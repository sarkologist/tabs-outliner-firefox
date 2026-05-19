import type { BrowserAdapter } from "./adapter.js";
import { createBrowserAdapter } from "./browser-adapter.js";
import { computeDiagnostics, type OutlineDiagnostics } from "./diagnostics.js";
import { isBackgroundCommand, planLiveSubtreeClose, runCommand, syncBrowserOrder } from "./commands.js";
import type { BackgroundCommand, CommandAck, RuntimeClosePlan } from "./commands.js";
import { getNormalWindow, getNormalWindows, getNormalWindowsIncludingTabs } from "./runtime-snapshot.js";
import { createStateCache } from "./state-cache.js";
import {
  initialTreeSnapshotForState,
  loadHistory,
  loadInitialTreeSnapshot,
  loadState,
  saveStateAndHistory
} from "./storage.js";
import type { InitialTreeSnapshot } from "./storage.js";
import {
  applyOutlineDelta,
  cloneOutlineNode,
  createHistoryEntry,
  historyStatus,
  normalizeHistoryState,
  popRedoEntry,
  popUndoEntry,
  pushRedoEntry,
  pushUndoEntry,
  pushUndoEntryPreservingRedo,
  type HistoryState,
  type HistoryStatus,
  type OutlineDelta,
  type TrackableHistoryCommandType
} from "./history.js";
import {
  APP_PREFERENCES_STORAGE_KEY,
  DEFAULT_APP_PREFERENCES,
  loadAppPreferences,
  normalizeAppPreferences,
  type AppPreferences
} from "../preferences.js";
import {
  bootstrapFromWindows,
  closeTab,
  closeWindow,
  deleteLiveTabNodeByTabId,
  planRestore,
  projectLiveTabs,
  reconcileWithWindows,
  repairState,
  runtimeTitleForOutlineTab
} from "../model/outline.js";
import { buildOutlineLookup } from "../model/outline-lookup.js";
import type { NodeId, OutlineNode, OutlineState, RuntimeTab, RuntimeWindow } from "../model/types.js";
import { createPerformanceTracer, type TraceDetail, type TraceSnapshot } from "../perf/trace.js";
import {
  isLabeledTraceSnapshot,
  type LabeledTraceSnapshot,
  type PerformanceProfileSnapshot
} from "../perf/profile.js";

export type BackgroundController = {
  ensureState(): Promise<OutlineState>;
  handleMessage(message: unknown): Promise<unknown>;
  refreshFromRuntime(eventTabs?: RuntimeTab[], options?: RefreshOptions): Promise<boolean>;
  flushPendingSaves(): Promise<void>;
};

type RefreshOptions = {
  closeMissing?: boolean;
};

type RuntimeRefreshCaller = {
  resolve: (changed: boolean) => void;
  reject: (error: unknown) => void;
};

type PendingRuntimeRefresh = {
  eventTabsById: Map<number, RuntimeTab>;
  activationByWindowId: Map<number, number>;
  closeMissing: boolean;
  callers: RuntimeRefreshCaller[];
  scheduled: boolean;
};

type MutationPriority = "high" | "low";

type ScheduledMutation<T = unknown> = {
  operation: () => Promise<T>;
  detail: TraceDetail | undefined;
  priority: MutationPriority;
  queuedAt: number;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
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
    }
  | {
      type: "getPerformanceProfile";
    };

type SidebarPerformanceTraceCollectedMessage = {
  type: "sidebarPerformanceTraceCollected";
  requestId: string;
  sidebar: LabeledTraceSnapshot;
};

type InitialTreeSnapshotMessage = {
  type: "getInitialTreeSnapshot";
};

type PendingSidebarProfileCollection = {
  sidebars: LabeledTraceSnapshot[];
  seenSidebarIds: Set<string>;
};

type StateDiffMode = "identity" | "material";

type BestEffortPatchOptions = {
  diffMode?: StateDiffMode;
  skipNodeState?: boolean;
};

type RuntimeStateIndex = {
  state: OutlineState;
  liveTabNodeIdsByRuntimeId: Map<number, NodeId>;
  liveWindowNodeIdsByRuntimeId: Map<number, NodeId>;
  liveTabNodeIdsByWindowId: Map<number, Set<NodeId>>;
  activeTabNodeIdsByWindowId: Map<number, NodeId>;
  windowNodeIdsWithClosedRestoreCandidates: Set<NodeId>;
  activeWindowNodeId?: NodeId;
};

type RuntimeEventTabsFastPathResult =
  | {
      handled: false;
    }
  | {
      handled: true;
      changed: false;
    }
  | {
      handled: true;
      changed: true;
      state: OutlineState;
      index: RuntimeStateIndex;
      update: TreeStructureUpdate | NodeStateUpdate;
    };

export type BackgroundControllerOptions = {
  api: WebExtensionBrowser;
  adapter?: BrowserAdapter;
  now?: () => number;
};

const RUNTIME_REFRESH_BATCH_DELAY_MS = 0;
const STATE_SAVE_QUIET_DELAY_MS = 1000;
const STATE_SAVE_MAX_DELAY_MS = 5000;
const SIDEBAR_PROFILE_COLLECTION_DELAY_MS = 50;
const TOGGLE_SIDEBAR_COMMAND = "toggle-sidebar";

