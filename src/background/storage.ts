import type { OutlineState } from "../model/types.js";

export const STATE_KEY = "outlineState";

export async function loadState(api: WebExtensionBrowser = browser): Promise<OutlineState | undefined> {
  const stored = await api.storage.local.get(STATE_KEY);
  const candidate = stored[STATE_KEY];
  return isOutlineState(candidate) ? candidate : undefined;
}

export async function saveState(state: OutlineState, api: WebExtensionBrowser = browser): Promise<void> {
  await api.storage.local.set({ [STATE_KEY]: state });
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
