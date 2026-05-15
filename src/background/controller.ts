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
  reconcileWithWindows,
  repairState
} from "../model/outline.js";
import type { OutlineState, RuntimeTab } from "../model/types.js";

export type BackgroundController = {
  ensureState(): Promise<OutlineState>;
  handleMessage(message: unknown): Promise<unknown>;
  refreshFromRuntime(eventTabs?: RuntimeTab[]): Promise<void>;
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

  api.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    if (!removeInfo.isWindowClosing) {
      await enqueueMutation(async () => {
        const current = await ensureState();
        const recent = await mostRecentClosedSession();
        state = closeTab(current, tabId, {
          now: now(),
          ...(recent?.tab?.sessionId ? { sessionId: recent.tab.sessionId } : {})
        });
        stateCache.replace(state);
        await persistAndBroadcast();
      });
    }
  });

  api.windows.onRemoved.addListener(async (windowId) => {
    await enqueueMutation(async () => {
      const current = await ensureState();
      const recent = await mostRecentClosedSession();
      state = closeWindow(current, windowId, {
        now: now(),
        ...(recent?.window?.sessionId ? { sessionId: recent.window.sessionId } : {})
      });
      stateCache.replace(state);
      await persistAndBroadcast();
    });
  });

  api.sessions.onChanged.addListener(async () => {
    await mutationQueue;
    await persistAndBroadcast();
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
      const result = await runCommand(current, adapter, message);
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

  async function refreshFromRuntime(eventTabs: RuntimeTab[] = []): Promise<void> {
    await enqueueMutation(async () => {
      await refreshFromRuntimeNow(eventTabs);
    });
  }

  async function refreshFromRuntimeNow(eventTabs: RuntimeTab[] = []): Promise<void> {
    const current = await ensureState();
    const windows =
      eventTabs.length > 0
        ? await getNormalWindowsIncludingTabs(api, eventTabs)
        : await getNormalWindows(api);
    state = reconcileWithWindows(current, windows, { now: now() }, {
      closeMissing: eventTabs.length === 0
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
