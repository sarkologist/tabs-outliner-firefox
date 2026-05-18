import type { OutlineState } from "../model/types.js";
import { normalizeHistoryState, type HistoryState } from "./history.js";

export const STATE_KEY = "outlineState";
export const HISTORY_KEY = "outlineHistory";

export async function loadState(api: WebExtensionBrowser = browser): Promise<OutlineState | undefined> {
  const stored = await api.storage.local.get(STATE_KEY);
  const candidate = stored[STATE_KEY];
  return isOutlineState(candidate) ? candidate : undefined;
}

export async function loadHistory(api: WebExtensionBrowser = browser): Promise<HistoryState> {
  const stored = await api.storage.local.get(HISTORY_KEY);
  return normalizeHistoryState(stored[HISTORY_KEY]);
}

export async function saveState(state: OutlineState, api: WebExtensionBrowser = browser): Promise<void> {
  await api.storage.local.set({ [STATE_KEY]: state });
}

export async function saveStateAndHistory(
  state: OutlineState | undefined,
  history: HistoryState | undefined,
  api: WebExtensionBrowser = browser
): Promise<void> {
  const items: Record<string, unknown> = {};
  if (state) {
    items[STATE_KEY] = state;
  }
  if (history) {
    items[HISTORY_KEY] = history;
  }
  if (Object.keys(items).length > 0) {
    await api.storage.local.set(items);
  }
}

function isOutlineState(value: unknown): value is OutlineState {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as OutlineState).version === 1 &&
      Array.isArray((value as OutlineState).rootIds) &&
      typeof (value as OutlineState).nodes === "object"
  );
}
