import type { BrowserAdapter } from "./adapter.js";
import { createBrowserAdapter } from "./browser-adapter.js";
import { computeDiagnostics, type OutlineDiagnostics } from "./diagnostics.js";
import { isBackgroundCommand, planLiveSubtreeClose, runCommand } from "./commands.js";
import type { CommandAck } from "./commands.js";
import { getNormalWindows, getNormalWindowsIncludingTabs } from "./runtime-snapshot.js";
import { createStateCache } from "./state-cache.js";
import { loadState, saveState } from "./storage.js";
import {
  bootstrapFromWindows,
  closeTab,
  closeWindow,
  deleteLiveTabNodeByTabId,
  planRestore,
  projectLiveTabs,
  reconcileWithWindows,
  repairState
} from "../model/outline.js";
import { buildOutlineLookup } from "../model/outline-lookup.js";
import type { NodeId, OutlineNode, OutlineState, RuntimeTab, RuntimeWindow } from "../model/types.js";
import { createPerformanceTracer, type TraceDetail, type TraceSnapshot } from "../perf/trace.js";

export type BackgroundController = {
  ensureState(): Promise<OutlineState>;
  handleMessage(message: unknown): Promise<unknown>;
  refreshFromRuntime(eventTabs?: RuntimeTab[], options?: RefreshOptions): Promise<boolean>;
  flushPendingSaves(): Promise<void>;
};

type RefreshOptions = {
  closeMissing?: boolean;
};

type QueuedRuntimeRefresh = {
  eventTabsById: Map<number, RuntimeTab>;
  closeMissing: boolean;
  resolve: (changed: boolean) => void;
  reject: (error: unknown) => void;
  promise: Promise<boolean>;
};

type ReconciledStateChange = {
  previous: OutlineState;
  next: OutlineState;
};

type ActiveStateUpdate = {
  nodeId: NodeId;
  active: boolean;
};

type TreeStructureUpdate = {
  type: "treeStructureUpdated";
  deletedNodeIds: NodeId[];
  updatedNodes: OutlineNode[];
  rootIds: NodeId[];
  deletedClosedCount: number;
};

type NodeStateUpdate = {
  type: "nodeStateUpdated";
  updatedNodes: OutlineNode[];
  closedCountDelta: number;
};

type PerformanceTraceMessage =
  | {
      type: "setPerformanceTraceEnabled";
      enabled: boolean;
    }
  | {
      type: "clearPerformanceTrace";
    }
  | {
      type: "getPerformanceTrace";
    };

type StateDiffMode = "identity" | "material";

type BestEffortPatchOptions = {
  diffMode?: StateDiffMode;
  skipNodeState?: boolean;
};

export type BackgroundControllerOptions = {
  api: WebExtensionBrowser;
  adapter?: BrowserAdapter;
  now?: () => number;
};

const RUNTIME_REFRESH_BATCH_DELAY_MS = 0;
const STATE_SAVE_QUIET_DELAY_MS = 1000;
const STATE_SAVE_MAX_DELAY_MS = 5000;

