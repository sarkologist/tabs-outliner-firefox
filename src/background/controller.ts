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

export type BackgroundControllerOptions = {
  api: WebExtensionBrowser;
  adapter?: BrowserAdapter;
  now?: () => number;
};

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
  const stateCache = createStateCache(initializeState);
  let sessionChangedQueued = false;

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
    await refreshFromRuntime([tab]);
  });

  api.tabs.onUpdated.addListener(async (_tabId, _changeInfo, tab) => {
    await refreshFromRuntime([tab]);
  });

  api.tabs.onActivated.addListener(async () => {
    await refreshFromRuntime();
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
      if (outlinerClosingTabIds.delete(tabId)) {
        const recent = await mostRecentClosedSession();
        state = closeTab(current, tabId, {
          now: now(),
          ...(recent?.tab?.sessionId ? { sessionId: recent.tab.sessionId } : {})
        });
      } else if (isRestoredLiveTabId(current, tabId)) {
        const recent = await mostRecentClosedSession();
        state = closeTab(current, tabId, {
          now: now(),
          ...(recent?.tab?.sessionId ? { sessionId: recent.tab.sessionId } : {})
        });
      } else {
        state = deleteLiveTabNodeByTabId(current, tabId);
      }
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

  api.windows.onFocusChanged.addListener(async () => {
    await refreshFromRuntime([], { closeMissing: false });
  });

  api.sessions.onChanged.addListener(async () => {
    if (sessionChangedQueued) {
      return;
    }
    sessionChangedQueued = true;
    await enqueueMutation(async () => {
      try {
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
      const deleteClosePlan = message.type === "deleteNode"
        ? planLiveSubtreeClose(current, message.nodeId)
        : undefined;
      if (typeof outlinerClosingTabId === "number") {
        outlinerClosingTabIds.add(outlinerClosingTabId);
      }
      if (typeof outlinerClosingWindowId === "number") {
        outlinerClosingWindowIds.add(outlinerClosingWindowId);
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
        throw error;
      }
      const stateChanged = result.state !== current;
      if (!stateChanged) {
        return commandAck(false);
      }

      state = result.state;
      stateCache.replace(result.state);
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

  async function refreshFromRuntimeNow(eventTabs: RuntimeTab[] = [], options: RefreshOptions = {}): Promise<boolean> {
    const current = await ensureState();
    const currentEventTabs = eventTabs.filter((tab) => !removedTabIds.has(tab.id));
    const windowsSnapshot =
      currentEventTabs.length > 0
        ? await getNormalWindowsIncludingTabs(api, currentEventTabs)
        : await getNormalWindows(api);
    const windows = filterRemovedTabsFromWindows(windowsSnapshot, removedTabIds);
    state = reconcileWithWindows(current, windows, { now: now() }, {
      closeMissing: options.closeMissing ?? eventTabs.length === 0
    });
    stateCache.replace(state);
    await persistAndBroadcast();
    return state !== current;
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
