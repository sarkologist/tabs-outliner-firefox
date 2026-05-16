import type { BrowserAdapter } from "./adapter.js";
import { createBrowserAdapter } from "./browser-adapter.js";
import { computeDiagnostics } from "./diagnostics.js";
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
  reconcileWithWindows,
  repairState
} from "../model/outline.js";
import type { NodeId, OutlineNode, OutlineState, RuntimeTab, RuntimeWindow } from "../model/types.js";

export type BackgroundController = {
  ensureState(): Promise<OutlineState>;
  handleMessage(message: unknown): Promise<unknown>;
  refreshFromRuntime(eventTabs?: RuntimeTab[], options?: RefreshOptions): Promise<boolean>;
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

export type BackgroundControllerOptions = {
  api: WebExtensionBrowser;
  adapter?: BrowserAdapter;
  now?: () => number;
};

const RUNTIME_REFRESH_BATCH_DELAY_MS = 0;

export function createBackgroundController(options: BackgroundControllerOptions): BackgroundController {
  const { api, now = Date.now } = options;
  const adapter = options.adapter ?? createBrowserAdapter(api);

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

  api.runtime.onInstalled.addListener(() => {
    void ensureState();
  });

  api.runtime.onStartup.addListener(() => {
    void ensureState();
  });

  api.action.onClicked.addListener(async () => {
    await api.sidebarAction.open();
  });

  api.runtime.onMessage.addListener((message) => handleMessage(message));

  api.tabs.onCreated.addListener(async (tab) => {
    await queueRuntimeRefresh([tab]);
  });

  api.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
    if (!hasOutlineRelevantTabUpdate(changeInfo)) {
      return;
    }
    if (isCommandFocusActiveUpdateEcho(commandFocusedActivationWindowIds, changeInfo, tab)) {
      return;
    }
    await queueRuntimeRefresh([tab]);
  });

  api.tabs.onActivated.addListener(async (activeInfo) => {
    if (commandFocusedTabIds.has(activeInfo.tabId)) {
      await handleCommandTabActivated(activeInfo);
      return;
    }
    await queueRuntimeRefresh();
  });

  api.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
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
      await persistAndBroadcast();
    });
  });

  api.windows.onRemoved.addListener(async (windowId) => {
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
        await persistAndBroadcast();
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
      await persistAndBroadcast();
    });
  });

  api.windows.onFocusChanged.addListener(async (windowId) => {
    if (commandFocusedWindowIds.has(windowId)) {
      await handleCommandWindowFocusChanged(windowId);
      return;
    }
    await queueRuntimeRefresh([], { closeMissing: false });
  });

  api.sessions.onChanged.addListener(async () => {
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
        if (await reconcileMissingLiveTabsInOpenWindows()) {
          await persistAndBroadcast();
        }
      } finally {
        sessionChangedQueued = false;
      }
    });
  });

  async function handleMessage(message: unknown): Promise<unknown> {
    if (isDiagnosticsRequest(message)) {
      await mutationQueue;
      return computeDiagnostics(await ensureState(), await getNormalWindows(api));
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
        result = await runCommand(current, adapter, message);
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
        for (const tabId of restoredLiveTabIdsChangedByCommand(current, result.state)) {
          commandRestoredTabIds.add(tabId);
        }
      }
      state = result.state;
      stateCache.replace(result.state);
      if (message.type === "deleteNode") {
        await broadcastTreeStructureUpdate(treeStructureUpdateFromStateChange(current, result.state));
        await saveState(result.state, api);
        return commandAck(true);
      }
      await persistAndBroadcast();
      return commandAck(true);
    });
  }

  async function ensureState(): Promise<OutlineState> {
    return stateCache.get();
  }

  async function initializeState(): Promise<OutlineState> {
    const windows = await getNormalWindows(api);
    const stored = await loadState(api);
    state = stored
      ? reconcileWithWindows(repairState(stored), windows, { now: now() })
      : bootstrapFromWindows(windows, { now: now() });
    await saveState(state, api);
    return state;
  }

  async function refreshFromRuntime(eventTabs: RuntimeTab[] = [], options: RefreshOptions = {}): Promise<boolean> {
    return enqueueMutation(async () => refreshFromRuntimeNow(eventTabs, options));
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
      .filter((tab) => !consumeCommandRestoredTabEvent(current, commandRestoredTabIds, tab));
    if (eventTabs.length > 0 && currentEventTabs.length === 0 && !closeMissing) {
      return false;
    }
    const windowsSnapshot =
      currentEventTabs.length > 0
        ? await getNormalWindowsIncludingTabs(api, currentEventTabs)
        : await getNormalWindows(api);
    const windows = filterRemovedTabsFromWindows(windowsSnapshot, removedTabIds);
    state = reconcileWithWindows(current, windows, { now: now() }, {
      closeMissing
    });
    stateCache.replace(state);
    await persistAndBroadcast();
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
    });
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
    });
  }

  function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const queued = mutationQueue.then(
      () => operation(),
      () => operation()
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
    await saveState(state, api);
    await api.runtime.sendMessage({ type: "stateUpdated", state }).catch(() => undefined);
  }

  async function broadcastActiveStateUpdate(updates: ActiveStateUpdate[]): Promise<void> {
    if (updates.length === 0) {
      return;
    }
    await api.runtime.sendMessage({ type: "activeStateUpdated", updates }).catch(() => undefined);
  }

  async function broadcastTreeStructureUpdate(update: TreeStructureUpdate): Promise<void> {
    await api.runtime.sendMessage(update).catch(() => undefined);
  }

  async function reconcileMissingLiveTabsInOpenWindows(): Promise<boolean> {
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
      return false;
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
    return next !== current;
  }

  async function mostRecentClosedSession(): Promise<{ tab?: { sessionId?: string }; window?: { sessionId?: string } } | undefined> {
    const sessions = await api.sessions.getRecentlyClosed({ maxResults: 1 }).catch(() => []);
    return sessions[0];
  }

  return {
    ensureState,
    handleMessage,
    refreshFromRuntime
  };
}

