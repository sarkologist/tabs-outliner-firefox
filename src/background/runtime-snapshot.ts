import type { RuntimeTab, RuntimeWindow } from "../model/types.js";

type RuntimeSnapshotApi = Pick<WebExtensionBrowser, "tabs" | "windows">;

// `excludeWindowIds` drops windows the extension owns (full-size sidebar / exported-tree viewer
// popups, tracked by id in the controller). Firefox transiently reports a freshly-created
// type:"popup" window as type:"normal", so the windowTypes:["normal"] filter alone is not enough to
// keep the extension's own window out of a reconciliation snapshot -- without this it gets
// reconciled into the outline as a phantom "Group" window, one per sidebar open.
export async function getNormalWindows(
  api: RuntimeSnapshotApi = browser,
  excludeWindowIds?: ReadonlySet<number>
): Promise<RuntimeWindow[]> {
  const windows = await api.windows.getAll({
    populate: false,
    windowTypes: ["normal"]
  });
  const windowsById = new Map<number, RuntimeWindow>();

  for (const windowInfo of windows) {
    if (!windowInfo.incognito && !excludeWindowIds?.has(windowInfo.id)) {
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
  eventTabs: RuntimeTab[],
  excludeWindowIds?: ReadonlySet<number>
): Promise<RuntimeWindow[]> {
  const windows = await getNormalWindows(api, excludeWindowIds);
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

// Window shells only: the focused/state flags and ids of the current normal windows,
// WITHOUT the global `tabs.query` that dominates getNormalWindows. Used to corroborate a
// native window focus-gain against fresh truth (which window is actually focused) before
// flipping the active flag in place, while skipping the expensive all-tabs snapshot.
export async function getNormalWindowShells(
  api: RuntimeSnapshotApi = browser,
  excludeWindowIds?: ReadonlySet<number>
): Promise<RuntimeWindow[]> {
  const windows = await api.windows.getAll({
    populate: false,
    windowTypes: ["normal"]
  });
  return windows
    .filter((windowInfo) => !windowInfo.incognito && !excludeWindowIds?.has(windowInfo.id))
    .map((windowInfo) => ({ ...windowInfo, tabs: [] }));
}

export async function getNormalWindow(
  api: RuntimeSnapshotApi,
  windowId: number,
  excludeWindowIds?: ReadonlySet<number>
): Promise<RuntimeWindow | undefined> {
  if (excludeWindowIds?.has(windowId)) {
    return undefined;
  }
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