export function createBackgroundController(options: BackgroundControllerOptions): BackgroundController {
  const { api, now = Date.now } = options;
  const adapter = options.adapter ?? createBrowserAdapter(api);
  const perfTrace = createPerformanceTracer("background");

  let state: OutlineState | undefined;
  let historyState: HistoryState | undefined;
  let preferences: AppPreferences | undefined;
  let runtimeIndex: RuntimeStateIndex | undefined;
  const highPriorityMutations: ScheduledMutation[] = [];
  const lowPriorityMutations: ScheduledMutation[] = [];
  const schedulerIdleResolvers: Array<() => void> = [];
  let schedulerRunning = false;
  let schedulerDrainQueued = false;
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
  let pendingRuntimeRefresh: PendingRuntimeRefresh | undefined;
  let pendingSaveState: OutlineState | undefined;
  let pendingSaveHistory: HistoryState | undefined;
  let saveTimer: number | undefined;
  let saveMaxTimer: number | undefined;
  let saveInFlight: Promise<void> | undefined;
  let diagnosticsInFlight: Promise<OutlineDiagnostics> | undefined;
  let sidebarProfileRequestSequence = 0;
  const pendingSidebarProfileCollections = new Map<string, PendingSidebarProfileCollection>();

  api.runtime.onInstalled.addListener(() => {
    void ensureState();
  });

  api.runtime.onStartup.addListener(() => {
    void ensureState();
  });

  api.action.onClicked.addListener(async () => {
    await perfTrace.measureAsync("background.action.openSidebar", () => api.sidebarAction.open());
  });

  api.commands.onCommand.addListener((command) => {
    if (command !== TOGGLE_SIDEBAR_COMMAND) {
      return;
    }
    void perfTrace.measureAsync("background.command.toggleSidebar", () => api.sidebarAction.toggle()).catch((error) => {
      perfTrace.mark("background.command.toggleSidebar.error", { message: errorText(error) });
    });
  });

  api.runtime.onMessage.addListener((message) => handleMessage(message));

  api.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[APP_PREFERENCES_STORAGE_KEY]) {
      return;
    }
    void handlePreferencesChanged(changes[APP_PREFERENCES_STORAGE_KEY].newValue).catch((error) => {
      perfTrace.mark("background.preferences.changed.error", { message: errorText(error) });
    });
  });

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
      await queueRuntimeActivation(activeInfo);
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
    if (isSidebarPerformanceTraceCollectedMessage(message)) {
      return handleSidebarPerformanceTraceCollected(message);
    }

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

    if (isInitialTreeSnapshotMessage(message)) {
      return initialTreeSnapshot();
    }

    if (!isBackgroundCommand(message)) {
      return undefined;
    }

    if (message.type === "getHistoryStatus") {
      return historyStatusMessage(await ensureHistory());
    }

    if (message.type === "undo" || message.type === "redo") {
      return enqueueMutation(() => applyHistoryCommand(message.type), { reason: "history", command: message.type });
    }

    if (message.type === "refresh") {
      return commandAck(await refreshFromRuntime());
    }

    if (message.type === "getState") {
      await waitForSchedulerIdle();
      return ensureState();
    }

    return enqueueMutation(async () => {
      const current = await ensureState();
      const historyPrevious = isTrackableHistoryCommandType(message.type)
        ? message.type === "toggleCollapsed"
          ? stateWithClonedNode(current, message.nodeId)
          : current
        : undefined;
      const outlinerClosePlan = message.type === "closeNode"
        ? closePlanForCloseNodeCommand(current, message.nodeId)
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
      for (const tabId of outlinerClosePlan?.tabIds ?? []) {
        outlinerClosingTabIds.add(tabId);
      }
      for (const windowId of outlinerClosePlan?.windowIds ?? []) {
        outlinerClosingWindowIds.add(windowId);
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
        for (const tabId of outlinerClosePlan?.tabIds ?? []) {
          outlinerClosingTabIds.delete(tabId);
        }
        for (const windowId of outlinerClosePlan?.windowIds ?? []) {
          outlinerClosingWindowIds.delete(windowId);
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
      if (historyPrevious && isTrackableHistoryCommandType(message.type)) {
        const candidateNodeIds = historyCandidateNodeIds(message, historyPrevious, result.state);
        await recordHistoryEntry(message.type, historyPrevious, result.state, {
          ...(candidateNodeIds ? { candidateNodeIds } : {})
        });
      }
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

  async function initialTreeSnapshot(): Promise<InitialTreeSnapshot | undefined> {
    if (state) {
      return initialTreeSnapshotFromFullState(state, false);
    }

    const snapshot = await perfTrace.measureAsync("background.state.initialSnapshot.load", () =>
      loadInitialTreeSnapshot(api)
    );
    if (snapshot) {
      return snapshot;
    }

    return undefined;
  }

  function initialTreeSnapshotFromFullState(source: OutlineState, hydrating: boolean): InitialTreeSnapshot {
    const snapshot = initialTreeSnapshotForState(source, { hydrating });
    snapshot.hydrating = snapshot.projection.totalRowCount > snapshot.projection.rows.length;
    return snapshot;
  }

  async function ensureHistory(): Promise<HistoryState> {
    const activePreferences = await ensurePreferences();
    historyState ??= normalizeHistoryState(await loadHistory(api, activePreferences.undoHistoryLimit), activePreferences.undoHistoryLimit);
    return historyState;
  }

  async function ensurePreferences(): Promise<AppPreferences> {
    preferences ??= await loadAppPreferences(api);
    return preferences;
  }

  async function initializeState(): Promise<OutlineState> {
    const [windows, stored] = await Promise.all([
      perfTrace.measureAsync("background.runtime.getWindows", () => getNormalWindows(api)),
      perfTrace.measureAsync("background.state.load", () => loadState(api))
    ]);
    if (stored) {
      if (runtimeSnapshotMateriallyMatchesState(stored, windows)) {
        state = stored;
      } else {
        const repaired = repairState(stored);
        const reconciled = reconcileWithWindows(repaired, windows, { now: now() });
        state = statesEqualIgnoringUpdatedAt(repaired, reconciled) ? repaired : reconciled;
        if (!statesMateriallyEqual(stored, state)) {
          scheduleStateSave(state);
        }
      }
    } else {
      state = bootstrapFromWindows(windows, { now: now() });
      scheduleStateSave(state);
    }
    runtimeIndex = buildRuntimeStateIndex(state);
    return state;
  }

  async function recordHistoryEntry(
    commandType: TrackableHistoryCommandType,
    previous: OutlineState,
    next: OutlineState,
    options: { candidateNodeIds?: readonly NodeId[] } = {}
  ): Promise<void> {
    const entry = createHistoryEntry(commandType, previous, next, options);
    if (!entry) {
      return;
    }

    const activePreferences = await ensurePreferences();
    historyState = pushUndoEntry(await ensureHistory(), entry, activePreferences.undoHistoryLimit);
    scheduleHistorySave(historyState);
    broadcastHistoryStatusSoon(historyState);
  }

  async function applyHistoryCommand(direction: "undo" | "redo"): Promise<CommandAck> {
    const history = await ensureHistory();
    const popped = direction === "undo" ? popUndoEntry(history) : popRedoEntry(history);
    if (!popped.entry) {
      return commandAck(false);
    }

    const current = await ensureState();
    const next = await applyHistoryDeltaWithRuntime(current, direction === "undo" ? popped.entry.undo : popped.entry.redo);
    if (statesMateriallyEqual(current, next)) {
      historyState = popped.history;
      scheduleHistorySave(historyState);
      broadcastHistoryStatusSoon(historyState);
      return commandAck(false);
    }

    state = next;
    stateCache.replace(next);
    const activePreferences = await ensurePreferences();
    historyState = direction === "undo"
      ? pushRedoEntry(popped.history, popped.entry, activePreferences.undoHistoryLimit)
      : pushUndoEntryPreservingRedo(popped.history, popped.entry, activePreferences.undoHistoryLimit);
    await persistWithBestEffortPatch(current, next, { diffMode: "material" });
    scheduleHistorySave(historyState);
    broadcastHistoryStatusSoon(historyState);
    return commandAck(true);
  }

  async function handlePreferencesChanged(value: unknown): Promise<void> {
    const nextPreferences = normalizeAppPreferences(value);
    const previousLimit = (preferences ?? DEFAULT_APP_PREFERENCES).undoHistoryLimit;
    preferences = nextPreferences;
    if (!historyState || previousLimit === nextPreferences.undoHistoryLimit) {
      return;
    }

    const trimmed = normalizeHistoryState(historyState, nextPreferences.undoHistoryLimit);
    if (
      trimmed.undoStack.length === historyState.undoStack.length &&
      trimmed.redoStack.length === historyState.redoStack.length
    ) {
      return;
    }

    historyState = trimmed;
    scheduleHistorySave(historyState);
    broadcastHistoryStatusSoon(historyState);
  }

  async function applyHistoryDeltaWithRuntime(current: OutlineState, delta: OutlineDelta): Promise<OutlineState> {
    const next = applyOutlineDelta(current, delta);
    const closedRuntimeResources = await closeDeletedLiveRuntimeResources(current, next);
    const materializedRuntimeResources = await materializeHistoryLiveResources(current, next);
    if (closedRuntimeResources || materializedRuntimeResources || liveStructureChanged(current, next)) {
      await syncBrowserOrder(next, adapter);
    }
    return next;
  }

  async function closeDeletedLiveRuntimeResources(current: OutlineState, next: OutlineState): Promise<boolean> {
    const nextLiveTabIds = new Set(liveTabNodes(next).map((node) => node.live.tabId));
    const deletedNodeIds = Object.keys(current.nodes).filter((nodeId) => !next.nodes[nodeId]);
    const closedWindowIds = new Set<number>();
    const tabIdsToClose: number[] = [];

    for (const nodeId of deletedNodeIds) {
      const node = current.nodes[nodeId];
      if (!node || !isLiveWindowNode(node)) {
        continue;
      }

      const windowLiveTabs = projectLiveTabs(current, node.id);
      if (windowLiveTabs.length > 0 && windowLiveTabs.some((tab) => nextLiveTabIds.has(tab.tabId))) {
        continue;
      }

      await adapter.closeWindow(node.live.windowId);
      closedWindowIds.add(node.live.windowId);
    }

    for (const nodeId of deletedNodeIds) {
      const node = current.nodes[nodeId];
      if (!node || !isLiveTabNode(node) || nextLiveTabIds.has(node.live.tabId) || closedWindowIds.has(node.live.windowId)) {
        continue;
      }
      tabIdsToClose.push(node.live.tabId);
    }

    if (tabIdsToClose.length > 0) {
      await adapter.closeTabs(tabIdsToClose);
    }

    return closedWindowIds.size > 0 || tabIdsToClose.length > 0;
  }

  async function materializeHistoryLiveResources(current: OutlineState, next: OutlineState): Promise<boolean> {
    let changed = false;
    const tabNodesCreatedWithWindow = new Set<NodeId>();

    for (const windowNode of liveWindowNodes(next)) {
      const currentWindow = current.nodes[windowNode.id];
      if (currentWindow && isLiveWindowNode(currentWindow)) {
        if (windowNode.live.windowId !== currentWindow.live.windowId) {
          replaceLiveWindowIdInSubtree(next, windowNode.id, currentWindow.live.windowId);
          changed = true;
        }
        continue;
      }

      const existingTabNode = liveTabNodesInSubtree(next, windowNode.id)
        .find((node) => {
          const currentNode = current.nodes[node.id];
          return Boolean(currentNode && isLiveTabNode(currentNode));
        });
      if (existingTabNode) {
        const currentTab = current.nodes[existingTabNode.id];
        if (!currentTab || !isLiveTabNode(currentTab)) {
          continue;
        }
        const createdWindow = await adapter.createWindow({ tabId: currentTab.live.tabId });
        replaceLiveWindowIdInSubtree(next, windowNode.id, createdWindow.id);
        changed = true;
        continue;
      }

      const missingTabNodes = liveTabNodesInSubtree(next, windowNode.id)
        .filter((node) => !isLiveTabNode(current.nodes[node.id]));
      const firstMissingTab = missingTabNodes[0];
      const createdWindow = await adapter.createWindow({
        url: firstMissingTab ? historyNodeUrl(firstMissingTab) : "about:blank"
      });
      replaceLiveWindowIdInSubtree(next, windowNode.id, createdWindow.id);
      const createdTab = createdWindow.tabs?.[0];
      if (firstMissingTab && createdTab) {
        updateLiveTabRef(next, firstMissingTab.id, createdTab.id, createdWindow.id);
        tabNodesCreatedWithWindow.add(firstMissingTab.id);
      }
      changed = true;
    }

    for (const node of liveTabNodes(next)) {
      const currentNode = current.nodes[node.id];
      const targetWindowId = nearestLiveWindowId(next, node.id) ?? node.live.windowId;
      if (currentNode && isLiveTabNode(currentNode)) {
        if (node.live.tabId !== currentNode.live.tabId || node.live.windowId !== targetWindowId) {
          updateLiveTabRef(next, node.id, currentNode.live.tabId, targetWindowId);
          changed = true;
        }
        continue;
      }

      if (tabNodesCreatedWithWindow.has(node.id)) {
        continue;
      }

      const created = await adapter.createTab({
        url: historyNodeUrl(node),
        windowId: targetWindowId,
        active: node.active === true
      });
      updateLiveTabRef(next, node.id, created.id, created.windowId);
      changed = true;
    }

    return changed;
  }

  async function refreshFromRuntime(eventTabs: RuntimeTab[] = [], options: RefreshOptions = {}): Promise<boolean> {
    return enqueueMutation(async () => refreshFromRuntimeNow(eventTabs, options), { reason: "refreshFromRuntime" });
  }

  function queueRuntimeRefresh(eventTabs: RuntimeTab[] = [], options: RefreshOptions = {}): Promise<boolean> {
    const requestedCloseMissing = options.closeMissing ?? eventTabs.length === 0;
    const pending = pendingRuntimeRefresh ?? createPendingRuntimeRefresh();
    pendingRuntimeRefresh = pending;
    pending.closeMissing ||= requestedCloseMissing;

    for (const tab of eventTabs) {
      pending.eventTabsById.set(tab.id, tab);
    }

    const promise = addRuntimeRefreshCaller(pending);
    schedulePendingRuntimeRefresh(pending);
    return promise;
  }

  function queueRuntimeActivation(activeInfo: { tabId: number; windowId: number }): Promise<boolean> {
    const pendingTab = pendingRuntimeRefresh?.eventTabsById.get(activeInfo.tabId);
    if (pendingRuntimeRefresh && pendingTab) {
      pendingRuntimeRefresh.activationByWindowId.set(activeInfo.windowId, activeInfo.tabId);
      pendingRuntimeRefresh.eventTabsById.set(activeInfo.tabId, {
        ...pendingTab,
        active: true
      });
      const promise = addRuntimeRefreshCaller(pendingRuntimeRefresh);
      schedulePendingRuntimeRefresh(pendingRuntimeRefresh);
      return promise;
    }

    return queueRuntimeRefresh();
  }

  function createPendingRuntimeRefresh(): PendingRuntimeRefresh {
    return {
      eventTabsById: new Map(),
      activationByWindowId: new Map(),
      closeMissing: false,
      callers: [],
      scheduled: false
    };
  }

  function addRuntimeRefreshCaller(pending: PendingRuntimeRefresh): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      pending.callers.push({ resolve, reject });
    });
  }

  function schedulePendingRuntimeRefresh(pending: PendingRuntimeRefresh): void {
    if (pending.scheduled) {
      return;
    }
    pending.scheduled = true;
    globalThis.setTimeout(() => {
      void enqueueMutation(() => runPendingRuntimeRefresh(pending), {
        reason: "refreshFromRuntime",
        source: "runtimeEvent"
      }, { priority: "low" }).catch(() => undefined);
    }, RUNTIME_REFRESH_BATCH_DELAY_MS);
  }

  async function runPendingRuntimeRefresh(pending: PendingRuntimeRefresh): Promise<boolean> {
    if (pendingRuntimeRefresh !== pending) {
      for (const caller of pending.callers) {
        caller.resolve(false);
      }
      return false;
    }

    pendingRuntimeRefresh = undefined;

    try {
      const eventTabs = [...pending.eventTabsById.values()].map((tab) => {
        const activatedTabId = pending.activationByWindowId.get(tab.windowId);
        return typeof activatedTabId === "number"
          ? {
              ...tab,
              active: tab.id === activatedTabId
            }
          : tab;
      });
      const changed = await refreshFromRuntimeNow(eventTabs, {
        closeMissing: pending.closeMissing
      });
      for (const caller of pending.callers) {
        caller.resolve(changed);
      }
      return changed;
    } catch (error) {
      for (const caller of pending.callers) {
        caller.reject(error);
      }
      throw error;
    }
  }

  async function refreshFromRuntimeNow(eventTabs: RuntimeTab[] = [], options: RefreshOptions = {}): Promise<boolean> {
    const current = await ensureState();
    const closeMissing = options.closeMissing ?? eventTabs.length === 0;
    const index = runtimeIndexForState(current);
    const currentEventTabs = eventTabs
      .filter((tab) => !removedTabIds.has(tab.id))
      .filter((tab) => !consumeCommandRestoredTabEvent(current, commandRestoredTabIds, tab))
      .filter((tab) => tabEventMayChangeState(current, tab, index));
    if (eventTabs.length > 0 && currentEventTabs.length === 0 && !closeMissing) {
      return false;
    }
    if (!closeMissing && currentEventTabs.length > 0) {
      const fastPath = await applyRuntimeEventTabsFastPath(current, currentEventTabs, index);
      if (fastPath.handled) {
        if (!fastPath.changed) {
          return false;
        }
        state = fastPath.state;
        stateCache.replace(state);
        runtimeIndex = fastPath.index;
        await persistKnownRuntimeFastPathUpdate(fastPath.update, state);
        return true;
      }
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

  async function applyRuntimeEventTabsFastPath(
    current: OutlineState,
    eventTabs: RuntimeTab[],
    index: RuntimeStateIndex
  ): Promise<RuntimeEventTabsFastPathResult> {
    let next = current;
    let structuralChanged = false;
    const changedNodeIds = new Set<NodeId>();
    const mutableIndex = cloneRuntimeStateIndex(index);
    const fetchedWindows = new Map<number, RuntimeWindow | undefined>();

    const ensureMutableState = (): OutlineState => {
      if (next === current) {
        next = {
          version: current.version,
          rootIds: current.rootIds,
          nodes: { ...current.nodes }
        };
      }
      return next;
    };
    const mutableRootIds = (): NodeId[] => {
      const stateForMutation = ensureMutableState();
      if (stateForMutation.rootIds === current.rootIds) {
        stateForMutation.rootIds = [...current.rootIds];
      }
      return stateForMutation.rootIds;
    };
    const cloneNodeForMutation = (nodeId: NodeId): OutlineNode | undefined => {
      const stateForMutation = ensureMutableState();
      const node = stateForMutation.nodes[nodeId];
      if (!node) {
        return undefined;
      }
      changedNodeIds.add(nodeId);
      if (node === current.nodes[nodeId]) {
        stateForMutation.nodes[nodeId] = cloneOutlineNode(node);
      }
      return stateForMutation.nodes[nodeId];
    };

    const ensureRuntimeWindowNode = async (windowId: number): Promise<NodeId | undefined> => {
      const existingWindowNodeId = mutableIndex.liveWindowNodeIdsByRuntimeId.get(windowId);
      if (existingWindowNodeId && next.nodes[existingWindowNodeId]) {
        return existingWindowNodeId;
      }

      if (!fetchedWindows.has(windowId)) {
        fetchedWindows.set(
          windowId,
          await perfTrace.measureAsync("background.runtime.getWindow", { windowId }, () => getNormalWindow(api, windowId))
        );
      }
      const windowInfo = fetchedWindows.get(windowId);
      if (!windowInfo) {
        return undefined;
      }

      const windowNodeId = uniqueRuntimeNodeId(next, windowNodeIdForRuntime(windowInfo.id), now());
      const stateForMutation = ensureMutableState();
      stateForMutation.nodes[windowNodeId] = {
        id: windowNodeId,
        kind: "window",
        status: "live",
        childIds: [],
        title: "Group",
        active: windowInfo.focused,
        collapsed: false,
        createdAt: now(),
        updatedAt: now(),
        live: { windowId: windowInfo.id }
      };
      changedNodeIds.add(windowNodeId);
      structuralChanged = true;
      mutableRootIds().push(windowNodeId);
      mutableIndex.liveWindowNodeIdsByRuntimeId.set(windowInfo.id, windowNodeId);
      mutableIndex.liveTabNodeIdsByWindowId.set(windowInfo.id, new Set());
      if (windowInfo.focused) {
        clearActiveWindowForRuntimeFastPath(windowNodeId);
      }
      return windowNodeId;
    };

    const clearActiveWindowForRuntimeFastPath = (activeWindowNodeId: NodeId): void => {
      const previousActiveWindowNodeId = mutableIndex.activeWindowNodeId;
      if (previousActiveWindowNodeId && previousActiveWindowNodeId !== activeWindowNodeId) {
        const previousActiveWindow = cloneNodeForMutation(previousActiveWindowNodeId);
        if (previousActiveWindow) {
          previousActiveWindow.active = false;
        }
      }
      const activeWindow = cloneNodeForMutation(activeWindowNodeId);
      if (activeWindow) {
        activeWindow.active = true;
      }
      mutableIndex.activeWindowNodeId = activeWindowNodeId;
    };

    const activateTabForRuntimeFastPath = (windowId: number, activeTabNodeId: NodeId): void => {
      const previousActiveTabNodeId = mutableIndex.activeTabNodeIdsByWindowId.get(windowId);
      if (previousActiveTabNodeId && previousActiveTabNodeId !== activeTabNodeId) {
        const previousActiveTab = cloneNodeForMutation(previousActiveTabNodeId);
        if (previousActiveTab) {
          previousActiveTab.active = false;
        }
      }
      const activeTab = cloneNodeForMutation(activeTabNodeId);
      if (activeTab) {
        activeTab.active = true;
      }
      mutableIndex.activeTabNodeIdsByWindowId.set(windowId, activeTabNodeId);
    };

    const deactivateTabForRuntimeFastPath = (windowId: number, tabNodeId: NodeId): void => {
      const tabNode = cloneNodeForMutation(tabNodeId);
      if (tabNode) {
        tabNode.active = false;
      }
      if (mutableIndex.activeTabNodeIdsByWindowId.get(windowId) === tabNodeId) {
        mutableIndex.activeTabNodeIdsByWindowId.delete(windowId);
      }
    };

    for (const tab of eventTabs) {
      if (tab.incognito) {
        continue;
      }

      const windowNodeId = await ensureRuntimeWindowNode(tab.windowId);
      if (!windowNodeId) {
        return { handled: false };
      }

      const existingTabNodeId = mutableIndex.liveTabNodeIdsByRuntimeId.get(tab.id);
      if (existingTabNodeId) {
        const existingTab = next.nodes[existingTabNodeId];
        if (!isLiveTabNode(existingTab) || existingTab.live.windowId !== tab.windowId) {
          return { handled: false };
        }
        if (liveTabNodeWouldChange(existingTab, tab)) {
          const tabNode = cloneNodeForMutation(existingTabNodeId);
          if (tabNode) {
            updateRuntimeTabNodeForFastPath(tabNode, tab, now());
          }
        }
        if (tab.active) {
          activateTabForRuntimeFastPath(tab.windowId, existingTabNodeId);
        } else if (existingTab.active) {
          deactivateTabForRuntimeFastPath(tab.windowId, existingTabNodeId);
        }
        continue;
      }

      if (mutableIndex.windowNodeIdsWithClosedRestoreCandidates.has(windowNodeId)) {
        return { handled: false };
      }

      const parentId = parentNodeIdForRuntimeTabFastPath(next, mutableIndex, tab, windowNodeId);
      const parent = next.nodes[parentId];
      if (!parent) {
        return { handled: false };
      }

      const tabNodeId = uniqueRuntimeNodeId(next, tabNodeIdForRuntime(tab.id), now());
      const stateForMutation = ensureMutableState();
      const parentNode = cloneNodeForMutation(parentId);
      if (!parentNode) {
        return { handled: false };
      }
      parentNode.childIds.push(tabNodeId);
      stateForMutation.nodes[tabNodeId] = runtimeTabNodeForFastPath(tab, tabNodeId, parentId, now());
      changedNodeIds.add(tabNodeId);
      structuralChanged = true;
      mutableIndex.liveTabNodeIdsByRuntimeId.set(tab.id, tabNodeId);
      const windowTabNodeIds = mutableIndex.liveTabNodeIdsByWindowId.get(tab.windowId) ?? new Set<NodeId>();
      windowTabNodeIds.add(tabNodeId);
      mutableIndex.liveTabNodeIdsByWindowId.set(tab.windowId, windowTabNodeIds);
      if (tab.active) {
        activateTabForRuntimeFastPath(tab.windowId, tabNodeId);
      }
    }

    if (next === current) {
      return {
        handled: true,
        changed: false
      };
    }

    mutableIndex.state = next;
    const updatedNodes = [...changedNodeIds].flatMap((nodeId) => {
      const node = next.nodes[nodeId];
      return node ? [node] : [];
    });
    const update: TreeStructureUpdate | NodeStateUpdate = structuralChanged
      ? {
          type: "treeStructureUpdated",
          deletedNodeIds: [],
          updatedNodes,
          rootIds: next.rootIds,
          deletedClosedCount: 0
        }
      : {
          type: "nodeStateUpdated",
          updatedNodes,
          closedCountDelta: 0
        };
    return {
      handled: true,
      changed: true,
      state: next,
      index: mutableIndex,
      update
    };
  }

  function runtimeIndexForState(current: OutlineState): RuntimeStateIndex {
    if (runtimeIndex?.state === current) {
      return runtimeIndex;
    }

    runtimeIndex = buildRuntimeStateIndex(current);
    return runtimeIndex;
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

  function enqueueMutation<T>(
    operation: () => Promise<T>,
    detail?: TraceDetail,
    options: { priority?: MutationPriority } = {}
  ): Promise<T> {
    const priority = options.priority ?? "high";
    const queuedAt = performance.now();
    const mutationDetail = detail ? { ...detail } : undefined;
    const promise = new Promise<T>((resolve, reject) => {
      const mutation: ScheduledMutation<T> = {
        operation,
        detail: mutationDetail,
        priority,
        queuedAt,
        resolve,
        reject
      };
      if (priority === "high") {
        highPriorityMutations.push(mutation as ScheduledMutation);
      } else {
        lowPriorityMutations.push(mutation as ScheduledMutation);
      }
      scheduleMutationDrain();
    });
    return promise;
  }

  function scheduleMutationDrain(): void {
    if (schedulerRunning || schedulerDrainQueued) {
      return;
    }
    schedulerDrainQueued = true;
    void Promise.resolve().then(runScheduledMutations);
  }

  async function runScheduledMutations(): Promise<void> {
    if (schedulerRunning) {
      schedulerDrainQueued = false;
      return;
    }

    schedulerDrainQueued = false;
    schedulerRunning = true;
    try {
      for (;;) {
        const mutation = highPriorityMutations.shift() ?? lowPriorityMutations.shift();
        if (!mutation) {
          return;
        }
        await runScheduledMutation(mutation);
      }
    } finally {
      schedulerRunning = false;
      if (highPriorityMutations.length > 0 || lowPriorityMutations.length > 0) {
        scheduleMutationDrain();
      } else {
        notifySchedulerIdleIfNeeded();
      }
    }
  }

  async function runScheduledMutation(mutation: ScheduledMutation): Promise<void> {
    const mutationDetail = {
      ...mutation.detail,
      priority: mutation.priority
    };
    perfTrace.mark("background.mutation.start", {
      ...mutationDetail,
      waitMs: Math.round(performance.now() - mutation.queuedAt)
    });
    try {
      const result = await perfTrace.measureAsync("background.mutation.run", mutationDetail, mutation.operation);
      mutation.resolve(result);
    } catch (error) {
      mutation.reject(error);
    }
  }

  function waitForSchedulerIdle(): Promise<void> {
    if (isSchedulerIdle()) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      schedulerIdleResolvers.push(resolve);
    });
  }

  function isSchedulerIdle(): boolean {
    return !schedulerRunning &&
      !schedulerDrainQueued &&
      highPriorityMutations.length === 0 &&
      lowPriorityMutations.length === 0 &&
      !pendingRuntimeRefresh;
  }

  function notifySchedulerIdleIfNeeded(): void {
    if (!isSchedulerIdle() || schedulerIdleResolvers.length === 0) {
      return;
    }

    const resolvers = schedulerIdleResolvers.splice(0);
    for (const resolve of resolvers) {
      resolve();
    }
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

  async function persistKnownRuntimeFastPathUpdate(
    update: TreeStructureUpdate | NodeStateUpdate,
    next: OutlineState
  ): Promise<void> {
    if (update.type === "treeStructureUpdated") {
      await broadcastTreeStructureUpdate(update);
    } else {
      await broadcastNodeStateUpdate(update);
    }
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

  async function broadcastHistoryStatus(history: HistoryState): Promise<void> {
    await broadcastWithTrace(historyStatusMessage(history));
  }

  function broadcastHistoryStatusSoon(history: HistoryState): void {
    void broadcastHistoryStatus(history).catch((error) => {
      perfTrace.mark("background.runtime.broadcast.historyStatus.error", { message: errorText(error) });
    });
  }

  function scheduleStateSave(next: OutlineState): void {
    pendingSaveState = next;
    schedulePendingSave();
  }

  function scheduleHistorySave(next: HistoryState): void {
    pendingSaveHistory = next;
    schedulePendingSave();
  }

  function schedulePendingSave(): void {
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

    while (pendingSaveState || pendingSaveHistory || saveInFlight) {
      if (saveInFlight) {
        await saveInFlight;
        continue;
      }

      const nextState = pendingSaveState;
      const nextHistory = pendingSaveHistory;
      if (!nextState && !nextHistory) {
        return;
      }
      pendingSaveState = undefined;
      pendingSaveHistory = undefined;
      saveInFlight = saveStateAndHistoryNowWithTrace(nextState, nextHistory).finally(() => {
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

  async function saveStateAndHistoryNowWithTrace(
    nextState: OutlineState | undefined,
    nextHistory: HistoryState | undefined
  ): Promise<void> {
    await perfTrace.measureAsync("background.state.save", () => saveStateAndHistory(nextState, nextHistory, api));
  }

  async function broadcastWithTrace(message: { type: string } & Record<string, unknown>): Promise<void> {
    await perfTrace.measureAsync("background.runtime.broadcast", { type: message.type }, async () => {
      await api.runtime.sendMessage(message).catch(() => undefined);
    });
  }

  function getDiagnosticsCoalesced(): Promise<OutlineDiagnostics> {
    diagnosticsInFlight ??= perfTrace.measureAsync("background.diagnostics", async () => {
      await waitForSchedulerIdle();
      return computeDiagnostics(await ensureState(), await getNormalWindows(api));
    }).finally(() => {
      diagnosticsInFlight = undefined;
    });
    return diagnosticsInFlight;
  }

  async function handlePerformanceTraceMessage(
    message: PerformanceTraceMessage
  ): Promise<TraceSnapshot | PerformanceProfileSnapshot | { ok: true }> {
    if (message.type === "setPerformanceTraceEnabled") {
      if (message.enabled) {
        perfTrace.setEnabled(true);
        perfTrace.mark("background.profile.enabled");
      } else {
        perfTrace.mark("background.profile.disabled");
        perfTrace.setEnabled(false);
      }
      await sendSidebarPerformanceTraceEnabled(message.enabled);
      return { ok: true };
    }
    if (message.type === "clearPerformanceTrace") {
      perfTrace.clear();
      await clearSidebarPerformanceTrace();
      return { ok: true };
    }
    if (message.type === "getPerformanceProfile") {
      return performanceProfileSnapshot();
    }
    return perfTrace.snapshot();
  }

  async function performanceProfileSnapshot(): Promise<PerformanceProfileSnapshot> {
    const background = perfTrace.snapshot();
    return {
      background,
      sidebars: await collectSidebarPerformanceTraces()
    };
  }

  async function collectSidebarPerformanceTraces(): Promise<LabeledTraceSnapshot[]> {
    const requestId = `sidebar-profile:${now()}:${sidebarProfileRequestSequence += 1}`;
    const sidebars = await new Promise<LabeledTraceSnapshot[]>((resolve) => {
      const collectedSidebars: LabeledTraceSnapshot[] = [];
      globalThis.setTimeout(() => {
        pendingSidebarProfileCollections.delete(requestId);
        resolve([...collectedSidebars]);
      }, SIDEBAR_PROFILE_COLLECTION_DELAY_MS);
      const collection: PendingSidebarProfileCollection = {
        sidebars: collectedSidebars,
        seenSidebarIds: new Set()
      };
      pendingSidebarProfileCollections.set(requestId, collection);
      void api.runtime.sendMessage({ type: "collectSidebarPerformanceTrace", requestId }).catch(() => undefined);
    });
    return sidebars;
  }

  function handleSidebarPerformanceTraceCollected(
    message: SidebarPerformanceTraceCollectedMessage
  ): { ok: true } {
    const collection = pendingSidebarProfileCollections.get(message.requestId);
    if (!collection || collection.seenSidebarIds.has(message.sidebar.id)) {
      return { ok: true };
    }

    collection.seenSidebarIds.add(message.sidebar.id);
    collection.sidebars.push(message.sidebar);
    return { ok: true };
  }

  async function sendSidebarPerformanceTraceEnabled(enabled: boolean): Promise<void> {
    await api.runtime.sendMessage({ type: "setSidebarPerformanceTraceEnabled", enabled }).catch(() => undefined);
  }

  async function clearSidebarPerformanceTrace(): Promise<void> {
    await api.runtime.sendMessage({ type: "clearSidebarPerformanceTrace" }).catch(() => undefined);
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

function historyStatusMessage(history: HistoryState): { type: "historyStatus" } & HistoryStatus {
  return {
    type: "historyStatus",
    ...historyStatus(history)
  };
}

function buildRuntimeStateIndex(state: OutlineState): RuntimeStateIndex {
  const index: RuntimeStateIndex = {
    state,
    liveTabNodeIdsByRuntimeId: new Map(),
    liveWindowNodeIdsByRuntimeId: new Map(),
    liveTabNodeIdsByWindowId: new Map(),
    activeTabNodeIdsByWindowId: new Map(),
    windowNodeIdsWithClosedRestoreCandidates: new Set()
  };

  for (const node of Object.values(state.nodes)) {
    if (isLiveWindowNode(node)) {
      index.liveWindowNodeIdsByRuntimeId.set(node.live.windowId, node.id);
      if (node.active) {
        index.activeWindowNodeId = node.id;
      }
      continue;
    }

    if (isLiveTabNode(node)) {
      index.liveTabNodeIdsByRuntimeId.set(node.live.tabId, node.id);
      const windowTabNodeIds = index.liveTabNodeIdsByWindowId.get(node.live.windowId) ?? new Set<NodeId>();
      windowTabNodeIds.add(node.id);
      index.liveTabNodeIdsByWindowId.set(node.live.windowId, windowTabNodeIds);
      if (node.active) {
        index.activeTabNodeIdsByWindowId.set(node.live.windowId, node.id);
      }
    }
  }

  const visited = new Set<NodeId>();
  const stack: Array<{ nodeId: NodeId; ownerWindowNodeId?: NodeId }> = state.rootIds.map((nodeId) => ({ nodeId }));
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (visited.has(entry.nodeId)) {
      continue;
    }
    visited.add(entry.nodeId);

    const node = state.nodes[entry.nodeId];
    if (!node) {
      continue;
    }

    const ownerWindowNodeId = node.kind === "window" ? node.id : entry.ownerWindowNodeId;
    if (ownerWindowNodeId && node.id !== ownerWindowNodeId && node.kind === "tab" && node.status === "closed") {
      index.windowNodeIdsWithClosedRestoreCandidates.add(ownerWindowNodeId);
    }

    for (const childId of node.childIds) {
      stack.push({
        nodeId: childId,
        ...(ownerWindowNodeId ? { ownerWindowNodeId } : {})
      });
    }
  }

  return index;
}

function cloneRuntimeStateIndex(index: RuntimeStateIndex): RuntimeStateIndex {
  return {
    state: index.state,
    liveTabNodeIdsByRuntimeId: new Map(index.liveTabNodeIdsByRuntimeId),
    liveWindowNodeIdsByRuntimeId: new Map(index.liveWindowNodeIdsByRuntimeId),
    liveTabNodeIdsByWindowId: new Map(
      [...index.liveTabNodeIdsByWindowId].map(([windowId, nodeIds]) => [windowId, new Set(nodeIds)])
    ),
    activeTabNodeIdsByWindowId: new Map(index.activeTabNodeIdsByWindowId),
    windowNodeIdsWithClosedRestoreCandidates: new Set(index.windowNodeIdsWithClosedRestoreCandidates),
    ...(index.activeWindowNodeId ? { activeWindowNodeId: index.activeWindowNodeId } : {})
  };
}

function runtimeTabNodeForFastPath(tab: RuntimeTab, nodeId: NodeId, parentId: NodeId, now: number): OutlineNode {
  const node: OutlineNode = {
    id: nodeId,
    kind: "tab",
    status: "live",
    parentId,
    childIds: [],
    title: tab.title || tab.url || "Untitled tab",
    active: tab.active,
    collapsed: false,
    createdAt: now,
    updatedAt: now,
    live: { tabId: tab.id, windowId: tab.windowId }
  };

  if (tab.url) {
    node.url = tab.url;
  }
  if (tab.favIconUrl) {
    node.favIconUrl = tab.favIconUrl;
  }

  return node;
}

function updateRuntimeTabNodeForFastPath(node: OutlineNode, tab: RuntimeTab, now: number): void {
  node.status = "live";
  node.title = runtimeTitleForOutlineTab(node, tab);
  node.active = tab.active;
  node.updatedAt = now;
  node.live = { tabId: tab.id, windowId: tab.windowId };
  if (tab.url !== undefined) {
    node.url = tab.url;
  }
  if (tab.favIconUrl !== undefined) {
    node.favIconUrl = tab.favIconUrl;
  }
  delete node.closedAt;
  delete node.restore;
}

function parentNodeIdForRuntimeTabFastPath(
  state: OutlineState,
  index: RuntimeStateIndex,
  tab: RuntimeTab,
  fallbackWindowNodeId: NodeId
): NodeId {
  if (typeof tab.openerTabId !== "number") {
    return fallbackWindowNodeId;
  }

  const openerNodeId = index.liveTabNodeIdsByRuntimeId.get(tab.openerTabId);
  if (!openerNodeId || !isNodeUnderRuntimeWindowFastPath(state, openerNodeId, tab.windowId)) {
    return fallbackWindowNodeId;
  }

  return openerNodeId;
}

function isNodeUnderRuntimeWindowFastPath(state: OutlineState, nodeId: NodeId, runtimeWindowId: number): boolean {
  const visited = new Set<NodeId>();
  let current = state.nodes[nodeId];

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (isLiveWindowNode(current)) {
      return current.live.windowId === runtimeWindowId;
    }
    current = current.parentId ? state.nodes[current.parentId] : undefined;
  }

  return false;
}

function tabNodeIdForRuntime(tabId: number): NodeId {
  return `tab:${tabId}`;
}

function windowNodeIdForRuntime(windowId: number): NodeId {
  return `window:${windowId}`;
}

function uniqueRuntimeNodeId(state: OutlineState, preferredId: NodeId, now: number): NodeId {
  if (!state.nodes[preferredId]) {
    return preferredId;
  }

  let index = 1;
  let candidate = `${preferredId}:${now}`;
  while (state.nodes[candidate]) {
    index += 1;
    candidate = `${preferredId}:${now}:${index}`;
  }
  return candidate;
}

function isTrackableHistoryCommandType(value: string): value is TrackableHistoryCommandType {
  return value === "moveNode" ||
    value === "moveNodeToNewWindow" ||
    value === "wrapNodeInGroup" ||
    value === "flattenSubtree" ||
    value === "toggleCollapsed" ||
    value === "renameGroup" ||
    value === "importTree" ||
    value === "deleteNode";
}

function stateWithClonedNode(state: OutlineState, nodeId: NodeId): OutlineState {
  const node = state.nodes[nodeId];
  if (!node) {
    return state;
  }

  return {
    version: state.version,
    rootIds: state.rootIds,
    nodes: {
      ...state.nodes,
      [nodeId]: cloneOutlineNode(node)
    }
  };
}

function historyCandidateNodeIds(
  command: BackgroundCommand,
  previous: OutlineState,
  next: OutlineState
): NodeId[] | undefined {
  if (command.type !== "moveNode" || !command.parentId) {
    return undefined;
  }

  const previousNode = previous.nodes[command.nodeId];
  const nextNode = next.nodes[command.nodeId];
  return uniqueDefinedNodeIds([
    command.nodeId,
    previousNode?.parentId,
    nextNode?.parentId,
    command.parentId
  ]);
}

function uniqueDefinedNodeIds(nodeIds: Array<NodeId | undefined>): NodeId[] {
  return [...new Set(nodeIds.filter((nodeId): nodeId is NodeId => Boolean(nodeId)))];
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
  const nextTitle = runtimeTitleForOutlineTab(node, tab);
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

function statesEqualIgnoringUpdatedAt(previous: OutlineState, next: OutlineState): boolean {
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
    return Boolean(previousNode && nextNode && nodesEqualIgnoringUpdatedAt(previousNode, nextNode));
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

function nodesEqualIgnoringUpdatedAt(previous: OutlineNode, next: OutlineNode): boolean {
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
  for (const node of Object.values(state.nodes)) {
    if (node.kind === "window" && node.status === "live" && node.live && "windowId" in node.live) {
      nodeIds.add(node.id);
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

function tabEventMayChangeState(state: OutlineState, tab: RuntimeTab, index: RuntimeStateIndex): boolean {
  const nodeId = index.liveTabNodeIdsByRuntimeId.get(tab.id);
  const node = nodeId ? state.nodes[nodeId] : undefined;
  if (!isLiveTabNode(node) || node.live.windowId !== tab.windowId) {
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

function closePlanForCloseNodeCommand(state: OutlineState, nodeId: NodeId): RuntimeClosePlan {
  const tabId = liveTabIdForNode(state, nodeId);
  if (typeof tabId === "number") {
    return { windowIds: [], tabIds: [tabId] };
  }

  const windowId = liveWindowIdForNode(state, nodeId);
  if (typeof windowId === "number") {
    return { windowIds: [windowId], tabIds: [] };
  }

  return planLiveSubtreeClose(state, nodeId);
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

function liveStructureChanged(previous: OutlineState, next: OutlineState): boolean {
  return liveStructureSignature(previous) !== liveStructureSignature(next);
}

function liveStructureSignature(state: OutlineState): string {
  return [
    ...liveWindowNodes(state).map((node) =>
      `window:${node.id}:${node.live.windowId}:${node.parentId ?? ""}:${node.childIds.join(",")}`
    ),
    ...liveTabNodes(state).map((node) =>
      `tab:${node.id}:${node.live.tabId}:${node.live.windowId}:${node.parentId ?? ""}`
    )
  ].sort().join("|");
}

function liveWindowNodes(state: OutlineState): Array<OutlineNode & { live: { windowId: number } }> {
  return Object.values(state.nodes).filter(isLiveWindowNode);
}

function liveTabNodes(state: OutlineState): Array<OutlineNode & { live: { tabId: number; windowId: number } }> {
  return Object.values(state.nodes).filter(isLiveTabNode);
}

function liveTabNodesInSubtree(
  state: OutlineState,
  nodeId: NodeId
): Array<OutlineNode & { live: { tabId: number; windowId: number } }> {
  const nodes: Array<OutlineNode & { live: { tabId: number; windowId: number } }> = [];
  const visited = new Set<NodeId>();
  const stack = [nodeId];

  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);

    const node = state.nodes[currentId];
    if (!node) {
      continue;
    }
    if (isLiveTabNode(node)) {
      nodes.push(node);
    }
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push(node.childIds[index]!);
    }
  }

  return nodes;
}

function replaceLiveWindowIdInSubtree(state: OutlineState, windowNodeId: NodeId, windowId: number): void {
  const windowNode = cloneNodeForHistoryMutation(state, windowNodeId);
  if (isLiveWindowNode(windowNode)) {
    windowNode.live = { windowId };
  }

  for (const tabNode of liveTabNodesInSubtree(state, windowNodeId)) {
    updateLiveTabRef(state, tabNode.id, tabNode.live.tabId, windowId);
  }
}

function updateLiveTabRef(state: OutlineState, nodeId: NodeId, tabId: number, windowId: number): void {
  const node = cloneNodeForHistoryMutation(state, nodeId);
  if (!node || node.kind !== "tab") {
    return;
  }
  node.status = "live";
  node.live = { tabId, windowId };
  node.updatedAt = Date.now();
  delete node.closedAt;
  delete node.restore;
}

function cloneNodeForHistoryMutation(state: OutlineState, nodeId: NodeId): OutlineNode | undefined {
  const node = state.nodes[nodeId];
  if (!node) {
    return undefined;
  }
  const cloned = cloneOutlineNode(node);
  state.nodes[nodeId] = cloned;
  return cloned;
}

function nearestLiveWindowId(state: OutlineState, nodeId: NodeId): number | undefined {
  const seen = new Set<NodeId>();
  let current = state.nodes[nodeId];

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (isLiveWindowNode(current)) {
      return current.live.windowId;
    }
    current = current.parentId ? state.nodes[current.parentId] : undefined;
  }

  return liveWindowNodes(state)[0]?.live.windowId;
}

function historyNodeUrl(node: OutlineNode): string {
  return node.url ?? node.restore?.url ?? "about:blank";
}

function isLiveWindowNode(node: OutlineNode | undefined): node is OutlineNode & { live: { windowId: number } } {
  return Boolean(node?.kind === "window" && node.status === "live" && node.live && "windowId" in node.live);
}

function isLiveTabNode(node: OutlineNode | undefined): node is OutlineNode & { live: { tabId: number; windowId: number } } {
  return Boolean(node?.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live);
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

function isInitialTreeSnapshotMessage(message: unknown): message is InitialTreeSnapshotMessage {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "getInitialTreeSnapshot"
  );
}

function isPerformanceTraceMessage(message: unknown): message is PerformanceTraceMessage {
  if (!message || typeof message !== "object") {
    return false;
  }

  const type = (message as { type?: unknown }).type;
  return type === "getPerformanceTrace" ||
    type === "getPerformanceProfile" ||
    type === "clearPerformanceTrace" ||
    (type === "setPerformanceTraceEnabled" && typeof (message as { enabled?: unknown }).enabled === "boolean");
}

function isSidebarPerformanceTraceCollectedMessage(
  message: unknown
): message is SidebarPerformanceTraceCollectedMessage {
  if (!message || typeof message !== "object") {
    return false;
  }
  const candidate = message as { type?: unknown; requestId?: unknown; sidebar?: unknown };
  return candidate.type === "sidebarPerformanceTraceCollected" &&
    typeof candidate.requestId === "string" &&
    isLabeledTraceSnapshot(candidate.sidebar);
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