function commandAck(stateChanged: boolean): CommandAck {
  return {
    type: "commandAck",
    stateChanged
  };
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

function treeStructureUpdateFromStateChange(previous: OutlineState, next: OutlineState): TreeStructureUpdate {
  const deletedNodeIds = Object.keys(previous.nodes).filter((nodeId) => !next.nodes[nodeId]);
  const updatedNodes = Object.entries(next.nodes).flatMap(([nodeId, node]) => {
    return previous.nodes[nodeId] !== node ? [node] : [];
  });
  const deletedClosedCount = deletedNodeIds.filter((nodeId) => previous.nodes[nodeId]?.status === "closed").length;

  return {
    type: "treeStructureUpdated",
    deletedNodeIds,
    updatedNodes,
    rootIds: next.rootIds,
    deletedClosedCount
  };
}

function restoredLiveTabIdsChangedByCommand(previous: OutlineState, next: OutlineState): number[] {
  return Object.values(next.nodes).flatMap((node) => {
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
  if (!commandRestoredTabIds.delete(tab.id)) {
    return false;
  }

  const node = liveTabNodeByRuntimeId(state, tab.id);
  return Boolean(node?.restoredFromClosed && tabEventMatchesLiveNode(node, tab));
}

function tabEventMatchesLiveNode(
  node: OutlineNode & { live: { tabId: number; windowId: number } },
  tab: RuntimeTab
): boolean {
  return node.live.windowId === tab.windowId &&
    node.active === tab.active &&
    (tab.url === undefined || node.url === tab.url) &&
    (tab.title === undefined || node.title === tab.title) &&
    (tab.favIconUrl === undefined || node.favIconUrl === tab.favIconUrl);
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

function hasOutlineRelevantTabUpdate(changeInfo: Partial<RuntimeTab>): boolean {
  return Boolean(
    "active" in changeInfo ||
      "favIconUrl" in changeInfo ||
      "title" in changeInfo ||
      "url" in changeInfo
  );
}
