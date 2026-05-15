import { createBrowserAdapter } from "./browser-adapter.js";
import { runCommand } from "./commands.js";
import { loadState, saveState } from "./storage.js";
import {
  bootstrapFromWindows,
  closeTab,
  closeWindow,
  reconcileWithWindows
} from "../model/outline.js";
import type { OutlineState, RuntimeWindow } from "../model/types.js";

const api = browser;
const adapter = createBrowserAdapter(api);

let state: OutlineState | undefined;
let stateReady: Promise<OutlineState> | undefined;

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
  if (!isCommand(message)) {
    return undefined;
  }

  const current = await ensureState();
  const result = await runCommand(current, adapter, message);
  state = result.state;
  await persistAndBroadcast();
  return result.state;
});

api.tabs.onCreated.addListener(async () => {
  await refreshFromRuntime();
});

api.tabs.onUpdated.addListener(async () => {
  await refreshFromRuntime();
});

api.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  const current = await ensureState();
  if (!removeInfo.isWindowClosing) {
    const recent = await mostRecentClosedSession();
    state = closeTab(current, tabId, {
      now: Date.now(),
      ...(recent?.tab?.sessionId ? { sessionId: recent.tab.sessionId } : {})
    });
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
  await persistAndBroadcast();
});

api.sessions.onChanged.addListener(async () => {
  await persistAndBroadcast();
});

async function ensureState(): Promise<OutlineState> {
  if (!stateReady) {
    stateReady = initializeState();
  }
  return stateReady;
}

async function initializeState(): Promise<OutlineState> {
  const windows = await getNormalWindows();
  const stored = await loadState(api);
  state = stored
    ? reconcileWithWindows(stored, windows, { now: Date.now() })
    : bootstrapFromWindows(windows, { now: Date.now() });
  await saveState(state, api);
  return state;
}

async function refreshFromRuntime(): Promise<void> {
  const current = await ensureState();
  state = reconcileWithWindows(current, await getNormalWindows(), { now: Date.now() });
  await persistAndBroadcast();
}

async function getNormalWindows(): Promise<RuntimeWindow[]> {
  const windows = await api.windows.getAll({
    populate: true,
    windowTypes: ["normal"]
  });
  return windows.filter((windowInfo) => !windowInfo.incognito);
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
