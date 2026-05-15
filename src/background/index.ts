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
import type { OutlineState } from "../model/types.js";

const api = browser;
const adapter = createBrowserAdapter(api);

let state: OutlineState | undefined;
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

api.runtime.onMessage.addListener(async (message) => {
  if (isDiagnosticsRequest(message)) {
    return computeDiagnostics(await ensureState(), await getNormalWindows(api));
  }

  if (!isCommand(message)) {
    return undefined;
  }

  if (message.type === "refresh") {
    await refreshFromRuntime();
    return state;
  }

  const current = await ensureState();
  const result = await runCommand(current, adapter, message);
  state = result.state;
  stateCache.replace(result.state);
  await persistAndBroadcast();
  return result.state;
});

api.tabs.onCreated.addListener(async (tab) => {
  await refreshFromRuntime([tab]);
});

api.tabs.onUpdated.addListener(async (_tabId, _changeInfo, tab) => {
  await refreshFromRuntime([tab]);
});

api.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  const current = await ensureState();
  if (!removeInfo.isWindowClosing) {
    const recent = await mostRecentClosedSession();
    state = closeTab(current, tabId, {
      now: Date.now(),
      ...(recent?.tab?.sessionId ? { sessionId: recent.tab.sessionId } : {})
    });
    stateCache.replace(state);
    await persistAndBroadcast();
  }
});

api.windows.onRemoved.addListener(async (windowId) => {
  const current = await ensureState();
  const recent = await mostRecentClosedSession();
  state = closeWindow(current, windowId, {
    now: Date.now(),
    ...(recent?.window?.sessionId ? { sessionId: recent.window.sessionId } : {})
  });
  stateCache.replace(state);
  await persistAndBroadcast();
});

api.sessions.onChanged.addListener(async () => {
  await persistAndBroadcast();
});

async function ensureState(): Promise<OutlineState> {
  return stateCache.get();
}

async function initializeState(): Promise<OutlineState> {
  const windows = await getNormalWindows();
  const stored = await loadState(api);
  state = stored
    ? reconcileWithWindows(repairState(stored), windows, { now: Date.now() })
    : bootstrapFromWindows(windows, { now: Date.now() });
  await saveState(state, api);
  return state;
}

async function refreshFromRuntime(eventTabs: Parameters<typeof getNormalWindowsIncludingTabs>[1] = []): Promise<void> {
  const current = await ensureState();
  const windows =
    eventTabs.length > 0
      ? await getNormalWindowsIncludingTabs(api, eventTabs)
      : await getNormalWindows(api);
  state = reconcileWithWindows(current, windows, { now: Date.now() }, {
    closeMissing: eventTabs.length === 0
  });
  stateCache.replace(state);
  await persistAndBroadcast();
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
    "toggleCollapsed"
  ].includes(String((message as { type: unknown }).type));
}

function isDiagnosticsRequest(message: unknown): message is { type: "getDiagnostics" } {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "getDiagnostics"
  );
}