export function createBackgroundController(options: BackgroundControllerOptions): BackgroundController {
  const { api, now = Date.now } = options;
  const adapter = options.adapter ?? createBrowserAdapter(api);
  const perfTrace = createPerformanceTracer("background");

  let state: OutlineState | undefined;
  let mutationQueue: Promise<void> = Promise.resolve();
  const outlinerClosingTabIds = new Set<number>();
  const outlinerClosingWindowIds = new Set<number>();
  const deleteOwnedClosingTabIds = new Set<number>();
  const deleteOwnedClosingWindowIds = new Set<number>();
  const removedTabIds = new Set<number>();
  const commandRestoredTabIds = new Set<number>();
  const commandFocusedTabIds = new Set<number>();
  const commandFocusedActivationWindowIds = new Set<number>();
  const commandFocusedWindowIds = new Set<number>();
  const stateCache = createStateCache(initializeState);
  let sessionChangedQueued = false;
  let commandCloseSessionEchoesToSkip = 0;
  let queuedRuntimeRefresh: QueuedRuntimeRefresh | undefined;
  let pendingSaveState: OutlineState | undefined;
  let saveTimer: number | undefined;
  let saveMaxTimer: number | undefined;
  let saveInFlight: Promise<void> | undefined;
  let diagnosticsInFlight: Promise<OutlineDiagnostics> | undefined;

  api.runtime.onInstalled.addListener(() => {
    void ensureState();
  });

  api.runtime.onStartup.addListener(() => {
    void ensureState();
  });

  api.action.onClicked.addListener(async () => {
    await perfTrace.measureAsync("background.action.openSidebar", () => api.sidebarAction.open());
  });

  api.runtime.onMessage.addListener((message) => handleMessage(message));

  api.tabs.onCreated.addListener(async (tab) => {
    await perfTrace.measureAsync("background.event.tabs.onCreated", { tabId: tab.id }, () => queueRuntimeRefresh([tab]));
  });

  api.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
    await perfTrace.measureAsync("background.event.tabs.onUpdated", { tabId: tab.id }, async () => {
      if (!hasOutlineRelevantTabUpdate(changeInfo)) {
        return;
      }
      if (isCommandFocusActiveUpdateEcho(commandFocusedActivationWindowIds, changeInfo, tab)) {
        return;
      }
      await queueRuntimeRefresh([tab]);
    });
  });

  api.tabs.onActivated.addListener(async (activeInfo) => {
    await perfTrace.measureAsync("background.event.tabs.onActivated", { tabId: activeInfo.tabId }, async () => {
      if (commandFocusedTabIds.has(activeInfo.tabId)) {
        await handleCommandTabActivated(activeInfo);
        return;
      }
      await queueRuntimeRefresh();
    });
  });

  api.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    await perfTrace.measureAsync("background.event.tabs.onRemoved", { tabId }, async () => {
      removedTabIds.add(tabId);
      if (deleteOwnedClosingTabIds.delete(tabId)) {
        return;
      }
      if (removeInfo.isWindowClosing) {
        return;
      }

      await enqueueMutation(async () => {
        const current = await ensureState();
        let next: OutlineState;
        if (outlinerClosingTabIds.delete(tabId)) {
          const recent = await mostRecentClosedSession();
          next = closeTab(current, tabId, {
            now: now(),
            ...(recent?.tab?.sessionId ? { sessionId: recent.tab.sessionId } : {})
          });
          commandCloseSessionEchoesToSkip += 1;
        } else if (isRestoredLiveTabId(current, tabId)) {
          const recent = await mostRecentClosedSession();
          next = closeTab(current, tabId, {
            now: now(),
            ...(recent?.tab?.sessionId ? { sessionId: recent.tab.sessionId } : {})
          });
        } else {
          next = deleteLiveTabNodeByTabId(current, tabId);
        }
        if (next === current) {
          return;
        }
        state = next;
        stateCache.replace(state);
        await persistWithNodeStateUpdate(current, next);
      }, { reason: "tabs.onRemoved" });
    });
  });

  api.windows.onRemoved.addListener(async (windowId) => {
    await perfTrace.measureAsync("background.event.windows.onRemoved", { windowId }, async () => {
      if (deleteOwnedClosingWindowIds.delete(windowId)) {
        return;
      }

      await enqueueMutation(async () => {
        const current = await ensureState();
        const liveTabIds = liveTabIdsInWindow(current, windowId);
        const outlinerClosingWindow = outlinerClosingWindowIds.delete(windowId);
        const singleNativeRemovedTabId = !outlinerClosingWindow &&
          liveTabIds.length === 1 &&
          removedTabIds.has(liveTabIds[0]!) &&
          !outlinerClosingTabIds.has(liveTabIds[0]!)
          ? liveTabIds[0]
          : undefined;

        if (typeof singleNativeRemovedTabId === "number") {
          if (shouldPreserveRestoredSingleTabWindowClose(current, windowId, singleNativeRemovedTabId)) {
            const recent = await mostRecentClosedSession();
            state = closeWindow(current, windowId, {
              now: now(),
              ...(recent?.window?.sessionId ? { sessionId: recent.window.sessionId } : {})
            });
          } else {
            state = closeWindow(deleteLiveTabNodeByTabId(current, singleNativeRemovedTabId), windowId, { now: now() });
          }
          stateCache.replace(state);
          await persistWithNodeStateUpdate(current, state);
          return;
        }

        for (const tabId of liveTabIds) {
          outlinerClosingTabIds.delete(tabId);
        }
        const recent = await mostRecentClosedSession();
        state = closeWindow(current, windowId, {
          now: now(),
          ...(recent?.window?.sessionId ? { sessionId: recent.window.sessionId } : {})
        });
        stateCache.replace(state);
        await persistWithNodeStateUpdate(current, state);
      }, { reason: "windows.onRemoved" });
    });
  });

  api.windows.onFocusChanged.addListener(async (windowId) => {
    await perfTrace.measureAsync("background.event.windows.onFocusChanged", { windowId }, async () => {
      if (commandFocusedWindowIds.has(windowId)) {
        await handleCommandWindowFocusChanged(windowId);
        return;
      }
      await queueRuntimeRefresh([], { closeMissing: false });
    });
  });

  api.sessions.onChanged.addListener(async () => {
    await perfTrace.measureAsync("background.event.sessions.onChanged", async () => {
      if (sessionChangedQueued) {
        return;
      }
      sessionChangedQueued = true;
      await enqueueMutation(async () => {
        try {
          if (commandCloseSessionEchoesToSkip > 0) {
            commandCloseSessionEchoesToSkip -= 1;
            return;
          }
          const reconciled = await reconcileMissingLiveTabsInOpenWindows();
          if (reconciled) {
            await persistWithNodeStateUpdate(reconciled.previous, reconciled.next);
          }
        } finally {
          sessionChangedQueued = false;
        }
      }, { reason: "sessions.onChanged" });
    });
  });

  async function handleMessage(message: unknown): Promise<unknown> {
    if (isPerformanceTraceMessage(message)) {
      return handlePerformanceTraceMessage(message);
    }

    return perfTrace.measureAsync("background.runtime.message", { type: messageType(message) }, () =>
      handleNonTraceMessage(message)
    );
  }

  async function handleNonTraceMessage(message: unknown): Promise<unknown> {
    if (isDiagnosticsRequest(message)) {
      return getDiagnosticsCoalesced();
    }

    if (!isBackgroundCommand(message)) {
      return undefined;
    }

    if (message.type === "refresh") {
      return commandAck(await refreshFromRuntime());
    }

    if (message.type === "getState") {
      await mutationQueue;
      return ensureState();
    }

    return enqueueMutation(async () => {
      const current = await ensureState();
      const outlinerClosingTabId = message.type === "closeNode"
        ? liveTabIdForNode(current, message.nodeId)
        : undefined;
      const outlinerClosingWindowId = message.type === "closeNode"
        ? liveWindowIdForNode(current, message.nodeId)
        : undefined;
      const focusTarget = message.type === "focusNode"
        ? focusTargetForNode(current, message.nodeId)
        : undefined;
      const deleteClosePlan = message.type === "deleteNode"
        ? planLiveSubtreeClose(current, message.nodeId)
        : undefined;
      const restorePatchNodeIds = message.type === "restoreNode"
        ? restorePatchCandidateNodeIds(current, message.nodeId)
        : undefined;
      if (typeof outlinerClosingTabId === "number") {
        outlinerClosingTabIds.add(outlinerClosingTabId);
      }
      if (typeof outlinerClosingWindowId === "number") {
        outlinerClosingWindowIds.add(outlinerClosingWindowId);
      }
      if (focusTarget && !focusTarget.tabActive) {
        commandFocusedTabIds.add(focusTarget.tabId);
        commandFocusedActivationWindowIds.add(focusTarget.windowId);
      }
      if (focusTarget) {
        commandFocusedWindowIds.add(focusTarget.windowId);
      }
      for (const tabId of deleteClosePlan?.tabIds ?? []) {
        deleteOwnedClosingTabIds.add(tabId);
      }
      for (const windowId of deleteClosePlan?.windowIds ?? []) {
        deleteOwnedClosingWindowIds.add(windowId);
      }

      let result: Awaited<ReturnType<typeof runCommand>>;
      try {
        result = await perfTrace.measureAsync("background.command.run", { command: message.type }, () =>
          runCommand(current, adapter, message)
        );
      } catch (error) {
        if (typeof outlinerClosingTabId === "number") {
          outlinerClosingTabIds.delete(outlinerClosingTabId);
        }
        if (typeof outlinerClosingWindowId === "number") {
          outlinerClosingWindowIds.delete(outlinerClosingWindowId);
        }
        for (const tabId of deleteClosePlan?.tabIds ?? []) {
          deleteOwnedClosingTabIds.delete(tabId);
        }
        for (const windowId of deleteClosePlan?.windowIds ?? []) {
          deleteOwnedClosingWindowIds.delete(windowId);
        }
        if (focusTarget) {
          commandFocusedTabIds.delete(focusTarget.tabId);
          commandFocusedActivationWindowIds.delete(focusTarget.windowId);
          commandFocusedWindowIds.delete(focusTarget.windowId);
        }
        throw error;
      }
      if (!result.changed) {
        return commandAck(false);
      }

      if (message.type === "restoreNode") {
        for (const tabId of restoredLiveTabIdsChangedByCommand(current, result.state, restorePatchNodeIds)) {
          commandRestoredTabIds.add(tabId);
        }
      }
      state = result.state;
      stateCache.replace(result.state);
      if (message.type === "restoreNode") {
        await persistWithNodeStateUpdate(current, result.state, restorePatchNodeIds);
        return commandAck(true);
      }
      if (message.type === "deleteNode") {
        const update = perfTrace.measure("background.patch.build.treeStructure", { command: message.type }, () =>
          treeStructureUpdateFromStateChange(current, result.state)
        );
        await broadcastTreeStructureUpdate(update);
        scheduleStateSave(result.state);
        return commandAck(true);
      }
      if (message.type === "wrapNodeInGroup") {
        const update = perfTrace.measure("background.patch.build.treeStructure", { command: message.type }, () =>
          treeStructureUpdateFromStateChange(current, result.state)
        );
        await broadcastTreeStructureUpdate(update);
        scheduleStateSave(result.state);
        return commandAck(true);
      }
      if (message.type === "renameGroup") {
        await persistKnownNodeStateUpdate(current, result.state, message.nodeId);
        return commandAck(true);
      }
      if (message.type === "toggleCollapsed") {
        await persistKnownNodeStateUpdate(current, result.state, message.nodeId);
        return commandAck(true);
      }
      await persistWithBestEffortPatch(current, result.state);
      return commandAck(true);
    }, { reason: "command", command: message.type });
  }

  async function ensureState(): Promise<OutlineState> {
    return stateCache.get();
  }

  async function initializeState(): Promise<OutlineState> {
    const windows = await perfTrace.measureAsync("background.runtime.getWindows", () => getNormalWindows(api));
    const stored = await perfTrace.measureAsync("background.state.load", () => loadState(api));
    state = stored
      ? reconcileWithWindows(repairState(stored), windows, { now: now() })
      : bootstrapFromWindows(windows, { now: now() });
    await saveStateNowWithTrace(state);
    return state;
  }

  async function refreshFromRuntime(eventTabs: RuntimeTab[] = [], options: RefreshOptions = {}): Promise<boolean> {
    return enqueueMutation(async () => refreshFromRuntimeNow(eventTabs, options), { reason: "refreshFromRuntime" });
  }

  function queueRuntimeRefresh(eventTabs: RuntimeTab[] = [], options: RefreshOptions = {}): Promise<boolean> {
    const requestedCloseMissing = options.closeMissing ?? eventTabs.length === 0;
    if (!queuedRuntimeRefresh) {
      let resolveRefresh!: (changed: boolean) => void;
      let rejectRefresh!: (error: unknown) => void;
      const promise = new Promise<boolean>((resolve, reject) => {
        resolveRefresh = resolve;
        rejectRefresh = reject;
      });
      queuedRuntimeRefresh = {
        eventTabsById: new Map(),
        closeMissing: requestedCloseMissing,
        resolve: resolveRefresh,
        reject: rejectRefresh,
        promise
      };
      globalThis.setTimeout(() => {
        void flushQueuedRuntimeRefresh();
      }, RUNTIME_REFRESH_BATCH_DELAY_MS);
    } else {
      queuedRuntimeRefresh.closeMissing ||= requestedCloseMissing;
    }

    for (const tab of eventTabs) {
      queuedRuntimeRefresh.eventTabsById.set(tab.id, tab);
    }

    return queuedRuntimeRefresh.promise;
  }

  async function flushQueuedRuntimeRefresh(): Promise<void> {
    const queued = queuedRuntimeRefresh;
    if (!queued) {
      return;
    }
    queuedRuntimeRefresh = undefined;

    try {
      queued.resolve(await refreshFromRuntime([...queued.eventTabsById.values()], {
        closeMissing: queued.closeMissing
      }));
    } catch (error) {
      queued.reject(error);
    }
  }

  async function refreshFromRuntimeNow(eventTabs: RuntimeTab[] = [], options: RefreshOptions = {}): Promise<boolean> {
    const current = await ensureState();
    const closeMissing = options.closeMissing ?? eventTabs.length === 0;
    const currentEventTabs = eventTabs
      .filter((tab) => !removedTabIds.has(tab.id))
      .filter((tab) => !consumeCommandRestoredTabEvent(current, commandRestoredTabIds, tab))
      .filter((tab) => tabEventMayChangeState(current, tab));
    if (eventTabs.length > 0 && currentEventTabs.length === 0 && !closeMissing) {
      return false;
    }
    const windowsSnapshot = await perfTrace.measureAsync("background.runtime.getWindows", {
      eventTabCount: currentEventTabs.length
    }, () => currentEventTabs.length > 0
      ? getNormalWindowsIncludingTabs(api, currentEventTabs)
      : getNormalWindows(api));
    const windows = filterRemovedTabsFromWindows(windowsSnapshot, removedTabIds);
    if (runtimeSnapshotMateriallyMatchesState(current, windows)) {
      return false;
    }
    const next = reconcileWithWindows(current, windows, { now: now() }, {
      closeMissing
    });
    if (statesMateriallyEqual(current, next)) {
      return false;
    }
    state = next;
    stateCache.replace(state);
    await persistWithBestEffortPatch(current, next, { diffMode: "material" });
    return state !== current;
  }

  async function handleCommandTabActivated(activeInfo: { tabId: number; windowId: number; previousTabId?: number }): Promise<boolean> {
    commandFocusedTabIds.delete(activeInfo.tabId);
    commandFocusedActivationWindowIds.delete(activeInfo.windowId);
    return enqueueMutation(async () => {
      const current = await ensureState();
      const activation = activateRuntimeTabInPlace(current, activeInfo.tabId, activeInfo.windowId);
      if (!activation.found) {
        return refreshFromRuntimeNow([], { closeMissing: true });
      }
      if (!activation.changed) {
        return false;
      }

      state = current;
      stateCache.replace(current);
      await broadcastActiveStateUpdate(activation.updates);
      return true;
    }, { reason: "commandFocusActivation" });
  }

  async function handleCommandWindowFocusChanged(windowId: number): Promise<boolean> {
    commandFocusedWindowIds.delete(windowId);
    return enqueueMutation(async () => {
      const current = await ensureState();
      if (windowId === api.windows.WINDOW_ID_NONE) {
        return refreshFromRuntimeNow([], { closeMissing: false });
      }

      const focus = focusRuntimeWindowInPlace(current, windowId);
      if (!focus.found) {
        return refreshFromRuntimeNow([], { closeMissing: false });
      }
      if (!focus.changed) {
        return false;
      }

      state = current;
      stateCache.replace(current);
      await broadcastActiveStateUpdate(focus.updates);
      return true;
    }, { reason: "commandWindowFocus" });
  }

  function enqueueMutation<T>(operation: () => Promise<T>, detail?: TraceDetail): Promise<T> {
    const queuedAt = performance.now();
    const mutationDetail = detail ? { ...detail } : undefined;
    const runOperation = async (): Promise<T> => {
      perfTrace.mark("background.mutation.start", {
        ...mutationDetail,
        waitMs: Math.round(performance.now() - queuedAt)
      });
      return perfTrace.measureAsync("background.mutation.run", mutationDetail, operation);
    };
    const queued = mutationQueue.then(
      () => runOperation(),
      () => runOperation()
    );
    mutationQueue = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  }

  async function persistAndBroadcast(): Promise<void> {
    if (!state) {
      return;
    }
    await broadcastWithTrace({ type: "stateUpdated", state });
    scheduleStateSave(state);
  }

  async function persistWithNodeStateUpdate(
    previous: OutlineState,
    next: OutlineState,
    candidateNodeIds?: readonly NodeId[]
  ): Promise<void> {
    const update = perfTrace.measure("background.patch.build.nodeState", {
      candidateNodeCount: candidateNodeIds?.length ?? 0
    }, () => candidateNodeIds
      ? nodeStateUpdateForNodeIds(previous, next, candidateNodeIds)
      : nodeStateUpdateFromStateChange(previous, next));
    if (isUsefulNodeStateUpdate(update, next)) {
      await broadcastNodeStateUpdate(update);
      scheduleStateSave(next);
      return;
    }

    await persistWithBestEffortPatch(previous, next, { diffMode: "material", skipNodeState: true });
  }

  async function persistKnownNodeStateUpdate(previous: OutlineState, next: OutlineState, nodeId: NodeId): Promise<void> {
    const node = next.nodes[nodeId];
    if (!node) {
      await persistWithBestEffortPatch(previous, next, { diffMode: "material", skipNodeState: true });
      return;
    }

    await broadcastNodeStateUpdate({
      type: "nodeStateUpdated",
      updatedNodes: [node],
      closedCountDelta: 0
    });
    scheduleStateSave(next);
  }

  async function persistWithBestEffortPatch(
    previous: OutlineState,
    next: OutlineState,
    options: BestEffortPatchOptions = {}
  ): Promise<void> {
    const diffMode = options.diffMode ?? "identity";
    if (!options.skipNodeState) {
      const nodeUpdate = perfTrace.measure("background.patch.build.nodeState", {
        candidateNodeCount: 0,
        diffMode
      }, () => nodeStateUpdateFromStateChange(previous, next, { diffMode }));
      if (isUsefulNodeStateUpdate(nodeUpdate, next)) {
        await broadcastNodeStateUpdate(nodeUpdate);
        scheduleStateSave(next);
        return;
      }
    }

    const treeUpdate = perfTrace.measure("background.patch.build.treeStructure", { diffMode }, () =>
      treeStructureUpdateFromStateChange(previous, next, { diffMode })
    );
    if (isUsefulTreeStructureUpdate(treeUpdate, next)) {
      await broadcastTreeStructureUpdate(treeUpdate);
      scheduleStateSave(next);
      return;
    }

    if (!options.skipNodeState && diffMode !== "material") {
      const nodeUpdate = perfTrace.measure("background.patch.build.nodeState", {
        candidateNodeCount: 0,
        diffMode: "material"
      }, () => nodeStateUpdateFromStateChange(previous, next, { diffMode: "material" }));
      if (isUsefulNodeStateUpdate(nodeUpdate, next)) {
        await broadcastNodeStateUpdate(nodeUpdate);
        scheduleStateSave(next);
        return;
      }
    }

    const semanticTreeUpdate = diffMode === "material"
      ? treeUpdate
      : perfTrace.measure("background.patch.build.treeStructure", { diffMode: "material" }, () =>
        treeStructureUpdateFromStateChange(previous, next, { diffMode: "material" })
      );
    if (diffMode !== "material" && isUsefulTreeStructureUpdate(semanticTreeUpdate, next)) {
      await broadcastTreeStructureUpdate(semanticTreeUpdate);
      scheduleStateSave(next);
      return;
    }

    await persistAndBroadcast();
  }

  function isUsefulNodeStateUpdate(update: NodeStateUpdate | undefined, next: OutlineState): update is NodeStateUpdate {
    if (!update || update.updatedNodes.length === 0) {
      return false;
    }

    return update.updatedNodes.length < Object.keys(next.nodes).length;
  }

  async function broadcastActiveStateUpdate(updates: ActiveStateUpdate[]): Promise<void> {
    if (updates.length === 0) {
      return;
    }
    await broadcastWithTrace({ type: "activeStateUpdated", updates });
  }

  async function broadcastTreeStructureUpdate(update: TreeStructureUpdate): Promise<void> {
    await broadcastWithTrace(update);
  }

  async function broadcastNodeStateUpdate(update: NodeStateUpdate): Promise<void> {
    if (update.updatedNodes.length === 0) {
      return;
    }
    await broadcastWithTrace(update);
  }

  function scheduleStateSave(next: OutlineState): void {
    pendingSaveState = next;
    if (saveInFlight) {
      return;
    }

    if (saveTimer !== undefined) {
      globalThis.clearTimeout(saveTimer);
    }
    saveTimer = globalThis.setTimeout(() => {
      void flushScheduledSave();
    }, STATE_SAVE_QUIET_DELAY_MS);

    saveMaxTimer ??= globalThis.setTimeout(() => {
      void flushScheduledSave();
    }, STATE_SAVE_MAX_DELAY_MS);
  }

  async function flushPendingSaves(): Promise<void> {
    clearSaveTimers();

    while (pendingSaveState || saveInFlight) {
      if (saveInFlight) {
        await saveInFlight;
        continue;
      }

      const next = pendingSaveState;
      if (!next) {
        return;
      }
      pendingSaveState = undefined;
      saveInFlight = saveStateNowWithTrace(next).finally(() => {
        saveInFlight = undefined;
      });
      await saveInFlight;
    }
  }

  async function flushScheduledSave(): Promise<void> {
    try {
      await flushPendingSaves();
    } catch (error) {
      perfTrace.mark("background.state.save.error", { message: errorText(error) });
    }
  }

  function clearSaveTimers(): void {
    if (saveTimer !== undefined) {
      globalThis.clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    if (saveMaxTimer !== undefined) {
      globalThis.clearTimeout(saveMaxTimer);
      saveMaxTimer = undefined;
    }
  }

  async function saveStateNowWithTrace(next: OutlineState): Promise<void> {
    await perfTrace.measureAsync("background.state.save", () => saveState(next, api));
  }

  async function broadcastWithTrace(message: { type: string } & Record<string, unknown>): Promise<void> {
    await perfTrace.measureAsync("background.runtime.broadcast", { type: message.type }, async () => {
      await api.runtime.sendMessage(message).catch(() => undefined);
    });
  }

  function getDiagnosticsCoalesced(): Promise<OutlineDiagnostics> {
    diagnosticsInFlight ??= perfTrace.measureAsync("background.diagnostics", async () => {
      await mutationQueue;
      return computeDiagnostics(await ensureState(), await getNormalWindows(api));
    }).finally(() => {
      diagnosticsInFlight = undefined;
    });
    return diagnosticsInFlight;
  }

  function handlePerformanceTraceMessage(message: PerformanceTraceMessage): TraceSnapshot | { ok: true } {
    if (message.type === "setPerformanceTraceEnabled") {
      if (message.enabled) {
        perfTrace.setEnabled(true);
        perfTrace.mark("background.profile.enabled");
      } else {
        perfTrace.mark("background.profile.disabled");
        perfTrace.setEnabled(false);
      }
      return { ok: true };
    }
    if (message.type === "clearPerformanceTrace") {
      perfTrace.clear();
      return { ok: true };
    }
    return perfTrace.snapshot();
  }

  async function reconcileMissingLiveTabsInOpenWindows(): Promise<ReconciledStateChange | undefined> {
    const current = await ensureState();
    const windows = filterRemovedTabsFromWindows(await getNormalWindows(api), removedTabIds);
    const openWindowIds = new Set(windows.map((windowInfo) => windowInfo.id));
    const openTabIds = new Set(
      windows.flatMap((windowInfo) => windowInfo.tabs ?? []).map((tab) => tab.id)
    );
    const missingLiveTabIds = Object.values(current.nodes)
      .filter(isLiveTabInOpenWindow(openWindowIds, openTabIds))
      .map((node) => node.live.tabId);
    if (missingLiveTabIds.length === 0) {
      return undefined;
    }

    let next = current;
    for (const tabId of missingLiveTabIds) {
      removedTabIds.add(tabId);
      if (outlinerClosingTabIds.delete(tabId)) {
        const recent = await mostRecentClosedSession();
        next = closeTab(next, tabId, {
          now: now(),
          ...(recent?.tab?.sessionId ? { sessionId: recent.tab.sessionId } : {})
        });
      } else if (isRestoredLiveTabId(next, tabId)) {
        const recent = await mostRecentClosedSession();
        next = closeTab(next, tabId, {
          now: now(),
          ...(recent?.tab?.sessionId ? { sessionId: recent.tab.sessionId } : {})
        });
      } else {
        next = deleteLiveTabNodeByTabId(next, tabId);
      }
    }

    state = next;
    stateCache.replace(next);
    return next !== current ? { previous: current, next } : undefined;
  }

  async function mostRecentClosedSession(): Promise<{ tab?: { sessionId?: string }; window?: { sessionId?: string } } | undefined> {
    const sessions = await api.sessions.getRecentlyClosed({ maxResults: 1 }).catch(() => []);
    return sessions[0];
  }

  return {
    ensureState,
    handleMessage,
    refreshFromRuntime,
    flushPendingSaves
  };
}

