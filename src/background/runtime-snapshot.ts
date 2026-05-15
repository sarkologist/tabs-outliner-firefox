import type { RuntimeTab, RuntimeWindow } from "../model/types.js";

type RuntimeSnapshotApi = Pick<WebExtensionBrowser, "tabs" | "windows">;

export async function getNormalWindows(api: RuntimeSnapshotApi = browser): Promise<RuntimeWindow[]> {
  const windows = await api.windows.getAll({
    populate: false,
    windowTypes: ["normal"]
  });
  const windowsById = new Map<number, RuntimeWindow>();

  for (const windowInfo of windows) {
    if (!windowInfo.incognito) {
      windowsById.set(windowInfo.id, {
        ...windowInfo,
        tabs: []
      });
    }
  }

  const tabs = await api.tabs.query({});
  for (const tab of tabs) {
    if (tab.incognito) {
      continue;
    }

    const windowInfo = windowsById.get(tab.windowId);
    if (windowInfo) {
      windowInfo.tabs?.push(tab);
    }
  }

  return [...windowsById.values()].map((windowInfo) => ({
    ...windowInfo,
    tabs: sortTabs(windowInfo.tabs ?? [])
  }));
}

function sortTabs(tabs: RuntimeTab[]): RuntimeTab[] {
  return [...tabs].sort((a, b) => a.index - b.index);
}
