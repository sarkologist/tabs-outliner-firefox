import type { BrowserAdapter } from "./adapter.js";
import { createBrowserAdapter } from "./browser-adapter.js";
import { computeDiagnostics } from "./diagnostics.js";
import { runCommand } from "./commands.js";
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
import type { NodeId, OutlineNode, OutlineState, RuntimeTab } from "../model/types.js";

export type BackgroundController = {
  ensureState(): Promise<OutlineState>;
  handleMessage(message: unknown): Promise<unknown>;
  refreshFromRuntime(eventTabs?: RuntimeTab[], options?: RefreshOptions): Promise<void>;
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
  const removedTabIds = new Set<number>();
  const stateCache = createStateCache(initializeState);

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
      } else {
        state = deleteLiveTabNodeByTabId(current, tabId);
      }
      stateCache.replace(state);
      await persistAndBroadcast();
    });
  });

  api.windows.onRemoved.addListener(async (windowId) => {
    await enqueueMutation(async () => {
      const current = await ensureState();
      for (const tabId of liveTabIdsInWindow(current, windowId)) {
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
    await enqueueMutation(async () => {
      await reconcileMissingLiveTabsInOpenWindows();
      await persistAndBroadcast();
    });
  });

  async function handleMessage(message: unknown): Promise<unknown> {
    if (isDiagnosticsRequest(message)) {
      await mutationQueue;
      return computeDiagnostics(await ensureState(), await getNormalWindows(api));
    }

    if (!isCommand(message)) {
      return undefined;
    }

    if (message.type === "refresh") {
      await refreshFromRuntime();
      return state;
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
      if (typeof outlinerClosingTabId === "number") {
        outlinerClosingTabIds.add(outlinerClosingTabId);
      }

      let result: Awaited<ReturnType<typeof runCommand>>;
      try {
        result = await runCommand(current, adapter, message);
      } catch (error) {
        if (typeof outlinerClosingTabId === "number") {
          outlinerClosingTabIds.delete(outlinerClosingTabId);
        }
        throw error;
      }
      state = result.state;
      stateCache.replace(result.state);
      await persistAndBroadcast();
      return result.state;
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

  async function refreshFromRuntime(eventTabs: RuntimeTab[] = [], options: RefreshOptions = {}): Promise<void> {
    await enqueueMutation(async () => {
      await refreshFromRuntimeNow(eventTabs, options);
    });
  }

  async function refreshFromRuntimeNow(eventTabs: RuntimeTab[] = [], options: RefreshOptions = {}): Promise<void> {
    const current = await ensureState();
    const currentEventTabs = eventTabs.filter((tab) => !removedTabIds.has(tab.id));
    const windows =
      currentEventTabs.length > 0
        ? await getNormalWindowsIncludingTabs(api, currentEventTabs)
        : await getNormalWindows(api);
    state = reconcileWithWindows(current, windows, { now: now() }, {
      closeMissing: options.closeMissing ?? eventTabs.length === 0
    });
    stateCache.replace(state);
    await persistAndBroadcast();
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

  async function reconcileMissingLiveTabsInOpenWindows(): Promise<void> {
    const current = await ensureState();
    const windows = await getNormalWindows(api);
    const openWindowIds = new Set(windows.map((windowInfo) => windowInfo.id));
    const openTabIds = new Set(
      windows.flatMap((windowInfo) => windowInfo.tabs ?? []).map((tab) => tab.id)
    );
    const missingLiveTabIds = Object.values(current.nodes)
      .filter(isLiveTabInOpenWindow(openWindowIds, openTabIds))
      .map((node) => node.live.tabId);

    let next = current;
    for (const tabId of missingLiveTabIds) {
      if (outlinerClosingTabIds.delete(tabId)) {
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

function liveTabIdForNode(state: OutlineState, nodeId: NodeId): number | undefined {
  const node = state.nodes[nodeId];
  return node?.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live
    ? node.live.tabId
    : undefined;
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

function isCommand(message: unknown): message is Parameters<typeof runCommand>[2] {
  if (!message || typeof message !== "object" || !("type" in message)) {
    return false;
  }

  return [
    "getState",
    "focusNode",
    "closeNode",
    "restoreNode",
    "deleteNode",
    "moveNode",
    "moveNodeToNewWindow",
    "toggleCollapsed",
    "refresh"
  ].includes(String((message as { type: unknown }).type));
}

function isDiagnosticsRequest(message: unknown): message is { type: "getDiagnostics" } {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "getDiagnostics"
  );
}
