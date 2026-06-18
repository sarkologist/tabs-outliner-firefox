import type { RuntimeTab, RuntimeWindow } from "../model/types.js";

type RuntimeSnapshotApi = Pick<WebExtensionBrowser, "tabs" | "windows">;

export async function getNormalWindows(
  api: RuntimeSnapshotApi = browser
): Promise<RuntimeWindow[]> {
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

export async function getNormalWindowsIncludingTabs(
  api: RuntimeSnapshotApi,
  eventTabs: RuntimeTab[]
): Promise<RuntimeWindow[]> {
  const windows = await getNormalWindows(api);
  const windowsById = new Map(windows.map((windowInfo) => [windowInfo.id, windowInfo]));

  for (const tab of eventTabs) {
    if (tab.incognito) {
      continue;
    }

    const windowInfo = windowsById.get(tab.windowId);
    if (!windowInfo) {
      continue;
    }

    const queriedWindow = windowWithTabId(windows, tab.id);
    if (queriedWindow && queriedWindow.id !== tab.windowId) {
      continue;
    }

    const tabs = windowInfo.tabs ?? [];
    const existingIndex = tabs.findIndex((candidate) => candidate.id === tab.id);
    if (existingIndex >= 0) {
      tabs[existingIndex] = tab;
    } else {
      tabs.push(tab);
    }
    windowInfo.tabs = sortTabs(tabs);
  }

  return [...windowsById.values()];
}

function windowWithTabId(windows: RuntimeWindow[], tabId: number): RuntimeWindow | undefined {
  return windows.find((windowInfo) => windowInfo.tabs?.some((candidate) => candidate.id === tabId));
}

export async function getNormalWindow(
  api: RuntimeSnapshotApi,
  windowId: number
): Promise<RuntimeWindow | undefined> {
  const windowInfo = await api.windows
    .get(windowId, {
      populate: false,
      windowTypes: ["normal"]
    })
    .catch(() => undefined);
  if (!windowInfo || windowInfo.incognito) {
    return undefined;
  }

  return {
    ...windowInfo,
    tabs: []
  };
}

function sortTabs(tabs: RuntimeTab[]): RuntimeTab[] {
  return [...tabs].sort((a, b) => a.index - b.index);
}
