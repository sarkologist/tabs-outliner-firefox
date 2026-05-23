import { describe, expect, it, vi } from "vitest";

import type { BrowserAdapter } from "./adapter.js";
import {
  AUTOMATIC_BACKUP_ALARM_NAME,
  AUTOMATIC_BACKUP_STATUS_STORAGE_KEY
} from "./backups.js";
import { createBackgroundController } from "./controller.js";
import type { CommandAck } from "./commands.js";
import { HISTORY_KEY, STATE_KEY, loadStateV2, outlineStateV2Items, outlineStateV3Changes } from "./storage.js";
import { PORTABLE_TREE_SCHEMA } from "../model/portable-tree.js";
import type { OutlineState, RuntimeTab, RuntimeWindow } from "../model/types.js";
import { APP_PREFERENCES_STORAGE_KEY, DEFAULT_APP_PREFERENCES } from "../preferences.js";
import { generatedTraceConfig, generatedTraceTimeoutMs } from "../test/generated-traces.test-support.js";

type Listener<TArgs extends unknown[]> = (...args: TArgs) => unknown | Promise<unknown>;

class FakeEvent<TArgs extends unknown[]> {
  private listeners: Listener<TArgs>[] = [];
  private pending: Promise<unknown>[] = [];

  addListener(listener: Listener<TArgs>): void {
    this.listeners.push(listener);
  }

  removeListener(listener: Listener<TArgs>): void {
    this.listeners = this.listeners.filter((candidate) => candidate !== listener);
  }

  dispatch(...args: TArgs): void {
    for (const listener of this.listeners) {
      try {
        this.track(listener(...args));
      } catch (error) {
        this.track(Promise.reject(error));
      }
    }
  }

  // Test-only barrier: Firefox dispatches extension events without waiting for async listeners.
  async emit(...args: TArgs): Promise<void> {
    this.dispatch(...args);
    await this.flush();
  }

  async flush(): Promise<void> {
    while (this.pending.length > 0) {
      const pending = this.pending;
      this.pending = [];
      const results = await Promise.allSettled(pending);
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") {
        throw rejected.reason;
      }
    }
  }

  private track(result: unknown): void {
    if (isPromiseLike(result)) {
      this.pending.push(result);
    }
  }
}

type FakeRuntime = {
  api: WebExtensionBrowser;
  events: {
    installed: FakeEvent<[]>;
    startup: FakeEvent<[]>;
    alarm: FakeEvent<[FakeAlarm]>;
    tabCreated: FakeEvent<[RuntimeTab]>;
    tabActivated: FakeEvent<[{ tabId: number; windowId: number; previousTabId?: number }]>;
    tabUpdated: FakeEvent<[number, Partial<RuntimeTab>, RuntimeTab]>;
    tabRemoved: FakeEvent<[number, { windowId: number; isWindowClosing: boolean }]>;
    windowFocusChanged: FakeEvent<[number]>;
    windowRemoved: FakeEvent<[number]>;
    sessionChanged: FakeEvent<[]>;
    command: FakeEvent<[string]>;
    storageChanged: FakeEvent<[Record<string, { oldValue?: unknown; newValue?: unknown }>, string]>;
  };
  tabs: RuntimeTab[];
  windows: FakeRuntimeWindow[];
  nextWindowId: number;
  broadcasts: unknown[];
  downloads: FakeDownloadOptions[];
  alarms: Map<string, FakeAlarm>;
  failNextDownload(error: Error): void;
  queueTabQueryResult(tabs: RuntimeTab[]): void;
  setNextTabQueryResult(tabs: RuntimeTab[]): void;
  clearNextTabQueryResult(): void;
};

type FakeAlarm = {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
};

type FakeDownloadOptions = {
  url: string;
  filename?: string;
  saveAs?: boolean;
  conflictAction?: "uniquify" | "overwrite" | "prompt";
  body?: string;
};

type FakeWindowType = "normal" | "popup";
type FakeRuntimeWindow = RuntimeWindow & {
  type?: FakeWindowType;
};
type FakeWindowCreateData = {
  url?: string | string[];
  tabId?: number;
  type?: FakeWindowType;
  state?: "normal" | "minimized" | "maximized" | "fullscreen";
  focused?: boolean;
};

type TabCloseEventOrder =
  | "tabRemovedThenSessionChanged"
  | "sessionChangedThenTabRemoved"
  | "tabRemovedOnly"
  | "sessionChangedOnly";
type WindowCloseEventOrder =
  | "tabsRemovedThenWindowRemoved"
  | "windowRemovedThenTabsRemoved"
  | "windowRemovedOnly"
  | "tabsRemovedOnly";

type FakeRuntimeOptions = {
  browserLikeTabRemove?: TabCloseEventOrder;
  initialStorage?: Record<string, unknown>;
};

type Deferred<T = void> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function waitForMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}

function fakeRuntime(windows: RuntimeWindow[], tabs: RuntimeTab[], options: FakeRuntimeOptions = {}): FakeRuntime {
  const alarm = new FakeEvent<[FakeAlarm]>();
  const installed = new FakeEvent<[]>();
  const startup = new FakeEvent<[]>();
  const tabCreated = new FakeEvent<[RuntimeTab]>();
  const tabActivated = new FakeEvent<[{ tabId: number; windowId: number; previousTabId?: number }]>();
  const tabUpdated = new FakeEvent<[number, Partial<RuntimeTab>, RuntimeTab]>();
  const tabRemoved = new FakeEvent<[number, { windowId: number; isWindowClosing: boolean }]>();
  const windowFocusChanged = new FakeEvent<[number]>();
  const windowRemoved = new FakeEvent<[number]>();
  const sessionChanged = new FakeEvent<[]>();
  const command = new FakeEvent<[string]>();
  const storageChanged = new FakeEvent<[Record<string, { oldValue?: unknown; newValue?: unknown }>, string]>();
  const storage = new Map<string, unknown>(Object.entries(options.initialStorage ?? {}));
  const broadcasts: unknown[] = [];
  const alarms = new Map<string, FakeAlarm>();
  const downloads: FakeDownloadOptions[] = [];
  let nextDownloadError: Error | undefined;
  const queuedTabQueryResults: RuntimeTab[][] = [];
  const runtime: FakeRuntime = {
    windows: windows.map(copyWindow),
    tabs: tabs.map(copyTab),
    nextWindowId: Math.max(0, ...windows.map((windowInfo) => windowInfo.id)) + 1,
    broadcasts,
    alarms,
    downloads,
    failNextDownload(error) {
      nextDownloadError = error;
    },
    queueTabQueryResult(tabs) {
      queuedTabQueryResults.push(tabs.map(copyTab));
    },
    setNextTabQueryResult(tabs) {
      queuedTabQueryResults.length = 0;
      runtime.queueTabQueryResult(tabs);
    },
    clearNextTabQueryResult() {
      queuedTabQueryResults.length = 0;
    },
    events: {
      installed,
      startup,
      alarm,
      tabCreated,
      tabActivated,
      tabUpdated,
      tabRemoved,
      windowFocusChanged,
      windowRemoved,
      sessionChanged,
      command,
      storageChanged
    },
    api: {
      action: {
        onClicked: new FakeEvent<[]>() as never
      },
      sidebarAction: {
        open: vi.fn(async () => undefined),
        toggle: vi.fn(async () => undefined)
      },
      alarms: {
        create: vi.fn((name: string, alarmInfo: { when?: number; delayInMinutes?: number; periodInMinutes?: number } = {}) => {
          const scheduledTime = alarmInfo.when ??
            Date.now() + Math.max(0, alarmInfo.delayInMinutes ?? alarmInfo.periodInMinutes ?? 0) * 60 * 1000;
          alarms.set(name, {
            name,
            scheduledTime,
            ...(typeof alarmInfo.periodInMinutes === "number"
              ? { periodInMinutes: alarmInfo.periodInMinutes }
              : {})
          });
        }),
        clear: vi.fn(async (name: string) => alarms.delete(name)),
        get: vi.fn(async (name: string) => alarms.get(name)),
        onAlarm: alarm as never
      },
      commands: {
        onCommand: command as never,
        getAll: vi.fn(async () => []),
        update: vi.fn(async () => undefined),
        reset: vi.fn(async () => undefined)
      },
      runtime: {
        onInstalled: installed as never,
        onStartup: startup as never,
        onMessage: new FakeEvent<[unknown, { tab?: RuntimeTab }]>() as never,
        getURL: vi.fn((path: string) => `moz-extension://extension-id/${path}`),
        openOptionsPage: vi.fn(async () => undefined),
        sendMessage: vi.fn(async (message: unknown) => {
          broadcasts.push(message);
          return undefined;
        })
      },
      downloads: {
        download: vi.fn(async (options: FakeDownloadOptions) => {
          if (nextDownloadError) {
            const error = nextDownloadError;
            nextDownloadError = undefined;
            throw error;
          }
          const body = await fetch(options.url).then((response) => response.text()).catch(() => undefined);
          downloads.push({ ...options, ...(body ? { body } : {}) });
          return downloads.length;
        })
      },
      storage: {
        local: {
          get: vi.fn(async (key?: string | string[] | Record<string, unknown> | null) => {
            if (typeof key === "string") {
              return { [key]: storage.get(key) };
            }
            return Object.fromEntries(storage);
          }),
          set: vi.fn(async (items: Record<string, unknown>) => {
            const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
            for (const [key, value] of Object.entries(items)) {
              changes[key] = { oldValue: storage.get(key), newValue: value };
              storage.set(key, value);
            }
            storageChanged.dispatch(changes, "local");
          }),
          remove: vi.fn(async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              storage.delete(key);
            }
          }),
        },
        onChanged: storageChanged as never
      },
      windows: {
        WINDOW_ID_NONE: -1,
        getCurrent: vi.fn(async (getInfo: { populate?: boolean; windowTypes?: string[] } = {}) => {
          const allowedTypes = new Set(getInfo.windowTypes ?? ["normal", "popup"]);
          const matchingWindows = runtime.windows.filter((candidate) => allowedTypes.has(candidate.type ?? "normal"));
          const windowInfo = matchingWindows.find((candidate) => candidate.focused) ?? matchingWindows[0];
          if (!windowInfo) {
            throw new Error("Missing current window");
          }
          const windowCopy = copyWindowWithoutTabs(windowInfo);
          return {
            ...windowCopy,
            ...(getInfo.populate
              ? {
                  tabs: runtime.tabs
                    .filter((tab) => tab.windowId === windowInfo.id)
                    .map(copyTab)
                }
              : {})
          };
        }),
        get: vi.fn(async (windowId: number, getInfo: { populate?: boolean; windowTypes?: string[] } = {}) => {
          const windowInfo = runtime.windows.find((candidate) => candidate.id === windowId);
          if (!windowInfo) {
            throw new Error(`Missing window: ${windowId}`);
          }
          if (getInfo.windowTypes && !getInfo.windowTypes.includes(windowInfo.type ?? "normal")) {
            throw new Error(`Missing window: ${windowId}`);
          }
          const windowCopy = copyWindowWithoutTabs(windowInfo);
          return {
            ...windowCopy,
            ...(getInfo.populate
              ? {
                  tabs: runtime.tabs
                    .filter((tab) => tab.windowId === windowId)
                    .map(copyTab)
                }
              : {})
          };
        }),
        getAll: vi.fn(async (getInfo: { populate?: boolean; windowTypes?: string[] } = {}) =>
          runtimeWindowSnapshot(runtime, getInfo)
        ),
        update: vi.fn(async (windowId: number, updateInfo: { focused?: boolean } = {}) => {
          if (updateInfo.focused) {
            runtime.windows = runtime.windows.map((windowInfo) => ({
              ...windowInfo,
              focused: windowInfo.id === windowId
            }));
            runtime.events.windowFocusChanged.dispatch(windowId);
          }
          return copyWindowWithoutTabs(runtime.windows.find((windowInfo) => windowInfo.id === windowId)!);
        }),
        remove: vi.fn(async (windowId: number) => {
          await closeRuntimeWindow(runtime, windowId, { awaitListeners: false });
        }),
        create: vi.fn(async (createData: FakeWindowCreateData = {}) =>
          createWindowFromBrowser(runtime, createData)
        ),
        onFocusChanged: windowFocusChanged as never,
        onRemoved: windowRemoved as never
      },
      tabs: {
        query: vi.fn(async (queryInfo: Record<string, unknown> = {}) => {
          const source = queuedTabQueryResults.shift() ?? runtime.tabs;
          return source
            .filter((tab) => tabMatchesQuery(tab, queryInfo))
            .map(copyTab);
        }),
        update: vi.fn(async (tabId: number, updateProperties: { active?: boolean } = {}) => {
          await updateTabFromBrowser(runtime, tabId, updateProperties, { awaitListeners: false });
          return copyTab(runtime.tabs.find((tab) => tab.id === tabId)!);
        }),
        remove: vi.fn(async (tabId: number | number[]) => {
          const tabIds = Array.isArray(tabId) ? tabId : [tabId];
          for (const currentTabId of tabIds) {
            await closeRuntimeTab(runtime, currentTabId, options.browserLikeTabRemove ?? "tabRemovedThenSessionChanged", {
              awaitListeners: false
            });
          }
        }),
        create: vi.fn(async (createProperties: { url: string; windowId?: number; active?: boolean }) => {
          const windowId =
            createProperties.windowId ??
            runtime.windows.find((windowInfo) => windowInfo.focused)?.id ??
            runtime.windows[0]?.id;
          if (typeof windowId !== "number") {
            throw new Error("Cannot create a tab without a window");
          }

          const tab: RuntimeTab = {
            id: nextRuntimeTabId(runtime),
            windowId,
            index: runtime.tabs.filter((candidate) => candidate.windowId === windowId).length,
            active: createProperties.active ?? true,
            url: createProperties.url,
            title: createProperties.url
          };
          await createTabFromBrowser(runtime, tab, { awaitListeners: false });
          return copyTab(runtime.tabs.find((candidate) => candidate.id === tab.id) ?? tab);
        }),
        move: vi.fn(async (tabIds: number | number[], moveProperties: { windowId?: number; index: number }) =>
          moveTabsFromBrowser(runtime, tabIds, moveProperties)
        ),
        onActivated: tabActivated as never,
        onCreated: tabCreated as never,
        onUpdated: tabUpdated as never,
        onRemoved: tabRemoved as never
      },
      sessions: {
        getRecentlyClosed: vi.fn(async () => [{ tab: { sessionId: "recent-session" } } as never]),
        restore: vi.fn(async () => ({})),
        onChanged: sessionChanged as never
      }
    }
  };

  return runtime;
}

async function storedAutomaticBackupStatus(runtime: FakeRuntime): Promise<Record<string, unknown> | undefined> {
  const stored = await runtime.api.storage.local.get(AUTOMATIC_BACKUP_STATUS_STORAGE_KEY);
  return stored[AUTOMATIC_BACKUP_STATUS_STORAGE_KEY] as Record<string, unknown> | undefined;
}

function createTabFromBrowser(
  runtime: FakeRuntime,
  tab: RuntimeTab,
  options: { awaitListeners?: boolean; queryLag?: boolean; eventTab?: RuntimeTab } = {}
): Promise<void> | void {
  runtime.tabs = runtime.tabs.map((candidate) => candidate.windowId === tab.windowId && candidate.index >= tab.index
    ? {
        ...candidate,
        index: candidate.index + 1,
        ...(tab.active ? { active: false } : {})
      }
    : {
        ...candidate,
        ...(candidate.windowId === tab.windowId && tab.active ? { active: false } : {})
      });
  runtime.tabs = [...runtime.tabs, copyTab(tab)];
  reindexWindowTabs(runtime, tab.windowId);
  if (options.queryLag) {
    runtime.setNextTabQueryResult(snapshotMissingTab(runtime.tabs, tab.id));
  }

  const eventTab = copyTab(options.eventTab ?? tab);
  if (options.awaitListeners === false) {
    runtime.events.tabCreated.dispatch(eventTab);
    runtime.clearNextTabQueryResult();
    return;
  }
  return runtime.events.tabCreated.emit(eventTab).finally(() => {
    runtime.clearNextTabQueryResult();
  });
}

function createWindowFromBrowser(
  runtime: FakeRuntime,
  createData: FakeWindowCreateData
): RuntimeWindow {
  const windowId = nextRuntimeWindowId(runtime);
  const type = createData.type ?? "normal";
  runtime.windows = runtime.windows
    .map((windowInfo) => ({ ...windowInfo, focused: false }))
    .concat({ id: windowId, focused: createData.focused ?? true, incognito: false, type });

  if (typeof createData.tabId === "number") {
    const movedTabs = moveTabsFromBrowser(runtime, [createData.tabId], { windowId, index: 0 });
    return {
      id: windowId,
      focused: true,
      incognito: false,
      tabs: movedTabs.map(copyTab)
    };
  }

  const urls = Array.isArray(createData.url) ? createData.url : createData.url ? [createData.url] : [];
  const firstTabId = nextRuntimeTabId(runtime);
  const createdTabs = urls.map((url, index) => ({
    id: firstTabId + index,
    windowId,
    index,
    active: index === 0,
    url,
    title: url
  }));
  runtime.tabs = [...runtime.tabs, ...createdTabs];

  return {
    id: windowId,
    focused: true,
    incognito: false,
    tabs: createdTabs.map(copyTab)
  };
}

function moveTabsFromBrowser(
  runtime: FakeRuntime,
  tabIds: number | number[],
  moveProperties: { windowId?: number; index: number }
): RuntimeTab[] {
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
  const moving = ids.flatMap((tabId) => {
    const tab = runtime.tabs.find((candidate) => candidate.id === tabId);
    return tab ? [copyTab(tab)] : [];
  });
  if (moving.length === 0) {
    return [];
  }

  const targetWindowId = moveProperties.windowId ?? moving[0]!.windowId;
  const affectedWindowIds = new Set<number>([targetWindowId, ...moving.map((tab) => tab.windowId)]);
  const movingIds = new Set(moving.map((tab) => tab.id));
  const remainingTabs = runtime.tabs.filter((tab) => !movingIds.has(tab.id));
  const targetTabs = remainingTabs
    .filter((tab) => tab.windowId === targetWindowId)
    .sort((left, right) => left.index - right.index)
    .map(copyTab);
  const boundedIndex = Math.max(0, Math.min(moveProperties.index, targetTabs.length));
  const movedTabs = moving.map((tab) => ({
    ...tab,
    windowId: targetWindowId
  }));
  targetTabs.splice(boundedIndex, 0, ...movedTabs);

  runtime.tabs = [
    ...remainingTabs.filter((tab) => tab.windowId !== targetWindowId).map(copyTab),
    ...targetTabs
  ];
  for (const windowId of affectedWindowIds) {
    reindexWindowTabs(runtime, windowId);
  }
  removeEmptyRuntimeWindows(runtime, [...affectedWindowIds].filter((windowId) => windowId !== targetWindowId));

  return movedTabs.map((tab) => copyTab(runtime.tabs.find((candidate) => candidate.id === tab.id) ?? tab));
}

async function updateTabFromBrowser(
  runtime: FakeRuntime,
  tabId: number,
  changes: Partial<RuntimeTab>,
  options: { awaitListeners?: boolean; queryResult?: RuntimeTab[] } = {}
): Promise<void> {
  const tab = runtime.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) {
    return;
  }

  if (changes.active) {
    runtime.tabs = runtime.tabs.map((candidate) => candidate.windowId === tab.windowId
      ? { ...candidate, active: candidate.id === tabId }
      : copyTab(candidate));
  }

  runtime.tabs = runtime.tabs.map((candidate) => candidate.id === tabId
    ? { ...candidate, ...changes }
    : candidate);
  if (options.queryResult) {
    runtime.setNextTabQueryResult(options.queryResult);
  }

  const updatedTab = runtime.tabs.find((candidate) => candidate.id === tabId);
  if (updatedTab) {
    const eventTab = copyTab(updatedTab);
    if (options.awaitListeners === false) {
      runtime.events.tabUpdated.dispatch(tabId, changes, eventTab);
    } else {
      await runtime.events.tabUpdated.emit(tabId, changes, eventTab);
    }
    runtime.clearNextTabQueryResult();
  }
}

async function activateTabFromBrowser(runtime: FakeRuntime, tabId: number): Promise<void> {
  const tab = runtime.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) {
    return;
  }
  const previousTab = runtime.tabs.find((candidate) => candidate.windowId === tab.windowId && candidate.active);
  runtime.tabs = runtime.tabs.map((candidate) => candidate.windowId === tab.windowId
    ? { ...candidate, active: candidate.id === tabId }
    : copyTab(candidate));
  await runtime.events.tabActivated.emit({
    tabId,
    windowId: tab.windowId,
    ...(previousTab ? { previousTabId: previousTab.id } : {})
  });
  runtime.clearNextTabQueryResult();
}

async function focusWindowFromBrowser(runtime: FakeRuntime, windowId: number): Promise<void> {
  runtime.windows = runtime.windows.map((windowInfo) => ({
    ...windowInfo,
    focused: windowInfo.id === windowId
  }));
  await runtime.events.windowFocusChanged.emit(windowId);
}

async function closeTabFromBrowser(
  runtime: FakeRuntime,
  tabId: number,
  order: TabCloseEventOrder = "tabRemovedThenSessionChanged"
): Promise<void> {
  await closeRuntimeTab(runtime, tabId, order, { awaitListeners: true });
}

async function closeRuntimeTab(
  runtime: FakeRuntime,
  tabId: number,
  order: TabCloseEventOrder,
  options: { awaitListeners: boolean }
): Promise<void> {
  const tab = runtime.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) {
    return;
  }

  const windowWillBecomeEmpty = runtime.tabs.filter((candidate) => candidate.windowId === tab.windowId).length === 1;
  const emitsWindowRemoved = windowWillBecomeEmpty &&
    (order === "tabRemovedThenSessionChanged" || order === "sessionChangedThenTabRemoved");
  let removedFromRuntime = false;
  const removeFromRuntime = (): void => {
    if (removedFromRuntime) {
      return;
    }
    removedFromRuntime = true;
    runtime.tabs = runtime.tabs.filter((candidate) => candidate.id !== tabId);
    reindexWindowTabs(runtime, tab.windowId);
    if (windowWillBecomeEmpty) {
      removeEmptyRuntimeWindows(runtime, [tab.windowId]);
    }
  };

  const emit = async (): Promise<void> => {
    const tabRemoved = (): Promise<void> | void => {
      removeFromRuntime();
      return fireEvent(runtime.events.tabRemoved, options.awaitListeners, tabId, {
        windowId: tab.windowId,
        isWindowClosing: emitsWindowRemoved
      });
    };
    const windowRemoved = (): Promise<void> | void => emitsWindowRemoved
      ? fireEvent(runtime.events.windowRemoved, options.awaitListeners, tab.windowId)
      : undefined;
    const sessionChanged = (): Promise<void> | void => {
      if (order === "sessionChangedOnly") {
        removeFromRuntime();
      }
      return fireEvent(runtime.events.sessionChanged, options.awaitListeners);
    };

    if (order === "tabRemovedThenSessionChanged") {
      await tabRemoved();
      await windowRemoved();
      await sessionChanged();
    } else if (order === "sessionChangedThenTabRemoved") {
      await sessionChanged();
      await tabRemoved();
      await windowRemoved();
    } else if (order === "tabRemovedOnly") {
      await tabRemoved();
    } else {
      await sessionChanged();
    }
  };

  if (options.awaitListeners) {
    await emit();
  } else {
    void emit();
  }
}

function removeEmptyRuntimeWindows(runtime: FakeRuntime, windowIds: number[]): number[] {
  const emptyWindowIds = new Set(
    windowIds.filter((windowId) => runtime.tabs.every((tab) => tab.windowId !== windowId))
  );
  if (emptyWindowIds.size === 0) {
    return [];
  }

  runtime.windows = runtime.windows.filter((windowInfo) => !emptyWindowIds.has(windowInfo.id));
  return [...emptyWindowIds];
}

async function closeRuntimeWindow(
  runtime: FakeRuntime,
  windowId: number,
  options: { awaitListeners: boolean },
  order: WindowCloseEventOrder = "tabsRemovedThenWindowRemoved"
): Promise<void> {
  if (!runtime.windows.some((windowInfo) => windowInfo.id === windowId)) {
    return;
  }

  const removedTabs = runtime.tabs
    .filter((tab) => tab.windowId === windowId)
    .sort((left, right) => left.index - right.index)
    .map(copyTab);
  runtime.tabs = runtime.tabs.filter((tab) => tab.windowId !== windowId);
  runtime.windows = runtime.windows.filter((windowInfo) => windowInfo.id !== windowId);

  const emit = async (): Promise<void> => {
    const tabsRemoved = async (): Promise<void> => {
      for (const tab of removedTabs) {
        await fireEvent(runtime.events.tabRemoved, options.awaitListeners, tab.id, {
          windowId,
          isWindowClosing: true
        });
      }
    };
    const windowRemoved = async (): Promise<void> => {
      await fireEvent(runtime.events.windowRemoved, options.awaitListeners, windowId);
    };

    if (order === "tabsRemovedThenWindowRemoved") {
      await tabsRemoved();
      await windowRemoved();
    } else if (order === "windowRemovedThenTabsRemoved") {
      await windowRemoved();
      await tabsRemoved();
    } else if (order === "windowRemovedOnly") {
      await windowRemoved();
    } else {
      await tabsRemoved();
    }
  };

  if (options.awaitListeners) {
    await emit();
  } else {
    void emit();
  }
}

function fireEvent<TArgs extends unknown[]>(
  event: FakeEvent<TArgs>,
  awaitListeners: boolean,
  ...args: TArgs
): Promise<void> | void {
  if (awaitListeners) {
    return event.emit(...args);
  }

  event.dispatch(...args);
}

function reindexWindowTabs(runtime: FakeRuntime, windowId: number): void {
  runtime.tabs = runtime.tabs
    .map((tab) => ({ ...tab }))
    .sort((left, right) => left.index - right.index)
    .map((tab) => tab.windowId === windowId
      ? {
          ...tab,
          index: runtime.tabs
            .filter((candidate) => candidate.windowId === windowId && candidate.index < tab.index)
            .length
        }
      : tab);
}

function nextRuntimeWindowId(runtime: FakeRuntime): number {
  const windowId = runtime.nextWindowId;
  runtime.nextWindowId += 1;
  return windowId;
}

function nextRuntimeTabId(runtime: FakeRuntime): number {
  return Math.max(0, ...runtime.tabs.map((tab) => tab.id)) + 1;
}

function tabMatchesQuery(tab: RuntimeTab, queryInfo: Record<string, unknown>): boolean {
  return (typeof queryInfo.windowId !== "number" || tab.windowId === queryInfo.windowId) &&
    (typeof queryInfo.active !== "boolean" || tab.active === queryInfo.active);
}

function copyTab(tab: RuntimeTab): RuntimeTab {
  return { ...tab };
}

function copyWindow(windowInfo: RuntimeWindow): RuntimeWindow {
  return {
    ...windowInfo,
    ...(windowInfo.tabs ? { tabs: windowInfo.tabs.map(copyTab) } : {})
  };
}

function copyWindowWithoutTabs(windowInfo: RuntimeWindow): RuntimeWindow {
  const { tabs: _tabs, type: _type, ...rest } = windowInfo as FakeRuntimeWindow;
  return { ...rest };
}

function runtimeWindowSnapshot(
  runtime: FakeRuntime,
  getInfo: { populate?: boolean; windowTypes?: string[] } = {}
): RuntimeWindow[] {
  const allowedTypes = new Set(getInfo.windowTypes ?? ["normal", "popup"]);
  return runtime.windows
    .filter((windowInfo) => allowedTypes.has(windowInfo.type ?? "normal"))
    .map((windowInfo) => {
      const windowCopy = copyWindowWithoutTabs(windowInfo);
      return {
        ...windowCopy,
        ...(getInfo.populate
          ? {
              tabs: runtime.tabs
                .filter((tab) => tab.windowId === windowInfo.id)
                .map(copyTab)
            }
          : {})
      };
    });
}

function wideClosedTabState(tabCount: number): OutlineState {
  const rootId = "window:10";
  const childIds = Array.from({ length: tabCount }, (_value, index) => `tab:${index + 1}`);
  return {
    version: 1,
    rootIds: [rootId],
    nodes: {
      [rootId]: {
        id: rootId,
        kind: "window",
        status: "live",
        title: "Window",
        active: true,
        collapsed: false,
        childIds,
        createdAt: 1000,
        updatedAt: 1000,
        live: { windowId: 10 }
      },
      ...Object.fromEntries(childIds.map((id, index) => [
        id,
        {
          id,
          kind: "tab",
          status: "closed",
          parentId: rootId,
          childIds: [],
          title: `Saved ${index + 1}`,
          url: `https://restore.example/${index + 1}`,
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          closedAt: 2000 + index,
          restore: {
            url: `https://restore.example/${index + 1}`,
            title: `Saved ${index + 1}`
          }
        }
      ]))
    }
  };
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && "then" in value;
}

function liveTabIds(state: OutlineState): number[] {
  return Object.values(state.nodes)
    .filter((node) => node.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live)
    .map((node) => node.live!.tabId!)
    .sort((a, b) => a - b);
}

function expectCommandAck(result: unknown, stateChanged: boolean): asserts result is CommandAck {
  expect(result).toEqual({
    type: "commandAck",
    stateChanged
  });
}

function stateBroadcasts(messages: unknown[]): unknown[] {
  return messages.filter((message) => (message as { type?: unknown }).type !== "historyStatus");
}

function traceEntryNames(snapshot: unknown): string[] {
  return Array.isArray((snapshot as { entries?: unknown }).entries)
    ? (snapshot as { entries: Array<{ name?: unknown }> }).entries.flatMap((entry) =>
        typeof entry.name === "string" ? [entry.name] : []
      )
    : [];
}

async function countNodeTableObjectValues<T>(
  callback: () => Promise<T>,
  countedNodeTable?: OutlineState["nodes"]
): Promise<{ calls: number; value: T }> {
  const originalValues = Object.values;
  let calls = 0;
  const spy = vi.spyOn(Object, "values").mockImplementation(((value: object) => {
    if (value === countedNodeTable || (!countedNodeTable && isNodeTableLike(value))) {
      calls += 1;
    }
    return originalValues(value as never);
  }) as typeof Object.values);
  try {
    const value = await callback();
    return {
      calls,
      value
    };
  } finally {
    spy.mockRestore();
  }
}

async function countNodeTableObjectKeys<T>(
  callback: () => Promise<T>,
  countedNodeTable?: OutlineState["nodes"]
): Promise<{ calls: number; value: T }> {
  const originalKeys = Object.keys;
  let calls = 0;
  const spy = vi.spyOn(Object, "keys").mockImplementation(((value: object) => {
    if (value === countedNodeTable || (!countedNodeTable && isNodeTableLike(value))) {
      calls += 1;
    }
    return originalKeys(value as never);
  }) as typeof Object.keys);
  try {
    const value = await callback();
    return {
      calls,
      value
    };
  } finally {
    spy.mockRestore();
  }
}

async function countNodeTableObjectEntries<T>(
  callback: () => Promise<T>,
  countedNodeTable?: OutlineState["nodes"]
): Promise<{ calls: number; value: T }> {
  const originalEntries = Object.entries;
  let calls = 0;
  const spy = vi.spyOn(Object, "entries").mockImplementation(((value: object) => {
    if (value === countedNodeTable || (!countedNodeTable && isNodeTableLike(value))) {
      calls += 1;
    }
    return originalEntries(value as never);
  }) as typeof Object.entries);
  try {
    const value = await callback();
    return {
      calls,
      value
    };
  } finally {
    spy.mockRestore();
  }
}

async function countNodePropertyReads<T>(
  state: OutlineState,
  countedNodeIds: readonly string[],
  callback: () => Promise<T>
): Promise<{ reads: number; value: T }> {
  const countedIds = new Set(countedNodeIds);
  const nodes = state.nodes;
  const originalDescriptors = Object.getOwnPropertyDescriptors(nodes);
  const values = new Map(Object.entries(nodes));
  let reads = 0;

  try {
    for (const nodeId of Object.keys(nodes)) {
      Object.defineProperty(nodes, nodeId, {
        enumerable: true,
        configurable: true,
        get() {
          if (countedIds.has(nodeId)) {
            reads += 1;
          }
          return values.get(nodeId);
        },
        set(value) {
          values.set(nodeId, value);
        }
      });
    }

    const value = await callback();
    return { reads, value };
  } finally {
    const addedDescriptors = Object.fromEntries(
      Object.entries(Object.getOwnPropertyDescriptors(nodes))
        .filter(([key]) => !originalDescriptors[key])
    );
    for (const key of Object.keys(nodes)) {
      delete nodes[key];
    }
    for (const [key, descriptor] of Object.entries(originalDescriptors)) {
      Object.defineProperty(nodes, key, {
        ...descriptor,
        value: values.get(key)
      });
    }
    for (const [key, value] of values) {
      if (!originalDescriptors[key]) {
        nodes[key] = value;
      }
    }
    Object.defineProperties(nodes, addedDescriptors);
  }
}

function isNodeTableLike(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const tabOne = (value as Record<string, unknown>)["tab:1"];
  return Boolean(
    tabOne &&
      typeof tabOne === "object" &&
      (tabOne as { id?: unknown }).id === "tab:1" &&
      Array.isArray((tabOne as { childIds?: unknown }).childIds)
  );
}

function liveWindowIds(state: OutlineState): number[] {
  return Object.values(state.nodes)
    .filter((node) => node.kind === "window" && node.status === "live" && node.live && "windowId" in node.live)
    .map((node) => node.live!.windowId)
    .sort((a, b) => a - b);
}

function reachableNodeIds(state: OutlineState): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  function visit(nodeId: string): void {
    if (seen.has(nodeId)) {
      return;
    }
    seen.add(nodeId);
    const node = state.nodes[nodeId];
    if (!node) {
      return;
    }
    ids.push(nodeId);
    for (const childId of node.childIds) {
      visit(childId);
    }
  }

  for (const rootId of state.rootIds) {
    visit(rootId);
  }

  return ids.sort();
}

type GeneratedTraceContext = {
  runtime: FakeRuntime;
  controller: ReturnType<typeof createBackgroundController>;
  nextTabId: number;
  allocatedRuntimeTabIds: Set<number>;
  history: string[];
  nativeDeletedNodeIds: Set<string>;
  commandDeletedNodeIds: Set<string>;
  expectedClosedNodeIds: Set<string>;
  staleTabs: RuntimeTab[];
  staleLiveEventTabs: RuntimeTab[];
  domainCaptures: DomainTraceCaptures;
  lastOpenedTabId?: number;
  lastMovedTabId?: number;
  lastOpenedWindowId?: number;
  adversarialRuntimeQueries: boolean;
  adversarialConcurrency: boolean;
  rng: () => number;
};

type GeneratedTraceOptions = {
  adversarialRuntimeQueries?: boolean;
  adversarialConcurrency?: boolean;
};

type GeneratedOperation = {
  name: string;
  run(context: GeneratedTraceContext): Promise<void>;
};

type RuntimeDomainTracePurpose = "regression" | "discovery";
type RuntimeDomainTraceOrigin = "known-finding" | "threat-model" | "agent-generated";

type RuntimeDomainTrace = {
  id: string;
  title: string;
  notes: string;
  purpose: RuntimeDomainTracePurpose;
  origin: RuntimeDomainTraceOrigin;
  tags: string[];
  coveredFindingIds?: string[];
  actions: DomainAction[];
};

type RuntimeDomainTraceDefinition = Omit<RuntimeDomainTrace, "purpose" | "origin" | "tags"> & {
  purpose?: RuntimeDomainTracePurpose;
  origin?: RuntimeDomainTraceOrigin;
  tags?: string[];
};

type DomainTraceCaptures = {
  tabs: Map<string, RuntimeTab>;
  windows: Map<string, FakeRuntimeWindow>;
  staleTabs: Map<string, RuntimeTab[]>;
};

type DomainTabSelector =
  | { tabId: number }
  | { capture: string }
  | { role: "activeTab" | "firstRuntimeTab" | "lastOpenedTab" | "lastMovedTab" }
  | { inWindow: DomainWindowSelector; index?: number };

type DomainWindowSelector =
  | { windowId: number }
  | { capture: string }
  | { role: "focusedWindow" | "firstRuntimeWindow" | "lastOpenedWindow" };

type DomainStaleTabSelector =
  | {
      capture: string;
      tabId?: number;
      index?: number;
    }
  | {
      role: "tabInOldWindow";
      index?: number;
    };

type DomainNodeSelector =
  | { nodeId: string }
  | { tab: DomainTabSelector }
  | { window: DomainWindowSelector };

type DomainRuntimeEventAction =
  | {
      type: "openTab";
      window: DomainWindowSelector;
      active?: boolean;
      title?: string;
      url?: string;
      openerTab?: DomainTabSelector;
      captureTab?: string;
    }
  | {
      type: "activateTab";
      tab: DomainTabSelector;
      staleQueryFrom?: DomainStaleTabSelector;
    }
  | {
      type: "updateTab";
      tab: DomainTabSelector;
      title?: string;
    }
  | {
      type: "focusWindow";
      window: DomainWindowSelector;
    };

type DomainAction =
  | DomainRuntimeEventAction
  | {
      type: "raceWithOutlinerGroup";
      event: DomainRuntimeEventAction;
      groupTab: DomainTabSelector;
      captureStaleTabs?: string;
    }
  | {
      type: "outlinerGroupTab";
      tab: DomainTabSelector;
      captureStaleTabs?: string;
    }
  | {
      type: "outlinerMoveTabToNewWindow";
      tab: DomainTabSelector;
      captureStaleTabs?: string;
    }
  | {
      type: "outlinerMoveTabCommandToNewWindow";
      tab: DomainTabSelector;
      captureStaleTabs?: string;
    }
  | {
      type: "outlinerMoveTabCommandToNewWindowRejectingCreate";
      tab: DomainTabSelector;
      captureStaleTabs?: string;
    }
  | {
      type: "outlinerMoveSubtreeToTopLevel";
      tab: DomainTabSelector;
      captureStaleTabs?: string;
    }
  | {
      type: "outlinerFocusTab";
      tab: DomainTabSelector;
    }
  | {
      type: "outlinerCloseTab";
      tab: DomainTabSelector;
    }
  | {
      type: "outlinerCloseWindow";
      window: DomainWindowSelector;
    }
  | {
      type: "outlinerDeleteWindowRejectingClose";
      window: DomainWindowSelector;
    }
  | {
      type: "outlinerDeleteTabRejectingClose";
      tab: DomainTabSelector;
    }
  | {
      type: "outlinerDeleteNodeRejectingClose";
      node: DomainNodeSelector;
    }
  | {
      type: "outlinerRestoreDeleteWindowDelayedEvent";
      window: DomainWindowSelector;
      captureStaleTabs?: string;
    }
  | {
      type: "manualRefresh";
    }
  | {
      type: "manualRefreshWithStaleQuery";
      staleTab: DomainStaleTabSelector;
    }
  | {
      type: "manualRefreshWithMissingTabQuery";
      tab: DomainTabSelector;
    }
  | {
      type: "manualRefreshWithMissingWindowQuery";
      window: DomainWindowSelector;
    }
  | {
      type: "manualRefreshWithReorderedQuery";
      window: DomainWindowSelector;
      order?: "reverse" | "rotateLeft" | "rotateRight";
    }
  | {
      type: "sessionChanged";
    }
  | {
      type: "outlinerUndo";
    }
  | {
      type: "outlinerRedo";
    }
  | {
      type: "nativeCloseTab";
      tab: DomainTabSelector;
      order?: TabCloseEventOrder;
    }
  | {
      type: "nativeCloseWindow";
      window: DomainWindowSelector;
      order?: WindowCloseEventOrder;
    }
  | {
      type: "staleLiveUpdatedEvent";
      staleTab: DomainStaleTabSelector;
      withStaleQuery?: boolean;
    }
  | {
      type: "staleLiveCreatedEvent";
      staleTab: DomainStaleTabSelector;
      withStaleQuery?: boolean;
    }
  | {
      type: "flushRuntimeEvents";
    };

const RUNTIME_DOMAIN_TRACE_DEFINITIONS: RuntimeDomainTraceDefinition[] = [
  {
    id: "rt-active-race",
    title: "activation event races a live-tab grouping command",
    notes: "Translated from RT-001/SS-001.",
    actions: [
      {
        type: "raceWithOutlinerGroup",
        event: { type: "activateTab", tab: { tabId: 2 } },
        groupTab: { tabId: 1 },
        captureStaleTabs: "grouped-tab-1"
      }
    ]
  },
  {
    id: "rt-created-race-after-window-close",
    title: "created-tab event races grouping after source-window closure",
    notes: "Translated from RT-002/SS-002 at the domain level.",
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 10 } },
      { type: "openTab", window: { windowId: 20 }, captureTab: "tab-100" },
      {
        type: "raceWithOutlinerGroup",
        event: { type: "focusWindow", window: { windowId: 20 } },
        groupTab: { capture: "tab-100" },
        captureStaleTabs: "tab-100-before-focus-race"
      },
      { type: "outlinerDeleteWindowRejectingClose", window: { role: "lastOpenedWindow" } },
      { type: "openTab", window: { windowId: 20 }, captureTab: "tab-101" },
      {
        type: "raceWithOutlinerGroup",
        event: { type: "openTab", window: { windowId: 20 }, captureTab: "tab-102" },
        groupTab: { capture: "tab-101" },
        captureStaleTabs: "tab-101-before-created-race"
      }
    ]
  },
  {
    id: "rt-stale-created-after-move",
    title: "stale created event follows move-to-new-window",
    notes: "Targets stale live created echoes after command relocation.",
    actions: [
      { type: "outlinerMoveTabToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "moved-tab-1" },
      { type: "staleLiveCreatedEvent", staleTab: { role: "tabInOldWindow" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-stale-created-after-fresh-relocation-event",
    title: "stale created event follows a fresh relocated-tab event",
    notes: "Fresh current-window events must not disable old-window stale echo protection.",
    actions: [
      { type: "outlinerMoveTabToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "moved-tab-1" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "fresh relocated tab update" },
      { type: "staleLiveCreatedEvent", staleTab: { role: "tabInOldWindow" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-stale-updated-after-move",
    title: "stale updated event follows move-to-new-window",
    notes: "Targets stale live update echoes after command relocation.",
    actions: [
      { type: "outlinerMoveTabToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "moved-tab-1" },
      { type: "staleLiveUpdatedEvent", staleTab: { role: "tabInOldWindow" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-stale-updated-after-fresh-relocation-event",
    title: "stale updated event follows a fresh relocated-tab event",
    notes: "Translated from stale old-window update findings that occur after protection was cleared too early.",
    actions: [
      { type: "outlinerMoveTabToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "moved-tab-1" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "fresh relocated tab update" },
      { type: "staleLiveUpdatedEvent", staleTab: { role: "tabInOldWindow" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-stale-activation-after-fresh-relocation-event",
    title: "stale activation snapshot follows a fresh relocated-tab event",
    notes: "Translated from RT-003/RT-005/RT-008 stale activation snapshot findings.",
    actions: [
      { type: "outlinerMoveTabToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "moved-tab-1" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "fresh relocated tab update" },
      { type: "activateTab", tab: { role: "lastMovedTab" }, staleQueryFrom: { role: "tabInOldWindow" } }
    ]
  },
  {
    id: "rt-native-close-after-relocation",
    title: "native close interleaves with relocated tab stale echoes",
    notes: "Covers native close after command-owned relocation.",
    actions: [
      { type: "outlinerMoveTabToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "moved-tab-1" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "sessionChangedThenTabRemoved" },
      { type: "staleLiveUpdatedEvent", staleTab: { role: "tabInOldWindow" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-restore-delete-delayed-stale-event",
    title: "restore-delete delayed event followed by stale runtime echo",
    notes: "Covers delayed restored-tab events after restore/delete workflows.",
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 } },
      { type: "openTab", window: { role: "firstRuntimeWindow" }, captureTab: "post-restore-tab" },
      {
        type: "raceWithOutlinerGroup",
        event: { type: "updateTab", tab: { capture: "post-restore-tab" }, title: "post restore stale update" },
        groupTab: { capture: "post-restore-tab" },
        captureStaleTabs: "post-restore-tab-before-group"
      },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "post-restore-tab-before-group" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-direct-new-window-stale-created-after-fresh-event",
    title: "stale created event follows direct move-to-new-window command",
    notes: "Mutated corpus trace for the explicit moveNodeToNewWindow command path.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "direct-moved-tab-1" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "fresh direct relocated tab update" },
      { type: "staleLiveCreatedEvent", staleTab: { role: "tabInOldWindow" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-top-level-stale-updated-after-fresh-event",
    title: "stale updated event follows move-subtree-to-top-level command",
    notes: "Mutated corpus trace for the moveSubtreeToTopLevel command relocation path.",
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "top-level-moved-tab-1" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "fresh top-level relocated tab update" },
      { type: "staleLiveUpdatedEvent", staleTab: { role: "tabInOldWindow" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-repeated-direct-relocation-stale-events",
    title: "stale events from multiple old windows follow repeated direct relocation",
    notes: "Mutated corpus trace for long-lived command relocation echo protection across updated destinations.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "first-direct-old-window" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { role: "lastMovedTab" }, captureStaleTabs: "second-direct-old-window" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "fresh repeated direct relocation update" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "first-direct-old-window" }, withStaleQuery: true },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "second-direct-old-window" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-repeated-direct-relocation-with-filler-stale-events",
    title: "stale events from multiple old windows follow repeated direct relocation with intermediate filler tab",
    notes: "Mutated corpus trace that keeps the first command-created window non-empty to probe stale echoes past the second relocation.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "first-direct-old-window-with-filler" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, captureTab: "intermediate-filler-tab" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { role: "lastMovedTab" }, captureStaleTabs: "second-direct-old-window-with-filler" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "fresh repeated direct filler relocation update" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "first-direct-old-window-with-filler" }, withStaleQuery: true },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "second-direct-old-window-with-filler", tabId: 1 }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-repeated-direct-relocation-native-close-stale-event",
    title: "native close follows repeated direct relocation before stale old-window events",
    notes: "Mutated corpus trace for close/delete protection composed with repeated command relocation.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "first-direct-old-window-before-close" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, captureTab: "intermediate-close-filler-tab" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { role: "lastMovedTab" }, captureStaleTabs: "second-direct-old-window-before-close" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "sessionChangedThenTabRemoved" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "first-direct-old-window-before-close" }, withStaleQuery: true },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "second-direct-old-window-before-close", tabId: 1 }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-repeated-top-level-relocation-with-filler-stale-events",
    title: "stale events from multiple old windows follow repeated top-level relocation with intermediate filler tab",
    notes: "Mutated corpus trace for repeated moveSubtreeToTopLevel relocation and stale old-window echoes.",
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "first-top-level-old-window-with-filler" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, captureTab: "top-level-intermediate-filler-tab" },
      { type: "outlinerMoveSubtreeToTopLevel", tab: { role: "lastMovedTab" }, captureStaleTabs: "second-top-level-old-window-with-filler" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "fresh repeated top-level filler relocation update" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "first-top-level-old-window-with-filler" }, withStaleQuery: true },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "second-top-level-old-window-with-filler", tabId: 1 }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-direct-new-window-native-close-old-window-stale-created",
    title: "stale created event follows direct relocation after native old-window close",
    notes: "Timed mutation round 1: close the source runtime window after direct command relocation, then deliver a stale old-window created echo.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "direct-old-window-before-native-close" },
      { type: "nativeCloseWindow", window: { windowId: 10 } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "direct-old-window-before-native-close" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-direct-new-window-outliner-close-old-window-stale-updated",
    title: "stale updated event follows direct relocation after outliner old-window close",
    notes: "Timed mutation round 1: outliner-owned close of the source window after direct command relocation.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "direct-old-window-before-outliner-close" },
      { type: "outlinerCloseWindow", window: { windowId: 10 } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "direct-old-window-before-outliner-close" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-top-level-native-close-old-window-stale-created",
    title: "stale created event follows top-level relocation after native old-window close",
    notes: "Timed mutation round 1: close the source runtime window after moveSubtreeToTopLevel relocation.",
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "top-level-old-window-before-native-close" },
      { type: "nativeCloseWindow", window: { windowId: 10 } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "top-level-old-window-before-native-close" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-group-native-close-old-window-stale-updated",
    title: "stale updated event follows grouping relocation after native old-window close",
    notes: "Timed mutation round 1: close the source runtime window after grouping relocation.",
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "group-old-window-before-native-close" },
      { type: "nativeCloseWindow", window: { windowId: 10 } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "group-old-window-before-native-close" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-direct-new-window-delete-old-window-rejecting-close-stale-created",
    title: "stale created event follows direct relocation after delete-owned old-window close",
    notes: "Timed mutation round 2: delete command closes the source window after direct relocation and reports a late rejection.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "direct-old-window-before-delete-close" },
      { type: "outlinerDeleteWindowRejectingClose", window: { windowId: 10 } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "direct-old-window-before-delete-close" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-top-level-delete-old-window-rejecting-close-stale-updated",
    title: "stale updated event follows top-level relocation after delete-owned old-window close",
    notes: "Timed mutation round 2: delete-owned old-window close after moveSubtreeToTopLevel relocation.",
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "top-level-old-window-before-delete-close" },
      { type: "outlinerDeleteWindowRejectingClose", window: { windowId: 10 } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "top-level-old-window-before-delete-close" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-group-delete-old-window-rejecting-close-stale-created",
    title: "stale created event follows grouping relocation after delete-owned old-window close",
    notes: "Timed mutation round 2: delete-owned old-window close after grouping relocation.",
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "group-old-window-before-delete-close" },
      { type: "outlinerDeleteWindowRejectingClose", window: { windowId: 10 } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "group-old-window-before-delete-close" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-top-level-outliner-close-old-window-stale-created",
    title: "stale created event follows top-level relocation after outliner old-window close",
    notes: "Timed mutation round 2: outliner-owned source-window close after moveSubtreeToTopLevel relocation.",
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "top-level-old-window-before-outliner-close" },
      { type: "outlinerCloseWindow", window: { windowId: 10 } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "top-level-old-window-before-outliner-close" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-group-outliner-close-old-window-stale-updated",
    title: "stale updated event follows grouping relocation after outliner old-window close",
    notes: "Timed mutation round 2: outliner-owned source-window close after grouping relocation.",
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "group-old-window-before-outliner-close" },
      { type: "outlinerCloseWindow", window: { windowId: 10 } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "group-old-window-before-outliner-close" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-direct-new-window-native-close-destination-stale-updated",
    title: "stale updated event follows native destination-window close after direct relocation",
    notes: "Timed mutation round 3: close the command-created destination window after direct relocation.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "direct-old-window-before-destination-native-close" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "direct-old-window-before-destination-native-close" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-direct-new-window-outliner-close-destination-stale-created",
    title: "stale created event follows outliner destination-window close after direct relocation",
    notes: "Timed mutation round 3: outliner-owned close of the command-created destination window.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "direct-old-window-before-destination-outliner-close" },
      { type: "outlinerCloseWindow", window: { role: "lastOpenedWindow" } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "direct-old-window-before-destination-outliner-close" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-top-level-native-close-destination-stale-updated",
    title: "stale updated event follows native destination-window close after top-level relocation",
    notes: "Timed mutation round 3: native close of the command-created destination window after moveSubtreeToTopLevel.",
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "top-level-old-window-before-destination-native-close" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "top-level-old-window-before-destination-native-close" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-group-outliner-close-destination-stale-created",
    title: "stale created event follows outliner destination-window close after grouping relocation",
    notes: "Timed mutation round 3: outliner-owned close of the command-created destination window after grouping.",
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "group-old-window-before-destination-outliner-close" },
      { type: "outlinerCloseWindow", window: { role: "lastOpenedWindow" } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "group-old-window-before-destination-outliner-close" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-direct-new-window-native-close-tab-removed-only-stale-created",
    title: "stale created event follows direct relocation after tab-removed-only native close",
    notes: "Timed mutation round 4: close the moved tab after direct relocation with only a tabRemoved event.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "direct-old-window-before-tab-removed-only" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "tabRemovedOnly" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "direct-old-window-before-tab-removed-only" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-direct-new-window-native-close-session-only-stale-updated",
    title: "stale updated event follows direct relocation after session-only native close",
    notes: "Timed mutation round 4: close the moved tab after direct relocation with only a sessionChanged event.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "direct-old-window-before-session-only" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "sessionChangedOnly" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "direct-old-window-before-session-only" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-top-level-native-close-tab-removed-only-stale-created",
    title: "stale created event follows top-level relocation after tab-removed-only native close",
    notes: "Timed mutation round 4: tabRemoved-only close after moveSubtreeToTopLevel relocation.",
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "top-level-old-window-before-tab-removed-only" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "tabRemovedOnly" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "top-level-old-window-before-tab-removed-only" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-group-native-close-session-only-stale-updated",
    title: "stale updated event follows grouping relocation after session-only native close",
    notes: "Timed mutation round 4: sessionChanged-only close after grouping relocation.",
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "group-old-window-before-session-only" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "sessionChangedOnly" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "group-old-window-before-session-only" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-top-level-native-close-session-only-stale-updated",
    title: "stale updated event follows top-level relocation after session-only native close",
    notes: "Timed mutation round 5: sessionChanged-only close after moveSubtreeToTopLevel relocation.",
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "top-level-old-window-before-session-only" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "sessionChangedOnly" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "top-level-old-window-before-session-only" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-group-native-close-tab-removed-only-stale-created",
    title: "stale created event follows grouping relocation after tab-removed-only native close",
    notes: "Timed mutation round 5: tabRemoved-only close after grouping relocation.",
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "group-old-window-before-tab-removed-only" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "tabRemovedOnly" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "group-old-window-before-tab-removed-only" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-direct-new-window-native-close-default-order-stale-created",
    title: "stale created event follows direct relocation after default native close order",
    notes: "Timed mutation round 5: tabRemovedThenSessionChanged close after explicit moveNodeToNewWindow relocation.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "direct-old-window-before-default-close" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "tabRemovedThenSessionChanged" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "direct-old-window-before-default-close" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-direct-new-window-stale-activation-after-focus",
    title: "stale activation snapshot follows direct relocation and destination focus",
    notes: "Timed mutation round 6: activation snapshot stale query through explicit moveNodeToNewWindow.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "direct-old-window-before-stale-activation" },
      { type: "focusWindow", window: { role: "lastOpenedWindow" } },
      { type: "activateTab", tab: { role: "lastMovedTab" }, staleQueryFrom: { capture: "direct-old-window-before-stale-activation" } }
    ]
  },
  {
    id: "rt-top-level-stale-activation-after-focus",
    title: "stale activation snapshot follows top-level relocation and destination focus",
    notes: "Timed mutation round 6: activation snapshot stale query through moveSubtreeToTopLevel.",
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "top-level-old-window-before-stale-activation" },
      { type: "focusWindow", window: { role: "lastOpenedWindow" } },
      { type: "activateTab", tab: { role: "lastMovedTab" }, staleQueryFrom: { capture: "top-level-old-window-before-stale-activation" } }
    ]
  },
  {
    id: "rt-group-stale-activation-after-focus",
    title: "stale activation snapshot follows grouping relocation and destination focus",
    notes: "Timed mutation round 6: activation snapshot stale query through wrapNodeInGroup.",
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "group-old-window-before-stale-activation" },
      { type: "focusWindow", window: { role: "lastOpenedWindow" } },
      { type: "activateTab", tab: { role: "lastMovedTab" }, staleQueryFrom: { capture: "group-old-window-before-stale-activation" } }
    ]
  },
  {
    id: "rt-direct-new-window-old-window-activation-with-stale-relocated-tab",
    title: "old-window activation carries stale relocated tab after direct relocation",
    notes: "Timed mutation round 6: refocus the source window and activate its remaining tab with a stale relocated-tab query copy.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "direct-old-window-before-old-window-activation" },
      { type: "focusWindow", window: { windowId: 10 } },
      { type: "activateTab", tab: { tabId: 2 }, staleQueryFrom: { capture: "direct-old-window-before-old-window-activation" } }
    ]
  },
  {
    id: "rt-top-level-old-window-activation-with-stale-relocated-tab",
    title: "old-window activation carries stale relocated tab after top-level relocation",
    notes: "Timed mutation round 6: source-window activation with stale relocated-tab query copy after moveSubtreeToTopLevel.",
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "top-level-old-window-before-old-window-activation" },
      { type: "focusWindow", window: { windowId: 10 } },
      { type: "activateTab", tab: { tabId: 2 }, staleQueryFrom: { capture: "top-level-old-window-before-old-window-activation" } }
    ]
  },
  {
    id: "rt-group-old-window-activation-with-stale-relocated-tab",
    title: "old-window activation carries stale relocated tab after grouping relocation",
    notes: "Timed mutation round 6: source-window activation with stale relocated-tab query copy after grouping.",
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "group-old-window-before-old-window-activation" },
      { type: "focusWindow", window: { windowId: 10 } },
      { type: "activateTab", tab: { tabId: 2 }, staleQueryFrom: { capture: "group-old-window-before-old-window-activation" } }
    ]
  },
  {
    id: "rt-direct-new-window-command-focus-stale-updated",
    title: "stale updated event follows command focus after direct relocation",
    notes: "Timed mutation round 7: focusNode command after explicit moveNodeToNewWindow relocation.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "direct-old-window-before-command-focus" },
      { type: "outlinerFocusTab", tab: { role: "lastMovedTab" } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "direct-old-window-before-command-focus" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-top-level-command-focus-stale-created",
    title: "stale created event follows command focus after top-level relocation",
    notes: "Timed mutation round 7: focusNode command after moveSubtreeToTopLevel relocation.",
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "top-level-old-window-before-command-focus" },
      { type: "outlinerFocusTab", tab: { role: "lastMovedTab" } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "top-level-old-window-before-command-focus" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-group-command-focus-stale-updated",
    title: "stale updated event follows command focus after grouping relocation",
    notes: "Timed mutation round 7: focusNode command after grouping relocation.",
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "group-old-window-before-command-focus" },
      { type: "outlinerFocusTab", tab: { role: "lastMovedTab" } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "group-old-window-before-command-focus" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-direct-new-window-delete-tab-rejecting-close-stale-created",
    title: "stale created event follows direct relocation after delete-owned tab close rejection",
    notes: "Timed mutation round 7: delete the relocated tab after browser close completes but reports rejection.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "direct-old-window-before-delete-tab" },
      { type: "outlinerDeleteTabRejectingClose", tab: { role: "lastMovedTab" } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "direct-old-window-before-delete-tab" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-top-level-delete-tab-rejecting-close-stale-updated",
    title: "stale updated event follows top-level relocation after delete-owned tab close rejection",
    notes: "Timed mutation round 7: delete relocated top-level tab after browser close completes but reports rejection.",
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "top-level-old-window-before-delete-tab" },
      { type: "outlinerDeleteTabRejectingClose", tab: { role: "lastMovedTab" } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "top-level-old-window-before-delete-tab" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-group-delete-tab-rejecting-close-stale-created",
    title: "stale created event follows grouping relocation after delete-owned tab close rejection",
    notes: "Timed mutation round 7: delete relocated grouped tab after browser close completes but reports rejection.",
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "group-old-window-before-delete-tab" },
      { type: "outlinerDeleteTabRejectingClose", tab: { role: "lastMovedTab" } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "group-old-window-before-delete-tab" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-direct-new-window-outliner-close-tab-stale-updated",
    title: "stale updated event follows outliner tab close after direct relocation",
    notes: "Timed mutation round 8: closeNode workflow for relocated tab after explicit moveNodeToNewWindow.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "direct-old-window-before-outliner-close-tab" },
      { type: "outlinerCloseTab", tab: { role: "lastMovedTab" } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "direct-old-window-before-outliner-close-tab" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-top-level-outliner-close-tab-stale-created",
    title: "stale created event follows outliner tab close after top-level relocation",
    notes: "Timed mutation round 8: closeNode workflow for relocated tab after moveSubtreeToTopLevel.",
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "top-level-old-window-before-outliner-close-tab" },
      { type: "outlinerCloseTab", tab: { role: "lastMovedTab" } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "top-level-old-window-before-outliner-close-tab" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-group-outliner-close-tab-stale-updated",
    title: "stale updated event follows outliner tab close after grouping relocation",
    notes: "Timed mutation round 8: closeNode workflow for relocated tab after grouping.",
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "group-old-window-before-outliner-close-tab" },
      { type: "outlinerCloseTab", tab: { role: "lastMovedTab" } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "group-old-window-before-outliner-close-tab" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-direct-new-window-close-source-tab-stale-created",
    title: "stale created event follows source-tab close after direct relocation",
    notes: "Timed mutation round 8: close the remaining source-window tab after direct relocation.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "direct-old-window-before-source-tab-close" },
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "direct-old-window-before-source-tab-close" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-top-level-close-source-tab-stale-updated",
    title: "stale updated event follows source-tab close after top-level relocation",
    notes: "Timed mutation round 8: close the remaining source-window tab after moveSubtreeToTopLevel relocation.",
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "top-level-old-window-before-source-tab-close" },
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "top-level-old-window-before-source-tab-close" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-group-close-source-tab-stale-created",
    title: "stale created event follows source-tab close after grouping relocation",
    notes: "Timed mutation round 8: close the remaining source-window tab after grouping relocation.",
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "group-old-window-before-source-tab-close" },
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "group-old-window-before-source-tab-close" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-direct-new-window-stale-updated-fast-path-after-fresh-event",
    title: "stale updated fast-path event follows direct relocation after fresh current-window event",
    notes: "Timed mutation round 9: stale old-window event without stale query after explicit moveNodeToNewWindow.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "direct-old-window-before-fast-path-stale-update" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "fresh direct fast path update" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "direct-old-window-before-fast-path-stale-update" } }
    ]
  },
  {
    id: "rt-top-level-stale-created-fast-path-after-fresh-event",
    title: "stale created fast-path event follows top-level relocation after fresh current-window event",
    notes: "Timed mutation round 9: stale old-window created event without stale query after moveSubtreeToTopLevel.",
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "top-level-old-window-before-fast-path-stale-create" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "fresh top-level fast path update" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "top-level-old-window-before-fast-path-stale-create" } }
    ]
  },
  {
    id: "rt-group-stale-updated-fast-path-after-fresh-event",
    title: "stale updated fast-path event follows grouping relocation after fresh current-window event",
    notes: "Timed mutation round 9: stale old-window event without stale query after grouping.",
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "group-old-window-before-fast-path-stale-update" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "fresh group fast path update" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "group-old-window-before-fast-path-stale-update" } }
    ]
  },
  {
    id: "rt-direct-new-window-paired-stale-events-after-fresh-event",
    title: "paired stale old-window events follow direct relocation after fresh current-window event",
    notes: "Timed mutation round 9: stale updated then stale created after explicit moveNodeToNewWindow.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "direct-old-window-before-paired-stale-events" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "fresh direct paired stale update" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "direct-old-window-before-paired-stale-events" } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "direct-old-window-before-paired-stale-events" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-top-level-paired-stale-events-after-fresh-event",
    title: "paired stale old-window events follow top-level relocation after fresh current-window event",
    notes: "Timed mutation round 9: stale updated then stale created after moveSubtreeToTopLevel.",
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "top-level-old-window-before-paired-stale-events" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "fresh top-level paired stale update" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "top-level-old-window-before-paired-stale-events" } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "top-level-old-window-before-paired-stale-events" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-group-paired-stale-events-after-fresh-event",
    title: "paired stale old-window events follow grouping relocation after fresh current-window event",
    notes: "Timed mutation round 9: stale updated then stale created after grouping.",
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "group-old-window-before-paired-stale-events" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "fresh group paired stale update" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "group-old-window-before-paired-stale-events" } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "group-old-window-before-paired-stale-events" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-direct-new-window-open-active-source-tab-stale-updated",
    title: "stale updated event follows active source-tab open after direct relocation",
    notes: "Timed mutation round 10: open a new active tab in the old source window after direct relocation.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "direct-old-window-before-active-source-open" },
      { type: "openTab", window: { windowId: 10 }, active: true, captureTab: "direct-active-source-tab" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "direct-old-window-before-active-source-open" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-top-level-open-active-source-tab-stale-created",
    title: "stale created event follows active source-tab open after top-level relocation",
    notes: "Timed mutation round 10: open a new active tab in the old source window after moveSubtreeToTopLevel.",
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "top-level-old-window-before-active-source-open" },
      { type: "openTab", window: { windowId: 10 }, active: true, captureTab: "top-level-active-source-tab" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "top-level-old-window-before-active-source-open" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-group-open-active-source-tab-stale-updated",
    title: "stale updated event follows active source-tab open after grouping relocation",
    notes: "Timed mutation round 10: open a new active tab in the old source window after grouping.",
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "group-old-window-before-active-source-open" },
      { type: "openTab", window: { windowId: 10 }, active: true, captureTab: "group-active-source-tab" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "group-old-window-before-active-source-open" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-direct-new-window-open-active-destination-tab-stale-created",
    title: "stale created event follows active destination-tab open after direct relocation",
    notes: "Timed mutation round 10: open a new active tab in the command-created destination window after direct relocation.",
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "direct-old-window-before-active-destination-open" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: true, captureTab: "direct-active-destination-tab" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "direct-old-window-before-active-destination-open" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-top-level-open-active-destination-tab-stale-updated",
    title: "stale updated event follows active destination-tab open after top-level relocation",
    notes: "Timed mutation round 10: open a new active tab in the command-created destination window after moveSubtreeToTopLevel.",
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "top-level-old-window-before-active-destination-open" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: true, captureTab: "top-level-active-destination-tab" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "top-level-old-window-before-active-destination-open" }, withStaleQuery: true }
    ]
  },
  {
    id: "rt-group-open-active-destination-tab-stale-created",
    title: "stale created event follows active destination-tab open after grouping relocation",
    notes: "Timed mutation round 10: open a new active tab in the command-created destination window after grouping.",
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "group-old-window-before-active-destination-open" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: true, captureTab: "group-active-destination-tab" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "group-old-window-before-active-destination-open" }, withStaleQuery: true }
    ]
  }
];

const RUNTIME_DOMAIN_DISCOVERY_TRACES: RuntimeDomainTrace[] = [
  {
    id: "dh-restore-delayed-focus-refresh",
    title: "restore plus delayed runtime events across focus and refresh",
    notes: "Threat-model seed for restore/delete recovery followed by delayed runtime events and a manual refresh.",
    purpose: "discovery",
    origin: "threat-model",
    tags: ["restore", "delayed-event", "focus", "manual-refresh"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 } },
      { type: "manualRefresh" },
      { type: "focusWindow", window: { role: "firstRuntimeWindow" } }
    ]
  },
  {
    id: "dh-opener-reparent-refresh",
    title: "opener relationship survives relocation and refresh skew",
    notes: "Threat-model seed for opener-linked tabs when a related tab is moved to a command-created window.",
    purpose: "discovery",
    origin: "threat-model",
    tags: ["opener", "reparenting", "relocation", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "opener-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "opener-child" }, captureStaleTabs: "opener-child-old-window" },
      { type: "manualRefresh" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "opener-child-old-window" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-nested-parent-native-close",
    title: "nested live window under a closing runtime parent",
    notes: "Threat-model seed for grouped live resources when a parent runtime window closes natively.",
    purpose: "discovery",
    origin: "threat-model",
    tags: ["nested-window", "native-close", "relocation", "stale-event"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "nested-parent-before-close" },
      { type: "nativeCloseWindow", window: { windowId: 10 } },
      { type: "manualRefresh" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "nested-parent-before-close" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-partial-subtree-delete-reject",
    title: "partial subtree close rejects after runtime resources disappear",
    notes: "Threat-model seed for a delete command whose adapter call rejects after close-side effects already happened.",
    purpose: "discovery",
    origin: "threat-model",
    tags: ["delete-rejection", "partial-close", "stale-event", "tombstone"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "partial-delete-before-close" },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { windowId: 10 } } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "partial-delete-before-close" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-focus-session-activation-refresh",
    title: "focus activation and session refresh interleave",
    notes: "Threat-model seed for focus, activation, session refresh, and manual refresh ordering.",
    purpose: "discovery",
    origin: "threat-model",
    tags: ["focus", "activation", "session", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "focus-session-tab" },
      { type: "focusWindow", window: { windowId: 20 } },
      { type: "sessionChanged" },
      { type: "activateTab", tab: { capture: "focus-session-tab" } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-undo-redo-stale-refresh",
    title: "undo redo around stale runtime events and refresh",
    notes: "Threat-model seed for history commands followed by stale event and refresh reconciliation.",
    purpose: "discovery",
    origin: "threat-model",
    tags: ["undo-redo", "stale-event", "relocation", "manual-refresh"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "undo-redo-before-stale" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "undo-redo-before-stale" }, withStaleQuery: true },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-opener-source-close-stale-child",
    title: "opener subtree relocation followed by source window close",
    notes: "Agent-generated discovery variant for opener-linked subtrees moved away before their old window closes.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "reparenting", "relocation", "native-close", "stale-event"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "opener-source-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "opener-source-before-close" },
      { type: "nativeCloseWindow", window: { windowId: 10 } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "opener-source-before-close", index: 1 }, withStaleQuery: true },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-opener-session-only-close",
    title: "opener-linked relocation with session-only tab removal",
    notes: "Agent-generated discovery variant for session refresh when an opener-linked relocated tab disappears without a tabRemoved event.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "relocation", "session", "stale-event", "tombstone"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "session-opener-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "session-opener-child" }, captureStaleTabs: "session-opener-old-window" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "sessionChangedOnly" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "session-opener-old-window" }, withStaleQuery: true },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-refresh-delete-reject-relocated-tab",
    title: "manual refresh before rejecting close of relocated tab",
    notes: "Agent-generated discovery variant for a refreshed model whose relocated tab close later rejects after runtime removal.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["manual-refresh", "delete-rejection", "relocation", "tombstone", "stale-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "refresh-delete-before-reject" },
      { type: "manualRefresh" },
      { type: "outlinerDeleteNodeRejectingClose", node: { tab: { role: "lastMovedTab" } } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "refresh-delete-before-reject" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-history-redo-stale-created",
    title: "history redo followed by stale created echo",
    notes: "Agent-generated discovery variant for history replay with a stale created event instead of an update event.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["undo-redo", "stale-event", "relocation", "manual-refresh"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "history-created-before-stale" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "history-created-before-stale" }, withStaleQuery: true },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-history-redo-session-refresh",
    title: "history redo followed by session and refresh",
    notes: "Agent-generated discovery variant for history replay followed by a session refresh before stale echo delivery.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["undo-redo", "session", "relocation", "stale-event", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "history-session-before-stale" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "sessionChanged" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "history-session-before-stale" }, withStaleQuery: true },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restore-history-redo-delayed-echo",
    title: "restored subtree history replay with delayed echo",
    notes: "Agent-generated discovery variant for restore/delete behavior crossing undo/redo and a delayed stale echo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restore", "undo-redo", "delayed-event", "stale-event", "manual-refresh"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-repeated-relocation-refresh-stale-pair",
    title: "repeated relocation across refresh with paired stale echoes",
    notes: "Agent-generated discovery variant for stale echo protection after a later relocation updates the destination.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["relocation", "manual-refresh", "stale-event", "paired-echo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "repeat-first-old-window" },
      { type: "manualRefresh" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { role: "lastMovedTab" }, captureStaleTabs: "repeat-second-old-window" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "repeat-first-old-window" }, withStaleQuery: true },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "repeat-second-old-window" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-fresh-event-source-close-stale-echo",
    title: "fresh relocated event before source close and stale echo",
    notes: "Agent-generated discovery variant for a fresh current-window update followed by source window closure and stale old-window echo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["relocation", "native-close", "fresh-event", "stale-event", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "fresh-source-before-close" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Fresh relocated title" },
      { type: "nativeCloseWindow", window: { windowId: 10 } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "fresh-source-before-close" }, withStaleQuery: true },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-focus-churn-refresh-stale-echo",
    title: "focus churn and refresh before stale relocated echo",
    notes: "Agent-generated discovery variant for focus and activation churn in the old window before stale relocated tab evidence arrives.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["focus", "activation", "relocation", "manual-refresh", "stale-event"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "focus-churn-extra" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "focus-churn-extra" }, captureStaleTabs: "focus-churn-old-window" },
      { type: "focusWindow", window: { windowId: 10 } },
      { type: "activateTab", tab: { tabId: 2 } },
      { type: "manualRefresh" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "focus-churn-old-window" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-refresh-delete-reject-window-after-relocation",
    title: "delete rejecting relocated window after refresh",
    notes: "Agent-generated discovery variant for destination-window deletion after relocation and refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["delete-rejection", "relocation", "manual-refresh", "tombstone", "stale-event"],
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "delete-window-after-refresh-old" },
      { type: "manualRefresh" },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { role: "lastOpenedWindow" } } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "delete-window-after-refresh-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-created-race-refresh-delete-reject",
    title: "created event races grouping before refresh and delete rejection",
    notes: "Agent-generated discovery variant for a pending created event that races relocation before a refreshed delete-reject path.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["created-event", "race", "relocation", "manual-refresh", "delete-rejection"],
    actions: [
      {
        type: "raceWithOutlinerGroup",
        event: { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "race-created-child" },
        groupTab: { tabId: 1 },
        captureStaleTabs: "race-created-before-delete"
      },
      { type: "manualRefresh" },
      { type: "outlinerDeleteNodeRejectingClose", node: { tab: { role: "lastMovedTab" } } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "race-created-before-delete" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-activation-race-source-close-refresh",
    title: "activation races grouping before source close and refresh",
    notes: "Agent-generated discovery variant for activation snapshots racing relocation before the old window closes.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["activation", "race", "relocation", "native-close", "manual-refresh"],
    actions: [
      {
        type: "raceWithOutlinerGroup",
        event: { type: "activateTab", tab: { tabId: 2 } },
        groupTab: { tabId: 1 },
        captureStaleTabs: "activation-race-before-close"
      },
      { type: "nativeCloseWindow", window: { windowId: 10 } },
      { type: "manualRefresh" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "activation-race-before-close" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-update-race-focus-session-refresh",
    title: "update races grouping before focus and session refresh",
    notes: "Agent-generated discovery variant for metadata updates racing relocation before focus and session refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["updated-event", "race", "relocation", "focus", "session", "manual-refresh"],
    actions: [
      {
        type: "raceWithOutlinerGroup",
        event: { type: "updateTab", tab: { tabId: 2 }, title: "Race updated sibling" },
        groupTab: { tabId: 1 },
        captureStaleTabs: "update-race-before-session"
      },
      { type: "focusWindow", window: { role: "lastOpenedWindow" } },
      { type: "sessionChanged" },
      { type: "manualRefresh" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "update-race-before-session" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-restore-delete-stale-created-refresh",
    title: "restore delete followed by stale created echo and refresh",
    notes: "Agent-generated discovery variant for restored tabs that emit stale created evidence after their restored window is deleted.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restore", "delayed-event", "stale-event", "manual-refresh", "tombstone"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 }, captureStaleTabs: "restore-delete-stale-created" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "restore-delete-stale-created" }, withStaleQuery: true },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restore-delete-stale-updated-session",
    title: "restore delete followed by session and stale update echo",
    notes: "Agent-generated discovery variant for restored tabs that emit stale updated evidence after session reconciliation.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restore", "delayed-event", "session", "stale-event", "tombstone"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 }, captureStaleTabs: "restore-delete-stale-updated" },
      { type: "sessionChanged" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "restore-delete-stale-updated" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-nested-opener-delete-reject",
    title: "nested opener subtree delete rejection",
    notes: "Agent-generated discovery variant for opener nesting plus delete rejection without history replay.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "nested-window", "delete-rejection", "stale-event", "tombstone"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "nested-delete-child" },
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "nested-opener-delete-before" },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { windowId: 10 } } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "nested-opener-delete-before", index: 1 }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-nested-opener-native-close-refresh",
    title: "nested opener subtree native close and refresh",
    notes: "Agent-generated discovery variant for opener nesting when the source window closes natively before stale child evidence arrives.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "nested-window", "native-close", "manual-refresh", "stale-event"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "nested-close-child" },
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "nested-opener-close-before" },
      { type: "nativeCloseWindow", window: { windowId: 10 } },
      { type: "manualRefresh" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "nested-opener-close-before", index: 1 }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-command-focus-relocated-refresh-stale",
    title: "command focus relocated tab before refresh and stale echo",
    notes: "Agent-generated discovery variant for focus commands after relocation and before stale old-window evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["focus", "relocation", "manual-refresh", "stale-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "focus-command-before-stale" },
      { type: "outlinerFocusTab", tab: { role: "lastMovedTab" } },
      { type: "manualRefresh" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "focus-command-before-stale" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-outliner-close-destination-refresh-stale",
    title: "outliner closes relocated destination after refresh",
    notes: "Agent-generated discovery variant for model-owned destination-window close after a refresh boundary.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["outliner-close", "relocation", "manual-refresh", "stale-event", "tombstone"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "close-destination-before-stale" },
      { type: "manualRefresh" },
      { type: "outlinerCloseWindow", window: { role: "lastOpenedWindow" } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "close-destination-before-stale" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-outliner-close-tab-refresh-stale",
    title: "outliner closes relocated tab after refresh",
    notes: "Agent-generated discovery variant for model-owned relocated tab close after refresh followed by stale old-window evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["outliner-close", "relocation", "manual-refresh", "stale-event", "tombstone"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "close-tab-before-stale" },
      { type: "manualRefresh" },
      { type: "outlinerCloseTab", tab: { role: "lastMovedTab" } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "close-tab-before-stale" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-source-sibling-close-refresh-stale",
    title: "source sibling close after relocation and refresh",
    notes: "Agent-generated discovery variant for closing an old-window sibling before stale relocated-tab evidence arrives.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["outliner-close", "relocation", "manual-refresh", "stale-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "source-sibling-before-stale" },
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "manualRefresh" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "source-sibling-before-stale" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-manual-stale-query-after-relocation",
    title: "manual stale query after command relocation",
    notes: "Agent-generated discovery variant for manual refresh seeing an old-window copy of a relocated tab.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["manual-refresh", "stale-query", "relocation", "stale-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "manual-stale-query-old" },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "manual-stale-query-old" } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "manual-stale-query-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-manual-stale-query-after-source-close",
    title: "manual stale query after source window close",
    notes: "Agent-generated discovery variant for manual refresh seeing an old-window copy after the old window disappears.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["manual-refresh", "stale-query", "native-close", "relocation", "tombstone"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "manual-stale-source-close-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 } },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "manual-stale-source-close-old" } },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "dh-history-manual-stale-query",
    title: "history redo followed by manual stale query",
    notes: "Agent-generated discovery variant for history replay followed by a stale manual refresh snapshot.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["undo-redo", "manual-refresh", "stale-query", "relocation"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "history-manual-stale-old" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "history-manual-stale-old" } }
    ]
  },
  {
    id: "dh-delete-reject-manual-stale-query",
    title: "delete rejecting relocated tab before manual stale query",
    notes: "Agent-generated discovery variant for delete-owned tombstones followed by a stale manual refresh snapshot.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["delete-rejection", "manual-refresh", "stale-query", "relocation", "tombstone"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "delete-reject-manual-old" },
      { type: "outlinerDeleteNodeRejectingClose", node: { tab: { role: "lastMovedTab" } } },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "delete-reject-manual-old" } }
    ]
  },
  {
    id: "dh-outliner-close-manual-stale-query",
    title: "outliner close relocated tab before manual stale query",
    notes: "Agent-generated discovery variant for outliner-owned close followed by a stale manual refresh snapshot.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["outliner-close", "manual-refresh", "stale-query", "relocation", "tombstone"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "outliner-close-manual-old" },
      { type: "outlinerCloseTab", tab: { role: "lastMovedTab" } },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "outliner-close-manual-old" } }
    ]
  },
  {
    id: "dh-repeated-relocation-manual-stale-query",
    title: "repeated relocation before manual stale query",
    notes: "Agent-generated discovery variant for stale manual refresh snapshots after a later command relocation changes the destination.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["manual-refresh", "stale-query", "relocation", "paired-echo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "repeated-manual-first-old" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { role: "lastMovedTab" }, captureStaleTabs: "repeated-manual-second-old" },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "repeated-manual-first-old" } },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "repeated-manual-second-old" } }
    ]
  },
  {
    id: "dh-restore-delete-manual-stale-query",
    title: "restore delete followed by manual stale query",
    notes: "Agent-generated discovery variant for restored/deleted tabs appearing in a stale manual refresh snapshot.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restore", "delayed-event", "manual-refresh", "stale-query", "tombstone"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 }, captureStaleTabs: "restore-manual-stale" },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "restore-manual-stale" } }
    ]
  },
  {
    id: "dh-session-only-close-manual-stale-query",
    title: "session-only moved tab close before manual stale query",
    notes: "Agent-generated discovery variant for session-only runtime removal followed by stale manual refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["session", "manual-refresh", "stale-query", "relocation", "tombstone"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "session-only-manual-old" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "sessionChangedOnly" },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "session-only-manual-old" } }
    ]
  },
  {
    id: "dh-destination-close-manual-stale-query",
    title: "destination window closes before manual stale query",
    notes: "Agent-generated discovery variant for destination-window removal followed by an old-window stale manual refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-close", "manual-refresh", "stale-query", "relocation", "tombstone"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "destination-close-manual-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" } },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "destination-close-manual-old" } }
    ]
  },
  {
    id: "dh-focus-override-manual-stale-query",
    title: "focus override before manual stale query",
    notes: "Agent-generated discovery variant for command focus/activation state followed by stale manual refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["focus", "activation", "manual-refresh", "stale-query", "relocation"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "focus-override-manual-old" },
      { type: "outlinerFocusTab", tab: { role: "lastMovedTab" } },
      { type: "activateTab", tab: { tabId: 3 } },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "focus-override-manual-old" } }
    ]
  },
  {
    id: "dh-opener-source-close-manual-stale-query",
    title: "opener source closes before manual stale query",
    notes: "Agent-generated discovery variant for opener-linked tabs and source-window removal followed by stale manual refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "native-close", "manual-refresh", "stale-query", "relocation"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "opener-manual-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "opener-manual-child" }, captureStaleTabs: "opener-source-close-manual-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 } },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "opener-source-close-manual-old" } }
    ]
  },
  {
    id: "dh-group-source-close-manual-stale-query",
    title: "grouped source closes before manual stale query",
    notes: "Agent-generated discovery variant for grouped relocation, source-window removal, and stale manual refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["nested-window", "native-close", "manual-refresh", "stale-query", "relocation"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "group-source-close-manual-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 } },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "group-source-close-manual-old" } }
    ]
  },
  {
    id: "dh-top-level-source-close-manual-stale-query",
    title: "top-level promotion source closes before manual stale query",
    notes: "Agent-generated discovery variant for top-level relocation, source-window removal, and stale manual refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-close", "manual-refresh", "stale-query", "relocation"],
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "top-level-source-close-manual-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 } },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "top-level-source-close-manual-old" } }
    ]
  },
  {
    id: "dh-created-race-source-close-manual-stale-query",
    title: "created race source closes before manual stale query",
    notes: "Agent-generated discovery variant for a created-tab race, source-window removal, and stale manual refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["created-event", "race", "native-close", "manual-refresh", "stale-query", "relocation"],
    actions: [
      {
        type: "raceWithOutlinerGroup",
        event: { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "created-race-manual-tab" },
        groupTab: { tabId: 1 },
        captureStaleTabs: "created-race-source-close-manual-old"
      },
      { type: "nativeCloseWindow", window: { windowId: 10 } },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "created-race-source-close-manual-old" } }
    ]
  },
  {
    id: "dh-activation-race-source-close-manual-stale-query",
    title: "activation race source closes before manual stale query",
    notes: "Agent-generated discovery variant for activation racing relocation before source-window removal and stale manual refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["activation", "race", "native-close", "manual-refresh", "stale-query", "relocation"],
    actions: [
      {
        type: "raceWithOutlinerGroup",
        event: { type: "activateTab", tab: { tabId: 2 } },
        groupTab: { tabId: 1 },
        captureStaleTabs: "activation-race-source-close-manual-old"
      },
      { type: "nativeCloseWindow", window: { windowId: 10 } },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "activation-race-source-close-manual-old" } }
    ]
  },
  {
    id: "dh-outliner-source-close-manual-stale-query",
    title: "outliner source close before manual stale query",
    notes: "Agent-generated discovery variant for model-owned source-window close followed by stale manual refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["outliner-close", "manual-refresh", "stale-query", "relocation", "tombstone"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "outliner-source-close-manual-old" },
      { type: "outlinerCloseWindow", window: { windowId: 10 } },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "outliner-source-close-manual-old" } }
    ]
  },
  {
    id: "dh-delete-reject-source-window-manual-stale-query",
    title: "delete-reject source window before manual stale query",
    notes: "Agent-generated discovery variant for delete-owned source-window removal followed by stale manual refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["delete-rejection", "manual-refresh", "stale-query", "relocation", "tombstone"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "delete-source-window-manual-old" },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { windowId: 10 } } },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "delete-source-window-manual-old" } }
    ]
  },
  {
    id: "dh-outliner-source-tab-close-manual-stale-query",
    title: "outliner source sibling close before manual stale query",
    notes: "Agent-generated discovery variant for source sibling close before stale manual refresh evidence for a relocated tab.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["outliner-close", "manual-refresh", "stale-query", "relocation"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "outliner-source-tab-close-manual-old" },
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "outliner-source-tab-close-manual-old" } }
    ]
  },
  {
    id: "dh-relocated-tab-missing-manual-query",
    title: "relocated tab missing from manual query",
    notes: "Agent-generated discovery variant for a partial manual refresh snapshot that omits a relocated live tab.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["manual-refresh", "partial-snapshot", "relocation"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "missing-query-relocated-old" },
      { type: "manualRefreshWithMissingTabQuery", tab: { role: "lastMovedTab" } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "missing-query-relocated-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-fresh-relocated-tab-missing-manual-query",
    title: "fresh relocated tab missing from manual query",
    notes: "Agent-generated discovery variant for a partial manual refresh snapshot after a fresh current-window update.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["manual-refresh", "partial-snapshot", "relocation", "fresh-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "fresh-missing-query-old" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Fresh before missing query" },
      { type: "manualRefreshWithMissingTabQuery", tab: { role: "lastMovedTab" } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "fresh-missing-query-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-opener-child-missing-manual-query",
    title: "opener child missing from manual query after relocation",
    notes: "Agent-generated discovery variant for a partial manual refresh snapshot that omits an opener-linked relocated tab.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["manual-refresh", "partial-snapshot", "opener", "relocation"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "missing-query-opener-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "missing-query-opener-child" }, captureStaleTabs: "opener-missing-query-old" },
      { type: "manualRefreshWithMissingTabQuery", tab: { role: "lastMovedTab" } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "opener-missing-query-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-current-session-refresh-after-relocation",
    title: "current session refresh after relocation",
    notes: "Agent-generated discovery variant for clean session/manual refresh after relocation without stale query injection.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["session", "manual-refresh", "relocation", "fresh-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "current-session-refresh-old" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Current session refresh" },
      { type: "sessionChanged" },
      { type: "manualRefresh" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "current-session-refresh-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-opener-current-refresh-after-relocation",
    title: "opener current refresh after relocation",
    notes: "Agent-generated discovery variant for opener-linked relocation followed by current refreshes and stale event without stale query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "manual-refresh", "relocation", "fresh-event"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "opener-current-refresh-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "opener-current-refresh-child" }, captureStaleTabs: "opener-current-refresh-old" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Opener current refresh" },
      { type: "manualRefresh" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "opener-current-refresh-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-focus-current-refresh-after-relocation",
    title: "focus current refresh after relocation",
    notes: "Agent-generated discovery variant for focus/activation churn with current snapshots only.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["focus", "activation", "manual-refresh", "relocation", "fresh-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "focus-current-refresh-old" },
      { type: "outlinerFocusTab", tab: { role: "lastMovedTab" } },
      { type: "activateTab", tab: { role: "lastMovedTab" } },
      { type: "manualRefresh" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "focus-current-refresh-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-race-current-refresh-after-relocation",
    title: "created race with current refresh after relocation",
    notes: "Agent-generated discovery variant for a created event race followed by current snapshots only.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["created-event", "race", "manual-refresh", "relocation", "fresh-event"],
    actions: [
      {
        type: "raceWithOutlinerGroup",
        event: { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "race-current-refresh-tab" },
        groupTab: { tabId: 1 },
        captureStaleTabs: "race-current-refresh-old"
      },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Race current refresh" },
      { type: "manualRefresh" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "race-current-refresh-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-repeated-current-refresh-after-relocation",
    title: "repeated relocation with current refresh",
    notes: "Agent-generated discovery variant for repeated relocation followed by current snapshots only.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["paired-echo", "manual-refresh", "relocation", "fresh-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "repeated-current-first-old" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { role: "lastMovedTab" }, captureStaleTabs: "repeated-current-second-old" },
      { type: "manualRefresh" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "repeated-current-first-old" }, withStaleQuery: false },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "repeated-current-second-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-restore-current-refresh-after-delete",
    title: "restore delete with current refresh only",
    notes: "Agent-generated discovery variant for restore/delete followed by current session and manual refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restore", "delayed-event", "session", "manual-refresh"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 }, captureStaleTabs: "restore-current-refresh-tabs" },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-delete-reject-current-refresh",
    title: "delete rejection followed by current refresh only",
    notes: "Agent-generated discovery variant for delete-reject recovery followed by current session and manual refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["delete-rejection", "session", "manual-refresh", "tombstone"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "delete-current-refresh-old" },
      { type: "outlinerDeleteNodeRejectingClose", node: { tab: { role: "lastMovedTab" } } },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-outliner-close-current-refresh",
    title: "outliner close followed by current refresh only",
    notes: "Agent-generated discovery variant for outliner-owned relocated-tab close followed by current refreshes.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["outliner-close", "session", "manual-refresh", "tombstone"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "outliner-close-current-refresh-old" },
      { type: "outlinerCloseTab", tab: { role: "lastMovedTab" } },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-native-close-current-refresh",
    title: "native close followed by current refresh only",
    notes: "Agent-generated discovery variant for native relocated-tab close followed by current refreshes.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-close", "session", "manual-refresh", "tombstone"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "native-close-current-refresh-old" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "tabRemovedThenSessionChanged" },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-destination-window-current-refresh",
    title: "destination window close with current refresh only",
    notes: "Agent-generated discovery variant for destination-window native close followed by current refreshes.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-close", "session", "manual-refresh", "relocation", "tombstone"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "destination-current-refresh-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" } },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-source-sibling-current-refresh",
    title: "source sibling close with current refresh only",
    notes: "Agent-generated discovery variant for source sibling close followed by current refreshes.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["outliner-close", "session", "manual-refresh", "relocation"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "source-sibling-current-refresh-old" },
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-active-destination-current-refresh",
    title: "active destination tab current refresh",
    notes: "Agent-generated discovery variant for active destination-window tab changes followed by current refreshes.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["activation", "manual-refresh", "relocation", "fresh-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "active-destination-current-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: true, captureTab: "active-destination-current-tab" },
      { type: "activateTab", tab: { role: "lastMovedTab" } },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-active-source-current-refresh",
    title: "active source tab current refresh",
    notes: "Agent-generated discovery variant for active source-window tab changes followed by current refreshes.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["activation", "manual-refresh", "relocation", "fresh-event"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: true, captureTab: "active-source-current-tab" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "active-source-current-old" },
      { type: "activateTab", tab: { capture: "active-source-current-tab" } },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-opener-active-current-refresh",
    title: "opener active current refresh",
    notes: "Agent-generated discovery variant for opener-linked active state changes followed by current refreshes.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "activation", "manual-refresh", "relocation", "fresh-event"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "opener-active-current-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "opener-active-current-child" }, captureStaleTabs: "opener-active-current-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: true, captureTab: "opener-active-current-destination" },
      { type: "activateTab", tab: { role: "lastMovedTab" } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-race-active-current-refresh",
    title: "race active current refresh",
    notes: "Agent-generated discovery variant for activation race followed by current active state refreshes.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["activation", "race", "manual-refresh", "relocation", "fresh-event"],
    actions: [
      {
        type: "raceWithOutlinerGroup",
        event: { type: "activateTab", tab: { tabId: 2 } },
        groupTab: { tabId: 1 },
        captureStaleTabs: "race-active-current-old"
      },
      { type: "activateTab", tab: { role: "lastMovedTab" } },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-repeated-active-current-refresh",
    title: "repeated relocation active current refresh",
    notes: "Agent-generated discovery variant for repeated relocation with active state changes and current refreshes.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["activation", "paired-echo", "manual-refresh", "relocation", "fresh-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "repeated-active-current-first-old" },
      { type: "activateTab", tab: { role: "lastMovedTab" } },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { role: "lastMovedTab" }, captureStaleTabs: "repeated-active-current-second-old" },
      { type: "activateTab", tab: { role: "lastMovedTab" } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-opener-history-missing-source-query",
    title: "opener history replay with missing source query",
    notes: "Coverage expansion for opener-linked history replay when a partial refresh omits the old source window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "undo-redo", "partial-snapshot", "manual-refresh", "relocation"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "opener-history-missing-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "opener-history-missing-child" }, captureStaleTabs: "opener-history-missing-old" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "opener-history-missing-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-opener-history-reordered-source-query",
    title: "opener history replay with reordered source query",
    notes: "Coverage expansion for opener-linked history replay when the source window snapshot has stale tab indices.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "undo-redo", "stale-query", "manual-refresh", "relocation"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "opener-history-reorder-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "opener-history-reorder-child" }, captureStaleTabs: "opener-history-reorder-old" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "opener-history-reorder-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-opener-history-missing-moved-tab-query",
    title: "opener history replay with missing moved tab query",
    notes: "Coverage expansion for opener-linked history replay when a partial refresh omits the relocated opener child.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "undo-redo", "partial-snapshot", "manual-refresh", "relocation"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "opener-history-missing-tab-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "opener-history-missing-tab-child" }, captureStaleTabs: "opener-history-missing-tab-old" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefreshWithMissingTabQuery", tab: { role: "lastMovedTab" } },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "dh-restore-history-missing-window-query",
    title: "restore history replay with missing window query",
    notes: "Coverage expansion for restored/deleted subtrees when undo is followed by a partial refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restore", "undo-redo", "partial-snapshot", "manual-refresh", "delayed-event"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 }, captureStaleTabs: "restore-history-missing-window" },
      { type: "outlinerUndo" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "focusedWindow" } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "restore-history-missing-window" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-restore-history-reordered-query",
    title: "restore history replay with reordered query",
    notes: "Coverage expansion for restored/deleted subtrees when a refreshed restored window has stale tab order.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restore", "undo-redo", "stale-query", "manual-refresh", "delayed-event"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 }, captureStaleTabs: "restore-history-reorder" },
      { type: "outlinerUndo" },
      { type: "openTab", window: { role: "focusedWindow" }, active: false, captureTab: "restore-history-reorder-extra" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "focusedWindow" }, order: "rotateRight" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "restore-history-reorder" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-restore-history-redo-partial-query",
    title: "restore history redo with partial query",
    notes: "Coverage expansion for restore/delete history redo followed by session and partial refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restore", "undo-redo", "partial-snapshot", "session", "manual-refresh"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 }, captureStaleTabs: "restore-history-redo-partial" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "sessionChanged" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "firstRuntimeWindow" } }
    ]
  },
  {
    id: "dh-window-close-source-window-first",
    title: "source window close emits window before tabs",
    notes: "Coverage expansion for native window-close event ordering after command relocation.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-close", "relocation", "event-order", "stale-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "window-close-source-first-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "windowRemovedThenTabsRemoved" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "window-close-source-first-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-window-close-destination-tabs-only",
    title: "destination window close emits tabs only",
    notes: "Coverage expansion for native destination-window disappearance without a windowRemoved event.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-close", "relocation", "event-order", "tombstone"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "window-close-destination-tabs-only-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "tabsRemovedOnly" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-window-close-nested-window-only",
    title: "nested window close emits window only",
    notes: "Coverage expansion for nested command-created windows disappearing without tabRemoved events.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-close", "nested-window", "event-order", "manual-refresh"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "window-close-nested-window-only-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "windowRemovedOnly" },
      { type: "manualRefresh" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "window-close-nested-window-only-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-window-close-source-tabs-only",
    title: "source window close emits tabs only",
    notes: "Coverage expansion for source-window disappearance with tabRemoved events but no windowRemoved event.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-close", "relocation", "event-order", "manual-refresh"],
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "window-close-source-tabs-only-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "tabsRemovedOnly" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "lastOpenedWindow" } }
    ]
  },
  {
    id: "dh-query-missing-source-window-after-relocation",
    title: "query omits source window after relocation",
    notes: "Coverage expansion for whole-window partial refresh snapshots beyond single-tab omission.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["partial-snapshot", "manual-refresh", "relocation", "stale-query"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "query-missing-source-window-old" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "query-missing-source-window-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-query-reordered-destination-after-relocation",
    title: "query reorders destination window after relocation",
    notes: "Coverage expansion for stale tab indices in the command-created destination window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["stale-query", "manual-refresh", "relocation", "fresh-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "query-reordered-destination-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, captureTab: "query-reordered-destination-extra" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "lastOpenedWindow" }, order: "reverse" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "query-reordered-destination-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-query-reordered-focus-session",
    title: "query reorders focused window across session refresh",
    notes: "Coverage expansion for reordered snapshots with focus and session churn but no relocation.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["stale-query", "focus", "activation", "session", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "query-reordered-focus-extra" },
      { type: "focusWindow", window: { windowId: 10 } },
      { type: "activateTab", tab: { capture: "query-reordered-focus-extra" } },
      { type: "sessionChanged" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateLeft" }
    ]
  },
  {
    id: "dh-relocation-create-reject-direct",
    title: "relocation create rejects after moving tab",
    notes: "Coverage expansion for command relocation whose browser createWindow side effect completes before rejection.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["relocation", "command-rejection", "partial-close", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindowRejectingCreate", tab: { tabId: 1 }, captureStaleTabs: "relocation-create-reject-direct-old" },
      { type: "manualRefresh" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "relocation-create-reject-direct-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-relocation-create-reject-opener",
    title: "opener relocation create rejects after moving tab",
    notes: "Coverage expansion for opener-linked command relocation whose browser side effect completes before rejection.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "relocation", "command-rejection", "partial-close"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "relocation-create-reject-opener-child" },
      { type: "outlinerMoveTabCommandToNewWindowRejectingCreate", tab: { capture: "relocation-create-reject-opener-child" }, captureStaleTabs: "relocation-create-reject-opener-old" },
      { type: "sessionChanged" },
      { type: "manualRefreshWithMissingTabQuery", tab: { capture: "relocation-create-reject-opener-child" } }
    ]
  },
  {
    id: "dh-opener-history-reordered-focused-query",
    title: "opener history replay with reordered focused query",
    notes: "Second-wave coverage for opener history replay when the command-created focused window reports stale indices.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "undo-redo", "stale-query", "manual-refresh", "relocation"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "opener-history-focused-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "opener-history-focused-child" }, captureStaleTabs: "opener-history-focused-old" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "openTab", window: { role: "focusedWindow" }, active: false, captureTab: "opener-history-focused-extra" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "focusedWindow" }, order: "rotateLeft" }
    ]
  },
  {
    id: "dh-window-close-source-window-only",
    title: "source window close emits window only",
    notes: "Second-wave coverage for source-window disappearance without tabRemoved events.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-close", "relocation", "event-order", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "window-close-source-window-only-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "windowRemovedOnly" },
      { type: "manualRefresh" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "window-close-source-window-only-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-window-close-destination-window-first",
    title: "destination window close emits window before tabs",
    notes: "Second-wave coverage for destination-window close event order after relocation.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-close", "relocation", "event-order", "tombstone"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "window-close-destination-window-first-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "windowRemovedThenTabsRemoved" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "window-close-destination-window-first-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-query-missing-destination-window-after-relocation",
    title: "query omits destination window after relocation",
    notes: "Second-wave coverage for whole-window partial snapshots that omit the command-created destination window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["partial-snapshot", "manual-refresh", "relocation", "stale-query"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "query-missing-destination-window-old" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "lastOpenedWindow" } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "query-missing-destination-window-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-query-reordered-source-after-relocation",
    title: "query reorders source window after relocation",
    notes: "Second-wave coverage for stale indices in a still-open source window after relocation.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["stale-query", "manual-refresh", "relocation", "fresh-event"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "query-reordered-source-extra" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "query-reordered-source-old" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateRight" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "query-reordered-source-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-focus-session-missing-window-query",
    title: "focus session refresh with missing focused window query",
    notes: "Second-wave coverage for multi-tab ownership under focus/session churn and whole-window omission.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["focus", "activation", "session", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "focus-session-missing-window-extra" },
      { type: "focusWindow", window: { windowId: 10 } },
      { type: "activateTab", tab: { capture: "focus-session-missing-window-extra" } },
      { type: "sessionChanged" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } }
    ]
  },
  {
    id: "dh-focus-session-missing-background-window",
    title: "focus session refresh with missing background window",
    notes: "Third-wave coverage for session refresh when a partial snapshot omits an unfocused live window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["focus", "activation", "session", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "focus-session-background-extra" },
      { type: "focusWindow", window: { windowId: 10 } },
      { type: "activateTab", tab: { tabId: 2 } },
      { type: "sessionChanged" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 20 } }
    ]
  },
  {
    id: "dh-nested-focus-session-missing-destination",
    title: "nested focus session omits destination window",
    notes: "Third-wave coverage for nested relocated windows under focus/session churn and whole-window omission.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["nested-window", "focus", "session", "partial-snapshot", "relocation"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "nested-focus-session-missing-old" },
      { type: "focusWindow", window: { role: "lastOpenedWindow" } },
      { type: "sessionChanged" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "lastOpenedWindow" } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "nested-focus-session-missing-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-opener-focus-session-missing-window",
    title: "opener focus session omits source window",
    notes: "Third-wave coverage combining opener relationships, focus/session churn, and whole-window omission.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "focus", "session", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "opener-focus-session-child" },
      { type: "focusWindow", window: { windowId: 10 } },
      { type: "activateTab", tab: { capture: "opener-focus-session-child" } },
      { type: "sessionChanged" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } }
    ]
  },
  {
    id: "dh-window-close-opener-tabs-only",
    title: "opener source window close emits tabs only",
    notes: "Third-wave coverage for opener-linked source-window close without a windowRemoved event.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "native-close", "event-order", "partial-snapshot"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "window-close-opener-tabs-only-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "window-close-opener-tabs-only-child" }, captureStaleTabs: "window-close-opener-tabs-only-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "tabsRemovedOnly" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "lastOpenedWindow" } }
    ]
  },
  {
    id: "dh-window-close-destination-window-only",
    title: "destination window close emits window only",
    notes: "Final coverage pass for destination-window close without tabRemoved events.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-close", "relocation", "event-order", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "window-close-destination-window-only-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "windowRemovedOnly" },
      { type: "manualRefresh" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "window-close-destination-window-only-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-nested-query-reordered-destination",
    title: "nested destination query reorder",
    notes: "Final coverage pass for stale indices in a nested command-created window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["nested-window", "stale-query", "manual-refresh", "relocation"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "nested-query-reordered-destination-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, captureTab: "nested-query-reordered-destination-extra" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "lastOpenedWindow" }, order: "reverse" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "nested-query-reordered-destination-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-opener-history-reordered-background-query",
    title: "opener history reorders background query",
    notes: "Final coverage pass for opener history replay when an unfocused source window reports stale indices.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "undo-redo", "stale-query", "manual-refresh", "relocation"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "opener-history-background-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "opener-history-background-child" }, captureStaleTabs: "opener-history-background-old" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateLeft" }
    ]
  },
  {
    id: "dh-session-reordered-both-windows",
    title: "session refresh with reordered windows",
    notes: "Final coverage pass for stale tab indices under session refresh without relocation.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["session", "stale-query", "manual-refresh", "focus", "activation"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "session-reordered-window-ten-extra" },
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "session-reordered-window-twenty-extra" },
      { type: "activateTab", tab: { capture: "session-reordered-window-ten-extra" } },
      { type: "sessionChanged" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 20 }, order: "rotateRight" }
    ]
  },
  {
    id: "dh-nested-source-reordered-focus-session",
    title: "nested source reordered after focus session",
    notes: "Clean-block probe for stale source-window indices after nested relocation and focus/session churn.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["nested-window", "focus", "session", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "nested-source-reordered-extra" },
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "nested-source-reordered-old" },
      { type: "focusWindow", window: { windowId: 10 } },
      { type: "sessionChanged" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" }
    ]
  },
  {
    id: "dh-source-window-only-session-refresh",
    title: "source window-only close followed by session refresh",
    notes: "Clean-block probe for source-window `windowRemovedOnly` ordering across session refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-close", "event-order", "session", "relocation", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "source-window-only-session-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "windowRemovedOnly" },
      { type: "sessionChanged" },
      { type: "manualRefresh" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "source-window-only-session-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-destination-window-first-session-refresh",
    title: "destination window-first close followed by session refresh",
    notes: "Clean-block probe for destination-window `windowRemovedThenTabsRemoved` ordering across session refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-close", "event-order", "session", "relocation", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "destination-window-first-session-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "windowRemovedThenTabsRemoved" },
      { type: "sessionChanged" },
      { type: "manualRefresh" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "destination-window-first-session-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-nested-tabs-only-session-refresh",
    title: "nested tabs-only close followed by session refresh",
    notes: "Clean-block probe for nested destination-window `tabsRemovedOnly` ordering across session refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["nested-window", "native-close", "event-order", "session", "manual-refresh"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "nested-tabs-only-session-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "tabsRemovedOnly" },
      { type: "sessionChanged" },
      { type: "manualRefresh" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "nested-tabs-only-session-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-restore-history-source-reordered-session",
    title: "restore history with source reordered after session",
    notes: "Clean-block probe for restore/history replay when a non-restored live window returns stale tab order.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restore", "undo-redo", "session", "stale-query", "manual-refresh"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 }, captureStaleTabs: "restore-source-reordered-session" },
      { type: "outlinerUndo" },
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "restore-source-reordered-extra" },
      { type: "sessionChanged" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "restore-source-reordered-session" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-relocation-reject-after-reordered-query",
    title: "relocation create rejects after reordered query",
    notes: "Clean-block probe for command relocation rejection after a stale ordered source-window refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["relocation", "command-rejection", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "reject-reordered-query-tab" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateRight" },
      { type: "outlinerMoveTabCommandToNewWindowRejectingCreate", tab: { capture: "reject-reordered-query-tab" }, captureStaleTabs: "reject-reordered-query-old" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-focus-session-destination-reordered",
    title: "focus session with reordered destination",
    notes: "Clean-block probe for a command-created destination window under multi-window focus and session churn.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["focus", "session", "stale-query", "relocation", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "focus-destination-background-extra" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "focus-destination-reordered-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, captureTab: "focus-destination-reordered-extra" },
      { type: "focusWindow", window: { role: "lastOpenedWindow" } },
      { type: "sessionChanged" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "lastOpenedWindow" }, order: "rotateRight" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "focus-destination-reordered-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-opener-history-window-only-source-close",
    title: "opener history with source window-only close",
    notes: "Clean-block probe for opener/history replay followed by a source-window close that emits no tabRemoved events.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "undo-redo", "native-close", "event-order", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "opener-history-window-only-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "opener-history-window-only-child" }, captureStaleTabs: "opener-history-window-only-old" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "windowRemovedOnly" },
      { type: "manualRefresh" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "opener-history-window-only-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-restore-redo-source-reordered-session",
    title: "restore redo with source reordered after session",
    notes: "Clean-block probe for restore/history redo when a still-live source window reports stale tab order.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restore", "undo-redo", "session", "stale-query", "manual-refresh"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 }, captureStaleTabs: "restore-redo-source-reordered" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "restore-redo-source-reordered-extra" },
      { type: "sessionChanged" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateLeft" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "restore-redo-source-reordered" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-focus-relocation-missing-background-query",
    title: "focus relocation with missing background query",
    notes: "Clean-block probe for a background window omitted after focus moves to a command-created destination.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["focus", "activation", "relocation", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "focus-relocation-background-extra" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "focus-relocation-missing-background-old" },
      { type: "focusWindow", window: { role: "lastOpenedWindow" } },
      { type: "activateTab", tab: { role: "lastMovedTab" } },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 20 } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "focus-relocation-missing-background-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-opener-source-default-close-session",
    title: "opener source default close followed by session",
    notes: "Clean-block probe for opener-linked relocation when source close emits tab removals before window removal.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "native-close", "event-order", "session", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "opener-source-default-close-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "opener-source-default-close-child" }, captureStaleTabs: "opener-source-default-close-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "tabsRemovedThenWindowRemoved" },
      { type: "sessionChanged" },
      { type: "manualRefresh" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "opener-source-default-close-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-relocation-reject-after-focus-session",
    title: "relocation create rejects after focus session",
    notes: "Clean-block probe for relocation rejection after unrelated focus/session churn.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["relocation", "command-rejection", "focus", "session", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "reject-focus-session-tab" },
      { type: "focusWindow", window: { windowId: 20 } },
      { type: "sessionChanged" },
      { type: "outlinerMoveTabCommandToNewWindowRejectingCreate", tab: { capture: "reject-focus-session-tab" }, captureStaleTabs: "reject-focus-session-old" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-destination-default-close-session-refresh",
    title: "destination default close followed by session refresh",
    notes: "Clean-block probe for destination-window close with tab removals followed by window removal.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-close", "event-order", "session", "relocation", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "destination-default-close-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "tabsRemovedThenWindowRemoved" },
      { type: "sessionChanged" },
      { type: "manualRefresh" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "destination-default-close-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-restore-history-missing-source-session",
    title: "restore history with missing source after session",
    notes: "Clean-block probe for restore/history replay when a partial refresh omits a still-live source window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restore", "undo-redo", "session", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 }, captureStaleTabs: "restore-missing-source-session" },
      { type: "outlinerUndo" },
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "restore-missing-source-extra" },
      { type: "sessionChanged" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "restore-missing-source-session" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-focus-session-reordered-background-query",
    title: "focus session with reordered background query",
    notes: "Clean-block probe for stale tab order in an unfocused background window after focus/session churn.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["focus", "activation", "session", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "focus-session-reordered-background-extra" },
      { type: "focusWindow", window: { windowId: 10 } },
      { type: "activateTab", tab: { tabId: 2 } },
      { type: "sessionChanged" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 20 }, order: "rotateLeft" }
    ]
  },
  {
    id: "dh-opener-history-source-default-close-session",
    title: "opener history source default close followed by session",
    notes: "Clean-block probe for opener/history replay when source close emits tab removals before window removal.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "undo-redo", "native-close", "event-order", "session"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "opener-history-source-default-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "opener-history-source-default-child" }, captureStaleTabs: "opener-history-source-default-old" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "tabsRemovedThenWindowRemoved" },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-destination-default-close-missing-source-query",
    title: "destination default close with missing source query",
    notes: "Clean-block probe for canonical destination close followed by a source-window partial refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-close", "event-order", "partial-snapshot", "relocation", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "destination-default-missing-source-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "tabsRemovedThenWindowRemoved" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "destination-default-missing-source-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-restore-redo-missing-source-session",
    title: "restore redo with missing source after session",
    notes: "Clean-block probe for restore/history redo when a partial refresh omits a still-live source window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restore", "undo-redo", "session", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 }, captureStaleTabs: "restore-redo-missing-source" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "restore-redo-missing-source-extra" },
      { type: "sessionChanged" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "restore-redo-missing-source" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-destination-default-close-reordered-source-query",
    title: "destination default close with reordered source query",
    notes: "Clean-block probe for canonical destination close followed by stale source-window tab order.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-close", "event-order", "stale-query", "relocation", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "destination-default-reordered-source-extra" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "destination-default-reordered-source-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "tabsRemovedThenWindowRemoved" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "destination-default-reordered-source-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-direct-move-source-reordered-session",
    title: "direct move source reordered after session",
    notes: "Clean-block probe for outliner move-to-new-window with stale source-window order after session refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["relocation", "session", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "direct-move-source-reordered-extra" },
      { type: "outlinerMoveTabToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "direct-move-source-reordered-old" },
      { type: "sessionChanged" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateLeft" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "direct-move-source-reordered-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-top-level-move-background-reordered-focus",
    title: "top-level move background reordered after focus",
    notes: "Clean-block probe for top-level relocation while an unfocused background window reports stale tab order.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["relocation", "focus", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "top-level-background-reordered-extra" },
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "top-level-background-reordered-old" },
      { type: "focusWindow", window: { role: "lastOpenedWindow" } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 20 }, order: "rotateRight" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "top-level-background-reordered-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-opener-tab-close-reordered-session",
    title: "opener tab close with reordered session refresh",
    notes: "Clean-block probe for opener-linked native tab close before a stale ordered source-window refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "native-close", "session", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "opener-tab-close-reordered-child" },
      { type: "nativeCloseTab", tab: { capture: "opener-tab-close-reordered-child" }, order: "sessionChangedThenTabRemoved" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" }
    ]
  },
  {
    id: "dh-stale-created-destination-reordered-session",
    title: "stale created after destination reordered session",
    notes: "Clean-block probe for stale old-window created evidence after destination reordering and session refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["relocation", "session", "stale-event", "stale-query", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "stale-created-destination-reordered-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, captureTab: "stale-created-destination-reordered-extra" },
      { type: "sessionChanged" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "lastOpenedWindow" }, order: "rotateLeft" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "stale-created-destination-reordered-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-session-only-tab-close-reordered-source",
    title: "session-only tab close with reordered source",
    notes: "Clean-block probe for native tab disappearance without tabRemoved followed by stale source-window order.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-close", "session", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "session-only-close-reordered-extra" },
      { type: "nativeCloseTab", tab: { tabId: 2 }, order: "sessionChangedOnly" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" },
      { type: "activateTab", tab: { capture: "session-only-close-reordered-extra" } }
    ]
  },
  {
    id: "dh-opener-history-reordered-session",
    title: "opener history reordered after session",
    notes: "Clean-block probe for opener/history replay with session churn and stale source-window order.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "undo-redo", "session", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "opener-history-reordered-session-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "opener-history-reordered-session-child" }, captureStaleTabs: "opener-history-reordered-session-old" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "sessionChanged" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "opener-history-reordered-session-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-flush-stale-created-destination-reordered",
    title: "flush after stale created destination reordered",
    notes: "Clean-block probe for explicit runtime flush after stale-created evidence and destination reordering.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["relocation", "stale-event", "stale-query", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "flush-stale-created-destination-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, captureTab: "flush-stale-created-destination-extra" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "lastOpenedWindow" }, order: "reverse" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "flush-stale-created-destination-old" }, withStaleQuery: false },
      { type: "flushRuntimeEvents" }
    ]
  }
];

const RUNTIME_DOMAIN_DISCOVERED_FINDING_IDS = new Map<string, string[]>([
  ["dh-undo-redo-stale-refresh", ["RT-022"]],
  ["dh-history-redo-stale-created", ["RT-023"]],
  ["dh-history-redo-session-refresh", ["RT-024"]],
  ["dh-restore-history-redo-delayed-echo", ["RT-025"]],
  ["dh-manual-stale-query-after-source-close", ["RT-026"]],
  ["dh-history-manual-stale-query", ["RT-027"]],
  ["dh-repeated-relocation-manual-stale-query", ["RT-028"]],
  ["dh-opener-source-close-manual-stale-query", ["RT-029"]],
  ["dh-group-source-close-manual-stale-query", ["RT-030"]],
  ["dh-top-level-source-close-manual-stale-query", ["RT-031"]],
  ["dh-created-race-source-close-manual-stale-query", ["RT-032"]],
  ["dh-activation-race-source-close-manual-stale-query", ["RT-033"]],
  ["dh-outliner-source-close-manual-stale-query", ["RT-034"]],
  ["dh-delete-reject-source-window-manual-stale-query", ["RT-035"]],
  ["dh-outliner-source-tab-close-manual-stale-query", ["RT-036"]],
  ["dh-relocated-tab-missing-manual-query", ["RT-037"]],
  ["dh-fresh-relocated-tab-missing-manual-query", ["RT-038"]],
  ["dh-opener-child-missing-manual-query", ["RT-039"]]
]);

function runtimeDomainTraceWithFindingMetadata(trace: RuntimeDomainTrace): RuntimeDomainTrace {
  const coveredFindingIds = RUNTIME_DOMAIN_DISCOVERED_FINDING_IDS.get(trace.id);
  return coveredFindingIds
    ? {
        ...trace,
        purpose: "regression",
        coveredFindingIds
      }
    : trace;
}

const RUNTIME_DOMAIN_TRACES: RuntimeDomainTrace[] = [
  ...RUNTIME_DOMAIN_TRACE_DEFINITIONS.map((trace): RuntimeDomainTrace => ({
    ...trace,
    purpose: trace.purpose ?? "regression",
    origin: trace.origin ?? "known-finding",
    tags: trace.tags ?? ["known-finding"]
  })),
  ...RUNTIME_DOMAIN_DISCOVERY_TRACES.map(runtimeDomainTraceWithFindingMetadata)
];

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function pickOne<T>(rng: () => number, values: T[]): T {
  return values[Math.floor(rng() * values.length)]!;
}

function sortedRuntimeTabIds(runtime: FakeRuntime): number[] {
  return runtime.tabs.map((tab) => tab.id).sort((a, b) => a - b);
}

function sortedRuntimeWindowIds(runtime: FakeRuntime): number[] {
  return runtime.windows.map((windowInfo) => windowInfo.id).sort((a, b) => a - b);
}

function tabsInRuntimeWindow(runtime: FakeRuntime, windowId: number): RuntimeTab[] {
  return runtime.tabs
    .filter((tab) => tab.windowId === windowId)
    .sort((left, right) => left.index - right.index);
}

function tabNodeIdFor(tabId: number): string {
  return `tab:${tabId}`;
}

function windowNodeIdFor(windowId: number): string {
  return `window:${windowId}`;
}

function availableGeneratedOperations(context: GeneratedTraceContext): GeneratedOperation[] {
  const operations: GeneratedOperation[] = [];
  const staleDeletedTabs = staleDeletedTabsInOpenWindows(context);
  const staleLiveEventTabs = staleLiveEventTabsInOpenWindows(context);
  const closeableOutlinerTabs = context.runtime.tabs.filter((tab) =>
    tabsInRuntimeWindow(context.runtime, tab.windowId).length > 1
  );
  const multiTabWindows = context.runtime.windows.filter((windowInfo) =>
    tabsInRuntimeWindow(context.runtime, windowInfo.id).length > 1
  );

  if (context.runtime.windows.length > 0) {
    operations.push(
      { name: "open-tab", run: openGeneratedTab },
      { name: "open-tab", run: openGeneratedTab }
    );
  }
  if (context.runtime.tabs.length > 0) {
    operations.push(
      { name: "activate-tab", run: activateGeneratedTab },
      { name: "native-close-tab", run: nativeCloseGeneratedTab },
      { name: "native-close-tab", run: nativeCloseGeneratedTab }
    );
  }
  if (context.adversarialRuntimeQueries && context.runtime.tabs.length > 0 && staleLiveEventTabs.length > 0) {
    operations.push({ name: "activate-tab-with-stale-query", run: activateGeneratedTabWithStaleQuery });
  }
  if (closeableOutlinerTabs.length > 0) {
    operations.push({ name: "outliner-close-tab", run: outlinerCloseGeneratedTab });
  }
  if (context.runtime.windows.length > 1) {
    operations.push({ name: "outliner-close-window", run: outlinerCloseGeneratedWindow });
  }
  if (context.runtime.windows.length > 1) {
    operations.push(
      { name: "outliner-restore-delete-window-delayed-event", run: outlinerRestoreDeleteGeneratedWindowWithDelayedEvent },
      { name: "outliner-delete-window-rejecting-close", run: outlinerDeleteGeneratedWindowWithRejectingClose }
    );
  }
  if (multiTabWindows.length > 0) {
    operations.push({ name: "native-close-window", run: nativeCloseGeneratedWindow });
  }
  if (multiTabWindows.length > 0) {
    operations.push(
      { name: "outliner-move-tab-new-window", run: outlinerMoveGeneratedTabToNewWindow },
      { name: "outliner-group-tab", run: outlinerGroupGeneratedTab }
    );
  }
  if (context.runtime.tabs.length > 0 && staleDeletedTabs.length > 0) {
    operations.push(
      { name: "stale-activation-snapshot", run: staleActivationSnapshot },
      { name: "stale-tab-created-event", run: staleCreatedEvent },
      { name: "stale-tab-updated-event", run: staleUpdatedEvent }
    );
  }
  if (context.runtime.tabs.length > 0 && staleLiveEventTabs.length > 0) {
    operations.push(
      { name: "stale-live-tab-updated-event", run: staleLiveUpdatedEvent },
      { name: "stale-live-tab-updated-event", run: staleLiveUpdatedEvent }
    );
    if (context.adversarialRuntimeQueries) {
      operations.push(
        { name: "stale-live-tab-updated-event-stale-query", run: staleLiveUpdatedEventWithStaleQuery },
        { name: "stale-live-tab-created-event-stale-query", run: staleLiveCreatedEventWithStaleQuery }
      );
    }
  }
  if (context.adversarialConcurrency && context.runtime.tabs.length > 0) {
    operations.push(
      { name: "concurrent-created-tab-then-group", run: concurrentCreatedTabThenGroup },
      { name: "concurrent-updated-tab-then-group", run: concurrentUpdatedTabThenGroup },
      { name: "concurrent-activated-tab-then-group", run: concurrentActivatedTabThenGroup },
      { name: "concurrent-focused-window-then-group", run: concurrentFocusedWindowThenGroup }
    );
  }

  return operations;
}

async function openGeneratedTab(context: GeneratedTraceContext): Promise<void> {
  const windowInfo = pickOne(context.rng, context.runtime.windows);
  const existingTabs = tabsInRuntimeWindow(context.runtime, windowInfo.id);
  const openerTab = existingTabs.length > 0 && context.rng() < 0.75
    ? pickOne(context.rng, existingTabs)
    : undefined;
  const tabId = nextGeneratedTabId(context);
  const tab: RuntimeTab = {
    id: tabId,
    windowId: windowInfo.id,
    index: Math.floor(context.rng() * (existingTabs.length + 1)),
    active: true,
    url: `https://generated.example/${tabId}`,
    title: `Generated ${tabId}`
  };
  if (openerTab) {
    tab.openerTabId = openerTab.id;
  }
  const queryLag = context.rng() < 0.25;
  context.history.push(`open tab ${tab.id} in window ${tab.windowId}${queryLag ? " with stale query" : ""}`);
  await createTabFromBrowser(context.runtime, tab, { queryLag });
}

async function activateGeneratedTab(context: GeneratedTraceContext): Promise<void> {
  const tab = pickOne(context.rng, context.runtime.tabs);
  context.history.push(`activate tab ${tab.id}`);
  await activateTabFromBrowser(context.runtime, tab.id);
}

async function activateGeneratedTabWithStaleQuery(context: GeneratedTraceContext): Promise<void> {
  const staleCandidates = staleLiveEventTabsInOpenWindows(context);
  if (staleCandidates.length === 0) {
    return activateGeneratedTab(context);
  }

  const stale = pickOne(context.rng, staleCandidates);
  const target = context.runtime.tabs.find((tab) => tab.id === stale.id) ?? pickOne(context.rng, context.runtime.tabs);
  context.runtime.queueTabQueryResult(snapshotWithStaleActiveFlags(
    snapshotReplacingTab(context.runtime.tabs, stale),
    stale
  ));
  context.history.push(`activate tab ${target.id} with stale query for moved tab ${stale.id}`);
  await activateTabFromBrowser(context.runtime, target.id);
}

async function nativeCloseGeneratedTab(context: GeneratedTraceContext): Promise<void> {
  const tab = pickOne(context.rng, context.runtime.tabs);
  const tabsInWindow = tabsInRuntimeWindow(context.runtime, tab.windowId);
  context.staleTabs.push(copyTab(tab));

  if (tabsInWindow.length === 1) {
    const protectedExpectedNodeIds = [windowNodeIdFor(tab.windowId), tabNodeIdFor(tab.id)];
    context.expectedClosedNodeIds.add(protectedExpectedNodeIds[0]!);
    context.expectedClosedNodeIds.add(protectedExpectedNodeIds[1]!);
    context.history.push(`native close last tab ${tab.id} in window ${tab.windowId}`);
    await closeRuntimeWindow(context.runtime, tab.windowId, { awaitListeners: true });
    await pruneMissingExpectedClosedNodes(context, protectedExpectedNodeIds);
    return;
  }

  const order = pickOne(context.rng, [
    "tabRemovedThenSessionChanged",
    "sessionChangedThenTabRemoved",
    "tabRemovedOnly",
    "sessionChangedOnly"
  ] satisfies TabCloseEventOrder[]);
  context.nativeDeletedNodeIds.add(tabNodeIdFor(tab.id));
  context.history.push(`native close tab ${tab.id} with ${order}`);
  await closeTabFromBrowser(context.runtime, tab.id, order);
  await pruneMissingExpectedClosedNodes(context, []);
}

async function outlinerCloseGeneratedTab(context: GeneratedTraceContext): Promise<void> {
  const candidates = context.runtime.tabs.filter((tab) =>
    tabsInRuntimeWindow(context.runtime, tab.windowId).length > 1
  );
  const tab = pickOne(context.rng, candidates);
  const protectedExpectedNodeIds = [tabNodeIdFor(tab.id)];
  context.expectedClosedNodeIds.add(protectedExpectedNodeIds[0]!);
  context.history.push(`outliner close tab ${tab.id}`);
  await context.controller.handleMessage({ type: "closeNode", nodeId: tabNodeIdFor(tab.id) });
  await pruneMissingExpectedClosedNodes(context, protectedExpectedNodeIds);
}

async function outlinerCloseGeneratedWindow(context: GeneratedTraceContext): Promise<void> {
  const windowInfo = pickOne(context.rng, context.runtime.windows);
  const tabs = tabsInRuntimeWindow(context.runtime, windowInfo.id);
  const protectedExpectedNodeIds = [windowNodeIdFor(windowInfo.id), ...tabs.map((tab) => tabNodeIdFor(tab.id))];
  context.expectedClosedNodeIds.add(protectedExpectedNodeIds[0]!);
  for (const tab of tabs) {
    context.expectedClosedNodeIds.add(tabNodeIdFor(tab.id));
  }
  context.history.push(`outliner close window ${windowInfo.id} with ${tabs.length} tabs`);
  await context.controller.handleMessage({ type: "closeNode", nodeId: windowNodeIdFor(windowInfo.id) });
  await pruneMissingExpectedClosedNodes(context, protectedExpectedNodeIds);
}

async function outlinerMoveGeneratedTabToNewWindow(context: GeneratedTraceContext): Promise<void> {
  const candidates = await commandMovableLiveTabCandidates(context);
  if (candidates.length === 0) {
    return;
  }

  const candidate = pickOne(context.rng, candidates);
  context.staleLiveEventTabs.push(...candidate.staleTabs);
  context.history.push(`outliner move tab ${candidate.runtimeTab.id} to new window`);
  await context.controller.handleMessage({
    type: "moveNode",
    nodeId: candidate.nodeId,
    index: 0
  });
}

async function outlinerGroupGeneratedTab(context: GeneratedTraceContext): Promise<void> {
  const candidates = await commandMovableLiveTabCandidates(context);
  if (candidates.length === 0) {
    return;
  }

  const candidate = pickOne(context.rng, candidates);
  context.staleLiveEventTabs.push(...candidate.staleTabs);
  context.history.push(`outliner group tab ${candidate.runtimeTab.id}`);
  await context.controller.handleMessage({
    type: "wrapNodeInGroup",
    nodeId: candidate.nodeId
  });
}

async function nativeCloseGeneratedWindow(context: GeneratedTraceContext): Promise<void> {
  const candidates = context.runtime.windows.filter((windowInfo) =>
    tabsInRuntimeWindow(context.runtime, windowInfo.id).length > 1
  );
  const windowInfo = pickOne(context.rng, candidates);
  const tabs = tabsInRuntimeWindow(context.runtime, windowInfo.id);
  const protectedExpectedNodeIds = [windowNodeIdFor(windowInfo.id), ...tabs.map((tab) => tabNodeIdFor(tab.id))];
  context.expectedClosedNodeIds.add(protectedExpectedNodeIds[0]!);
  for (const tab of tabs) {
    context.expectedClosedNodeIds.add(tabNodeIdFor(tab.id));
  }
  context.history.push(`native close multi-tab window ${windowInfo.id}`);
  await closeRuntimeWindow(context.runtime, windowInfo.id, { awaitListeners: true });
  await pruneMissingExpectedClosedNodes(context, protectedExpectedNodeIds);
}

async function outlinerRestoreDeleteGeneratedWindowWithDelayedEvent(context: GeneratedTraceContext): Promise<void> {
  const windowInfo = pickOne(context.rng, context.runtime.windows);
  const originalWindowNodeId = windowNodeIdFor(windowInfo.id);
  context.history.push(`outliner restore-delete window ${windowInfo.id} with delayed restored-tab event`);
  await context.controller.handleMessage({ type: "wrapNodeInGroup", nodeId: originalWindowNodeId });
  let state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const groupId = state.nodes[originalWindowNodeId]?.parentId;
  if (!groupId) {
    return;
  }

  await context.controller.handleMessage({ type: "closeNode", nodeId: groupId });
  await flushGeneratedCloseEvents(context);
  await context.controller.handleMessage({ type: "restoreNode", nodeId: groupId });
  state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const restoredWindow = state.nodes[originalWindowNodeId];
  const restoredWindowId =
    restoredWindow?.kind === "window" && restoredWindow.status === "live" && restoredWindow.live && "windowId" in restoredWindow.live
      ? restoredWindow.live.windowId
      : undefined;
  if (typeof restoredWindowId !== "number") {
    return;
  }

  reserveGeneratedRuntimeTabIds(context, context.runtime.tabs);
  const restoredTabs = tabsInRuntimeWindow(context.runtime, restoredWindowId);
  const delayedTab = restoredTabs[0];
  if (delayedTab) {
    await updateTabFromBrowser(context.runtime, delayedTab.id, {
      title: `${delayedTab.title ?? "Generated"} delayed`
    }, { awaitListeners: false });
  }

  const deletedNodeIds = generatedSubtreeNodeIds(state, groupId);
  vi.mocked(context.runtime.api.windows.remove).mockImplementationOnce(async () => undefined);
  const result = await context.controller.handleMessage({ type: "deleteNode", nodeId: groupId });
  expectCommandAck(result, true);
  markCommandDeletedNodes(context, deletedNodeIds);
  await context.runtime.events.tabUpdated.flush();
  await closeRuntimeWindow(context.runtime, restoredWindowId, { awaitListeners: true });
  await pruneMissingExpectedClosedNodes(context, []);
}

async function outlinerDeleteGeneratedWindowWithRejectingClose(context: GeneratedTraceContext): Promise<void> {
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const candidates = context.runtime.windows.flatMap((windowInfo) => {
    const stateWindow = liveWindowNodeForRuntimeWindow(state, windowInfo.id);
    if (!stateWindow || generatedSubtreeLiveWindowIds(state, stateWindow.id).length !== 1) {
      return [];
    }
    return [{ windowInfo, nodeId: stateWindow.id }];
  });
  if (candidates.length === 0) {
    return;
  }

  const { windowInfo, nodeId } = pickOne(context.rng, candidates);
  const deletedNodeIds = generatedSubtreeNodeIds(state, nodeId);
  context.history.push(`outliner delete window ${windowInfo.id} with rejecting close`);
  vi.mocked(context.runtime.api.windows.remove).mockImplementationOnce(async (windowId) => {
    await closeRuntimeWindow(context.runtime, windowId, { awaitListeners: false });
    throw new Error("generated window close rejected after completion");
  });

  const result = await context.controller.handleMessage({ type: "deleteNode", nodeId });
  expectCommandAck(result, true);
  markCommandDeletedNodes(context, deletedNodeIds);
  await flushGeneratedCloseEvents(context);
  await pruneMissingExpectedClosedNodes(context, []);
}

async function pruneMissingExpectedClosedNodes(
  context: GeneratedTraceContext,
  protectedNodeIds: string[]
): Promise<void> {
  const protectedSet = new Set(protectedNodeIds);
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  for (const nodeId of context.expectedClosedNodeIds) {
    if (!protectedSet.has(nodeId) && !state.nodes[nodeId]) {
      context.expectedClosedNodeIds.delete(nodeId);
    }
  }
}

async function staleActivationSnapshot(context: GeneratedTraceContext): Promise<void> {
  const stale = pickOne(context.rng, staleDeletedTabsInOpenWindows(context));
  const target = pickOne(context.rng, context.runtime.tabs);
  context.runtime.queueTabQueryResult(snapshotContainingDeletedTab(
    context.runtime.tabs.map((tab) => ({
      ...tab,
      active: tab.windowId === target.windowId ? tab.id === target.id : tab.active
    })),
    {
      ...stale,
      active: false
    }
  ));
  context.history.push(`activate tab ${target.id} with stale tab ${stale.id} in query result`);
  await activateTabFromBrowser(context.runtime, target.id);
}

async function staleCreatedEvent(context: GeneratedTraceContext): Promise<void> {
  const stale = pickOne(context.rng, staleDeletedTabsInOpenWindows(context));
  context.history.push(`dispatch stale created event for tab ${stale.id}`);
  await context.runtime.events.tabCreated.emit(copyTab(stale));
}

async function staleUpdatedEvent(context: GeneratedTraceContext): Promise<void> {
  const stale = pickOne(context.rng, staleDeletedTabsInOpenWindows(context));
  context.history.push(`dispatch stale updated event for tab ${stale.id}`);
  await context.runtime.events.tabUpdated.emit(stale.id, { title: "Stale" }, {
    ...stale,
    title: "Stale"
  });
}

async function staleLiveUpdatedEvent(context: GeneratedTraceContext): Promise<void> {
  const stale = pickOne(context.rng, staleLiveEventTabsInOpenWindows(context));
  context.history.push(`dispatch stale live updated event for tab ${stale.id} in old window ${stale.windowId}`);
  await context.runtime.events.tabUpdated.emit(stale.id, { title: "Stale live" }, {
    ...stale,
    title: "Stale live"
  });
}

async function staleLiveUpdatedEventWithStaleQuery(context: GeneratedTraceContext): Promise<void> {
  const stale = pickOne(context.rng, staleLiveEventTabsInOpenWindows(context));
  context.runtime.queueTabQueryResult(snapshotReplacingTab(context.runtime.tabs, stale));
  context.history.push(`dispatch stale live updated event for tab ${stale.id} with stale query window ${stale.windowId}`);
  try {
    await context.runtime.events.tabUpdated.emit(stale.id, { title: "Stale live" }, {
      ...stale,
      title: "Stale live"
    });
  } finally {
    context.runtime.clearNextTabQueryResult();
  }
}

async function staleLiveCreatedEventWithStaleQuery(context: GeneratedTraceContext): Promise<void> {
  const stale = pickOne(context.rng, staleLiveEventTabsInOpenWindows(context));
  context.runtime.queueTabQueryResult(snapshotReplacingTab(context.runtime.tabs, stale));
  context.history.push(`dispatch stale live created event for moved tab ${stale.id} with stale query window ${stale.windowId}`);
  try {
    await context.runtime.events.tabCreated.emit(copyTab(stale));
  } finally {
    context.runtime.clearNextTabQueryResult();
  }
}

async function concurrentCreatedTabThenGroup(context: GeneratedTraceContext): Promise<void> {
  const candidate = await generatedGroupCommandCandidate(context);
  if (!candidate) {
    return;
  }

  const windowInfo = pickOne(context.rng, context.runtime.windows);
  const existingTabs = tabsInRuntimeWindow(context.runtime, windowInfo.id);
  const tabId = nextGeneratedTabId(context);
  const tab: RuntimeTab = {
    id: tabId,
    windowId: windowInfo.id,
    index: Math.floor(context.rng() * (existingTabs.length + 1)),
    active: context.rng() < 0.5,
    url: `https://generated.example/concurrent/${tabId}`,
    title: `Concurrent ${tabId}`
  };
  context.history.push(`dispatch tab ${tab.id} created, then group tab ${candidate.runtimeTab.id}`);
  createTabFromBrowser(context.runtime, tab, { awaitListeners: false });
  await runGeneratedGroupCommand(context, candidate);
  await flushGeneratedRuntimeEventRefreshes(context);
}

async function concurrentUpdatedTabThenGroup(context: GeneratedTraceContext): Promise<void> {
  const candidate = await generatedGroupCommandCandidate(context);
  if (!candidate) {
    return;
  }

  const tab = pickOne(context.rng, context.runtime.tabs);
  context.history.push(`dispatch tab ${tab.id} updated, then group tab ${candidate.runtimeTab.id}`);
  void updateTabFromBrowser(context.runtime, tab.id, {
    title: `${tab.title ?? "Generated"} concurrent ${Math.floor(context.rng() * 10_000)}`
  }, { awaitListeners: false });
  await runGeneratedGroupCommand(context, candidate);
  await flushGeneratedRuntimeEventRefreshes(context);
}

async function concurrentActivatedTabThenGroup(context: GeneratedTraceContext): Promise<void> {
  const candidate = await generatedGroupCommandCandidate(context);
  if (!candidate) {
    return;
  }

  const tab = pickOne(context.rng, context.runtime.tabs);
  context.history.push(`dispatch tab ${tab.id} activated, then group tab ${candidate.runtimeTab.id}`);
  dispatchTabActivatedFromBrowser(context.runtime, tab.id);
  await runGeneratedGroupCommand(context, candidate);
  await flushGeneratedRuntimeEventRefreshes(context);
}

async function concurrentFocusedWindowThenGroup(context: GeneratedTraceContext): Promise<void> {
  const candidate = await generatedGroupCommandCandidate(context);
  if (!candidate) {
    return;
  }

  const windowInfo = pickOne(context.rng, context.runtime.windows);
  context.history.push(`dispatch window ${windowInfo.id} focused, then group tab ${candidate.runtimeTab.id}`);
  dispatchWindowFocusedFromBrowser(context.runtime, windowInfo.id);
  await runGeneratedGroupCommand(context, candidate);
  await flushGeneratedRuntimeEventRefreshes(context);
}

async function generatedGroupCommandCandidate(
  context: GeneratedTraceContext
): Promise<CommandMovableLiveTabCandidate | undefined> {
  const candidates = await commandMovableLiveTabCandidates(context);
  return candidates.length > 0 ? pickOne(context.rng, candidates) : undefined;
}

async function runGeneratedGroupCommand(
  context: GeneratedTraceContext,
  candidate: CommandMovableLiveTabCandidate
): Promise<void> {
  context.staleLiveEventTabs.push(...candidate.staleTabs);
  const result = await context.controller.handleMessage({
    type: "wrapNodeInGroup",
    nodeId: candidate.nodeId
  });
  expectCommandAck(result, true);
}

function dispatchTabActivatedFromBrowser(runtime: FakeRuntime, tabId: number): void {
  const tab = runtime.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) {
    return;
  }

  const previousTab = runtime.tabs.find((candidate) => candidate.windowId === tab.windowId && candidate.active);
  runtime.tabs = runtime.tabs.map((candidate) => candidate.windowId === tab.windowId
    ? { ...candidate, active: candidate.id === tabId }
    : copyTab(candidate));
  runtime.events.tabActivated.dispatch({
    tabId,
    windowId: tab.windowId,
    ...(previousTab ? { previousTabId: previousTab.id } : {})
  });
}

function dispatchWindowFocusedFromBrowser(runtime: FakeRuntime, windowId: number): void {
  runtime.windows = runtime.windows.map((windowInfo) => ({
    ...windowInfo,
    focused: windowInfo.id === windowId
  }));
  runtime.events.windowFocusChanged.dispatch(windowId);
}

async function flushGeneratedRuntimeEventRefreshes(context: GeneratedTraceContext): Promise<void> {
  await Promise.all([
    context.runtime.events.tabCreated.flush(),
    context.runtime.events.tabUpdated.flush(),
    context.runtime.events.tabActivated.flush(),
    context.runtime.events.windowFocusChanged.flush(),
    context.runtime.events.tabRemoved.flush(),
    context.runtime.events.windowRemoved.flush(),
    context.runtime.events.sessionChanged.flush()
  ]);
  await waitForMacrotask();
}

function snapshotReplacingTab(tabs: RuntimeTab[], replacement: RuntimeTab): RuntimeTab[] {
  const replaced = tabs.map((tab) => tab.id === replacement.id ? copyTab(replacement) : copyTab(tab));
  return replaced.some((tab) => tab.id === replacement.id)
    ? replaced
    : [...replaced, copyTab(replacement)];
}

function snapshotMissingTab(tabs: RuntimeTab[], tabId: number): RuntimeTab[] {
  return tabs.filter((tab) => tab.id !== tabId).map(copyTab);
}

function snapshotMissingWindow(tabs: RuntimeTab[], windowId: number): RuntimeTab[] {
  return tabs.filter((tab) => tab.windowId !== windowId).map(copyTab);
}

function snapshotReorderedWindowTabs(
  tabs: RuntimeTab[],
  windowId: number,
  order: "reverse" | "rotateLeft" | "rotateRight"
): RuntimeTab[] {
  const windowTabs = tabs
    .filter((tab) => tab.windowId === windowId)
    .sort((left, right) => left.index - right.index)
    .map(copyTab);
  const reorderedTabs = order === "reverse"
    ? [...windowTabs].reverse()
    : order === "rotateLeft"
      ? [...windowTabs.slice(1), ...windowTabs.slice(0, 1)]
      : [...windowTabs.slice(-1), ...windowTabs.slice(0, -1)];
  const indexByTabId = new Map(reorderedTabs.map((tab, index) => [tab.id, index]));
  return tabs.map((tab) => ({
    ...tab,
    ...(tab.windowId === windowId && indexByTabId.has(tab.id)
      ? { index: indexByTabId.get(tab.id)! }
      : {})
  }));
}

function snapshotContainingDeletedTab(tabs: RuntimeTab[], stale: RuntimeTab): RuntimeTab[] {
  return tabs.some((tab) => tab.id === stale.id)
    ? snapshotReplacingTab(tabs, stale)
    : [...tabs.map(copyTab), copyTab(stale)];
}

function snapshotWithStaleActiveFlags(tabs: RuntimeTab[], staleActive: RuntimeTab): RuntimeTab[] {
  return tabs.map((tab) => ({
    ...tab,
    active: tab.windowId === staleActive.windowId ? tab.id === staleActive.id : tab.active
  }));
}

function staleDeletedTabsInOpenWindows(context: GeneratedTraceContext): RuntimeTab[] {
  return context.staleTabs.filter((tab) =>
    context.runtime.windows.some((windowInfo) => windowInfo.id === tab.windowId) &&
      !context.runtime.tabs.some((runtimeTab) => runtimeTab.id === tab.id)
  );
}

function staleLiveEventTabsInOpenWindows(context: GeneratedTraceContext): RuntimeTab[] {
  return context.staleLiveEventTabs.filter((tab) =>
    context.runtime.windows.some((windowInfo) => windowInfo.id === tab.windowId) &&
      context.runtime.tabs.some((runtimeTab) => runtimeTab.id === tab.id && runtimeTab.windowId !== tab.windowId)
  );
}

function generatedSubtreeNodeIds(state: OutlineState, nodeId: string): string[] {
  const nodeIds: string[] = [];
  const visited = new Set<string>();
  const stack = [nodeId];
  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);
    const node = state.nodes[currentId];
    if (!node) {
      continue;
    }
    nodeIds.push(currentId);
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push(node.childIds[index]!);
    }
  }
  return nodeIds;
}

function generatedSubtreeLiveWindowIds(state: OutlineState, nodeId: string): number[] {
  return generatedSubtreeNodeIds(state, nodeId).flatMap((subtreeNodeId) => {
    const node = state.nodes[subtreeNodeId];
    return node?.kind === "window" && node.status === "live" && node.live && "windowId" in node.live
      ? [node.live.windowId]
      : [];
  });
}

function markCommandDeletedNodes(context: GeneratedTraceContext, nodeIds: string[]): void {
  for (const nodeId of nodeIds) {
    context.commandDeletedNodeIds.add(nodeId);
    context.expectedClosedNodeIds.delete(nodeId);
  }
}

function nextGeneratedTabId(context: GeneratedTraceContext): number {
  while (context.allocatedRuntimeTabIds.has(context.nextTabId)) {
    context.nextTabId += 1;
  }
  const tabId = context.nextTabId;
  context.nextTabId += 1;
  context.allocatedRuntimeTabIds.add(tabId);
  return tabId;
}

function reserveGeneratedRuntimeTabIds(context: GeneratedTraceContext, tabs: RuntimeTab[]): void {
  for (const tab of tabs) {
    context.allocatedRuntimeTabIds.add(tab.id);
    if (tab.id >= context.nextTabId) {
      context.nextTabId = tab.id + 1;
    }
  }
}

async function flushGeneratedCloseEvents(context: GeneratedTraceContext): Promise<void> {
  await Promise.all([
    context.runtime.events.tabRemoved.flush(),
    context.runtime.events.windowRemoved.flush(),
    context.runtime.events.sessionChanged.flush()
  ]);
}

type CommandMovableLiveTabCandidate = {
  nodeId: string;
  runtimeTab: RuntimeTab;
  staleTabs: RuntimeTab[];
};

async function commandMovableLiveTabCandidates(context: GeneratedTraceContext): Promise<CommandMovableLiveTabCandidate[]> {
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  return context.runtime.tabs.flatMap((runtimeTab) => {
    const node = liveTabNodeForRuntimeTab(state, runtimeTab.id);
    if (!node) {
      return [];
    }

    const subtreeTabIds = liveTabIdsInOutlineSubtree(state, node.id);
    const sameWindowTabs = tabsInRuntimeWindow(context.runtime, runtimeTab.windowId);
    if (!sameWindowTabs.some((tab) => !subtreeTabIds.has(tab.id))) {
      return [];
    }

    return [{
      nodeId: node.id,
      runtimeTab,
      staleTabs: sameWindowTabs.filter((tab) => subtreeTabIds.has(tab.id)).map(copyTab)
    }];
  });
}

function liveTabIdsInOutlineSubtree(state: OutlineState, nodeId: string): Set<number> {
  const tabIds = new Set<number>();
  const visited = new Set<string>();
  const stack = [nodeId];

  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);

    const node = state.nodes[currentId];
    if (!node) {
      continue;
    }
    if (node.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live) {
      tabIds.add(node.live.tabId);
    }
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push(node.childIds[index]!);
    }
  }

  return tabIds;
}

function selectedRuntimeDomainTraces(): RuntimeDomainTrace[] {
  const rawTraceIds = process.env.RUNTIME_TRACE_HUNT_TRACE_IDS;
  if (!rawTraceIds) {
    return runtimeDomainTracesForProfile(runtimeTraceHuntProfile());
  }

  const traceIds = rawTraceIds
    .split(",")
    .map((traceId) => traceId.trim())
    .filter(Boolean);
  const selected = RUNTIME_DOMAIN_TRACES.filter((trace) => traceIds.includes(trace.id));
  if (selected.length !== traceIds.length) {
    const known = new Set(RUNTIME_DOMAIN_TRACES.map((trace) => trace.id));
    const missing = traceIds.filter((traceId) => !known.has(traceId));
    throw new Error(`Unknown runtime domain trace id(s): ${missing.join(", ")}`);
  }
  return selected;
}

function runtimeDomainRegressionTraces(): RuntimeDomainTrace[] {
  return runtimeDomainTracesForProfile("regression");
}

type RuntimeTraceHuntProfile = "discovery" | "regression" | "all";

function runtimeTraceHuntProfile(): RuntimeTraceHuntProfile {
  const profile = process.env.RUNTIME_TRACE_HUNT_PROFILE ?? "discovery";
  if (profile === "discovery" || profile === "regression" || profile === "all") {
    return profile;
  }
  throw new Error(`Unknown RUNTIME_TRACE_HUNT_PROFILE ${JSON.stringify(profile)}`);
}

function runtimeDomainTracesForProfile(profile: RuntimeTraceHuntProfile): RuntimeDomainTrace[] {
  if (profile === "all") {
    return RUNTIME_DOMAIN_TRACES;
  }
  return RUNTIME_DOMAIN_TRACES.filter((trace) => trace.purpose === profile);
}

async function runDomainTrace(trace: RuntimeDomainTrace): Promise<void> {
  const context = createGeneratedTraceContext({
    now: 10_000,
    history: [`domain trace ${trace.id}: ${trace.title}`]
  });

  await context.controller.ensureState();
  await assertGeneratedInvariants(context);

  for (let index = 0; index < trace.actions.length; index += 1) {
    const action = trace.actions[index]!;
    context.history.push(`action ${index + 1}: ${domainActionSummary(action)}`);
    try {
      await runDomainAction(context, action);
      await assertGeneratedInvariants(context);
    } catch (error) {
      throw new Error(domainTraceErrorText(trace, index, action, error, context.history));
    }
  }
}

function createGeneratedTraceContext(options: { now: number; history: string[] }): GeneratedTraceContext {
  const runtime = fakeRuntime(
    [
      {
        id: 10,
        focused: true,
        incognito: false
      },
      {
        id: 20,
        focused: false,
        incognito: false
      }
    ],
    [
      {
        id: 1,
        windowId: 10,
        index: 0,
        active: true,
        url: "https://one.example/",
        title: "One"
      },
      {
        id: 2,
        windowId: 10,
        index: 1,
        active: false,
        url: "https://two.example/",
        title: "Two"
      },
      {
        id: 3,
        windowId: 20,
        index: 0,
        active: true,
        url: "https://three.example/",
        title: "Three"
      }
    ]
  );
  const controller = createBackgroundController({ api: runtime.api, now: () => options.now });
  return {
    runtime,
    controller,
    nextTabId: 100,
    allocatedRuntimeTabIds: new Set(runtime.tabs.map((tab) => tab.id)),
    history: [...options.history],
    nativeDeletedNodeIds: new Set(),
    commandDeletedNodeIds: new Set(),
    expectedClosedNodeIds: new Set(),
    staleTabs: [],
    staleLiveEventTabs: [],
    domainCaptures: emptyDomainTraceCaptures(),
    adversarialRuntimeQueries: false,
    adversarialConcurrency: false,
    rng: seededRandom(options.now)
  };
}

function emptyDomainTraceCaptures(): DomainTraceCaptures {
  return {
    tabs: new Map(),
    windows: new Map(),
    staleTabs: new Map()
  };
}

async function runDomainAction(context: GeneratedTraceContext, action: DomainAction): Promise<void> {
  if (isDomainRuntimeEventAction(action)) {
    await runDomainRuntimeEventAction(context, action, { awaitListeners: true });
    return;
  }

  if (action.type === "raceWithOutlinerGroup") {
    const groupTab = resolveDomainTab(context, action.groupTab);
    const candidate = await domainCommandCandidateForTab(context, groupTab.id);
    captureStaleRuntimeTabs(context, action.captureStaleTabs, candidate.staleTabs);
    await runDomainRuntimeEventAction(context, action.event, { awaitListeners: false });
    await runGeneratedGroupCommand(context, candidate);
    captureMovedTab(context, groupTab.id);
    await flushGeneratedRuntimeEventRefreshes(context);
    return;
  }

  if (action.type === "outlinerGroupTab") {
    await runDomainOutlinerGroupTab(context, action.tab, action.captureStaleTabs);
    return;
  }

  if (action.type === "outlinerMoveTabToNewWindow") {
    await runDomainOutlinerMoveTabToNewWindow(context, action.tab, action.captureStaleTabs);
    return;
  }

  if (action.type === "outlinerMoveTabCommandToNewWindow") {
    await runDomainOutlinerMoveTabCommandToNewWindow(context, action.tab, action.captureStaleTabs);
    return;
  }

  if (action.type === "outlinerMoveTabCommandToNewWindowRejectingCreate") {
    await runDomainOutlinerMoveTabCommandToNewWindowRejectingCreate(context, action.tab, action.captureStaleTabs);
    return;
  }

  if (action.type === "outlinerMoveSubtreeToTopLevel") {
    await runDomainOutlinerMoveSubtreeToTopLevel(context, action.tab, action.captureStaleTabs);
    return;
  }

  if (action.type === "outlinerFocusTab") {
    await runDomainOutlinerFocusTab(context, action.tab);
    return;
  }

  if (action.type === "outlinerCloseTab") {
    await runDomainOutlinerCloseTab(context, action.tab);
    return;
  }

  if (action.type === "outlinerCloseWindow") {
    await runDomainOutlinerCloseWindow(context, action.window);
    return;
  }

  if (action.type === "outlinerDeleteWindowRejectingClose") {
    await runDomainOutlinerDeleteWindowRejectingClose(context, action.window);
    return;
  }

  if (action.type === "outlinerDeleteTabRejectingClose") {
    await runDomainOutlinerDeleteTabRejectingClose(context, action.tab);
    return;
  }

  if (action.type === "outlinerDeleteNodeRejectingClose") {
    await runDomainOutlinerDeleteNodeRejectingClose(context, action.node);
    return;
  }

  if (action.type === "outlinerRestoreDeleteWindowDelayedEvent") {
    await runDomainOutlinerRestoreDeleteWindowDelayedEvent(context, action.window, action.captureStaleTabs);
    return;
  }

  if (action.type === "manualRefresh") {
    await runDomainManualRefresh(context);
    return;
  }

  if (action.type === "manualRefreshWithStaleQuery") {
    await runDomainManualRefreshWithStaleQuery(context, action.staleTab);
    return;
  }

  if (action.type === "manualRefreshWithMissingTabQuery") {
    await runDomainManualRefreshWithMissingTabQuery(context, action.tab);
    return;
  }

  if (action.type === "manualRefreshWithMissingWindowQuery") {
    await runDomainManualRefreshWithMissingWindowQuery(context, action.window);
    return;
  }

  if (action.type === "manualRefreshWithReorderedQuery") {
    await runDomainManualRefreshWithReorderedQuery(context, action.window, action.order ?? "reverse");
    return;
  }

  if (action.type === "sessionChanged") {
    await runDomainSessionChanged(context);
    return;
  }

  if (action.type === "outlinerUndo") {
    await runDomainHistoryCommand(context, "undo");
    return;
  }

  if (action.type === "outlinerRedo") {
    await runDomainHistoryCommand(context, "redo");
    return;
  }

  if (action.type === "nativeCloseTab") {
    await runDomainNativeCloseTab(context, action.tab, action.order ?? "tabRemovedThenSessionChanged");
    return;
  }

  if (action.type === "nativeCloseWindow") {
    await runDomainNativeCloseWindow(context, action.window, action.order ?? "tabsRemovedThenWindowRemoved");
    return;
  }

  if (action.type === "staleLiveUpdatedEvent") {
    await runDomainStaleLiveUpdatedEvent(context, action.staleTab, action.withStaleQuery ?? false);
    return;
  }

  if (action.type === "staleLiveCreatedEvent") {
    await runDomainStaleLiveCreatedEvent(context, action.staleTab, action.withStaleQuery ?? false);
    return;
  }

  await flushGeneratedRuntimeEventRefreshes(context);
}

function isDomainRuntimeEventAction(action: DomainAction): action is DomainRuntimeEventAction {
  return action.type === "openTab" ||
    action.type === "activateTab" ||
    action.type === "updateTab" ||
    action.type === "focusWindow";
}

async function runDomainRuntimeEventAction(
  context: GeneratedTraceContext,
  action: DomainRuntimeEventAction,
  options: { awaitListeners: boolean }
): Promise<void> {
  if (action.type === "openTab") {
    const windowInfo = resolveDomainWindow(context, action.window);
    const openerTab = action.openerTab ? resolveDomainTab(context, action.openerTab) : undefined;
    const existingTabs = tabsInRuntimeWindow(context.runtime, windowInfo.id);
    const tabId = nextGeneratedTabId(context);
    const tab: RuntimeTab = {
      id: tabId,
      windowId: windowInfo.id,
      index: existingTabs.length,
      active: action.active ?? true,
      url: action.url ?? `https://domain.example/${tabId}`,
      title: action.title ?? `Domain ${tabId}`,
      ...(openerTab ? { openerTabId: openerTab.id } : {})
    };
    await createTabFromBrowser(context.runtime, tab, { awaitListeners: options.awaitListeners });
    context.lastOpenedTabId = tabId;
    captureRuntimeTab(context, action.captureTab, tabId);
    return;
  }

  if (action.type === "activateTab") {
    const tab = resolveDomainTab(context, action.tab);
    if (action.staleQueryFrom) {
      const stale = resolveDomainStaleTab(context, action.staleQueryFrom);
      context.runtime.queueTabQueryResult(snapshotWithStaleActiveFlags(
        snapshotReplacingTab(context.runtime.tabs, stale),
        stale
      ));
    }
    if (options.awaitListeners) {
      await activateTabFromBrowser(context.runtime, tab.id);
    } else {
      dispatchTabActivatedFromBrowser(context.runtime, tab.id);
    }
    context.runtime.clearNextTabQueryResult();
    return;
  }

  if (action.type === "updateTab") {
    const tab = resolveDomainTab(context, action.tab);
    await updateTabFromBrowser(context.runtime, tab.id, {
      title: action.title ?? `${tab.title ?? "Domain"} updated`
    }, { awaitListeners: options.awaitListeners });
    return;
  }

  const windowInfo = resolveDomainWindow(context, action.window);
  if (options.awaitListeners) {
    await focusWindowFromBrowser(context.runtime, windowInfo.id);
  } else {
    dispatchWindowFocusedFromBrowser(context.runtime, windowInfo.id);
  }
}

async function runDomainOutlinerGroupTab(
  context: GeneratedTraceContext,
  selector: DomainTabSelector,
  captureStaleTabs?: string
): Promise<void> {
  const tab = resolveDomainTab(context, selector);
  const candidate = await domainCommandCandidateForTab(context, tab.id);
  captureStaleRuntimeTabs(context, captureStaleTabs, candidate.staleTabs);
  await runGeneratedGroupCommand(context, candidate);
  captureMovedTab(context, tab.id);
}

async function runDomainOutlinerMoveTabToNewWindow(
  context: GeneratedTraceContext,
  selector: DomainTabSelector,
  captureStaleTabs?: string
): Promise<void> {
  const tab = resolveDomainTab(context, selector);
  const candidate = await domainCommandCandidateForTab(context, tab.id);
  captureStaleRuntimeTabs(context, captureStaleTabs, candidate.staleTabs);
  context.staleLiveEventTabs.push(...candidate.staleTabs);
  const result = await context.controller.handleMessage({
    type: "moveNode",
    nodeId: candidate.nodeId,
    index: 0
  });
  expectCommandAck(result, true);
  captureMovedTab(context, tab.id);
}

async function runDomainOutlinerMoveTabCommandToNewWindow(
  context: GeneratedTraceContext,
  selector: DomainTabSelector,
  captureStaleTabs?: string
): Promise<void> {
  const tab = resolveDomainTab(context, selector);
  const candidate = await domainRelocatableCommandCandidateForTab(context, tab.id);
  captureStaleRuntimeTabs(context, captureStaleTabs, candidate.staleTabs);
  context.staleLiveEventTabs.push(...candidate.staleTabs);
  const result = await context.controller.handleMessage({
    type: "moveNodeToNewWindow",
    nodeId: candidate.nodeId,
    index: 0
  });
  expectCommandAck(result, true);
  captureMovedTab(context, tab.id);
}

async function runDomainOutlinerMoveTabCommandToNewWindowRejectingCreate(
  context: GeneratedTraceContext,
  selector: DomainTabSelector,
  captureStaleTabs?: string
): Promise<void> {
  const tab = resolveDomainTab(context, selector);
  const candidate = await domainRelocatableCommandCandidateForTab(context, tab.id);
  captureStaleRuntimeTabs(context, captureStaleTabs, candidate.staleTabs);
  context.staleLiveEventTabs.push(...candidate.staleTabs);
  vi.mocked(context.runtime.api.windows.create).mockImplementationOnce(async (createData) => {
    createWindowFromBrowser(context.runtime, createData as FakeWindowCreateData);
    throw new Error("domain create window rejected after completion");
  });
  const result = await context.controller.handleMessage({
    type: "moveNodeToNewWindow",
    nodeId: candidate.nodeId,
    index: 0
  });
  expect((result as CommandAck).type).toBe("commandAck");
  captureMovedTab(context, tab.id);
  await flushGeneratedRuntimeEventRefreshes(context);
}

async function runDomainOutlinerMoveSubtreeToTopLevel(
  context: GeneratedTraceContext,
  selector: DomainTabSelector,
  captureStaleTabs?: string
): Promise<void> {
  const tab = resolveDomainTab(context, selector);
  const candidate = await domainRelocatableCommandCandidateForTab(context, tab.id);
  captureStaleRuntimeTabs(context, captureStaleTabs, candidate.staleTabs);
  context.staleLiveEventTabs.push(...candidate.staleTabs);
  const result = await context.controller.handleMessage({
    type: "moveSubtreeToTopLevel",
    nodeId: candidate.nodeId
  });
  expectCommandAck(result, true);
  captureMovedTab(context, tab.id);
}

async function domainCommandCandidateForTab(
  context: GeneratedTraceContext,
  tabId: number
): Promise<CommandMovableLiveTabCandidate> {
  const candidates = await commandMovableLiveTabCandidates(context);
  const candidate = candidates.find((value) => value.runtimeTab.id === tabId);
  if (!candidate) {
    throw new Error(`No movable live-tab command candidate for runtime tab ${tabId}`);
  }
  return candidate;
}

async function domainRelocatableCommandCandidateForTab(
  context: GeneratedTraceContext,
  tabId: number
): Promise<CommandMovableLiveTabCandidate> {
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const runtimeTab = runtimeTabById(context, tabId);
  const node = liveTabNodeForRuntimeTab(state, runtimeTab.id);
  if (!node) {
    throw new Error(`No live outline tab for runtime tab ${tabId}`);
  }

  const subtreeTabIds = liveTabIdsInOutlineSubtree(state, node.id);
  const sameWindowTabs = tabsInRuntimeWindow(context.runtime, runtimeTab.windowId);
  return {
    nodeId: node.id,
    runtimeTab,
    staleTabs: sameWindowTabs.filter((tab) => subtreeTabIds.has(tab.id)).map(copyTab)
  };
}

async function runDomainOutlinerFocusTab(
  context: GeneratedTraceContext,
  selector: DomainTabSelector
): Promise<void> {
  const tab = resolveDomainTab(context, selector);
  const result = await context.controller.handleMessage({
    type: "focusNode",
    nodeId: tabNodeIdFor(tab.id)
  });
  expectCommandAck(result, false);
  await flushGeneratedRuntimeEventRefreshes(context);
}

async function runDomainOutlinerCloseWindow(
  context: GeneratedTraceContext,
  selector: DomainWindowSelector
): Promise<void> {
  const windowInfo = resolveDomainWindow(context, selector);
  const tabs = tabsInRuntimeWindow(context.runtime, windowInfo.id);
  const protectedExpectedNodeIds = [windowNodeIdFor(windowInfo.id), ...tabs.map((tab) => tabNodeIdFor(tab.id))];
  context.expectedClosedNodeIds.add(protectedExpectedNodeIds[0]!);
  for (const tab of tabs) {
    context.expectedClosedNodeIds.add(tabNodeIdFor(tab.id));
  }
  await context.controller.handleMessage({ type: "closeNode", nodeId: windowNodeIdFor(windowInfo.id) });
  await pruneMissingExpectedClosedNodes(context, protectedExpectedNodeIds);
}

async function runDomainOutlinerCloseTab(
  context: GeneratedTraceContext,
  selector: DomainTabSelector
): Promise<void> {
  const tab = resolveDomainTab(context, selector);
  const nodeId = tabNodeIdFor(tab.id);
  context.expectedClosedNodeIds.add(nodeId);
  await context.controller.handleMessage({ type: "closeNode", nodeId });
  await flushGeneratedCloseEvents(context);
  await pruneMissingExpectedClosedNodes(context, [nodeId]);
}

async function runDomainOutlinerDeleteWindowRejectingClose(
  context: GeneratedTraceContext,
  selector: DomainWindowSelector
): Promise<void> {
  const windowInfo = resolveDomainWindow(context, selector);
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const stateWindow = liveWindowNodeForRuntimeWindow(state, windowInfo.id);
  if (!stateWindow) {
    throw new Error(`No live outline window for runtime window ${windowInfo.id}`);
  }

  const deletedNodeIds = generatedSubtreeNodeIds(state, stateWindow.id);
  vi.mocked(context.runtime.api.windows.remove).mockImplementationOnce(async (windowId) => {
    await closeRuntimeWindow(context.runtime, windowId, { awaitListeners: false });
    throw new Error("domain window close rejected after completion");
  });
  const result = await context.controller.handleMessage({ type: "deleteNode", nodeId: stateWindow.id });
  expectCommandAck(result, true);
  markCommandDeletedNodes(context, deletedNodeIds);
  await flushGeneratedCloseEvents(context);
  await pruneMissingExpectedClosedNodes(context, []);
}

async function runDomainOutlinerDeleteTabRejectingClose(
  context: GeneratedTraceContext,
  selector: DomainTabSelector
): Promise<void> {
  const tab = resolveDomainTab(context, selector);
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const stateTab = liveTabNodeForRuntimeTab(state, tab.id);
  if (!stateTab) {
    throw new Error(`No live outline tab for runtime tab ${tab.id}`);
  }

  const deletedNodeIds = generatedSubtreeNodeIds(state, stateTab.id);
  vi.mocked(context.runtime.api.tabs.remove).mockImplementationOnce(async (tabIds) => {
    for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
      await closeRuntimeTab(context.runtime, tabId, "tabRemovedThenSessionChanged", { awaitListeners: false });
    }
    throw new Error("domain tab close rejected after completion");
  });
  const result = await context.controller.handleMessage({ type: "deleteNode", nodeId: stateTab.id });
  expectCommandAck(result, true);
  markCommandDeletedNodes(context, deletedNodeIds);
  await flushGeneratedCloseEvents(context);
  await pruneMissingExpectedClosedNodes(context, []);
}

async function runDomainOutlinerDeleteNodeRejectingClose(
  context: GeneratedTraceContext,
  selector: DomainNodeSelector
): Promise<void> {
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const nodeId = resolveDomainNodeId(context, state, selector);
  const node = state.nodes[nodeId];
  if (!node) {
    throw new Error(`No outline node ${nodeId}`);
  }

  const deletedNodeIds = generatedSubtreeNodeIds(state, nodeId);
  if (node.kind === "window" && node.status === "live" && node.live && "windowId" in node.live) {
    vi.mocked(context.runtime.api.windows.remove).mockImplementationOnce(async (windowId) => {
      await closeRuntimeWindow(context.runtime, windowId, { awaitListeners: false });
      throw new Error("domain node window close rejected after completion");
    });
  } else if (node.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live) {
    vi.mocked(context.runtime.api.tabs.remove).mockImplementationOnce(async (tabIds) => {
      for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
        await closeRuntimeTab(context.runtime, tabId, "tabRemovedThenSessionChanged", { awaitListeners: false });
      }
      throw new Error("domain node tab close rejected after completion");
    });
  } else {
    vi.mocked(context.runtime.api.windows.remove).mockImplementationOnce(async (windowId) => {
      await closeRuntimeWindow(context.runtime, windowId, { awaitListeners: false });
      throw new Error("domain node window close rejected after completion");
    });
    vi.mocked(context.runtime.api.tabs.remove).mockImplementationOnce(async (tabIds) => {
      for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
        await closeRuntimeTab(context.runtime, tabId, "tabRemovedThenSessionChanged", { awaitListeners: false });
      }
      throw new Error("domain node tab close rejected after completion");
    });
  }

  const result = await context.controller.handleMessage({ type: "deleteNode", nodeId });
  expect((result as CommandAck).type).toBe("commandAck");
  markCommandDeletedNodes(context, deletedNodeIds);
  await flushGeneratedCloseEvents(context);
  await pruneMissingExpectedClosedNodes(context, []);
}

async function runDomainOutlinerRestoreDeleteWindowDelayedEvent(
  context: GeneratedTraceContext,
  selector: DomainWindowSelector,
  captureStaleTabs?: string
): Promise<void> {
  const windowInfo = resolveDomainWindow(context, selector);
  const originalWindowNodeId = windowNodeIdFor(windowInfo.id);
  await context.controller.handleMessage({ type: "wrapNodeInGroup", nodeId: originalWindowNodeId });
  let state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const groupId = state.nodes[originalWindowNodeId]?.parentId;
  if (!groupId) {
    throw new Error(`Window ${windowInfo.id} was not wrapped before restore-delete trace`);
  }

  await context.controller.handleMessage({ type: "closeNode", nodeId: groupId });
  await flushGeneratedCloseEvents(context);
  await context.controller.handleMessage({ type: "restoreNode", nodeId: groupId });
  state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const restoredWindow = state.nodes[originalWindowNodeId];
  const restoredWindowId =
    restoredWindow?.kind === "window" && restoredWindow.status === "live" && restoredWindow.live && "windowId" in restoredWindow.live
      ? restoredWindow.live.windowId
      : undefined;
  if (typeof restoredWindowId !== "number") {
    throw new Error(`Window ${windowInfo.id} did not restore to a live runtime window`);
  }

  context.lastOpenedWindowId = restoredWindowId;
  const restoredTabs = tabsInRuntimeWindow(context.runtime, restoredWindowId);
  captureStaleRuntimeTabs(context, captureStaleTabs, restoredTabs);
  const delayedTab = restoredTabs[0];
  if (delayedTab) {
    await updateTabFromBrowser(context.runtime, delayedTab.id, {
      title: `${delayedTab.title ?? "Domain"} delayed`
    }, { awaitListeners: false });
  }

  const deletedNodeIds = generatedSubtreeNodeIds(state, groupId);
  vi.mocked(context.runtime.api.windows.remove).mockImplementationOnce(async () => undefined);
  const result = await context.controller.handleMessage({ type: "deleteNode", nodeId: groupId });
  expectCommandAck(result, true);
  markCommandDeletedNodes(context, deletedNodeIds);
  await context.runtime.events.tabUpdated.flush();
  await closeRuntimeWindow(context.runtime, restoredWindowId, { awaitListeners: true });
  await pruneMissingExpectedClosedNodes(context, []);
}

async function runDomainManualRefresh(context: GeneratedTraceContext): Promise<void> {
  const result = await context.controller.handleMessage({ type: "refresh" });
  expect((result as CommandAck).type).toBe("commandAck");
  await flushGeneratedRuntimeEventRefreshes(context);
}

async function runDomainManualRefreshWithStaleQuery(
  context: GeneratedTraceContext,
  selector: DomainStaleTabSelector
): Promise<void> {
  const stale = resolveDomainStaleTab(context, selector);
  context.runtime.queueTabQueryResult(snapshotReplacingTab(context.runtime.tabs, stale));
  try {
    await runDomainManualRefresh(context);
  } finally {
    context.runtime.clearNextTabQueryResult();
  }
}

async function runDomainManualRefreshWithMissingTabQuery(
  context: GeneratedTraceContext,
  selector: DomainTabSelector
): Promise<void> {
  const tab = resolveDomainTab(context, selector);
  context.runtime.queueTabQueryResult(snapshotMissingTab(context.runtime.tabs, tab.id));
  try {
    await runDomainManualRefresh(context);
  } finally {
    context.runtime.clearNextTabQueryResult();
  }
}

async function runDomainManualRefreshWithMissingWindowQuery(
  context: GeneratedTraceContext,
  selector: DomainWindowSelector
): Promise<void> {
  const windowInfo = resolveDomainWindow(context, selector);
  context.runtime.queueTabQueryResult(snapshotMissingWindow(context.runtime.tabs, windowInfo.id));
  try {
    await runDomainManualRefresh(context);
  } finally {
    context.runtime.clearNextTabQueryResult();
  }
}

async function runDomainManualRefreshWithReorderedQuery(
  context: GeneratedTraceContext,
  selector: DomainWindowSelector,
  order: "reverse" | "rotateLeft" | "rotateRight"
): Promise<void> {
  const windowInfo = resolveDomainWindow(context, selector);
  context.runtime.queueTabQueryResult(snapshotReorderedWindowTabs(context.runtime.tabs, windowInfo.id, order));
  try {
    await runDomainManualRefresh(context);
  } finally {
    context.runtime.clearNextTabQueryResult();
  }
}

async function runDomainSessionChanged(context: GeneratedTraceContext): Promise<void> {
  await context.runtime.events.sessionChanged.emit();
  await flushGeneratedRuntimeEventRefreshes(context);
}

async function runDomainHistoryCommand(context: GeneratedTraceContext, type: "undo" | "redo"): Promise<void> {
  const before = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const result = await context.controller.handleMessage({ type });
  expect((result as CommandAck).type).toBe("commandAck");
  const after = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  trackHistoryCommandLifecycleExpectations(context, before, after);
  await flushGeneratedCloseEvents(context);
  await flushGeneratedRuntimeEventRefreshes(context);
}

function trackHistoryCommandLifecycleExpectations(
  context: GeneratedTraceContext,
  before: OutlineState,
  after: OutlineState
): void {
  for (const nodeId of [...context.commandDeletedNodeIds]) {
    if (after.nodes[nodeId]) {
      context.commandDeletedNodeIds.delete(nodeId);
    }
  }

  for (const nodeId of Object.keys(before.nodes)) {
    if (!after.nodes[nodeId]) {
      context.commandDeletedNodeIds.add(nodeId);
      context.expectedClosedNodeIds.delete(nodeId);
    }
  }
}

async function runDomainNativeCloseTab(
  context: GeneratedTraceContext,
  selector: DomainTabSelector,
  order: TabCloseEventOrder
): Promise<void> {
  const tab = resolveDomainTab(context, selector);
  context.staleTabs.push(copyTab(tab));
  const tabsInWindow = tabsInRuntimeWindow(context.runtime, tab.windowId);
  const emitsWindowRemoved = tabsInWindow.length === 1 &&
    (order === "tabRemovedThenSessionChanged" || order === "sessionChangedThenTabRemoved");
  if (emitsWindowRemoved) {
    const protectedExpectedNodeIds = [windowNodeIdFor(tab.windowId), tabNodeIdFor(tab.id)];
    context.expectedClosedNodeIds.add(protectedExpectedNodeIds[0]!);
    context.expectedClosedNodeIds.add(protectedExpectedNodeIds[1]!);
    await closeRuntimeTab(context.runtime, tab.id, order, { awaitListeners: true });
    await pruneMissingExpectedClosedNodes(context, protectedExpectedNodeIds);
    return;
  }

  context.nativeDeletedNodeIds.add(tabNodeIdFor(tab.id));
  await closeRuntimeTab(context.runtime, tab.id, order, { awaitListeners: true });
  await pruneMissingExpectedClosedNodes(context, []);
}

async function runDomainNativeCloseWindow(
  context: GeneratedTraceContext,
  selector: DomainWindowSelector,
  order: WindowCloseEventOrder
): Promise<void> {
  const windowInfo = resolveDomainWindow(context, selector);
  const tabs = tabsInRuntimeWindow(context.runtime, windowInfo.id);
  const protectedExpectedNodeIds = [windowNodeIdFor(windowInfo.id), ...tabs.map((tab) => tabNodeIdFor(tab.id))];
  context.expectedClosedNodeIds.add(protectedExpectedNodeIds[0]!);
  for (const tab of tabs) {
    context.expectedClosedNodeIds.add(tabNodeIdFor(tab.id));
  }
  await closeRuntimeWindow(context.runtime, windowInfo.id, { awaitListeners: true }, order);
  await pruneMissingExpectedClosedNodes(context, protectedExpectedNodeIds);
}

async function runDomainStaleLiveUpdatedEvent(
  context: GeneratedTraceContext,
  selector: DomainStaleTabSelector,
  withStaleQuery: boolean
): Promise<void> {
  const stale = resolveDomainStaleTab(context, selector);
  if (withStaleQuery) {
    context.runtime.queueTabQueryResult(snapshotReplacingTab(context.runtime.tabs, stale));
  }
  try {
    await context.runtime.events.tabUpdated.emit(stale.id, { title: "Domain stale live" }, {
      ...stale,
      title: "Domain stale live"
    });
  } finally {
    context.runtime.clearNextTabQueryResult();
  }
}

async function runDomainStaleLiveCreatedEvent(
  context: GeneratedTraceContext,
  selector: DomainStaleTabSelector,
  withStaleQuery: boolean
): Promise<void> {
  const stale = resolveDomainStaleTab(context, selector);
  if (withStaleQuery) {
    context.runtime.queueTabQueryResult(snapshotReplacingTab(context.runtime.tabs, stale));
  }
  try {
    await context.runtime.events.tabCreated.emit(copyTab(stale));
  } finally {
    context.runtime.clearNextTabQueryResult();
  }
}

function resolveDomainTab(context: GeneratedTraceContext, selector: DomainTabSelector): RuntimeTab {
  if ("tabId" in selector) {
    return runtimeTabById(context, selector.tabId);
  }
  if ("capture" in selector) {
    const tab = context.domainCaptures.tabs.get(selector.capture);
    if (!tab) {
      throw new Error(`Missing captured tab ${selector.capture}`);
    }
    return runtimeTabById(context, tab.id);
  }
  if ("inWindow" in selector) {
    const windowInfo = resolveDomainWindow(context, selector.inWindow);
    const tab = tabsInRuntimeWindow(context.runtime, windowInfo.id)[selector.index ?? 0];
    if (!tab) {
      throw new Error(`Missing tab at index ${selector.index ?? 0} in window ${windowInfo.id}`);
    }
    return tab;
  }
  if (selector.role === "activeTab") {
    const tab = context.runtime.tabs.find((candidate) => candidate.active);
    if (!tab) {
      throw new Error("Missing active runtime tab");
    }
    return tab;
  }
  if (selector.role === "lastOpenedTab") {
    return runtimeTabById(context, context.lastOpenedTabId ?? -1);
  }
  if (selector.role === "lastMovedTab") {
    return runtimeTabById(context, context.lastMovedTabId ?? -1);
  }
  const tab = context.runtime.tabs.slice().sort((left, right) => left.id - right.id)[0];
  if (!tab) {
    throw new Error("Missing first runtime tab");
  }
  return tab;
}

function resolveDomainWindow(context: GeneratedTraceContext, selector: DomainWindowSelector): FakeRuntimeWindow {
  if ("windowId" in selector) {
    return runtimeWindowById(context, selector.windowId);
  }
  if ("capture" in selector) {
    const windowInfo = context.domainCaptures.windows.get(selector.capture);
    if (!windowInfo) {
      throw new Error(`Missing captured window ${selector.capture}`);
    }
    return runtimeWindowById(context, windowInfo.id);
  }
  if (selector.role === "focusedWindow") {
    const windowInfo = context.runtime.windows.find((candidate) => candidate.focused);
    if (!windowInfo) {
      throw new Error("Missing focused runtime window");
    }
    return windowInfo;
  }
  if (selector.role === "lastOpenedWindow") {
    return runtimeWindowById(context, context.lastOpenedWindowId ?? -1);
  }
  const windowInfo = context.runtime.windows.slice().sort((left, right) => left.id - right.id)[0];
  if (!windowInfo) {
    throw new Error("Missing first runtime window");
  }
  return windowInfo;
}

function resolveDomainNodeId(
  context: GeneratedTraceContext,
  state: OutlineState,
  selector: DomainNodeSelector
): string {
  if ("nodeId" in selector) {
    return selector.nodeId;
  }
  if ("tab" in selector) {
    const tab = resolveDomainTab(context, selector.tab);
    const node = liveTabNodeForRuntimeTab(state, tab.id);
    if (!node) {
      throw new Error(`No live outline tab for runtime tab ${tab.id}`);
    }
    return node.id;
  }

  const windowInfo = resolveDomainWindow(context, selector.window);
  const node = liveWindowNodeForRuntimeWindow(state, windowInfo.id);
  if (!node) {
    throw new Error(`No live outline window for runtime window ${windowInfo.id}`);
  }
  return node.id;
}

function resolveDomainStaleTab(context: GeneratedTraceContext, selector: DomainStaleTabSelector): RuntimeTab {
  if ("role" in selector) {
    const defaultIndex = Math.max(0, context.staleLiveEventTabs.length - 1);
    const tab = context.staleLiveEventTabs[selector.index ?? defaultIndex];
    if (!tab) {
      throw new Error("Missing stale live tab from an old window");
    }
    return copyTab(tab);
  }

  const tabs = context.domainCaptures.staleTabs.get(selector.capture);
  if (!tabs || tabs.length === 0) {
    throw new Error(`Missing captured stale tab set ${selector.capture}`);
  }
  if (typeof selector.tabId === "number") {
    const tab = tabs.find((candidate) => candidate.id === selector.tabId);
    if (!tab) {
      throw new Error(`Missing stale tab ${selector.tabId} in ${selector.capture}`);
    }
    return copyTab(tab);
  }
  return copyTab(tabs[selector.index ?? 0]!);
}

function runtimeTabById(context: GeneratedTraceContext, tabId: number): RuntimeTab {
  const tab = context.runtime.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) {
    throw new Error(`Missing runtime tab ${tabId}`);
  }
  return tab;
}

function runtimeWindowById(context: GeneratedTraceContext, windowId: number): FakeRuntimeWindow {
  const windowInfo = context.runtime.windows.find((candidate) => candidate.id === windowId);
  if (!windowInfo) {
    throw new Error(`Missing runtime window ${windowId}`);
  }
  return windowInfo;
}

function captureRuntimeTab(context: GeneratedTraceContext, captureName: string | undefined, tabId: number): void {
  if (!captureName) {
    return;
  }
  context.domainCaptures.tabs.set(captureName, copyTab(runtimeTabById(context, tabId)));
}

function captureStaleRuntimeTabs(
  context: GeneratedTraceContext,
  captureName: string | undefined,
  tabs: RuntimeTab[]
): void {
  if (!captureName) {
    return;
  }
  context.domainCaptures.staleTabs.set(captureName, tabs.map(copyTab));
}

function captureMovedTab(context: GeneratedTraceContext, tabId: number): void {
  const moved = runtimeTabById(context, tabId);
  context.lastMovedTabId = moved.id;
  context.lastOpenedWindowId = moved.windowId;
}

function domainActionSummary(action: DomainAction): string {
  return JSON.stringify(action);
}

function domainTraceErrorText(
  trace: RuntimeDomainTrace,
  actionIndex: number,
  action: DomainAction,
  error: unknown,
  history: string[]
): string {
  return `${generatedErrorText(error)}\nDomain trace: ${trace.id}\nAction ${actionIndex + 1}: ${JSON.stringify(action)}\nTrace:\n${history.join("\n")}`;
}

async function runGeneratedTrace(seed: number, steps: number, options: GeneratedTraceOptions = {}): Promise<void> {
  const context = createGeneratedTraceContext({ now: seed * 1000, history: [`seed ${seed}`] });
  context.adversarialRuntimeQueries = options.adversarialRuntimeQueries ?? false;
  context.adversarialConcurrency = options.adversarialConcurrency ?? false;
  context.rng = seededRandom(seed);

  await context.controller.ensureState();
  await assertGeneratedInvariants(context);

  for (let step = 0; step < steps; step += 1) {
    const operations = availableGeneratedOperations(context);
    if (operations.length === 0) {
      break;
    }

    const operation = pickOne(context.rng, operations);
    context.history.push(`step ${step + 1}: ${operation.name}`);
    try {
      await operation.run(context);
    } catch (error) {
      throw new Error(`${generatedErrorText(error)}\nTrace:\n${context.history.join("\n")}`);
    }
    await assertGeneratedInvariants(context);

    if (context.runtime.windows.length === 0) {
      break;
    }
  }
}

async function runGeneratedGroupingTrace(): Promise<void> {
  const runtime = fakeRuntime(
    [
      {
        id: 10,
        focused: true,
        incognito: false
      },
      {
        id: 20,
        focused: false,
        incognito: false
      }
    ],
    [
      {
        id: 1,
        windowId: 10,
        index: 0,
        active: true,
        url: "https://one.example/",
        title: "One"
      },
      {
        id: 2,
        windowId: 10,
        index: 1,
        active: false,
        openerTabId: 1,
        url: "https://two.example/",
        title: "Two"
      },
      {
        id: 3,
        windowId: 20,
        index: 0,
        active: true,
        url: "https://three.example/",
        title: "Three"
      }
    ]
  );
  const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
  const context: GeneratedTraceContext = {
    runtime,
    controller,
    nextTabId: 100,
    allocatedRuntimeTabIds: new Set(runtime.tabs.map((tab) => tab.id)),
    history: [],
    nativeDeletedNodeIds: new Set(),
    commandDeletedNodeIds: new Set(),
    expectedClosedNodeIds: new Set(),
    staleTabs: [],
    staleLiveEventTabs: [],
    domainCaptures: emptyDomainTraceCaptures(),
    adversarialRuntimeQueries: false,
    adversarialConcurrency: false,
    rng: seededRandom(1001)
  };

  await controller.ensureState();
  await assertGeneratedInvariants(context);

  context.history.push("outliner group tab 1");
  await controller.handleMessage({ type: "wrapNodeInGroup", nodeId: "tab:1" });
  await assertGeneratedInvariants(context);

  await activateGeneratedTab(context);
  await assertGeneratedInvariants(context);
}

async function assertGeneratedInvariants(context: GeneratedTraceContext): Promise<void> {
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  assertStructureInvariants(state, context.history);
  assertRuntimeProjectionInvariants(state, context);
  assertLifecycleExpectationInvariants(state, context);
  assertClosedSubtreeInvariants(state, context.history);
  assertRuntimeIndexWarmForGeneratedTrace(context);
}

function assertRuntimeIndexWarmForGeneratedTrace(context: GeneratedTraceContext): void {
  const status = context.controller.__debugRuntimeIndexStatus();
  invariant(status.warm, "runtime index was cold after generated operation", context.history);
  invariant(status.matchesState, `runtime index diverged after generated operation: ${status.reason}`, context.history);
}

function assertStructureInvariants(state: OutlineState, history: string[]): void {
  invariant(new Set(state.rootIds).size === state.rootIds.length, "rootIds contain duplicates", history);
  invariantEqual(reachableNodeIds(state), Object.keys(state.nodes).sort(), "all nodes are reachable", history);

  for (const rootId of state.rootIds) {
    const root = state.nodes[rootId];
    invariant(Boolean(root), `root node ${rootId} is missing`, history);
    invariant(!root?.parentId, `root node ${rootId} has parent ${root?.parentId}`, history);
  }

  for (const [nodeId, node] of Object.entries(state.nodes)) {
    invariant(
      new Set(node.childIds).size === node.childIds.length,
      `node ${nodeId} has duplicate children`,
      history
    );

    if (node.parentId) {
      const parent = state.nodes[node.parentId];
      invariant(Boolean(parent), `node ${nodeId} has missing parent ${node.parentId}`, history);
      invariant(
        Boolean(parent?.childIds.includes(nodeId)),
        `parent ${node.parentId} does not include child ${nodeId}`,
        history
      );
    }

    for (const childId of node.childIds) {
      const child = state.nodes[childId];
      invariant(Boolean(child), `node ${nodeId} has missing child ${childId}`, history);
      invariant(child?.parentId === nodeId, `child ${childId} does not point back to ${nodeId}`, history);
    }
  }
}

function assertRuntimeProjectionInvariants(state: OutlineState, context: GeneratedTraceContext): void {
  invariantEqual(liveTabIds(state), sortedRuntimeTabIds(context.runtime), "live tab IDs match runtime tabs", context.history);
  invariantEqual(
    liveWindowIds(state),
    sortedRuntimeWindowIds(context.runtime),
    "live window IDs match runtime windows",
    context.history
  );

  for (const runtimeTab of context.runtime.tabs) {
    const node = liveTabNodeForRuntimeTab(state, runtimeTab.id);
    invariant(Boolean(node), `runtime tab ${runtimeTab.id} has no live node`, context.history);
    invariant(node?.live?.windowId === runtimeTab.windowId, `tab ${runtimeTab.id} has wrong live window`, context.history);
    invariant(node?.active === runtimeTab.active, `tab ${runtimeTab.id} active flag diverged`, context.history);
  }

  for (const node of Object.values(state.nodes)) {
    if (node.kind !== "tab" || node.status !== "live" || !node.live || !("tabId" in node.live)) {
      continue;
    }

    const owningWindow = nearestWindowNode(state, node.id);
    invariant(
      owningWindow?.live && "windowId" in owningWindow.live && owningWindow.live.windowId === node.live.windowId,
      `live tab ${node.id} is not under its runtime window`,
      context.history
    );
  }
}

function assertLifecycleExpectationInvariants(state: OutlineState, context: GeneratedTraceContext): void {
  for (const nodeId of context.nativeDeletedNodeIds) {
    invariant(!state.nodes[nodeId], `native-deleted node ${nodeId} was resurrected`, context.history);
  }
  for (const nodeId of context.commandDeletedNodeIds) {
    invariant(!state.nodes[nodeId], `command-deleted node ${nodeId} was resurrected`, context.history);
  }

  for (const nodeId of context.expectedClosedNodeIds) {
    if (context.nativeDeletedNodeIds.has(nodeId) || context.commandDeletedNodeIds.has(nodeId)) {
      continue;
    }

    const node = state.nodes[nodeId];
    invariant(Boolean(node), `expected closed node ${nodeId} is missing`, context.history);
    invariant(node?.status === "closed", `expected closed node ${nodeId} is ${node?.status}`, context.history);
  }
}

function assertClosedSubtreeInvariants(state: OutlineState, history: string[]): void {
  for (const node of Object.values(state.nodes)) {
    if (node.status === "live") {
      const closedAncestor = nearestAncestor(state, node.id, (candidate) => candidate.status === "closed");
      invariant(!closedAncestor, `live node ${node.id} is under closed node ${closedAncestor?.id}`, history);
    }

    if (node.kind === "tab" && node.status === "closed" && node.childIds.length > 0) {
      const owningWindow = nearestWindowNode(state, node.id);
      invariant(
        owningWindow?.status !== "live",
        `closed tab ${node.id} has children while under live window ${owningWindow?.id}`,
        history
      );
    }
  }
}

function liveTabNodeForRuntimeTab(state: OutlineState, tabId: number) {
  return Object.values(state.nodes).find((node) =>
    node.kind === "tab" &&
      node.status === "live" &&
      node.live &&
      "tabId" in node.live &&
      node.live.tabId === tabId
  );
}

function liveWindowNodeForRuntimeWindow(state: OutlineState, windowId: number) {
  return Object.values(state.nodes).find((node) =>
    node.kind === "window" &&
      node.status === "live" &&
      node.live &&
      "windowId" in node.live &&
      node.live.windowId === windowId
  );
}

function nearestWindowNode(state: OutlineState, nodeId: string) {
  return nearestAncestor(state, nodeId, (node) => node.kind === "window");
}

function nearestAncestor(
  state: OutlineState,
  nodeId: string,
  predicate: (node: OutlineState["nodes"][string]) => boolean
) {
  let current = state.nodes[nodeId];
  const visited = new Set<string>();

  while (current) {
    if (visited.has(current.id)) {
      return undefined;
    }
    visited.add(current.id);

    if (predicate(current)) {
      return current;
    }
    current = current.parentId ? state.nodes[current.parentId] : undefined;
  }

  return undefined;
}

function invariant(condition: boolean, message: string, history: string[]): void {
  if (!condition) {
    throw new Error(`${message}\nTrace:\n${history.join("\n")}`);
  }
}

function invariantEqual<T>(actual: T, expected: T, message: string, history: string[]): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  invariant(
    actualJson === expectedJson,
    `${message}\nExpected: ${expectedJson}\nReceived: ${actualJson}`,
    history
  );
}

function generatedErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe("background controller lifecycle", () => {
  it("toggles the sidebar from the native extension command", async () => {
    const runtime = fakeRuntime([], []);
    createBackgroundController({ api: runtime.api, now: () => 1000 });

    await runtime.events.command.emit("toggle-sidebar");

    expect(runtime.api.sidebarAction.toggle).toHaveBeenCalledTimes(1);
  });

  it("enabling automatic backups schedules an alarm and immediately downloads an export", async () => {
    const now = Date.parse("2026-05-19T13:20:00.000Z");
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => now });
    await controller.ensureState();

    await runtime.api.storage.local.set({
      [APP_PREFERENCES_STORAGE_KEY]: {
        ...DEFAULT_APP_PREFERENCES,
        automaticBackups: { enabled: true }
      }
    });
    await runtime.events.storageChanged.flush();

    expect(runtime.alarms.get(AUTOMATIC_BACKUP_ALARM_NAME)).toMatchObject({
      name: AUTOMATIC_BACKUP_ALARM_NAME,
      periodInMinutes: 1440
    });
    expect(runtime.downloads).toHaveLength(1);
    expect(runtime.downloads[0]).toMatchObject({
      filename: "tabs-outliner-backups/tabs-outliner-tree-2026-05-19.json",
      saveAs: false
    });
    const payload = JSON.parse(runtime.downloads[0]!.body ?? "{}") as { schema?: string; roots?: unknown[] };
    expect(payload).toMatchObject({
      schema: PORTABLE_TREE_SCHEMA,
      roots: [
        {
          kind: "window",
          children: [
            {
              kind: "tab",
              title: "One",
              url: "https://one.example/"
            }
          ]
        }
      ]
    });
    expect(await storedAutomaticBackupStatus(runtime)).toMatchObject({
      lastAttemptedBackupAt: "2026-05-19T13:20:00.000Z",
      lastSuccessfulBackupAt: "2026-05-19T13:20:00.000Z"
    });
  });

  it("disabling automatic backups clears the scheduled alarm", async () => {
    const runtime = fakeRuntime([], []);
    createBackgroundController({ api: runtime.api, now: () => Date.parse("2026-05-19T13:20:00.000Z") });

    await runtime.api.storage.local.set({
      [APP_PREFERENCES_STORAGE_KEY]: {
        ...DEFAULT_APP_PREFERENCES,
        automaticBackups: { enabled: true }
      }
    });
    await runtime.events.storageChanged.flush();
    runtime.downloads.length = 0;

    await runtime.api.storage.local.set({
      [APP_PREFERENCES_STORAGE_KEY]: {
        ...DEFAULT_APP_PREFERENCES,
        automaticBackups: { enabled: false }
      }
    });
    await runtime.events.storageChanged.flush();

    expect(runtime.alarms.has(AUTOMATIC_BACKUP_ALARM_NAME)).toBe(false);
    expect(runtime.downloads).toHaveLength(0);
    expect(runtime.api.alarms.clear).toHaveBeenCalledWith(AUTOMATIC_BACKUP_ALARM_NAME);
  });

  it("recreates automatic backup alarms on startup", async () => {
    const runtime = fakeRuntime([], [], {
      initialStorage: {
        [APP_PREFERENCES_STORAGE_KEY]: {
          ...DEFAULT_APP_PREFERENCES,
          automaticBackups: { enabled: true }
        },
        [AUTOMATIC_BACKUP_STATUS_STORAGE_KEY]: {
          lastSuccessfulBackupAt: "2026-05-19T12:30:00.000Z"
        }
      }
    });
    createBackgroundController({ api: runtime.api, now: () => Date.parse("2026-05-19T13:20:00.000Z") });

    await runtime.events.startup.emit();

    expect(runtime.alarms.get(AUTOMATIC_BACKUP_ALARM_NAME)).toMatchObject({
      name: AUTOMATIC_BACKUP_ALARM_NAME,
      periodInMinutes: 1440
    });
    expect(runtime.downloads).toHaveLength(0);
  });

  it("runs one catch-up automatic backup on startup when the last success is stale", async () => {
    const runtime = fakeRuntime([], [], {
      initialStorage: {
        [APP_PREFERENCES_STORAGE_KEY]: {
          ...DEFAULT_APP_PREFERENCES,
          automaticBackups: { enabled: true }
        },
        [AUTOMATIC_BACKUP_STATUS_STORAGE_KEY]: {
          lastSuccessfulBackupAt: "2026-05-18T13:19:59.000Z"
        }
      }
    });
    createBackgroundController({ api: runtime.api, now: () => Date.parse("2026-05-19T13:20:00.000Z") });

    await runtime.events.startup.emit();

    expect(runtime.downloads).toHaveLength(1);
    expect(await storedAutomaticBackupStatus(runtime)).toMatchObject({
      lastSuccessfulBackupAt: "2026-05-19T13:20:00.000Z"
    });
  });

  it("exports on automatic backup alarm fires and records download failures", async () => {
    const now = Date.parse("2026-05-19T13:20:00.000Z");
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ],
      {
        initialStorage: {
          [APP_PREFERENCES_STORAGE_KEY]: {
            ...DEFAULT_APP_PREFERENCES,
            automaticBackups: { enabled: true }
          }
        }
      }
    );
    createBackgroundController({ api: runtime.api, now: () => now });
    await runtime.events.startup.emit();
    runtime.downloads.length = 0;

    await runtime.events.alarm.emit({
      name: AUTOMATIC_BACKUP_ALARM_NAME,
      scheduledTime: now,
      periodInMinutes: 1440
    });

    expect(runtime.downloads).toHaveLength(1);
    expect(JSON.parse(runtime.downloads[0]!.body ?? "{}")).toMatchObject({
      schema: PORTABLE_TREE_SCHEMA
    });

    runtime.failNextDownload(new Error("download denied"));
    await runtime.events.alarm.emit({
      name: AUTOMATIC_BACKUP_ALARM_NAME,
      scheduledTime: now,
      periodInMinutes: 1440
    });

    expect(await storedAutomaticBackupStatus(runtime)).toMatchObject({
      lastAttemptedBackupAt: "2026-05-19T13:20:00.000Z",
      lastError: "download denied"
    });
  });

  it("opens the full-size sidebar in a focused maximized popup without saving or broadcasting state", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    const result = await controller.handleMessage({ type: "openSidebarWindow" });

    expect(result).toEqual({ ok: true });
    expect(runtime.api.windows.create).toHaveBeenCalledWith({
      url: "moz-extension://extension-id/sidebar/sidebar.html",
      type: "popup",
      state: "maximized",
      focused: true
    });
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(0);
    expect(vi.mocked(runtime.api.storage.local.set)).not.toHaveBeenCalled();
  });

  it("ignores focus changes from the tracked full-size sidebar popup", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.handleMessage({ type: "openSidebarWindow" });
    const popupWindowId = runtime.windows.find((windowInfo) => windowInfo.type === "popup")?.id;
    if (typeof popupWindowId !== "number") {
      throw new Error("Expected popup window to be created");
    }
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    await runtime.events.windowFocusChanged.emit(popupWindowId);
    const state = await controller.handleMessage({ type: "getState" }) as OutlineState;

    expect(state.nodes["window:10"]?.active).toBe(true);
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(0);
    expect(vi.mocked(runtime.api.storage.local.set)).not.toHaveBeenCalled();
  });

  it("records opt-in performance trace entries", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });

    expect(await controller.handleMessage({ type: "setPerformanceTraceEnabled", enabled: true })).toEqual({ ok: true });
    await controller.handleMessage({ type: "getState" });
    await controller.flushPendingSaves();

    const snapshot = await controller.handleMessage({ type: "getPerformanceTrace" });
    expect(snapshot).toMatchObject({
      enabled: true
    });
    expect(traceEntryNames(snapshot)).toContain("background.runtime.message");
    expect(traceEntryNames(snapshot)).toContain("background.state.save");

    await controller.handleMessage({ type: "clearPerformanceTrace" });
    expect(await controller.handleMessage({ type: "getPerformanceTrace" })).toMatchObject({
      entries: []
    });
  });

  it("broadcasts profile start, stop, and reset controls to live sidebars", async () => {
    const runtime = fakeRuntime([], []);
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });

    expect(await controller.handleMessage({ type: "setPerformanceTraceEnabled", enabled: true })).toEqual({ ok: true });
    expect(await controller.handleMessage({ type: "getPerformanceTrace" })).toMatchObject({
      enabled: true
    });
    expect(runtime.broadcasts).toContainEqual({
      type: "setSidebarPerformanceTraceEnabled",
      enabled: true
    });

    runtime.broadcasts.length = 0;
    await controller.handleMessage({ type: "clearPerformanceTrace" });
    expect(runtime.broadcasts).toContainEqual({
      type: "clearSidebarPerformanceTrace"
    });
    expect(await controller.handleMessage({ type: "getPerformanceTrace" })).toMatchObject({
      enabled: true,
      entries: []
    });

    runtime.broadcasts.length = 0;
    expect(await controller.handleMessage({ type: "setPerformanceTraceEnabled", enabled: false })).toEqual({ ok: true });
    expect(await controller.handleMessage({ type: "getPerformanceTrace" })).toMatchObject({
      enabled: false
    });
    expect(runtime.broadcasts).toContainEqual({
      type: "setSidebarPerformanceTraceEnabled",
      enabled: false
    });
  });

  it("returns a combined performance profile with all labeled sidebar snapshots", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime(
        [
          {
            id: 10,
            focused: true,
            incognito: false
          }
        ],
        [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://one.example/",
            title: "One"
          }
        ]
      );
      const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });

      await controller.handleMessage({ type: "setPerformanceTraceEnabled", enabled: true });
      await controller.handleMessage({ type: "getState" });
      await controller.flushPendingSaves();
      runtime.broadcasts.length = 0;

      const profilePromise = controller.handleMessage({ type: "getPerformanceProfile" });
      const collectRequest = runtime.broadcasts.find((message) =>
        typeof message === "object" &&
          message &&
          (message as { type?: unknown }).type === "collectSidebarPerformanceTrace"
      ) as { requestId?: string } | undefined;
      expect(collectRequest?.requestId).toEqual(expect.any(String));

      const firstSidebar = {
        id: "sidebar-window-10",
        label: "Sidebar window 10",
        windowId: 10,
        snapshot: {
          enabled: true,
          maxEntries: 500,
          entries: [
            {
              source: "sidebar",
              name: "sidebar.render",
              atMs: 2000,
              durationMs: 6
            }
          ]
        }
      };
      const secondSidebar = {
        id: "sidebar-window-20",
        label: "Sidebar window 20",
        windowId: 20,
        snapshot: {
          enabled: true,
          maxEntries: 500,
          entries: [
            {
              source: "sidebar",
              name: "sidebar.patch.treeStructure",
              atMs: 2100,
              durationMs: 4
            }
          ]
        }
      };

      await controller.handleMessage({
        type: "sidebarPerformanceTraceCollected",
        requestId: collectRequest!.requestId,
        sidebar: firstSidebar
      });
      await controller.handleMessage({
        type: "sidebarPerformanceTraceCollected",
        requestId: collectRequest!.requestId,
        sidebar: secondSidebar
      });
      await vi.advanceTimersByTimeAsync(1000);

      expect(await profilePromise).toMatchObject({
        background: {
          enabled: true
        },
        sidebars: [
          firstSidebar,
          secondSidebar
        ]
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not save during startup when stored state already matches runtime", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const firstController = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await firstController.ensureState();
    await firstController.flushPendingSaves();
    vi.mocked(runtime.api.storage.local.set).mockClear();

    const secondController = createBackgroundController({ api: runtime.api, now: () => 2000 });
    await secondController.ensureState();

    expect(vi.mocked(runtime.api.storage.local.set)).not.toHaveBeenCalled();
  });

  it("does not clone the persisted v3 node table before returning a matching closed-heavy startup state", async () => {
    const storedState = wideClosedTabState(300);
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [],
      { initialStorage: outlineStateV3Changes(storedState).setItems }
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    const { calls, value: state } = await countNodeTableObjectEntries(() => controller.ensureState());

    expect(state.nodes["tab:300"]?.title).toBe("Saved 300");
    expect(calls).toBe(0);
  });

  it("reuses the matching startup lookup while warming the runtime index", async () => {
    const storedState = wideClosedTabState(300);
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [],
      { initialStorage: outlineStateV3Changes(storedState).setItems }
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    const { calls, value: state } = await countNodeTableObjectValues(() => controller.ensureState());

    expect(state.nodes["tab:300"]?.title).toBe("Saved 300");
    expect(calls).toBeLessThanOrEqual(1);
    expect(controller.__debugRuntimeIndexStatus()).toEqual({ warm: true, matchesState: true, reason: "" });
  });

  it("defers fresh bootstrap persistence until an explicit save flush", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });

    const state = await controller.ensureState();

    expect(state.nodes["tab:1"]?.title).toBe("One");
    expect(vi.mocked(runtime.api.storage.local.set)).not.toHaveBeenCalled();

    await controller.flushPendingSaves();

    expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
  });

  it("eventually persists repaired startup state without blocking initialization", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const firstController = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await firstController.ensureState();
    await firstController.flushPendingSaves();

    runtime.tabs.push({
      id: 2,
      windowId: 10,
      index: 1,
      active: false,
      url: "https://two.example/",
      title: "Two"
    });
    vi.mocked(runtime.api.storage.local.set).mockClear();

    const secondController = createBackgroundController({ api: runtime.api, now: () => 2000 });
    const state = await secondController.ensureState();

    expect(state.nodes["tab:2"]?.title).toBe("Two");
    expect(vi.mocked(runtime.api.storage.local.set)).not.toHaveBeenCalled();

    await secondController.flushPendingSaves();

    expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
  });

  it("serves an initial tree snapshot from v2 storage without full runtime startup", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      Array.from({ length: 300 }, (_value, index) => ({
        id: index + 1,
        windowId: 10,
        index,
        active: index === 0,
        url: `https://example.test/${index + 1}`,
        title: `Tab ${index + 1}`
      }))
    );
    const seeded = createBackgroundController({ api: runtime.api, now: () => 1000 });
    const fullState = await seeded.ensureState();
    await runtime.api.storage.local.set(outlineStateV2Items(fullState, { revision: 321 }));
    vi.mocked(runtime.api.storage.local.get).mockClear();
    vi.mocked(runtime.api.windows.getAll).mockClear();
    vi.mocked(runtime.api.tabs.query).mockClear();

    const controller = createBackgroundController({ api: runtime.api, now: () => 2000 });
    const snapshot = await controller.handleMessage({ type: "getInitialTreeSnapshot" }) as
      | {
          type?: string;
          revision?: number;
          hydrating?: boolean;
          state?: OutlineState;
          projection?: { rows?: unknown[]; nodeCount?: number };
        }
      | undefined;

    expect(snapshot?.type).toBe("initialTreeSnapshot");
    expect(snapshot?.revision).toBe(321);
    expect(snapshot?.hydrating).toBe(true);
    expect(snapshot?.projection?.rows).toHaveLength(256);
    expect(snapshot?.projection?.nodeCount).toBe(301);
    expect(Object.keys(snapshot?.state?.nodes ?? {})).toHaveLength(256);
    expect(runtime.api.storage.local.get).toHaveBeenCalledWith(["outlineState:v3:manifest", "outlineState:v2:manifest"]);
    expect(runtime.api.windows.getAll).not.toHaveBeenCalled();
    expect(runtime.api.tabs.query).not.toHaveBeenCalled();
    await waitForMacrotask();
    expect(runtime.api.windows.getAll).not.toHaveBeenCalled();
    expect(runtime.api.tabs.query).not.toHaveBeenCalled();

    const hydrated = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(Object.keys(hydrated.nodes)).toHaveLength(301);
    expect(hydrated).toEqual(fullState);
  });

  it("serves a bounded initial tree snapshot when the background state is already warm", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      Array.from({ length: 800 }, (_value, index) => ({
        id: index + 1,
        windowId: 10,
        index,
        active: index === 799,
        url: `https://example.test/${index + 1}`,
        title: `Tab ${index + 1}`
      }))
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    vi.mocked(runtime.api.storage.local.get).mockClear();
    vi.mocked(runtime.api.windows.getAll).mockClear();
    vi.mocked(runtime.api.tabs.query).mockClear();

    const snapshot = await controller.handleMessage({ type: "getInitialTreeSnapshot" }) as
      | {
          type?: string;
          hydrating?: boolean;
          state?: OutlineState;
          projection?: {
            rows?: Array<{ nodeId?: string; index?: number }>;
            activeTabNodeId?: string;
            activeTabRowIndex?: number;
            totalRowCount?: number;
          };
        }
      | undefined;

    expect(snapshot?.type).toBe("initialTreeSnapshot");
    expect(snapshot?.hydrating).toBe(true);
    expect(snapshot?.projection?.rows).toHaveLength(256);
    expect(snapshot?.projection?.totalRowCount).toBe(801);
    expect(snapshot?.projection?.activeTabNodeId).toBe("tab:800");
    expect(snapshot?.projection?.activeTabRowIndex).toBe(800);
    expect(snapshot?.projection?.rows?.some((row) => row.nodeId === "tab:800")).toBe(true);
    expect(Object.keys(snapshot?.state?.nodes ?? {})).toHaveLength(256);
    expect(runtime.api.storage.local.get).not.toHaveBeenCalled();
    expect(runtime.api.windows.getAll).not.toHaveBeenCalled();
    expect(runtime.api.tabs.query).not.toHaveBeenCalled();
  });

  it("warms undo history after the initial tree snapshot before the first structural command", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });

    await controller.handleMessage({ type: "getInitialTreeSnapshot" });
    await waitForMacrotask();
    vi.mocked(runtime.api.storage.local.get).mockClear();

    await controller.handleMessage({ type: "deleteNode", nodeId: "tab:2" });

    const historyReads = vi.mocked(runtime.api.storage.local.get).mock.calls.filter(([key]) => key === HISTORY_KEY);
    expect(historyReads).toHaveLength(0);
  });

  it("does not wait for storage persistence before acknowledging a patched command", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.flushPendingSaves();
    vi.mocked(runtime.api.storage.local.set).mockClear();
    runtime.broadcasts.length = 0;

    let finishSave: () => void = () => undefined;
    vi.mocked(runtime.api.storage.local.set).mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finishSave = resolve;
      })
    );

    const response = await controller.handleMessage({ type: "toggleCollapsed", nodeId: "window:10" });

    expectCommandAck(response, true);
    expect(runtime.broadcasts.at(-1)).toMatchObject({
      type: "nodeStateUpdated"
    });
    expect(vi.mocked(runtime.api.storage.local.set)).not.toHaveBeenCalled();

    const flush = controller.flushPendingSaves();
    expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
    finishSave();
    await flush;
  });

  it("does not wait for sidebar broadcasts before acknowledging repeated structural commands", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.flushPendingSaves();
    runtime.broadcasts.length = 0;

    const blockedTreePatch = deferred<unknown>();
    vi.mocked(runtime.api.runtime.sendMessage).mockImplementation(async (message: unknown) => {
      runtime.broadcasts.push(message);
      if ((message as { type?: unknown }).type === "treeStructureUpdated") {
        return blockedTreePatch.promise;
      }
      return undefined;
    });

    const first = await Promise.race([
      controller.handleMessage({ type: "wrapNodeInGroup", nodeId: "tab:1" }),
      waitForMacrotask().then(() => "blocked")
    ]);
    const second = await Promise.race([
      controller.handleMessage({ type: "wrapNodeInGroup", nodeId: "tab:1" }),
      waitForMacrotask().then(() => "blocked")
    ]);

    expectCommandAck(first, true);
    expectCommandAck(second, true);
    expect(stateBroadcasts(runtime.broadcasts).filter((message) =>
      (message as { type?: unknown }).type === "treeStructureUpdated"
    )).toHaveLength(2);
  });

  it("flushes repeated structural command saves against the persisted v3 baseline", async () => {
    const tabCount = 1500;
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      Array.from({ length: tabCount }, (_value, index) => ({
        id: index + 1,
        windowId: 10,
        index,
        active: index === 0,
        url: `https://baseline.example/${index + 1}`,
        title: `Tab ${index + 1}`
      }))
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.flushPendingSaves();
    vi.mocked(runtime.api.storage.local.set).mockClear();

    await controller.handleMessage({
      type: "moveNode",
      nodeId: `tab:${tabCount}`,
      parentId: "window:10",
      index: 0
    });
    await controller.flushPendingSaves();

    const saved = vi.mocked(runtime.api.storage.local.set).mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    const savedKeys = Object.keys(saved ?? {});
    expect(savedKeys).toContain("outlineState:v3:manifest");
    expect(savedKeys.filter((key) => key.includes(":nodes:"))).toHaveLength(0);
    expect(savedKeys.filter((key) => key.includes(":order:")).length).toBeGreaterThan(0);
    expect(savedKeys.length).toBeLessThan(10);
  });

  it("waits for a quiet period before flushing deferred state saves", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime(
        [
          {
            id: 10,
            focused: true,
            incognito: false
          }
        ],
        [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://one.example/",
            title: "One"
          }
        ]
      );
      const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
      await controller.ensureState();
      vi.mocked(runtime.api.storage.local.set).mockClear();

      await controller.handleMessage({ type: "toggleCollapsed", nodeId: "window:10" });
      await vi.advanceTimersByTimeAsync(999);

      expect(vi.mocked(runtime.api.storage.local.set)).not.toHaveBeenCalled();

      await controller.handleMessage({ type: "toggleCollapsed", nodeId: "window:10" });
      await vi.advanceTimersByTimeAsync(999);

      expect(vi.mocked(runtime.api.storage.local.set)).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a longer quiet save delay for structural command bursts", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime(
        [
          {
            id: 10,
            focused: true,
            incognito: false
          }
        ],
        [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://one.example/",
            title: "One"
          },
          {
            id: 2,
            windowId: 10,
            index: 1,
            active: false,
            openerTabId: 1,
            url: "https://two.example/",
            title: "Two"
          }
        ]
      );
      const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
      await controller.ensureState();
      await controller.flushPendingSaves();
      vi.mocked(runtime.api.storage.local.set).mockClear();

      expectCommandAck(await controller.handleMessage({
        type: "moveNode",
        nodeId: "tab:2",
        parentId: "window:10",
        index: 0
      }), true);
      await vi.advanceTimersByTimeAsync(1000);

      expect(vi.mocked(runtime.api.storage.local.set)).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(4000);

      expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a structural save batch deferred after a later ordinary command", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime(
        [
          {
            id: 10,
            focused: true,
            incognito: false
          }
        ],
        [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://one.example/",
            title: "One"
          },
          {
            id: 2,
            windowId: 10,
            index: 1,
            active: false,
            openerTabId: 1,
            url: "https://two.example/",
            title: "Two"
          }
        ]
      );
      const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
      await controller.ensureState();
      await controller.flushPendingSaves();
      vi.mocked(runtime.api.storage.local.set).mockClear();

      expectCommandAck(await controller.handleMessage({
        type: "moveNode",
        nodeId: "tab:2",
        parentId: "window:10",
        index: 0
      }), true);
      await vi.advanceTimersByTimeAsync(1000);
      expectCommandAck(await controller.handleMessage({ type: "toggleCollapsed", nodeId: "window:10" }), true);
      await vi.advanceTimersByTimeAsync(1000);

      expect(vi.mocked(runtime.api.storage.local.set)).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(4000);

      expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a longer quiet save delay for restore commands", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          openerTabId: 1,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.handleMessage({ type: "closeNode", nodeId: "tab:2" });
    await runtime.events.tabRemoved.flush();
    await runtime.events.sessionChanged.flush();
    await controller.flushPendingSaves();

    const restoredTab: RuntimeTab = {
      id: 22,
      windowId: 10,
      index: 1,
      active: false,
      url: "https://two.example/",
      title: "Two"
    };
    vi.mocked(runtime.api.sessions.restore).mockResolvedValue({ tab: copyTab(restoredTab) } as never);

    vi.useFakeTimers();
    try {
      vi.mocked(runtime.api.storage.local.set).mockClear();

      expectCommandAck(await controller.handleMessage({ type: "restoreNode", nodeId: "tab:2" }), true);
      await vi.advanceTimersByTimeAsync(1000);

      expect(vi.mocked(runtime.api.storage.local.set)).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(4000);

      expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a longer quiet save delay for structural undo and redo", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime(
        [
          {
            id: 10,
            focused: true,
            incognito: false
          }
        ],
        [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://one.example/",
            title: "One"
          },
          {
            id: 2,
            windowId: 10,
            index: 1,
            active: false,
            openerTabId: 1,
            url: "https://two.example/",
            title: "Two"
          }
        ]
      );
      const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
      await controller.ensureState();
      await controller.flushPendingSaves();
      vi.mocked(runtime.api.storage.local.set).mockClear();

      expectCommandAck(await controller.handleMessage({
        type: "moveNode",
        nodeId: "tab:2",
        parentId: "window:10",
        index: 0
      }), true);
      await controller.flushPendingSaves();
      vi.mocked(runtime.api.storage.local.set).mockClear();

      expectCommandAck(await controller.handleMessage({ type: "undo" }), true);
      await vi.advanceTimersByTimeAsync(1000);

      expect(vi.mocked(runtime.api.storage.local.set)).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(4000);

      expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);

      vi.mocked(runtime.api.storage.local.set).mockClear();

      expectCommandAck(await controller.handleMessage({ type: "redo" }), true);
      await vi.advanceTimersByTimeAsync(1000);

      expect(vi.mocked(runtime.api.storage.local.set)).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(4000);

      expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts the quiet timer instead of immediately draining saves queued during an in-flight save", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime(
        [
          {
            id: 10,
            focused: true,
            incognito: false
          }
        ],
        [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://one.example/",
            title: "One"
          }
        ]
      );
      const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
      await controller.ensureState();
      await controller.flushPendingSaves();
      vi.mocked(runtime.api.storage.local.set).mockClear();

      const firstSave = deferred<void>();
      const saveImplementation = vi.mocked(runtime.api.storage.local.set).getMockImplementation();
      vi.mocked(runtime.api.storage.local.set).mockImplementationOnce(async (items: Record<string, unknown>) => {
        await firstSave.promise;
        await saveImplementation?.(items);
      });

      await controller.handleMessage({ type: "toggleCollapsed", nodeId: "window:10" });
      await vi.advanceTimersByTimeAsync(1000);

      expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);

      await controller.handleMessage({ type: "toggleCollapsed", nodeId: "window:10" });
      firstSave.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces concurrent diagnostics requests across sidebar contexts", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    vi.mocked(runtime.api.windows.getAll).mockClear();

    const diagnostics = await Promise.all(
      Array.from({ length: 7 }, () => controller.handleMessage({ type: "getDiagnostics" }))
    );

    expect(diagnostics).toHaveLength(7);
    expect(runtime.api.windows.getAll).toHaveBeenCalledTimes(1);
  });

  it("rebroadcasts sidebar non-edit interaction notices", async () => {
    const runtime = fakeRuntime([], []);
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });

    await expect(controller.handleMessage({ type: "sidebarNonEditInteraction" })).resolves.toEqual({ ok: true });

    expect(runtime.broadcasts).toEqual([{ type: "sidebarNonEditInteraction" }]);
  });

  it("adds new tab events without closing existing tabs when query is stale", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await createTabFromBrowser(runtime, {
      id: 2,
      windowId: 10,
      index: 1,
      active: true,
      url: "about:newtab",
      title: "New Tab"
    }, { queryLag: true });

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(liveTabIds(state)).toEqual([1, 2]);
    expect(state.nodes["tab:1"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.title).toBe("New Tab");
  });

  it("coalesces noisy new-tab event bursts into one runtime refresh", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          url: "https://three.example/",
          title: "Three"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    const newTab: RuntimeTab = {
      id: 4,
      windowId: 10,
      index: 3,
      active: true,
      url: "about:newtab",
      title: "New Tab"
    };
    await createTabFromBrowser(runtime, newTab, { awaitListeners: false });
    await updateTabFromBrowser(runtime, 4, { title: "Loading" }, { awaitListeners: false });
    await updateTabFromBrowser(runtime, 4, {
      title: "Opened",
      url: "https://opened.example/"
    }, { awaitListeners: false });
    runtime.events.tabActivated.dispatch({ tabId: 4, windowId: 10, previousTabId: 1 });

    await Promise.all([
      runtime.events.tabCreated.flush(),
      runtime.events.tabUpdated.flush(),
      runtime.events.tabActivated.flush()
    ]);

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(1);
    expect(runtime.broadcasts.at(-1)).toMatchObject({
      type: "treeStructureUpdated"
    });
    await controller.flushPendingSaves();
    expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
    expect(state.nodes["tab:4"]?.title).toBe("Opened");
    expect(state.nodes["tab:4"]?.url).toBe("https://opened.example/");
    expect(state.nodes["tab:4"]?.active).toBe(true);
    expect(state.nodes["tab:1"]?.active).toBe(false);
  });

  it("waits for pending runtime refreshes before returning state", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    createTabFromBrowser(runtime, {
      id: 2,
      windowId: 10,
      index: 1,
      active: true,
      url: "about:newtab",
      title: "New Tab"
    }, { awaitListeners: false });

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expect(state.nodes["tab:2"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.active).toBe(true);
  });

  it("runs user commands before queued runtime refreshes", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const focusStarted = deferred();
    const releaseFocus = deferred();
    const adapter: BrowserAdapter = {
      focusTab: vi.fn(async () => {
        focusStarted.resolve();
        await releaseFocus.promise;
      }),
      closeTab: vi.fn(async () => undefined),
      closeTabs: vi.fn(async () => undefined),
      closeWindow: vi.fn(async () => undefined),
      restoreSession: vi.fn(async () => ({})),
      createTab: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      createWindow: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      moveTabs: vi.fn(async () => undefined)
    };
    const controller = createBackgroundController({ api: runtime.api, adapter, now: () => 1000 });
    await controller.ensureState();
    runtime.broadcasts.length = 0;

    const focusPromise = controller.handleMessage({ type: "focusNode", nodeId: "tab:2" });
    await focusStarted.promise;
    await updateTabFromBrowser(runtime, 1, { title: "One from runtime" }, { awaitListeners: false });
    await waitForMacrotask();
    const renamePromise = controller.handleMessage({
      type: "renameGroup",
      nodeId: "window:10",
      title: "Renamed"
    });
    await waitForMacrotask();

    expect(runtime.broadcasts).toHaveLength(0);
    releaseFocus.resolve();
    await Promise.all([
      focusPromise,
      renamePromise,
      runtime.events.tabUpdated.flush()
    ]);

    const broadcasts = stateBroadcasts(runtime.broadcasts) as Array<{
      type?: string;
      updatedNodes?: Array<{ id: string }>;
    }>;
    const windowRenameIndex = broadcasts.findIndex((message) =>
      message.updatedNodes?.some((node) => node.id === "window:10")
    );
    const runtimeUpdateIndex = broadcasts.findIndex((message) =>
      message.updatedNodes?.some((node) => node.id === "tab:1")
    );
    expect(windowRenameIndex).toBeGreaterThanOrEqual(0);
    expect(runtimeUpdateIndex).toBeGreaterThanOrEqual(0);
    expect(windowRenameIndex).toBeLessThan(runtimeUpdateIndex);
  });

  it("merges runtime events into one trailing refresh while a refresh is in flight", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    runtime.broadcasts.length = 0;

    const firstSnapshotStarted = deferred();
    const releaseFirstSnapshot = deferred();
    const originalGetAll = vi.mocked(runtime.api.windows.getAll).getMockImplementation();
    let getAllCalls = 0;
    vi.mocked(runtime.api.windows.getAll).mockImplementation(async (getInfo = {}) => {
      getAllCalls += 1;
      if (getAllCalls === 1) {
        const snapshot = runtimeWindowSnapshot(runtime, getInfo);
        firstSnapshotStarted.resolve();
        await releaseFirstSnapshot.promise;
        return snapshot;
      }
      return originalGetAll?.(getInfo) ?? [];
    });

    runtime.tabs = runtime.tabs.map((tab) => tab.windowId === 10
      ? { ...tab, active: tab.id === 2 }
      : copyTab(tab));
    runtime.events.tabActivated.dispatch({ tabId: 2, windowId: 10, previousTabId: 1 });
    await firstSnapshotStarted.promise;
    await updateTabFromBrowser(runtime, 2, { title: "Two loading" }, { awaitListeners: false });
    await waitForMacrotask();
    await updateTabFromBrowser(runtime, 2, {
      title: "Two final",
      url: "https://two.example/final"
    }, { awaitListeners: false });

    releaseFirstSnapshot.resolve();
    await Promise.all([
      runtime.events.tabActivated.flush(),
      runtime.events.tabUpdated.flush()
    ]);
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expect(state.nodes["tab:2"]?.title).toBe("Two final");
    expect(state.nodes["tab:2"]?.url).toBe("https://two.example/final");
    expect(stateBroadcasts(runtime.broadcasts).length).toBeLessThanOrEqual(2);
  });

  it("does not interrupt an in-flight runtime refresh with user commands", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    runtime.broadcasts.length = 0;

    const firstSnapshotStarted = deferred();
    const releaseFirstSnapshot = deferred();
    const originalGetAll = vi.mocked(runtime.api.windows.getAll).getMockImplementation();
    let getAllCalls = 0;
    vi.mocked(runtime.api.windows.getAll).mockImplementation(async (getInfo = {}) => {
      getAllCalls += 1;
      if (getAllCalls === 1) {
        const snapshot = runtimeWindowSnapshot(runtime, getInfo);
        firstSnapshotStarted.resolve();
        await releaseFirstSnapshot.promise;
        return snapshot;
      }
      return originalGetAll?.(getInfo) ?? [];
    });

    runtime.tabs = runtime.tabs.map((tab) => tab.windowId === 10
      ? { ...tab, active: tab.id === 2 }
      : copyTab(tab));
    runtime.events.tabActivated.dispatch({ tabId: 2, windowId: 10, previousTabId: 1 });
    await firstSnapshotStarted.promise;
    const renamePromise = controller.handleMessage({
      type: "renameGroup",
      nodeId: "window:10",
      title: "Renamed while refresh runs"
    });
    await waitForMacrotask();

    expect(runtime.broadcasts).toHaveLength(0);
    releaseFirstSnapshot.resolve();
    await Promise.all([
      runtime.events.tabActivated.flush(),
      renamePromise
    ]);
    expect(runtime.broadcasts.some((message) =>
      (message as { type?: string; updatedNodes?: Array<{ id: string }> }).updatedNodes?.some((node) => node.id === "window:10")
    )).toBe(true);
  });

  it("handles browser-created same-window tab bursts without a full runtime snapshot", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    expect(await controller.handleMessage({ type: "setPerformanceTraceEnabled", enabled: true })).toEqual({ ok: true });
    await controller.handleMessage({ type: "clearPerformanceTrace" });
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.windows.get).mockClear();
    vi.mocked(runtime.api.windows.getAll).mockClear();
    vi.mocked(runtime.api.tabs.query).mockClear();
    vi.mocked(runtime.api.storage.local.set).mockClear();

    const newTab: RuntimeTab = {
      id: 2,
      windowId: 10,
      index: 1,
      active: true,
      openerTabId: 1,
      url: "about:newtab",
      title: "New Tab"
    };
    await createTabFromBrowser(runtime, newTab, { awaitListeners: false });
    await updateTabFromBrowser(runtime, 2, {
      title: "Opened",
      url: "https://opened.example/"
    }, { awaitListeners: false });
    runtime.events.tabActivated.dispatch({ tabId: 2, windowId: 10, previousTabId: 1 });

    await Promise.all([
      runtime.events.tabCreated.flush(),
      runtime.events.tabUpdated.flush(),
      runtime.events.tabActivated.flush()
    ]);
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expect(runtime.api.windows.get).not.toHaveBeenCalled();
    expect(runtime.api.windows.getAll).not.toHaveBeenCalled();
    expect(runtime.api.tabs.query).not.toHaveBeenCalled();
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(1);
    expect(runtime.broadcasts.at(-1)).toMatchObject({
      type: "treeStructureUpdated"
    });
    expect(state.nodes["tab:2"]?.title).toBe("Opened");
    expect(state.nodes["tab:2"]?.url).toBe("https://opened.example/");
    expect(state.nodes["tab:2"]?.active).toBe(true);
    expect(state.nodes["tab:1"]?.active).toBe(false);
    expect(traceEntryNames(await controller.handleMessage({ type: "getPerformanceTrace" }))).not.toContain(
      "background.patch.build.treeStructure"
    );
    expect(traceEntryNames(await controller.handleMessage({ type: "getPerformanceTrace" }))).not.toContain(
      "background.patch.build.nodeState"
    );
  });

  it("handles browser-created same-window tabs without reading unrelated nodes", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          url: "https://three.example/",
          title: "Three"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    const initialState = await controller.ensureState();
    runtime.broadcasts.length = 0;

    const { reads: unrelatedNodeReads } = await countNodePropertyReads(initialState, ["tab:2", "tab:3"], async () => {
      await createTabFromBrowser(runtime, {
        id: 4,
        windowId: 10,
        index: 3,
        active: true,
        openerTabId: 1,
        url: "about:newtab",
        title: "New Tab"
      });
    });
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expect(unrelatedNodeReads).toBe(0);
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(1);
    expect(state.nodes["tab:4"]?.parentId).toBe("tab:1");
    expect(state.nodes["tab:1"]?.active).toBe(false);
    expect(state.nodes["tab:4"]?.active).toBe(true);
  });

  it("handles browser-created focused windows with narrow window lookup and compact patch", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.windows.get).mockClear();
    vi.mocked(runtime.api.windows.getAll).mockClear();
    vi.mocked(runtime.api.tabs.query).mockClear();
    vi.mocked(runtime.api.storage.local.set).mockClear();

    runtime.windows = [
      { id: 10, focused: false, incognito: false },
      { id: 42, focused: true, incognito: false }
    ];
    await createTabFromBrowser(runtime, {
      id: 2,
      windowId: 42,
      index: 0,
      active: true,
      url: "https://new-window.example/",
      title: "New window"
    });

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const patch = runtime.broadcasts.at(-1) as
      | { type?: string; updatedNodes?: Array<{ id: string }> }
      | undefined;

    expect(runtime.api.windows.get).toHaveBeenCalledWith(42, {
      populate: false,
      windowTypes: ["normal"]
    });
    expect(runtime.api.windows.getAll).not.toHaveBeenCalled();
    expect(runtime.api.tabs.query).not.toHaveBeenCalled();
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(1);
    expect(patch?.type).toBe("treeStructureUpdated");
    expect(patch?.updatedNodes?.map((node) => node.id)).toEqual(
      expect.arrayContaining(["window:10", "window:42", "tab:2"])
    );
    expect(state.nodes["window:10"]?.active).toBe(false);
    expect(state.nodes["window:42"]?.active).toBe(true);
    expect(state.nodes["window:42"]?.childIds).toEqual(["tab:2"]);
    expect(state.nodes["tab:2"]?.active).toBe(true);
  });

  it("broadcasts runtime tab metadata refreshes as node state patches", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          url: "https://three.example/",
          title: "Three"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    const initialState = await controller.ensureState();
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    const { reads: unrelatedNodeReads } = await countNodePropertyReads(initialState, ["tab:1", "tab:3"], async () => {
      await updateTabFromBrowser(runtime, 2, {
        title: "Two updated",
        url: "https://two.example/updated"
      });
    });
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expect(unrelatedNodeReads).toBe(0);
    expect(state.nodes["tab:2"]?.title).toBe("Two updated");
    expect(state.nodes["tab:2"]?.url).toBe("https://two.example/updated");
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(1);
    const lastBroadcast = runtime.broadcasts.at(-1) as
      | {
          type?: string;
          updatedNodes?: OutlineState["nodes"][string][];
          state?: OutlineState;
        }
      | undefined;
    expect(lastBroadcast?.type).toBe("nodeStateUpdated");
    expect(lastBroadcast?.updatedNodes?.map((node) => node.id)).toEqual(["tab:2"]);
    expect(lastBroadcast?.updatedNodes?.[0]).toMatchObject({
      id: "tab:2",
      title: "Two updated",
      url: "https://two.example/updated"
    });
    expect(lastBroadcast?.state).toBeUndefined();
    await controller.flushPendingSaves();
    expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
  });

  it("ignores tab update events without outline-relevant changes", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    await runtime.events.tabUpdated.emit(1, {}, {
      id: 1,
      windowId: 10,
      index: 0,
      active: true,
      url: "https://one.example/",
      title: "One"
    });
    await runtime.events.tabUpdated.emit(1, { status: "loading" } as Partial<RuntimeTab>, {
      id: 1,
      windowId: 10,
      index: 0,
      active: true,
      url: "https://one.example/",
      title: "One"
    });

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expect(runtime.broadcasts).toHaveLength(0);
    expect(vi.mocked(runtime.api.storage.local.set)).not.toHaveBeenCalled();
    expect(state.nodes["tab:1"]?.title).toBe("One");
  });

  it("ignores outline-relevant tab update events that leave state unchanged", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One",
          favIconUrl: "https://one.example/favicon.ico"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    await runtime.events.tabUpdated.emit(1, {
      title: "One",
      url: "https://one.example/",
      favIconUrl: "https://one.example/favicon.ico"
    }, {
      id: 1,
      windowId: 10,
      index: 0,
      active: true,
      url: "https://one.example/",
      title: "One",
      favIconUrl: "https://one.example/favicon.ico"
    });

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expect(runtime.broadcasts).toHaveLength(0);
    expect(vi.mocked(runtime.api.storage.local.set)).not.toHaveBeenCalled();
    expect(state.nodes["tab:1"]?.title).toBe("One");
  });

  it("serializes concurrent tab create events against the freshest state", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await Promise.all([
      createTabFromBrowser(runtime, {
        id: 2,
        windowId: 10,
        index: 1,
        active: false,
        url: "about:newtab",
        title: "New Tab"
      }),
      createTabFromBrowser(runtime, {
        id: 3,
        windowId: 10,
        index: 2,
        active: true,
        url: "about:newtab",
        title: "New Tab"
      })
    ]);

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(liveTabIds(state)).toEqual([1, 2, 3]);
  });

  it("updates active tab state from activation events", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await activateTabFromBrowser(runtime, 2);

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:1"]?.active).toBe(false);
    expect(state.nodes["tab:2"]?.active).toBe(true);
  });

  it("absorbs focus command activation echoes without a full runtime snapshot", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    const initialState = await controller.ensureState();
    vi.mocked(runtime.api.tabs.query).mockClear();
    vi.mocked(runtime.api.windows.getAll).mockClear();
    vi.mocked(runtime.api.storage.local.set).mockClear();
    runtime.broadcasts.length = 0;

    const result = await controller.handleMessage({ type: "focusNode", nodeId: "tab:2" });
    const { calls } = await countNodeTableObjectValues(async () => {
      await runtime.events.tabUpdated.flush();
      await runtime.events.windowFocusChanged.flush();
      await runtime.events.tabActivated.emit({ tabId: 2, windowId: 10, previousTabId: 1 });
    }, initialState.nodes);

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const lastBroadcast = runtime.broadcasts.at(-1) as
      | { type?: string; updates?: Array<{ nodeId: string; active: boolean }> }
      | undefined;
    expectCommandAck(result, false);
    expect(state.nodes["tab:1"]?.active).toBe(false);
    expect(state.nodes["tab:2"]?.active).toBe(true);
    expect(runtime.api.tabs.query).not.toHaveBeenCalled();
    expect(runtime.api.windows.getAll).not.toHaveBeenCalled();
    expect(calls).toBe(0);
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(1);
    expect(lastBroadcast).toEqual({
      type: "activeStateUpdated",
      updates: [
        { nodeId: "tab:1", active: false },
        { nodeId: "tab:2", active: true }
      ]
    });
    expect(vi.mocked(runtime.api.storage.local.set)).not.toHaveBeenCalled();
  });

  it("absorbs cross-window focus command echoes without node table scans", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        },
        {
          id: 20,
          focused: false,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 20,
          index: 0,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    const initialState = await controller.ensureState();
    vi.mocked(runtime.api.tabs.query).mockClear();
    vi.mocked(runtime.api.windows.getAll).mockClear();
    vi.mocked(runtime.api.storage.local.set).mockClear();
    runtime.broadcasts.length = 0;

    const result = await controller.handleMessage({ type: "focusNode", nodeId: "tab:2" });
    const { calls } = await countNodeTableObjectValues(async () => {
      await runtime.events.windowFocusChanged.flush();
      await runtime.events.tabUpdated.flush();
      await runtime.events.tabActivated.emit({ tabId: 2, windowId: 20, previousTabId: 1 });
    }, initialState.nodes);

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expectCommandAck(result, false);
    expect(state.nodes["window:10"]?.active).toBe(false);
    expect(state.nodes["window:20"]?.active).toBe(true);
    expect(state.nodes["tab:1"]?.active).toBe(true);
    expect(state.nodes["tab:2"]?.active).toBe(true);
    expect(runtime.api.tabs.query).not.toHaveBeenCalled();
    expect(runtime.api.windows.getAll).not.toHaveBeenCalled();
    expect(calls).toBe(0);
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(2);
    expect(vi.mocked(runtime.api.storage.local.set)).not.toHaveBeenCalled();
  });

  it("uses activation snapshots to remove tabs Firefox no longer reports", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await createTabFromBrowser(runtime, {
      id: 2,
      windowId: 10,
      index: 1,
      active: true,
      openerTabId: 1,
      url: "about:newtab",
      title: "New Tab"
    });
    runtime.tabs = runtime.tabs.filter((tab) => tab.id !== 2);
    reindexWindowTabs(runtime, 10);
    await activateTabFromBrowser(runtime, 1);

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(runtime.tabs.map((tab) => tab.id)).toEqual([1]);
    expect(state.nodes["tab:2"]).toBeUndefined();
    expect(state.nodes["tab:1"]?.active).toBe(true);
    expect(state.nodes["tab:1"]?.childIds).toEqual([]);
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:1"]);
  });

  it("does not resurrect a removed tab from a stale activation snapshot", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    const closedTab: RuntimeTab = {
      id: 2,
      windowId: 10,
      index: 1,
      active: true,
      openerTabId: 1,
      url: "about:newtab",
      title: "New Tab"
    };
    await createTabFromBrowser(runtime, closedTab);
    await closeTabFromBrowser(runtime, 2, "tabRemovedOnly");

    runtime.setNextTabQueryResult([
      {
        ...runtime.tabs[0]!,
        active: true
      },
      closedTab
    ]);
    await activateTabFromBrowser(runtime, 1);

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(runtime.tabs.map((tab) => tab.id)).toEqual([1]);
    expect(state.nodes["tab:2"]).toBeUndefined();
    expect(state.nodes["tab:1"]?.childIds).toEqual([]);
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:1"]);
  });

  it("does not resurrect the last removed tab from a stale full snapshot after closing many", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    const openedTabs: RuntimeTab[] = [2, 3, 4].map((id, index) => ({
      id,
      windowId: 10,
      index: index + 1,
      active: id === 4,
      openerTabId: id === 2 ? 1 : id - 1,
      url: "about:newtab",
      title: "New Tab"
    }));
    for (const tab of openedTabs) {
      await createTabFromBrowser(runtime, tab);
    }
    await closeTabFromBrowser(runtime, 4, "tabRemovedOnly");
    await closeTabFromBrowser(runtime, 3, "tabRemovedOnly");
    await closeTabFromBrowser(runtime, 2, "tabRemovedOnly");

    runtime.setNextTabQueryResult([
      {
        ...runtime.tabs[0]!,
        active: true
      },
      openedTabs[2]!
    ]);
    await activateTabFromBrowser(runtime, 1);

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(runtime.tabs.map((tab) => tab.id)).toEqual([1]);
    expect(state.nodes["tab:2"]).toBeUndefined();
    expect(state.nodes["tab:3"]).toBeUndefined();
    expect(state.nodes["tab:4"]).toBeUndefined();
    expect(state.nodes["tab:1"]?.childIds).toEqual([]);
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:1"]);
  });

  it("preserves lifecycle invariants across generated Firefox-like traces", async () => {
    const config = generatedTraceConfig({
      defaultSeedCount: 24,
      defaultSteps: 32,
      soakSeedCount: 96,
      soakSteps: 96
    });
    for (const seed of config.seeds) {
      await runGeneratedTrace(seed, config.steps);
    }
  }, generatedTraceTimeoutMs(10_000, 120_000));

  it("preserves invariants across adversarial runtime query skew traces", async () => {
    const config = generatedTraceConfig({
      defaultSeedCount: 12,
      defaultSteps: 40,
      soakSeedCount: 64,
      soakSteps: 96
    });
    for (const seed of config.seeds) {
      await runGeneratedTrace(seed + 100, config.steps, { adversarialRuntimeQueries: true });
    }
  }, generatedTraceTimeoutMs(10_000, 120_000));

  it("preserves invariants across adversarial runtime concurrency traces", async () => {
    const config = generatedTraceConfig({
      defaultSeedCount: 4,
      defaultSteps: 30,
      soakSeedCount: 20,
      soakSteps: 100
    });
    for (const seed of config.seeds) {
      await runGeneratedTrace(seed, config.steps, {
        adversarialRuntimeQueries: true,
        adversarialConcurrency: true
      });
    }
  }, generatedTraceTimeoutMs(10_000, 120_000));

  const domainTraceIt = process.env.RUNTIME_DOMAIN_TRACE_HUNT === "1" || process.env.RUNTIME_TRACE_HUNT_TRACE_IDS
    ? it
    : it.skip;
  domainTraceIt("preserves invariants across adversarial runtime domain traces", async () => {
    for (const trace of selectedRuntimeDomainTraces()) {
      await runDomainTrace(trace);
    }
  }, generatedTraceTimeoutMs(10_000, 120_000));

  it("preserves invariants across known runtime domain regression traces", async () => {
    for (const trace of runtimeDomainRegressionTraces()) {
      await runDomainTrace(trace);
    }
  }, generatedTraceTimeoutMs(10_000, 120_000));

  it("preserves lifecycle invariants across a generated live-tab grouping trace", async () => {
    await runGeneratedGroupingTrace();
  });

  it("keeps grouped child tabs nested when a stale pre-grouping tab update arrives", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          openerTabId: 1,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          url: "https://three.example/",
          title: "Three"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await controller.handleMessage({ type: "wrapNodeInGroup", nodeId: "tab:1" });
    const grouped = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const wrapperId = grouped.nodes["tab:1"]?.parentId;
    expect(wrapperId).toMatch(/^window:/);
    if (!wrapperId) {
      throw new Error("Expected tab:1 to be wrapped in a live window");
    }
    const wrapperWindowId = grouped.nodes[wrapperId]?.live?.windowId;
    expect(grouped.nodes["tab:2"]?.parentId).toBe("tab:1");

    await runtime.events.tabUpdated.emit(2, { title: "Stale child update" }, {
      id: 2,
      windowId: 10,
      index: 1,
      active: false,
      openerTabId: 1,
      url: "https://two.example/",
      title: "Stale child update"
    });

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.rootIds).toEqual(["window:10"]);
    expect(state.nodes["window:10"]?.childIds).toEqual([wrapperId, "tab:3"]);
    expect(state.nodes[wrapperId]?.childIds).toEqual(["tab:1"]);
    expect(state.nodes["tab:1"]?.childIds).toEqual(["tab:2"]);
    expect(state.nodes["tab:2"]?.parentId).toBe("tab:1");
    expect(state.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: wrapperWindowId });
  });

  it("keeps a moved-out live group in place when it is closed after grouping", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    vi.mocked(runtime.api.sessions.getRecentlyClosed).mockResolvedValue([
      { window: { sessionId: "session-window-group" } } as never
    ]);
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.flushPendingSaves();
    const staleGroupedTab = copyTab(runtime.tabs.find((tab) => tab.id === 1)!);
    let state: OutlineState;

    await controller.handleMessage({ type: "wrapNodeInGroup", nodeId: "window:10" });
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const originalGroupId = state.nodes["window:10"]?.parentId;
    expect(originalGroupId).toMatch(/^group:/);
    if (!originalGroupId) {
      throw new Error("Expected window:10 to be inside an outline group");
    }

    await controller.handleMessage({ type: "wrapNodeInGroup", nodeId: "tab:1" });
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const wrapperId = state.nodes["tab:1"]?.parentId;
    expect(wrapperId).toMatch(/^window:/);
    if (!wrapperId) {
      throw new Error("Expected tab:1 to be wrapped in a live window");
    }
    expect(state.nodes["window:10"]?.childIds).toEqual([wrapperId, "tab:2"]);

    await controller.handleMessage({
      type: "moveNode",
      nodeId: wrapperId,
      index: 0
    });
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.rootIds).toEqual([wrapperId, originalGroupId]);
    expect(state.nodes[wrapperId]?.parentId).toBeUndefined();
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:2"]);
    expect(state.nodes[originalGroupId]?.childIds).toEqual(["window:10"]);

    const wrapperRuntimeWindowId = state.nodes[wrapperId]?.live?.windowId;
    if (typeof wrapperRuntimeWindowId !== "number") {
      throw new Error("Expected moved wrapper to be a live window");
    }
    await closeRuntimeWindow(runtime, wrapperRuntimeWindowId, { awaitListeners: true });
    runtime.queueTabQueryResult([...runtime.tabs, staleGroupedTab]);
    try {
      await runtime.events.tabUpdated.emit(1, { title: "Stale grouped tab update" }, {
        ...staleGroupedTab,
        title: "Stale grouped tab update"
      });
    } finally {
      runtime.clearNextTabQueryResult();
    }

    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.rootIds).toEqual([wrapperId, originalGroupId]);
    expect(state.nodes[wrapperId]).toMatchObject({
      kind: "window",
      status: "closed",
      childIds: ["tab:1"],
      restore: { sessionId: "session-window-group" }
    });
    expect(state.nodes["tab:1"]).toMatchObject({
      kind: "tab",
      status: "closed",
      parentId: wrapperId
    });
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:2"]);
    expect(state.nodes[originalGroupId]?.childIds).toEqual(["window:10"]);

    await controller.flushPendingSaves();
    const reloadedController = createBackgroundController({ api: runtime.api, now: () => 2000 });
    const reloaded = await reloadedController.ensureState();
    expect(reloaded.rootIds).toEqual([wrapperId, originalGroupId]);
    expect(reloaded.nodes[wrapperId]).toMatchObject({
      kind: "window",
      status: "closed",
      childIds: ["tab:1"]
    });
    expect(reloaded.nodes["tab:1"]?.parentId).toBe(wrapperId);
    expect(reloaded.nodes["window:10"]?.childIds).toEqual(["tab:2"]);
    expect(reloaded.nodes[originalGroupId]?.childIds).toEqual(["window:10"]);
  });

  it("preserves grouped live tabs across native parent and child window closes", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await controller.handleMessage({ type: "wrapNodeInGroup", nodeId: "tab:1" });
    let state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const wrapperId = state.nodes["tab:1"]?.parentId;
    expect(wrapperId).toMatch(/^window:/);
    if (!wrapperId) {
      throw new Error("Expected tab:1 to be wrapped in a live window");
    }
    const wrapperRuntimeWindowId = state.nodes[wrapperId]?.live?.windowId;
    if (typeof wrapperRuntimeWindowId !== "number") {
      throw new Error("Expected tab:1 wrapper to be a live window");
    }

    await closeRuntimeWindow(runtime, 10, { awaitListeners: true });
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes[wrapperId]?.parentId).toBeUndefined();
    expect(state.nodes["window:10"]?.status).toBe("closed");
    expect(state.nodes["tab:2"]?.status).toBe("closed");
    expect(state.nodes[wrapperId]?.status).toBe("live");
    expect(state.nodes["tab:1"]?.status).toBe("live");

    await closeRuntimeWindow(runtime, wrapperRuntimeWindowId, { awaitListeners: true });

    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes[wrapperId]?.status).toBe("closed");
    expect(state.nodes["tab:1"]?.status).toBe("closed");
  });

  it("keeps command-moved child tabs nested when a stale pre-move tab update arrives", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          openerTabId: 1,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          url: "https://three.example/",
          title: "Three"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await controller.handleMessage({
      type: "moveNode",
      nodeId: "tab:1",
      index: 0
    });
    const moved = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const destinationWindowId = moved.nodes["tab:1"]?.parentId;
    expect(destinationWindowId).toMatch(/^window:/);
    if (!destinationWindowId) {
      throw new Error("Expected tab:1 to be moved into a new live window");
    }
    const destinationRuntimeWindowId = moved.nodes[destinationWindowId]?.live?.windowId;
    expect(moved.nodes["tab:2"]?.parentId).toBe("tab:1");

    await runtime.events.tabUpdated.emit(2, { title: "Stale child update" }, {
      id: 2,
      windowId: 10,
      index: 1,
      active: false,
      openerTabId: 1,
      url: "https://two.example/",
      title: "Stale child update"
    });

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.rootIds).toEqual([destinationWindowId, "window:10"]);
    expect(state.nodes[destinationWindowId]?.childIds).toEqual(["tab:1"]);
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:3"]);
    expect(state.nodes["tab:1"]?.childIds).toEqual(["tab:2"]);
    expect(state.nodes["tab:2"]?.parentId).toBe("tab:1");
    expect(state.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: destinationRuntimeWindowId });
  });

  it("ignores command-relocated stale tab updates even when the tab query is stale too", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          openerTabId: 1,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          url: "https://three.example/",
          title: "Three"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    const staleChild = copyTab(runtime.tabs.find((tab) => tab.id === 2)!);

    await controller.handleMessage({
      type: "moveNode",
      nodeId: "tab:1",
      index: 0
    });
    const moved = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const destinationWindowId = moved.nodes["tab:1"]?.parentId;
    if (!destinationWindowId) {
      throw new Error("Expected tab:1 to be moved into a live window");
    }
    const destinationRuntimeWindowId = moved.nodes[destinationWindowId]?.live?.windowId;

    runtime.queueTabQueryResult(snapshotReplacingTab(runtime.tabs, staleChild));
    try {
      await runtime.events.tabUpdated.emit(2, { title: "Stale child update" }, {
        ...staleChild,
        title: "Stale child update"
      });
    } finally {
      runtime.clearNextTabQueryResult();
    }

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes[destinationWindowId]?.childIds).toEqual(["tab:1"]);
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:3"]);
    expect(state.nodes["tab:1"]?.childIds).toEqual(["tab:2"]);
    expect(state.nodes["tab:2"]?.parentId).toBe("tab:1");
    expect(state.nodes["tab:2"]?.title).toBe("Two");
    expect(state.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: destinationRuntimeWindowId });
  });

  it("ignores older command-relocated stale created events after a second command move", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          openerTabId: 1,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          url: "https://three.example/",
          title: "Three"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    const staleChild = copyTab(runtime.tabs.find((tab) => tab.id === 2)!);

    await controller.handleMessage({
      type: "moveNode",
      nodeId: "tab:1",
      index: 0
    });
    await controller.handleMessage({
      type: "moveNode",
      nodeId: "tab:2",
      index: 0
    });
    const movedAgain = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const destinationWindowId = movedAgain.nodes["tab:2"]?.parentId;
    if (!destinationWindowId) {
      throw new Error("Expected tab:2 to be moved into a live window");
    }
    const destinationRuntimeWindowId = movedAgain.nodes[destinationWindowId]?.live?.windowId;

    runtime.queueTabQueryResult(snapshotReplacingTab(runtime.tabs, staleChild));
    try {
      await runtime.events.tabCreated.emit(staleChild);
    } finally {
      runtime.clearNextTabQueryResult();
    }

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(liveWindowIds(state)).toContain(destinationRuntimeWindowId);
    expect(state.nodes["tab:2"]?.parentId).toBe(destinationWindowId);
    expect(state.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: destinationRuntimeWindowId });
    expect(nearestWindowNode(state, "tab:2")?.live).toEqual({ windowId: destinationRuntimeWindowId });
  });

  it("filters coalesced command-relocated stale echoes without per-echo node table scans", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          openerTabId: 1,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          openerTabId: 1,
          url: "https://three.example/",
          title: "Three"
        },
        {
          id: 4,
          windowId: 10,
          index: 3,
          active: false,
          url: "https://four.example/",
          title: "Four"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    const staleTabs = [1, 2, 3].map((tabId) => copyTab(runtime.tabs.find((tab) => tab.id === tabId)!));

    await controller.handleMessage({
      type: "moveNode",
      nodeId: "tab:1",
      index: 0
    });
    const moved = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    const { calls } = await countNodeTableObjectValues(async () => {
      for (const staleTab of staleTabs) {
        runtime.events.tabUpdated.dispatch(staleTab.id, { title: `Stale ${staleTab.id}` }, {
          ...staleTab,
          title: `Stale ${staleTab.id}`
        });
      }
      await runtime.events.tabUpdated.flush();
    }, moved.nodes);
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expect(calls).toBe(0);
    expect(state.nodes["tab:1"]?.title).toBe("One");
    expect(state.nodes["tab:2"]?.title).toBe("Two");
    expect(state.nodes["tab:3"]?.title).toBe("Three");
  });

  it("accepts fresh command-relocated tab updates and clears stale echo tracking", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          openerTabId: 1,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          url: "https://three.example/",
          title: "Three"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await controller.handleMessage({
      type: "moveNode",
      nodeId: "tab:1",
      index: 0
    });
    const moved = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const destinationWindowId = moved.nodes["tab:1"]?.parentId;
    if (!destinationWindowId) {
      throw new Error("Expected tab:1 to be moved into a live window");
    }
    const destinationRuntimeWindowId = moved.nodes[destinationWindowId]?.live?.windowId;

    await updateTabFromBrowser(runtime, 2, { title: "Fresh child update" });

    const fresh = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(fresh.nodes["tab:2"]?.title).toBe("Fresh child update");
    expect(fresh.nodes["tab:2"]?.parentId).toBe("tab:1");
    expect(fresh.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: destinationRuntimeWindowId });

    await updateTabFromBrowser(runtime, 2, { title: "Another fresh child update" });
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:2"]?.title).toBe("Another fresh child update");
    expect(state.nodes["tab:2"]?.parentId).toBe("tab:1");
    expect(state.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: destinationRuntimeWindowId });
  });

  it("does not resurrect a removed command-relocated tab from a stale echo", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          openerTabId: 1,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          url: "https://three.example/",
          title: "Three"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    const staleChild = copyTab(runtime.tabs.find((tab) => tab.id === 2)!);

    await controller.handleMessage({
      type: "moveNode",
      nodeId: "tab:1",
      index: 0
    });
    await closeTabFromBrowser(runtime, 2, "tabRemovedOnly");
    await runtime.events.tabUpdated.emit(2, { title: "Stale child update" }, {
      ...staleChild,
      title: "Stale child update"
    });

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(runtime.tabs.map((tab) => tab.id).sort((left, right) => left - right)).toEqual([1, 3]);
    expect(state.nodes["tab:2"]).toBeUndefined();
  });

  it("clears the previous active tab during partial active updates", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          url: "https://three.example/",
          title: "Three"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await updateTabFromBrowser(runtime, 2, { active: true }, {
      queryResult: [
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: true,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    });

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:1"]?.active).toBe(false);
    expect(state.nodes["tab:2"]?.active).toBe(true);
    expect(state.nodes["tab:3"]?.active).toBe(false);
    expect(state.nodes["tab:1"]?.status).toBe("live");
    expect(state.nodes["tab:3"]?.status).toBe("live");
  });

  it("updates active window state from focus change events", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        },
        {
          id: 20,
          focused: false,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 20,
          index: 0,
          active: true,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await focusWindowFromBrowser(runtime, 20);

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["window:10"]?.active).toBe(false);
    expect(state.nodes["window:20"]?.active).toBe(true);
  });

  it("deletes browser-native removed tabs while preserving other live tabs", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await closeTabFromBrowser(runtime, 2);

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:1"]?.status).toBe("live");
    expect(state.nodes["tab:2"]).toBeUndefined();
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:1"]);

    await controller.flushPendingSaves();
    const lastSave = vi.mocked(runtime.api.storage.local.set).mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(lastSave?.[STATE_KEY]).toBeUndefined();
    const persisted = await loadStateV2(runtime.api);
    expect(persisted?.nodes["tab:2"]).toBeUndefined();

    const lastBroadcast = runtime.broadcasts.at(-1) as { type?: string; state?: OutlineState } | undefined;
    expect(lastBroadcast?.type).toBe("stateUpdated");
    expect(lastBroadcast?.state?.nodes["tab:2"]).toBeUndefined();
    expect(runtime.api.sessions.getRecentlyClosed).not.toHaveBeenCalled();
  });

  it("preserves restored tabs when they are closed through browser chrome", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const restoredTab: RuntimeTab = {
      id: 22,
      windowId: 10,
      index: 1,
      active: false,
      url: "https://two.example/",
      title: "Two"
    };
    vi.mocked(runtime.api.sessions.restore).mockImplementation(async () => {
      runtime.tabs = [...runtime.tabs.filter((tab) => tab.id !== restoredTab.id), copyTab(restoredTab)];
      reindexWindowTabs(runtime, restoredTab.windowId);
      return { tab: copyTab(restoredTab) } as never;
    });
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await controller.handleMessage({ type: "closeNode", nodeId: "tab:2" });
    await controller.handleMessage({ type: "restoreNode", nodeId: "tab:2" });

    let state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:2"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.live).toEqual({ tabId: 22, windowId: 10 });
    expect(state.nodes["tab:2"]?.restoredFromClosed).toBe(true);

    await closeTabFromBrowser(runtime, 22);

    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:2"]?.status).toBe("closed");
    expect(state.nodes["tab:2"]?.live).toBeUndefined();
    expect(state.nodes["tab:2"]?.restore).toEqual({
      sessionId: "recent-session",
      url: "https://two.example/",
      title: "Two"
    });
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:2"]);
  });

  it("absorbs the created-tab echo after a command restore", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const restoredTab: RuntimeTab = {
      id: 22,
      windowId: 10,
      index: 1,
      active: false,
      url: "https://two.example/",
      title: "Two"
    };
    vi.mocked(runtime.api.sessions.restore).mockImplementation(async () => {
      createTabFromBrowser(runtime, restoredTab, { awaitListeners: false });
      return { tab: copyTab(restoredTab) } as never;
    });
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.handleMessage({ type: "closeNode", nodeId: "tab:2" });
    await runtime.events.tabRemoved.flush();
    await runtime.events.sessionChanged.flush();

    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    const result = await controller.handleMessage({ type: "restoreNode", nodeId: "tab:2" });
    await runtime.events.tabCreated.flush();
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expectCommandAck(result, true);
    expect(state.nodes["tab:2"]?.live).toEqual({ tabId: 22, windowId: 10 });
    expect(state.nodes["tab:2"]?.active).toBe(false);
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(1);
    const restoreBroadcast = runtime.broadcasts.at(-1) as
      | {
          type?: string;
          updatedNodes?: OutlineState["nodes"][string][];
          closedCountDelta?: number;
          state?: OutlineState;
        }
      | undefined;
    expect(restoreBroadcast?.type).toBe("nodeStateUpdated");
    expect(restoreBroadcast?.updatedNodes?.map((node) => node.id)).toEqual(["tab:2"]);
    expect(restoreBroadcast?.updatedNodes?.[0]).toMatchObject({
      id: "tab:2",
      status: "live",
      live: { tabId: 22, windowId: 10 },
      restoredFromClosed: true
    });
    expect(restoreBroadcast?.closedCountDelta).toBe(-1);
    expect(restoreBroadcast?.state).toBeUndefined();
    await controller.flushPendingSaves();
    expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
  });

  it("absorbs command-restored created-tab echoes without an extra node table scan", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const restoredTab: RuntimeTab = {
      id: 22,
      windowId: 10,
      index: 1,
      active: false,
      url: "https://two.example/",
      title: "Two"
    };
    vi.mocked(runtime.api.sessions.restore).mockImplementation(async () => {
      createTabFromBrowser(runtime, restoredTab, { awaitListeners: false });
      return { tab: copyTab(restoredTab) } as never;
    });
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.handleMessage({ type: "closeNode", nodeId: "tab:2" });
    await runtime.events.tabRemoved.flush();
    await runtime.events.sessionChanged.flush();

    await controller.handleMessage({ type: "restoreNode", nodeId: "tab:2" });
    const restoredState = await controller.ensureState();
    const { calls } = await countNodeTableObjectValues(() => runtime.events.tabCreated.flush(), restoredState.nodes);
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expect(calls).toBe(0);
    expect(state.nodes["tab:2"]?.live).toEqual({ tabId: 22, windowId: 10 });
  });

  it("restores one closed tab without traversing unrelated closed siblings", async () => {
    const storedState = wideClosedTabState(100);
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [],
      { initialStorage: outlineStateV3Changes(storedState).setItems }
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    const initialState = await controller.ensureState();

    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    const { reads, value } = await countNodePropertyReads(initialState, ["tab:40"], () =>
      controller.handleMessage({ type: "restoreNode", nodeId: "tab:100" })
    );
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expectCommandAck(value, true);
    expect(reads).toBeLessThanOrEqual(1);
    expect(state.nodes["tab:100"]?.live).toEqual({ tabId: 1, windowId: 10 });
    expect(state.nodes["tab:40"]?.status).toBe("closed");
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(1);
    expect(runtime.broadcasts.at(-1)).toMatchObject({
      type: "nodeStateUpdated",
      updatedNodes: [
        expect.objectContaining({
          id: "tab:100",
          status: "live"
        })
      ],
      closedCountDelta: -1
    });
    await controller.flushPendingSaves();
    expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
  });

  it("broadcasts a restored focused new window and the cleared active window in one compact restore patch", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        },
        {
          id: 20,
          focused: false,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 5,
          windowId: 20,
          index: 0,
          active: true,
          url: "https://restored.example/",
          title: "Restored"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.handleMessage({ type: "closeNode", nodeId: "window:20" });
    await runtime.events.tabRemoved.flush();
    await runtime.events.windowRemoved.flush();

    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    const result = await controller.handleMessage({ type: "restoreNode", nodeId: "tab:5" });
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expectCommandAck(result, true);
    expect(state.nodes["window:10"]?.active).toBe(false);
    expect(state.nodes["window:20"]?.active).toBe(true);
    const restoredRuntimeWindowId = state.nodes["window:20"]?.live?.windowId;
    expect(state.nodes["tab:5"]?.live).toEqual({
      tabId: 2,
      windowId: restoredRuntimeWindowId
    });
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(1);
    const restoreBroadcast = runtime.broadcasts.at(-1) as
      | {
          type?: string;
          updatedNodes?: OutlineState["nodes"][string][];
          closedCountDelta?: number;
          state?: OutlineState;
        }
      | undefined;
    expect(restoreBroadcast?.type).toBe("nodeStateUpdated");
    expect(restoreBroadcast?.updatedNodes?.map((node) => node.id).sort()).toEqual([
      "tab:5",
      "window:10",
      "window:20"
    ]);
    expect(restoreBroadcast?.updatedNodes?.find((node) => node.id === "window:10")?.active).toBe(false);
    expect(restoreBroadcast?.updatedNodes?.find((node) => node.id === "window:20")?.active).toBe(true);
    expect(restoreBroadcast?.updatedNodes?.find((node) => node.id === "tab:5")).toMatchObject({
      status: "live",
      active: true,
      live: { tabId: 2, windowId: restoredRuntimeWindowId }
    });
    expect(restoreBroadcast?.closedCountDelta).toBe(-2);
    expect(restoreBroadcast?.state).toBeUndefined();
    await controller.flushPendingSaves();
    expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
  });

  it("absorbs transient restored-tab create and no-op update echoes", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const restoredTab: RuntimeTab = {
      id: 22,
      windowId: 10,
      index: 1,
      active: false,
      url: "https://two.example/",
      title: "Two"
    };
    vi.mocked(runtime.api.sessions.restore).mockImplementation(async () => {
      createTabFromBrowser(runtime, restoredTab, {
        awaitListeners: false,
        eventTab: {
          ...restoredTab,
          url: "about:blank",
          title: "New Tab"
        }
      });
      return { tab: copyTab(restoredTab) } as never;
    });
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.handleMessage({ type: "closeNode", nodeId: "tab:2" });
    await runtime.events.tabRemoved.flush();
    await runtime.events.sessionChanged.flush();

    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    await controller.handleMessage({ type: "restoreNode", nodeId: "tab:2" });
    await runtime.events.tabCreated.flush();
    await updateTabFromBrowser(runtime, 22, {
      url: restoredTab.url,
      title: restoredTab.title
    });
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expect(state.nodes["tab:2"]?.live).toEqual({ tabId: 22, windowId: 10 });
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(1);
    const restoreBroadcast = runtime.broadcasts[0] as { type?: string; state?: OutlineState } | undefined;
    expect(restoreBroadcast?.type).toBe("nodeStateUpdated");
    expect(restoreBroadcast?.state).toBeUndefined();
    await controller.flushPendingSaves();
    expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
  });

  it("keeps a command-restored tab's saved title until runtime reports the final page title", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Saved Two"
        }
      ]
    );
    const restoredTab: RuntimeTab = {
      id: 22,
      windowId: 10,
      index: 1,
      active: false,
      url: "https://two.example/",
      title: "New Tab"
    };
    vi.mocked(runtime.api.sessions.restore).mockImplementation(async () => {
      createTabFromBrowser(runtime, restoredTab, {
        awaitListeners: false,
        eventTab: {
          ...restoredTab,
          title: "New Tab"
        }
      });
      return { tab: copyTab(restoredTab) } as never;
    });
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.handleMessage({ type: "closeNode", nodeId: "tab:2" });
    await runtime.events.tabRemoved.flush();
    await runtime.events.sessionChanged.flush();

    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    await controller.handleMessage({ type: "restoreNode", nodeId: "tab:2" });
    await runtime.events.tabCreated.flush();

    let state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:2"]?.title).toBe("Saved Two");
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(1);
    expect(runtime.broadcasts[0]).toMatchObject({
      type: "nodeStateUpdated",
      updatedNodes: [
        expect.objectContaining({
          id: "tab:2",
          title: "Saved Two",
          url: "https://two.example/"
        })
      ]
    });

    await updateTabFromBrowser(runtime, 22, {
      title: "https://two.example/",
      url: "https://two.example/"
    });

    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:2"]?.title).toBe("Saved Two");
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(1);

    await updateTabFromBrowser(runtime, 22, {
      title: "https://two.example",
      url: "https://two.example/"
    });

    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:2"]?.title).toBe("Saved Two");
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(1);

    await updateTabFromBrowser(runtime, 22, {
      title: "localhost:8089/"
    });

    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:2"]?.title).toBe("Saved Two");
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(1);

    await updateTabFromBrowser(runtime, 22, {
      title: "Loaded Two"
    });

    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:2"]?.title).toBe("Loaded Two");
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(2);
    expect(runtime.broadcasts.at(-1)).toMatchObject({
      type: "nodeStateUpdated",
      updatedNodes: [
        expect.objectContaining({
          id: "tab:2",
          title: "Loaded Two"
        })
      ]
    });
  });

  it("preserves outliner closeNode tab removals as restorable closed nodes", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await controller.handleMessage({ type: "closeNode", nodeId: "tab:2" });
    expect(runtime.api.tabs.remove).toHaveBeenCalledWith([2]);

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:1"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.status).toBe("closed");
    expect(state.nodes["tab:2"]?.live).toBeUndefined();
    expect(state.nodes["tab:2"]?.restore).toEqual({
      sessionId: "recent-session",
      url: "https://two.example/",
      title: "Two"
    });
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:2"]);
  });

  it("does not broadcast stale unchanged state for outliner closeNode tabs", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    await controller.handleMessage({ type: "closeNode", nodeId: "tab:2" });
    await controller.handleMessage({ type: "getState" });

    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(1);
    const closeBroadcast = runtime.broadcasts[0] as
      | {
          type?: string;
          updatedNodes?: OutlineState["nodes"][string][];
          closedCountDelta?: number;
          state?: OutlineState;
        }
      | undefined;
    expect(closeBroadcast?.type).toBe("nodeStateUpdated");
    expect(closeBroadcast?.updatedNodes?.map((node) => node.id)).toEqual(["tab:2"]);
    expect(closeBroadcast?.updatedNodes?.[0]?.status).toBe("closed");
    expect(closeBroadcast?.closedCountDelta).toBe(1);
    expect(closeBroadcast?.state).toBeUndefined();
    await controller.flushPendingSaves();
    expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
  });

  it("does not broadcast twice when outliner closeNode sessions arrive before tabRemoved", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ],
      { browserLikeTabRemove: "sessionChangedThenTabRemoved" }
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    await controller.handleMessage({ type: "closeNode", nodeId: "tab:2" });
    await runtime.events.sessionChanged.flush();
    await runtime.events.tabRemoved.flush();
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expect(state.nodes["tab:2"]?.status).toBe("closed");
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(1);
    const closeBroadcast = runtime.broadcasts[0] as { type?: string; closedCountDelta?: number } | undefined;
    expect(closeBroadcast?.type).toBe("nodeStateUpdated");
    expect(closeBroadcast?.closedCountDelta).toBe(1);
    await controller.flushPendingSaves();
    expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
  });

  it("defers command close session echoes until the matching tabRemoved event", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      Array.from({ length: 100 }, (_value, index) => ({
        id: index + 1,
        windowId: 10,
        index,
        active: index === 0,
        url: `https://close.example/${index + 1}`,
        title: `Tab ${index + 1}`
      })),
      { browserLikeTabRemove: "sessionChangedThenTabRemoved" }
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    const initialState = await controller.ensureState();

    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.tabs.query).mockClear();
    vi.mocked(runtime.api.windows.getAll).mockClear();
    vi.mocked(runtime.api.storage.local.set).mockClear();

    await controller.handleMessage({ type: "closeNode", nodeId: "tab:100" });
    const sessionResult = await countNodePropertyReads(initialState, ["tab:40"], () =>
      runtime.events.sessionChanged.flush()
    );

    expect(sessionResult.reads).toBe(0);
    expect(runtime.api.tabs.query).not.toHaveBeenCalled();
    expect(runtime.api.windows.getAll).not.toHaveBeenCalled();

    await runtime.events.tabRemoved.flush();
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expect(state.nodes["tab:100"]?.status).toBe("closed");
    expect(state.nodes["tab:40"]?.status).toBe("live");
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(1);
    expect(runtime.broadcasts.at(-1)).toMatchObject({
      type: "nodeStateUpdated",
      updatedNodes: [
        expect.objectContaining({
          id: "tab:100",
          status: "closed"
        })
      ],
      closedCountDelta: 1
    });
    await controller.flushPendingSaves();
    expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
  });

  it("skips the session-changed snapshot after an outliner closeNode tabRemoved update", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ],
      { browserLikeTabRemove: "tabRemovedThenSessionChanged" }
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    vi.mocked(runtime.api.tabs.query).mockClear();
    vi.mocked(runtime.api.windows.getAll).mockClear();

    await controller.handleMessage({ type: "closeNode", nodeId: "tab:2" });
    await runtime.events.tabRemoved.flush();
    await runtime.events.sessionChanged.flush();
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expect(state.nodes["tab:2"]?.status).toBe("closed");
    expect(runtime.api.tabs.query).not.toHaveBeenCalled();
    expect(runtime.api.windows.getAll).not.toHaveBeenCalled();
  });

  it("preserves outliner closeNode windows with one live tab as restorable closed nodes", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        },
        {
          id: 20,
          focused: false,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 20,
          index: 0,
          active: true,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    vi.mocked(runtime.api.sessions.getRecentlyClosed).mockResolvedValue([
      { window: { sessionId: "session-window-20" } } as never
    ]);
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await controller.handleMessage({ type: "closeNode", nodeId: "window:20" });

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(runtime.api.windows.remove).toHaveBeenCalledWith(20);
    expect(runtime.windows.map((windowInfo) => windowInfo.id)).toEqual([10]);
    expect(runtime.tabs.map((tab) => tab.id)).toEqual([1]);
    expect(state.nodes["window:20"]?.status).toBe("closed");
    expect(state.nodes["window:20"]?.restore?.sessionId).toBe("session-window-20");
    expect(state.nodes["tab:2"]?.status).toBe("closed");
    expect(state.nodes["tab:2"]?.live).toBeUndefined();
    expect(state.nodes["window:10"]?.status).toBe("live");
    expect(state.nodes["tab:1"]?.status).toBe("live");
    const closeBroadcast = runtime.broadcasts.at(-1) as
      | { type?: string; updatedNodes?: OutlineState["nodes"][string][]; closedCountDelta?: number; state?: OutlineState }
      | undefined;
    expect(closeBroadcast?.type).toBe("nodeStateUpdated");
    expect(closeBroadcast?.updatedNodes?.map((node) => node.id).sort()).toEqual(["tab:2", "window:20"]);
    expect(closeBroadcast?.closedCountDelta).toBe(2);
    expect(closeBroadcast?.state).toBeUndefined();
  });

  it("preserves live descendants when closing a neutral outline group", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        },
        {
          id: 20,
          focused: false,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 20,
          index: 0,
          active: true,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.handleMessage({ type: "wrapNodeInGroup", nodeId: "window:20" });
    let state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const innerGroupId = state.nodes["window:20"]?.parentId;
    await controller.handleMessage({ type: "wrapNodeInGroup", nodeId: innerGroupId! });
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const outerGroupId = state.nodes[innerGroupId!]?.parentId;
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.sessions.getRecentlyClosed).mockResolvedValue([
      { window: { sessionId: "session-window-20" } } as never
    ]);

    await controller.handleMessage({ type: "closeNode", nodeId: outerGroupId! });

    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(runtime.api.windows.remove).toHaveBeenCalledWith(20);
    expect(runtime.windows.map((windowInfo) => windowInfo.id)).toEqual([10]);
    expect(runtime.tabs.map((tab) => tab.id)).toEqual([1]);
    expect(state.nodes[outerGroupId!]?.status).toBe("neutral");
    expect(state.nodes[innerGroupId!]?.status).toBe("neutral");
    expect(state.nodes["window:20"]?.status).toBe("closed");
    expect(state.nodes["window:20"]?.restore?.sessionId).toBe("session-window-20");
    expect(state.nodes["tab:2"]?.status).toBe("closed");
    expect(state.nodes["tab:2"]?.live).toBeUndefined();
    expect(state.nodes["window:10"]?.status).toBe("live");
    expect(state.nodes["tab:1"]?.status).toBe("live");
    const closeBroadcast = runtime.broadcasts.at(-1) as
      | { type?: string; updatedNodes?: OutlineState["nodes"][string][]; closedCountDelta?: number; state?: OutlineState }
      | undefined;
    expect(closeBroadcast?.type).toBe("nodeStateUpdated");
    expect(closeBroadcast?.updatedNodes?.map((node) => node.id).sort()).toEqual(["tab:2", "window:20"]);
    expect(closeBroadcast?.closedCountDelta).toBe(2);
    expect(closeBroadcast?.state).toBeUndefined();
  });

  it("handles outliner closeNode when Firefox fires tabRemoved during tabs.remove", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          openerTabId: 1,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          url: "https://three.example/",
          title: "Three"
        }
      ],
      { browserLikeTabRemove: "tabRemovedThenSessionChanged" }
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await controller.handleMessage({ type: "closeNode", nodeId: "tab:1" });

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(runtime.tabs.map((tab) => tab.id)).toEqual([2, 3]);
    expect(state.nodes["tab:1"]?.status).toBe("closed");
    expect(state.nodes["tab:1"]?.childIds).toEqual([]);
    expect(state.nodes["tab:2"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.parentId).toBe("window:10");
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:2", "tab:3"]);
    const closeBroadcast = runtime.broadcasts.at(-1) as
      | { type?: string; updatedNodes?: OutlineState["nodes"][string][]; state?: OutlineState }
      | undefined;
    expect(closeBroadcast?.type).toBe("treeStructureUpdated");
    expect(closeBroadcast?.state).toBeUndefined();
    const updatedNodes = new Map(closeBroadcast?.updatedNodes?.map((node) => [node.id, node]));
    expect(updatedNodes.get("tab:2")?.parentId).toBe("window:10");
    expect(updatedNodes.get("tab:1")).toMatchObject({
      id: "tab:1",
      status: "closed",
      childIds: []
    });
    expect(updatedNodes.get("window:10")?.childIds).toEqual(["tab:1", "tab:2", "tab:3"]);
  });

  it("handles outliner closeNode when Firefox reports sessions before tabRemoved", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          openerTabId: 1,
          url: "https://two.example/",
          title: "Two"
        }
      ],
      { browserLikeTabRemove: "sessionChangedThenTabRemoved" }
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await controller.handleMessage({ type: "closeNode", nodeId: "tab:1" });

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(runtime.tabs.map((tab) => tab.id)).toEqual([2]);
    expect(state.nodes["tab:1"]?.status).toBe("closed");
    expect(state.nodes["tab:1"]?.childIds).toEqual([]);
    expect(state.nodes["tab:2"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.parentId).toBe("window:10");
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:2"]);
  });

  it("deletes stale live tab nodes when a native close only reports through sessions", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await closeTabFromBrowser(runtime, 2, "sessionChangedOnly");

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:1"]?.status).toBe("live");
    expect(state.nodes["tab:2"]).toBeUndefined();
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:1"]);
  });

  it("ignores stale created events after a sessions-only native close", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    const staleTab = runtime.tabs.find((tab) => tab.id === 2)!;
    await closeTabFromBrowser(runtime, 2, "sessionChangedOnly");
    await runtime.events.tabCreated.emit(staleTab);

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(runtime.tabs.map((tab) => tab.id)).toEqual([1]);
    expect(state.nodes["tab:2"]).toBeUndefined();
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:1"]);
  });

  it("preserves outliner closeNode tabs when sessions change before tabRemoved", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ],
      { browserLikeTabRemove: "sessionChangedThenTabRemoved" }
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await controller.handleMessage({ type: "closeNode", nodeId: "tab:2" });

    let state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:2"]?.status).toBe("closed");
    expect(state.nodes["tab:2"]?.restore?.sessionId).toBe("recent-session");

    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:2"]?.status).toBe("closed");
  });

  it("deletes browser-native parent closes after Firefox mutates the tab list", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          openerTabId: 1,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          url: "https://three.example/",
          title: "Three"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await closeTabFromBrowser(runtime, 1, "tabRemovedThenSessionChanged");

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(runtime.tabs.map((tab) => [tab.id, tab.index])).toEqual([
      [2, 0],
      [3, 1]
    ]);
    expect(state.nodes["tab:1"]).toBeUndefined();
    expect(state.nodes["tab:2"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.parentId).toBe("window:10");
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:2", "tab:3"]);
  });

  it("ignores stale created events for tabs already removed by Firefox", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    const staleTab: RuntimeTab = {
      id: 2,
      windowId: 10,
      index: 1,
      active: true,
      openerTabId: 1,
      url: "about:newtab",
      title: "New Tab"
    };
    createTabFromBrowser(runtime, staleTab, { awaitListeners: false });
    await closeTabFromBrowser(runtime, 2);

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(runtime.tabs.map((tab) => tab.id)).toEqual([1]);
    expect(state.nodes["tab:2"]).toBeUndefined();
    expect(state.nodes["tab:1"]?.childIds).toEqual([]);
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:1"]);
  });

  it("ignores stale consecutive created events for tabs already removed by Firefox", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    const staleTab2: RuntimeTab = {
      id: 2,
      windowId: 10,
      index: 1,
      active: true,
      openerTabId: 1,
      url: "about:newtab",
      title: "New Tab"
    };
    const staleTab3: RuntimeTab = {
      id: 3,
      windowId: 10,
      index: 2,
      active: true,
      openerTabId: 2,
      url: "about:newtab",
      title: "New Tab"
    };

    createTabFromBrowser(runtime, staleTab2, { awaitListeners: false });
    createTabFromBrowser(runtime, staleTab3, { awaitListeners: false });
    await closeTabFromBrowser(runtime, 3);
    await closeTabFromBrowser(runtime, 2);

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(runtime.tabs.map((tab) => tab.id)).toEqual([1]);
    expect(state.nodes["tab:2"]).toBeUndefined();
    expect(state.nodes["tab:3"]).toBeUndefined();
    expect(state.nodes["tab:1"]?.childIds).toEqual([]);
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:1"]);
  });

  it("ignores stale updated events for tabs already removed by Firefox", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    const staleTab: RuntimeTab = {
      id: 2,
      windowId: 10,
      index: 1,
      active: true,
      openerTabId: 1,
      url: "https://two.example/",
      title: "Two"
    };
    createTabFromBrowser(runtime, staleTab, { awaitListeners: false });
    await updateTabFromBrowser(runtime, 2, { url: "https://two.example/" }, { awaitListeners: false });
    await closeTabFromBrowser(runtime, 2);

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:2"]).toBeUndefined();
    expect(state.nodes["tab:1"]?.childIds).toEqual([]);
  });

  it("adds tabs restored through native browser undo close as new live nodes", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await closeTabFromBrowser(runtime, 2);

    await createTabFromBrowser(runtime, {
      id: 22,
      windowId: 10,
      index: 1,
      active: true,
      url: "about:blank",
      title: "New Tab"
    });
    await updateTabFromBrowser(runtime, 22, { url: "https://two.example/", title: "Two" });

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:2"]).toBeUndefined();
    expect(state.nodes["tab:22"]?.status).toBe("live");
    expect(state.nodes["tab:22"]?.live).toEqual({ tabId: 22, windowId: 10 });
    expect(liveTabIds(state)).toEqual([1, 22]);
  });

  it("does not create a saved closed node when duplicating after native close", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://same.example/",
          title: "Original"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://same.example/",
          title: "Previously saved"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await closeTabFromBrowser(runtime, 2);

    await createTabFromBrowser(runtime, {
      id: 22,
      windowId: 10,
      index: 1,
      active: true,
      openerTabId: 1,
      url: "https://same.example/",
      title: "Original"
    });

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:2"]).toBeUndefined();
    expect(state.nodes["tab:22"]?.status).toBe("live");
    expect(state.nodes["tab:22"]?.live).toEqual({ tabId: 22, windowId: 10 });
    expect(liveTabIds(state)).toEqual([1, 22]);
  });

  it("keeps all nodes reachable across stale updates, new tabs, and native restores", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          openerTabId: 1,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          url: "https://three.example/",
          title: "Three"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await updateTabFromBrowser(runtime, 2, { active: true }, {
      queryResult: [
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: true,
          openerTabId: 1,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    });

    await createTabFromBrowser(runtime, {
      id: 4,
      windowId: 10,
      index: 3,
      active: true,
      url: "about:newtab",
      title: "New Tab"
    });

    await closeTabFromBrowser(runtime, 2);

    await createTabFromBrowser(runtime, {
      id: 22,
      windowId: 10,
      index: 1,
      active: true,
      url: "about:blank",
      title: "New Tab"
    });
    await updateTabFromBrowser(runtime, 22, { url: "https://two.example/", title: "Two" });

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(reachableNodeIds(state)).toEqual(Object.keys(state.nodes).sort());
    expect(liveTabIds(state)).toEqual([1, 3, 4, 22]);
    expect(state.nodes["tab:2"]).toBeUndefined();
    expect(state.nodes["tab:22"]?.live).toEqual({ tabId: 22, windowId: 10 });
  });

  it("does not delete tab nodes from tab removal events during multi-tab window close", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    vi.mocked(runtime.api.sessions.getRecentlyClosed).mockResolvedValue([
      { window: { sessionId: "session-window-10" } } as never
    ]);
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await runtime.events.tabRemoved.emit(1, { windowId: 10, isWindowClosing: true });
    await runtime.events.tabRemoved.emit(2, { windowId: 10, isWindowClosing: true });

    let state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["window:10"]?.status).toBe("live");
    expect(state.nodes["tab:1"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.status).toBe("live");

    runtime.windows = [];
    runtime.tabs = [];
    await runtime.events.windowRemoved.emit(10);

    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["window:10"]?.status).toBe("closed");
    expect(state.nodes["window:10"]?.restore?.sessionId).toBe("session-window-10");
    expect(state.nodes["tab:1"]?.status).toBe("closed");
    expect(state.nodes["tab:2"]?.status).toBe("closed");
  });

  it("preserves a single-tab window when Firefox reports the corresponding window removal", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        },
        {
          id: 20,
          focused: false,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 20,
          index: 0,
          active: true,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    runtime.tabs = runtime.tabs.filter((tab) => tab.id !== 2);
    runtime.windows = runtime.windows.filter((windowInfo) => windowInfo.id !== 20);
    await runtime.events.tabRemoved.emit(2, { windowId: 20, isWindowClosing: true });
    await runtime.events.windowRemoved.emit(20);

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["window:20"]?.status).toBe("closed");
    expect(state.nodes["tab:2"]?.status).toBe("closed");
    expect(state.nodes["window:10"]?.status).toBe("live");
    expect(state.nodes["tab:1"]?.status).toBe("live");
  });

  it("preserves restored single-tab windows when they are closed through browser chrome", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        },
        {
          id: 20,
          focused: false,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 20,
          index: 0,
          active: true,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const restoredTab: RuntimeTab = {
      id: 22,
      windowId: 42,
      index: 0,
      active: true,
      url: "https://two.example/",
      title: "Two"
    };
    vi.mocked(runtime.api.sessions.getRecentlyClosed)
      .mockResolvedValueOnce([{ window: { sessionId: "session-window-20" } } as never])
      .mockResolvedValueOnce([{ window: { sessionId: "session-window-42" } } as never]);
    vi.mocked(runtime.api.sessions.restore).mockImplementation(async () => {
      runtime.windows = [
        ...runtime.windows.filter((windowInfo) => windowInfo.id !== 42),
        {
          id: 42,
          focused: false,
          incognito: false
        }
      ];
      runtime.tabs = [
        ...runtime.tabs.filter((tab) => tab.id !== restoredTab.id),
        copyTab(restoredTab)
      ];
      return {
        window: {
          id: 42,
          focused: false,
          incognito: false,
          tabs: [copyTab(restoredTab)]
        }
      } as never;
    });
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await controller.handleMessage({ type: "closeNode", nodeId: "window:20" });
    await controller.handleMessage({ type: "restoreNode", nodeId: "window:20" });

    let state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["window:20"]?.status).toBe("live");
    expect(state.nodes["window:20"]?.live).toEqual({ windowId: 42 });
    expect(state.nodes["window:20"]?.restoredFromClosed).toBe(true);
    expect(state.nodes["tab:2"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.live).toEqual({ tabId: 22, windowId: 42 });
    expect(state.nodes["tab:2"]?.restoredFromClosed).toBe(true);

    await closeRuntimeWindow(runtime, 42, { awaitListeners: true });

    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["window:20"]?.status).toBe("closed");
    expect(state.nodes["window:20"]?.restore?.sessionId).toBe("session-window-42");
    expect(state.nodes["tab:2"]?.status).toBe("closed");
    expect(state.nodes["tab:2"]?.live).toBeUndefined();
    expect(state.nodes["window:42"]).toBeUndefined();
    expect(state.nodes["tab:22"]).toBeUndefined();
    expect(state.nodes["window:10"]?.status).toBe("live");
    expect(state.nodes["tab:1"]?.status).toBe("live");
  });

  it("does not delete missing live tabs from windows that are no longer open", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    vi.mocked(runtime.api.sessions.getRecentlyClosed).mockResolvedValue([
      { window: { sessionId: "session-window-10" } } as never
    ]);
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    runtime.windows = [];
    runtime.tabs = [];
    await runtime.events.sessionChanged.emit();

    let state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["window:10"]?.status).toBe("live");
    expect(state.nodes["tab:1"]?.status).toBe("live");

    await runtime.events.windowRemoved.emit(10);

    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["window:10"]?.status).toBe("closed");
    expect(state.nodes["window:10"]?.restore?.sessionId).toBe("session-window-10");
    expect(state.nodes["tab:1"]?.status).toBe("closed");
  });

  it("manual refresh performs a full snapshot reconciliation", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    runtime.tabs = [];
    const result = await controller.handleMessage({ type: "refresh" });
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expectCommandAck(result, true);
    expect(state.nodes["tab:1"]).toBeUndefined();
    expect(state.nodes["window:10"]).toBeUndefined();
  });

  it("acknowledges unchanged manual refresh without saving or broadcasting", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    const result = await controller.handleMessage({ type: "refresh" });

    expectCommandAck(result, false);
    expect(runtime.broadcasts).toHaveLength(0);
    expect(vi.mocked(runtime.api.storage.local.set)).not.toHaveBeenCalled();
  });

  it("manual refresh deletes stale parent tab nodes without closing their children", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          openerTabId: 1,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          url: "https://three.example/",
          title: "Three"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    runtime.tabs = [
      {
        id: 2,
        windowId: 10,
        index: 0,
        active: true,
        url: "https://two.example/",
        title: "Two"
      },
      {
        id: 3,
        windowId: 10,
        index: 1,
        active: false,
        url: "https://three.example/",
        title: "Three"
      }
    ];
    const result = await controller.handleMessage({ type: "refresh" });
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expectCommandAck(result, true);
    expect(state.nodes["tab:1"]).toBeUndefined();
    expect(state.nodes["tab:2"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.parentId).toBe("window:10");
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:2", "tab:3"]);
  });

  it("reattaches delayed tabs after restoring a closed single-tab window node", async () => {
    const url = "about:debugging#/runtime/this-firefox";
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        },
        {
          id: 20,
          focused: false,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 5,
          windowId: 20,
          index: 0,
          active: true,
          url,
          title: "Debugging - Runtime / this-firefox"
        }
      ]
    );
    vi.mocked(runtime.api.sessions.getRecentlyClosed).mockResolvedValue([
      { window: { sessionId: "session-window-20" } } as never
    ]);
    vi.mocked(runtime.api.sessions.restore).mockResolvedValue({
      window: {
        id: 42,
        focused: true,
        incognito: false,
        tabs: []
      }
    });
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    runtime.windows = runtime.windows.filter((windowInfo) => windowInfo.id !== 20);
    runtime.tabs = runtime.tabs.filter((tab) => tab.windowId !== 20);
    await runtime.events.windowRemoved.emit(20);
    runtime.broadcasts.length = 0;

    const restoreResult = await controller.handleMessage({ type: "restoreNode", nodeId: "window:20" });
    const restored = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expectCommandAck(restoreResult, true);
    expect(restored.nodes["window:20"]?.live).toEqual({ windowId: 42 });
    expect(restored.nodes["tab:5"]?.status).toBe("closed");
    expect(restored.nodes["window:42"]).toBeUndefined();
    const restoreBroadcast = runtime.broadcasts.at(-1) as
      | { type?: string; updatedNodes?: OutlineState["nodes"][string][]; closedCountDelta?: number; state?: OutlineState }
      | undefined;
    expect(restoreBroadcast?.type).toBe("nodeStateUpdated");
    expect(restoreBroadcast?.updatedNodes?.map((node) => node.id)).toEqual(["window:20", "window:10"]);
    expect(restoreBroadcast?.updatedNodes?.find((node) => node.id === "window:20")?.active).toBe(true);
    expect(restoreBroadcast?.updatedNodes?.find((node) => node.id === "window:10")?.active).toBe(false);
    expect(restoreBroadcast?.closedCountDelta).toBe(-1);
    expect(restoreBroadcast?.state).toBeUndefined();

    runtime.windows = [
      ...runtime.windows,
      {
        id: 42,
        focused: true,
        incognito: false
      }
    ];
    const restoredTab: RuntimeTab = {
      id: 50,
      windowId: 42,
      index: 0,
      active: true,
      url,
      title: "Debugging - Runtime / this-firefox"
    };
    await createTabFromBrowser(runtime, restoredTab);

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["window:20"]?.live).toEqual({ windowId: 42 });
    expect(state.nodes["tab:5"]?.live).toEqual({ tabId: 50, windowId: 42 });
    expect(state.nodes["window:42"]).toBeUndefined();
    expect(state.rootIds).not.toContain("window:42");
  });

  it("does not recreate nodes from delayed restored-tab events after deleting their restored group", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        },
        {
          id: 20,
          focused: false,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 5,
          windowId: 20,
          index: 0,
          active: true,
          url: "https://restored.example/",
          title: "Restored"
        }
      ]
    );
    vi.mocked(runtime.api.sessions.getRecentlyClosed).mockResolvedValue([
      { window: { sessionId: "session-window-20" } } as never
    ]);
    const adapter: BrowserAdapter = {
      focusTab: vi.fn(async () => undefined),
      closeTab: vi.fn(async () => undefined),
      closeTabs: vi.fn(async () => undefined),
      closeWindow: vi.fn(async (windowId) => {
        if (windowId === 20) {
          await closeRuntimeWindow(runtime, windowId, { awaitListeners: false });
        }
      }),
      restoreSession: vi.fn(async () => {
        runtime.windows = runtime.windows
          .map((windowInfo) => ({ ...windowInfo, focused: false }))
          .concat({ id: 42, focused: true, incognito: false });
        return {
          window: {
            id: 42,
            focused: true,
            incognito: false,
            tabs: []
          }
        };
      }),
      createTab: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      createWindow: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      moveTabs: vi.fn(async () => undefined)
    };
    const controller = createBackgroundController({ api: runtime.api, adapter, now: () => 1000 });
    await controller.ensureState();
    await controller.handleMessage({ type: "wrapNodeInGroup", nodeId: "window:20" });
    let state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const groupId = state.nodes["window:20"]?.parentId;
    expect(groupId).toBeTruthy();

    await controller.handleMessage({ type: "closeNode", nodeId: groupId! });
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes[groupId!]?.status).toBe("neutral");
    expect(state.nodes["window:20"]?.status).toBe("closed");

    expectCommandAck(await controller.handleMessage({ type: "restoreNode", nodeId: groupId! }), true);
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["window:20"]?.live).toEqual({ windowId: 42 });
    expect(state.nodes["tab:5"]?.status).toBe("closed");

    const delayedRestoredTab: RuntimeTab = {
      id: 50,
      windowId: 42,
      index: 0,
      active: true,
      url: "https://restored.example/",
      title: "Restored"
    };
    createTabFromBrowser(runtime, delayedRestoredTab, { awaitListeners: false });

    expectCommandAck(await controller.handleMessage({ type: "deleteNode", nodeId: groupId! }), true);
    await runtime.events.tabCreated.flush();

    runtime.tabs = runtime.tabs.filter((tab) => tab.windowId !== 42);
    runtime.windows = runtime.windows.filter((windowInfo) => windowInfo.id !== 42);
    runtime.events.tabRemoved.dispatch(50, { windowId: 42, isWindowClosing: true });
    runtime.events.windowRemoved.dispatch(42);
    await Promise.all([
      runtime.events.tabRemoved.flush(),
      runtime.events.windowRemoved.flush()
    ]);

    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes[groupId!]).toBeUndefined();
    expect(state.nodes["window:20"]).toBeUndefined();
    expect(state.nodes["tab:5"]).toBeUndefined();
    expect(state.nodes["window:42"]).toBeUndefined();
    expect(state.nodes["tab:50"]).toBeUndefined();
    expect(state.rootIds).toEqual(["window:10"]);
  });

  it("deletes the outline subtree when a delete-owned window close completes but rejects", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        },
        {
          id: 20,
          focused: false,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 20,
          index: 0,
          active: true,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const adapter: BrowserAdapter = {
      focusTab: vi.fn(async () => undefined),
      closeTab: vi.fn(async () => undefined),
      closeTabs: vi.fn(async () => undefined),
      closeWindow: vi.fn(async (windowId) => {
        await closeRuntimeWindow(runtime, windowId, { awaitListeners: false });
        throw new Error("Window close completed after rejecting");
      }),
      restoreSession: vi.fn(async () => ({})),
      createTab: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      createWindow: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      moveTabs: vi.fn(async () => undefined)
    };
    const controller = createBackgroundController({ api: runtime.api, adapter, now: () => 1000 });
    await controller.ensureState();
    await controller.handleMessage({ type: "wrapNodeInGroup", nodeId: "window:20" });
    let state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const groupId = state.nodes["window:20"]?.parentId;
    expect(groupId).toBeTruthy();

    const deleteResult = await controller.handleMessage({ type: "deleteNode", nodeId: groupId! });
    await Promise.all([
      runtime.events.tabRemoved.flush(),
      runtime.events.windowRemoved.flush()
    ]);
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expectCommandAck(deleteResult, true);
    expect(state.nodes[groupId!]).toBeUndefined();
    expect(state.nodes["window:20"]).toBeUndefined();
    expect(state.nodes["tab:2"]).toBeUndefined();
    expect(state.rootIds).toEqual(["window:10"]);
  });

  it("deletes live nodes through commands and ignores later remove events", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    runtime.broadcasts.length = 0;

    const deleteResult = await controller.handleMessage({ type: "deleteNode", nodeId: "tab:2" });
    const deleted = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expect(runtime.api.tabs.remove).toHaveBeenCalledWith([2]);
    expectCommandAck(deleteResult, true);
    expect(deleted.nodes["tab:2"]).toBeUndefined();
    expect(deleted.nodes["window:10"]?.childIds).toEqual(["tab:1"]);

    await controller.flushPendingSaves();
    const lastSave = vi.mocked(runtime.api.storage.local.set).mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(lastSave?.[STATE_KEY]).toBeUndefined();
    const persisted = await loadStateV2(runtime.api);
    expect(persisted?.nodes["tab:2"]).toBeUndefined();

    const lastBroadcast = runtime.broadcasts.at(-1) as
      | {
          type?: string;
          deletedNodeIds?: string[];
          updatedNodes?: OutlineState["nodes"][string][];
          rootIds?: string[];
        }
      | undefined;
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(1);
    expect(lastBroadcast?.type).toBe("treeStructureUpdated");
    expect(lastBroadcast?.deletedNodeIds).toEqual(["tab:2"]);
    expect(lastBroadcast?.updatedNodes?.map((node) => node.id)).toEqual(["window:10"]);
    expect(lastBroadcast?.updatedNodes?.[0]?.childIds).toEqual(["tab:1"]);
    expect(lastBroadcast?.rootIds).toEqual(["window:10"]);

    const afterRemoveEvent = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(afterRemoveEvent.nodes["tab:2"]).toBeUndefined();
    expect(afterRemoveEvent.nodes["tab:1"]?.status).toBe("live");
    expect(afterRemoveEvent.nodes["window:10"]?.childIds).toEqual(["tab:1"]);
  });

  it("deletes one live leaf without full node-table diff scans", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      Array.from({ length: 100 }, (_value, index) => ({
        id: index + 1,
        windowId: 10,
        index,
        active: index === 0,
        url: `https://delete.example/${index + 1}`,
        title: `Tab ${index + 1}`
      }))
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    const { calls, value } = await countNodeTableObjectKeys(() =>
      controller.handleMessage({ type: "deleteNode", nodeId: "tab:100" })
    );
    const deleted = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const lastBroadcast = runtime.broadcasts.at(-1) as
      | {
          type?: string;
          deletedNodeIds?: string[];
          updatedNodes?: OutlineState["nodes"][string][];
          state?: OutlineState;
        }
      | undefined;

    expectCommandAck(value, true);
    expect(calls).toBe(0);
    expect(deleted.nodes["tab:100"]).toBeUndefined();
    expect(deleted.nodes["window:10"]?.childIds.at(-1)).toBe("tab:99");
    expect(lastBroadcast?.type).toBe("treeStructureUpdated");
    expect(lastBroadcast?.deletedNodeIds).toEqual(["tab:100"]);
    expect(lastBroadcast?.updatedNodes?.map((node) => node.id)).toEqual(["window:10"]);
    expect(lastBroadcast?.state).toBeUndefined();
  });

  it("batches delete-owned live subtree removals without redundant event persistence", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          openerTabId: 1,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          url: "https://three.example/",
          title: "Three"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    const deleteResult = await controller.handleMessage({ type: "deleteNode", nodeId: "tab:1" });
    const deleted = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const afterRemoveEvents = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expect(runtime.api.tabs.remove).toHaveBeenCalledWith([2, 1]);
    expectCommandAck(deleteResult, true);
    expect(deleted.nodes["tab:1"]).toBeUndefined();
    expect(deleted.nodes["tab:2"]).toBeUndefined();
    expect(deleted.nodes["tab:3"]?.status).toBe("live");
    expect(afterRemoveEvents).toEqual(deleted);
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(1);
    await controller.flushPendingSaves();
    expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
  });

  it("accepts flatten subtree commands through the extension message path", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          openerTabId: 1,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          openerTabId: 2,
          url: "https://three.example/",
          title: "Three"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    const flattenResult = await controller.handleMessage({
      type: "flattenSubtree",
      nodeId: "window:10"
    });
    const flattened = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expectCommandAck(flattenResult, true);
    expect(flattened.rootIds).toEqual(["window:10"]);
    expect(flattened.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:2"]);
    expect(flattened.nodes["tab:1"]?.childIds).toEqual([]);
    expect(flattened.nodes["tab:2"]?.childIds).toEqual(["tab:3"]);

    const lastBroadcast = runtime.broadcasts.at(-1) as
      | {
          type?: string;
          updatedNodes?: OutlineState["nodes"][string][];
          rootIds?: string[];
          state?: OutlineState;
        }
      | undefined;
    expect(lastBroadcast?.type).toBe("treeStructureUpdated");
    expect(lastBroadcast?.updatedNodes?.map((node) => node.id).sort()).toEqual(["tab:1", "tab:2", "window:10"]);
    expect(lastBroadcast?.rootIds).toEqual(["window:10"]);
    expect(lastBroadcast?.state).toBeUndefined();
  });

  it("accepts promote children commands through the extension message path", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          openerTabId: 1,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          url: "https://three.example/",
          title: "Three"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    const promoteResult = await controller.handleMessage({
      type: "promoteChildren",
      nodeId: "tab:1"
    });
    const promoted = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expectCommandAck(promoteResult, true);
    expect(promoted.rootIds).toEqual(["window:10"]);
    expect(promoted.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:2", "tab:3"]);
    expect(promoted.nodes["tab:1"]?.childIds).toEqual([]);
    expect(promoted.nodes["tab:2"]?.parentId).toBe("window:10");
    expect(runtime.api.tabs.move).not.toHaveBeenCalled();

    expect(await controller.handleMessage({ type: "getHistoryStatus" })).toMatchObject({
      type: "historyStatus",
      canUndo: true,
      undoLabel: "Promote children"
    });

    const lastBroadcast = runtime.broadcasts.at(-1) as
      | {
          type?: string;
          updatedNodes?: OutlineState["nodes"][string][];
          rootIds?: string[];
          state?: OutlineState;
        }
      | undefined;
    expect(lastBroadcast?.type).toBe("treeStructureUpdated");
    expect(lastBroadcast?.updatedNodes?.map((node) => node.id).sort()).toEqual(["tab:1", "tab:2", "window:10"]);
    expect(lastBroadcast?.rootIds).toEqual(["window:10"]);
    expect(lastBroadcast?.state).toBeUndefined();
  });

  it("broadcasts move commands as tree structure patches", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          url: "https://three.example/",
          title: "Three"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    const result = await controller.handleMessage({
      type: "moveNode",
      nodeId: "tab:3",
      parentId: "window:10",
      index: 0
    });
    const moved = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const lastBroadcast = runtime.broadcasts.at(-1) as
      | {
          type?: string;
          updatedNodes?: OutlineState["nodes"][string][];
          rootIds?: string[];
          state?: OutlineState;
        }
      | undefined;

    expectCommandAck(result, true);
    expect(moved.nodes["window:10"]?.childIds).toEqual(["tab:3", "tab:1", "tab:2"]);
    expect(lastBroadcast?.type).toBe("treeStructureUpdated");
    expect(lastBroadcast?.updatedNodes?.map((node) => node.id).sort()).toEqual(["tab:3", "window:10"]);
    expect(lastBroadcast?.rootIds).toEqual(["window:10"]);
    expect(lastBroadcast?.state).toBeUndefined();
    await controller.flushPendingSaves();
    expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
  });

  it("broadcasts wrap-in-group commands as tree structure patches", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          openerTabId: 1,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          url: "https://three.example/",
          title: "Three"
        }
      ]
    );
    const adapter: BrowserAdapter = {
      focusTab: vi.fn(async () => undefined),
      closeTab: vi.fn(async () => undefined),
      closeTabs: vi.fn(async () => undefined),
      closeWindow: vi.fn(async () => undefined),
      restoreSession: vi.fn(async () => ({})),
      createTab: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      createWindow: vi.fn(async () => ({
        id: 42,
        focused: true,
        incognito: false
      })),
      moveTabs: vi.fn(async () => undefined)
    };
    const controller = createBackgroundController({ api: runtime.api, adapter, now: () => 1000 });
    await controller.ensureState();
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    const result = await controller.handleMessage({
      type: "wrapNodeInGroup",
      nodeId: "tab:1"
    });
    const wrapped = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const lastBroadcast = runtime.broadcasts.at(-1) as
      | {
          type?: string;
          updatedNodes?: OutlineState["nodes"][string][];
          rootIds?: string[];
          state?: OutlineState;
        }
      | undefined;

    expect(adapter.createWindow).toHaveBeenCalledWith({ tabId: 1 });
    expectCommandAck(result, true);
    expect(wrapped.nodes["window:10"]?.childIds).toEqual(["window:42", "tab:3"]);
    expect(wrapped.nodes["window:42"]?.childIds).toEqual(["tab:1"]);
    expect(wrapped.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: 42 });
    expect(lastBroadcast?.type).toBe("treeStructureUpdated");
    expect(lastBroadcast?.updatedNodes?.map((node) => node.id).sort()).toEqual([
      "tab:1",
      "tab:2",
      "window:10",
      "window:42"
    ]);
    expect(lastBroadcast?.rootIds).toEqual(["window:10"]);
    expect(lastBroadcast?.state).toBeUndefined();
    await controller.flushPendingSaves();
    expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
  });

  it("broadcasts move-to-top-level commands as tree structure patches", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          openerTabId: 1,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          url: "https://three.example/",
          title: "Three"
        }
      ]
    );
    const adapter: BrowserAdapter = {
      focusTab: vi.fn(async () => undefined),
      closeTab: vi.fn(async () => undefined),
      closeTabs: vi.fn(async () => undefined),
      closeWindow: vi.fn(async () => undefined),
      restoreSession: vi.fn(async () => ({})),
      createTab: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      createWindow: vi.fn(async () => ({
        id: 42,
        focused: true,
        incognito: false
      })),
      moveTabs: vi.fn(async () => undefined)
    };
    const controller = createBackgroundController({ api: runtime.api, adapter, now: () => 1000 });
    await controller.ensureState();
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    const result = await controller.handleMessage({
      type: "moveSubtreeToTopLevel",
      nodeId: "tab:1"
    });
    const moved = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const lastBroadcast = runtime.broadcasts.at(-1) as
      | {
          type?: string;
          updatedNodes?: OutlineState["nodes"][string][];
          rootIds?: string[];
          state?: OutlineState;
        }
      | undefined;

    expect(adapter.createWindow).toHaveBeenCalledWith({ tabId: 1 });
    expect(adapter.moveTabs).toHaveBeenCalledWith([2], { windowId: 42, index: 1 });
    expectCommandAck(result, true);
    expect(moved.rootIds).toEqual(["window:10", "window:42"]);
    expect(moved.nodes["window:10"]?.childIds).toEqual(["tab:3"]);
    expect(moved.nodes["window:42"]?.childIds).toEqual(["tab:1"]);
    expect(moved.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: 42 });
    expect(lastBroadcast?.type).toBe("treeStructureUpdated");
    expect(lastBroadcast?.updatedNodes?.map((node) => node.id).sort()).toEqual([
      "tab:1",
      "tab:2",
      "window:10",
      "window:42"
    ]);
    expect(lastBroadcast?.rootIds).toEqual(["window:10", "window:42"]);
    expect(lastBroadcast?.state).toBeUndefined();
    expect(await controller.handleMessage({ type: "getHistoryStatus" })).toMatchObject({
      type: "historyStatus",
      canUndo: true,
      undoLabel: "Move to top level"
    });
    await controller.flushPendingSaves();
    expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
  });

  it("absorbs focus and activation echoes from live-tab grouping without a full runtime refresh", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const adapter: BrowserAdapter = {
      focusTab: vi.fn(async () => undefined),
      closeTab: vi.fn(async () => undefined),
      closeTabs: vi.fn(async () => undefined),
      closeWindow: vi.fn(async () => undefined),
      restoreSession: vi.fn(async () => ({})),
      createTab: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      createWindow: vi.fn(async ({ tabId }) => {
        const createdWindow = createWindowFromBrowser(runtime, { tabId });
        const movedTab = createdWindow.tabs?.[0];
        runtime.events.windowFocusChanged.dispatch(createdWindow.id);
        if (movedTab) {
          runtime.events.tabUpdated.dispatch(movedTab.id, {
            windowId: movedTab.windowId,
            index: movedTab.index
          }, movedTab);
          runtime.events.tabActivated.dispatch({
            tabId: movedTab.id,
            windowId: movedTab.windowId,
            previousTabId: 1
          });
        }
        return createdWindow;
      }),
      moveTabs: vi.fn(async () => undefined)
    };
    const controller = createBackgroundController({ api: runtime.api, adapter, now: () => 1000 });
    await controller.ensureState();
    vi.mocked(runtime.api.windows.getAll).mockClear();
    vi.mocked(runtime.api.tabs.query).mockClear();

    expectCommandAck(await controller.handleMessage({ type: "wrapNodeInGroup", nodeId: "tab:1" }), true);
    await Promise.all([
      runtime.events.windowFocusChanged.flush(),
      runtime.events.tabUpdated.flush(),
      runtime.events.tabActivated.flush()
    ]);
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expect(state.nodes["window:11"]?.active).toBe(true);
    expect(state.nodes["tab:1"]?.active).toBe(true);
    expect(runtime.api.windows.getAll).not.toHaveBeenCalled();
    expect(runtime.api.tabs.query).not.toHaveBeenCalled();
  });

  it("keeps nested live windows in their own runtime window when grouping an ancestor tab", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await createTabFromBrowser(runtime, {
      id: 100,
      windowId: 10,
      index: 2,
      active: true,
      openerTabId: 1,
      url: "https://child.example/",
      title: "Child"
    });
    await controller.handleMessage({ type: "wrapNodeInGroup", nodeId: "tab:100" });
    const childGrouped = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const childWindowId = childGrouped.nodes["tab:100"]?.live?.windowId;

    await controller.handleMessage({ type: "wrapNodeInGroup", nodeId: "tab:1" });

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const childRuntimeTab = runtime.tabs.find((tab) => tab.id === 100);
    const childOwnerWindow = nearestWindowNode(state, "tab:100");

    expect(typeof childWindowId).toBe("number");
    expect(childRuntimeTab?.windowId).toBe(childWindowId);
    expect(state.nodes["tab:100"]?.live).toEqual({ tabId: 100, windowId: childWindowId });
    expect(childOwnerWindow?.live).toEqual({ windowId: childWindowId });
  });

  it("ignores unknown extension message command types", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    const broadcastsBefore = runtime.broadcasts.length;
    const savesBefore = vi.mocked(runtime.api.storage.local.set).mock.calls.length;

    const result = await controller.handleMessage({ type: "notACommand" });

    expect(result).toBeUndefined();
    expect(runtime.broadcasts).toHaveLength(broadcastsBefore);
    expect(vi.mocked(runtime.api.storage.local.set).mock.calls).toHaveLength(savesBefore);
  });

  it("acknowledges state-unchanged focus commands without saving or broadcasting", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const adapter: BrowserAdapter = {
      focusTab: vi.fn(async () => undefined),
      closeTab: vi.fn(async () => undefined),
      closeTabs: vi.fn(async () => undefined),
      closeWindow: vi.fn(async () => undefined),
      restoreSession: vi.fn(async () => ({})),
      createTab: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      createWindow: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      moveTabs: vi.fn(async () => undefined)
    };
    const controller = createBackgroundController({ api: runtime.api, adapter, now: () => 1000 });
    await controller.ensureState();
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    const result = await controller.handleMessage({ type: "focusNode", nodeId: "tab:1" });

    expect(adapter.focusTab).toHaveBeenCalledWith(1, 10);
    expectCommandAck(result, false);
    expect(runtime.broadcasts).toHaveLength(0);
    expect(vi.mocked(runtime.api.storage.local.set)).not.toHaveBeenCalled();
  });

  it("broadcasts command mutations even when the state object is reused", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    const result = await controller.handleMessage({ type: "toggleCollapsed", nodeId: "tab:1" });
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const lastBroadcast = runtime.broadcasts.at(-1) as
      | { type?: string; updatedNodes?: OutlineState["nodes"][string][]; state?: OutlineState }
      | undefined;

    expectCommandAck(result, true);
    expect(state.nodes["tab:1"]?.collapsed).toBe(true);
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(1);
    expect(lastBroadcast?.type).toBe("nodeStateUpdated");
    expect(lastBroadcast?.updatedNodes?.[0]).toMatchObject({ id: "tab:1", collapsed: true });
    expect(lastBroadcast?.state).toBeUndefined();
    await controller.flushPendingSaves();
    expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
  });

  it("broadcasts ancestor expansion as one node state patch and one undoable command", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          url: "https://three.example/",
          title: "Three"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    const state = await controller.ensureState();
    state.nodes["window:10"]!.childIds = ["tab:1"];
    state.nodes["window:10"]!.collapsed = true;
    state.nodes["tab:1"]!.parentId = "window:10";
    state.nodes["tab:1"]!.childIds = ["tab:2"];
    state.nodes["tab:1"]!.collapsed = true;
    state.nodes["tab:2"]!.parentId = "tab:1";
    state.nodes["tab:2"]!.childIds = ["tab:3"];
    state.nodes["tab:2"]!.collapsed = true;
    state.nodes["tab:3"]!.parentId = "tab:2";
    state.nodes["tab:3"]!.childIds = [];
    await controller.flushPendingSaves();
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    const result = await controller.handleMessage({ type: "expandAncestors", nodeId: "tab:3" });
    const after = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const patchBroadcasts = stateBroadcasts(runtime.broadcasts) as Array<{
      type?: string;
      updatedNodes?: OutlineState["nodes"][string][];
      state?: OutlineState;
    }>;

    expectCommandAck(result, true);
    expect(after.nodes["window:10"]?.collapsed).toBe(false);
    expect(after.nodes["tab:1"]?.collapsed).toBe(false);
    expect(after.nodes["tab:2"]?.collapsed).toBe(false);
    expect(patchBroadcasts).toHaveLength(1);
    expect(patchBroadcasts[0]?.type).toBe("nodeStateUpdated");
    expect(patchBroadcasts[0]?.updatedNodes?.map((node) => node.id)).toEqual(["window:10", "tab:1", "tab:2"]);
    expect(patchBroadcasts[0]?.state).toBeUndefined();
    expect(await controller.handleMessage({ type: "getHistoryStatus" })).toMatchObject({
      type: "historyStatus",
      canUndo: true,
      undoLabel: "Expand"
    });

    await controller.flushPendingSaves();
    expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
  });

  it("broadcasts group renames as node state patches", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    const result = await controller.handleMessage({
      type: "renameGroup",
      nodeId: "window:10",
      title: "Research"
    });
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const lastBroadcast = runtime.broadcasts.at(-1) as
      | { type?: string; updatedNodes?: OutlineState["nodes"][string][]; state?: OutlineState }
      | undefined;

    expectCommandAck(result, true);
    expect(state.nodes["window:10"]?.title).toBe("Research");
    expect(stateBroadcasts(runtime.broadcasts)).toHaveLength(1);
    expect(lastBroadcast?.type).toBe("nodeStateUpdated");
    expect(lastBroadcast?.updatedNodes?.[0]).toMatchObject({
      id: "window:10",
      title: "Research",
      customTitle: "Research"
    });
    expect(lastBroadcast?.state).toBeUndefined();
    await controller.flushPendingSaves();
    expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
  });

  it("deletes the window node when its only live tab is deleted by command", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    const deleteResult = await controller.handleMessage({ type: "deleteNode", nodeId: "tab:1" });
    const deleted = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expect(runtime.api.tabs.remove).toHaveBeenCalledWith([1]);
    expectCommandAck(deleteResult, true);
    expect(deleted.nodes["tab:1"]).toBeUndefined();
    expect(deleted.nodes["window:10"]).toBeUndefined();
    expect(deleted.rootIds).toEqual([]);

    await controller.flushPendingSaves();
    const lastSave = vi.mocked(runtime.api.storage.local.set).mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(lastSave?.[STATE_KEY]).toBeUndefined();
    const persisted = await loadStateV2(runtime.api);
    expect(persisted?.nodes["window:10"]).toBeUndefined();

    const lastBroadcast = runtime.broadcasts.at(-1) as
      | { type?: string; deletedNodeIds?: string[]; rootIds?: string[] }
      | undefined;
    expect(lastBroadcast?.type).toBe("treeStructureUpdated");
    expect(lastBroadcast?.deletedNodeIds?.sort()).toEqual(["tab:1", "window:10"]);
    expect(lastBroadcast?.rootIds).toEqual([]);

    const afterRemoveEvent = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(afterRemoveEvent.nodes["tab:1"]).toBeUndefined();
    expect(afterRemoveEvent.nodes["window:10"]).toBeUndefined();
    expect(afterRemoveEvent.rootIds).toEqual([]);
  });

  it("tracks structural commands and undoes/redoes them through the controller", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    runtime.broadcasts.length = 0;

    expect(await controller.handleMessage({ type: "getHistoryStatus" })).toMatchObject({
      type: "historyStatus",
      canUndo: false,
      canRedo: false
    });

    expectCommandAck(await controller.handleMessage({
      type: "renameGroup",
      nodeId: "window:10",
      title: "Research"
    }), true);
    expect(await controller.handleMessage({ type: "getHistoryStatus" })).toMatchObject({
      type: "historyStatus",
      canUndo: true,
      canRedo: false,
      undoLabel: "Rename"
    });

    expectCommandAck(await controller.handleMessage({ type: "undo" }), true);
    let state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["window:10"]?.title).toBe("Group");
    expect(await controller.handleMessage({ type: "getHistoryStatus" })).toMatchObject({
      type: "historyStatus",
      canUndo: false,
      canRedo: true,
      redoLabel: "Rename"
    });

    expectCommandAck(await controller.handleMessage({ type: "redo" }), true);
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["window:10"]?.title).toBe("Research");
    expect(runtime.broadcasts.map((message) => (message as { type?: string }).type)).toContain("historyStatus");
  });

  it("persists undo history across controller restarts", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const firstController = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await firstController.ensureState();
    await firstController.handleMessage({
      type: "renameGroup",
      nodeId: "window:10",
      title: "Research"
    });
    await firstController.flushPendingSaves();

    const secondController = createBackgroundController({ api: runtime.api, now: () => 2000 });
    await secondController.ensureState();

    expect(await secondController.handleMessage({ type: "getHistoryStatus" })).toMatchObject({
      type: "historyStatus",
      canUndo: true,
      undoLabel: "Rename"
    });
    expectCommandAck(await secondController.handleMessage({ type: "undo" }), true);
    const undone = (await secondController.handleMessage({ type: "getState" })) as OutlineState;
    expect(undone.nodes["window:10"]?.title).toBe("Group");
  });

  it("trims loaded undo history when the history length preference changes", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    for (let index = 0; index < 4; index += 1) {
      expectCommandAck(await controller.handleMessage({
        type: "renameGroup",
        nodeId: "window:10",
        title: `Research ${index}`
      }), true);
    }
    expect(await controller.handleMessage({ type: "getHistoryStatus" })).toMatchObject({
      type: "historyStatus",
      undoDepth: 4
    });

    vi.mocked(runtime.api.storage.local.set).mockClear();
    await runtime.api.storage.local.set({
      [APP_PREFERENCES_STORAGE_KEY]: {
        ...DEFAULT_APP_PREFERENCES,
        undoHistoryLimit: 2
      }
    });
    await runtime.events.storageChanged.flush();

    expect(await controller.handleMessage({ type: "getHistoryStatus" })).toMatchObject({
      type: "historyStatus",
      undoDepth: 2
    });

    await controller.flushPendingSaves();
    const lastSave = vi.mocked(runtime.api.storage.local.set).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect((lastSave[HISTORY_KEY] as { undoStack?: unknown[] }).undoStack).toHaveLength(2);
  });

  it("does not add runtime refreshes to undo history", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    await updateTabFromBrowser(runtime, 1, {
      title: "One updated",
      url: "https://one.example/updated"
    });

    expect(await controller.handleMessage({ type: "getHistoryStatus" })).toMatchObject({
      type: "historyStatus",
      canUndo: false,
      canRedo: false
    });
  });

  it("undoes and redoes live delete commands by recreating and reclosing tabs", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "https://two.example/",
          title: "Two"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    expectCommandAck(await controller.handleMessage({ type: "deleteNode", nodeId: "tab:2" }), true);
    let state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:2"]).toBeUndefined();
    expect(runtime.tabs.map((tab) => tab.id).sort((a, b) => a - b)).toEqual([1]);

    expectCommandAck(await controller.handleMessage({ type: "undo" }), true);
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const recreatedTabId = state.nodes["tab:2"]?.live && "tabId" in state.nodes["tab:2"]!.live!
      ? state.nodes["tab:2"]!.live!.tabId
      : undefined;
    expect(state.nodes["tab:2"]).toMatchObject({
      id: "tab:2",
      status: "live",
      title: "Two",
      live: {
        windowId: 10
      }
    });
    expect(runtime.api.tabs.create).toHaveBeenCalledWith({
      url: "https://two.example/",
      windowId: 10,
      active: false
    });
    expect(recreatedTabId).toBeDefined();
    expect(runtime.tabs.map((tab) => tab.id).sort((a, b) => a - b)).toEqual([1, recreatedTabId]);

    expectCommandAck(await controller.handleMessage({ type: "redo" }), true);
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:2"]).toBeUndefined();
    expect(runtime.tabs.map((tab) => tab.id).sort((a, b) => a - b)).toEqual([1]);
  });

  it("undoes and redoes collapse, move, flatten, and grouping commands", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://one.example/",
          title: "One"
        },
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          openerTabId: 1,
          url: "https://two.example/",
          title: "Two"
        },
        {
          id: 3,
          windowId: 10,
          index: 2,
          active: false,
          openerTabId: 2,
          url: "https://three.example/",
          title: "Three"
        }
      ]
    );
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    let state: OutlineState;

    expectCommandAck(await controller.handleMessage({ type: "toggleCollapsed", nodeId: "window:10" }), true);
    expect(((await controller.handleMessage({ type: "getState" })) as OutlineState).nodes["window:10"]?.collapsed).toBe(true);
    expectCommandAck(await controller.handleMessage({ type: "undo" }), true);
    expect(((await controller.handleMessage({ type: "getState" })) as OutlineState).nodes["window:10"]?.collapsed).toBe(false);
    expectCommandAck(await controller.handleMessage({ type: "redo" }), true);
    expect(((await controller.handleMessage({ type: "getState" })) as OutlineState).nodes["window:10"]?.collapsed).toBe(true);

    expectCommandAck(await controller.handleMessage({
      type: "moveNode",
      nodeId: "tab:3",
      parentId: "window:10",
      index: 0
    }), true);
    expect(((await controller.handleMessage({ type: "getState" })) as OutlineState).nodes["window:10"]?.childIds[0]).toBe("tab:3");
    expectCommandAck(await controller.handleMessage({ type: "undo" }), true);
    expect(((await controller.handleMessage({ type: "getState" })) as OutlineState).nodes["tab:2"]?.childIds).toEqual(["tab:3"]);
    expectCommandAck(await controller.handleMessage({ type: "redo" }), true);
    expect(((await controller.handleMessage({ type: "getState" })) as OutlineState).nodes["window:10"]?.childIds[0]).toBe("tab:3");

    expectCommandAck(await controller.handleMessage({ type: "flattenSubtree", nodeId: "window:10" }), true);
    expect(((await controller.handleMessage({ type: "getState" })) as OutlineState).nodes["tab:1"]?.childIds).toEqual([]);
    expectCommandAck(await controller.handleMessage({ type: "undo" }), true);
    expect(((await controller.handleMessage({ type: "getState" })) as OutlineState).nodes["tab:1"]?.childIds).toEqual(["tab:2"]);
    expectCommandAck(await controller.handleMessage({ type: "redo" }), true);
    expect(((await controller.handleMessage({ type: "getState" })) as OutlineState).nodes["tab:1"]?.childIds).toEqual([]);
    expectCommandAck(await controller.handleMessage({ type: "undo" }), true);
    expect(((await controller.handleMessage({ type: "getState" })) as OutlineState).nodes["tab:1"]?.childIds).toEqual(["tab:2"]);

    expectCommandAck(await controller.handleMessage({ type: "promoteChildren", nodeId: "tab:1" }), true);
    expect(await controller.handleMessage({ type: "getHistoryStatus" })).toMatchObject({
      type: "historyStatus",
      undoLabel: "Promote children"
    });
    expect(((await controller.handleMessage({ type: "getState" })) as OutlineState).nodes["tab:1"]?.childIds).toEqual([]);
    expectCommandAck(await controller.handleMessage({ type: "undo" }), true);
    expect(((await controller.handleMessage({ type: "getState" })) as OutlineState).nodes["tab:1"]?.childIds).toEqual(["tab:2"]);
    expectCommandAck(await controller.handleMessage({ type: "redo" }), true);
    expect(((await controller.handleMessage({ type: "getState" })) as OutlineState).nodes["tab:1"]?.childIds).toEqual([]);

    expectCommandAck(await controller.handleMessage({ type: "moveSubtreeToTopLevel", nodeId: "tab:1" }), true);
    expect(await controller.handleMessage({ type: "getHistoryStatus" })).toMatchObject({
      type: "historyStatus",
      undoLabel: "Move to top level"
    });
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const topLevelWrapperId = state.nodes["tab:1"]?.parentId;
    expect(topLevelWrapperId).toBeDefined();
    expect(state.nodes[topLevelWrapperId!]?.kind).toBe("window");
    expect(state.nodes[topLevelWrapperId!]?.parentId).toBeUndefined();
    expectCommandAck(await controller.handleMessage({ type: "undo" }), true);
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes[topLevelWrapperId!]).toBeUndefined();
    expect(state.nodes["tab:1"]?.parentId).toBe("window:10");
    expectCommandAck(await controller.handleMessage({ type: "redo" }), true);
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes[topLevelWrapperId!]?.parentId).toBeUndefined();
    expect(state.nodes["tab:1"]?.parentId).toBe(topLevelWrapperId);
    expectCommandAck(await controller.handleMessage({ type: "undo" }), true);
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:1"]?.parentId).toBe("window:10");

    expectCommandAck(await controller.handleMessage({ type: "wrapNodeInGroup", nodeId: "tab:1" }), true);
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const wrapperId = state.nodes["tab:1"]?.parentId;
    expect(wrapperId).toBeDefined();
    expect(state.nodes[wrapperId!]?.kind).toBe("window");
    expectCommandAck(await controller.handleMessage({ type: "undo" }), true);
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes[wrapperId!]).toBeUndefined();
    expect(state.nodes["tab:1"]?.parentId).toBe("window:10");
    expectCommandAck(await controller.handleMessage({ type: "redo" }), true);
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes[wrapperId!]?.kind).toBe("window");
    expect(state.nodes["tab:1"]?.parentId).toBe(wrapperId);
  });

  it("undoes and redoes imports and closed-node deletes", async () => {
    const runtime = fakeRuntime([], []);
    const controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    expectCommandAck(await controller.handleMessage({
      type: "importTree",
      tree: {
        schema: PORTABLE_TREE_SCHEMA,
        version: 1,
        exportedAt: "2026-05-18T12:00:00.000Z",
        roots: [
          {
            kind: "tab",
            title: "Imported",
            url: "https://imported.example/",
            children: []
          }
        ]
      }
    }), true);
    let state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const importedTabId = Object.values(state.nodes).find((node) => node.title === "Imported")?.id;
    expect(importedTabId).toBeDefined();

    expectCommandAck(await controller.handleMessage({ type: "undo" }), true);
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(Object.values(state.nodes).some((node) => node.title === "Imported")).toBe(false);
    expectCommandAck(await controller.handleMessage({ type: "redo" }), true);
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes[importedTabId!]?.title).toBe("Imported");

    expectCommandAck(await controller.handleMessage({ type: "deleteNode", nodeId: importedTabId! }), true);
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes[importedTabId!]).toBeUndefined();
    expectCommandAck(await controller.handleMessage({ type: "undo" }), true);
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes[importedTabId!]?.status).toBe("closed");
    expectCommandAck(await controller.handleMessage({ type: "redo" }), true);
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes[importedTabId!]).toBeUndefined();
  });
});