function commandAck(stateChanged: boolean): CommandAck {
  return {
    type: "commandAck",
    stateChanged
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function focusTargetForNode(
  state: OutlineState,
  nodeId: NodeId
): { tabId: number; windowId: number; tabActive: boolean; windowActive: boolean } | undefined {
  const node = state.nodes[nodeId];
  if (!node || !isLiveTabNode(node)) {
    return undefined;
  }

  return {
    tabId: node.live.tabId,
    windowId: node.live.windowId,
    tabActive: node.active === true,
    windowActive: liveWindowNodeByRuntimeId(state, node.live.windowId)?.active === true
  };
}

function treeStructureUpdateFromStateChange(
  previous: OutlineState,
  next: OutlineState,
  options: { diffMode?: StateDiffMode } = {}
): TreeStructureUpdate {
  const diffMode = options.diffMode ?? "identity";
  const deletedNodeIds = Object.keys(previous.nodes).filter((nodeId) => !next.nodes[nodeId]);
  const updatedNodes: OutlineNode[] = [];
  for (const nodeId of Object.keys(next.nodes)) {
    const node = next.nodes[nodeId]!;
    const previousNode = previous.nodes[nodeId];
    if (!previousNode || nodeChangedForPatch(previousNode, node, diffMode)) {
      updatedNodes.push(node);
    }
  }
  const deletedClosedCount = deletedNodeIds.filter((nodeId) => previous.nodes[nodeId]?.status === "closed").length;

  return {
    type: "treeStructureUpdated",
    deletedNodeIds,
    updatedNodes,
    rootIds: next.rootIds,
    deletedClosedCount
  };
}

function isUsefulTreeStructureUpdate(update: TreeStructureUpdate, next: OutlineState): boolean {
  const changedNodeCount = update.deletedNodeIds.length + update.updatedNodes.length;
  if (changedNodeCount === 0) {
    return false;
  }

  return changedNodeCount < Object.keys(next.nodes).length;
}

function runtimeSnapshotMateriallyMatchesState(state: OutlineState, windows: RuntimeWindow[]): boolean {
  const lookup = buildOutlineLookup(state);
  const normalWindows = windows.filter((windowInfo) => !windowInfo.incognito);
  if (lookup.liveWindowNodeIdsByRuntimeId.size !== normalWindows.length) {
    return false;
  }

  let runtimeTabCount = 0;
  for (const windowInfo of normalWindows) {
    const windowNodeId = lookup.liveWindowNodeIdsByRuntimeId.get(windowInfo.id);
    const windowNode = windowNodeId ? state.nodes[windowNodeId] : undefined;
    if (!windowNodeId || !windowNode || windowNode.active !== windowInfo.focused) {
      return false;
    }

    const tabs = [...(windowInfo.tabs ?? [])]
      .filter((tab) => !tab.incognito)
      .sort((left, right) => left.index - right.index);
    runtimeTabCount += tabs.length;

    const projectedTabs = projectLiveTabs(state, windowNodeId).filter((tab) => tab.windowId === windowInfo.id);
    if (projectedTabs.length !== tabs.length) {
      return false;
    }

    for (let index = 0; index < tabs.length; index += 1) {
      const tab = tabs[index]!;
      const nodeId = lookup.liveTabNodeIdsByRuntimeId.get(tab.id);
      const node = nodeId ? state.nodes[nodeId] : undefined;
      if (
        !node ||
        !isLiveTabNode(node) ||
        node.live.windowId !== tab.windowId ||
        projectedTabs[index]?.tabId !== tab.id ||
        liveTabNodeWouldChange(node, tab)
      ) {
        return false;
      }
    }
  }

  return lookup.liveTabNodeIdsByRuntimeId.size === runtimeTabCount;
}

function liveTabNodeWouldChange(node: OutlineNode & { live: { tabId: number; windowId: number } }, tab: RuntimeTab): boolean {
  const nextTitle = tab.title || tab.url || node.title || "Untitled tab";
  return node.active !== tab.active ||
    (tab.url !== undefined && node.url !== tab.url) ||
    node.title !== nextTitle ||
    (tab.favIconUrl !== undefined && node.favIconUrl !== tab.favIconUrl);
}

function nodeStateUpdateFromStateChange(
  previous: OutlineState,
  next: OutlineState,
  options: { diffMode?: StateDiffMode } = {}
): NodeStateUpdate | undefined {
  const diffMode = options.diffMode ?? "identity";
  const nextNodeIds = Object.keys(next.nodes);
  if (!sameNodeIdList(previous.rootIds, next.rootIds) || Object.keys(previous.nodes).length !== nextNodeIds.length) {
    return undefined;
  }

  const updatedNodes: OutlineNode[] = [];
  let closedCountDelta = 0;
  for (const nodeId of nextNodeIds) {
    const previousNode = previous.nodes[nodeId];
    const node = next.nodes[nodeId]!;
    if (!previousNode) {
      return undefined;
    }
    if (!nodeChangedForPatch(previousNode, node, diffMode)) {
      continue;
    }
    if (previousNode.parentId !== node.parentId || !sameNodeIdList(previousNode.childIds, node.childIds)) {
      return undefined;
    }
    updatedNodes.push(node);
    const wasClosed = previousNode.status === "closed" ? 1 : 0;
    const isClosed = node.status === "closed" ? 1 : 0;
    closedCountDelta += isClosed - wasClosed;
  }

  return {
    type: "nodeStateUpdated",
    updatedNodes,
    closedCountDelta
  };
}

function nodeStateUpdateForNodeIds(
  previous: OutlineState,
  next: OutlineState,
  nodeIds: readonly NodeId[],
  options: { diffMode?: StateDiffMode } = {}
): NodeStateUpdate | undefined {
  const diffMode = options.diffMode ?? "identity";
  if (!sameNodeIdList(previous.rootIds, next.rootIds)) {
    return undefined;
  }

  const updatedNodes: OutlineNode[] = [];
  let closedCountDelta = 0;
  for (const nodeId of nodeIds) {
    const previousNode = previous.nodes[nodeId];
    const node = next.nodes[nodeId];
    if (!previousNode || !node) {
      return undefined;
    }
    if (!nodeChangedForPatch(previousNode, node, diffMode)) {
      continue;
    }
    if (previousNode.parentId !== node.parentId || !sameNodeIdList(previousNode.childIds, node.childIds)) {
      return undefined;
    }
    updatedNodes.push(node);
    const wasClosed = previousNode.status === "closed" ? 1 : 0;
    const isClosed = node.status === "closed" ? 1 : 0;
    closedCountDelta += isClosed - wasClosed;
  }

  return {
    type: "nodeStateUpdated",
    updatedNodes,
    closedCountDelta
  };
}

function nodeChangedForPatch(previous: OutlineNode, next: OutlineNode, diffMode: StateDiffMode): boolean {
  return diffMode === "material" ? !nodesMateriallyEqual(previous, next) : previous !== next;
}

function sameNodeIdList(previous: NodeId[], next: NodeId[]): boolean {
  return previous.length === next.length && previous.every((nodeId, index) => nodeId === next[index]);
}

function statesMateriallyEqual(previous: OutlineState, next: OutlineState): boolean {
  if (!sameNodeIdList(previous.rootIds, next.rootIds)) {
    return false;
  }

  const previousNodeIds = Object.keys(previous.nodes);
  if (previousNodeIds.length !== Object.keys(next.nodes).length) {
    return false;
  }

  return previousNodeIds.every((nodeId) => {
    const previousNode = previous.nodes[nodeId];
    const nextNode = next.nodes[nodeId];
    return Boolean(previousNode && nextNode && nodesMateriallyEqual(previousNode, nextNode));
  });
}

function nodesMateriallyEqual(previous: OutlineNode, next: OutlineNode): boolean {
  return previous.id === next.id &&
    previous.kind === next.kind &&
    previous.status === next.status &&
    previous.parentId === next.parentId &&
    sameNodeIdList(previous.childIds, next.childIds) &&
    previous.title === next.title &&
    previous.customTitle === next.customTitle &&
    previous.url === next.url &&
    previous.favIconUrl === next.favIconUrl &&
    previous.active === next.active &&
    previous.collapsed === next.collapsed &&
    previous.createdAt === next.createdAt &&
    previous.closedAt === next.closedAt &&
    previous.restoredFromClosed === next.restoredFromClosed &&
    liveRefsEqual(previous.live, next.live) &&
    restoreRefsEqual(previous.restore, next.restore);
}

function liveRefsEqual(previous: OutlineNode["live"], next: OutlineNode["live"]): boolean {
  return previous?.tabId === next?.tabId && previous?.windowId === next?.windowId;
}

function restoreRefsEqual(previous: OutlineNode["restore"], next: OutlineNode["restore"]): boolean {
  return previous?.sessionId === next?.sessionId &&
    previous?.url === next?.url &&
    previous?.title === next?.title &&
    previous?.favIconUrl === next?.favIconUrl;
}

function restorePatchCandidateNodeIds(state: OutlineState, nodeId: NodeId): NodeId[] {
  const nodeIds = new Set<NodeId>();
  for (const plan of planRestore(state, nodeId)) {
    nodeIds.add(plan.nodeId);
    if (plan.windowNodeId) {
      nodeIds.add(plan.windowNodeId);
    }
  }
  return [...nodeIds];
}

function restoredLiveTabIdsChangedByCommand(
  previous: OutlineState,
  next: OutlineState,
  candidateNodeIds?: readonly NodeId[]
): number[] {
  const nodes = candidateNodeIds
    ? candidateNodeIds.flatMap((nodeId) => {
        const node = next.nodes[nodeId];
        return node ? [node] : [];
      })
    : Object.values(next.nodes);

  return nodes.flatMap((node) => {
    if (!isLiveTabNode(node) || !node.restoredFromClosed || previous.nodes[node.id]?.status !== "closed") {
      return [];
    }
    return [node.live.tabId];
  });
}

function consumeCommandRestoredTabEvent(
  state: OutlineState,
  commandRestoredTabIds: Set<number>,
  tab: RuntimeTab
): boolean {
  if (!commandRestoredTabIds.has(tab.id)) {
    return false;
  }

  const node = liveTabNodeByRuntimeId(state, tab.id);
  if (!node?.restoredFromClosed || node.live.windowId !== tab.windowId) {
    commandRestoredTabIds.delete(tab.id);
    return false;
  }

  commandRestoredTabIds.delete(tab.id);
  return true;
}

function tabEventMayChangeState(state: OutlineState, tab: RuntimeTab): boolean {
  const node = liveTabNodeByRuntimeId(state, tab.id);
  if (!node || node.live.windowId !== tab.windowId) {
    return true;
  }

  return liveTabNodeWouldChange(node, tab);
}

function isCommandFocusActiveUpdateEcho(
  commandFocusedActivationWindowIds: Set<number>,
  changeInfo: Partial<RuntimeTab>,
  tab: RuntimeTab
): boolean {
  return tab.active === true &&
    commandFocusedActivationWindowIds.has(tab.windowId) &&
    Object.keys(changeInfo).every((key) => key === "active");
}

function activateRuntimeTabInPlace(
  state: OutlineState,
  tabId: number,
  windowId: number
): { found: boolean; changed: boolean; updates: ActiveStateUpdate[] } {
  let found = false;
  let changed = false;
  const updates: ActiveStateUpdate[] = [];

  for (const node of Object.values(state.nodes)) {
    if (!isLiveTabNode(node) || node.live.windowId !== windowId) {
      continue;
    }

    const active = node.live.tabId === tabId;
    found ||= active;
    if (node.active !== active) {
      node.active = active;
      changed = true;
      updates.push({ nodeId: node.id, active });
    }
  }

  return { found, changed, updates };
}

function focusRuntimeWindowInPlace(
  state: OutlineState,
  windowId: number
): { found: boolean; changed: boolean; updates: ActiveStateUpdate[] } {
  let found = false;
  let changed = false;
  const updates: ActiveStateUpdate[] = [];

  for (const node of Object.values(state.nodes)) {
    if (node.kind !== "window" || node.status !== "live" || !node.live || !("windowId" in node.live)) {
      continue;
    }

    const active = node.live.windowId === windowId;
    found ||= active;
    if (node.active !== active) {
      node.active = active;
      changed = true;
      updates.push({ nodeId: node.id, active });
    }
  }

  return { found, changed, updates };
}

function liveTabIdForNode(state: OutlineState, nodeId: NodeId): number | undefined {
  const node = state.nodes[nodeId];
  return node?.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live
    ? node.live.tabId
    : undefined;
}

function liveWindowIdForNode(state: OutlineState, nodeId: NodeId): number | undefined {
  const node = state.nodes[nodeId];
  return node?.kind === "window" && node.status === "live" && node.live && "windowId" in node.live
    ? node.live.windowId
    : undefined;
}

function isRestoredLiveTabId(state: OutlineState, tabId: number): boolean {
  return Boolean(liveTabNodeByRuntimeId(state, tabId)?.restoredFromClosed);
}

function shouldPreserveRestoredSingleTabWindowClose(
  state: OutlineState,
  windowId: number,
  tabId: number
): boolean {
  return Boolean(
    liveWindowNodeByRuntimeId(state, windowId)?.restoredFromClosed ||
      liveTabNodeByRuntimeId(state, tabId)?.restoredFromClosed
  );
}

function liveTabNodeByRuntimeId(
  state: OutlineState,
  tabId: number
): (OutlineNode & { live: { tabId: number; windowId: number } }) | undefined {
  return Object.values(state.nodes).find((node): node is OutlineNode & { live: { tabId: number; windowId: number } } => {
    return isLiveTabNode(node) && node.live.tabId === tabId;
  });
}

function liveWindowNodeByRuntimeId(
  state: OutlineState,
  windowId: number
): (OutlineNode & { live: { windowId: number } }) | undefined {
  return Object.values(state.nodes).find((node): node is OutlineNode & { live: { windowId: number } } => {
    return Boolean(
      node.kind === "window" &&
        node.status === "live" &&
        node.live &&
        "windowId" in node.live &&
        node.live.windowId === windowId
    );
  });
}

function liveTabIdsInWindow(state: OutlineState, windowId: number): number[] {
  return Object.values(state.nodes).flatMap((node) => {
    if (!isLiveTabNode(node) || node.live.windowId !== windowId) {
      return [];
    }
    return [node.live.tabId];
  });
}

function isLiveTabInOpenWindow(
  openWindowIds: Set<number>,
  openTabIds: Set<number>
): (node: OutlineNode) => node is OutlineNode & { live: { tabId: number; windowId: number } } {
  return (node): node is OutlineNode & { live: { tabId: number; windowId: number } } => {
    return Boolean(
      isLiveTabNode(node) &&
        openWindowIds.has(node.live.windowId) &&
        !openTabIds.has(node.live.tabId)
    );
  };
}

function isLiveTabNode(node: OutlineNode): node is OutlineNode & { live: { tabId: number; windowId: number } } {
  return Boolean(node.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live);
}

function filterRemovedTabsFromWindows(windows: RuntimeWindow[], removedTabIds: Set<number>): RuntimeWindow[] {
  if (removedTabIds.size === 0) {
    return windows;
  }

  return windows.map((windowInfo) => ({
    ...windowInfo,
    tabs: (windowInfo.tabs ?? []).filter((tab) => !removedTabIds.has(tab.id))
  }));
}

function isDiagnosticsRequest(message: unknown): message is { type: "getDiagnostics" } {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "getDiagnostics"
  );
}

function isPerformanceTraceMessage(message: unknown): message is PerformanceTraceMessage {
  if (!message || typeof message !== "object") {
    return false;
  }

  const type = (message as { type?: unknown }).type;
  return type === "getPerformanceTrace" ||
    type === "clearPerformanceTrace" ||
    (type === "setPerformanceTraceEnabled" && typeof (message as { enabled?: unknown }).enabled === "boolean");
}

function messageType(message: unknown): string {
  return message && typeof message === "object" && typeof (message as { type?: unknown }).type === "string"
    ? (message as { type: string }).type
    : "unknown";
}

function hasOutlineRelevantTabUpdate(changeInfo: Partial<RuntimeTab>): boolean {
  return Boolean(
    "active" in changeInfo ||
      "favIconUrl" in changeInfo ||
      "title" in changeInfo ||
      "url" in changeInfo
  );
}
