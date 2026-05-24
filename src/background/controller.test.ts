import { describe, expect, it, vi } from "vitest";

import type { BrowserAdapter } from "./adapter.js";
import {
  AUTOMATIC_BACKUP_ALARM_NAME,
  AUTOMATIC_BACKUP_STATUS_STORAGE_KEY
} from "./backups.js";
import { createBackgroundController, type BackgroundController } from "./controller.js";
import type { CommandAck } from "./commands.js";
import { RUNTIME_LIFECYCLE_JOURNAL_KEY } from "./runtime-lifecycle-journal.js";
import { HISTORY_KEY, STATE_KEY, loadStateV2, outlineStateV2Items, outlineStateV3Changes } from "./storage.js";
import { PORTABLE_TREE_SCHEMA } from "../model/portable-tree.js";
import { runtimeTitleForOutlineTab } from "../model/outline.js";
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

  clearListeners(): void {
    this.listeners = [];
  }

  clearPending(): void {
    this.pending = [];
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
    tabAttached: FakeEvent<[number, { newWindowId: number; newPosition: number }]>;
    tabDetached: FakeEvent<[number, { oldWindowId: number; oldPosition: number }]>;
    tabMoved: FakeEvent<[number, { windowId: number; fromIndex: number; toIndex: number }]>;
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

function storageSetCallsExcludingLifecycleJournal(runtime: FakeRuntime): unknown[][] {
  return vi.mocked(runtime.api.storage.local.set).mock.calls.filter(
    ([items]) => !isLifecycleJournalOnlyStorageSet(items)
  );
}

function isLifecycleJournalOnlyStorageSet(items: unknown): boolean {
  if (!items || typeof items !== "object" || Array.isArray(items)) {
    return false;
  }
  const keys = Object.keys(items);
  return keys.length === 1 && keys[0] === RUNTIME_LIFECYCLE_JOURNAL_KEY;
}

function fakeRuntime(windows: RuntimeWindow[], tabs: RuntimeTab[], options: FakeRuntimeOptions = {}): FakeRuntime {
  const alarm = new FakeEvent<[FakeAlarm]>();
  const installed = new FakeEvent<[]>();
  const startup = new FakeEvent<[]>();
  const tabCreated = new FakeEvent<[RuntimeTab]>();
  const tabActivated = new FakeEvent<[{ tabId: number; windowId: number; previousTabId?: number }]>();
  const tabAttached = new FakeEvent<[number, { newWindowId: number; newPosition: number }]>();
  const tabDetached = new FakeEvent<[number, { oldWindowId: number; oldPosition: number }]>();
  const tabMoved = new FakeEvent<[number, { windowId: number; fromIndex: number; toIndex: number }]>();
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
      tabAttached,
      tabDetached,
      tabMoved,
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
        onAttached: tabAttached as never,
        onCreated: tabCreated as never,
        onDetached: tabDetached as never,
        onMoved: tabMoved as never,
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

function removeRuntimeTabWithoutEvents(runtime: FakeRuntime, tabId: number): void {
  const tab = runtime.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) {
    return;
  }
  runtime.tabs = runtime.tabs.filter((candidate) => candidate.id !== tabId);
  reindexWindowTabs(runtime, tab.windowId);
  removeEmptyRuntimeWindows(runtime, [tab.windowId]);
}

function removeRuntimeWindowWithoutEvents(runtime: FakeRuntime, windowId: number): void {
  runtime.tabs = runtime.tabs.filter((candidate) => candidate.windowId !== windowId);
  runtime.windows = runtime.windows.filter((candidate) => candidate.id !== windowId);
  if (!runtime.windows.some((candidate) => candidate.focused) && runtime.windows[0]) {
    runtime.windows = runtime.windows.map((candidate, index) => ({
      ...candidate,
      focused: index === 0
    }));
  }
}

function restartControllerAbrupt(runtime: FakeRuntime, now: () => number = () => 1000): BackgroundController {
  clearFakeRuntimeListeners(runtime);
  return createBackgroundController({ api: runtime.api, now });
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
  now: number;
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
type RuntimeDomainTraceAssertion = "runtimeOrder" | "runtimeMetadata";

type RuntimeDomainTrace = {
  id: string;
  title: string;
  notes: string;
  purpose: RuntimeDomainTracePurpose;
  origin: RuntimeDomainTraceOrigin;
  tags: string[];
  assertions?: RuntimeDomainTraceAssertion[];
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
      url?: string;
      favIconUrl?: string;
    }
  | {
      type: "focusWindow";
      window: DomainWindowSelector;
    };

type DomainNativeOpenWindowTab = {
  active?: boolean;
  title?: string;
  url?: string;
  openerTab?: DomainTabSelector;
};

type DomainAction =
  | DomainRuntimeEventAction
  | {
      type: "nativeOpenWindow";
      tabs: DomainNativeOpenWindowTab[];
      focused?: boolean;
      captureWindow?: string;
      captureTabs?: string;
    }
  | {
      type: "nativeMoveTabToWindow";
      tab: DomainTabSelector;
      window: DomainWindowSelector;
      index?: number;
      active?: boolean;
      captureStaleTabs?: string;
    }
  | {
      type: "nativeMoveTabToNewWindow";
      tab: DomainTabSelector;
      active?: boolean;
      captureWindow?: string;
      captureStaleTabs?: string;
    }
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
      type: "outlinerGroupTabThenAbruptRestart";
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
      type: "outlinerMoveTabCommandToNewWindowThenAbruptRestart";
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
      type: "outlinerMoveSubtreeToTopLevelThenAbruptRestart";
      tab: DomainTabSelector;
      captureStaleTabs?: string;
    }
  | {
      type: "outlinerFocusTab";
      tab: DomainTabSelector;
    }
  | {
      type: "outlinerFocusTabRejectingUpdate";
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
      type: "outlinerCloseNodeRejectingClose";
      node: DomainNodeSelector;
    }
  | {
      type: "outlinerCloseNodeThenAbruptRestart";
      node: DomainNodeSelector;
      captureStaleTabs?: string;
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
      type: "outlinerDeleteNodeThenAbruptRestart";
      node: DomainNodeSelector;
      captureStaleTabs?: string;
    }
  | {
      type: "outlinerRestoreDeleteWindowDelayedEvent";
      window: DomainWindowSelector;
      captureStaleTabs?: string;
    }
  | {
      type: "outlinerRestoreNodeRejectingCreate";
      node: DomainNodeSelector;
      captureRestoredTabs?: string;
      captureRestoredWindows?: string;
    }
  | {
      type: "outlinerRestoreNodeThenAbruptRestart";
      node: DomainNodeSelector;
      captureRestoredTabs?: string;
      captureRestoredWindows?: string;
    }
  | {
      type: "injectCloseJournalThenAbruptRestart";
      node: DomainNodeSelector;
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
      type: "restartBackground";
    }
  | {
      type: "restartBackgroundAbrupt";
    }
  | {
      type: "outlinerUndo";
    }
  | {
      type: "outlinerRedo";
    }
  | {
      type: "outlinerUndoThenAbruptRestart";
    }
  | {
      type: "outlinerRedoThenAbruptRestart";
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
  },
  {
    id: "dh-restart-relocation-old-updated",
    title: "restart relocation old updated",
    notes: "Architecture-stress probe for relocation guard reconstruction when stale old-window update evidence arrives after restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "relocation", "tombstone", "stale-event", "partial-snapshot"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "restart-relocation-old-updated-old" },
      { type: "restartBackground" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "restart-relocation-old-updated-old" }, withStaleQuery: true },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "lastOpenedWindow" } }
    ]
  },
  {
    id: "dh-restart-relocation-current-then-old-created",
    title: "restart relocation current then old created",
    notes: "Architecture-stress probe where current-window metadata is observed before restart and stale old-window creation arrives after.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "relocation", "stale-event", "metadata"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "restart-current-old-created-old" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Current after relocation" },
      { type: "restartBackground" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "restart-current-old-created-old" }, withStaleQuery: false },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-destination-close-stale-old",
    title: "restart destination close stale old",
    notes: "Architecture-stress probe for destination window removal, lost ephemeral relocation guards, and stale old-window evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "relocation", "native-close", "tombstone", "stale-event", "session"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "restart-destination-close-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "windowRemovedOnly" },
      { type: "restartBackground" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "restart-destination-close-old" }, withStaleQuery: true },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "dh-restart-source-close-missing-destination",
    title: "restart source close missing destination",
    notes: "Architecture-stress probe for source-window tab-only close before restart and a missing destination snapshot after.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "relocation", "native-close", "partial-snapshot", "stale-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "restart-source-close-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "tabsRemovedOnly" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "lastOpenedWindow" } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "restart-source-close-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-restart-restore-redo-delayed-echo",
    title: "restart restore redo delayed echo",
    notes: "Architecture-stress probe for restored-delete delayed events crossing history replay and background restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "restore", "undo-redo", "tombstone", "stale-event", "partial-snapshot", "session"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 }, captureStaleTabs: "restart-restore-redo-delayed" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "restartBackground" },
      { type: "sessionChanged" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "restart-restore-redo-delayed" }, withStaleQuery: false },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } }
    ]
  },
  {
    id: "dh-restart-delete-reject-relocation",
    title: "restart delete reject relocation",
    notes: "Architecture-stress probe for create-window relocation side effects that reject, then restart before stale source evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "command-rejection", "relocation", "partial-snapshot", "stale-event"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "restart-delete-reject-tab" },
      { type: "outlinerMoveTabCommandToNewWindowRejectingCreate", tab: { capture: "restart-delete-reject-tab" }, captureStaleTabs: "restart-delete-reject-old" },
      { type: "restartBackground" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "restart-delete-reject-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-restart-focus-command-activation",
    title: "restart focus command activation",
    notes: "Architecture-stress probe for command focus facts reconstructed before activation and reordered destination evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "relocation", "focus", "activation", "partial-snapshot"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "restart-focus-command-old" },
      { type: "outlinerFocusTab", tab: { role: "lastMovedTab" } },
      { type: "restartBackground" },
      { type: "activateTab", tab: { role: "lastMovedTab" } },
      { type: "manualRefreshWithReorderedQuery", window: { role: "lastOpenedWindow" }, order: "reverse" }
    ]
  },
  {
    id: "dh-opener-chain-restart-source-close",
    title: "opener chain restart source close",
    notes: "Architecture-stress probe for opener chains when the deepest child relocates and source-window evidence arrives after restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "opener", "relocation", "native-close", "stale-event"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "restart-opener-chain-child" },
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { capture: "restart-opener-chain-child" }, captureTab: "restart-opener-chain-grandchild" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "restart-opener-chain-grandchild" }, captureStaleTabs: "restart-opener-chain-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "windowRemovedOnly" },
      { type: "restartBackground" },
      { type: "manualRefresh" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "restart-opener-chain-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-restore-native-close-after-restart",
    title: "restore native close after restart",
    notes: "Architecture-stress probe for restored-window lifecycle reconstructed before native close and stale restored-tab echo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "restore", "native-close", "tombstone", "stale-event"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 }, captureStaleTabs: "restart-restore-native-close" },
      { type: "outlinerUndo" },
      { type: "restartBackground" },
      { type: "nativeCloseWindow", window: { role: "focusedWindow" }, order: "windowRemovedOnly" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "restart-restore-native-close" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-session-only-tab-close-after-restart-query",
    title: "session only tab close after restart query",
    notes: "Architecture-stress probe for a session-only disappearance reconstructed before a reordered source-window refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "native-close", "session", "partial-snapshot", "activation"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "restart-session-only-extra" },
      { type: "nativeCloseTab", tab: { tabId: 2 }, order: "sessionChangedOnly" },
      { type: "restartBackground" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" },
      { type: "activateTab", tab: { capture: "restart-session-only-extra" } }
    ]
  },
  {
    id: "dh-restart-paired-old-events-after-current-refresh",
    title: "restart paired old events after current refresh",
    notes: "Architecture-stress probe for a complete current refresh before restart followed by paired stale old-window echoes.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "relocation", "stale-event", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "restart-paired-old-events-old" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Fresh before restart" },
      { type: "manualRefresh" },
      { type: "restartBackground" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "restart-paired-old-events-old" }, withStaleQuery: false },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "restart-paired-old-events-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-nested-restart-missing-background",
    title: "nested restart missing background",
    notes: "Architecture-stress probe for grouped relocation, focus/session churn, restart, and a missing background-window query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "nested", "relocation", "focus", "session", "partial-snapshot", "stale-event"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "nested-restart-background-extra" },
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "nested-restart-missing-background-old" },
      { type: "focusWindow", window: { role: "lastOpenedWindow" } },
      { type: "sessionChanged" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 20 } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "nested-restart-missing-background-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-restart-destination-tabs-only-stale-created",
    title: "restart destination tabs only stale created",
    notes: "Mutation probe for destination close that emits only tab removals before restart, then stale source creation evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "relocation", "native-close", "event-order", "stale-event", "tombstone"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "restart-destination-tabs-only-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "tabsRemovedOnly" },
      { type: "restartBackground" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "restart-destination-tabs-only-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-restart-destination-window-first-paired-old",
    title: "restart destination window first paired old",
    notes: "Mutation probe for window-first destination close followed by paired stale old-window echoes after restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "relocation", "native-close", "event-order", "stale-event", "paired-echo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "restart-destination-window-first-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "windowRemovedThenTabsRemoved" },
      { type: "restartBackground" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "restart-destination-window-first-old" }, withStaleQuery: false },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "restart-destination-window-first-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-restart-relocated-tab-session-only-stale",
    title: "restart relocated tab session only stale",
    notes: "Mutation probe for a relocated tab disappearing via session-only tab close before stale old-window evidence arrives after restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "relocation", "native-close", "session", "stale-event", "tombstone"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "restart-relocated-session-only-old" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "sessionChangedOnly" },
      { type: "restartBackground" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "restart-relocated-session-only-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-restart-relocated-tab-removed-only-stale",
    title: "restart relocated tab removed only stale",
    notes: "Mutation probe for a relocated tab disappearing via tabRemoved-only evidence before restart and stale source evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "relocation", "native-close", "event-order", "stale-event", "tombstone"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "restart-relocated-tab-only-old" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "tabRemovedOnly" },
      { type: "restartBackground" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "restart-relocated-tab-only-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-restart-restore-native-tabs-only-stale",
    title: "restart restore native tabs only stale",
    notes: "Mutation probe for restored-window native close with tab-removal-only evidence after restart and delayed restored-tab echo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "restore", "native-close", "event-order", "stale-event", "tombstone"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 }, captureStaleTabs: "restart-restore-tabs-only" },
      { type: "outlinerUndo" },
      { type: "restartBackground" },
      { type: "nativeCloseWindow", window: { role: "focusedWindow" }, order: "tabsRemovedOnly" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "restart-restore-tabs-only" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-restart-restore-native-window-first-stale",
    title: "restart restore native window first stale",
    notes: "Mutation probe for restored-window native close with window-first event order after restart and stale update echo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "restore", "native-close", "event-order", "stale-event", "tombstone"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 }, captureStaleTabs: "restart-restore-window-first" },
      { type: "outlinerUndo" },
      { type: "restartBackground" },
      { type: "nativeCloseWindow", window: { role: "focusedWindow" }, order: "windowRemovedThenTabsRemoved" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "restart-restore-window-first" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-restart-reject-destination-close-stale-old",
    title: "restart reject destination close stale old",
    notes: "Mutation probe for create-window relocation rejection, destination close, restart, and stale old-window evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "command-rejection", "relocation", "native-close", "stale-event", "tombstone"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "restart-reject-destination-close-tab" },
      { type: "outlinerMoveTabCommandToNewWindowRejectingCreate", tab: { capture: "restart-reject-destination-close-tab" }, captureStaleTabs: "restart-reject-destination-close-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "windowRemovedOnly" },
      { type: "restartBackground" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "restart-reject-destination-close-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-restart-reject-destination-missing-query",
    title: "restart reject destination missing query",
    notes: "Mutation probe for rejected relocation side effects followed by restart and missing-destination snapshot confidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "command-rejection", "relocation", "partial-snapshot", "stale-event"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "restart-reject-destination-missing-tab" },
      { type: "outlinerMoveTabCommandToNewWindowRejectingCreate", tab: { capture: "restart-reject-destination-missing-tab" }, captureStaleTabs: "restart-reject-destination-missing-old" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "lastOpenedWindow" } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "restart-reject-destination-missing-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-restart-source-window-only-stale-updated",
    title: "restart source window only stale updated",
    notes: "Mutation probe for source-window native close with only windowRemoved before restart and stale relocated-tab update.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "relocation", "native-close", "event-order", "stale-event", "stale-query"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "restart-source-window-only-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "windowRemovedOnly" },
      { type: "restartBackground" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "restart-source-window-only-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-restart-source-tabs-only-stale-created",
    title: "restart source tabs only stale created",
    notes: "Mutation probe for source-window native close with tab removals only before restart and stale old-window creation evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "relocation", "native-close", "event-order", "stale-event", "stale-query"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "restart-source-tabs-only-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "tabsRemovedOnly" },
      { type: "restartBackground" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "restart-source-tabs-only-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-restart-source-default-missing-destination",
    title: "restart source default missing destination",
    notes: "Mutation probe for source default close, restart, a partial destination snapshot, and stale old-window evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "relocation", "native-close", "partial-snapshot", "stale-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "restart-source-default-missing-destination-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "tabsRemovedThenWindowRemoved" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "lastOpenedWindow" } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "restart-source-default-missing-destination-old" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-restart-group-destination-close-stale-old",
    title: "restart group destination close stale old",
    notes: "Mutation probe for grouped relocation whose destination closes before restart and stale source evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "nested", "relocation", "native-close", "stale-event", "stale-query"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "restart-group-destination-close-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "windowRemovedOnly" },
      { type: "restartBackground" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "restart-group-destination-close-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-restart-top-level-destination-close-stale-old",
    title: "restart top level destination close stale old",
    notes: "Mutation probe for top-level relocation whose destination closes before restart and stale source creation evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "relocation", "native-close", "stale-event", "stale-query"],
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "restart-top-level-destination-close-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "windowRemovedOnly" },
      { type: "restartBackground" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "restart-top-level-destination-close-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-restart-outliner-close-destination-stale-old",
    title: "restart outliner close destination stale old",
    notes: "Mutation probe for command-owned destination close before restart followed by stale source update evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "relocation", "outliner-close", "stale-event", "stale-query", "tombstone"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "restart-outliner-close-destination-old" },
      { type: "outlinerCloseWindow", window: { role: "lastOpenedWindow" } },
      { type: "restartBackground" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "restart-outliner-close-destination-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-restart-outliner-close-tab-stale-old",
    title: "restart outliner close tab stale old",
    notes: "Mutation probe for command-owned relocated tab close before restart followed by stale source creation evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "relocation", "outliner-close", "stale-event", "stale-query", "tombstone"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "restart-outliner-close-tab-old" },
      { type: "outlinerCloseTab", tab: { role: "lastMovedTab" } },
      { type: "restartBackground" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "restart-outliner-close-tab-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-restart-focus-session-source-window-only-old",
    title: "restart focus session source window only old",
    notes: "Mutation probe for focus/session churn before source window-only native close, restart, and stale source evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "relocation", "focus", "session", "native-close", "event-order", "stale-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "restart-focus-session-source-window-only-old" },
      { type: "focusWindow", window: { role: "lastOpenedWindow" } },
      { type: "sessionChanged" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "windowRemovedOnly" },
      { type: "restartBackground" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "restart-focus-session-source-window-only-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-restart-destination-window-only-manual-stale",
    title: "restart destination window only manual stale",
    notes: "Mutation probe for stale query evidence, without a tab event, after destination window-only close and restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "relocation", "native-close", "event-order", "stale-query", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "restart-destination-window-only-manual-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "windowRemovedOnly" },
      { type: "restartBackground" },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "restart-destination-window-only-manual-old" } }
    ]
  },
  {
    id: "dh-restart-destination-tabs-only-manual-stale",
    title: "restart destination tabs only manual stale",
    notes: "Mutation probe for stale query evidence after destination tab-removal-only close and restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "relocation", "native-close", "event-order", "stale-query", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "restart-destination-tabs-only-manual-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "tabsRemovedOnly" },
      { type: "restartBackground" },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "restart-destination-tabs-only-manual-old" } }
    ]
  },
  {
    id: "dh-restart-restore-native-default-stale",
    title: "restart restore native default stale",
    notes: "Mutation probe for restored-window native close in default event order after restart and delayed stale echo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "restore", "native-close", "event-order", "stale-event", "tombstone"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 }, captureStaleTabs: "restart-restore-default" },
      { type: "outlinerUndo" },
      { type: "restartBackground" },
      { type: "nativeCloseWindow", window: { role: "focusedWindow" }, order: "tabsRemovedThenWindowRemoved" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "restart-restore-default" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-restart-restore-native-tab-close-stale",
    title: "restart restore native tab close stale",
    notes: "Mutation probe for closing the restored live tab after restart, then delivering a delayed restored-tab echo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "restore", "native-close", "session", "stale-event", "tombstone"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 }, captureStaleTabs: "restart-restore-tab-close" },
      { type: "outlinerUndo" },
      { type: "restartBackground" },
      { type: "nativeCloseTab", tab: { inWindow: { role: "focusedWindow" } }, order: "tabRemovedThenSessionChanged" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "restart-restore-tab-close" }, withStaleQuery: false }
    ]
  },
  {
    id: "dh-restart-restore-outliner-close-window-stale",
    title: "restart restore outliner close window stale",
    notes: "Mutation probe for command-owned close of a restored window after restart and delayed stale restored-tab echo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "restore", "outliner-close", "stale-event", "tombstone"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 }, captureStaleTabs: "restart-restore-outliner-close-window" },
      { type: "outlinerUndo" },
      { type: "restartBackground" },
      { type: "outlinerCloseWindow", window: { role: "focusedWindow" } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "restart-restore-outliner-close-window" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-restart-delete-reject-destination-close-created",
    title: "restart delete reject destination close created",
    notes: "Mutation probe for rejected relocation side effect, destination close, restart, and stale creation evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "command-rejection", "relocation", "native-close", "stale-event", "tombstone"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "restart-reject-destination-close-created-tab" },
      { type: "outlinerMoveTabCommandToNewWindowRejectingCreate", tab: { capture: "restart-reject-destination-close-created-tab" }, captureStaleTabs: "restart-reject-destination-close-created-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "tabsRemovedOnly" },
      { type: "restartBackground" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "restart-reject-destination-close-created-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-opener-chain-restart-destination-close",
    title: "opener chain restart destination close",
    notes: "Mutation probe for an opener chain whose relocated child destination closes before restart and stale child evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "opener", "relocation", "native-close", "stale-event", "stale-query"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "opener-chain-destination-close-child" },
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { capture: "opener-chain-destination-close-child" }, captureTab: "opener-chain-destination-close-grandchild" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "opener-chain-destination-close-grandchild" }, captureStaleTabs: "opener-chain-destination-close-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "windowRemovedOnly" },
      { type: "restartBackground" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "opener-chain-destination-close-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "dh-restart-baseline-reordered-focus-session",
    title: "restart baseline reordered focus session",
    notes: "Clean-block probe for startup reconstruction under focus/session churn and reordered query without command ownership.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "focus", "session", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "restart-baseline-reordered-extra" },
      { type: "restartBackground" },
      { type: "focusWindow", window: { windowId: 20 } },
      { type: "sessionChanged" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" },
      { type: "activateTab", tab: { capture: "restart-baseline-reordered-extra" } }
    ]
  },
  {
    id: "dh-restart-opener-chain-reordered-query",
    title: "restart opener chain reordered query",
    notes: "Clean-block probe for opener chains reconstructed across restart with reordered source-window query evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "opener", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "restart-opener-reordered-child" },
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { capture: "restart-opener-reordered-child" }, captureTab: "restart-opener-reordered-grandchild" },
      { type: "restartBackground" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateRight" }
    ]
  },
  {
    id: "dh-restart-missing-background-no-command",
    title: "restart missing background no command",
    notes: "Clean-block probe for missing whole-window snapshot confidence after restart without command-owned resources.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "restart-missing-background-extra" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 20 } },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "dh-restart-session-refresh-after-open",
    title: "restart session refresh after open",
    notes: "Clean-block probe for created-tab reconstruction across restart followed by session and complete refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "created-event", "session", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: true, captureTab: "restart-session-refresh-opened" },
      { type: "restartBackground" },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-native-tab-close-current-refresh",
    title: "restart native tab close current refresh",
    notes: "Clean-block probe for a non-last native tab close before restart followed by complete current refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "native-close", "session", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "restart-native-close-survivor" },
      { type: "nativeCloseTab", tab: { tabId: 2 }, order: "tabRemovedThenSessionChanged" },
      { type: "restartBackground" },
      { type: "manualRefresh" },
      { type: "activateTab", tab: { capture: "restart-native-close-survivor" } }
    ]
  },
  {
    id: "dh-restart-focus-current-window-reordered",
    title: "restart focus current window reordered",
    notes: "Clean-block probe for current-window focus and activation facts after restart with reordered destination evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "focus", "activation", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "restart-focus-current-background" },
      { type: "restartBackground" },
      { type: "focusWindow", window: { windowId: 20 } },
      { type: "activateTab", tab: { capture: "restart-focus-current-background" } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 20 }, order: "rotateLeft" }
    ]
  },
  {
    id: "dh-restart-close-undo-refresh",
    title: "restart close undo refresh",
    notes: "Clean-block probe for a command-closed tab restored by undo after restart and then reconciled from a complete refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "outliner-close", "undo-redo", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "restart-close-undo-tab" },
      { type: "outlinerCloseTab", tab: { capture: "restart-close-undo-tab" } },
      { type: "restartBackground" },
      { type: "outlinerUndo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-native-background-window-close",
    title: "restart native background window close",
    notes: "Clean-block probe for native close classification on a background window after startup reconstruction.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "native-close", "event-order", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "restart-background-window-close-extra" },
      { type: "restartBackground" },
      { type: "nativeCloseWindow", window: { windowId: 20 }, order: "tabsRemovedThenWindowRemoved" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-delete-reject-background-window-refresh",
    title: "restart delete reject background window refresh",
    notes: "Clean-block probe for delete-reject recovery reconstructed after restart and confirmed by complete refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "delete-rejection", "tombstone", "manual-refresh"],
    actions: [
      { type: "outlinerDeleteWindowRejectingClose", window: { windowId: 20 } },
      { type: "restartBackground" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-opener-native-child-close-refresh",
    title: "restart opener native child close refresh",
    notes: "Clean-block probe for opener-linked tab deletion after restart followed by complete refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "opener", "native-close", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "restart-opener-native-child" },
      { type: "restartBackground" },
      { type: "nativeCloseTab", tab: { capture: "restart-opener-native-child" }, order: "tabRemovedThenSessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-session-only-background-tab-query",
    title: "restart session only background tab query",
    notes: "Clean-block probe for session-only background tab disappearance after restart with reordered survivor query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "session", "native-close", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "restart-session-only-background-tab" },
      { type: "restartBackground" },
      { type: "nativeCloseTab", tab: { capture: "restart-session-only-background-tab" }, order: "sessionChangedOnly" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 20 }, order: "reverse" }
    ]
  },
  {
    id: "dh-restart-focus-command-no-relocation",
    title: "restart focus command no relocation",
    notes: "Clean-block probe for command focus facts reconstructed across restart without relocation or deletion.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "focus", "activation", "stale-query", "manual-refresh"],
    actions: [
      { type: "outlinerFocusTab", tab: { tabId: 2 } },
      { type: "restartBackground" },
      { type: "activateTab", tab: { tabId: 1 } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateRight" }
    ]
  },
  {
    id: "dh-restart-focus-command-complete-refresh",
    title: "restart focus command complete refresh",
    notes: "Mutation probe for command focus reconstructed across restart and then reconciled from a complete refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "focus", "activation", "manual-refresh"],
    actions: [
      { type: "outlinerFocusTab", tab: { tabId: 2 } },
      { type: "restartBackground" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-focus-command-session-activation",
    title: "restart focus command session activation",
    notes: "Mutation probe for command focus reconstructed across restart, session churn, and later activation.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "focus", "activation", "session", "manual-refresh"],
    actions: [
      { type: "outlinerFocusTab", tab: { tabId: 2 } },
      { type: "restartBackground" },
      { type: "sessionChanged" },
      { type: "activateTab", tab: { tabId: 1 } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-focus-command-background-activation",
    title: "restart focus command background activation",
    notes: "Mutation probe for command focus into a background window across restart before returning activation to the source window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "focus", "activation", "stale-query", "manual-refresh"],
    actions: [
      { type: "outlinerFocusTab", tab: { tabId: 3 } },
      { type: "restartBackground" },
      { type: "focusWindow", window: { windowId: 10 } },
      { type: "activateTab", tab: { tabId: 1 } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" }
    ]
  },
  {
    id: "dh-restart-focus-command-missing-focused-tab",
    title: "restart focus command missing focused tab",
    notes: "Mutation probe for command focus across restart when the focused tab is omitted from a partial snapshot.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "focus", "activation", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "outlinerFocusTab", tab: { tabId: 2 } },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingTabQuery", tab: { tabId: 2 } },
      { type: "activateTab", tab: { tabId: 1 } }
    ]
  },
  {
    id: "dh-restart-noop-complete-refresh",
    title: "restart noop complete refresh",
    notes: "Clean-block probe for startup reconstruction without intervening browser or command skew.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "manual-refresh"],
    actions: [
      { type: "restartBackground" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-opened-tabs-reordered-both",
    title: "restart opened tabs reordered both",
    notes: "Clean-block probe for tabs opened before restart and reordered snapshots in both live windows.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "created-event", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "restart-opened-reordered-source" },
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "restart-opened-reordered-background" },
      { type: "restartBackground" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateLeft" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 20 }, order: "rotateRight" }
    ]
  },
  {
    id: "dh-restart-opener-chain-current-refresh",
    title: "restart opener chain current refresh",
    notes: "Clean-block probe for opener chain reconstruction across restart with only current runtime evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "opener", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "restart-opener-current-child" },
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { capture: "restart-opener-current-child" }, captureTab: "restart-opener-current-grandchild" },
      { type: "restartBackground" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-nonlast-tab-removed-only-refresh",
    title: "restart nonlast tab removed only refresh",
    notes: "Clean-block probe for tabRemoved-only deletion of a non-last tab after restart followed by complete refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "native-close", "event-order", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "restart-nonlast-tab-removed-survivor" },
      { type: "restartBackground" },
      { type: "nativeCloseTab", tab: { tabId: 2 }, order: "tabRemovedOnly" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-session-only-opened-tab-refresh",
    title: "restart session only opened tab refresh",
    notes: "Clean-block probe for session-only disappearance of a pre-restart opened tab resolved by complete refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "session", "native-close", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "restart-session-only-opened-tab" },
      { type: "restartBackground" },
      { type: "nativeCloseTab", tab: { capture: "restart-session-only-opened-tab" }, order: "sessionChangedOnly" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-window-focus-churn-refresh",
    title: "restart window focus churn refresh",
    notes: "Clean-block probe for browser window focus churn around restart followed by complete refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "focus", "manual-refresh"],
    actions: [
      { type: "focusWindow", window: { windowId: 20 } },
      { type: "restartBackground" },
      { type: "focusWindow", window: { windowId: 10 } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-open-active-background-refresh",
    title: "restart open active background refresh",
    notes: "Clean-block probe for a browser-created active background tab reconstructed across restart with current evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "created-event", "activation", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: true, captureTab: "restart-open-active-background" },
      { type: "restartBackground" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-missing-opened-tab-query",
    title: "restart missing opened tab query",
    notes: "Clean-block probe for a partial snapshot missing a browser-created tab after restart without command ownership.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "created-event", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "restart-missing-opened-tab" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingTabQuery", tab: { capture: "restart-missing-opened-tab" } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-session-reordered-both-current",
    title: "restart session reordered both current",
    notes: "Clean-block probe for session refresh after restart followed by reordered snapshots in both current windows.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "session", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "restart-session-reordered-source" },
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "restart-session-reordered-background" },
      { type: "restartBackground" },
      { type: "sessionChanged" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 20 }, order: "reverse" }
    ]
  },
  {
    id: "dh-restart-missing-background-opened-tab-query",
    title: "restart missing background opened tab query",
    notes: "Mutation probe for a post-restart partial snapshot missing a browser-created background-window tab.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "created-event", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "restart-missing-background-opened-tab" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingTabQuery", tab: { capture: "restart-missing-background-opened-tab" } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-missing-active-opened-tab-query",
    title: "restart missing active opened tab query",
    notes: "Mutation probe for a post-restart partial snapshot missing a browser-created active tab.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "created-event", "activation", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: true, captureTab: "restart-missing-active-opened-tab" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingTabQuery", tab: { capture: "restart-missing-active-opened-tab" } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-missing-opener-child-query",
    title: "restart missing opener child query",
    notes: "Mutation probe for a post-restart partial snapshot missing an opener-linked browser-created child.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "opener", "created-event", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "restart-missing-opener-child" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingTabQuery", tab: { capture: "restart-missing-opener-child" } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-multiple-opens-complete-refresh",
    title: "restart multiple opens complete refresh",
    notes: "Clean-block probe for multiple browser-created tabs across windows reconstructed by complete refresh only.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "created-event", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "restart-multiple-opens-source" },
      { type: "openTab", window: { windowId: 20 }, active: true, captureTab: "restart-multiple-opens-background" },
      { type: "restartBackground" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-updated-tabs-complete-refresh",
    title: "restart updated tabs complete refresh",
    notes: "Clean-block probe for browser metadata updates before and after restart with complete refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "updated-event", "manual-refresh"],
    actions: [
      { type: "updateTab", tab: { tabId: 1 }, title: "Updated before restart" },
      { type: "restartBackground" },
      { type: "updateTab", tab: { tabId: 2 }, title: "Updated after restart" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-window-focus-reordered-current",
    title: "restart window focus reordered current",
    notes: "Clean-block probe for window focus changes and reordered current snapshots without command focus ownership.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "focus", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "restart-window-focus-reordered-extra" },
      { type: "focusWindow", window: { windowId: 20 } },
      { type: "restartBackground" },
      { type: "focusWindow", window: { windowId: 10 } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 20 }, order: "rotateRight" }
    ]
  },
  {
    id: "dh-restart-updated-reordered-both",
    title: "restart updated reordered both",
    notes: "Clean-block probe for metadata updates around restart followed by reordered current snapshots in both windows.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "updated-event", "stale-query", "manual-refresh"],
    actions: [
      { type: "updateTab", tab: { tabId: 1 }, title: "Source before restart" },
      { type: "updateTab", tab: { tabId: 3 }, title: "Background before restart" },
      { type: "restartBackground" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateLeft" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 20 }, order: "rotateRight" }
    ]
  },
  {
    id: "dh-restart-opener-focus-current-refresh",
    title: "restart opener focus current refresh",
    notes: "Clean-block probe for opener-linked tabs plus browser focus changes across restart with complete refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "opener", "focus", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "restart-opener-focus-child" },
      { type: "focusWindow", window: { windowId: 20 } },
      { type: "restartBackground" },
      { type: "focusWindow", window: { windowId: 10 } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-native-nonlast-session-refresh",
    title: "restart native nonlast session refresh",
    notes: "Clean-block probe for session-notified non-last tab deletion after restart with complete refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "native-close", "session", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "restart-native-nonlast-session-survivor" },
      { type: "restartBackground" },
      { type: "nativeCloseTab", tab: { tabId: 2 }, order: "sessionChangedThenTabRemoved" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-created-updated-session-refresh",
    title: "restart created updated session refresh",
    notes: "Clean-block probe for created and updated browser facts across restart plus session and complete refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "created-event", "updated-event", "session", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "restart-created-updated-tab" },
      { type: "updateTab", tab: { capture: "restart-created-updated-tab" }, title: "Created then updated" },
      { type: "restartBackground" },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "dh-restart-opener-updated-reordered",
    title: "restart opener updated reordered",
    notes: "Clean-block probe for opener-linked metadata update before restart followed by reordered current source evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restart", "reconciliation", "opener", "updated-event", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "restart-opener-updated-tab" },
      { type: "updateTab", tab: { capture: "restart-opener-updated-tab" }, title: "Opener child updated" },
      { type: "restartBackground" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" }
    ]
  },
  {
    id: "bh-deep-nested-double-group-source-window-only",
    title: "deep nested double group source window only close",
    notes: "Breadth probe for two nested grouping relocations followed by a source windowRemoved-only native close.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "nested", "nested-window", "native-close", "event-order", "stale-event"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "bh-nested-double-first-old" },
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "bh-nested-double-source-sibling" },
      { type: "outlinerGroupTab", tab: { tabId: 2 }, captureStaleTabs: "bh-nested-double-second-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "windowRemovedOnly" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "bh-nested-double-second-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "bh-deep-nested-destination-multitab-close",
    title: "deep nested destination multitab close",
    notes: "Breadth probe for a command-created nested destination that gains another tab before a native close.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "nested", "nested-window", "native-close", "manual-refresh"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "bh-nested-multitab-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, captureTab: "bh-nested-extra-destination-tab" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "tabsRemovedThenWindowRemoved" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "bh-deep-nested-focus-session-churn",
    title: "deep nested focus session churn",
    notes: "Breadth probe for nested command-created windows under focus and session churn with reordered evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "nested", "focus", "session", "stale-query", "manual-refresh"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "bh-nested-focus-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: true, captureTab: "bh-nested-focus-extra" },
      { type: "focusWindow", window: { windowId: 20 } },
      { type: "sessionChanged" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "lastOpenedWindow" }, order: "rotateRight" }
    ]
  },
  {
    id: "bh-deep-nested-source-tabs-only-after-second-group",
    title: "deep nested source tabs only after second group",
    notes: "Breadth probe for two grouped live tabs when the source window reports tab removals without window removal.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "nested", "native-close", "event-order", "stale-event"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "bh-nested-tabs-only-first-old" },
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "bh-nested-tabs-only-source-sibling" },
      { type: "outlinerGroupTab", tab: { tabId: 2 }, captureStaleTabs: "bh-nested-tabs-only-second-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "tabsRemovedOnly" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "bh-nested-tabs-only-second-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "bh-opener-grandchild-relocation-refresh",
    title: "opener grandchild relocation refresh",
    notes: "Breadth probe for a two-hop opener chain where the grandchild is command-relocated and partially refreshed.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "opener", "reparenting", "relocation", "partial-snapshot", "stale-event"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "bh-opener-child" },
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { capture: "bh-opener-child" }, captureTab: "bh-opener-grandchild" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "bh-opener-grandchild" }, captureStaleTabs: "bh-opener-grandchild-old" },
      { type: "manualRefreshWithMissingTabQuery", tab: { role: "lastMovedTab" } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "bh-opener-grandchild-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "bh-opener-chain-undo-redo-source-close",
    title: "opener chain undo redo source close",
    notes: "Breadth probe for opener relocation replayed through history before a source window close and reordered query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "opener", "undo-redo", "native-close", "event-order", "stale-query"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "bh-opener-undo-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "bh-opener-undo-child" }, captureStaleTabs: "bh-opener-undo-old" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "windowRemovedThenTabsRemoved" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "focusedWindow" }, order: "reverse" }
    ]
  },
  {
    id: "bh-opener-child-native-close-missing-query",
    title: "opener child native close missing query",
    notes: "Breadth probe for opener child deletion while a grandchild remains and a partial query omits the survivor.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "opener", "native-close", "partial-snapshot", "session"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "bh-opener-native-child" },
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { capture: "bh-opener-native-child" }, captureTab: "bh-opener-native-grandchild" },
      { type: "nativeCloseTab", tab: { capture: "bh-opener-native-child" }, order: "sessionChangedThenTabRemoved" },
      { type: "manualRefreshWithMissingTabQuery", tab: { capture: "bh-opener-native-grandchild" } }
    ]
  },
  {
    id: "bh-opener-focus-reordered-cross-window",
    title: "opener focus reordered cross window",
    notes: "Breadth probe for opener-linked relocation, command focus, and reordered destination evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "opener", "focus", "activation", "relocation", "stale-query"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "bh-opener-focus-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "bh-opener-focus-child" }, captureStaleTabs: "bh-opener-focus-old" },
      { type: "outlinerFocusTab", tab: { role: "lastMovedTab" } },
      { type: "manualRefreshWithReorderedQuery", window: { role: "lastOpenedWindow" }, order: "rotateLeft" }
    ]
  },
  {
    id: "bh-restore-window-native-window-only",
    title: "restore window native window only",
    notes: "Breadth probe for a restored window that later emits only a native windowRemoved event.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "restore", "undo-redo", "native-close", "event-order"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerUndo" },
      { type: "nativeCloseWindow", window: { role: "focusedWindow" }, order: "windowRemovedOnly" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "bh-restore-redo-reordered-query",
    title: "restore redo reordered query",
    notes: "Breadth probe for repeated restore history transitions with reordered live evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "restore", "undo-redo", "stale-query", "manual-refresh"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "outlinerUndo" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateRight" }
    ]
  },
  {
    id: "bh-restore-delete-reject-after-undo",
    title: "restore delete reject after undo",
    notes: "Breadth probe for restored window ownership followed by a delete rejection side effect.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "restore", "undo-redo", "delete-rejection", "tombstone"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerUndo" },
      { type: "outlinerDeleteWindowRejectingClose", window: { role: "focusedWindow" } },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "bh-restore-delayed-event-after-focus",
    title: "restore delayed event after focus",
    notes: "Breadth probe for restored delayed runtime evidence after command focus has changed active state.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "restore", "focus", "delayed-event", "stale-event"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 }, captureStaleTabs: "bh-restore-focus-stale" },
      { type: "outlinerFocusTab", tab: { tabId: 1 } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "bh-restore-focus-stale" }, withStaleQuery: true }
    ]
  },
  {
    id: "bh-focus-reject-same-window-session",
    title: "focus reject same window session",
    notes: "Breadth probe for a focus command whose tab activation side effect happens before adapter rejection.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "focus", "activation", "command-rejection", "session"],
    actions: [
      { type: "outlinerFocusTabRejectingUpdate", tab: { tabId: 2 } },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "bh-focus-reject-cross-window-reordered",
    title: "focus reject cross window reordered",
    notes: "Breadth probe for a cross-window focus side effect that rejects and is followed by reordered old-window evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "focus", "activation", "command-rejection", "stale-query"],
    actions: [
      { type: "outlinerFocusTabRejectingUpdate", tab: { tabId: 3 } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" }
    ]
  },
  {
    id: "bh-restore-create-reject-tab",
    title: "restore create reject tab",
    notes: "Breadth probe for restore fallback tab creation side effects followed by adapter rejection.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "restore", "command-rejection", "created-event", "session"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" } },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "bh-relocation-reject-after-second-relocation",
    title: "relocation reject after second relocation",
    notes: "Breadth probe for a rejected command-created relocation followed by another relocation attempt and partial evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "relocation", "command-rejection", "partial-snapshot", "stale-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindowRejectingCreate", tab: { tabId: 1 }, captureStaleTabs: "bh-reject-second-first-old" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { role: "lastMovedTab" }, captureStaleTabs: "bh-reject-second-second-old" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "lastOpenedWindow" } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "bh-reject-second-first-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "bh-query-missing-source-reorder-destination",
    title: "query missing source reorder destination",
    notes: "Breadth probe for multi-window query skew where one window is missing and another is reordered.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "partial-snapshot", "stale-query", "relocation", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "bh-query-missing-source-old" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } },
      { type: "manualRefreshWithReorderedQuery", window: { role: "lastOpenedWindow" }, order: "reverse" }
    ]
  },
  {
    id: "bh-query-empty-focused-background-active",
    title: "query empty focused background active",
    notes: "Breadth probe for missing focused-window evidence while a background tab becomes active.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "partial-snapshot", "focus", "activation", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: true, captureTab: "bh-query-background-active" },
      { type: "focusWindow", window: { windowId: 20 } },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 20 } },
      { type: "activateTab", tab: { tabId: 1 } }
    ]
  },
  {
    id: "bh-query-reordered-source-destination-pair",
    title: "query reordered source destination pair",
    notes: "Breadth probe for back-to-back reordered source and destination snapshots after relocation.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "stale-query", "relocation", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "bh-query-reorder-pair-old" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateLeft" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "lastOpenedWindow" }, order: "rotateRight" }
    ]
  },
  {
    id: "bh-query-stale-event-partial-two-windows",
    title: "query stale event partial two windows",
    notes: "Breadth probe for stale event-local evidence followed by a missing-window snapshot across another window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "stale-event", "partial-snapshot", "relocation", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "bh-query-stale-partial-old" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "bh-query-stale-partial-old" }, withStaleQuery: true },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 20 } }
    ]
  },
  {
    id: "bh-restart-opener-restore-mix",
    title: "restart opener restore mix",
    notes: "Breadth probe for opener-linked closed tab recovery across a restart and manual refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "restart", "opener", "restore", "undo-redo", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "bh-restart-opener-restore-child" },
      { type: "outlinerCloseTab", tab: { capture: "bh-restart-opener-restore-child" } },
      { type: "restartBackground" },
      { type: "outlinerUndo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "bh-restart-focus-reject",
    title: "restart focus reject",
    notes: "Breadth probe for command-focus side effects that reject before restart reconstruction.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "restart", "focus", "activation", "command-rejection", "stale-query"],
    actions: [
      { type: "outlinerFocusTabRejectingUpdate", tab: { tabId: 2 } },
      { type: "restartBackground" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateRight" }
    ]
  },
  {
    id: "bh-restart-multiple-open-session-churn",
    title: "restart multiple open session churn",
    notes: "Breadth probe for multiple browser-created tabs crossing restart with session churn and reordered evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "restart", "created-event", "session", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "bh-restart-multi-open-a" },
      { type: "openTab", window: { windowId: 20 }, active: true, captureTab: "bh-restart-multi-open-b" },
      { type: "restartBackground" },
      { type: "sessionChanged" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 20 }, order: "rotateLeft" }
    ]
  },
  {
    id: "bh-restart-runtime-id-gap",
    title: "restart runtime id gap",
    notes: "Breadth probe for runtime tab ID gaps from native close before restart followed by a new browser-created tab.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "restart", "created-event", "native-close", "session", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "bh-restart-gap-closed" },
      { type: "nativeCloseTab", tab: { capture: "bh-restart-gap-closed" }, order: "sessionChangedOnly" },
      { type: "restartBackground" },
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "bh-restart-gap-opened" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "bh-restore-create-reject-window",
    title: "restore create reject window",
    notes: "Breadth probe for restored window creation side effects followed by adapter rejection.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "restore", "command-rejection", "created-event", "session"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" } },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "bh-restart-restore-create-reject-tab",
    title: "restart restore create reject tab",
    notes: "Breadth probe for tab restore creation rejection after startup reconstruction has lost command-local facts.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "restart", "restore", "command-rejection", "created-event", "manual-refresh"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "restartBackground" },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "bh-restore-create-reject-tab-after-redo",
    title: "restore create reject tab after redo",
    notes: "Breadth probe for restore creation rejection after history replay has closed the tab again.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "restore", "undo-redo", "command-rejection", "created-event"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" } }
    ]
  },
  {
    id: "bh-restart-restore-create-reject-window",
    title: "restart restore create reject window",
    notes: "Breadth probe for restored window creation rejection after background restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "restart", "restore", "command-rejection", "created-event", "manual-refresh"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "restartBackground" },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "bh-focus-reject-after-relocation-restart",
    title: "focus reject after relocation restart",
    notes: "Breadth probe for focus side-effect rejection after command relocation and startup reconstruction.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "restart", "focus", "activation", "command-rejection", "relocation", "stale-query"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "bh-focus-reject-relocated-old" },
      { type: "restartBackground" },
      { type: "outlinerFocusTabRejectingUpdate", tab: { role: "lastMovedTab" } },
      { type: "manualRefreshWithReorderedQuery", window: { role: "lastOpenedWindow" }, order: "rotateRight" }
    ]
  },
  {
    id: "bh-focus-reject-opener-chain-query",
    title: "focus reject opener chain query",
    notes: "Breadth probe for opener-chain relocation followed by focus rejection and source-window reordered evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "opener", "focus", "activation", "command-rejection", "relocation", "stale-query"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "bh-focus-reject-opener-child" },
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { capture: "bh-focus-reject-opener-child" }, captureTab: "bh-focus-reject-opener-grandchild" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "bh-focus-reject-opener-grandchild" }, captureStaleTabs: "bh-focus-reject-opener-old" },
      { type: "outlinerFocusTabRejectingUpdate", tab: { role: "lastMovedTab" } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" }
    ]
  },
  {
    id: "bh-query-missing-two-windows-reordered-focus",
    title: "query missing two windows reordered focus",
    notes: "Breadth probe for sequential missing-window and reordered-window query skew during focus churn.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "partial-snapshot", "stale-query", "focus", "activation", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "bh-query-two-source" },
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "bh-query-two-background" },
      { type: "focusWindow", window: { windowId: 20 } },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 20 }, order: "reverse" },
      { type: "activateTab", tab: { capture: "bh-query-two-background" } }
    ]
  },
  {
    id: "bh-restart-query-skew-id-gap-focus",
    title: "restart query skew id gap focus",
    notes: "Breadth probe for native ID gaps across restart followed by focus side-effect rejection and reordered current evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "restart", "native-close", "focus", "activation", "command-rejection", "stale-query"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "bh-restart-skew-gap-tab" },
      { type: "nativeCloseTab", tab: { capture: "bh-restart-skew-gap-tab" }, order: "sessionChangedOnly" },
      { type: "restartBackground" },
      { type: "outlinerFocusTabRejectingUpdate", tab: { tabId: 1 } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateLeft" }
    ]
  },
  {
    id: "bh-nested-destination-window-only-stale-pair",
    title: "nested destination window only stale pair",
    notes: "Breadth probe for a multi-tab nested destination closed by windowRemoved-only before old source echoes arrive.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "nested", "nested-window", "native-close", "event-order", "stale-event"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "bh-nested-dest-window-only-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, captureTab: "bh-nested-dest-window-only-extra" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "windowRemovedOnly" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "bh-nested-dest-window-only-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "bh-nested-destination-tabs-only-reordered-source",
    title: "nested destination tabs only reordered source",
    notes: "Breadth probe for destination tab removals without window removal followed by reordered source evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "nested", "nested-window", "native-close", "event-order", "stale-query"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "bh-nested-dest-tabs-only-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, captureTab: "bh-nested-dest-tabs-only-extra" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "tabsRemovedOnly" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateLeft" }
    ]
  },
  {
    id: "bh-opener-grandchild-source-window-only-after-focus",
    title: "opener grandchild source window only after focus",
    notes: "Breadth probe for a relocated opener grandchild focused before source windowRemoved-only evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "opener", "focus", "activation", "native-close", "event-order", "stale-event"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "bh-opener-window-only-child" },
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { capture: "bh-opener-window-only-child" }, captureTab: "bh-opener-window-only-grandchild" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "bh-opener-window-only-grandchild" }, captureStaleTabs: "bh-opener-window-only-old" },
      { type: "outlinerFocusTab", tab: { role: "lastMovedTab" } },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "windowRemovedOnly" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "bh-opener-window-only-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "bh-opener-destination-tabs-only-extra-tab",
    title: "opener destination tabs only extra tab",
    notes: "Breadth probe for opener-linked relocation into a destination with another tab before tabsRemoved-only close.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "opener", "native-close", "event-order", "partial-snapshot", "relocation"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "bh-opener-dest-tabs-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "bh-opener-dest-tabs-child" }, captureStaleTabs: "bh-opener-dest-tabs-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, captureTab: "bh-opener-dest-tabs-extra" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "tabsRemovedOnly" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } }
    ]
  },
  {
    id: "bh-query-missing-both-windows-sequential",
    title: "query missing both windows sequential",
    notes: "Breadth probe for separate partial snapshots omitting first the source window and then the background window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "partial-snapshot", "manual-refresh", "focus", "activation"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "bh-query-both-source" },
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "bh-query-both-background" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 20 } },
      { type: "activateTab", tab: { capture: "bh-query-both-source" } }
    ]
  },
  {
    id: "bh-restart-opener-native-gap-reordered",
    title: "restart opener native gap reordered",
    notes: "Breadth probe for opener child native disappearance before restart, then reordered evidence after a new ID is allocated.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "restart", "opener", "native-close", "session", "stale-query"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "bh-restart-opener-gap-child" },
      { type: "nativeCloseTab", tab: { capture: "bh-restart-opener-gap-child" }, order: "sessionChangedOnly" },
      { type: "restartBackground" },
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "bh-restart-opener-gap-new" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateRight" }
    ]
  },
  {
    id: "bh-relocation-reject-then-focus-reject",
    title: "relocation reject then focus reject",
    notes: "Breadth probe for relocation create rejection followed by focus update rejection on the side-effect-created destination.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "relocation", "focus", "activation", "command-rejection", "stale-query"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindowRejectingCreate", tab: { tabId: 1 }, captureStaleTabs: "bh-relocation-focus-reject-old" },
      { type: "outlinerFocusTabRejectingUpdate", tab: { role: "lastMovedTab" } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" }
    ]
  },
  {
    id: "bh-history-opener-grandchild-missing-window",
    title: "history opener grandchild missing window",
    notes: "Breadth probe for opener grandchild relocation replayed through history before a missing source-window query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "opener", "undo-redo", "relocation", "partial-snapshot", "stale-query"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "bh-history-opener-child" },
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { capture: "bh-history-opener-child" }, captureTab: "bh-history-opener-grandchild" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "bh-history-opener-grandchild" }, captureStaleTabs: "bh-history-opener-old" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } },
      { type: "manualRefreshWithReorderedQuery", window: { role: "focusedWindow" }, order: "rotateLeft" }
    ]
  },
  {
    id: "bh-history-nested-source-tabs-only-focus",
    title: "history nested source tabs only focus",
    notes: "Breadth probe for nested grouping replayed through history before focus churn and source tabsRemoved-only evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "nested", "undo-redo", "native-close", "focus", "event-order"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "bh-history-nested-old" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "openTab", window: { role: "focusedWindow" }, active: false, captureTab: "bh-history-nested-extra" },
      { type: "focusWindow", window: { role: "focusedWindow" } },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "tabsRemovedOnly" }
    ]
  },
  {
    id: "bh-native-source-tabs-then-window-after-focus",
    title: "native source tabs then window after focus",
    notes: "Breadth probe for source close ordering after a relocated tab and cross-window focus churn.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "native-close", "event-order", "focus", "relocation", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "bh-native-source-order-old" },
      { type: "outlinerFocusTab", tab: { tabId: 3 } },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "tabsRemovedThenWindowRemoved" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "lastOpenedWindow" } }
    ]
  },
  {
    id: "bh-native-destination-window-only-after-reorder",
    title: "native destination window only after reorder",
    notes: "Breadth probe for reordered destination evidence immediately before a windowRemoved-only destination close.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "native-close", "event-order", "stale-query", "relocation", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "bh-native-dest-window-only-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, captureTab: "bh-native-dest-window-only-extra" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "lastOpenedWindow" }, order: "reverse" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "windowRemovedOnly" }
    ]
  },
  {
    id: "bh-query-no-command-missing-reordered-pair",
    title: "query no command missing reordered pair",
    notes: "Breadth probe for partial and reordered snapshots across two windows without command ownership facts.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "partial-snapshot", "stale-query", "manual-refresh", "focus"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "bh-query-no-command-source" },
      { type: "openTab", window: { windowId: 20 }, active: true, captureTab: "bh-query-no-command-background" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 20 } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateRight" },
      { type: "focusWindow", window: { windowId: 10 } }
    ]
  },
  {
    id: "bh-restart-after-partial-query-no-command",
    title: "restart after partial query no command",
    notes: "Breadth probe for startup reconstruction after a partial query that omitted a browser-created background tab.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "restart", "partial-snapshot", "created-event", "session", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "bh-restart-partial-background" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 20 } },
      { type: "restartBackground" },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "bh-session-focus-nested-multitab-restart",
    title: "session focus nested multitab restart",
    notes: "Breadth probe for nested multi-tab ownership across session churn, restart, focus, and reordered destination evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "nested", "restart", "focus", "session", "stale-query"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "bh-session-nested-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, captureTab: "bh-session-nested-extra" },
      { type: "sessionChanged" },
      { type: "restartBackground" },
      { type: "focusWindow", window: { role: "lastOpenedWindow" } },
      { type: "manualRefreshWithReorderedQuery", window: { role: "lastOpenedWindow" }, order: "rotateRight" }
    ]
  },
  {
    id: "bh-opener-history-source-tabs-only-restart",
    title: "opener history source tabs only restart",
    notes: "Breadth probe for opener relocation replayed through history and restart before source tabsRemoved-only evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "opener", "undo-redo", "restart", "native-close", "event-order"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "bh-opener-history-restart-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "bh-opener-history-restart-child" }, captureStaleTabs: "bh-opener-history-restart-old" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "restartBackground" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "tabsRemovedOnly" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "bh-query-two-command-windows-reordered",
    title: "query two command windows reordered",
    notes: "Breadth probe for multiple command-created windows with reordered source, background, and newest destination snapshots.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "relocation", "stale-query", "manual-refresh", "focus"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "bh-query-two-command-first-old" },
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "bh-query-two-command-background-survivor" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 3 }, captureStaleTabs: "bh-query-two-command-second-old" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 20 }, order: "rotateLeft" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "lastOpenedWindow" }, order: "rotateRight" }
    ]
  },
  {
    id: "bh-native-background-window-only-no-command-restart",
    title: "native background window only no command restart",
    notes: "Breadth probe for a browser-only background windowRemoved event crossing restart without command ownership facts.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "native-close", "event-order", "restart", "created-event", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "bh-native-background-window-only-extra" },
      { type: "nativeCloseWindow", window: { windowId: 20 }, order: "windowRemovedOnly" },
      { type: "restartBackground" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "bh-focus-after-session-only-close-missing-source",
    title: "focus after session only close missing source",
    notes: "Breadth probe for focus side-effect rejection after a session-only tab disappearance and missing source-window query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "focus", "activation", "native-close", "session", "partial-snapshot", "command-rejection"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "bh-focus-session-only-closed" },
      { type: "nativeCloseTab", tab: { capture: "bh-focus-session-only-closed" }, order: "sessionChangedOnly" },
      { type: "outlinerFocusTabRejectingUpdate", tab: { tabId: 1 } },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } }
    ]
  },
  {
    id: "bh-relocation-reject-source-window-only-restart",
    title: "relocation reject source window only restart",
    notes: "Breadth probe for relocation create rejection followed by source windowRemoved-only evidence across restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["breadth", "relocation", "command-rejection", "restart", "native-close", "stale-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindowRejectingCreate", tab: { tabId: 1 }, captureStaleTabs: "bh-reject-source-window-only-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "windowRemovedOnly" },
      { type: "restartBackground" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "bh-reject-source-window-only-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "ph-close-reject-tab-session-refresh",
    title: "close reject tab session refresh",
    notes: "Post-recovery probe for outliner tab close side effects that complete before adapter rejection, followed by session/manual reconciliation.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "outliner-close", "command-rejection", "session", "manual-refresh"],
    actions: [
      { type: "outlinerCloseNodeRejectingClose", node: { tab: { tabId: 2 } } },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "ph-close-reject-single-window-restart",
    title: "close reject single window restart",
    notes: "Post-recovery probe for a rejected outliner close of a single-tab window across startup reconstruction.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "outliner-close", "command-rejection", "restart", "manual-refresh"],
    actions: [
      { type: "outlinerCloseNodeRejectingClose", node: { window: { windowId: 20 } } },
      { type: "restartBackground" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "ph-close-reject-multitab-window-reordered",
    title: "close reject multitab window reordered",
    notes: "Post-recovery probe for a rejected outliner close of a multi-tab runtime window followed by reordered surviving-window query evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "outliner-close", "command-rejection", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "ph-close-reject-multitab-extra" },
      { type: "outlinerCloseNodeRejectingClose", node: { window: { windowId: 20 } } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" }
    ]
  },
  {
    id: "ph-close-reject-nested-destination-stale",
    title: "close reject nested destination stale",
    notes: "Post-recovery probe for rejected outliner close of a command-created nested destination, then stale old-window evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "nested", "outliner-close", "command-rejection", "stale-event", "stale-query"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "ph-close-reject-nested-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, captureTab: "ph-close-reject-nested-extra" },
      { type: "outlinerCloseNodeRejectingClose", node: { window: { role: "lastOpenedWindow" } } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "ph-close-reject-nested-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "ph-restore-native-window-only-after-recovery",
    title: "restore native window only after recovery",
    notes: "Post-recovery probe for restored window create-rejection recovery followed by windowRemoved-only native close.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "restore", "command-rejection", "native-close", "event-order", "manual-refresh"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" } },
      { type: "nativeCloseWindow", window: { role: "focusedWindow" }, order: "windowRemovedOnly" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "ph-restore-native-default-after-recovery",
    title: "restore native default after recovery",
    notes: "Post-recovery probe for restored window create-rejection recovery followed by full native close ordering and session evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "restore", "command-rejection", "native-close", "event-order", "session"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" } },
      { type: "nativeCloseWindow", window: { role: "focusedWindow" }, order: "tabsRemovedThenWindowRemoved" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "ph-restore-delayed-focus-partial-query",
    title: "restore delayed focus partial query",
    notes: "Post-recovery probe for restore/delete delayed echoes, command focus, and a missing source-window query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "restore", "delayed-event", "focus", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 }, captureStaleTabs: "ph-restore-delayed-focus" },
      { type: "outlinerFocusTab", tab: { tabId: 1 } },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "ph-restore-delayed-focus" }, withStaleQuery: true }
    ]
  },
  {
    id: "ph-restore-redo-native-tabs-only",
    title: "restore redo native tabs only",
    notes: "Post-recovery probe for history replay around restored windows followed by tabsRemoved-only native close evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "restore", "undo-redo", "native-close", "event-order", "manual-refresh"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" } },
      { type: "nativeCloseWindow", window: { role: "focusedWindow" }, order: "tabsRemovedOnly" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "ph-opener-grandchild-redo-missing-destination",
    title: "opener grandchild redo missing destination",
    notes: "Post-recovery probe for opener grandchild relocation through history replay and missing destination query evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "opener", "undo-redo", "relocation", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "ph-opener-redo-child" },
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { capture: "ph-opener-redo-child" }, captureTab: "ph-opener-redo-grandchild" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "ph-opener-redo-grandchild" }, captureStaleTabs: "ph-opener-redo-old" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefreshWithMissingTabQuery", tab: { role: "lastMovedTab" } }
    ]
  },
  {
    id: "ph-opener-source-close-reject-stale",
    title: "opener source close reject stale",
    notes: "Post-recovery probe for opener relocation followed by source outliner close rejection and stale old-window evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "opener", "outliner-close", "command-rejection", "stale-event", "stale-query"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "ph-opener-close-child" },
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { capture: "ph-opener-close-child" }, captureTab: "ph-opener-close-grandchild" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "ph-opener-close-grandchild" }, captureStaleTabs: "ph-opener-close-old" },
      { type: "outlinerCloseNodeRejectingClose", node: { window: { windowId: 10 } } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "ph-opener-close-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "ph-opener-native-child-reordered-restart",
    title: "opener native child reordered restart",
    notes: "Post-recovery probe for opener child native close, restart reconstruction, and reordered source query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "opener", "native-close", "restart", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "ph-opener-native-child" },
      { type: "nativeCloseTab", tab: { capture: "ph-opener-native-child" }, order: "sessionChangedOnly" },
      { type: "restartBackground" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateRight" }
    ]
  },
  {
    id: "ph-query-no-command-two-window-skew",
    title: "query no command two window skew",
    notes: "Post-recovery probe for browser-created tabs with missing one window and reordered another without command ownership.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "partial-snapshot", "stale-query", "created-event", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "ph-query-skew-source" },
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "ph-query-skew-background" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 20 }, order: "reverse" }
    ]
  },
  {
    id: "ph-query-command-destination-source-skew",
    title: "query command destination source skew",
    notes: "Post-recovery probe for command-created destination and source windows receiving different partial query shapes.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "relocation", "partial-snapshot", "stale-query", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "ph-query-command-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, captureTab: "ph-query-command-extra" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "lastOpenedWindow" } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateLeft" }
    ]
  },
  {
    id: "ph-query-stale-event-two-window-skew",
    title: "query stale event two window skew",
    notes: "Post-recovery probe for stale old-window event followed by missing and reordered evidence across two windows.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "stale-event", "partial-snapshot", "stale-query", "relocation", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "ph-query-stale-old" },
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "ph-query-stale-background" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "ph-query-stale-old" }, withStaleQuery: true },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 20 } },
      { type: "manualRefreshWithReorderedQuery", window: { role: "lastOpenedWindow" }, order: "reverse" }
    ]
  },
  {
    id: "ph-focus-after-close-reject-session",
    title: "focus after close reject session",
    notes: "Post-recovery probe for focus side-effect rejection after an outliner close rejection and session churn.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "focus", "activation", "outliner-close", "command-rejection", "session"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "ph-focus-close-reject-tab" },
      { type: "outlinerCloseNodeRejectingClose", node: { tab: { capture: "ph-focus-close-reject-tab" } } },
      { type: "outlinerFocusTabRejectingUpdate", tab: { tabId: 1 } },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "ph-focus-restore-native-session",
    title: "focus restore native session",
    notes: "Post-recovery probe for restore recovery, native close, command focus rejection, and session refresh interaction.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "focus", "restore", "native-close", "command-rejection", "session"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" } },
      { type: "nativeCloseWindow", window: { role: "focusedWindow" }, order: "windowRemovedOnly" },
      { type: "outlinerFocusTabRejectingUpdate", tab: { tabId: 1 } },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "ph-restart-close-reject-stale-old",
    title: "restart close reject stale old",
    notes: "Post-recovery probe for close rejection across restart followed by stale old-window relocation evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "restart", "outliner-close", "command-rejection", "stale-event", "stale-query"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "ph-restart-close-reject-old" },
      { type: "outlinerCloseNodeRejectingClose", node: { window: { windowId: 10 } } },
      { type: "restartBackground" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "ph-restart-close-reject-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "ph-restart-restore-native-id-gap",
    title: "restart restore native id gap",
    notes: "Post-recovery probe for runtime id gaps, restored window recovery, native close, restart, and reordered surviving evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "restart", "restore", "native-close", "session", "stale-query"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "ph-restart-gap-tab" },
      { type: "nativeCloseTab", tab: { capture: "ph-restart-gap-tab" }, order: "sessionChangedOnly" },
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" } },
      { type: "nativeCloseWindow", window: { role: "focusedWindow" }, order: "tabsRemovedOnly" },
      { type: "restartBackground" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateLeft" }
    ]
  },
  {
    id: "ph-restore-tab-native-source-missing",
    title: "restore tab native source missing",
    notes: "Post-recovery mutation for restored tab create-rejection recovery followed by native tab removal and missing source-window query evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "restore", "command-rejection", "native-close", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" } },
      { type: "nativeCloseTab", tab: { role: "activeTab" }, order: "tabRemovedOnly" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } }
    ]
  },
  {
    id: "ph-restore-window-focus-restart-stale-query",
    title: "restore window focus restart stale query",
    notes: "Post-recovery mutation for restored window recovery followed by focus churn, restart reconstruction, and partial focused-window query evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "restore", "focus", "restart", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" } },
      { type: "outlinerFocusTab", tab: { tabId: 1 } },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "focusedWindow" } }
    ]
  },
  {
    id: "ph-opener-grandchild-redo-missing-tab",
    title: "opener grandchild redo missing tab",
    notes: "Post-recovery mutation for opener grandchild relocation through history replay, using the current moved tab as the partial-query target.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "opener", "undo-redo", "relocation", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "ph-opener-redo-tab-child" },
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { capture: "ph-opener-redo-tab-child" }, captureTab: "ph-opener-redo-tab-grandchild" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "ph-opener-redo-tab-grandchild" }, captureStaleTabs: "ph-opener-redo-tab-old" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefreshWithMissingTabQuery", tab: { role: "lastMovedTab" } }
    ]
  },
  {
    id: "ph-opener-grandchild-restart-reordered",
    title: "opener grandchild restart reordered",
    notes: "Post-recovery mutation for opener grandchild relocation across restart with fresh metadata and reordered current-window query evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "opener", "relocation", "restart", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "ph-opener-restart-child" },
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { capture: "ph-opener-restart-child" }, captureTab: "ph-opener-restart-grandchild" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "ph-opener-restart-grandchild" }, captureStaleTabs: "ph-opener-restart-old" },
      { type: "restartBackground" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Post recovery opener current" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "focusedWindow" }, order: "rotateRight" }
    ]
  },
  {
    id: "ph-query-restart-two-window-no-command",
    title: "query restart two window no command",
    notes: "Post-recovery mutation for no-command browser-created tabs, startup reconstruction, missing one window, and reordered another.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "created-event", "restart", "partial-snapshot", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "ph-query-restart-source" },
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "ph-query-restart-background" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 20 } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" }
    ]
  },
  {
    id: "ph-focus-close-reject-window-restart-session",
    title: "focus close reject window restart session",
    notes: "Post-recovery mutation for rejected outliner close of a window followed by focus rejection, restart reconstruction, and session evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "focus", "outliner-close", "command-rejection", "restart", "session"],
    actions: [
      { type: "outlinerCloseNodeRejectingClose", node: { window: { windowId: 20 } } },
      { type: "outlinerFocusTabRejectingUpdate", tab: { tabId: 1 } },
      { type: "restartBackground" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "ph-restore-tab-native-active-missing",
    title: "restore tab native active missing",
    notes: "Post-recovery mutation for restored tab recovery addressed through the current active runtime tab before native close and partial source query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "restore", "command-rejection", "native-close", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" } },
      { type: "nativeCloseTab", tab: { role: "activeTab" }, order: "sessionChangedThenTabRemoved" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } }
    ]
  },
  {
    id: "ph-restore-tab-restart-active-reordered",
    title: "restore tab restart active reordered",
    notes: "Post-recovery mutation for restored tab recovery across restart followed by current active-tab metadata and reordered source query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "restore", "restart", "metadata", "stale-query", "manual-refresh"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" } },
      { type: "restartBackground" },
      { type: "updateTab", tab: { role: "activeTab" }, title: "Post recovery restored active" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateLeft" }
    ]
  },
  {
    id: "ph-opener-redo-current-window-reordered",
    title: "opener redo current window reordered",
    notes: "Post-recovery mutation for opener grandchild relocation through redo, then current destination metadata and focused-window reorder evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "opener", "undo-redo", "relocation", "metadata", "stale-query"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "ph-opener-current-child" },
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { capture: "ph-opener-current-child" }, captureTab: "ph-opener-current-grandchild" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "ph-opener-current-grandchild" }, captureStaleTabs: "ph-opener-current-old" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Post recovery redo current" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "focusedWindow" }, order: "reverse" }
    ]
  },
  {
    id: "ph-close-reject-window-focus-partial",
    title: "close reject window focus partial",
    notes: "Post-recovery mutation for rejected close of a single-tab window followed by focus churn and partial surviving-window query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "outliner-close", "command-rejection", "focus", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "outlinerCloseNodeRejectingClose", node: { window: { windowId: 20 } } },
      { type: "outlinerFocusTab", tab: { tabId: 1 } },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } }
    ]
  },
  {
    id: "ph-query-native-restart-two-window-skew",
    title: "query native restart two window skew",
    notes: "Post-recovery mutation for browser-created tabs, native session-only disappearance, restart, and skewed query evidence in both windows.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "created-event", "native-close", "restart", "partial-snapshot", "stale-query"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "ph-query-native-source" },
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "ph-query-native-background" },
      { type: "nativeCloseTab", tab: { capture: "ph-query-native-source" }, order: "sessionChangedOnly" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 20 } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateRight" }
    ]
  },
  {
    id: "ph-restore-window-native-restart-partial",
    title: "restore window native restart partial",
    notes: "Post-recovery mutation for restored window recovery, native tabs-only close, restart reconstruction, and partial surviving-window query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "restore", "native-close", "restart", "event-order", "partial-snapshot"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" } },
      { type: "nativeCloseWindow", window: { role: "focusedWindow" }, order: "tabsRemovedOnly" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } }
    ]
  },
  {
    id: "ph-restore-opener-native-window-only",
    title: "restore opener native window only",
    notes: "Post-recovery mutation for opener children inside a restored window, followed by windowRemoved-only native close and source-window refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "restore", "opener", "native-close", "event-order", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, openerTab: { tabId: 3 }, captureTab: "ph-restore-opener-child" },
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" } },
      { type: "nativeCloseWindow", window: { role: "focusedWindow" }, order: "windowRemovedOnly" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateRight" }
    ]
  },
  {
    id: "ph-restore-then-close-reject-focused",
    title: "restore then close reject focused",
    notes: "Post-recovery mutation for restored window recovery followed by rejected outliner close of the restored focused window and restart reconstruction.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "restore", "outliner-close", "command-rejection", "restart", "manual-refresh"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" } },
      { type: "outlinerCloseNodeRejectingClose", node: { window: { role: "focusedWindow" } } },
      { type: "restartBackground" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "ph-opener-source-delete-redo-reordered",
    title: "opener source delete redo reordered",
    notes: "Post-recovery mutation for opener grandchild relocation, source delete rejection recovery, history replay, and reordered focused-window query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "opener", "delete-rejection", "undo-redo", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "ph-opener-delete-child" },
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { capture: "ph-opener-delete-child" }, captureTab: "ph-opener-delete-grandchild" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "ph-opener-delete-grandchild" }, captureStaleTabs: "ph-opener-delete-old" },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { windowId: 10 } } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "firstRuntimeWindow" }, order: "rotateLeft" }
    ]
  },
  {
    id: "ph-relocation-current-refresh-missing-destination",
    title: "relocation current refresh missing destination",
    notes: "Post-recovery mutation for command relocation with fresh current metadata before a missing destination-window query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "relocation", "fresh-event", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "ph-relocation-current-old" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Post recovery before missing destination" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "lastOpenedWindow" } }
    ]
  },
  {
    id: "ph-restart-id-gap-session-skew",
    title: "restart id gap session skew",
    notes: "Post-recovery mutation for browser-created runtime ID gaps, session-only disappearance, restart, and skewed surviving-window query evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "created-event", "native-close", "restart", "session", "stale-query"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "ph-restart-gap-source" },
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "ph-restart-gap-background" },
      { type: "nativeCloseTab", tab: { capture: "ph-restart-gap-background" }, order: "sessionChangedOnly" },
      { type: "restartBackground" },
      { type: "sessionChanged" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" }
    ]
  },
  {
    id: "ph-focus-reject-after-native-window-only",
    title: "focus reject after native window only",
    notes: "Post-recovery mutation for native windowRemoved-only evidence followed by focus rejection and session/manual reconciliation.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "focus", "native-close", "event-order", "command-rejection", "session"],
    actions: [
      { type: "nativeCloseWindow", window: { windowId: 20 }, order: "windowRemovedOnly" },
      { type: "outlinerFocusTabRejectingUpdate", tab: { tabId: 1 } },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "ph-opener-source-delete-redo-first-reordered",
    title: "opener source delete redo first reordered",
    notes: "Post-recovery mutation for opener relocation and source delete recovery, using first surviving runtime window after history replay.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "opener", "delete-rejection", "undo-redo", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "ph-opener-first-child" },
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { capture: "ph-opener-first-child" }, captureTab: "ph-opener-first-grandchild" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "ph-opener-first-grandchild" }, captureStaleTabs: "ph-opener-first-old" },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { windowId: 10 } } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "firstRuntimeWindow" }, order: "rotateRight" }
    ]
  },
  {
    id: "ph-restore-delete-redo-first-query",
    title: "restore delete redo first query",
    notes: "Post-recovery mutation for restore recovery followed by delete rejection history replay and first-window partial query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "restore", "delete-rejection", "undo-redo", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" } },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { role: "firstRuntimeWindow" } } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "firstRuntimeWindow" } }
    ]
  },
  {
    id: "ph-close-reject-multitab-source-restart-first",
    title: "close reject multitab source restart first",
    notes: "Post-recovery mutation for rejected close of a multi-tab source window, restart, and reordered first surviving window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "outliner-close", "command-rejection", "restart", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "ph-close-multitab-source-extra" },
      { type: "outlinerCloseNodeRejectingClose", node: { window: { windowId: 10 } } },
      { type: "restartBackground" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "firstRuntimeWindow" }, order: "reverse" }
    ]
  },
  {
    id: "ph-relocation-native-source-stale-first",
    title: "relocation native source stale first",
    notes: "Post-recovery mutation for relocation, native source windowRemoved-only evidence, stale old-window echo, and first-window query refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "relocation", "native-close", "stale-event", "stale-query", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "ph-relocation-native-source-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "windowRemovedOnly" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "ph-relocation-native-source-old" }, withStaleQuery: true },
      { type: "manualRefreshWithReorderedQuery", window: { role: "firstRuntimeWindow" }, order: "rotateLeft" }
    ]
  },
  {
    id: "ph-restore-active-focus-reject-session",
    title: "restore active focus reject session",
    notes: "Post-recovery mutation for restored active tab recovery followed by focus rejection on the current active runtime tab and session refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "restore", "focus", "command-rejection", "session", "manual-refresh"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" } },
      { type: "outlinerFocusTabRejectingUpdate", tab: { role: "activeTab" } },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "ph-query-created-focus-session-first",
    title: "query created focus session first",
    notes: "Post-recovery mutation for no-command tab creation, focus churn, session refresh, and partial first-window query skew.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "created-event", "focus", "session", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "ph-query-focus-source" },
      { type: "focusWindow", window: { windowId: 20 } },
      { type: "activateTab", tab: { tabId: 3 } },
      { type: "sessionChanged" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "firstRuntimeWindow" } }
    ]
  },
  {
    id: "ph-query-no-command-focus-restart-reordered",
    title: "query no command focus restart reordered",
    notes: "Post-recovery mutation for browser-created tabs with focus/session churn across restart and reordered first-window query evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "created-event", "focus", "restart", "session", "stale-query"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "ph-query-no-command-focus-source" },
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "ph-query-no-command-focus-background" },
      { type: "focusWindow", window: { windowId: 20 } },
      { type: "sessionChanged" },
      { type: "restartBackground" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "firstRuntimeWindow" }, order: "rotateLeft" }
    ]
  },
  {
    id: "ph-native-close-order-restart-session",
    title: "native close order restart session",
    notes: "Post-recovery mutation for native tabs-then-window removal order across restart and later session refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "native-close", "event-order", "restart", "session", "manual-refresh"],
    actions: [
      { type: "nativeCloseWindow", window: { windowId: 20 }, order: "tabsRemovedThenWindowRemoved" },
      { type: "restartBackground" },
      { type: "sessionChanged" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "firstRuntimeWindow" }, order: "reverse" }
    ]
  },
  {
    id: "ph-relocation-restart-current-first-reordered",
    title: "relocation restart current first reordered",
    notes: "Post-recovery mutation for command relocation across restart with fresh current tab metadata and first-window query reorder.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "relocation", "restart", "fresh-event", "stale-query", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "ph-relocation-restart-current-old" },
      { type: "restartBackground" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Post recovery relocation restart current" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "firstRuntimeWindow" }, order: "rotateRight" }
    ]
  },
  {
    id: "ph-close-reject-tab-undo-redo",
    title: "close reject tab undo redo",
    notes: "Post-recovery mutation for rejected tab close side effects combined with history replay and manual reconciliation.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "outliner-close", "command-rejection", "undo-redo", "manual-refresh"],
    actions: [
      { type: "outlinerCloseNodeRejectingClose", node: { tab: { tabId: 2 } } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "ph-query-session-rotate-both-windows",
    title: "query session rotate both windows",
    notes: "Post-recovery mutation for no-command browser-created tabs, session churn, and sequential reordered snapshots in both windows.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "created-event", "session", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "ph-query-rotate-source" },
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "ph-query-rotate-background" },
      { type: "sessionChanged" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateLeft" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 20 }, order: "rotateRight" }
    ]
  },
  {
    id: "ph-relocation-fresh-session-reordered",
    title: "relocation fresh session reordered",
    notes: "Post-recovery mutation for relocation with fresh current metadata, session refresh, and reordered source-window query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "relocation", "fresh-event", "session", "stale-query", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "ph-relocation-fresh-session-old" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Post recovery fresh session" },
      { type: "sessionChanged" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" }
    ]
  },
  {
    id: "ph-native-tabs-only-refresh-restart",
    title: "native tabs only refresh restart",
    notes: "Post-recovery mutation for tabsRemoved-only native window evidence, manual refresh, restart, and surviving-window reorder.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "native-close", "event-order", "manual-refresh", "restart", "stale-query"],
    actions: [
      { type: "nativeCloseWindow", window: { windowId: 20 }, order: "tabsRemovedOnly" },
      { type: "manualRefresh" },
      { type: "restartBackground" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateLeft" }
    ]
  },
  {
    id: "ph-query-created-restart-missing-first",
    title: "query created restart missing first",
    notes: "Post-recovery mutation for browser-created tabs across restart followed by a missing first-window query and surviving-window reorder.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "created-event", "restart", "partial-snapshot", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "ph-query-created-restart-source" },
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "ph-query-created-restart-background" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "firstRuntimeWindow" } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 20 }, order: "rotateLeft" }
    ]
  },
  {
    id: "ph-relocation-fresh-restart-missing-tab",
    title: "relocation fresh restart missing tab",
    notes: "Post-recovery mutation for command relocation with fresh metadata across restart and a missing moved-tab query snapshot.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "relocation", "fresh-event", "restart", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "ph-relocation-fresh-restart-old" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Post recovery before restart missing tab" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingTabQuery", tab: { role: "lastMovedTab" } }
    ]
  },
  {
    id: "ph-query-created-session-missing-tab-restart",
    title: "query created session missing tab restart",
    notes: "Post-recovery mutation for no-command created tab, partial missing-tab query, session churn, and restart reconstruction.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "created-event", "partial-snapshot", "session", "restart", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "ph-query-created-session-tab" },
      { type: "manualRefreshWithMissingTabQuery", tab: { capture: "ph-query-created-session-tab" } },
      { type: "sessionChanged" },
      { type: "restartBackground" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "ph-relocation-session-source-destination-skew",
    title: "relocation session source destination skew",
    notes: "Post-recovery mutation for relocation, session churn, source-window missing query, and destination reordered query evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["post-recovery", "relocation", "session", "partial-snapshot", "stale-query", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "ph-relocation-session-skew-old" },
      { type: "sessionChanged" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } },
      { type: "manualRefreshWithReorderedQuery", window: { role: "lastOpenedWindow" }, order: "rotateLeft" }
    ]
  },
  {
    id: "lh-close-restore-reject-captured-tab",
    title: "close restore reject captured tab",
    notes: "Transaction-boundary probe for close side-effect recovery followed by restore create rejection, using current restored-tab capture.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "outliner-close", "restore", "command-rejection", "partial-snapshot"],
    actions: [
      { type: "outlinerCloseNodeRejectingClose", node: { tab: { tabId: 2 } } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" }, captureRestoredTabs: "lh-restored-tab" },
      { type: "manualRefreshWithMissingTabQuery", tab: { capture: "lh-restored-tab" } }
    ]
  },
  {
    id: "lh-delete-reject-then-close-reject-survivor",
    title: "delete reject then close reject survivor",
    notes: "Transaction-boundary probe for delete-owned side-effect recovery followed by independent outliner close recovery.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "delete-rejection", "outliner-close", "command-rejection", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "lh-delete-then-close-extra" },
      { type: "outlinerDeleteNodeRejectingClose", node: { tab: { capture: "lh-delete-then-close-extra" } } },
      { type: "outlinerCloseNodeRejectingClose", node: { tab: { tabId: 2 } } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "lh-restore-reject-then-close-reject-window",
    title: "restore reject then close reject window",
    notes: "Transaction-boundary probe for restored-window recovery followed by rejected close of the current restored runtime window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "restore", "outliner-close", "command-rejection", "restart"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredWindows: "lh-restored-window" },
      { type: "outlinerCloseNodeRejectingClose", node: { window: { capture: "lh-restored-window" } } },
      { type: "restartBackground" }
    ]
  },
  {
    id: "lh-close-recovery-undo-redo-session",
    title: "close recovery undo redo session",
    notes: "Transaction-boundary probe for close recovery followed by history replay and session/manual reconciliation.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "outliner-close", "undo-redo", "session", "manual-refresh"],
    actions: [
      { type: "outlinerCloseNodeRejectingClose", node: { tab: { tabId: 2 } } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "lh-group-foreign-window-close-reject",
    title: "group foreign window close reject",
    notes: "Transaction-boundary probe for closing a source window that contains a command-created foreign live window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "nested", "outliner-close", "command-rejection", "stale-event"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "lh-foreign-close-old" },
      { type: "outlinerCloseNodeRejectingClose", node: { window: { windowId: 10 } } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "lh-foreign-close-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "lh-multitab-source-close-reject-reordered",
    title: "multitab source close reject reordered",
    notes: "Transaction-boundary probe for rejected close of a multi-tab source window followed by reordered surviving-window evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "outliner-close", "command-rejection", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "lh-multitab-close-extra" },
      { type: "outlinerCloseNodeRejectingClose", node: { window: { windowId: 10 } } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 20 }, order: "reverse" }
    ]
  },
  {
    id: "lh-nested-command-window-close-reject-extra",
    title: "nested command window close reject extra",
    notes: "Transaction-boundary probe for closing a command-created destination window that also gained a browser-created tab.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "nested", "outliner-close", "created-event", "session"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "lh-nested-close-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, captureTab: "lh-nested-close-extra" },
      { type: "outlinerCloseNodeRejectingClose", node: { window: { role: "lastOpenedWindow" } } },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "lh-restored-multitab-window-close-reject",
    title: "restored multitab window close reject",
    notes: "Transaction-boundary probe for restoring a multi-tab window via rejected create, then closing the restored runtime window via rejected close.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "restore", "outliner-close", "command-rejection", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "lh-restored-multitab-extra" },
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredWindows: "lh-restored-multitab-window" },
      { type: "outlinerCloseNodeRejectingClose", node: { window: { capture: "lh-restored-multitab-window" } } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "lh-no-focused-after-delete-first-query",
    title: "no focused after delete first query",
    notes: "Transaction-boundary probe for destructive delete/history replay without assuming a focused runtime window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "delete-rejection", "undo-redo", "focus", "stale-query"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "lh-no-focus-extra" },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { windowId: 10 } } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "firstRuntimeWindow" }, order: "rotateRight" }
    ]
  },
  {
    id: "lh-focus-reject-after-close-recovery",
    title: "focus reject after close recovery",
    notes: "Transaction-boundary probe for focus command side effects after a recovered outliner close.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "outliner-close", "focus", "command-rejection", "session"],
    actions: [
      { type: "outlinerCloseNodeRejectingClose", node: { tab: { tabId: 2 } } },
      { type: "outlinerFocusTabRejectingUpdate", tab: { tabId: 1 } },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "lh-activation-after-restart-close-reject",
    title: "activation after restart close reject",
    notes: "Transaction-boundary probe for activation/session evidence after close recovery crosses restart reconstruction.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "outliner-close", "restart", "activation", "manual-refresh"],
    actions: [
      { type: "outlinerCloseNodeRejectingClose", node: { tab: { tabId: 2 } } },
      { type: "restartBackground" },
      { type: "activateTab", tab: { tabId: 1 } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "lh-active-snapshot-after-undo-redo",
    title: "active snapshot after undo redo",
    notes: "Transaction-boundary probe for active state after close/history replay and reordered source query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "activation", "undo-redo", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "lh-active-history-tab" },
      { type: "activateTab", tab: { capture: "lh-active-history-tab" } },
      { type: "outlinerCloseTab", tab: { capture: "lh-active-history-tab" } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateLeft" }
    ]
  },
  {
    id: "lh-missing-command-window-reordered-source",
    title: "missing command window reordered source",
    notes: "Transaction-boundary probe for missing command-created destination evidence plus reordered source evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "relocation", "partial-snapshot", "stale-query", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "lh-missing-command-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, captureTab: "lh-missing-command-extra" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "lastOpenedWindow" } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateRight" }
    ]
  },
  {
    id: "lh-missing-restored-window-fresh-event",
    title: "missing restored window fresh event",
    notes: "Transaction-boundary probe for fresh current evidence in a restored window before a partial missing-window snapshot.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "restore", "fresh-event", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredTabs: "lh-restored-fresh-tabs", captureRestoredWindows: "lh-restored-fresh-window" },
      { type: "updateTab", tab: { capture: "lh-restored-fresh-tabs" }, title: "Ledger restored fresh" },
      { type: "manualRefreshWithMissingWindowQuery", window: { capture: "lh-restored-fresh-window" } }
    ]
  },
  {
    id: "lh-stale-event-after-close-recovery",
    title: "stale event after close recovery",
    notes: "Transaction-boundary probe for stale old-window evidence after closing a command-relocated tab through recovered outliner close.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "relocation", "outliner-close", "stale-event", "stale-query"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "lh-close-recovery-stale-old" },
      { type: "outlinerCloseNodeRejectingClose", node: { tab: { role: "lastMovedTab" } } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "lh-close-recovery-stale-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "lh-no-command-created-partial-pair",
    title: "no command created partial pair",
    notes: "Transaction-boundary control for browser-created tabs under paired partial/reordered query evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "created-event", "partial-snapshot", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "lh-no-command-source" },
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "lh-no-command-background" },
      { type: "manualRefreshWithMissingTabQuery", tab: { capture: "lh-no-command-source" } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 20 }, order: "reverse" }
    ]
  },
  {
    id: "lh-close-recovery-restart-stale-query",
    title: "close recovery restart stale query",
    notes: "Transaction-boundary probe for recovered close across restart followed by source-window reordered evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "outliner-close", "restart", "stale-query", "manual-refresh"],
    actions: [
      { type: "outlinerCloseNodeRejectingClose", node: { tab: { tabId: 2 } } },
      { type: "restartBackground" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" }
    ]
  },
  {
    id: "lh-restore-delete-redo-restart-first",
    title: "restore delete redo restart first",
    notes: "Transaction-boundary probe for restore recovery, delete rejection, history replay, restart, and first-window query evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "restore", "delete-rejection", "undo-redo", "restart"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredWindows: "lh-restore-delete-window" },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { role: "firstRuntimeWindow" } } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "restartBackground" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "firstRuntimeWindow" }, order: "rotateLeft" }
    ]
  },
  {
    id: "lh-relocation-focus-restart-stale-old",
    title: "relocation focus restart stale old",
    notes: "Transaction-boundary probe for relocation focus command across restart followed by stale old-window evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "relocation", "focus", "restart", "stale-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "lh-relocation-focus-old" },
      { type: "outlinerFocusTab", tab: { role: "lastMovedTab" } },
      { type: "restartBackground" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "lh-relocation-focus-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "lh-id-gap-history-replay",
    title: "id gap history replay",
    notes: "Transaction-boundary probe for browser-created id gaps, native session-only disappearance, history replay, and restart reconstruction.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "created-event", "native-close", "undo-redo", "restart"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "lh-id-gap-tab" },
      { type: "nativeCloseTab", tab: { capture: "lh-id-gap-tab" }, order: "sessionChangedOnly" },
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "restartBackground" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "firstRuntimeWindow" }, order: "rotateRight" }
    ]
  },
  {
    id: "lh-restore-tab-close-reject-after-current-update",
    title: "restore tab close reject after current update",
    notes: "Transaction-boundary mutation for restore recovery, fresh current metadata, and rejected close of the recovered tab.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "restore", "fresh-event", "outliner-close", "command-rejection"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" }, captureRestoredTabs: "lh-restored-close-tab" },
      { type: "updateTab", tab: { capture: "lh-restored-close-tab" }, title: "Recovered then closed" },
      { type: "outlinerCloseNodeRejectingClose", node: { tab: { capture: "lh-restored-close-tab" } } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "lh-close-reject-window-then-restore-reject",
    title: "close reject window then restore reject",
    notes: "Transaction-boundary mutation for window close recovery followed by restore create rejection of the same outline window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "outliner-close", "restore", "command-rejection", "restart"],
    actions: [
      { type: "outlinerCloseNodeRejectingClose", node: { window: { windowId: 20 } } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredWindows: "lh-close-then-restore-window" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingWindowQuery", window: { capture: "lh-close-then-restore-window" } }
    ]
  },
  {
    id: "lh-relocation-reject-close-destination-current",
    title: "relocation reject close destination current",
    notes: "Transaction-boundary mutation for relocation side-effect rejection, destination close recovery, restart, and stale old evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "relocation", "command-rejection", "outliner-close", "stale-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindowRejectingCreate", tab: { tabId: 1 }, captureStaleTabs: "lh-reject-close-destination-old" },
      { type: "outlinerCloseNodeRejectingClose", node: { window: { role: "lastOpenedWindow" } } },
      { type: "restartBackground" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "lh-reject-close-destination-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "lh-focus-reject-after-window-only-close",
    title: "focus reject after window only close",
    notes: "Transaction-boundary mutation for native window-only close classification followed by rejected focus side effects.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "native-close", "event-order", "focus", "command-rejection"],
    actions: [
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "windowRemovedOnly" },
      { type: "restartBackground" },
      { type: "outlinerFocusTabRejectingUpdate", tab: { tabId: 3 } },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "lh-restored-window-close-native-order",
    title: "restored window close native order",
    notes: "Transaction-boundary mutation for restored-window recovery followed by native close event-order classification.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "restore", "native-close", "event-order", "restart"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredWindows: "lh-native-restored-window" },
      { type: "nativeCloseWindow", window: { capture: "lh-native-restored-window" }, order: "tabsRemovedThenWindowRemoved" },
      { type: "restartBackground" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "lh-source-close-reject-missing-destination",
    title: "source close reject missing destination",
    notes: "Transaction-boundary mutation for recovered source close while destination evidence is absent and old evidence arrives later.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "relocation", "outliner-close", "partial-snapshot", "stale-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "lh-source-close-missing-destination-old" },
      { type: "outlinerCloseNodeRejectingClose", node: { window: { windowId: 10 } } },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "lastOpenedWindow" } },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "lh-source-close-missing-destination-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "lh-relocated-tab-close-reject-history",
    title: "relocated tab close reject history",
    notes: "Transaction-boundary mutation for relocated tab close recovery followed by undo/redo replay and stale source query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "relocation", "outliner-close", "undo-redo", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "lh-relocated-close-history-old" },
      { type: "outlinerCloseNodeRejectingClose", node: { tab: { role: "lastMovedTab" } } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "lh-relocated-close-history-old" } }
    ]
  },
  {
    id: "lh-delete-reject-window-restore-history",
    title: "delete reject window restore history",
    notes: "Transaction-boundary mutation for delete rejection, history replay, restored captures, and reordered first-window evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "delete-rejection", "restore", "undo-redo", "stale-query"],
    actions: [
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { windowId: 20 } } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "outlinerUndo" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "firstRuntimeWindow" }, order: "reverse" }
    ]
  },
  {
    id: "lh-no-command-id-gap-double-partial",
    title: "no command id gap double partial",
    notes: "Transaction-boundary control for browser-created id gaps and paired partial snapshots without command ownership.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "created-event", "native-close", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "lh-id-gap-a" },
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "lh-id-gap-b" },
      { type: "nativeCloseTab", tab: { capture: "lh-id-gap-a" }, order: "sessionChangedOnly" },
      { type: "manualRefreshWithMissingTabQuery", tab: { capture: "lh-id-gap-b" } },
      { type: "manualRefreshWithReorderedQuery", window: { role: "firstRuntimeWindow" }, order: "rotateRight" }
    ]
  },
  {
    id: "lh-close-reject-focus-reject-restart-current",
    title: "close reject focus reject restart current",
    notes: "Transaction-boundary mutation for consecutive close/focus command rejections across restart and current refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "outliner-close", "focus", "command-rejection", "restart"],
    actions: [
      { type: "outlinerCloseNodeRejectingClose", node: { tab: { tabId: 2 } } },
      { type: "outlinerFocusTabRejectingUpdate", tab: { tabId: 1 } },
      { type: "restartBackground" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "lh-relocated-window-close-reject-history",
    title: "relocated window close reject history",
    notes: "Transaction-boundary mutation for closing a command-created destination window, then replaying undo/redo with old source evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "relocation", "outliner-close", "undo-redo", "stale-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "lh-relocated-window-history-old" },
      { type: "outlinerCloseNodeRejectingClose", node: { window: { role: "lastOpenedWindow" } } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "lh-relocated-window-history-old" } }
    ]
  },
  {
    id: "lh-restored-tab-delete-reject-focus-restart",
    title: "restored tab delete reject focus restart",
    notes: "Transaction-boundary mutation for recovered restore, delete rejection, focus rejection, and restart reconstruction.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "restore", "delete-rejection", "focus", "restart"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" }, captureRestoredTabs: "lh-restored-delete-focus-tab" },
      { type: "outlinerDeleteNodeRejectingClose", node: { tab: { capture: "lh-restored-delete-focus-tab" } } },
      { type: "outlinerUndo" },
      { type: "outlinerFocusTabRejectingUpdate", tab: { tabId: 1 } },
      { type: "restartBackground" }
    ]
  },
  {
    id: "lh-restored-window-close-reject-undo",
    title: "restored window close reject undo",
    notes: "Transaction-boundary mutation for restored-window close recovery followed by undo and full refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "restore", "outliner-close", "undo-redo", "manual-refresh"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredWindows: "lh-restored-close-undo-window" },
      { type: "outlinerCloseNodeRejectingClose", node: { window: { capture: "lh-restored-close-undo-window" } } },
      { type: "outlinerUndo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "lh-close-reject-native-tabs-only-history",
    title: "close reject native tabs only history",
    notes: "Transaction-boundary mutation for rejected close recovery, undo, then tabs-only native source-window evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "outliner-close", "native-close", "event-order", "undo-redo"],
    actions: [
      { type: "outlinerCloseNodeRejectingClose", node: { tab: { tabId: 2 } } },
      { type: "outlinerUndo" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "tabsRemovedOnly" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "lh-relocation-reject-focus-history",
    title: "relocation reject focus history",
    notes: "Transaction-boundary mutation for relocation side-effect rejection, focus rejection, history replay, and stale old query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "relocation", "focus", "command-rejection", "undo-redo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindowRejectingCreate", tab: { tabId: 1 }, captureStaleTabs: "lh-reject-focus-history-old" },
      { type: "outlinerFocusTabRejectingUpdate", tab: { role: "lastMovedTab" } },
      { type: "outlinerUndo" },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "lh-reject-focus-history-old" } }
    ]
  },
  {
    id: "lh-close-reject-multitab-window-undo-query",
    title: "close reject multitab window undo query",
    notes: "Transaction-boundary mutation for multi-tab window close recovery, undo/redo, and reordered surviving query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "outliner-close", "undo-redo", "stale-query", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "lh-close-reject-multitab-undo-extra" },
      { type: "outlinerCloseNodeRejectingClose", node: { window: { windowId: 20 } } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "firstRuntimeWindow" }, order: "rotateLeft" }
    ]
  },
  {
    id: "lh-delete-reject-focus-restart-partial",
    title: "delete reject focus restart partial",
    notes: "Transaction-boundary mutation for delete rejection followed by focus rejection, restart, and partial source evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "delete-rejection", "focus", "restart", "partial-snapshot"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "lh-delete-focus-partial-tab" },
      { type: "outlinerDeleteNodeRejectingClose", node: { tab: { capture: "lh-delete-focus-partial-tab" } } },
      { type: "outlinerFocusTabRejectingUpdate", tab: { tabId: 3 } },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } }
    ]
  },
  {
    id: "lh-restore-current-missing-double-window",
    title: "restore current missing double window",
    notes: "Transaction-boundary mutation for restored current evidence, missing restored window, and reordered source window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "restore", "fresh-event", "partial-snapshot", "stale-query"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredTabs: "lh-restore-current-missing-tabs", captureRestoredWindows: "lh-restore-current-missing-window" },
      { type: "updateTab", tab: { capture: "lh-restore-current-missing-tabs" }, title: "Recovered partial source" },
      { type: "manualRefreshWithMissingWindowQuery", window: { capture: "lh-restore-current-missing-window" } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" }
    ]
  },
  {
    id: "lh-focus-reject-close-reject-current-window",
    title: "focus reject close reject current window",
    notes: "Transaction-boundary mutation for rejected focus side effects before rejected close of the same current window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "focus", "outliner-close", "command-rejection", "session"],
    actions: [
      { type: "outlinerFocusTabRejectingUpdate", tab: { tabId: 3 } },
      { type: "outlinerCloseNodeRejectingClose", node: { window: { windowId: 20 } } },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "lh-relocation-reject-native-destination-tabs-only",
    title: "relocation reject native destination tabs only",
    notes: "Transaction-boundary mutation for relocation side-effect rejection followed by tabs-only destination native close.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "relocation", "command-rejection", "native-close", "event-order"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindowRejectingCreate", tab: { tabId: 1 }, captureStaleTabs: "lh-reject-native-destination-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "tabsRemovedOnly" },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "lh-browser-created-close-reject-partial",
    title: "browser created close reject partial",
    notes: "Transaction-boundary control for browser-created tabs, rejected close, and partial query without command relocation.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "created-event", "outliner-close", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "lh-browser-created-close-tab" },
      { type: "outlinerCloseNodeRejectingClose", node: { tab: { capture: "lh-browser-created-close-tab" } } },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 20 } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateRight" }
    ]
  },
  {
    id: "lh-restore-focus-native-tabs-only",
    title: "restore focus native tabs only",
    notes: "Transaction-boundary mutation for restore recovery, rejected focus, and tabs-only native close of the restored window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "restore", "focus", "native-close", "event-order"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredTabs: "lh-restore-focus-native-tabs", captureRestoredWindows: "lh-restore-focus-native-window" },
      { type: "outlinerFocusTabRejectingUpdate", tab: { capture: "lh-restore-focus-native-tabs" } },
      { type: "nativeCloseWindow", window: { capture: "lh-restore-focus-native-window" }, order: "tabsRemovedOnly" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "lh-delete-close-chain-partial-current",
    title: "delete close chain partial current",
    notes: "Transaction-boundary mutation for delete rejection followed by independent rejected close and partial current evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "delete-rejection", "outliner-close", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "lh-delete-close-chain-tab" },
      { type: "outlinerDeleteNodeRejectingClose", node: { tab: { capture: "lh-delete-close-chain-tab" } } },
      { type: "outlinerCloseNodeRejectingClose", node: { window: { windowId: 20 } } },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "lh-session-created-close-reject-restart",
    title: "session created close reject restart",
    notes: "Transaction-boundary control for browser-created tab, session churn, rejected close, and restart reconstruction.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "created-event", "session", "outliner-close", "restart"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: true, captureTab: "lh-session-created-close-tab" },
      { type: "sessionChanged" },
      { type: "outlinerCloseNodeRejectingClose", node: { tab: { capture: "lh-session-created-close-tab" } } },
      { type: "restartBackground" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "firstRuntimeWindow" }, order: "rotateLeft" }
    ]
  },
  {
    id: "lh-focus-reject-two-window-reorder",
    title: "focus reject two window reorder",
    notes: "Transaction-boundary mutation for rejected focus followed by reordered snapshots from both initial windows.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "focus", "command-rejection", "stale-query", "manual-refresh"],
    actions: [
      { type: "outlinerFocusTabRejectingUpdate", tab: { tabId: 3 } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 20 }, order: "reverse" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateRight" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "lh-restart-no-command-focus-id-gap",
    title: "restart no command focus id gap",
    notes: "Transaction-boundary control for browser-only id gaps, restart reconstruction, and rejected focus.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "created-event", "native-close", "restart", "focus"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "lh-restart-gap-a" },
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "lh-restart-gap-b" },
      { type: "nativeCloseTab", tab: { capture: "lh-restart-gap-a" }, order: "sessionChangedOnly" },
      { type: "restartBackground" },
      { type: "outlinerFocusTabRejectingUpdate", tab: { capture: "lh-restart-gap-b" } },
      { type: "manualRefreshWithReorderedQuery", window: { role: "firstRuntimeWindow" }, order: "reverse" }
    ]
  },
  {
    id: "lh-restore-delete-close-chain-session",
    title: "restore delete close chain session",
    notes: "Transaction-boundary mutation for restore recovery, delete rejection, independent close rejection, and session churn.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "restore", "delete-rejection", "outliner-close", "session"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredTabs: "lh-restore-delete-close-tabs" },
      { type: "outlinerDeleteNodeRejectingClose", node: { tab: { capture: "lh-restore-delete-close-tabs" } } },
      { type: "outlinerCloseNodeRejectingClose", node: { tab: { tabId: 1 } } },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "lh-relocation-fresh-current-native-source-close",
    title: "relocation fresh current native source close",
    notes: "Transaction-boundary mutation for fresh current relocated metadata followed by native source close without history replay.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["transaction-boundary", "relocation", "fresh-event", "native-close", "event-order"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "lh-fresh-current-native-source-old" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Fresh before source close" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "windowRemovedThenTabsRemoved" },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "lh-fresh-current-native-source-old" } }
    ]
  },
  {
    id: "hh-normal-close-after-relocation-history",
    title: "normal close after relocation history",
    notes: "History-boundary seed for normal outliner close after relocation, then undo/redo of the earlier move.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "outliner-close", "undo-redo", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-normal-close-old" },
      { type: "outlinerCloseTab", tab: { role: "lastMovedTab" } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "hh-native-close-after-relocation-history",
    title: "native close after relocation history",
    notes: "History-boundary seed for browser/native close of a relocated tab before old move undo/redo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "native-close", "undo-redo", "session"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-native-close-old" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "sessionChangedOnly" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "hh-group-close-history-stale-old",
    title: "group close history stale old",
    notes: "History-boundary seed for grouped relocation, close, old move undo, and stale source-window evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "nested", "outliner-close", "stale-event"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "hh-group-close-old" },
      { type: "outlinerCloseTab", tab: { role: "lastMovedTab" } },
      { type: "outlinerUndo" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "hh-group-close-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "hh-group-window-close-history",
    title: "group window close history",
    notes: "History-boundary seed for closing a command-created group window before undo/redo of the grouping command.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "nested", "outliner-close", "undo-redo"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "hh-group-window-close-old" },
      { type: "outlinerCloseWindow", window: { role: "lastOpenedWindow" } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "hh-group-window-close-old" } }
    ]
  },
  {
    id: "hh-relocation-reject-close-history",
    title: "relocation reject close history",
    notes: "History-boundary seed for relocation create side effect recovery followed by close and history replay.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "command-rejection", "outliner-close", "undo-redo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindowRejectingCreate", tab: { tabId: 1 }, captureStaleTabs: "hh-reject-close-old" },
      { type: "outlinerCloseTab", tab: { role: "lastMovedTab" } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "hh-restore-after-closed-history",
    title: "restore after closed history",
    notes: "History-boundary seed for restoring a tab after an old move undo touched its closed outline record.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "restore", "undo-redo", "command-rejection"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-restore-after-history-old" },
      { type: "outlinerCloseTab", tab: { role: "lastMovedTab" } },
      { type: "outlinerUndo" },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:1" }, captureRestoredTabs: "hh-restored-after-history-tab" },
      { type: "manualRefreshWithMissingTabQuery", tab: { capture: "hh-restored-after-history-tab" } }
    ]
  },
  {
    id: "hh-delete-reject-after-closed-history",
    title: "delete reject after closed history",
    notes: "History-boundary seed for deleting a closed relocated record after old move undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "delete-rejection", "undo-redo", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-delete-after-history-old" },
      { type: "outlinerCloseTab", tab: { role: "lastMovedTab" } },
      { type: "outlinerUndo" },
      { type: "outlinerDeleteNodeRejectingClose", node: { nodeId: "tab:1" } },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "hh-delete-after-history-old" } }
    ]
  },
  {
    id: "hh-opener-child-closed-history",
    title: "opener child closed history",
    notes: "History-boundary seed for opener-linked moved tab closed before history replay and stale opener/source evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "opener", "relocation", "outliner-close", "stale-event"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "hh-opener-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "hh-opener-child" }, captureStaleTabs: "hh-opener-child-old" },
      { type: "outlinerCloseTab", tab: { role: "lastMovedTab" } },
      { type: "outlinerUndo" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "hh-opener-child-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "hh-focus-session-around-closed-history",
    title: "focus session around closed history",
    notes: "History-boundary seed for focus/session churn around a closed relocated tab touched by old undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "focus", "session", "undo-redo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-focus-session-old" },
      { type: "outlinerFocusTab", tab: { role: "lastMovedTab" } },
      { type: "outlinerCloseTab", tab: { role: "lastMovedTab" } },
      { type: "outlinerUndo" },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "hh-restart-after-closed-history",
    title: "restart after closed history",
    notes: "History-boundary seed for restart reconstruction after old move undo touches a closed relocated record.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "outliner-close", "restart", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-restart-closed-old" },
      { type: "outlinerCloseTab", tab: { role: "lastMovedTab" } },
      { type: "outlinerUndo" },
      { type: "restartBackground" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "hh-redo-closed-stale-old",
    title: "redo closed stale old",
    notes: "History-boundary seed for stale old-window event after undo/redo around a closed relocated record.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "undo-redo", "stale-event", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-redo-closed-old" },
      { type: "outlinerCloseTab", tab: { role: "lastMovedTab" } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "hh-redo-closed-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "hh-missing-source-after-closed-history",
    title: "missing source after closed history",
    notes: "History-boundary seed for missing source-window snapshot after closed-node history replay.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "partial-snapshot", "manual-refresh", "undo-redo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-missing-source-old" },
      { type: "outlinerCloseTab", tab: { role: "lastMovedTab" } },
      { type: "outlinerUndo" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } }
    ]
  },
  {
    id: "hh-missing-first-after-closed-history",
    title: "missing first after closed history",
    notes: "History-boundary seed for first surviving window missing from query after closed-node history replay.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "partial-snapshot", "manual-refresh", "undo-redo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-missing-first-old" },
      { type: "outlinerCloseTab", tab: { role: "lastMovedTab" } },
      { type: "outlinerUndo" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "firstRuntimeWindow" } }
    ]
  },
  {
    id: "hh-close-without-prior-move-control",
    title: "close without prior move control",
    notes: "History-boundary control for closing a browser-created tab without prior relocation history.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "created-event", "outliner-close", "undo-redo", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "hh-control-close-tab" },
      { type: "outlinerCloseTab", tab: { capture: "hh-control-close-tab" } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "hh-browser-created-session-control",
    title: "browser created session control",
    notes: "History-boundary control for browser-created tab close plus session/reordered query without relocation history.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "created-event", "session", "outliner-close", "stale-query"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: true, captureTab: "hh-created-session-tab" },
      { type: "outlinerCloseTab", tab: { capture: "hh-created-session-tab" } },
      { type: "sessionChanged" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "firstRuntimeWindow" }, order: "rotateRight" }
    ]
  },
  {
    id: "hh-native-window-close-after-relocation-history",
    title: "native window close after relocation history",
    notes: "History-boundary seed for native close of command-created destination before old move undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "native-close", "event-order", "undo-redo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-native-window-close-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "windowRemovedOnly" },
      { type: "outlinerUndo" },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "hh-native-window-close-old" } }
    ]
  },
  {
    id: "hh-delete-source-window-history",
    title: "delete source window history",
    notes: "History-boundary seed for deleting source window after relocation and then replaying old move history.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "delete-rejection", "undo-redo", "partial-snapshot"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-delete-source-old" },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { windowId: 10 } } },
      { type: "outlinerUndo" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "firstRuntimeWindow" } }
    ]
  },
  {
    id: "hh-restore-window-history-restart",
    title: "restore window history restart",
    notes: "History-boundary seed for restore recovery followed by history replay and restart reconstruction.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "restore", "undo-redo", "restart", "manual-refresh"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredWindows: "hh-restore-history-window" },
      { type: "outlinerUndo" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "firstRuntimeWindow" } }
    ]
  },
  {
    id: "hh-native-close-group-history",
    title: "native close group history",
    notes: "History-boundary clone for native session-only close after grouped relocation before history replay.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "nested", "native-close", "undo-redo"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "hh-native-group-old" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "sessionChangedOnly" },
      { type: "outlinerUndo" },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "hh-native-group-old" } }
    ]
  },
  {
    id: "hh-native-close-opener-history",
    title: "native close opener history",
    notes: "History-boundary clone for opener-linked relocated tab natively closed before old move undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "opener", "relocation", "native-close", "undo-redo"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "hh-native-opener-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "hh-native-opener-child" }, captureStaleTabs: "hh-native-opener-old" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "sessionChangedOnly" },
      { type: "outlinerUndo" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "hh-native-opener-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "hh-native-close-restart-before-undo",
    title: "native close restart before undo",
    notes: "History-boundary clone for native-closed relocated tab crossing restart before undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "native-close", "restart", "undo-redo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-native-restart-old" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "sessionChangedOnly" },
      { type: "restartBackground" },
      { type: "outlinerUndo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "hh-native-close-tabremoved-history",
    title: "native close tabremoved history",
    notes: "History-boundary clone for native tabRemoved event order before old move undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "native-close", "event-order", "undo-redo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-native-tabremoved-old" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "tabRemovedThenSessionChanged" },
      { type: "outlinerUndo" },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "hh-native-tabremoved-old" } }
    ]
  },
  {
    id: "hh-delete-source-group-history",
    title: "delete source group history",
    notes: "History-boundary clone for source-window delete rejection after grouped relocation before old undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "nested", "delete-rejection", "undo-redo"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "hh-delete-source-group-old" },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { windowId: 10 } } },
      { type: "outlinerUndo" },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "hh-delete-source-group-old" } }
    ]
  },
  {
    id: "hh-delete-destination-window-history",
    title: "delete destination window history",
    notes: "History-boundary clone for deleting command-created destination before old move undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "delete-rejection", "undo-redo", "partial-snapshot"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-delete-destination-old" },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { role: "lastOpenedWindow" } } },
      { type: "outlinerUndo" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "firstRuntimeWindow" } }
    ]
  },
  {
    id: "hh-delete-source-focus-history",
    title: "delete source focus history",
    notes: "History-boundary clone for focus churn before source delete rejection and old move undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "focus", "delete-rejection", "undo-redo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-delete-source-focus-old" },
      { type: "outlinerFocusTab", tab: { tabId: 3 } },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { windowId: 10 } } },
      { type: "outlinerUndo" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "hh-delete-source-reordered-history",
    title: "delete source reordered history",
    notes: "History-boundary clone for source delete rejection, old undo, and reordered surviving-window evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "delete-rejection", "stale-query", "undo-redo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-delete-source-reordered-old" },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { windowId: 10 } } },
      { type: "outlinerUndo" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "firstRuntimeWindow" }, order: "reverse" }
    ]
  },
  {
    id: "hh-native-destination-tabs-then-history",
    title: "native destination tabs then history",
    notes: "History-boundary clone for destination window native close with tab removals before window removal, then old move history.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "native-close", "event-order", "undo-redo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-native-dest-tabs-then-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "tabsRemovedThenWindowRemoved" },
      { type: "outlinerUndo" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "hh-native-dest-tabs-then-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "hh-native-destination-tabs-only-redo",
    title: "native destination tabs only redo",
    notes: "History-boundary clone for tabs-only destination close followed by undo/redo of the old relocation.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "native-close", "event-order", "undo-redo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-native-dest-tabs-only-old" },
      { type: "nativeCloseWindow", window: { role: "lastOpenedWindow" }, order: "tabsRemovedOnly" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "hh-native-source-window-tabs-then-history",
    title: "native source window tabs then history",
    notes: "History-boundary clone for source window native close after relocation before old move undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "native-close", "event-order", "undo-redo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-native-source-tabs-then-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "tabsRemovedThenWindowRemoved" },
      { type: "outlinerUndo" },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "hh-native-source-tabs-then-old" } }
    ]
  },
  {
    id: "hh-native-source-window-restart-history",
    title: "native source window restart history",
    notes: "History-boundary clone for source window native close crossing restart before undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "native-close", "restart", "undo-redo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-native-source-restart-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "windowRemovedThenTabsRemoved" },
      { type: "restartBackground" },
      { type: "outlinerUndo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "hh-delete-source-window-redo-history",
    title: "delete source window redo history",
    notes: "History-boundary clone for source delete rejection followed by undo/redo of the old relocation.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "delete-rejection", "undo-redo", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-delete-source-redo-old" },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { windowId: 10 } } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "hh-delete-source-restart-before-undo",
    title: "delete source restart before undo",
    notes: "History-boundary clone for source delete rejection crossing restart before old move undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "delete-rejection", "restart", "undo-redo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-delete-source-restart-old" },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { windowId: 10 } } },
      { type: "restartBackground" },
      { type: "outlinerUndo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "hh-delete-source-stale-after-redo",
    title: "delete source stale after redo",
    notes: "History-boundary clone for source delete rejection, undo/redo, and late stale source-window evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "delete-rejection", "stale-event", "undo-redo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-delete-source-stale-redo-old" },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { windowId: 10 } } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "hh-delete-source-stale-redo-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "hh-delete-source-opener-history",
    title: "delete source opener history",
    notes: "History-boundary clone for opener-linked relocated child after source delete rejection and old undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "opener", "relocation", "delete-rejection", "undo-redo"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "hh-delete-source-opener-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "hh-delete-source-opener-child" }, captureStaleTabs: "hh-delete-source-opener-old" },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { windowId: 10 } } },
      { type: "outlinerUndo" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "hh-delete-source-opener-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "hh-top-level-native-close-history",
    title: "top level native close history",
    notes: "History-boundary clone for top-level relocation natively closed before old move undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "native-close", "undo-redo", "stale-event"],
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "hh-top-level-native-old" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "sessionChangedThenTabRemoved" },
      { type: "outlinerUndo" },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "hh-top-level-native-old" } }
    ]
  },
  {
    id: "hh-top-level-delete-source-history",
    title: "top level delete source history",
    notes: "History-boundary clone for top-level relocation, source delete rejection, and old undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "delete-rejection", "undo-redo", "partial-snapshot"],
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "hh-top-level-delete-source-old" },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { windowId: 10 } } },
      { type: "outlinerUndo" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "firstRuntimeWindow" } }
    ]
  },
  {
    id: "hh-restored-tab-native-close-history",
    title: "restored tab native close history",
    notes: "History-boundary clone for a restored tab that is natively closed before undo of the restore entry.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "restore", "native-close", "undo-redo", "tombstone"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" }, captureRestoredTabs: "hh-restored-native-tab" },
      { type: "nativeCloseTab", tab: { capture: "hh-restored-native-tab" }, order: "tabRemovedThenSessionChanged" },
      { type: "outlinerUndo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "hh-restored-window-native-close-history",
    title: "restored window native close history",
    notes: "History-boundary clone for a restored window that is natively closed before undo of the restore entry.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "restore", "native-close", "undo-redo", "tombstone"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredWindows: "hh-restored-native-window" },
      { type: "nativeCloseWindow", window: { capture: "hh-restored-native-window" }, order: "tabsRemovedThenWindowRemoved" },
      { type: "outlinerUndo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "hh-restored-tab-delete-reject-history",
    title: "restored tab delete reject history",
    notes: "History-boundary clone for deleting a recovered restored tab before replaying restore history.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "restore", "delete-rejection", "undo-redo", "manual-refresh"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" }, captureRestoredTabs: "hh-restored-delete-tab" },
      { type: "outlinerDeleteNodeRejectingClose", node: { tab: { capture: "hh-restored-delete-tab" } } },
      { type: "outlinerUndo" },
      { type: "manualRefreshWithMissingTabQuery", tab: { capture: "hh-restored-delete-tab" } }
    ]
  },
  {
    id: "hh-restored-window-delete-reject-history",
    title: "restored window delete reject history",
    notes: "History-boundary clone for deleting a recovered restored window before replaying restore history.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "restore", "delete-rejection", "undo-redo", "partial-snapshot"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredWindows: "hh-restored-delete-window" },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { capture: "hh-restored-delete-window" } } },
      { type: "outlinerUndo" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "firstRuntimeWindow" } }
    ]
  },
  {
    id: "hh-native-source-window-only-redo",
    title: "native source window only redo",
    notes: "History-boundary clone for window-only source close before undo/redo of the old relocation.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "native-close", "event-order", "undo-redo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-native-source-window-only-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "windowRemovedOnly" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "hh-native-source-window-only-old" } }
    ]
  },
  {
    id: "hh-native-source-tabs-only-redo",
    title: "native source tabs only redo",
    notes: "History-boundary clone for tabs-only source close before undo/redo of the old relocation.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "native-close", "event-order", "undo-redo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-native-source-tabs-only-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "tabsRemovedOnly" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefreshWithStaleQuery", staleTab: { capture: "hh-native-source-tabs-only-old" } }
    ]
  },
  {
    id: "hh-native-source-focus-history",
    title: "native source focus history",
    notes: "History-boundary clone for focus churn before native source close and old move undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "relocation", "native-close", "focus", "undo-redo"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "hh-native-source-focus-old" },
      { type: "outlinerFocusTab", tab: { role: "lastMovedTab" } },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "tabsRemovedThenWindowRemoved" },
      { type: "outlinerUndo" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "hh-native-source-opener-history",
    title: "native source opener history",
    notes: "History-boundary clone for opener-linked relocated child after native source close and old move undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "opener", "relocation", "native-close", "undo-redo"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "hh-native-source-opener-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "hh-native-source-opener-child" }, captureStaleTabs: "hh-native-source-opener-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "tabsRemovedThenWindowRemoved" },
      { type: "outlinerUndo" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "hh-native-source-opener-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "hh-restored-tab-native-session-history",
    title: "restored tab native session history",
    notes: "History-boundary clone for restored tab closed by session-only evidence before restore undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "restore", "native-close", "session", "undo-redo"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" }, captureRestoredTabs: "hh-restored-native-session-tab" },
      { type: "nativeCloseTab", tab: { capture: "hh-restored-native-session-tab" }, order: "sessionChangedOnly" },
      { type: "outlinerUndo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "hh-restored-tab-native-restart-history",
    title: "restored tab native restart history",
    notes: "History-boundary clone for restored tab natively closed, then restart before restore undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "restore", "native-close", "restart", "undo-redo"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" }, captureRestoredTabs: "hh-restored-native-restart-tab" },
      { type: "nativeCloseTab", tab: { capture: "hh-restored-native-restart-tab" }, order: "tabRemovedOnly" },
      { type: "restartBackground" },
      { type: "outlinerUndo" }
    ]
  },
  {
    id: "hh-restored-tab-native-stale-history",
    title: "restored tab native stale history",
    notes: "History-boundary clone for restored tab native close followed by stale restored-tab evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "restore", "native-close", "stale-event", "manual-refresh"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" }, captureRestoredTabs: "hh-restored-native-stale-tab" },
      { type: "nativeCloseTab", tab: { capture: "hh-restored-native-stale-tab" }, order: "tabRemovedThenSessionChanged" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "hh-restored-native-stale-tab" }, withStaleQuery: true }
    ]
  },
  {
    id: "hh-restored-window-native-window-only-history",
    title: "restored window native window only history",
    notes: "History-boundary clone for restored window closed by windowRemovedOnly evidence before restore undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "restore", "native-close", "event-order", "undo-redo"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredWindows: "hh-restored-window-only-window" },
      { type: "nativeCloseWindow", window: { capture: "hh-restored-window-only-window" }, order: "windowRemovedOnly" },
      { type: "outlinerUndo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "hh-restored-window-native-tabs-only-history",
    title: "restored window native tabs only history",
    notes: "History-boundary clone for restored window closed by tabsRemovedOnly evidence before restore undo/redo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "restore", "native-close", "event-order", "undo-redo"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredWindows: "hh-restored-tabs-only-window" },
      { type: "nativeCloseWindow", window: { capture: "hh-restored-tabs-only-window" }, order: "tabsRemovedOnly" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" }
    ]
  },
  {
    id: "hh-restored-window-native-restart-history",
    title: "restored window native restart history",
    notes: "History-boundary clone for restored window natively closed, then restart before restore undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "restore", "native-close", "restart", "undo-redo"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredWindows: "hh-restored-native-restart-window" },
      { type: "nativeCloseWindow", window: { capture: "hh-restored-native-restart-window" }, order: "windowRemovedThenTabsRemoved" },
      { type: "restartBackground" },
      { type: "outlinerUndo" }
    ]
  },
  {
    id: "hh-restored-window-native-stale-history",
    title: "restored window native stale history",
    notes: "History-boundary clone for restored window native close followed by stale restored-tab evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "restore", "native-close", "stale-event", "manual-refresh"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredTabs: "hh-restored-window-stale-tabs", captureRestoredWindows: "hh-restored-window-stale-window" },
      { type: "nativeCloseWindow", window: { capture: "hh-restored-window-stale-window" }, order: "tabsRemovedThenWindowRemoved" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "hh-restored-window-stale-tabs" }, withStaleQuery: true }
    ]
  },
  {
    id: "hh-restored-window-native-missing-history",
    title: "restored window native missing history",
    notes: "History-boundary clone for restored window native close followed by a missing-window refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "restore", "native-close", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredWindows: "hh-restored-window-missing-window" },
      { type: "nativeCloseWindow", window: { capture: "hh-restored-window-missing-window" }, order: "windowRemovedOnly" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "firstRuntimeWindow" } }
    ]
  },
  {
    id: "hh-control-browser-close-restart-history",
    title: "control browser close restart history",
    notes: "History-boundary control for browser-created tab close, undo, restart, and refresh without prior relocation.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "created-event", "outliner-close", "restart", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "hh-control-browser-restart-tab" },
      { type: "outlinerCloseTab", tab: { capture: "hh-control-browser-restart-tab" } },
      { type: "outlinerUndo" },
      { type: "restartBackground" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "hh-control-browser-close-redo-query",
    title: "control browser close redo query",
    notes: "History-boundary control for browser-created tab close, undo/redo, and reordered query without relocation.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "created-event", "outliner-close", "undo-redo", "stale-query"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "hh-control-browser-redo-tab" },
      { type: "outlinerCloseTab", tab: { capture: "hh-control-browser-redo-tab" } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "firstRuntimeWindow" }, order: "rotateLeft" }
    ]
  },
  {
    id: "hh-control-delete-browser-created-history",
    title: "control delete browser created history",
    notes: "History-boundary control for delete rejection on a browser-created tab before history replay.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "created-event", "delete-rejection", "undo-redo", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "hh-control-delete-browser-tab" },
      { type: "outlinerDeleteNodeRejectingClose", node: { tab: { capture: "hh-control-delete-browser-tab" } } },
      { type: "outlinerUndo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "hh-control-restore-window-redo-history",
    title: "control restore window redo history",
    notes: "History-boundary control for restore recovery and undo/redo without later native deletion.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "restore", "undo-redo", "manual-refresh"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredWindows: "hh-control-restore-redo-window" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "hh-control-browser-created-missing-history",
    title: "control browser created missing history",
    notes: "History-boundary control for browser-created tab history replay with a missing-window query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "created-event", "partial-snapshot", "undo-redo", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "hh-control-browser-missing-tab" },
      { type: "outlinerCloseTab", tab: { capture: "hh-control-browser-missing-tab" } },
      { type: "outlinerUndo" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 20 } }
    ]
  },
  {
    id: "hh-control-restore-tab-redo-query",
    title: "control restore tab redo query",
    notes: "History-boundary control for restored tab undo/redo and reordered query without later native deletion.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "restore", "undo-redo", "stale-query", "manual-refresh"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" }, captureRestoredTabs: "hh-control-restore-redo-tab" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "firstRuntimeWindow" }, order: "rotateRight" }
    ]
  },
  {
    id: "hh-control-delete-created-restart-history",
    title: "control delete created restart history",
    notes: "History-boundary control for browser-created tab delete rejection crossing restart before undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "created-event", "delete-rejection", "restart", "undo-redo"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "hh-control-delete-created-restart-tab" },
      { type: "outlinerDeleteNodeRejectingClose", node: { tab: { capture: "hh-control-delete-created-restart-tab" } } },
      { type: "restartBackground" },
      { type: "outlinerUndo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "hh-control-created-focus-session-history",
    title: "control created focus session history",
    notes: "History-boundary control for browser-created tab focus/session churn around close history.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "created-event", "focus", "session", "undo-redo"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "hh-control-created-focus-tab" },
      { type: "outlinerFocusTab", tab: { capture: "hh-control-created-focus-tab" } },
      { type: "outlinerCloseTab", tab: { capture: "hh-control-created-focus-tab" } },
      { type: "outlinerUndo" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "hh-control-restore-tab-restart-query",
    title: "control restore tab restart query",
    notes: "History-boundary control for restored tab history replay across restart without native deletion.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "restore", "restart", "undo-redo", "manual-refresh"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" }, captureRestoredTabs: "hh-control-restore-restart-tab" },
      { type: "outlinerUndo" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingTabQuery", tab: { capture: "hh-control-restore-restart-tab" } }
    ]
  },
  {
    id: "hh-control-created-window-delete-history",
    title: "control created window delete history",
    notes: "History-boundary control for deleting a no-relocation browser-created tab window before undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["history-boundary", "created-event", "delete-rejection", "partial-snapshot", "undo-redo"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "hh-control-created-window-tab" },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { windowId: 20 } } },
      { type: "outlinerUndo" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "firstRuntimeWindow" } }
    ]
  },
  {
    id: "jh-close-tab-abrupt-stale-update",
    title: "journal close tab abrupt stale update",
    notes: "Lifecycle-journal crash probe for outliner tab close side effect before event/save flush, followed by stale tab update evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "outliner-close", "stale-event", "tombstone"],
    actions: [
      { type: "outlinerCloseNodeThenAbruptRestart", node: { tab: { tabId: 2 } }, captureStaleTabs: "jh-close-tab-stale" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "jh-close-tab-stale" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-close-single-window-abrupt-session",
    title: "journal close single window abrupt session",
    notes: "Lifecycle-journal crash probe for outliner close of a single-tab runtime window before close events are delivered.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "outliner-close", "native-close", "session"],
    actions: [
      { type: "outlinerCloseNodeThenAbruptRestart", node: { window: { windowId: 20 } }, captureStaleTabs: "jh-close-single-window-stale" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "jh-close-multi-window-abrupt-refresh",
    title: "journal close multi window abrupt refresh",
    notes: "Lifecycle-journal crash probe for a multi-tab runtime window close reconstructed from the journal before manual refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "outliner-close", "manual-refresh", "multi-tab"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "jh-close-multi-extra" },
      { type: "outlinerCloseNodeThenAbruptRestart", node: { window: { windowId: 20 } }, captureStaleTabs: "jh-close-multi-stale" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-close-grouped-window-abrupt-reordered",
    title: "journal close grouped window abrupt reordered",
    notes: "Lifecycle-journal crash probe for closing a command-created grouped live window before save, then checking surviving-window query order.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "outliner-close", "nested", "stale-query"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "jh-close-group-old" },
      { type: "outlinerCloseNodeThenAbruptRestart", node: { window: { role: "lastOpenedWindow" } }, captureStaleTabs: "jh-close-group-stale" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" }
    ]
  },
  {
    id: "jh-delete-leaf-abrupt-session",
    title: "journal delete leaf abrupt session",
    notes: "Lifecycle-journal crash probe for delete of a live leaf tab before close events or state save.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "delete-rejection", "session", "tombstone"],
    actions: [
      { type: "outlinerDeleteNodeThenAbruptRestart", node: { tab: { tabId: 2 } }, captureStaleTabs: "jh-delete-leaf-stale" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "jh-delete-relocated-source-abrupt-missing",
    title: "journal delete relocated source abrupt missing",
    notes: "Lifecycle-journal crash probe for deleting the source window after command relocation and restarting before delete persistence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "delete-rejection", "relocation", "partial-snapshot", "stale-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "jh-delete-source-old" },
      { type: "outlinerDeleteNodeThenAbruptRestart", node: { window: { windowId: 10 } }, captureStaleTabs: "jh-delete-source-stale" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "jh-delete-source-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-delete-restored-window-abrupt-query",
    title: "journal delete restored window abrupt query",
    notes: "Lifecycle-journal crash probe for deleting a restored window before delete state/history persistence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "restore", "delete-rejection", "partial-snapshot"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeThenAbruptRestart", node: { nodeId: "window:20" }, captureRestoredWindows: "jh-delete-restored-window" },
      { type: "outlinerDeleteNodeThenAbruptRestart", node: { window: { capture: "jh-delete-restored-window" } }, captureStaleTabs: "jh-delete-restored-stale" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-delete-grouped-window-abrupt-stale",
    title: "journal delete grouped window abrupt stale",
    notes: "Lifecycle-journal crash probe for deleting a grouped command-created window before runtime close echoes drain.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "delete-rejection", "nested", "stale-event"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "jh-delete-group-old" },
      { type: "outlinerDeleteNodeThenAbruptRestart", node: { window: { role: "lastOpenedWindow" } }, captureStaleTabs: "jh-delete-group-stale" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "jh-delete-group-stale" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-restore-tab-abrupt-stale-created",
    title: "journal restore tab abrupt stale created",
    notes: "Lifecycle-journal crash probe for restoring a closed tab before create echo or save, followed by stale created evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "restore", "created-event", "stale-event"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeThenAbruptRestart", node: { nodeId: "tab:2" }, captureRestoredTabs: "jh-restore-tab" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "jh-restore-tab" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-restore-window-abrupt-missing",
    title: "journal restore window abrupt missing",
    notes: "Lifecycle-journal crash probe for restoring a closed window before create echo/save, then omitting the restored window from refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "restore", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeThenAbruptRestart", node: { nodeId: "window:20" }, captureRestoredWindows: "jh-restore-window" },
      { type: "manualRefreshWithMissingWindowQuery", window: { capture: "jh-restore-window" } }
    ]
  },
  {
    id: "jh-restore-after-redo-abrupt-query",
    title: "journal restore after redo abrupt query",
    notes: "Lifecycle-journal crash probe for restore after close undo/redo history replay.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "restore", "undo-redo", "manual-refresh"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "outlinerRestoreNodeThenAbruptRestart", node: { nodeId: "tab:2" }, captureRestoredTabs: "jh-restore-redo-tab" },
      { type: "manualRefreshWithMissingTabQuery", tab: { capture: "jh-restore-redo-tab" } }
    ]
  },
  {
    id: "jh-restore-after-native-close-abrupt-session",
    title: "journal restore after native close abrupt session",
    notes: "Lifecycle-journal crash probe for restoring a browser-closed window before restore create evidence drains.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "restore", "native-close", "session"],
    actions: [
      { type: "nativeCloseWindow", window: { windowId: 20 }, order: "windowRemovedThenTabsRemoved" },
      { type: "outlinerRestoreNodeThenAbruptRestart", node: { nodeId: "window:20" }, captureRestoredWindows: "jh-native-restore-window" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "jh-relocate-direct-abrupt-old-updated",
    title: "journal relocate direct abrupt old updated",
    notes: "Lifecycle-journal crash probe for direct command relocation reconstructed after abrupt restart with stale old-window update.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "relocation", "stale-event", "updated-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "jh-relocate-direct-old" },
      { type: "restartBackgroundAbrupt" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "jh-relocate-direct-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-relocate-group-abrupt-old-created",
    title: "journal relocate group abrupt old created",
    notes: "Lifecycle-journal crash probe for grouped relocation reconstructed after abrupt restart with stale created evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "relocation", "nested", "created-event", "stale-event"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "jh-relocate-group-old" },
      { type: "restartBackgroundAbrupt" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "jh-relocate-group-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-relocate-top-level-abrupt-missing",
    title: "journal relocate top level abrupt missing",
    notes: "Lifecycle-journal crash probe for top-level relocation followed by missing destination-window query after abrupt restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "relocation", "partial-snapshot", "manual-refresh"],
    actions: [
      { type: "outlinerMoveSubtreeToTopLevel", tab: { tabId: 1 }, captureStaleTabs: "jh-relocate-top-old" },
      { type: "restartBackgroundAbrupt" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "lastOpenedWindow" } }
    ]
  },
  {
    id: "jh-relocate-twice-abrupt-stale",
    title: "journal relocate twice abrupt stale",
    notes: "Lifecycle-journal crash probe for a later relocation journal entry superseding old relocation evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "relocation", "paired-echo", "stale-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "jh-relocate-twice-first-old" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { role: "lastMovedTab" }, captureStaleTabs: "jh-relocate-twice-second-old" },
      { type: "restartBackgroundAbrupt" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "jh-relocate-twice-first-old" }, withStaleQuery: true },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "jh-relocate-twice-second-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-undo-close-abrupt-missing",
    title: "journal undo close abrupt missing",
    notes: "Lifecycle-journal crash probe for undo of an outliner close before recreated runtime evidence is persisted.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "undo-redo", "outliner-close", "partial-snapshot"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerUndoThenAbruptRestart" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-redo-delete-abrupt-session",
    title: "journal redo delete abrupt session",
    notes: "Lifecycle-journal crash probe for redo of a delete command before close echoes or history persistence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "undo-redo", "delete-rejection", "session"],
    actions: [
      { type: "outlinerDeleteNodeRejectingClose", node: { tab: { tabId: 2 } } },
      { type: "outlinerUndo" },
      { type: "outlinerRedoThenAbruptRestart" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "jh-undo-restore-abrupt-stale",
    title: "journal undo restore abrupt stale",
    notes: "Lifecycle-journal crash probe for undoing a restore before close/delete echoes drain.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "undo-redo", "restore", "stale-event"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeThenAbruptRestart", node: { nodeId: "tab:2" }, captureRestoredTabs: "jh-undo-restore-tab" },
      { type: "outlinerUndoThenAbruptRestart" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "jh-undo-restore-tab" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-undo-relocation-abrupt-old",
    title: "journal undo relocation abrupt old",
    notes: "Lifecycle-journal crash probe for undoing relocation before history save, with stale source evidence arriving after restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "undo-redo", "relocation", "stale-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "jh-undo-relocation-old" },
      { type: "outlinerUndoThenAbruptRestart" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "jh-undo-relocation-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-native-close-no-journal-abrupt",
    title: "native close no journal abrupt",
    notes: "Lifecycle-journal control: a native browser close has no journal and must retain browser-native deletion semantics across abrupt restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "native-close", "manual-refresh"],
    actions: [
      { type: "nativeCloseTab", tab: { tabId: 2 }, order: "tabRemovedOnly" },
      { type: "restartBackgroundAbrupt" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-journal-unconfirmed-close-abrupt",
    title: "journal unconfirmed close abrupt",
    notes: "Lifecycle-journal control: an injected close journal entry without confirmed runtime disappearance must no-op on startup.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "outliner-close", "manual-refresh"],
    actions: [
      { type: "injectCloseJournalThenAbruptRestart", node: { tab: { tabId: 2 } } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-journal-recovered-stale-contradiction",
    title: "journal recovered stale contradiction",
    notes: "Lifecycle-journal contradiction probe: recovered outliner close should ignore stale created evidence for the closed tab.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "outliner-close", "created-event", "stale-event"],
    actions: [
      { type: "outlinerCloseNodeThenAbruptRestart", node: { tab: { tabId: 2 } }, captureStaleTabs: "jh-recovered-stale-tab" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "jh-recovered-stale-tab" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-journal-recovered-native-contradiction",
    title: "journal recovered native contradiction",
    notes: "Lifecycle-journal contradiction probe: recovered close of one tab followed by unrelated native close and session churn.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "outliner-close", "native-close", "session"],
    actions: [
      { type: "outlinerCloseNodeThenAbruptRestart", node: { tab: { tabId: 2 } }, captureStaleTabs: "jh-recovered-native-stale" },
      { type: "nativeCloseWindow", window: { windowId: 20 }, order: "windowRemovedOnly" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "jh-close-relocated-destination-abrupt-old-event",
    title: "journal close relocated destination abrupt old event",
    notes: "Lifecycle-journal crash probe for closing a command-created destination window after relocation, then delivering stale source-window evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "outliner-close", "relocation", "stale-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "jh-close-relocated-old" },
      { type: "outlinerCloseNodeThenAbruptRestart", node: { window: { role: "lastOpenedWindow" } }, captureStaleTabs: "jh-close-relocated-destination" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "jh-close-relocated-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-close-relocated-source-abrupt-session",
    title: "journal close relocated source abrupt session",
    notes: "Lifecycle-journal crash probe for closing the source window left behind after relocation before close persistence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "outliner-close", "relocation", "session"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "jh-close-source-old" },
      { type: "outlinerCloseNodeThenAbruptRestart", node: { window: { windowId: 10 } }, captureStaleTabs: "jh-close-source-stale" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "jh-close-restored-tab-abrupt-session",
    title: "journal close restored tab abrupt session",
    notes: "Lifecycle-journal crash probe for closing a restored tab whose current runtime id differs from the original closed tab id.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "outliner-close", "restore", "session"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" }, captureRestoredTabs: "jh-close-restored-tab" },
      { type: "outlinerCloseNodeThenAbruptRestart", node: { tab: { capture: "jh-close-restored-tab" } }, captureStaleTabs: "jh-close-restored-tab-stale" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "jh-close-restored-window-abrupt-missing",
    title: "journal close restored window abrupt missing",
    notes: "Lifecycle-journal crash probe for closing a restored window and then omitting its runtime window from a refresh snapshot.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "outliner-close", "restore", "partial-snapshot"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredWindows: "jh-close-restored-window" },
      { type: "outlinerCloseNodeThenAbruptRestart", node: { window: { capture: "jh-close-restored-window" } }, captureStaleTabs: "jh-close-restored-window-stale" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-close-opener-child-abrupt-query",
    title: "journal close opener child abrupt query",
    notes: "Lifecycle-journal crash probe for an opener-linked child tab closed before event delivery, followed by a reordered source snapshot.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "outliner-close", "opener", "stale-query"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, openerTab: { tabId: 1 }, active: false, captureTab: "jh-close-opener-child" },
      { type: "outlinerCloseNodeThenAbruptRestart", node: { tab: { capture: "jh-close-opener-child" } }, captureStaleTabs: "jh-close-opener-stale" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" }
    ]
  },
  {
    id: "jh-window-close-undo-abrupt-refresh",
    title: "journal window close undo abrupt refresh",
    notes: "Lifecycle-journal crash probe for undoing a window close before undo-created runtime evidence is saved.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "undo-redo", "outliner-close", "manual-refresh"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerUndoThenAbruptRestart" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-relocate-command-abrupt-current-refresh",
    title: "journal relocate command abrupt current refresh",
    notes: "Lifecycle-journal crash probe for direct command relocation before persistence, followed by a complete current refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "relocation", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindowThenAbruptRestart", tab: { tabId: 1 }, captureStaleTabs: "jh-relocate-command-crash-old" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-relocate-group-abrupt-stale-created",
    title: "journal relocate group abrupt stale created",
    notes: "Lifecycle-journal crash probe for grouped relocation before persistence, followed by stale old-window created evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "relocation", "nested", "stale-event"],
    actions: [
      { type: "outlinerGroupTabThenAbruptRestart", tab: { tabId: 1 }, captureStaleTabs: "jh-group-crash-old" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "jh-group-crash-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-relocate-top-level-abrupt-reordered",
    title: "journal relocate top level abrupt reordered",
    notes: "Lifecycle-journal crash probe for top-level subtree relocation before persistence, followed by reordered surviving source evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "relocation", "stale-query"],
    actions: [
      { type: "outlinerMoveSubtreeToTopLevelThenAbruptRestart", tab: { tabId: 1 }, captureStaleTabs: "jh-top-crash-old" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" }
    ]
  },
  {
    id: "jh-relocate-second-abrupt-paired-old",
    title: "journal relocate second abrupt paired old",
    notes: "Lifecycle-journal crash probe for a second relocation crashing before persistence while both old-window echoes remain possible.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "relocation", "paired-echo", "stale-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "jh-second-crash-first-old" },
      { type: "outlinerMoveTabCommandToNewWindowThenAbruptRestart", tab: { role: "lastMovedTab" }, captureStaleTabs: "jh-second-crash-second-old" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "jh-second-crash-first-old" }, withStaleQuery: true },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "jh-second-crash-second-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-relocate-opener-child-abrupt-session",
    title: "journal relocate opener child abrupt session",
    notes: "Lifecycle-journal crash probe for relocating an opener-linked child tab before persistence, then session refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "relocation", "opener", "session"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, openerTab: { tabId: 1 }, active: false, captureTab: "jh-relocate-opener-child" },
      { type: "outlinerMoveTabCommandToNewWindowThenAbruptRestart", tab: { capture: "jh-relocate-opener-child" }, captureStaleTabs: "jh-relocate-opener-old" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "jh-delete-multitab-window-abrupt-reordered",
    title: "journal delete multitab window abrupt reordered",
    notes: "Lifecycle-journal crash probe for deleting a multi-tab runtime window before delete persistence, then reordering a survivor snapshot.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "delete-rejection", "multi-tab", "stale-query"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "jh-delete-multitab-extra" },
      { type: "outlinerDeleteNodeThenAbruptRestart", node: { window: { windowId: 20 } }, captureStaleTabs: "jh-delete-multitab-stale" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" }
    ]
  },
  {
    id: "jh-delete-opener-child-abrupt-stale",
    title: "journal delete opener child abrupt stale",
    notes: "Lifecycle-journal crash probe for deleting an opener-linked child tab before delete persistence, followed by stale child evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "delete-rejection", "opener", "stale-event"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, openerTab: { tabId: 1 }, active: false, captureTab: "jh-delete-opener-child" },
      { type: "outlinerDeleteNodeThenAbruptRestart", node: { tab: { capture: "jh-delete-opener-child" } }, captureStaleTabs: "jh-delete-opener-stale" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "jh-delete-opener-stale" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-delete-command-destination-abrupt-old",
    title: "journal delete command destination abrupt old",
    notes: "Lifecycle-journal crash probe for deleting a command-created destination window before persistence, followed by stale source evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "delete-rejection", "relocation", "stale-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "jh-delete-destination-old" },
      { type: "outlinerDeleteNodeThenAbruptRestart", node: { window: { role: "lastOpenedWindow" } }, captureStaleTabs: "jh-delete-destination-stale" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "jh-delete-destination-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-restore-multitab-window-abrupt-reordered",
    title: "journal restore multitab window abrupt reordered",
    notes: "Lifecycle-journal crash probe for restoring a multi-tab closed window before persistence and then reordering restored tabs.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "restore", "multi-tab", "stale-query"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "jh-restore-multitab-extra" },
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeThenAbruptRestart", node: { nodeId: "window:20" }, captureRestoredWindows: "jh-restore-multitab-window" },
      { type: "manualRefreshWithReorderedQuery", window: { capture: "jh-restore-multitab-window" }, order: "reverse" }
    ]
  },
  {
    id: "jh-restore-opener-child-abrupt-session",
    title: "journal restore opener child abrupt session",
    notes: "Lifecycle-journal crash probe for restoring an opener-linked child tab before restore persistence and then session refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "restore", "opener", "session"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, openerTab: { tabId: 1 }, active: false, captureTab: "jh-restore-opener-child" },
      { type: "outlinerCloseTab", tab: { capture: "jh-restore-opener-child" } },
      { type: "outlinerRestoreNodeThenAbruptRestart", node: { nodeId: "tab:100" }, captureRestoredTabs: "jh-restore-opener-restored" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "jh-redo-restore-abrupt-refresh",
    title: "journal redo restore abrupt refresh",
    notes: "Lifecycle-journal crash probe for redoing a restore before restored runtime evidence is saved.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "restore", "undo-redo", "manual-refresh"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" }, captureRestoredTabs: "jh-redo-restore-tab" },
      { type: "outlinerUndo" },
      { type: "outlinerRedoThenAbruptRestart" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-delete-opener-child-abrupt-updated",
    title: "journal delete opener child abrupt updated",
    notes: "Lifecycle-journal crash probe for deleted opener-linked child tab receiving stale updated evidence after abrupt restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "delete-rejection", "opener", "stale-event"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, openerTab: { tabId: 1 }, active: false, captureTab: "jh-delete-opener-updated-child" },
      { type: "outlinerDeleteNodeThenAbruptRestart", node: { tab: { capture: "jh-delete-opener-updated-child" } }, captureStaleTabs: "jh-delete-opener-updated-stale" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "jh-delete-opener-updated-stale" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-delete-opened-child-abrupt-created",
    title: "journal delete opened child abrupt created",
    notes: "Lifecycle-journal control for deleting a browser-created child tab without opener linkage before stale created evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "delete-rejection", "created-event", "stale-event"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "jh-delete-opened-child" },
      { type: "outlinerDeleteNodeThenAbruptRestart", node: { tab: { capture: "jh-delete-opened-child" } }, captureStaleTabs: "jh-delete-opened-stale" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "jh-delete-opened-stale" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-delete-opener-child-abrupt-session-only",
    title: "journal delete opener child abrupt session only",
    notes: "Lifecycle-journal control for deleting an opener-linked child before restart with only session evidence afterward.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "delete-rejection", "opener", "session"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, openerTab: { tabId: 1 }, active: false, captureTab: "jh-delete-opener-session-child" },
      { type: "outlinerDeleteNodeThenAbruptRestart", node: { tab: { capture: "jh-delete-opener-session-child" } }, captureStaleTabs: "jh-delete-opener-session-stale" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "jh-delete-opener-window-abrupt-created",
    title: "journal delete opener window abrupt created",
    notes: "Lifecycle-journal crash probe for deleting a window containing opener-linked tabs before stale child created evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "delete-rejection", "opener", "stale-event"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, openerTab: { tabId: 3 }, active: false, captureTab: "jh-delete-opener-window-child" },
      { type: "outlinerDeleteNodeThenAbruptRestart", node: { window: { windowId: 20 } }, captureStaleTabs: "jh-delete-opener-window-stale" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "jh-delete-opener-window-stale", index: 1 }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-delete-leaf-abrupt-created",
    title: "journal delete leaf abrupt created",
    notes: "Lifecycle-journal crash probe for a deleted initial leaf tab receiving stale created evidence after abrupt restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "delete-rejection", "created-event", "stale-event"],
    actions: [
      { type: "outlinerDeleteNodeThenAbruptRestart", node: { tab: { tabId: 2 } }, captureStaleTabs: "jh-delete-leaf-created-stale" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "jh-delete-leaf-created-stale" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-delete-leaf-abrupt-updated",
    title: "journal delete leaf abrupt updated",
    notes: "Lifecycle-journal crash probe for a deleted initial leaf tab receiving stale updated evidence after abrupt restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "delete-rejection", "updated-event", "stale-event"],
    actions: [
      { type: "outlinerDeleteNodeThenAbruptRestart", node: { tab: { tabId: 2 } }, captureStaleTabs: "jh-delete-leaf-updated-stale" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "jh-delete-leaf-updated-stale" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-delete-window-tab-abrupt-created",
    title: "journal delete window tab abrupt created",
    notes: "Lifecycle-journal crash probe for a tab inside a deleted window receiving stale created evidence after abrupt restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "delete-rejection", "native-close", "stale-event"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "jh-delete-window-extra" },
      { type: "outlinerDeleteNodeThenAbruptRestart", node: { window: { windowId: 20 } }, captureStaleTabs: "jh-delete-window-created-stale" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "jh-delete-window-created-stale", index: 1 }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-delete-relocated-destination-abrupt-created",
    title: "journal delete relocated destination abrupt created",
    notes: "Lifecycle-journal crash probe for a deleted command-created destination tab receiving stale created evidence after abrupt restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "delete-rejection", "relocation", "stale-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "jh-delete-relocated-before" },
      { type: "outlinerDeleteNodeThenAbruptRestart", node: { window: { role: "lastOpenedWindow" } }, captureStaleTabs: "jh-delete-relocated-destination-stale" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "jh-delete-relocated-destination-stale" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-restore-tab-abrupt-stale-updated",
    title: "journal restore tab abrupt stale updated",
    notes: "Lifecycle-journal crash probe for restored tab receiving stale updated evidence after abrupt restore recovery.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "restore", "updated-event", "stale-event"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeThenAbruptRestart", node: { nodeId: "tab:2" }, captureRestoredTabs: "jh-restore-updated-tab" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "jh-restore-updated-tab" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-restore-window-abrupt-stale-created",
    title: "journal restore window abrupt stale created",
    notes: "Lifecycle-journal crash probe for restored window tab receiving stale created evidence after abrupt restore recovery.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "restore", "created-event", "stale-event"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeThenAbruptRestart", node: { nodeId: "window:20" }, captureRestoredTabs: "jh-restore-window-created-tabs", captureRestoredWindows: "jh-restore-created-window" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "jh-restore-window-created-tabs" }, withStaleQuery: true }
    ]
  },
  {
    id: "jh-redo-restore-window-abrupt-reordered",
    title: "journal redo restore window abrupt reordered",
    notes: "Lifecycle-journal crash probe for redoing a window restore before persistence, followed by reordered restored-window query evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "restore", "undo-redo", "stale-query"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredWindows: "jh-redo-window-before-undo" },
      { type: "outlinerUndo" },
      { type: "outlinerRedoThenAbruptRestart" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-native-window-no-journal-abrupt",
    title: "native window no journal abrupt",
    notes: "Lifecycle-journal control: native browser window close plus abrupt restart must not be reclassified as a Tabs Outliner command close.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "native-close", "manual-refresh"],
    actions: [
      { type: "nativeCloseWindow", window: { windowId: 20 }, order: "windowRemovedOnly" },
      { type: "restartBackgroundAbrupt" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-native-window-tabs-then-abrupt",
    title: "native window tabs then abrupt",
    notes: "Lifecycle-journal native-control probe for tabs-then-window native close order followed by abrupt restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "native-close", "event-order"],
    actions: [
      { type: "nativeCloseWindow", window: { windowId: 20 }, order: "tabsRemovedThenWindowRemoved" },
      { type: "restartBackgroundAbrupt" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-native-window-window-then-tabs-abrupt",
    title: "native window window then tabs abrupt",
    notes: "Lifecycle-journal native-control probe for window-then-tabs native close order followed by abrupt restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "native-close", "event-order"],
    actions: [
      { type: "nativeCloseWindow", window: { windowId: 20 }, order: "windowRemovedThenTabsRemoved" },
      { type: "restartBackgroundAbrupt" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-native-window-tabs-only-abrupt",
    title: "native window tabs only abrupt",
    notes: "Lifecycle-journal native-control probe for tabs-only native window close evidence followed by abrupt restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "native-close", "event-order"],
    actions: [
      { type: "nativeCloseWindow", window: { windowId: 20 }, order: "tabsRemovedOnly" },
      { type: "restartBackgroundAbrupt" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-native-multitab-window-abrupt",
    title: "native multitab window abrupt",
    notes: "Lifecycle-journal native-control probe for native close of a multi-tab window followed by abrupt restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "native-close", "multi-tab"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "jh-native-multitab-extra" },
      { type: "nativeCloseWindow", window: { windowId: 20 }, order: "windowRemovedOnly" },
      { type: "restartBackgroundAbrupt" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-native-last-tab-abrupt",
    title: "native last tab abrupt",
    notes: "Lifecycle-journal native-control probe for native close of the last tab in a window followed by abrupt restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "native-close", "tombstone"],
    actions: [
      { type: "nativeCloseTab", tab: { tabId: 3 }, order: "tabRemovedOnly" },
      { type: "restartBackgroundAbrupt" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-native-opener-child-tab-abrupt",
    title: "native opener child tab abrupt",
    notes: "Lifecycle-journal native-control probe for native close of an opener-linked child tab followed by abrupt restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "native-close", "opener"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, openerTab: { tabId: 1 }, active: false, captureTab: "jh-native-opener-child" },
      { type: "nativeCloseTab", tab: { capture: "jh-native-opener-child" }, order: "tabRemovedOnly" },
      { type: "restartBackgroundAbrupt" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-native-restored-window-abrupt",
    title: "native restored window abrupt",
    notes: "Lifecycle-journal native-control probe for native close of a restored window followed by abrupt restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "native-close", "restore"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredWindows: "jh-native-restored-window" },
      { type: "nativeCloseWindow", window: { capture: "jh-native-restored-window" }, order: "windowRemovedOnly" },
      { type: "restartBackgroundAbrupt" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-native-restored-window-tabs-then-abrupt",
    title: "native restored window tabs then abrupt",
    notes: "Lifecycle-journal native-control probe for native close of a restored window with tabs-then-window event order before abrupt restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "native-close", "restore", "event-order"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredWindows: "jh-native-restored-tabs-then-window" },
      { type: "nativeCloseWindow", window: { capture: "jh-native-restored-tabs-then-window" }, order: "tabsRemovedThenWindowRemoved" },
      { type: "restartBackgroundAbrupt" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-native-restored-multitab-window-abrupt",
    title: "native restored multitab window abrupt",
    notes: "Lifecycle-journal native-control probe for native close of a restored multi-tab window before persistence survives.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "native-close", "restore", "multi-tab"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "jh-native-restored-multitab-extra" },
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredWindows: "jh-native-restored-multitab-window" },
      { type: "nativeCloseWindow", window: { capture: "jh-native-restored-multitab-window" }, order: "windowRemovedOnly" },
      { type: "restartBackgroundAbrupt" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-native-restored-tab-abrupt",
    title: "native restored tab abrupt",
    notes: "Lifecycle-journal native-control probe for native close of a restored tab followed by abrupt restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "native-close", "restore"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" }, captureRestoredTabs: "jh-native-restored-tab" },
      { type: "nativeCloseTab", tab: { capture: "jh-native-restored-tab" }, order: "tabRemovedOnly" },
      { type: "restartBackgroundAbrupt" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-native-restored-window-window-then-tabs-abrupt",
    title: "native restored window window then tabs abrupt",
    notes: "Lifecycle-journal native-control probe for restored-window native close where window removal arrives before tab removals.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "native-close", "restore", "event-order"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredWindows: "jh-native-restored-window-first" },
      { type: "nativeCloseWindow", window: { capture: "jh-native-restored-window-first" }, order: "windowRemovedThenTabsRemoved" },
      { type: "restartBackgroundAbrupt" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-native-restored-window-tabs-only-abrupt",
    title: "native restored window tabs only abrupt",
    notes: "Lifecycle-journal native-control probe for restored-window native close with only tab removal evidence before abrupt restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "native-close", "restore", "event-order"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredWindows: "jh-native-restored-tabs-only-window" },
      { type: "nativeCloseWindow", window: { capture: "jh-native-restored-tabs-only-window" }, order: "tabsRemovedOnly" },
      { type: "restartBackgroundAbrupt" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-relocate-command-abrupt-focus-session",
    title: "journal relocate command abrupt focus session",
    notes: "Lifecycle-journal clean-sector probe for command relocation crash followed by focus and session evidence from surviving windows.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "relocation", "focus", "session"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindowThenAbruptRestart", tab: { tabId: 1 }, captureStaleTabs: "jh-relocate-focus-session-old" },
      { type: "focusWindow", window: { windowId: 20 } },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "jh-relocate-command-abrupt-missing-destination",
    title: "journal relocate command abrupt missing destination",
    notes: "Lifecycle-journal clean-sector probe for command relocation crash followed by partial query omitting the destination window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "relocation", "partial-snapshot"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindowThenAbruptRestart", tab: { tabId: 1 }, captureStaleTabs: "jh-relocate-missing-destination-old" },
      { type: "manualRefreshWithMissingWindowQuery", window: { role: "lastOpenedWindow" } }
    ]
  },
  {
    id: "jh-restore-tab-abrupt-focus-session",
    title: "journal restore tab abrupt focus session",
    notes: "Lifecycle-journal clean-sector probe for restored tab crash followed by focus/session evidence without stale echoes.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "restore", "focus", "session"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeThenAbruptRestart", node: { nodeId: "tab:2" }, captureRestoredTabs: "jh-restore-focus-tab" },
      { type: "focusWindow", window: { windowId: 20 } },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "jh-delete-leaf-abrupt-refresh-control",
    title: "journal delete leaf abrupt refresh control",
    notes: "Lifecycle-journal clean-sector probe for leaf delete crash followed only by complete refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "delete-rejection", "manual-refresh"],
    actions: [
      { type: "outlinerDeleteNodeThenAbruptRestart", node: { tab: { tabId: 2 } }, captureStaleTabs: "jh-delete-leaf-refresh-stale" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-relocate-group-abrupt-focus-session",
    title: "journal relocate group abrupt focus session",
    notes: "Lifecycle-journal clean-sector probe for grouped relocation crash followed by focus/session evidence only.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "relocation", "nested", "focus", "session"],
    actions: [
      { type: "outlinerGroupTabThenAbruptRestart", tab: { tabId: 1 }, captureStaleTabs: "jh-group-focus-session-old" },
      { type: "focusWindow", window: { windowId: 20 } },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "jh-restore-window-abrupt-focus-session",
    title: "journal restore window abrupt focus session",
    notes: "Lifecycle-journal clean-sector probe for restored window crash followed by focus/session evidence only.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "restore", "focus", "session"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeThenAbruptRestart", node: { nodeId: "window:20" }, captureRestoredWindows: "jh-restore-window-focus-session" },
      { type: "focusWindow", window: { capture: "jh-restore-window-focus-session" } },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "jh-delete-multitab-window-abrupt-refresh-control",
    title: "journal delete multitab window abrupt refresh control",
    notes: "Lifecycle-journal clean-sector probe for multi-tab window delete crash followed only by complete refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "delete-rejection", "multi-tab", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, captureTab: "jh-delete-multitab-refresh-extra" },
      { type: "outlinerDeleteNodeThenAbruptRestart", node: { window: { windowId: 20 } }, captureStaleTabs: "jh-delete-multitab-refresh-stale" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "jh-native-tab-session-abrupt",
    title: "native tab session abrupt",
    notes: "Lifecycle-journal clean-sector probe for native non-last-tab close, abrupt restart, and session refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "native-close", "session"],
    actions: [
      { type: "nativeCloseTab", tab: { tabId: 2 }, order: "sessionChangedOnly" },
      { type: "restartBackgroundAbrupt" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "jh-relocate-abrupt-reordered-survivor-control",
    title: "journal relocate abrupt reordered survivor control",
    notes: "Lifecycle-journal final control for relocation crash followed by reordered source-window survivor query evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "relocation", "stale-query"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindowThenAbruptRestart", tab: { tabId: 1 }, captureStaleTabs: "jh-relocate-final-old" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" }
    ]
  },
  {
    id: "jh-restore-window-abrupt-reordered-control",
    title: "journal restore window abrupt reordered control",
    notes: "Lifecycle-journal final control for restored-window crash followed by reordered restored-window query evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "restore", "stale-query"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeThenAbruptRestart", node: { nodeId: "window:20" }, captureRestoredWindows: "jh-restore-final-window" },
      { type: "manualRefreshWithReorderedQuery", window: { capture: "jh-restore-final-window" }, order: "reverse" }
    ]
  },
  {
    id: "jh-delete-window-abrupt-missing-survivor-control",
    title: "journal delete window abrupt missing survivor control",
    notes: "Lifecycle-journal final control for window delete crash followed by partial query omitting an unaffected survivor window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["journal", "restart", "delete-rejection", "partial-snapshot"],
    actions: [
      { type: "outlinerDeleteNodeThenAbruptRestart", node: { window: { windowId: 20 } }, captureStaleTabs: "jh-delete-final-window-stale" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } }
    ]
  },
  {
    id: "nh-native-open-window-refresh",
    title: "native open window refresh",
    notes: "Browser-authored drift probe for an externally created window followed by complete refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "created-event", "manual-refresh", "reconciliation"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native created", url: "https://native.example/open" }], captureWindow: "nh-open-window", captureTabs: "nh-open-window-tabs" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-open-multitab-session",
    title: "native open multitab session",
    notes: "Browser-authored drift probe for an externally created background multi-tab window followed by session evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "multi-tab", "session", "reconciliation"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Native A" }, { title: "Native B", active: true }], captureWindow: "nh-open-multitab-window", captureTabs: "nh-open-multitab-tabs" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "nh-native-open-opener-reordered",
    title: "native open opener reordered",
    notes: "Browser-authored drift probe for an opener-linked child in an externally created window followed by reordered query evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "opener", "stale-query", "reconciliation"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native opener child", openerTab: { tabId: 1 } }, { title: "Native opener sibling" }], captureWindow: "nh-open-opener-window", captureTabs: "nh-open-opener-tabs" },
      { type: "manualRefreshWithReorderedQuery", window: { capture: "nh-open-opener-window" }, order: "reverse" }
    ]
  },
  {
    id: "nh-native-open-active-missing-query",
    title: "native open active missing query",
    notes: "Browser-authored drift probe for an active externally created window omitted from a later partial query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "partial-snapshot", "focus", "reconciliation"],
    actions: [
      { type: "nativeOpenWindow", focused: true, tabs: [{ title: "Native active" }], captureWindow: "nh-open-active-window", captureTabs: "nh-open-active-tabs" },
      { type: "manualRefreshWithMissingWindowQuery", window: { capture: "nh-open-active-window" } }
    ]
  },
  {
    id: "nh-native-move-existing-refresh",
    title: "native move existing refresh",
    notes: "Browser-authored drift probe for a tab moved to an existing runtime window and reconciled from complete refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "manual-refresh", "reconciliation"],
    actions: [
      { type: "nativeMoveTabToWindow", tab: { tabId: 2 }, window: { windowId: 20 }, active: false, captureStaleTabs: "nh-move-existing-old" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-move-new-window-session",
    title: "native move new window session",
    notes: "Browser-authored drift probe for a tab detached into a new runtime window followed by session evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "session", "reconciliation"],
    actions: [
      { type: "nativeMoveTabToNewWindow", tab: { tabId: 2 }, captureWindow: "nh-move-new-window", captureStaleTabs: "nh-move-new-old" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "nh-native-move-active-old-stale",
    title: "native move active old stale",
    notes: "Browser-authored drift probe for an active native move followed by stale old-window tab evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "activation", "stale-event", "reconciliation"],
    actions: [
      { type: "nativeMoveTabToWindow", tab: { tabId: 1 }, window: { windowId: 20 }, active: true, captureStaleTabs: "nh-move-active-old" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "nh-move-active-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "nh-native-move-opener-child-refresh",
    title: "native move opener child refresh",
    notes: "Browser-authored drift probe for an opener child moved natively while the opener remains in the source window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "opener", "manual-refresh", "reconciliation"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "nh-move-opener-child" },
      { type: "nativeMoveTabToWindow", tab: { capture: "nh-move-opener-child" }, window: { windowId: 20 }, active: false, captureStaleTabs: "nh-move-opener-old" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" }
    ]
  },
  {
    id: "nh-native-move-close-tab-stale",
    title: "native move close tab stale",
    notes: "Browser-authored drift probe for a natively moved tab that is then natively closed before stale old-window evidence arrives.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "native-close", "stale-event", "tombstone"],
    actions: [
      { type: "nativeMoveTabToWindow", tab: { tabId: 2 }, window: { windowId: 20 }, captureStaleTabs: "nh-move-close-tab-old" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "tabRemovedThenSessionChanged" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "nh-move-close-tab-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "nh-native-move-close-destination-window",
    title: "native move close destination window",
    notes: "Browser-authored drift probe for a native move followed by native closure of the destination window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "native-close", "event-order", "reconciliation"],
    actions: [
      { type: "nativeMoveTabToWindow", tab: { tabId: 2 }, window: { windowId: 20 }, captureStaleTabs: "nh-move-destination-close-old" },
      { type: "nativeCloseWindow", window: { windowId: 20 }, order: "windowRemovedThenTabsRemoved" }
    ]
  },
  {
    id: "nh-native-move-close-source-window",
    title: "native move close source window",
    notes: "Browser-authored drift probe for a native move followed by native closure of the source window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "native-close", "event-order", "reconciliation"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "nh-source-close-extra" },
      { type: "nativeMoveTabToWindow", tab: { tabId: 2 }, window: { windowId: 20 }, active: false, captureStaleTabs: "nh-move-source-close-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "tabsRemovedThenWindowRemoved" }
    ]
  },
  {
    id: "nh-native-move-session-only-close",
    title: "native move session only close",
    notes: "Browser-authored drift probe for a natively moved tab that disappears through session-only evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "native-close", "session", "tombstone"],
    actions: [
      { type: "nativeMoveTabToWindow", tab: { tabId: 2 }, window: { windowId: 20 }, captureStaleTabs: "nh-move-session-only-old" },
      { type: "nativeCloseTab", tab: { role: "lastMovedTab" }, order: "sessionChangedOnly" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-move-restart-refresh",
    title: "native move restart refresh",
    notes: "Browser-authored drift probe for native move evidence across normal background restart with no command journal.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "restart", "manual-refresh", "reconciliation"],
    actions: [
      { type: "nativeMoveTabToWindow", tab: { tabId: 2 }, window: { windowId: 20 }, captureStaleTabs: "nh-move-restart-old" },
      { type: "restartBackground" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-open-restart-session",
    title: "native open restart session",
    notes: "Browser-authored drift probe for an externally created window across normal restart with no command journal.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "restart", "session", "reconciliation"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native restart" }], captureWindow: "nh-open-restart-window", captureTabs: "nh-open-restart-tabs" },
      { type: "restartBackground" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "nh-native-move-close-abrupt",
    title: "native move close abrupt",
    notes: "Browser-authored drift probe for a native move and native destination close across abrupt restart with no journal.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "native-close", "restart", "manual-refresh"],
    actions: [
      { type: "nativeMoveTabToNewWindow", tab: { tabId: 2 }, captureWindow: "nh-move-close-abrupt-window", captureStaleTabs: "nh-move-close-abrupt-old" },
      { type: "nativeCloseWindow", window: { capture: "nh-move-close-abrupt-window" }, order: "windowRemovedOnly" },
      { type: "restartBackgroundAbrupt" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-opener-chain-restart-missing",
    title: "native opener chain restart missing",
    notes: "Browser-authored drift probe for opener-chain native relocation across restart and partial source-window query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "opener", "restart", "partial-snapshot"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "nh-opener-chain-child" },
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { capture: "nh-opener-chain-child" }, captureTab: "nh-opener-chain-grandchild" },
      { type: "nativeMoveTabToNewWindow", tab: { capture: "nh-opener-chain-grandchild" }, captureWindow: "nh-opener-chain-destination", captureStaleTabs: "nh-opener-chain-old" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } }
    ]
  },
  {
    id: "nh-native-open-missing-created-window",
    title: "native open missing created window",
    notes: "Browser-authored drift probe for a browser-created window omitted by a later partial query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "partial-snapshot", "reconciliation"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native missing" }], captureWindow: "nh-missing-created-window", captureTabs: "nh-missing-created-tabs" },
      { type: "manualRefreshWithMissingWindowQuery", window: { capture: "nh-missing-created-window" } }
    ]
  },
  {
    id: "nh-native-move-reordered-destination",
    title: "native move reordered destination",
    notes: "Browser-authored drift probe for a native move followed by reordered destination-window query evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "stale-query", "reconciliation"],
    actions: [
      { type: "nativeMoveTabToWindow", tab: { tabId: 2 }, window: { windowId: 20 }, captureStaleTabs: "nh-move-reordered-old" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 20 }, order: "rotateLeft" }
    ]
  },
  {
    id: "nh-native-move-missing-source-fresh-destination",
    title: "native move missing source fresh destination",
    notes: "Browser-authored drift probe for fresh destination metadata after native move, then a partial query omitting the old source window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "updated-event", "partial-snapshot", "reconciliation"],
    actions: [
      { type: "nativeMoveTabToWindow", tab: { tabId: 2 }, window: { windowId: 20 }, active: true, captureStaleTabs: "nh-move-missing-source-old" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Native moved fresh" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } }
    ]
  },
  {
    id: "nh-native-open-stale-event-complete-refresh",
    title: "native open stale event complete refresh",
    notes: "Browser-authored drift probe for stale event-local evidence from an externally created tab after complete refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "stale-event", "manual-refresh", "reconciliation"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native stale" }], captureWindow: "nh-open-stale-window", captureTabs: "nh-open-stale-tabs" },
      { type: "manualRefresh" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "nh-open-stale-tabs" } }
    ]
  },
  {
    id: "nh-history-undo-native-move",
    title: "history undo native move",
    notes: "Browser-authored drift control for TO history replay followed by unrelated native tab relocation.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "undo-redo", "manual-refresh", "reconciliation"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 } },
      { type: "outlinerUndo" },
      { type: "nativeMoveTabToWindow", tab: { tabId: 2 }, window: { windowId: 20 }, captureStaleTabs: "nh-history-undo-move-old" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-history-redo-native-close",
    title: "history redo native close",
    notes: "Browser-authored drift control for TO redo followed by native tab close and refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-close", "undo-redo", "manual-refresh", "reconciliation"],
    actions: [
      { type: "outlinerGroupTab", tab: { tabId: 1 } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "nativeCloseTab", tab: { tabId: 2 }, order: "tabRemovedThenSessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-restored-tab-native-move",
    title: "restored tab native move",
    notes: "Browser-authored drift control for a restored tab whose current runtime resource is moved natively.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restore", "native-move", "restart", "session"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeThenAbruptRestart", node: { nodeId: "tab:2" }, captureRestoredTabs: "nh-restored-tab" },
      { type: "nativeMoveTabToWindow", tab: { capture: "nh-restored-tab" }, window: { windowId: 20 }, captureStaleTabs: "nh-restored-tab-move-old" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "nh-restored-window-native-open-sibling",
    title: "restored window native open sibling",
    notes: "Browser-authored drift control for a restored window receiving an external sibling tab before reordered refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restore", "native-open", "stale-query", "restart"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeThenAbruptRestart", node: { nodeId: "window:20" }, captureRestoredWindows: "nh-restored-window" },
      { type: "openTab", window: { capture: "nh-restored-window" }, active: false, captureTab: "nh-restored-window-sibling" },
      { type: "manualRefreshWithReorderedQuery", window: { capture: "nh-restored-window" }, order: "reverse" }
    ]
  },
  {
    id: "nh-native-open-close-window-tabs-then",
    title: "native open close window tabs then",
    notes: "Browser-authored drift variant for an externally created multi-tab window that closes natively with tab removals before window removal.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "native-close", "event-order", "multi-tab"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native close A" }, { title: "Native close B", active: true }], captureWindow: "nh-open-close-tabs-window", captureTabs: "nh-open-close-tabs" },
      { type: "nativeCloseWindow", window: { capture: "nh-open-close-tabs-window" }, order: "tabsRemovedThenWindowRemoved" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-open-close-window-window-only-abrupt",
    title: "native open close window window only abrupt",
    notes: "Browser-authored drift variant for an external window that closes with only window removal evidence before abrupt restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "native-close", "restart", "event-order"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native abrupt close" }], captureWindow: "nh-open-close-window-only", captureTabs: "nh-open-close-window-only-tabs" },
      { type: "nativeCloseWindow", window: { capture: "nh-open-close-window-only" }, order: "windowRemovedOnly" },
      { type: "restartBackgroundAbrupt" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-open-close-tab-stale-created",
    title: "native open close tab stale created",
    notes: "Browser-authored drift variant for an externally created tab that closes before delayed created evidence is replayed.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "native-close", "created-event", "stale-event"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native stale close" }], captureWindow: "nh-open-close-tab-window", captureTabs: "nh-open-close-tab-tabs" },
      { type: "nativeCloseTab", tab: { capture: "nh-open-close-tab-tabs" }, order: "tabRemovedThenSessionChanged" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "nh-open-close-tab-tabs" }, withStaleQuery: true }
    ]
  },
  {
    id: "nh-native-open-opener-source-close",
    title: "native open opener source close",
    notes: "Browser-authored drift variant for an external opener-linked window after the opener source window closes natively.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "opener", "native-close", "manual-refresh"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native opener child after source close", openerTab: { tabId: 1 } }], captureWindow: "nh-open-opener-source-close-window", captureTabs: "nh-open-opener-source-close-tabs" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "tabsRemovedThenWindowRemoved" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-move-new-window-refresh-stale",
    title: "native move new window refresh stale",
    notes: "Browser-authored drift variant for a native detach-to-new-window followed by complete refresh and delayed old-window evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "manual-refresh", "stale-event", "reconciliation"],
    actions: [
      { type: "nativeMoveTabToNewWindow", tab: { tabId: 2 }, captureWindow: "nh-move-new-refresh-window", captureStaleTabs: "nh-move-new-refresh-old" },
      { type: "manualRefresh" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "nh-move-new-refresh-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "nh-native-move-new-window-source-close",
    title: "native move new window source close",
    notes: "Browser-authored drift variant for a native detach-to-new-window followed by native closure of the old source window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "native-close", "restart", "reconciliation"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "nh-move-new-source-survivor" },
      { type: "nativeMoveTabToNewWindow", tab: { tabId: 2 }, captureWindow: "nh-move-new-source-destination", captureStaleTabs: "nh-move-new-source-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "windowRemovedThenTabsRemoved" },
      { type: "restartBackground" }
    ]
  },
  {
    id: "nh-native-move-new-window-destination-tabs-only",
    title: "native move new window destination tabs only",
    notes: "Browser-authored drift variant for a native detach-to-new-window whose destination disappears through tab-only close evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "native-close", "event-order", "manual-refresh"],
    actions: [
      { type: "nativeMoveTabToNewWindow", tab: { tabId: 2 }, captureWindow: "nh-move-new-tabs-only-destination", captureStaleTabs: "nh-move-new-tabs-only-old" },
      { type: "nativeCloseWindow", window: { capture: "nh-move-new-tabs-only-destination" }, order: "tabsRemovedOnly" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-move-new-window-restart-missing-destination",
    title: "native move new window restart missing destination",
    notes: "Browser-authored drift variant for native detach-to-new-window across restart with a later partial query omitting the destination.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "restart", "partial-snapshot", "reconciliation"],
    actions: [
      { type: "nativeMoveTabToNewWindow", tab: { tabId: 2 }, captureWindow: "nh-move-new-missing-destination", captureStaleTabs: "nh-move-new-missing-old" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingWindowQuery", window: { capture: "nh-move-new-missing-destination" } }
    ]
  },
  {
    id: "nh-native-open-outliner-close-undo",
    title: "native open outliner close undo",
    notes: "Browser-authored drift variant for a browser-created window later closed through TO and restored through history.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "outliner-close", "undo-redo", "manual-refresh"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native TO close" }], captureWindow: "nh-open-to-close-window", captureTabs: "nh-open-to-close-tabs" },
      { type: "outlinerCloseWindow", window: { capture: "nh-open-to-close-window" } },
      { type: "outlinerUndo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-open-outliner-close-redo-restart",
    title: "native open outliner close redo restart",
    notes: "Browser-authored drift variant for TO close/undo/redo on an external window across restart reconstruction.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "outliner-close", "undo-redo", "restart"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native TO redo" }], captureWindow: "nh-open-to-redo-window", captureTabs: "nh-open-to-redo-tabs" },
      { type: "outlinerCloseWindow", window: { capture: "nh-open-to-redo-window" } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "restartBackground" }
    ]
  },
  {
    id: "nh-native-open-outliner-delete-reject",
    title: "native open outliner delete reject",
    notes: "Browser-authored drift variant for delete-reject recovery on an externally created tab node.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "delete-rejection", "tombstone", "manual-refresh"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native delete reject" }], captureWindow: "nh-open-delete-reject-window", captureTabs: "nh-open-delete-reject-tabs" },
      { type: "outlinerDeleteNodeRejectingClose", node: { tab: { capture: "nh-open-delete-reject-tabs" } } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-open-outliner-close-reject-abrupt",
    title: "native open outliner close reject abrupt",
    notes: "Browser-authored drift variant for close-reject recovery on an externally created window across abrupt restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "outliner-close", "command-rejection", "restart"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native close reject" }], captureWindow: "nh-open-close-reject-window", captureTabs: "nh-open-close-reject-tabs" },
      { type: "outlinerCloseNodeRejectingClose", node: { window: { capture: "nh-open-close-reject-window" } } },
      { type: "restartBackgroundAbrupt" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-open-tab-focus-session",
    title: "native open tab focus session",
    notes: "Browser-authored drift variant for focusing an externally created tab through TO followed by session churn.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "focus", "session", "reconciliation"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Native focus A" }, { title: "Native focus B" }], captureWindow: "nh-open-focus-window", captureTabs: "nh-open-focus-tabs" },
      { type: "outlinerFocusTab", tab: { capture: "nh-open-focus-tabs", index: 1 } },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "nh-native-open-tab-focus-reject-refresh",
    title: "native open tab focus reject refresh",
    notes: "Browser-authored drift variant for focus side-effect rejection on an externally created tab followed by refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "focus", "command-rejection", "manual-refresh"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Native reject focus A" }, { title: "Native reject focus B" }], captureWindow: "nh-open-focus-reject-window", captureTabs: "nh-open-focus-reject-tabs" },
      { type: "outlinerFocusTabRejectingUpdate", tab: { capture: "nh-open-focus-reject-tabs", index: 1 } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-open-restored-window-close",
    title: "native open restored window close",
    notes: "Browser-authored drift variant for an external tab added to a restored window before native close ordering.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restore", "native-open", "native-close", "event-order"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeThenAbruptRestart", node: { nodeId: "window:20" }, captureRestoredWindows: "nh-open-restored-close-window" },
      { type: "openTab", window: { capture: "nh-open-restored-close-window" }, active: false, captureTab: "nh-open-restored-close-sibling" },
      { type: "nativeCloseWindow", window: { capture: "nh-open-restored-close-window" }, order: "windowRemovedThenTabsRemoved" }
    ]
  },
  {
    id: "nh-native-open-id-gap-history-restart",
    title: "native open id gap history restart",
    notes: "Browser-authored drift variant for externally created ID gaps combined with TO history replay and restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "undo-redo", "restart", "reconciliation"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native gap A" }], captureWindow: "nh-id-gap-window-a", captureTabs: "nh-id-gap-tabs-a" },
      { type: "nativeOpenWindow", tabs: [{ title: "Native gap B" }], captureWindow: "nh-id-gap-window-b", captureTabs: "nh-id-gap-tabs-b" },
      { type: "outlinerGroupTab", tab: { tabId: 1 } },
      { type: "outlinerUndo" },
      { type: "restartBackground" }
    ]
  },
  {
    id: "nh-native-open-single-history-undo",
    title: "native open single history undo",
    notes: "Browser-authored drift clone for a single externally created window surviving TO group/undo history replay.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "undo-redo", "manual-refresh", "reconciliation"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native single history" }], captureWindow: "nh-history-single-window", captureTabs: "nh-history-single-tabs" },
      { type: "outlinerGroupTab", tab: { tabId: 1 } },
      { type: "outlinerUndo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-open-multitab-history-undo",
    title: "native open multitab history undo",
    notes: "Browser-authored drift clone for a multi-tab externally created window surviving TO group/undo history replay.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "multi-tab", "undo-redo", "reconciliation"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native history A" }, { title: "Native history B", active: true }], captureWindow: "nh-history-multitab-window", captureTabs: "nh-history-multitab-tabs" },
      { type: "outlinerGroupTab", tab: { tabId: 1 } },
      { type: "outlinerUndo" }
    ]
  },
  {
    id: "nh-native-open-history-restart-before-undo",
    title: "native open history restart before undo",
    notes: "Browser-authored drift clone for externally created resources reconstructed at startup before a later TO undo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "restart", "undo-redo", "reconciliation"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native restart history" }], captureWindow: "nh-history-restart-window", captureTabs: "nh-history-restart-tabs" },
      { type: "restartBackground" },
      { type: "outlinerGroupTab", tab: { tabId: 1 } },
      { type: "outlinerUndo" }
    ]
  },
  {
    id: "nh-native-open-history-close-tab-undo",
    title: "native open history close tab undo",
    notes: "Browser-authored drift clone for externally created resources surviving a TO close/undo history entry on a built-in tab.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "outliner-close", "undo-redo", "manual-refresh"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native close history" }], captureWindow: "nh-history-close-window", captureTabs: "nh-history-close-tabs" },
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerUndo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-open-history-group-redo",
    title: "native open history group redo",
    notes: "Browser-authored drift clone for externally created resources across TO group undo plus redo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "undo-redo", "reconciliation"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native redo history" }], captureWindow: "nh-history-redo-window", captureTabs: "nh-history-redo-tabs" },
      { type: "outlinerGroupTab", tab: { tabId: 1 } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" }
    ]
  },
  {
    id: "nh-native-open-history-session-undo",
    title: "native open history session undo",
    notes: "Browser-authored drift clone for externally created resources with session churn before TO history replay.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "session", "undo-redo", "reconciliation"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native session history" }], captureWindow: "nh-history-session-window", captureTabs: "nh-history-session-tabs" },
      { type: "sessionChanged" },
      { type: "outlinerGroupTab", tab: { tabId: 1 } },
      { type: "outlinerUndo" }
    ]
  },
  {
    id: "nh-native-detach-outliner-close-undo",
    title: "native detach outliner close undo",
    notes: "Browser-authored drift probe for a natively detached tab closed through TO and restored through history.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "outliner-close", "undo-redo", "manual-refresh"],
    actions: [
      { type: "nativeMoveTabToNewWindow", tab: { tabId: 2 }, captureWindow: "nh-detach-close-window", captureStaleTabs: "nh-detach-close-old" },
      { type: "outlinerCloseTab", tab: { role: "lastMovedTab" } },
      { type: "outlinerUndo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-detach-window-close-redo",
    title: "native detach window close redo",
    notes: "Browser-authored drift probe for a natively detached destination closed through TO undo/redo.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "outliner-close", "undo-redo", "restart"],
    actions: [
      { type: "nativeMoveTabToNewWindow", tab: { tabId: 2 }, captureWindow: "nh-detach-window-close", captureStaleTabs: "nh-detach-window-close-old" },
      { type: "outlinerCloseWindow", window: { capture: "nh-detach-window-close" } },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "restartBackground" }
    ]
  },
  {
    id: "nh-native-detach-group-undo",
    title: "native detach group undo",
    notes: "Browser-authored drift probe for TO group history replay after a native detach-to-new-window has converged.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "undo-redo", "reconciliation"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, captureTab: "nh-detach-group-filler" },
      { type: "nativeMoveTabToNewWindow", tab: { tabId: 2 }, captureWindow: "nh-detach-group-window", captureStaleTabs: "nh-detach-group-old" },
      { type: "outlinerGroupTab", tab: { tabId: 1 } },
      { type: "outlinerUndo" }
    ]
  },
  {
    id: "nh-native-detach-focus-reject-refresh",
    title: "native detach focus reject refresh",
    notes: "Browser-authored drift probe for focus side-effect rejection after native detach-to-new-window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "focus", "command-rejection", "manual-refresh"],
    actions: [
      { type: "nativeMoveTabToNewWindow", tab: { tabId: 2 }, captureWindow: "nh-detach-focus-window", captureStaleTabs: "nh-detach-focus-old" },
      { type: "outlinerFocusTabRejectingUpdate", tab: { role: "lastMovedTab" } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-detach-open-sibling-reordered",
    title: "native detach open sibling reordered",
    notes: "Browser-authored drift probe for a natively detached window that receives an external sibling tab before reordered refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "created-event", "stale-query", "reconciliation"],
    actions: [
      { type: "nativeMoveTabToNewWindow", tab: { tabId: 2 }, captureWindow: "nh-detach-sibling-window", captureStaleTabs: "nh-detach-sibling-old" },
      { type: "openTab", window: { capture: "nh-detach-sibling-window" }, active: false, captureTab: "nh-detach-sibling-tab" },
      { type: "manualRefreshWithReorderedQuery", window: { capture: "nh-detach-sibling-window" }, order: "reverse" }
    ]
  },
  {
    id: "nh-native-detach-abrupt-session-refresh",
    title: "native detach abrupt session refresh",
    notes: "Browser-authored drift probe for native detach-to-new-window across abrupt restart with session and complete refresh evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "restart", "session", "manual-refresh"],
    actions: [
      { type: "nativeMoveTabToNewWindow", tab: { tabId: 2 }, captureWindow: "nh-detach-abrupt-window", captureStaleTabs: "nh-detach-abrupt-old" },
      { type: "restartBackgroundAbrupt" },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-open-focus-restart-active",
    title: "native open focus restart active",
    notes: "Browser-authored drift probe for external multi-tab focus and active state across restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "focus", "restart", "activation"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Native focus restart A" }, { title: "Native focus restart B" }], captureWindow: "nh-focus-restart-window", captureTabs: "nh-focus-restart-tabs" },
      { type: "activateTab", tab: { capture: "nh-focus-restart-tabs", index: 1 } },
      { type: "restartBackground" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-open-focus-missing-background",
    title: "native open focus missing background",
    notes: "Browser-authored drift probe for focused external window evidence while a background runtime window is omitted from partial query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "focus", "partial-snapshot", "reconciliation"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Native background partial" }], captureWindow: "nh-focus-background-window", captureTabs: "nh-focus-background-tabs" },
      { type: "focusWindow", window: { windowId: 10 } },
      { type: "manualRefreshWithMissingWindowQuery", window: { capture: "nh-focus-background-window" } }
    ]
  },
  {
    id: "nh-native-open-two-windows-reordered-both",
    title: "native open two windows reordered both",
    notes: "Browser-authored drift probe for two external windows with independent reordered query evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "stale-query", "multi-tab", "reconciliation"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Native reorder A1" }, { title: "Native reorder A2", active: true }], captureWindow: "nh-reorder-window-a", captureTabs: "nh-reorder-tabs-a" },
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Native reorder B1" }, { title: "Native reorder B2", active: true }], captureWindow: "nh-reorder-window-b", captureTabs: "nh-reorder-tabs-b" },
      { type: "manualRefreshWithReorderedQuery", window: { capture: "nh-reorder-window-a" }, order: "reverse" },
      { type: "manualRefreshWithReorderedQuery", window: { capture: "nh-reorder-window-b" }, order: "rotateLeft" }
    ]
  },
  {
    id: "nh-native-open-created-then-tab-close-session",
    title: "native open created then tab close session",
    notes: "Browser-authored drift probe for an externally created tab closed by browser events after session churn.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "native-close", "session", "tombstone"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native close after create" }], captureWindow: "nh-created-close-window", captureTabs: "nh-created-close-tabs" },
      { type: "sessionChanged" },
      { type: "nativeCloseTab", tab: { capture: "nh-created-close-tabs" }, order: "sessionChangedThenTabRemoved" }
    ]
  },
  {
    id: "nh-native-open-opener-focus-reordered",
    title: "native open opener focus reordered",
    notes: "Browser-authored drift probe for opener-linked external tabs with focus churn and reordered destination query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "opener", "focus", "stale-query"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native opener focus", openerTab: { tabId: 1 } }, { title: "Native opener focus sibling" }], captureWindow: "nh-opener-focus-window", captureTabs: "nh-opener-focus-tabs" },
      { type: "focusWindow", window: { windowId: 10 } },
      { type: "focusWindow", window: { capture: "nh-opener-focus-window" } },
      { type: "manualRefreshWithReorderedQuery", window: { capture: "nh-opener-focus-window" }, order: "reverse" }
    ]
  },
  {
    id: "nh-native-open-command-move-new-window-refresh",
    title: "native open command move new window refresh",
    notes: "Browser-authored drift probe for a browser-created tab later relocated by a TO command.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "relocation", "manual-refresh", "reconciliation"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native command move" }], captureWindow: "nh-command-move-window", captureTabs: "nh-command-move-tabs" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "nh-command-move-tabs" }, captureStaleTabs: "nh-command-move-old" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-open-command-group-refresh",
    title: "native open command group refresh",
    notes: "Browser-authored drift probe for TO grouping inside an externally created multi-tab window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "relocation", "multi-tab", "manual-refresh"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native group A" }, { title: "Native group B", active: true }], captureWindow: "nh-command-group-window", captureTabs: "nh-command-group-tabs" },
      { type: "outlinerGroupTab", tab: { capture: "nh-command-group-tabs", index: 0 } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-open-command-top-level-refresh",
    title: "native open command top level refresh",
    notes: "Browser-authored drift probe for moving an externally created tab subtree to a command-created top-level window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "relocation", "manual-refresh", "reconciliation"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native top level A" }, { title: "Native top level B", active: true }], captureWindow: "nh-command-top-window", captureTabs: "nh-command-top-tabs" },
      { type: "outlinerMoveSubtreeToTopLevel", tab: { capture: "nh-command-top-tabs", index: 0 }, captureStaleTabs: "nh-command-top-old" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-open-delete-reject-window-abrupt",
    title: "native open delete reject window abrupt",
    notes: "Browser-authored drift probe for delete-reject recovery on an externally created window across abrupt restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "delete-rejection", "restart", "tombstone"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native delete reject window" }], captureWindow: "nh-delete-reject-native-window", captureTabs: "nh-delete-reject-native-tabs" },
      { type: "outlinerDeleteNodeRejectingClose", node: { window: { capture: "nh-delete-reject-native-window" } } },
      { type: "restartBackgroundAbrupt" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-open-close-reject-tab-session",
    title: "native open close reject tab session",
    notes: "Browser-authored drift probe for close-reject recovery on an externally created tab followed by session evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "outliner-close", "command-rejection", "session"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native close reject tab" }], captureWindow: "nh-close-reject-tab-window", captureTabs: "nh-close-reject-tab-tabs" },
      { type: "outlinerCloseNodeRejectingClose", node: { tab: { capture: "nh-close-reject-tab-tabs" } } },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "nh-native-open-many-restart-missing-one",
    title: "native open many restart missing one",
    notes: "Browser-authored drift probe for multiple externally created windows across restart with one omitted from a partial query.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "restart", "partial-snapshot", "reconciliation"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Native many A" }], captureWindow: "nh-many-window-a", captureTabs: "nh-many-tabs-a" },
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Native many B" }], captureWindow: "nh-many-window-b", captureTabs: "nh-many-tabs-b" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingWindowQuery", window: { capture: "nh-many-window-a" } }
    ]
  },
  {
    id: "nh-native-open-many-abrupt-refresh",
    title: "native open many abrupt refresh",
    notes: "Browser-authored drift probe for multiple externally created windows across abrupt restart and complete refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "restart", "manual-refresh", "reconciliation"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Native abrupt many A" }], captureWindow: "nh-abrupt-many-window-a", captureTabs: "nh-abrupt-many-tabs-a" },
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Native abrupt many B" }, { title: "Native abrupt many C", active: true }], captureWindow: "nh-abrupt-many-window-b", captureTabs: "nh-abrupt-many-tabs-b" },
      { type: "restartBackgroundAbrupt" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-open-window-only-close-after-restart",
    title: "native open window only close after restart",
    notes: "Browser-authored drift probe for externally created window reconstruction followed by window-only native close evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "native-close", "restart", "event-order"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native close after restart" }], captureWindow: "nh-close-after-restart-window", captureTabs: "nh-close-after-restart-tabs" },
      { type: "restartBackground" },
      { type: "nativeCloseWindow", window: { capture: "nh-close-after-restart-window" }, order: "windowRemovedOnly" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "nh-native-detach-with-external-id-gaps",
    title: "native detach with external id gaps",
    notes: "Browser-authored drift probe for native detach-to-new-window surrounded by externally created runtime ID gaps.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "native-open", "manual-refresh", "reconciliation"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Native gap before detach" }], captureWindow: "nh-detach-gap-before-window", captureTabs: "nh-detach-gap-before-tabs" },
      { type: "nativeMoveTabToNewWindow", tab: { tabId: 2 }, captureWindow: "nh-detach-gap-window", captureStaleTabs: "nh-detach-gap-old" },
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Native gap after detach" }], captureWindow: "nh-detach-gap-after-window", captureTabs: "nh-detach-gap-after-tabs" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "nh-native-open-opener-close-child-stale",
    title: "native open opener close child stale",
    notes: "Browser-authored drift probe for opener-linked externally created tab closing before delayed created evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "opener", "native-close", "stale-event"],
    actions: [
      { type: "nativeOpenWindow", tabs: [{ title: "Native opener child close", openerTab: { tabId: 1 } }], captureWindow: "nh-opener-close-child-window", captureTabs: "nh-opener-close-child-tabs" },
      { type: "nativeCloseTab", tab: { capture: "nh-opener-close-child-tabs" }, order: "tabRemovedThenSessionChanged" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "nh-opener-close-child-tabs" }, withStaleQuery: true }
    ]
  },
  {
    id: "mh-native-same-window-reorder",
    title: "native same window reorder",
    notes: "Runtime-shape probe for browser-authored same-window tab order changes with no command transaction.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["metadata", "native-move", "manual-refresh"],
    assertions: ["runtimeOrder"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, title: "Order filler", captureTab: "mh-order-filler" },
      { type: "nativeMoveTabToWindow", tab: { tabId: 1 }, window: { windowId: 10 }, index: 2, active: true, captureStaleTabs: "mh-order-tab-one" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-native-reorder-session-restart",
    title: "native reorder session restart",
    notes: "Runtime-shape probe for same-window browser reorder across session churn and normal restart.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-move", "session", "restart", "metadata"],
    assertions: ["runtimeOrder"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, title: "Restart order filler", captureTab: "mh-restart-order-filler" },
      { type: "nativeMoveTabToWindow", tab: { capture: "mh-restart-order-filler" }, window: { windowId: 10 }, index: 0, active: false, captureStaleTabs: "mh-restart-order-old" },
      { type: "sessionChanged" },
      { type: "restartBackground" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-native-created-window-reorder",
    title: "native created window reorder",
    notes: "Runtime-shape probe for a browser-created multi-tab window whose internal order changes later.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "native-move", "multi-tab", "metadata"],
    assertions: ["runtimeOrder", "runtimeMetadata"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Order A" }, { title: "Order B" }, { title: "Order C", active: true }], captureWindow: "mh-created-order-window", captureTabs: "mh-created-order-tabs" },
      { type: "nativeMoveTabToWindow", tab: { capture: "mh-created-order-tabs", index: 2 }, window: { capture: "mh-created-order-window" }, index: 0, active: true, captureStaleTabs: "mh-created-order-old" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-restored-tab-reorder",
    title: "restored tab reorder",
    notes: "Runtime-shape probe for a restored tab reordered among live siblings after recovery.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restore", "native-move", "multi-tab", "metadata"],
    assertions: ["runtimeOrder", "runtimeMetadata"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" }, captureRestoredTabs: "mh-restored-order-tab" },
      { type: "openTab", window: { role: "firstRuntimeWindow" }, active: false, title: "Restored order sibling", captureTab: "mh-restored-order-sibling" },
      { type: "nativeMoveTabToWindow", tab: { capture: "mh-restored-order-tab" }, window: { role: "firstRuntimeWindow" }, index: 0, active: false, captureStaleTabs: "mh-restored-order-old" }
    ]
  },
  {
    id: "mh-grouped-sibling-reorder-history",
    title: "grouped sibling reorder history",
    notes: "Runtime-shape probe for browser-authored order changes after TO grouping and undo/redo.",
    purpose: "regression",
    origin: "agent-generated",
    tags: ["nested", "undo-redo", "native-move", "multi-tab"],
    assertions: ["runtimeOrder"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, title: "Grouped order sibling", captureTab: "mh-grouped-order-sibling" },
      { type: "outlinerGroupTab", tab: { tabId: 1 }, captureStaleTabs: "mh-grouped-order-before" },
      { type: "outlinerUndo" },
      { type: "outlinerRedo" },
      { type: "nativeMoveTabToWindow", tab: { capture: "mh-grouped-order-sibling" }, window: { windowId: 10 }, index: 0, active: false, captureStaleTabs: "mh-grouped-order-old" }
    ]
  },
  {
    id: "mh-update-title-url-favicon",
    title: "update title url favicon",
    notes: "Runtime-shape probe for live tab title/url/favicon metadata convergence from browser update events.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["metadata", "updated-event", "manual-refresh"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "updateTab", tab: { tabId: 2 }, title: "Meta Two", url: "https://meta.example/two", favIconUrl: "https://meta.example/favicon.ico" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-restored-tab-real-metadata",
    title: "restored tab real metadata",
    notes: "Runtime-shape probe for restored-tab real metadata replacing transient restore metadata.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["metadata", "restore", "updated-event"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" }, captureRestoredTabs: "mh-restored-meta-tab" },
      { type: "updateTab", tab: { capture: "mh-restored-meta-tab" }, title: "Restored Real Title", url: "https://restored-meta.example/", favIconUrl: "https://restored-meta.example/icon.png" }
    ]
  },
  {
    id: "mh-native-open-metadata-restart",
    title: "native open metadata restart",
    notes: "Runtime-shape probe for browser-created tab metadata across restart reconstruction.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["metadata", "native-open", "restart"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Native Meta", url: "https://native-meta.example/" }], captureWindow: "mh-native-meta-window", captureTabs: "mh-native-meta-tabs" },
      { type: "restartBackground" },
      { type: "updateTab", tab: { capture: "mh-native-meta-tabs" }, title: "Native Meta Updated", url: "https://native-meta.example/updated", favIconUrl: "https://native-meta.example/icon.ico" }
    ]
  },
  {
    id: "mh-moved-current-metadata-stale-old",
    title: "moved current metadata stale old",
    notes: "Runtime-shape probe for current metadata on a moved tab followed by stale old-window update evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["metadata", "relocation", "updated-event", "stale-event"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 2 }, captureStaleTabs: "mh-moved-meta-old" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Moved Fresh Meta", url: "https://moved-meta.example/", favIconUrl: "https://moved-meta.example/icon.png" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "mh-moved-meta-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "mh-metadata-missing-reordered-query",
    title: "metadata missing reordered query",
    notes: "Runtime-shape probe for metadata preservation through missing-tab and reordered-window refresh skew.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["metadata", "partial-snapshot", "stale-query", "manual-refresh"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "updateTab", tab: { tabId: 1 }, title: "Query Meta One", url: "https://query-meta.example/one", favIconUrl: "https://query-meta.example/one.ico" },
      { type: "manualRefreshWithMissingTabQuery", tab: { tabId: 1 } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" }
    ]
  },
  {
    id: "mh-opener-parent-native-move-child",
    title: "opener parent native move child",
    notes: "Runtime-shape opener probe for a browser-authored parent move while its opener child remains in the source window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "reparenting", "native-move", "manual-refresh"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "mh-opener-child" },
      { type: "nativeMoveTabToWindow", tab: { tabId: 1 }, window: { windowId: 20 }, active: false, captureStaleTabs: "mh-opener-parent-old" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-opener-chain-native-reorder",
    title: "opener chain native reorder",
    notes: "Runtime-shape opener probe for a grandchild opener chain followed by browser-authored reorder evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "reparenting", "native-move", "stale-query"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "mh-opener-chain-child" },
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { capture: "mh-opener-chain-child" }, captureTab: "mh-opener-chain-grandchild" },
      { type: "nativeMoveTabToWindow", tab: { capture: "mh-opener-chain-grandchild" }, window: { windowId: 10 }, index: 0, active: false, captureStaleTabs: "mh-opener-chain-old" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateLeft" }
    ]
  },
  {
    id: "mh-cross-window-opener-creation",
    title: "cross window opener creation",
    notes: "Runtime-shape opener control for browser-created tabs whose opener lives in another window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "reparenting", "native-open", "manual-refresh"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Cross opener", openerTab: { tabId: 1 } }, { title: "Cross opener sibling" }], captureWindow: "mh-cross-opener-window", captureTabs: "mh-cross-opener-tabs" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-opener-source-close-stale-created",
    title: "opener source close stale created",
    notes: "Runtime-shape opener probe for source close followed by stale created evidence for an opener child.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "reparenting", "native-close", "created-event", "stale-event"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "mh-opener-source-close-child" },
      { type: "outlinerMoveTabCommandToNewWindow", tab: { capture: "mh-opener-source-close-child" }, captureStaleTabs: "mh-opener-source-close-old" },
      { type: "nativeCloseWindow", window: { windowId: 10 }, order: "windowRemovedOnly" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "mh-opener-source-close-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "mh-paired-created-updated-after-native-move",
    title: "paired created updated after native move",
    notes: "Runtime-shape paired-echo probe for stale created and updated events after a browser-authored detach.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["paired-echo", "created-event", "updated-event", "native-move", "stale-event"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "nativeMoveTabToNewWindow", tab: { tabId: 2 }, captureWindow: "mh-paired-move-window", captureStaleTabs: "mh-paired-move-old" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Paired Fresh", url: "https://paired.example/fresh" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "mh-paired-move-old" }, withStaleQuery: false },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "mh-paired-move-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "mh-race-activation-metadata-group",
    title: "race activation metadata group",
    notes: "Runtime-shape race probe for a metadata update racing a TO grouping command.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["race", "metadata", "updated-event", "nested"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "raceWithOutlinerGroup", event: { type: "updateTab", tab: { tabId: 2 }, title: "Race Meta Two", url: "https://race-meta.example/two" }, groupTab: { tabId: 1 }, captureStaleTabs: "mh-race-meta-before" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-focus-move-update-ordering",
    title: "focus move update ordering",
    notes: "Runtime-shape paired ordering probe for focus, native move, and metadata update evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["focus", "native-move", "updated-event", "metadata"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "focusWindow", window: { windowId: 20 } },
      { type: "nativeMoveTabToWindow", tab: { tabId: 2 }, window: { windowId: 20 }, active: true, captureStaleTabs: "mh-focus-move-old" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Focus Move Meta", url: "https://focus-move.example/" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-event-local-metadata-complete-refresh",
    title: "event local metadata complete refresh",
    notes: "Runtime-shape probe for event-local metadata followed by a complete refresh snapshot.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["fresh-event", "metadata", "updated-event", "manual-refresh"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "updateTab", tab: { tabId: 3 }, title: "Event Local Meta", url: "https://event-local.example/", favIconUrl: "https://event-local.example/icon.png" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-nested-command-window-reorder",
    title: "nested command window reorder",
    notes: "Runtime-shape nested-window probe for command-created destination tabs reordered by browser evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["nested-window", "multi-tab", "relocation", "native-move"],
    assertions: ["runtimeOrder"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "mh-nested-command-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, title: "Nested command sibling", captureTab: "mh-nested-command-sibling" },
      { type: "nativeMoveTabToWindow", tab: { capture: "mh-nested-command-sibling" }, window: { role: "lastOpenedWindow" }, index: 0, active: false, captureStaleTabs: "mh-nested-command-reorder-old" }
    ]
  },
  {
    id: "mh-partial-close-metadata-update",
    title: "partial close metadata update",
    notes: "Runtime-shape partial-close probe for survivor metadata after tab-only window close evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["partial-close", "metadata", "native-close", "updated-event"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, title: "Partial close survivor", captureTab: "mh-partial-close-survivor" },
      { type: "nativeCloseTab", tab: { tabId: 3 }, order: "tabRemovedOnly" },
      { type: "updateTab", tab: { capture: "mh-partial-close-survivor" }, title: "Partial Survivor Meta", url: "https://partial-close.example/survivor" }
    ]
  },
  {
    id: "mh-native-multitab-move-one-out",
    title: "native multitab move one out",
    notes: "Runtime-shape multi-tab probe for a browser-created window after one tab moves out.",
    purpose: "regression",
    origin: "agent-generated",
    tags: ["native-open", "native-move", "multi-tab", "manual-refresh"],
    assertions: ["runtimeOrder", "runtimeMetadata"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Multi A" }, { title: "Multi B" }, { title: "Multi C", active: true }], captureWindow: "mh-multitab-window", captureTabs: "mh-multitab-tabs" },
      { type: "nativeMoveTabToWindow", tab: { capture: "mh-multitab-tabs", index: 1 }, window: { windowId: 10 }, index: 1, active: false, captureStaleTabs: "mh-multitab-move-old" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-restart-nested-reorder-missing",
    title: "restart nested reorder missing",
    notes: "Runtime-shape nested-window probe for reorder evidence across restart followed by a missing-window query.",
    purpose: "regression",
    origin: "agent-generated",
    tags: ["nested-window", "restart", "partial-snapshot", "native-move"],
    assertions: ["runtimeOrder"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 2 }, captureStaleTabs: "mh-restart-nested-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, title: "Restart nested sibling", captureTab: "mh-restart-nested-sibling" },
      { type: "nativeMoveTabToWindow", tab: { capture: "mh-restart-nested-sibling" }, window: { role: "lastOpenedWindow" }, index: 0, active: false, captureStaleTabs: "mh-restart-nested-reorder-old" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 10 } }
    ]
  },
  {
    id: "mh-active-fallback-same-window-reorder",
    title: "active fallback same window reorder",
    notes: "Runtime-shape clone for same-window reorder when the moved active tab becomes inactive and the browser chooses a fallback active tab.",
    purpose: "regression",
    origin: "agent-generated",
    tags: ["metadata", "native-move", "activation", "manual-refresh"],
    actions: [
      { type: "activateTab", tab: { tabId: 2 } },
      { type: "nativeMoveTabToWindow", tab: { tabId: 2 }, window: { windowId: 10 }, index: 0, active: false, captureStaleTabs: "mh-active-fallback-old" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-active-fallback-command-window",
    title: "active fallback command window",
    notes: "Runtime-shape clone for active fallback inside a command-created destination after browser-authored same-window reorder.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["metadata", "relocation", "activation", "native-move"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 2 }, captureStaleTabs: "mh-active-command-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, title: "Command active fallback sibling", captureTab: "mh-active-command-sibling" },
      { type: "nativeMoveTabToWindow", tab: { role: "lastMovedTab" }, window: { role: "lastOpenedWindow" }, index: 1, active: false, captureStaleTabs: "mh-active-command-reorder-old" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "mh-active-fallback-restored-window",
    title: "active fallback restored window",
    notes: "Runtime-shape clone for active fallback after restoring a closed window and reordering its restored active tab.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restore", "activation", "native-move", "multi-tab"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 10 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:10" }, captureRestoredTabs: "mh-active-restored-tabs", captureRestoredWindows: "mh-active-restored-window" },
      { type: "nativeMoveTabToWindow", tab: { capture: "mh-active-restored-tabs" }, window: { capture: "mh-active-restored-window" }, index: 1, active: false, captureStaleTabs: "mh-active-restored-old" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-order-native-open-move-front",
    title: "order native open move front",
    notes: "Runtime-shape clone for moving a browser-created tab into the front of an existing runtime window.",
    purpose: "regression",
    origin: "agent-generated",
    tags: ["native-open", "native-move", "multi-tab", "manual-refresh"],
    assertions: ["runtimeOrder"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Move front A" }, { title: "Move front B", active: true }], captureWindow: "mh-order-front-window", captureTabs: "mh-order-front-tabs" },
      { type: "nativeMoveTabToWindow", tab: { capture: "mh-order-front-tabs", index: 1 }, window: { windowId: 10 }, index: 0, active: false, captureStaleTabs: "mh-order-front-old" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-order-native-open-move-middle-session",
    title: "order native open move middle session",
    notes: "Runtime-shape clone for moving a browser-created tab into the middle of an existing window before session churn.",
    purpose: "regression",
    origin: "agent-generated",
    tags: ["native-open", "native-move", "multi-tab", "session"],
    assertions: ["runtimeOrder"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, title: "Middle target filler", captureTab: "mh-order-middle-filler" },
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Move middle A" }, { title: "Move middle B", active: true }], captureWindow: "mh-order-middle-window", captureTabs: "mh-order-middle-tabs" },
      { type: "nativeMoveTabToWindow", tab: { capture: "mh-order-middle-tabs" }, window: { windowId: 10 }, index: 1, active: false, captureStaleTabs: "mh-order-middle-old" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "mh-order-command-destination-move-out",
    title: "order command destination move out",
    notes: "Runtime-shape clone for moving a tab out of a command-created multi-tab destination and checking both windows' order.",
    purpose: "regression",
    origin: "agent-generated",
    tags: ["relocation", "native-move", "multi-tab", "nested-window"],
    assertions: ["runtimeOrder"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "mh-order-command-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, title: "Command order sibling", captureTab: "mh-order-command-sibling" },
      { type: "nativeMoveTabToWindow", tab: { role: "lastMovedTab" }, window: { windowId: 10 }, index: 1, active: false, captureStaleTabs: "mh-order-command-move-old" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-metadata-paired-stale-current",
    title: "metadata paired stale current",
    notes: "Runtime-shape clone for fresh metadata followed by paired stale old-window echoes and a complete refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["metadata", "paired-echo", "updated-event", "stale-event"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "mh-meta-paired-old" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Paired Current Meta", url: "https://paired-current.example/", favIconUrl: "https://paired-current.example/icon.ico" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "mh-meta-paired-old" }, withStaleQuery: false },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "mh-meta-paired-old" }, withStaleQuery: false },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-metadata-native-created-stale-refresh",
    title: "metadata native created stale refresh",
    notes: "Runtime-shape clone for metadata on an external tab after stale event-local evidence and reordered refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["metadata", "native-open", "updated-event", "stale-query"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "External stale meta" }], captureWindow: "mh-meta-native-window", captureTabs: "mh-meta-native-tabs" },
      { type: "updateTab", tab: { capture: "mh-meta-native-tabs" }, title: "External Meta Fresh", url: "https://external-meta.example/" },
      { type: "manualRefreshWithReorderedQuery", window: { capture: "mh-meta-native-window" }, order: "rotateRight" }
    ]
  },
  {
    id: "mh-command-destination-move-out-restart",
    title: "command destination move out restart",
    notes: "Runtime-shape clone for a command-relocated tab moved natively back to the source window across restart.",
    purpose: "regression",
    origin: "agent-generated",
    tags: ["relocation", "native-move", "restart", "manual-refresh"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 2 }, captureStaleTabs: "mh-command-out-restart-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, title: "Command out restart sibling", captureTab: "mh-command-out-restart-sibling" },
      { type: "nativeMoveTabToWindow", tab: { role: "lastMovedTab" }, window: { windowId: 10 }, index: 0, active: false, captureStaleTabs: "mh-command-out-restart-move-old" },
      { type: "restartBackground" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-command-destination-move-out-stale",
    title: "command destination move out stale",
    notes: "Runtime-shape clone for native move-back of a command-relocated tab followed by stale destination evidence.",
    purpose: "regression",
    origin: "agent-generated",
    tags: ["relocation", "native-move", "stale-event", "updated-event"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "mh-command-out-stale-source-old" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Before move back", url: "https://move-back.example/before" },
      { type: "nativeMoveTabToWindow", tab: { role: "lastMovedTab" }, window: { windowId: 10 }, index: 1, active: false, captureStaleTabs: "mh-command-out-stale-destination-old" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "mh-command-out-stale-destination-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "mh-native-detach-move-back-history",
    title: "native detach move back history",
    notes: "Runtime-shape clone for browser-authored detach, native move back, and TO history replay.",
    purpose: "regression",
    origin: "agent-generated",
    tags: ["native-move", "undo-redo", "manual-refresh", "metadata"],
    assertions: ["runtimeOrder"],
    actions: [
      { type: "nativeMoveTabToNewWindow", tab: { tabId: 2 }, captureWindow: "mh-detach-back-window", captureStaleTabs: "mh-detach-back-old" },
      { type: "nativeMoveTabToWindow", tab: { role: "lastMovedTab" }, window: { windowId: 10 }, index: 0, active: false, captureStaleTabs: "mh-detach-back-destination-old" },
      { type: "outlinerGroupTab", tab: { tabId: 1 } },
      { type: "outlinerUndo" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-active-fallback-native-created-window",
    title: "active fallback native created window",
    notes: "Runtime-shape clone for active fallback when a browser-created window reorders its active tab to inactive.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["native-open", "native-move", "activation", "multi-tab"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Created active A" }, { title: "Created active B", active: true }], captureWindow: "mh-active-created-window", captureTabs: "mh-active-created-tabs" },
      { type: "nativeMoveTabToWindow", tab: { capture: "mh-active-created-tabs", index: 1 }, window: { capture: "mh-active-created-window" }, index: 0, active: false, captureStaleTabs: "mh-active-created-old" },
      { type: "sessionChanged" }
    ]
  },
  {
    id: "mh-order-restored-window-move-out",
    title: "order restored window move out",
    notes: "Runtime-shape clone for restored multi-tab window order after one restored tab moves to an existing window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["restore", "native-move", "multi-tab", "manual-refresh"],
    assertions: ["runtimeOrder", "runtimeMetadata"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 10 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:10" }, captureRestoredTabs: "mh-order-restored-tabs", captureRestoredWindows: "mh-order-restored-window" },
      { type: "nativeMoveTabToWindow", tab: { capture: "mh-order-restored-tabs", index: 1 }, window: { windowId: 20 }, index: 1, active: false, captureStaleTabs: "mh-order-restored-old" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-order-two-window-swap",
    title: "order two window swap",
    notes: "Runtime-shape clone for two browser-created windows swapping one tab each into existing windows.",
    purpose: "regression",
    origin: "agent-generated",
    tags: ["native-open", "native-move", "multi-tab", "stale-query"],
    assertions: ["runtimeOrder"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Swap A1" }, { title: "Swap A2", active: true }], captureWindow: "mh-swap-window-a", captureTabs: "mh-swap-tabs-a" },
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Swap B1" }, { title: "Swap B2", active: true }], captureWindow: "mh-swap-window-b", captureTabs: "mh-swap-tabs-b" },
      { type: "nativeMoveTabToWindow", tab: { capture: "mh-swap-tabs-a" }, window: { capture: "mh-swap-window-b" }, index: 1, active: false, captureStaleTabs: "mh-swap-a-old" },
      { type: "nativeMoveTabToWindow", tab: { capture: "mh-swap-tabs-b" }, window: { windowId: 10 }, index: 1, active: false, captureStaleTabs: "mh-swap-b-old" },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "reverse" }
    ]
  },
  {
    id: "mh-metadata-url-only-stale-old",
    title: "metadata url only stale old",
    notes: "Runtime-shape metadata probe for URL/favicon-only current evidence followed by stale old-window update evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["metadata", "updated-event", "stale-event", "relocation"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "mh-url-only-old" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, url: "https://url-only.example/current", favIconUrl: "https://url-only.example/icon.png" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "mh-url-only-old" }, withStaleQuery: true }
    ]
  },
  {
    id: "mh-metadata-native-restart-missing-window",
    title: "metadata native restart missing window",
    notes: "Runtime-shape metadata probe for browser-created tab metadata across restart and whole-window omission.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["metadata", "native-open", "restart", "partial-snapshot"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Native Missing Meta", url: "https://missing-meta.example/" }], captureWindow: "mh-missing-meta-window", captureTabs: "mh-missing-meta-tabs" },
      { type: "updateTab", tab: { capture: "mh-missing-meta-tabs" }, title: "Native Missing Meta Current", url: "https://missing-meta.example/current", favIconUrl: "https://missing-meta.example/icon.png" },
      { type: "restartBackground" },
      { type: "manualRefreshWithMissingWindowQuery", window: { capture: "mh-missing-meta-window" } }
    ]
  },
  {
    id: "mh-opener-cross-window-metadata",
    title: "opener cross window metadata",
    notes: "Runtime-shape opener probe for cross-window opener metadata, focus churn, and complete refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "reparenting", "metadata", "focus"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Opener Meta Child", openerTab: { tabId: 1 } }], captureWindow: "mh-opener-meta-window", captureTabs: "mh-opener-meta-tabs" },
      { type: "updateTab", tab: { capture: "mh-opener-meta-tabs" }, title: "Opener Meta Current", url: "https://opener-meta.example/" },
      { type: "focusWindow", window: { capture: "mh-opener-meta-window" } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-paired-browser-created-close-metadata",
    title: "paired browser created close metadata",
    notes: "Runtime-shape paired-echo probe for browser-created metadata followed by native close and stale created evidence.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["paired-echo", "metadata", "native-open", "native-close"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Paired close meta" }], captureWindow: "mh-paired-close-window", captureTabs: "mh-paired-close-tabs" },
      { type: "updateTab", tab: { capture: "mh-paired-close-tabs" }, title: "Paired Close Current", url: "https://paired-close.example/" },
      { type: "nativeCloseTab", tab: { capture: "mh-paired-close-tabs" }, order: "sessionChangedThenTabRemoved" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "mh-paired-close-tabs" }, withStaleQuery: true }
    ]
  },
  {
    id: "mh-delayed-restore-metadata-reorder",
    title: "delayed restore metadata reorder",
    notes: "Runtime-shape probe for delayed restore/delete echoes followed by current metadata and reordered refresh.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["delayed-event", "restore", "metadata", "stale-query"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "outlinerRestoreDeleteWindowDelayedEvent", window: { windowId: 20 }, captureStaleTabs: "mh-delayed-restore-old" },
      { type: "updateTab", tab: { role: "firstRuntimeTab" }, title: "Delayed Current Meta", url: "https://delayed-meta.example/" },
      { type: "manualRefreshWithReorderedQuery", window: { role: "firstRuntimeWindow" }, order: "rotateLeft" }
    ]
  },
  {
    id: "mh-partial-close-opener-metadata",
    title: "partial close opener metadata",
    notes: "Runtime-shape probe for opener metadata after tab-only close evidence in the same source window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["partial-close", "opener", "metadata", "native-close"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "mh-partial-opener-child" },
      { type: "nativeCloseTab", tab: { tabId: 2 }, order: "tabRemovedOnly" },
      { type: "updateTab", tab: { capture: "mh-partial-opener-child" }, title: "Partial Opener Meta", url: "https://partial-opener.example/" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-race-created-updated-opener",
    title: "race created updated opener",
    notes: "Runtime-shape race probe for opener-linked creation racing a TO group and then receiving metadata.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["race", "created-event", "updated-event", "opener", "metadata"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "raceWithOutlinerGroup", event: { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "mh-race-opener-created" }, groupTab: { tabId: 2 }, captureStaleTabs: "mh-race-opener-before" },
      { type: "updateTab", tab: { capture: "mh-race-opener-created" }, title: "Race Opener Meta", url: "https://race-opener.example/" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-nested-window-metadata-focus",
    title: "nested window metadata focus",
    notes: "Runtime-shape nested-window probe for metadata and focus churn inside a command-created nested window.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["nested-window", "metadata", "focus", "multi-tab"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 1 }, captureStaleTabs: "mh-nested-meta-old" },
      { type: "openTab", window: { role: "lastOpenedWindow" }, active: false, title: "Nested Meta Sibling", captureTab: "mh-nested-meta-sibling" },
      { type: "updateTab", tab: { capture: "mh-nested-meta-sibling" }, title: "Nested Meta Current", url: "https://nested-meta.example/" },
      { type: "focusWindow", window: { role: "lastOpenedWindow" } },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-focus-reject-metadata-current",
    title: "focus reject metadata current",
    notes: "Runtime-shape probe for focus side-effect rejection followed by authoritative current metadata.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["focus", "command-rejection", "metadata", "updated-event"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "outlinerFocusTabRejectingUpdate", tab: { tabId: 3 } },
      { type: "updateTab", tab: { tabId: 3 }, title: "Focus Reject Meta", url: "https://focus-reject.example/" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-two-window-partial-metadata",
    title: "two window partial metadata",
    notes: "Runtime-shape probe for metadata in one window while another runtime window is omitted and reordered.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["metadata", "partial-snapshot", "stale-query", "multi-tab"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Partial Meta A" }, { title: "Partial Meta B", active: true }], captureWindow: "mh-two-partial-window", captureTabs: "mh-two-partial-tabs" },
      { type: "updateTab", tab: { capture: "mh-two-partial-tabs" }, title: "Two Partial Meta Current", url: "https://two-partial.example/" },
      { type: "manualRefreshWithMissingWindowQuery", window: { capture: "mh-two-partial-window" } },
      { type: "manualRefreshWithReorderedQuery", window: { windowId: 10 }, order: "rotateRight" }
    ]
  },
  {
    id: "mh-delayed-restored-tab-updated-echo",
    title: "delayed restored tab updated echo",
    notes: "Runtime-shape probe for restored-tab metadata followed by delayed stale updated evidence.",
    purpose: "regression",
    origin: "agent-generated",
    tags: ["delayed-event", "restore", "metadata", "updated-event"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" }, captureRestoredTabs: "mh-delayed-restored-tab" },
      { type: "updateTab", tab: { capture: "mh-delayed-restored-tab" }, title: "Delayed Restored Current", url: "https://delayed-restored.example/" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "mh-delayed-restored-tab" }, withStaleQuery: true }
    ]
  },
  {
    id: "mh-opener-native-move-metadata-restart",
    title: "opener native move metadata restart",
    notes: "Runtime-shape probe for opener-linked browser move, current metadata, and restart reconstruction.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "reparenting", "metadata", "restart"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "mh-opener-move-meta-child" },
      { type: "nativeMoveTabToWindow", tab: { capture: "mh-opener-move-meta-child" }, window: { windowId: 20 }, active: false, captureStaleTabs: "mh-opener-move-meta-old" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Opener Move Meta Current", url: "https://opener-move-meta.example/" },
      { type: "restartBackground" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-restored-tab-created-echo-metadata",
    title: "restored tab created echo metadata",
    notes: "Runtime-shape clone for restored-tab current metadata followed by stale created echo evidence.",
    purpose: "regression",
    origin: "agent-generated",
    tags: ["restore", "metadata", "created-event", "stale-event"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" }, captureRestoredTabs: "mh-restored-created-meta-tab" },
      { type: "updateTab", tab: { capture: "mh-restored-created-meta-tab" }, title: "Restored Created Current", url: "https://restored-created.example/" },
      { type: "staleLiveCreatedEvent", staleTab: { capture: "mh-restored-created-meta-tab" }, withStaleQuery: true }
    ]
  },
  {
    id: "mh-restored-window-tab-updated-echo",
    title: "restored window tab updated echo",
    notes: "Runtime-shape clone for restored-window tab metadata followed by stale updated evidence.",
    purpose: "regression",
    origin: "agent-generated",
    tags: ["restore", "metadata", "updated-event", "multi-tab"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "outlinerCloseWindow", window: { windowId: 20 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "window:20" }, captureRestoredTabs: "mh-restored-window-meta-tabs", captureRestoredWindows: "mh-restored-window-meta-window" },
      { type: "updateTab", tab: { capture: "mh-restored-window-meta-tabs" }, title: "Restored Window Current", url: "https://restored-window-meta.example/" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "mh-restored-window-meta-tabs" }, withStaleQuery: true }
    ]
  },
  {
    id: "mh-restored-tab-restart-stale-metadata",
    title: "restored tab restart stale metadata",
    notes: "Runtime-shape clone for restored-tab metadata across restart before stale echo evidence.",
    purpose: "regression",
    origin: "agent-generated",
    tags: ["restore", "metadata", "restart", "stale-event"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" }, captureRestoredTabs: "mh-restored-restart-meta-tab" },
      { type: "updateTab", tab: { capture: "mh-restored-restart-meta-tab" }, title: "Restored Restart Current", url: "https://restored-restart.example/" },
      { type: "restartBackground" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "mh-restored-restart-meta-tab" }, withStaleQuery: true }
    ]
  },
  {
    id: "mh-restored-tab-missing-query-metadata",
    title: "restored tab missing query metadata",
    notes: "Runtime-shape clone for restored-tab metadata through a missing-tab query before stale echo evidence.",
    purpose: "regression",
    origin: "agent-generated",
    tags: ["restore", "metadata", "partial-snapshot", "stale-event"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "outlinerCloseTab", tab: { tabId: 2 } },
      { type: "outlinerRestoreNodeRejectingCreate", node: { nodeId: "tab:2" }, captureRestoredTabs: "mh-restored-missing-meta-tab" },
      { type: "updateTab", tab: { capture: "mh-restored-missing-meta-tab" }, title: "Restored Missing Current", url: "https://restored-missing.example/" },
      { type: "manualRefreshWithMissingTabQuery", tab: { capture: "mh-restored-missing-meta-tab" } },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "mh-restored-missing-meta-tab" }, withStaleQuery: true }
    ]
  },
  {
    id: "mh-control-native-metadata-focus-session",
    title: "control native metadata focus session",
    notes: "Runtime-shape clean-block control for non-restored browser-created metadata through focus and session churn.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["metadata", "native-open", "focus", "session"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "nativeOpenWindow", focused: false, tabs: [{ title: "Control Meta", url: "https://control-meta.example/" }], captureWindow: "mh-control-meta-window", captureTabs: "mh-control-meta-tabs" },
      { type: "updateTab", tab: { capture: "mh-control-meta-tabs" }, title: "Control Meta Current", url: "https://control-meta.example/current", favIconUrl: "https://control-meta.example/icon.png" },
      { type: "focusWindow", window: { capture: "mh-control-meta-window" } },
      { type: "sessionChanged" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-control-opener-metadata-partial",
    title: "control opener metadata partial",
    notes: "Runtime-shape clean-block control for opener-linked metadata while an unrelated background window is omitted.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["opener", "reparenting", "metadata", "partial-snapshot"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "openTab", window: { windowId: 10 }, active: false, openerTab: { tabId: 1 }, captureTab: "mh-control-opener-meta" },
      { type: "updateTab", tab: { capture: "mh-control-opener-meta" }, title: "Control Opener Meta", url: "https://control-opener.example/" },
      { type: "manualRefreshWithMissingWindowQuery", window: { windowId: 20 } }
    ]
  },
  {
    id: "mh-control-race-metadata-refresh",
    title: "control race metadata refresh",
    notes: "Runtime-shape clean-block control for non-restored metadata after a race-style TO grouping operation.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["race", "metadata", "updated-event", "manual-refresh"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "raceWithOutlinerGroup", event: { type: "updateTab", tab: { tabId: 3 }, title: "Control Race Meta", url: "https://control-race.example/" }, groupTab: { tabId: 1 }, captureStaleTabs: "mh-control-race-before" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-control-paired-nonrestored-echo",
    title: "control paired nonrestored echo",
    notes: "Runtime-shape clean-block control for paired stale echoes around a non-restored moved tab with current metadata.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["paired-echo", "metadata", "relocation", "stale-event"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "outlinerMoveTabCommandToNewWindow", tab: { tabId: 3 }, captureStaleTabs: "mh-control-paired-old" },
      { type: "updateTab", tab: { role: "lastMovedTab" }, title: "Control Paired Meta", url: "https://control-paired.example/" },
      { type: "staleLiveUpdatedEvent", staleTab: { capture: "mh-control-paired-old" }, withStaleQuery: false },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-control-native-close-session-metadata",
    title: "control native close session metadata",
    notes: "Runtime-shape clean-block control for survivor metadata after native close plus session churn.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["metadata", "native-close", "session", "manual-refresh"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "openTab", window: { windowId: 20 }, active: false, title: "Close session survivor", captureTab: "mh-close-session-survivor" },
      { type: "nativeCloseTab", tab: { tabId: 3 }, order: "sessionChangedThenTabRemoved" },
      { type: "updateTab", tab: { capture: "mh-close-session-survivor" }, title: "Close Session Survivor Current", url: "https://close-session.example/" },
      { type: "manualRefresh" }
    ]
  },
  {
    id: "mh-control-partial-query-current-metadata",
    title: "control partial query current metadata",
    notes: "Runtime-shape clean-block control for current metadata surviving a partial query that omits another tab.",
    purpose: "discovery",
    origin: "agent-generated",
    tags: ["metadata", "partial-snapshot", "manual-refresh"],
    assertions: ["runtimeMetadata"],
    actions: [
      { type: "updateTab", tab: { tabId: 1 }, title: "Partial Current Meta", url: "https://partial-current.example/" },
      { type: "manualRefreshWithMissingTabQuery", tab: { tabId: 2 } },
      { type: "manualRefresh" }
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
  ["dh-opener-child-missing-manual-query", ["RT-039"]],
  ["dh-opener-history-missing-source-query", ["RT-040"]],
  ["dh-restore-history-missing-window-query", ["RT-041"]],
  ["dh-restore-history-reordered-query", ["RT-042"]],
  ["dh-restore-history-redo-partial-query", ["RT-043"]],
  ["dh-window-close-destination-tabs-only", ["RT-044"]],
  ["dh-window-close-nested-window-only", ["RT-045"]],
  ["dh-window-close-source-tabs-only", ["RT-046"]],
  ["dh-query-missing-source-window-after-relocation", ["RT-047"]],
  ["dh-relocation-create-reject-direct", ["RT-048"]],
  ["dh-relocation-create-reject-opener", ["RT-049"]],
  ["dh-focus-session-missing-window-query", ["RT-050"]],
  ["dh-focus-session-missing-background-window", ["RT-051"]],
  ["dh-opener-focus-session-missing-window", ["RT-052"]],
  ["dh-window-close-opener-tabs-only", ["RT-053"]],
  ["dh-window-close-destination-window-only", ["RT-054"]],
  ["dh-nested-tabs-only-session-refresh", ["RT-055"]],
  ["dh-restore-history-source-reordered-session", ["RT-056"]],
  ["dh-relocation-reject-after-reordered-query", ["RT-057"]],
  ["dh-focus-relocation-missing-background-query", ["RT-058"]],
  ["dh-relocation-reject-after-focus-session", ["RT-059"]],
  ["dh-restore-history-missing-source-session", ["RT-060"]],
  ["dh-destination-default-close-missing-source-query", ["RT-061"]],
  ["dh-restore-redo-missing-source-session", ["RT-062"]],
  ["dh-restart-destination-close-stale-old", ["RT-063"]],
  ["dh-restore-native-close-after-restart", ["RT-064"]],
  ["dh-restart-destination-tabs-only-stale-created", ["RT-065"]],
  ["dh-restart-destination-window-first-paired-old", ["RT-066"]],
  ["dh-restart-relocated-tab-session-only-stale", ["RT-067"]],
  ["dh-restart-relocated-tab-removed-only-stale", ["RT-068"]],
  ["dh-restart-restore-native-tabs-only-stale", ["RT-069"]],
  ["dh-restart-restore-native-window-first-stale", ["RT-070"]],
  ["dh-restart-reject-destination-close-stale-old", ["RT-071"]],
  ["dh-restart-group-destination-close-stale-old", ["RT-072"]],
  ["dh-restart-top-level-destination-close-stale-old", ["RT-073"]],
  ["dh-restart-outliner-close-destination-stale-old", ["RT-074"]],
  ["dh-restart-outliner-close-tab-stale-old", ["RT-075"]],
  ["dh-restart-destination-window-only-manual-stale", ["RT-076"]],
  ["dh-restart-destination-tabs-only-manual-stale", ["RT-077"]],
  ["dh-restart-restore-native-default-stale", ["RT-078"]],
  ["dh-restart-restore-native-tab-close-stale", ["RT-079"]],
  ["dh-restart-restore-outliner-close-window-stale", ["RT-080"]],
  ["dh-restart-delete-reject-destination-close-created", ["RT-081"]],
  ["dh-opener-chain-restart-destination-close", ["RT-082"]],
  ["dh-restart-focus-command-no-relocation", ["RT-083"]],
  ["dh-restart-focus-command-complete-refresh", ["RT-084"]],
  ["dh-restart-focus-command-session-activation", ["RT-085"]],
  ["dh-restart-focus-command-missing-focused-tab", ["RT-086"]],
  ["dh-restart-missing-opened-tab-query", ["RT-087"]],
  ["dh-restart-missing-background-opened-tab-query", ["RT-088"]],
  ["dh-restart-missing-active-opened-tab-query", ["RT-089"]],
  ["dh-restart-missing-opener-child-query", ["RT-090"]],
  ["bh-restore-create-reject-tab", ["RT-091"]],
  ["bh-restore-create-reject-window", ["RT-092"]],
  ["bh-restart-restore-create-reject-tab", ["RT-093"]],
  ["bh-restore-create-reject-tab-after-redo", ["RT-094"]],
  ["bh-restart-restore-create-reject-window", ["RT-095"]],
  ["ph-close-reject-tab-session-refresh", ["RT-096"]],
  ["ph-focus-after-close-reject-session", ["RT-098"]],
  ["ph-close-reject-tab-undo-redo", ["RT-103"]],
  ["lh-relocated-tab-close-reject-history", ["RT-104"]],
  ["lh-relocated-window-close-reject-history", ["RT-105"]],
  ["hh-native-close-after-relocation-history", ["RT-106"]],
  ["hh-delete-source-window-history", ["RT-107"]],
  ["hh-native-close-group-history", ["RT-108"]],
  ["hh-native-close-opener-history", ["RT-109"]],
  ["hh-native-close-restart-before-undo", ["RT-110"]],
  ["hh-delete-source-group-history", ["RT-111"]],
  ["hh-delete-source-focus-history", ["RT-112"]],
  ["hh-delete-source-reordered-history", ["RT-113"]],
  ["hh-native-source-window-tabs-then-history", ["RT-114"]],
  ["hh-native-source-window-restart-history", ["RT-115"]],
  ["hh-delete-source-window-redo-history", ["RT-116"]],
  ["hh-delete-source-restart-before-undo", ["RT-117"]],
  ["hh-delete-source-stale-after-redo", ["RT-118"]],
  ["hh-top-level-delete-source-history", ["RT-119"]],
  ["hh-restored-tab-native-close-history", ["RT-120"]],
  ["hh-native-source-window-only-redo", ["RT-121"]],
  ["hh-native-source-tabs-only-redo", ["RT-122"]],
  ["hh-native-source-focus-history", ["RT-123"]],
  ["hh-native-source-opener-history", ["RT-124"]],
  ["hh-restored-tab-native-session-history", ["RT-125"]],
  ["hh-restored-tab-native-restart-history", ["RT-126"]],
  ["hh-restored-tab-native-stale-history", ["RT-127"]],
  ["jh-close-tab-abrupt-stale-update", ["RT-128"]],
  ["jh-close-single-window-abrupt-session", ["RT-129"]],
  ["jh-close-multi-window-abrupt-refresh", ["RT-130"]],
  ["jh-close-grouped-window-abrupt-reordered", ["RT-131"]],
  ["jh-undo-close-abrupt-missing", ["RT-132"]],
  ["jh-journal-recovered-stale-contradiction", ["RT-133"]],
  ["jh-journal-recovered-native-contradiction", ["RT-134"]],
  ["jh-close-relocated-destination-abrupt-old-event", ["RT-135"]],
  ["jh-close-relocated-source-abrupt-session", ["RT-136"]],
  ["jh-close-restored-tab-abrupt-session", ["RT-137"]],
  ["jh-close-restored-window-abrupt-missing", ["RT-138"]],
  ["jh-close-opener-child-abrupt-query", ["RT-139"]],
  ["jh-window-close-undo-abrupt-refresh", ["RT-140"]],
  ["jh-delete-opener-child-abrupt-stale", ["RT-141"]],
  ["jh-delete-opener-child-abrupt-updated", ["RT-142"]],
  ["jh-delete-opened-child-abrupt-created", ["RT-143"]],
  ["jh-native-window-no-journal-abrupt", ["RT-144"]],
  ["jh-native-window-tabs-then-abrupt", ["RT-145"]],
  ["jh-native-window-window-then-tabs-abrupt", ["RT-146"]],
  ["jh-native-window-tabs-only-abrupt", ["RT-147"]],
  ["jh-native-multitab-window-abrupt", ["RT-148"]],
  ["jh-native-restored-window-abrupt", ["RT-149"]],
  ["jh-native-restored-window-tabs-then-abrupt", ["RT-150"]],
  ["jh-native-restored-multitab-window-abrupt", ["RT-151"]],
  ["jh-native-restored-window-window-then-tabs-abrupt", ["RT-152"]],
  ["jh-native-restored-window-tabs-only-abrupt", ["RT-153"]],
  ["jh-native-restored-tab-abrupt", ["RT-154"]],
  ["nh-native-move-existing-refresh", ["RT-155"]],
  ["nh-native-move-opener-child-refresh", ["RT-156"]],
  ["nh-native-move-close-tab-stale", ["RT-157"]],
  ["nh-native-move-close-destination-window", ["RT-158"]],
  ["nh-native-move-close-source-window", ["RT-159"]],
  ["nh-native-move-session-only-close", ["RT-160"]],
  ["nh-native-move-restart-refresh", ["RT-161"]],
  ["nh-native-move-reordered-destination", ["RT-162"]],
  ["nh-history-undo-native-move", ["RT-163"]],
  ["nh-restored-tab-native-move", ["RT-164"]],
  ["nh-native-open-id-gap-history-restart", ["RT-165"]],
  ["nh-native-open-single-history-undo", ["RT-166"]],
  ["nh-native-open-multitab-history-undo", ["RT-167"]],
  ["nh-native-open-history-group-redo", ["RT-168"]],
  ["nh-native-open-history-session-undo", ["RT-169"]],
  ["nh-native-detach-group-undo", ["RT-170"]]
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
    const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
    const protectedExpectedNodeIds = [
      liveWindowNodeIdForRuntimeWindow(state, tab.windowId),
      liveTabNodeIdForRuntimeTab(state, tab.id)
    ];
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
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  context.nativeDeletedNodeIds.add(liveTabNodeIdForRuntimeTab(state, tab.id));
  context.history.push(`native close tab ${tab.id} with ${order}`);
  await closeTabFromBrowser(context.runtime, tab.id, order);
  await pruneMissingExpectedClosedNodes(context, []);
}

async function outlinerCloseGeneratedTab(context: GeneratedTraceContext): Promise<void> {
  const candidates = context.runtime.tabs.filter((tab) =>
    tabsInRuntimeWindow(context.runtime, tab.windowId).length > 1
  );
  const tab = pickOne(context.rng, candidates);
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const protectedExpectedNodeIds = [liveTabNodeIdForRuntimeTab(state, tab.id)];
  context.expectedClosedNodeIds.add(protectedExpectedNodeIds[0]!);
  context.history.push(`outliner close tab ${tab.id}`);
  await context.controller.handleMessage({ type: "closeNode", nodeId: protectedExpectedNodeIds[0]! });
  await pruneMissingExpectedClosedNodes(context, protectedExpectedNodeIds);
}

async function outlinerCloseGeneratedWindow(context: GeneratedTraceContext): Promise<void> {
  const windowInfo = pickOne(context.rng, context.runtime.windows);
  const tabs = tabsInRuntimeWindow(context.runtime, windowInfo.id);
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const protectedExpectedNodeIds = [
    liveWindowNodeIdForRuntimeWindow(state, windowInfo.id),
    ...tabs.map((tab) => liveTabNodeIdForRuntimeTab(state, tab.id))
  ];
  context.expectedClosedNodeIds.add(protectedExpectedNodeIds[0]!);
  for (const nodeId of protectedExpectedNodeIds.slice(1)) {
    context.expectedClosedNodeIds.add(nodeId);
  }
  context.history.push(`outliner close window ${windowInfo.id} with ${tabs.length} tabs`);
  await context.controller.handleMessage({ type: "closeNode", nodeId: protectedExpectedNodeIds[0]! });
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
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const protectedExpectedNodeIds = [
    liveWindowNodeIdForRuntimeWindow(state, windowInfo.id),
    ...tabs.map((tab) => liveTabNodeIdForRuntimeTab(state, tab.id))
  ];
  context.expectedClosedNodeIds.add(protectedExpectedNodeIds[0]!);
  for (const nodeId of protectedExpectedNodeIds.slice(1)) {
    context.expectedClosedNodeIds.add(nodeId);
  }
  context.history.push(`native close multi-tab window ${windowInfo.id}`);
  await closeRuntimeWindow(context.runtime, windowInfo.id, { awaitListeners: true });
  await pruneMissingExpectedClosedNodes(context, protectedExpectedNodeIds);
}

async function outlinerRestoreDeleteGeneratedWindowWithDelayedEvent(context: GeneratedTraceContext): Promise<void> {
  const windowInfo = pickOne(context.rng, context.runtime.windows);
  let state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const originalWindowNodeId = liveWindowNodeIdForRuntimeWindow(state, windowInfo.id);
  context.history.push(`outliner restore-delete window ${windowInfo.id} with delayed restored-tab event`);
  await context.controller.handleMessage({ type: "wrapNodeInGroup", nodeId: originalWindowNodeId });
  state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
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
    context.runtime.events.tabAttached.flush(),
    context.runtime.events.tabDetached.flush(),
    context.runtime.events.tabMoved.flush(),
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
  await assertDomainTraceAssertions(trace, context);

  for (let index = 0; index < trace.actions.length; index += 1) {
    const action = trace.actions[index]!;
    context.history.push(`action ${index + 1}: ${domainActionSummary(action)}`);
    try {
      await runDomainAction(context, action);
      await assertGeneratedInvariants(context);
      await assertDomainTraceAssertions(trace, context);
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
    now: options.now,
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

  if (action.type === "nativeOpenWindow") {
    await runDomainNativeOpenWindow(context, action);
    return;
  }

  if (action.type === "nativeMoveTabToWindow") {
    await runDomainNativeMoveTabToWindow(context, action);
    return;
  }

  if (action.type === "nativeMoveTabToNewWindow") {
    await runDomainNativeMoveTabToNewWindow(context, action);
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

  if (action.type === "outlinerGroupTabThenAbruptRestart") {
    await runDomainOutlinerGroupTabThenAbruptRestart(context, action.tab, action.captureStaleTabs);
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

  if (action.type === "outlinerMoveTabCommandToNewWindowThenAbruptRestart") {
    await runDomainOutlinerMoveTabCommandToNewWindowThenAbruptRestart(context, action.tab, action.captureStaleTabs);
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

  if (action.type === "outlinerMoveSubtreeToTopLevelThenAbruptRestart") {
    await runDomainOutlinerMoveSubtreeToTopLevelThenAbruptRestart(context, action.tab, action.captureStaleTabs);
    return;
  }

  if (action.type === "outlinerFocusTab") {
    await runDomainOutlinerFocusTab(context, action.tab);
    return;
  }

  if (action.type === "outlinerFocusTabRejectingUpdate") {
    await runDomainOutlinerFocusTabRejectingUpdate(context, action.tab);
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

  if (action.type === "outlinerCloseNodeRejectingClose") {
    await runDomainOutlinerCloseNodeRejectingClose(context, action.node);
    return;
  }

  if (action.type === "outlinerCloseNodeThenAbruptRestart") {
    await runDomainOutlinerCloseNodeThenAbruptRestart(context, action.node, action.captureStaleTabs);
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

  if (action.type === "outlinerDeleteNodeThenAbruptRestart") {
    await runDomainOutlinerDeleteNodeThenAbruptRestart(context, action.node, action.captureStaleTabs);
    return;
  }

  if (action.type === "outlinerRestoreDeleteWindowDelayedEvent") {
    await runDomainOutlinerRestoreDeleteWindowDelayedEvent(context, action.window, action.captureStaleTabs);
    return;
  }

  if (action.type === "outlinerRestoreNodeRejectingCreate") {
    await runDomainOutlinerRestoreNodeRejectingCreate(
      context,
      action.node,
      action.captureRestoredTabs,
      action.captureRestoredWindows
    );
    return;
  }

  if (action.type === "outlinerRestoreNodeThenAbruptRestart") {
    await runDomainOutlinerRestoreNodeThenAbruptRestart(
      context,
      action.node,
      action.captureRestoredTabs,
      action.captureRestoredWindows
    );
    return;
  }

  if (action.type === "injectCloseJournalThenAbruptRestart") {
    await runDomainInjectCloseJournalThenAbruptRestart(context, action.node);
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

  if (action.type === "restartBackground") {
    await runDomainRestartBackground(context);
    return;
  }

  if (action.type === "restartBackgroundAbrupt") {
    await runDomainRestartBackgroundAbrupt(context);
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

  if (action.type === "outlinerUndoThenAbruptRestart") {
    await runDomainHistoryCommandThenAbruptRestart(context, "undo");
    return;
  }

  if (action.type === "outlinerRedoThenAbruptRestart") {
    await runDomainHistoryCommandThenAbruptRestart(context, "redo");
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

async function runDomainRestartBackground(context: GeneratedTraceContext): Promise<void> {
  await flushGeneratedRuntimeEventRefreshes(context);
  await context.controller.flushPendingSaves();
  clearFakeRuntimeListeners(context.runtime);
  context.controller = createBackgroundController({
    api: context.runtime.api,
    now: () => context.now
  });
  await context.controller.ensureState();
}

async function runDomainRestartBackgroundAbrupt(context: GeneratedTraceContext): Promise<void> {
  clearFakeRuntimeListeners(context.runtime);
  context.controller = createBackgroundController({
    api: context.runtime.api,
    now: () => context.now
  });
  await context.controller.ensureState();
}

function clearFakeRuntimeListeners(runtime: FakeRuntime): void {
  runtime.events.installed.clearListeners();
  runtime.events.installed.clearPending();
  runtime.events.startup.clearListeners();
  runtime.events.startup.clearPending();
  runtime.events.alarm.clearListeners();
  runtime.events.alarm.clearPending();
  runtime.events.tabCreated.clearListeners();
  runtime.events.tabCreated.clearPending();
  runtime.events.tabActivated.clearListeners();
  runtime.events.tabActivated.clearPending();
  runtime.events.tabUpdated.clearListeners();
  runtime.events.tabUpdated.clearPending();
  runtime.events.tabRemoved.clearListeners();
  runtime.events.tabRemoved.clearPending();
  runtime.events.windowFocusChanged.clearListeners();
  runtime.events.windowFocusChanged.clearPending();
  runtime.events.windowRemoved.clearListeners();
  runtime.events.windowRemoved.clearPending();
  runtime.events.sessionChanged.clearListeners();
  runtime.events.sessionChanged.clearPending();
  runtime.events.command.clearListeners();
  runtime.events.command.clearPending();
  runtime.events.storageChanged.clearListeners();
  runtime.events.storageChanged.clearPending();
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
    const changes: Partial<RuntimeTab> = {};
    if (action.title !== undefined) {
      changes.title = action.title;
    }
    if (action.url !== undefined) {
      changes.url = action.url;
    }
    if (action.favIconUrl !== undefined) {
      changes.favIconUrl = action.favIconUrl;
    }
    if (Object.keys(changes).length === 0) {
      changes.title = `${tab.title ?? "Domain"} updated`;
    }
    await updateTabFromBrowser(context.runtime, tab.id, changes, { awaitListeners: options.awaitListeners });
    return;
  }

  const windowInfo = resolveDomainWindow(context, action.window);
  if (options.awaitListeners) {
    await focusWindowFromBrowser(context.runtime, windowInfo.id);
  } else {
    dispatchWindowFocusedFromBrowser(context.runtime, windowInfo.id);
  }
}

async function runDomainNativeOpenWindow(
  context: GeneratedTraceContext,
  action: Extract<DomainAction, { type: "nativeOpenWindow" }>
): Promise<void> {
  const windowId = nextRuntimeWindowId(context.runtime);
  const focused = action.focused ?? true;
  context.runtime.windows = context.runtime.windows
    .map((windowInfo) => ({
      ...windowInfo,
      ...(focused ? { focused: false } : {})
    }))
    .concat({ id: windowId, focused, incognito: false });

  const activeIndex = Math.max(0, action.tabs.findIndex((tab) => tab.active));
  const createdTabs = action.tabs.map((tab, index): RuntimeTab => {
    const tabId = nextGeneratedTabId(context);
    const openerTab = tab.openerTab ? resolveDomainTab(context, tab.openerTab) : undefined;
    return {
      id: tabId,
      windowId,
      index,
      active: index === activeIndex,
      url: tab.url ?? `https://native.example/${tabId}`,
      title: tab.title ?? `Native ${tabId}`,
      ...(openerTab ? { openerTabId: openerTab.id } : {})
    };
  });
  context.runtime.tabs = [...context.runtime.tabs, ...createdTabs.map(copyTab)];
  reindexWindowTabs(context.runtime, windowId);
  context.lastOpenedWindowId = windowId;
  if (createdTabs[0]) {
    context.lastOpenedTabId = createdTabs[0].id;
  }
  captureRuntimeWindow(context, action.captureWindow, windowId);
  captureRuntimeTabs(context, action.captureTabs, createdTabs);

  for (const tab of createdTabs) {
    await context.runtime.events.tabCreated.emit(copyTab(tab));
  }
  if (focused) {
    await context.runtime.events.windowFocusChanged.emit(windowId);
  }
  await flushGeneratedRuntimeEventRefreshes(context);
}

async function runDomainNativeMoveTabToWindow(
  context: GeneratedTraceContext,
  action: Extract<DomainAction, { type: "nativeMoveTabToWindow" }>
): Promise<void> {
  const tab = resolveDomainTab(context, action.tab);
  const destination = resolveDomainWindow(context, action.window);
  await runNativeMoveTab(context, tab, {
    targetWindowId: destination.id,
    index: action.index,
    active: action.active,
    captureStaleTabs: action.captureStaleTabs
  });
}

async function runDomainNativeMoveTabToNewWindow(
  context: GeneratedTraceContext,
  action: Extract<DomainAction, { type: "nativeMoveTabToNewWindow" }>
): Promise<void> {
  const tab = resolveDomainTab(context, action.tab);
  const windowId = nextRuntimeWindowId(context.runtime);
  context.runtime.windows = context.runtime.windows
    .map((windowInfo) => ({
      ...windowInfo,
      ...((action.active ?? true) ? { focused: false } : {})
    }))
    .concat({ id: windowId, focused: action.active ?? true, incognito: false });
  captureRuntimeWindow(context, action.captureWindow, windowId);
  context.lastOpenedWindowId = windowId;
  await runNativeMoveTab(context, tab, {
    targetWindowId: windowId,
    index: 0,
    active: action.active ?? true,
    captureStaleTabs: action.captureStaleTabs
  });
}

async function runNativeMoveTab(
  context: GeneratedTraceContext,
  tab: RuntimeTab,
  options: {
    targetWindowId: number;
    index?: number;
    active?: boolean;
    captureStaleTabs?: string;
  }
): Promise<void> {
  const sourceWindowId = tab.windowId;
  const sourceIndex = tab.index;
  const staleTabs = tabsInRuntimeWindow(context.runtime, sourceWindowId).filter((candidate) => candidate.id === tab.id);
  captureStaleRuntimeTabs(context, options.captureStaleTabs, staleTabs);
  context.staleLiveEventTabs.push(...staleTabs.map(copyTab));

  const destinationTabs = tabsInRuntimeWindow(context.runtime, options.targetWindowId);
  const movedTabs = moveTabsFromBrowser(context.runtime, [tab.id], {
    windowId: options.targetWindowId,
    index: options.index ?? destinationTabs.length
  });
  const moved = movedTabs[0];
  if (!moved) {
    throw new Error(`Native move could not find runtime tab ${tab.id}`);
  }

  applyNativeMoveActiveState(context.runtime, moved.id, sourceWindowId, options.targetWindowId, options.active ?? moved.active);
  const currentMoved = runtimeTabById(context, moved.id);
  context.lastMovedTabId = currentMoved.id;
  context.lastOpenedWindowId = currentMoved.windowId;

  if (sourceWindowId !== currentMoved.windowId) {
    await context.runtime.events.tabDetached.emit(currentMoved.id, {
      oldWindowId: sourceWindowId,
      oldPosition: sourceIndex
    });
    await context.runtime.events.tabAttached.emit(currentMoved.id, {
      newWindowId: currentMoved.windowId,
      newPosition: currentMoved.index
    });
  } else if (sourceIndex !== currentMoved.index) {
    await context.runtime.events.tabMoved.emit(currentMoved.id, {
      windowId: currentMoved.windowId,
      fromIndex: sourceIndex,
      toIndex: currentMoved.index
    });
  }
  if (!context.runtime.windows.some((windowInfo) => windowInfo.id === sourceWindowId)) {
    await context.runtime.events.windowRemoved.emit(sourceWindowId);
  }
  await context.runtime.events.tabUpdated.emit(currentMoved.id, { title: currentMoved.title }, copyTab(currentMoved));
  if (currentMoved.active) {
    await context.runtime.events.windowFocusChanged.emit(currentMoved.windowId);
    await context.runtime.events.tabActivated.emit({
      tabId: currentMoved.id,
      windowId: currentMoved.windowId
    });
  }
  await flushGeneratedRuntimeEventRefreshes(context);
}

function applyNativeMoveActiveState(
  runtime: FakeRuntime,
  movedTabId: number,
  sourceWindowId: number,
  destinationWindowId: number,
  active: boolean
): void {
  runtime.tabs = runtime.tabs.map((candidate) => {
    if (candidate.id === movedTabId) {
      return { ...candidate, active };
    }
    if (active && candidate.windowId === destinationWindowId) {
      return { ...candidate, active: false };
    }
    return copyTab(candidate);
  });
  ensureWindowHasActiveTab(runtime, sourceWindowId);
  ensureWindowHasActiveTab(runtime, destinationWindowId);
  if (active) {
    runtime.windows = runtime.windows.map((windowInfo) => ({
      ...windowInfo,
      focused: windowInfo.id === destinationWindowId
    }));
  }
}

function ensureWindowHasActiveTab(runtime: FakeRuntime, windowId: number): void {
  const tabs = tabsInRuntimeWindow(runtime, windowId);
  if (tabs.length === 0 || tabs.some((tab) => tab.active)) {
    return;
  }
  const firstTabId = tabs[0]!.id;
  runtime.tabs = runtime.tabs.map((tab) => tab.windowId === windowId
    ? { ...tab, active: tab.id === firstTabId }
    : copyTab(tab));
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

async function runDomainOutlinerGroupTabThenAbruptRestart(
  context: GeneratedTraceContext,
  selector: DomainTabSelector,
  captureStaleTabs?: string
): Promise<void> {
  const tab = resolveDomainTab(context, selector);
  const candidate = await domainCommandCandidateForTab(context, tab.id);
  captureStaleRuntimeTabs(context, captureStaleTabs, candidate.staleTabs);
  context.staleLiveEventTabs.push(...candidate.staleTabs);
  const result = await context.controller.handleMessage({
    type: "wrapNodeInGroup",
    nodeId: candidate.nodeId
  });
  expectCommandAck(result, true);
  captureMovedTab(context, tab.id);
  await runDomainRestartBackgroundAbrupt(context);
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

async function runDomainOutlinerMoveTabCommandToNewWindowThenAbruptRestart(
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
  await runDomainRestartBackgroundAbrupt(context);
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

async function runDomainOutlinerMoveSubtreeToTopLevelThenAbruptRestart(
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
  await runDomainRestartBackgroundAbrupt(context);
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
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const result = await context.controller.handleMessage({
    type: "focusNode",
    nodeId: liveTabNodeIdForRuntimeTab(state, tab.id)
  });
  expectCommandAck(result, false);
  await flushGeneratedRuntimeEventRefreshes(context);
}

async function runDomainOutlinerFocusTabRejectingUpdate(
  context: GeneratedTraceContext,
  selector: DomainTabSelector
): Promise<void> {
  const tab = resolveDomainTab(context, selector);
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  vi.mocked(context.runtime.api.tabs.update).mockImplementationOnce(async (tabId, updateProperties = {}) => {
    await updateTabFromBrowser(context.runtime, tabId, updateProperties as Partial<RuntimeTab>, { awaitListeners: false });
    throw new Error("domain focus tab update rejected after completion");
  });
  try {
    const result = await context.controller.handleMessage({
      type: "focusNode",
      nodeId: liveTabNodeIdForRuntimeTab(state, tab.id)
    });
    expect((result as CommandAck).type).toBe("commandAck");
  } catch {
    // The breadth action models a browser side effect that completes before the command rejects.
  }
  await flushGeneratedRuntimeEventRefreshes(context);
}

async function runDomainOutlinerCloseWindow(
  context: GeneratedTraceContext,
  selector: DomainWindowSelector
): Promise<void> {
  const windowInfo = resolveDomainWindow(context, selector);
  const tabs = tabsInRuntimeWindow(context.runtime, windowInfo.id);
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const protectedExpectedNodeIds = [
    liveWindowNodeIdForRuntimeWindow(state, windowInfo.id),
    ...tabs.map((tab) => liveTabNodeIdForRuntimeTab(state, tab.id))
  ];
  context.expectedClosedNodeIds.add(protectedExpectedNodeIds[0]!);
  for (const nodeId of protectedExpectedNodeIds.slice(1)) {
    context.expectedClosedNodeIds.add(nodeId);
  }
  await context.controller.handleMessage({ type: "closeNode", nodeId: protectedExpectedNodeIds[0]! });
  await pruneMissingExpectedClosedNodes(context, protectedExpectedNodeIds);
}

async function runDomainOutlinerCloseTab(
  context: GeneratedTraceContext,
  selector: DomainTabSelector
): Promise<void> {
  const tab = resolveDomainTab(context, selector);
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const nodeId = liveTabNodeIdForRuntimeTab(state, tab.id);
  context.expectedClosedNodeIds.add(nodeId);
  await context.controller.handleMessage({ type: "closeNode", nodeId });
  await flushGeneratedCloseEvents(context);
  await pruneMissingExpectedClosedNodes(context, [nodeId]);
}

async function runDomainOutlinerCloseNodeRejectingClose(
  context: GeneratedTraceContext,
  selector: DomainNodeSelector
): Promise<void> {
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const nodeId = resolveDomainNodeId(context, state, selector);
  const protectedExpectedNodeIds = expectedClosedNodeIdsForOutlinerCloseNode(state, nodeId);
  for (const protectedNodeId of protectedExpectedNodeIds) {
    context.expectedClosedNodeIds.add(protectedNodeId);
  }

  vi.mocked(context.runtime.api.windows.remove).mockImplementationOnce(async (windowId) => {
    await closeRuntimeWindow(context.runtime, windowId, { awaitListeners: false });
    throw new Error("domain close window rejected after completion");
  });
  vi.mocked(context.runtime.api.tabs.remove).mockImplementationOnce(async (tabIds) => {
    for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
      await closeRuntimeTab(context.runtime, tabId, "tabRemovedThenSessionChanged", { awaitListeners: false });
    }
    throw new Error("domain close tab rejected after completion");
  });

  try {
    const result = await context.controller.handleMessage({ type: "closeNode", nodeId });
    expect((result as CommandAck).type).toBe("commandAck");
  } catch {
    // The post-recovery hunt models an outliner close side effect that completes before the command rejects.
  }
  await flushGeneratedCloseEvents(context);
  await pruneMissingExpectedClosedNodes(context, protectedExpectedNodeIds);
}

async function runDomainOutlinerCloseNodeThenAbruptRestart(
  context: GeneratedTraceContext,
  selector: DomainNodeSelector,
  captureStaleTabs?: string
): Promise<void> {
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const nodeId = resolveDomainNodeId(context, state, selector);
  captureStaleRuntimeTabs(context, captureStaleTabs, staleRuntimeTabsForDomainNode(context, state, nodeId));
  const protectedExpectedNodeIds = expectedClosedNodeIdsForOutlinerCloseNode(state, nodeId);
  for (const protectedNodeId of protectedExpectedNodeIds) {
    context.expectedClosedNodeIds.add(protectedNodeId);
  }

  const result = await context.controller.handleMessage({ type: "closeNode", nodeId });
  expect((result as CommandAck).type).toBe("commandAck");
  await runDomainRestartBackgroundAbrupt(context);
  await pruneMissingExpectedClosedNodes(context, protectedExpectedNodeIds);
}

function expectedClosedNodeIdsForOutlinerCloseNode(state: OutlineState, nodeId: NodeId): NodeId[] {
  const node = state.nodes[nodeId];
  if (!node) {
    return [];
  }

  if (node.kind === "tab" && node.status === "live") {
    return [node.id];
  }

  if (node.kind === "window" && node.status === "live" && node.live && "windowId" in node.live) {
    return generatedSubtreeNodeIds(state, nodeId).filter((candidateId) => {
      const candidate = state.nodes[candidateId];
      if (!candidate) {
        return false;
      }
      if (candidate.id === node.id) {
        return true;
      }
      return candidate.kind === "tab" &&
        candidate.status === "live" &&
        candidate.live &&
        "windowId" in candidate.live &&
        candidate.live.windowId === node.live.windowId;
    });
  }

  return generatedSubtreeNodeIds(state, nodeId)
    .filter((candidateId) => state.nodes[candidateId]?.status === "live");
}

function staleRuntimeTabsForDomainNode(
  context: GeneratedTraceContext,
  state: OutlineState,
  nodeId: NodeId
): RuntimeTab[] {
  return generatedSubtreeNodeIds(state, nodeId).flatMap((candidateId) => {
    const node = state.nodes[candidateId];
    if (node?.kind !== "tab" || node.status !== "live" || !node.live || !("tabId" in node.live)) {
      return [];
    }
    const tab = context.runtime.tabs.find((candidate) => candidate.id === node.live.tabId);
    return tab ? [copyTab(tab)] : [];
  });
}

function runtimeClosePlanForDomainNode(
  context: GeneratedTraceContext,
  state: OutlineState,
  nodeId: NodeId
): { tabIds: number[]; windowIds: number[] } {
  const tabIds = new Set<number>();
  const windowIds = new Set<number>();
  for (const candidateId of generatedSubtreeNodeIds(state, nodeId)) {
    const node = state.nodes[candidateId];
    if (node?.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live) {
      tabIds.add(node.live.tabId);
    }
    if (node?.kind === "window" && node.status === "live" && node.live && "windowId" in node.live) {
      windowIds.add(node.live.windowId);
      for (const tab of tabsInRuntimeWindow(context.runtime, node.live.windowId)) {
        tabIds.add(tab.id);
      }
    }
  }
  return {
    tabIds: [...tabIds],
    windowIds: [...windowIds]
  };
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

async function runDomainOutlinerDeleteNodeThenAbruptRestart(
  context: GeneratedTraceContext,
  selector: DomainNodeSelector,
  captureStaleTabs?: string
): Promise<void> {
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const nodeId = resolveDomainNodeId(context, state, selector);
  captureStaleRuntimeTabs(context, captureStaleTabs, staleRuntimeTabsForDomainNode(context, state, nodeId));
  const deletedNodeIds = generatedSubtreeNodeIds(state, nodeId);

  const result = await context.controller.handleMessage({ type: "deleteNode", nodeId });
  expectCommandAck(result, true);
  markCommandDeletedNodes(context, deletedNodeIds);
  await runDomainRestartBackgroundAbrupt(context);
  await pruneMissingExpectedClosedNodes(context, []);
}

async function runDomainOutlinerRestoreDeleteWindowDelayedEvent(
  context: GeneratedTraceContext,
  selector: DomainWindowSelector,
  captureStaleTabs?: string
): Promise<void> {
  const windowInfo = resolveDomainWindow(context, selector);
  let state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const originalWindowNodeId = liveWindowNodeIdForRuntimeWindow(state, windowInfo.id);
  await context.controller.handleMessage({ type: "wrapNodeInGroup", nodeId: originalWindowNodeId });
  state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
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

async function runDomainOutlinerRestoreNodeRejectingCreate(
  context: GeneratedTraceContext,
  selector: DomainNodeSelector,
  captureRestoredTabs?: string,
  captureRestoredWindows?: string
): Promise<void> {
  const before = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const nodeId = resolveDomainNodeId(context, before, selector);
  const candidateNodeIds = new Set(generatedSubtreeNodeIds(before, nodeId));
  const node = before.nodes[nodeId];
  const shouldMockTabCreate = node?.kind !== "window";
  const shouldMockWindowCreate = node?.kind !== "tab";
  if (shouldMockTabCreate) {
    vi.mocked(context.runtime.api.tabs.create).mockImplementationOnce(async (createProperties) => {
      const windowId =
        createProperties.windowId ??
        context.runtime.windows.find((windowInfo) => windowInfo.focused)?.id ??
        context.runtime.windows[0]?.id;
      if (typeof windowId !== "number") {
        throw new Error("Cannot create a rejecting restore tab without a window");
      }
      const tab: RuntimeTab = {
        id: nextRuntimeTabId(context.runtime),
        windowId,
        index: tabsInRuntimeWindow(context.runtime, windowId).length,
        active: createProperties.active ?? true,
        url: createProperties.url,
        title: createProperties.url
      };
      await createTabFromBrowser(context.runtime, tab, { awaitListeners: false });
      throw new Error("domain restore tab create rejected after completion");
    });
  }
  if (shouldMockWindowCreate) {
    vi.mocked(context.runtime.api.windows.create).mockImplementationOnce(async (createData = {}) => {
      createWindowFromBrowser(context.runtime, createData as FakeWindowCreateData);
      throw new Error("domain restore window create rejected after completion");
    });
  }
  try {
    const result = await context.controller.handleMessage({ type: "restoreNode", nodeId });
    expect((result as CommandAck).type).toBe("commandAck");
  } catch {
    // The breadth action models a browser create/restore side effect that completes before the command rejects.
  }
  const after = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  captureRestoredRuntimeResources(context, before, after, candidateNodeIds, {
    tabs: captureRestoredTabs,
    windows: captureRestoredWindows
  });
  trackRestoreCommandLifecycleExpectations(context, before, after);
  await flushGeneratedRuntimeEventRefreshes(context);
}

async function runDomainOutlinerRestoreNodeThenAbruptRestart(
  context: GeneratedTraceContext,
  selector: DomainNodeSelector,
  captureRestoredTabs?: string,
  captureRestoredWindows?: string
): Promise<void> {
  const before = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const nodeId = resolveDomainNodeId(context, before, selector);
  const candidateNodeIds = new Set(generatedSubtreeNodeIds(before, nodeId));

  const result = await context.controller.handleMessage({ type: "restoreNode", nodeId });
  expect((result as CommandAck).type).toBe("commandAck");
  const after = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  captureRestoredRuntimeResources(context, before, after, candidateNodeIds, {
    tabs: captureRestoredTabs,
    windows: captureRestoredWindows
  });
  trackRestoreCommandLifecycleExpectations(context, before, after);
  await runDomainRestartBackgroundAbrupt(context);
}

async function runDomainInjectCloseJournalThenAbruptRestart(
  context: GeneratedTraceContext,
  selector: DomainNodeSelector
): Promise<void> {
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const nodeId = resolveDomainNodeId(context, state, selector);
  const plan = runtimeClosePlanForDomainNode(context, state, nodeId);
  await context.runtime.api.storage.local.set({
    [RUNTIME_LIFECYCLE_JOURNAL_KEY]: {
      version: 1,
      entries: [
        {
          version: 1,
          id: `domain-journal:${nodeId}`,
          createdAt: context.now,
          kind: "closeNode",
          nodeId,
          plan
        }
      ]
    }
  });
  await runDomainRestartBackgroundAbrupt(context);
}

function captureRestoredRuntimeResources(
  context: GeneratedTraceContext,
  before: OutlineState,
  after: OutlineState,
  candidateNodeIds: ReadonlySet<NodeId>,
  captures: { tabs?: string; windows?: string }
): void {
  const restoredTabs: RuntimeTab[] = [];
  const restoredWindows: FakeRuntimeWindow[] = [];
  for (const nodeId of candidateNodeIds) {
    const beforeNode = before.nodes[nodeId];
    const afterNode = after.nodes[nodeId];
    if (beforeNode?.status !== "closed" || afterNode?.status !== "live") {
      continue;
    }
    if (afterNode.kind === "tab" && afterNode.live && "tabId" in afterNode.live) {
      const tab = context.runtime.tabs.find((candidate) => candidate.id === afterNode.live.tabId);
      if (tab) {
        restoredTabs.push(copyTab(tab));
      }
    }
    if (afterNode.kind === "window" && afterNode.live && "windowId" in afterNode.live) {
      const windowInfo = context.runtime.windows.find((candidate) => candidate.id === afterNode.live.windowId);
      if (windowInfo) {
        restoredWindows.push({ ...windowInfo });
      }
    }
  }

  if (captures.tabs && restoredTabs.length > 0) {
    context.domainCaptures.staleTabs.set(captures.tabs, restoredTabs.map(copyTab));
    context.domainCaptures.tabs.set(captures.tabs, copyTab(restoredTabs[0]!));
    context.lastOpenedTabId = restoredTabs[0]!.id;
  }
  if (captures.windows && restoredWindows.length > 0) {
    context.domainCaptures.windows.set(captures.windows, { ...restoredWindows[0]! });
    context.lastOpenedWindowId = restoredWindows[0]!.id;
  }
}

function trackRestoreCommandLifecycleExpectations(
  context: GeneratedTraceContext,
  before: OutlineState,
  after: OutlineState
): void {
  for (const nodeId of [...context.expectedClosedNodeIds]) {
    if (before.nodes[nodeId]?.status === "closed" && after.nodes[nodeId]?.status === "live") {
      context.expectedClosedNodeIds.delete(nodeId);
    }
  }

  for (const nodeId of [...context.commandDeletedNodeIds]) {
    if (after.nodes[nodeId]) {
      context.commandDeletedNodeIds.delete(nodeId);
    }
  }
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

async function runDomainHistoryCommandThenAbruptRestart(
  context: GeneratedTraceContext,
  type: "undo" | "redo"
): Promise<void> {
  const before = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const result = await context.controller.handleMessage({ type });
  expect((result as CommandAck).type).toBe("commandAck");
  const after = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  trackHistoryCommandLifecycleExpectations(context, before, after);
  await runDomainRestartBackgroundAbrupt(context);
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
    const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
    const protectedExpectedNodeIds = [
      liveWindowNodeIdForRuntimeWindow(state, tab.windowId),
      liveTabNodeIdForRuntimeTab(state, tab.id)
    ];
    context.expectedClosedNodeIds.add(protectedExpectedNodeIds[0]!);
    context.expectedClosedNodeIds.add(protectedExpectedNodeIds[1]!);
    await closeRuntimeTab(context.runtime, tab.id, order, { awaitListeners: true });
    await pruneMissingExpectedClosedNodes(context, protectedExpectedNodeIds);
    return;
  }

  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  context.nativeDeletedNodeIds.add(liveTabNodeIdForRuntimeTab(state, tab.id));
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
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const protectedExpectedNodeIds = [
    liveWindowNodeIdForRuntimeWindow(state, windowInfo.id),
    ...tabs.map((tab) => liveTabNodeIdForRuntimeTab(state, tab.id))
  ];
  context.expectedClosedNodeIds.add(protectedExpectedNodeIds[0]!);
  for (const nodeId of protectedExpectedNodeIds.slice(1)) {
    context.expectedClosedNodeIds.add(nodeId);
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

function captureRuntimeWindow(
  context: GeneratedTraceContext,
  captureName: string | undefined,
  windowId: number
): void {
  if (!captureName) {
    return;
  }
  context.domainCaptures.windows.set(captureName, { ...runtimeWindowById(context, windowId) });
}

function captureRuntimeTabs(
  context: GeneratedTraceContext,
  captureName: string | undefined,
  tabs: RuntimeTab[]
): void {
  if (!captureName || tabs.length === 0) {
    return;
  }
  const copiedTabs = tabs.map(copyTab);
  context.domainCaptures.staleTabs.set(captureName, copiedTabs);
  context.domainCaptures.tabs.set(captureName, copiedTabs[0]!);
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

async function assertDomainTraceAssertions(trace: RuntimeDomainTrace, context: GeneratedTraceContext): Promise<void> {
  if (!trace.assertions || trace.assertions.length === 0) {
    return;
  }

  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  if (trace.assertions.includes("runtimeOrder")) {
    assertRuntimeOrderAssertion(state, context);
  }
  if (trace.assertions.includes("runtimeMetadata")) {
    assertRuntimeMetadataAssertion(state, context);
  }
}

function assertRuntimeOrderAssertion(state: OutlineState, context: GeneratedTraceContext): void {
  for (const runtimeWindow of context.runtime.windows) {
    const windowNode = liveWindowNodeForRuntimeWindow(state, runtimeWindow.id);
    invariant(Boolean(windowNode), `runtime-order window ${runtimeWindow.id} has no live node`, context.history);
    if (!windowNode) {
      continue;
    }

    const outlineTabIds = liveRuntimeTabIdsInOutlineWindowPreorder(state, windowNode.id);
    const runtimeTabIds = tabsInRuntimeWindow(context.runtime, runtimeWindow.id).map((tab) => tab.id);
    invariantEqual(
      outlineTabIds,
      runtimeTabIds,
      `runtime tab order for window ${runtimeWindow.id} matches outline preorder`,
      context.history
    );
  }
}

function liveRuntimeTabIdsInOutlineWindowPreorder(state: OutlineState, windowNodeId: string): number[] {
  return generatedSubtreeNodeIds(state, windowNodeId).flatMap((nodeId) => {
    const node = state.nodes[nodeId];
    if (
      !node ||
      node.kind !== "tab" ||
      node.status !== "live" ||
      !node.live ||
      !("tabId" in node.live) ||
      nearestWindowNode(state, node.id)?.id !== windowNodeId
    ) {
      return [];
    }
    return [node.live.tabId];
  });
}

function assertRuntimeMetadataAssertion(state: OutlineState, context: GeneratedTraceContext): void {
  for (const runtimeTab of context.runtime.tabs) {
    const node = liveTabNodeForRuntimeTab(state, runtimeTab.id);
    invariant(Boolean(node), `runtime-metadata tab ${runtimeTab.id} has no live node`, context.history);
    if (!node) {
      continue;
    }

    if (runtimeTab.title || runtimeTab.url) {
      const expectedTitle = runtimeTitleForOutlineTab(node, runtimeTab, {
        restoredFromClosed: node.restoredFromClosed === true
      });
      invariant(node.title === expectedTitle, `tab ${runtimeTab.id} title metadata diverged`, context.history);
    }
    if (runtimeTab.url !== undefined) {
      invariant(node.url === runtimeTab.url, `tab ${runtimeTab.id} url metadata diverged`, context.history);
    }
    if (runtimeTab.favIconUrl !== undefined) {
      invariant(node.favIconUrl === runtimeTab.favIconUrl, `tab ${runtimeTab.id} favicon metadata diverged`, context.history);
    }
  }
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

function liveTabNodeIdForRuntimeTab(state: OutlineState, tabId: number): string {
  return liveTabNodeForRuntimeTab(state, tabId)?.id ?? tabNodeIdFor(tabId);
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

function liveWindowNodeIdForRuntimeWindow(state: OutlineState, windowId: number): string {
  return liveWindowNodeForRuntimeWindow(state, windowId)?.id ?? windowNodeIdFor(windowId);
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
    await controller.flushPendingSaves();
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
    await controller.flushPendingSaves();
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

  it("deletes restored tabs when they are closed through browser chrome", async () => {
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
    expect(state.nodes["tab:2"]).toBeUndefined();
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:1"]);
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

    await controller.flushPendingSaves();
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
    expect(storageSetCallsExcludingLifecycleJournal(runtime)).toHaveLength(1);
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

  it("recovers a closed-tab restore when tabs.create succeeds before rejecting", async () => {
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
    await runtime.events.tabRemoved.flush();
    await runtime.events.sessionChanged.flush();

    vi.mocked(runtime.api.tabs.create).mockImplementationOnce(async (createProperties) => {
      const tab: RuntimeTab = {
        id: 22,
        windowId: createProperties.windowId ?? 10,
        index: 1,
        active: createProperties.active ?? true,
        url: createProperties.url,
        title: "Recovered"
      };
      await createTabFromBrowser(runtime, tab, { awaitListeners: false });
      throw new Error("tabs.create rejected after side effect");
    });

    const result = await controller.handleMessage({ type: "restoreNode", nodeId: "tab:2" });
    await runtime.events.tabCreated.flush();
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expectCommandAck(result, true);
    expect(state.nodes["tab:2"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.live).toEqual({ tabId: 22, windowId: 10 });
    expect(
      Object.values(state.nodes)
        .filter((node) => node.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live && node.live.tabId === 22)
        .map((node) => node.id)
    ).toEqual(["tab:2"]);
  });

  it("recovers a closed-window restore when windows.create succeeds before rejecting", async () => {
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
    await controller.handleMessage({ type: "closeNode", nodeId: "window:20" });
    await Promise.all([
      runtime.events.tabCreated.flush(),
      runtime.events.tabUpdated.flush(),
      runtime.events.tabActivated.flush(),
      runtime.events.windowFocusChanged.flush(),
      runtime.events.tabRemoved.flush(),
      runtime.events.windowRemoved.flush(),
      runtime.events.sessionChanged.flush()
    ]);

    vi.mocked(runtime.api.windows.create).mockImplementationOnce(async (createData = {}) => {
      createWindowFromBrowser(runtime, createData as FakeWindowCreateData);
      throw new Error("windows.create rejected after side effect");
    });

    const result = await controller.handleMessage({ type: "restoreNode", nodeId: "window:20" });
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expectCommandAck(result, true);
    expect(state.nodes["window:20"]?.status).toBe("live");
    expect(state.nodes["window:20"]?.live).toEqual({ windowId: 21 });
    expect(state.nodes["tab:2"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: 21 });
    expect(state.nodes["tab:2"]?.active).toBe(true);
  });

  it("keeps restart-reconstructed restore tombstones clear after create rejection recovery", async () => {
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
    let controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.handleMessage({ type: "closeNode", nodeId: "tab:2" });
    await runtime.events.tabRemoved.flush();
    await runtime.events.sessionChanged.flush();
    await controller.flushPendingSaves();
    clearFakeRuntimeListeners(runtime);
    controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();

    vi.mocked(runtime.api.tabs.create).mockImplementationOnce(async (createProperties) => {
      const tab: RuntimeTab = {
        id: 2,
        windowId: createProperties.windowId ?? 10,
        index: 1,
        active: createProperties.active ?? true,
        url: createProperties.url,
        title: "Recovered after restart"
      };
      await createTabFromBrowser(runtime, tab, { awaitListeners: false });
      throw new Error("tabs.create rejected after restart side effect");
    });

    expectCommandAck(await controller.handleMessage({ type: "restoreNode", nodeId: "tab:2" }), true);
    expectCommandAck(await controller.handleMessage({ type: "refresh" }), false);
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expect(state.nodes["tab:2"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: 10 });
    expect(liveTabIds(state)).toEqual([1, 2]);
  });

  it("recovers tab restore create rejection after redo closes the tab again", async () => {
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
    await runtime.events.tabRemoved.flush();
    await runtime.events.sessionChanged.flush();
    await controller.handleMessage({ type: "undo" });
    await controller.handleMessage({ type: "redo" });

    vi.mocked(runtime.api.tabs.create).mockImplementationOnce(async (createProperties) => {
      const tab: RuntimeTab = {
        id: 22,
        windowId: createProperties.windowId ?? 10,
        index: 1,
        active: createProperties.active ?? true,
        url: createProperties.url,
        title: "Recovered after redo"
      };
      await createTabFromBrowser(runtime, tab, { awaitListeners: false });
      throw new Error("tabs.create rejected after redo side effect");
    });

    expectCommandAck(await controller.handleMessage({ type: "restoreNode", nodeId: "tab:2" }), true);
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expect(state.nodes["tab:2"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.live).toEqual({ tabId: 22, windowId: 10 });
  });

  it("rejects restore create failures when no browser side effect is detectable", async () => {
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
    await runtime.events.tabRemoved.flush();
    await runtime.events.sessionChanged.flush();
    vi.mocked(runtime.api.tabs.create).mockImplementationOnce(async () => {
      throw new Error("tabs.create rejected before side effect");
    });

    await expect(controller.handleMessage({ type: "restoreNode", nodeId: "tab:2" })).rejects.toThrow(
      "tabs.create rejected before side effect"
    );
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expect(state.nodes["tab:2"]?.status).toBe("closed");
    expect(runtime.tabs.map((tab) => tab.id).sort((left, right) => left - right)).toEqual([1]);
  });

  it("recovers an outliner tab close when tabs.remove succeeds before rejecting", async () => {
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
    vi.mocked(runtime.api.tabs.remove).mockImplementationOnce(async (tabIds) => {
      for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
        await closeRuntimeTab(runtime, tabId, "tabRemovedThenSessionChanged", { awaitListeners: false });
      }
      throw new Error("tabs.remove rejected after close side effect");
    });

    expectCommandAck(await controller.handleMessage({ type: "closeNode", nodeId: "tab:2" }), true);

    let state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(runtime.tabs.map((tab) => tab.id)).toEqual([1]);
    expect(state.nodes["tab:2"]?.status).toBe("closed");
    expect(state.nodes["tab:2"]?.live).toBeUndefined();
    await runtime.events.tabRemoved.flush();
    await runtime.events.sessionChanged.flush();
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:2"]?.status).toBe("closed");
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:2"]);
  });

  it("recovers an outliner window close when windows.remove succeeds before rejecting", async () => {
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
    vi.mocked(runtime.api.windows.remove).mockImplementationOnce(async (windowId) => {
      await closeRuntimeWindow(runtime, windowId, { awaitListeners: false });
      throw new Error("windows.remove rejected after close side effect");
    });

    expectCommandAck(await controller.handleMessage({ type: "closeNode", nodeId: "window:20" }), true);

    let state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(runtime.windows.map((windowInfo) => windowInfo.id)).toEqual([10]);
    expect(runtime.tabs.map((tab) => tab.id)).toEqual([1]);
    expect(state.nodes["window:20"]?.status).toBe("closed");
    expect(state.nodes["tab:2"]?.status).toBe("closed");
    await Promise.all([
      runtime.events.tabCreated.flush(),
      runtime.events.tabUpdated.flush(),
      runtime.events.tabActivated.flush(),
      runtime.events.windowFocusChanged.flush(),
      runtime.events.tabRemoved.flush(),
      runtime.events.windowRemoved.flush(),
      runtime.events.sessionChanged.flush()
    ]);
    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["window:20"]?.status).toBe("closed");
    expect(state.nodes["tab:2"]?.status).toBe("closed");
  });

  it("recovers an outliner tab close across abrupt restart before events or saves flush", async () => {
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
    let controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.flushPendingSaves();
    vi.mocked(runtime.api.storage.local.set).mockClear();
    vi.mocked(runtime.api.tabs.remove).mockImplementationOnce(async (tabIds) => {
      for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
        removeRuntimeTabWithoutEvents(runtime, tabId);
      }
    });

    expectCommandAck(await controller.handleMessage({ type: "closeNode", nodeId: "tab:2" }), false);

    controller = restartControllerAbrupt(runtime);
    const state = await controller.ensureState();

    expect(state.nodes["tab:2"]?.status).toBe("closed");
    expect(state.nodes["tab:2"]?.live).toBeUndefined();
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:2"]);
  });

  it("recovers an outliner window close across abrupt restart before events or saves flush", async () => {
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
    let controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.flushPendingSaves();
    vi.mocked(runtime.api.windows.remove).mockImplementationOnce(async (windowId) => {
      removeRuntimeWindowWithoutEvents(runtime, windowId);
    });

    expectCommandAck(await controller.handleMessage({ type: "closeNode", nodeId: "window:20" }), false);

    controller = restartControllerAbrupt(runtime);
    const state = await controller.ensureState();

    expect(state.nodes["window:20"]?.status).toBe("closed");
    expect(state.nodes["tab:2"]?.status).toBe("closed");
    expect(state.nodes["window:20"]?.live).toBeUndefined();
    expect(state.rootIds).toEqual(["window:10", "window:20"]);
  });

  it("aborts lifecycle commands before browser side effects when journal persistence fails", async () => {
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
    await controller.flushPendingSaves();
    const storageSet = vi.mocked(runtime.api.storage.local.set);
    const defaultSet = storageSet.getMockImplementation();
    vi.mocked(runtime.api.tabs.remove).mockClear();
    storageSet.mockImplementationOnce(async (items: Record<string, unknown>) => {
      if (RUNTIME_LIFECYCLE_JOURNAL_KEY in items) {
        throw new Error("journal write failed");
      }
      await defaultSet?.(items);
    });

    await expect(controller.handleMessage({ type: "closeNode", nodeId: "tab:2" })).rejects.toThrow(
      "journal write failed"
    );

    expect(runtime.api.tabs.remove).not.toHaveBeenCalled();
    expect(runtime.tabs.map((tab) => tab.id)).toEqual([1, 2]);
  });

  it("does not preserve browser-native tab disappearance across abrupt restart without a journal", async () => {
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
    let controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.flushPendingSaves();

    removeRuntimeTabWithoutEvents(runtime, 2);
    controller = restartControllerAbrupt(runtime);
    const state = await controller.ensureState();

    expect(state.nodes["tab:2"]).toBeUndefined();
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:1"]);
  });

  it("clears a lifecycle journal entry without mutation when runtime evidence does not confirm it", async () => {
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
    let controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.flushPendingSaves();
    await runtime.api.storage.local.set({
      [RUNTIME_LIFECYCLE_JOURNAL_KEY]: {
        version: 1,
        entries: [
          {
            version: 1,
            id: "journal:no-side-effect",
            createdAt: 1000,
            kind: "closeNode",
            nodeId: "tab:2",
            plan: { tabIds: [2], windowIds: [] }
          }
        ]
      }
    });
    vi.mocked(runtime.api.storage.local.remove).mockClear();

    controller = restartControllerAbrupt(runtime);
    const state = await controller.ensureState();
    await waitForMacrotask();

    expect(state.nodes["tab:2"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: 10 });
    expect(runtime.api.storage.local.remove).toHaveBeenCalledWith(RUNTIME_LIFECYCLE_JOURNAL_KEY);
  });

  it("clears a lifecycle journal entry without duplicating work when persisted state already reflects it", async () => {
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
    let controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.handleMessage({ type: "closeNode", nodeId: "tab:2" });
    await runtime.events.tabRemoved.flush();
    await runtime.events.sessionChanged.flush();
    await controller.flushPendingSaves();
    await runtime.api.storage.local.set({
      [RUNTIME_LIFECYCLE_JOURNAL_KEY]: {
        version: 1,
        entries: [
          {
            version: 1,
            id: "journal:already-persisted",
            createdAt: 1000,
            kind: "closeNode",
            nodeId: "tab:2",
            plan: { tabIds: [2], windowIds: [] }
          }
        ]
      }
    });
    vi.mocked(runtime.api.storage.local.remove).mockClear();

    controller = restartControllerAbrupt(runtime);
    const state = await controller.ensureState();
    await waitForMacrotask();

    expect(state.nodes["tab:2"]?.status).toBe("closed");
    expect(state.nodes["window:10"]?.childIds.filter((nodeId) => nodeId === "tab:2")).toHaveLength(1);
    expect(runtime.api.storage.local.remove).toHaveBeenCalledWith(RUNTIME_LIFECYCLE_JOURNAL_KEY);
  });

  it("recovers a delete command across abrupt restart before state save", async () => {
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
    let controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.flushPendingSaves();
    vi.mocked(runtime.api.tabs.remove).mockImplementationOnce(async (tabIds) => {
      for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
        removeRuntimeTabWithoutEvents(runtime, tabId);
      }
    });

    expectCommandAck(await controller.handleMessage({ type: "deleteNode", nodeId: "tab:2" }), true);

    controller = restartControllerAbrupt(runtime);
    const state = await controller.ensureState();

    expect(state.nodes["tab:2"]).toBeUndefined();
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:1"]);
  });

  it("recovers a restore create side effect across abrupt restart before state save", async () => {
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
    let controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.handleMessage({ type: "closeNode", nodeId: "tab:2" });
    await runtime.events.tabRemoved.flush();
    await runtime.events.sessionChanged.flush();
    await controller.flushPendingSaves();
    vi.mocked(runtime.api.tabs.create).mockImplementationOnce(async (createProperties) => {
      const windowId = createProperties.windowId ?? 10;
      const tab: RuntimeTab = {
        id: nextRuntimeTabId(runtime),
        windowId,
        index: runtime.tabs.filter((candidate) => candidate.windowId === windowId).length,
        active: createProperties.active ?? true,
        url: createProperties.url,
        title: createProperties.url
      };
      runtime.tabs.push(tab);
      reindexWindowTabs(runtime, windowId);
      return copyTab(tab);
    });

    expectCommandAck(await controller.handleMessage({ type: "restoreNode", nodeId: "tab:2" }), true);

    controller = restartControllerAbrupt(runtime);
    const state = await controller.ensureState();

    expect(state.nodes["tab:2"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: 10 });
    expect(state.nodes["tab:2"]?.title).toBe("Two");
  });

  it("recovers a restored window create side effect across abrupt restart before state save", async () => {
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
    let controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.handleMessage({ type: "closeNode", nodeId: "window:20" });
    await runtime.events.tabRemoved.flush();
    await runtime.events.windowRemoved.flush();
    await runtime.events.sessionChanged.flush();
    await controller.flushPendingSaves();

    expectCommandAck(await controller.handleMessage({ type: "restoreNode", nodeId: "window:20" }), true);

    controller = restartControllerAbrupt(runtime);
    const state = await controller.ensureState();

    const restoredWindowId = state.nodes["window:20"]?.live?.windowId;
    expect(restoredWindowId).toBe(21);
    expect(state.nodes["window:20"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: restoredWindowId });
  });

  it("recovers a grouping relocation across abrupt restart before state save", async () => {
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
    let controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    await controller.flushPendingSaves();

    expectCommandAck(await controller.handleMessage({ type: "wrapNodeInGroup", nodeId: "tab:1" }), true);

    controller = restartControllerAbrupt(runtime);
    const state = await controller.ensureState();

    expect(state.rootIds).toEqual(["window:10"]);
    expect(state.nodes["window:10"]?.childIds).toEqual(["window:11", "tab:2"]);
    expect(state.nodes["window:11"]?.childIds).toEqual(["tab:1"]);
    expect(state.nodes["tab:1"]?.live).toEqual({ tabId: 1, windowId: 11 });
  });

  it("recovers undo history replay across abrupt restart before state and history save", async () => {
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
    let controller = createBackgroundController({ api: runtime.api, now: () => 1000 });
    await controller.ensureState();
    expectCommandAck(await controller.handleMessage({ type: "deleteNode", nodeId: "tab:2" }), true);
    await runtime.events.tabRemoved.flush();
    await runtime.events.sessionChanged.flush();
    await controller.flushPendingSaves();
    vi.mocked(runtime.api.tabs.create).mockImplementationOnce(async (createProperties) => {
      const windowId = createProperties.windowId ?? 10;
      const tab: RuntimeTab = {
        id: nextRuntimeTabId(runtime),
        windowId,
        index: runtime.tabs.filter((candidate) => candidate.windowId === windowId).length,
        active: createProperties.active ?? true,
        url: createProperties.url,
        title: createProperties.url
      };
      runtime.tabs.push(tab);
      reindexWindowTabs(runtime, windowId);
      return copyTab(tab);
    });

    expectCommandAck(await controller.handleMessage({ type: "undo" }), true);

    controller = restartControllerAbrupt(runtime);
    const state = await controller.ensureState();
    const historyStatus = await controller.handleMessage({ type: "getHistoryStatus" });

    expect(state.nodes["tab:2"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: 10 });
    expect(historyStatus).toMatchObject({
      type: "historyStatus",
      canUndo: false,
      canRedo: true,
      redoLabel: "Delete"
    });
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
    expect(storageSetCallsExcludingLifecycleJournal(runtime)).toHaveLength(1);
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

    await controller.flushPendingSaves();
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
    expect(storageSetCallsExcludingLifecycleJournal(runtime)).toHaveLength(1);
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

    await controller.flushPendingSaves();
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
    await controller.flushPendingSaves();
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
    expect(storageSetCallsExcludingLifecycleJournal(runtime)).toHaveLength(1);
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
    await controller.flushPendingSaves();
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
    expect(storageSetCallsExcludingLifecycleJournal(runtime)).toHaveLength(1);
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

    await controller.flushPendingSaves();
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
    expect(storageSetCallsExcludingLifecycleJournal(runtime)).toHaveLength(1);
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

  it("removes restored single-tab window shells when their only restored tab is deleted", async () => {
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
    await runtime.events.tabRemoved.flush();
    await runtime.events.windowRemoved.flush();
    await runtime.events.sessionChanged.flush();
    await controller.handleMessage({ type: "restoreNode", nodeId: "window:20" });

    let state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["window:20"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.status).toBe("live");
    const restoredWindowId = state.nodes["window:20"]?.live?.windowId;
    const restoredTabId = state.nodes["tab:2"]?.live?.tabId;
    expect(typeof restoredWindowId).toBe("number");
    expect(typeof restoredTabId).toBe("number");
    expect(state.nodes["tab:2"]?.live?.windowId).toBe(restoredWindowId);

    expectCommandAck(await controller.handleMessage({ type: "deleteNode", nodeId: "tab:2" }), true);

    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:2"]).toBeUndefined();
    expect(state.nodes["window:20"]).toBeUndefined();
    expect(runtime.windows.map((windowInfo) => windowInfo.id)).toEqual([10]);
    expect(runtime.tabs.map((tab) => tab.id)).toEqual([1]);
    const deletePatch = runtime.broadcasts
      .filter((message): message is { type: string; deletedNodeIds: NodeId[] } =>
        Boolean(message && typeof message === "object" && (message as { type?: unknown }).type === "treeStructureUpdated")
      )
      .at(-1);
    expect(deletePatch?.deletedNodeIds).toEqual(expect.arrayContaining(["tab:2", "window:20"]));

    await runtime.events.tabRemoved.flush();
    await runtime.events.windowRemoved.flush();
    await runtime.events.sessionChanged.flush();

    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:2"]).toBeUndefined();
    expect(state.nodes["window:20"]).toBeUndefined();
    expect(state.nodes["window:42"]).toBeUndefined();
    expect(state.nodes["tab:22"]).toBeUndefined();
  });

  it("removes restored single-tab windows when the restored window node is deleted", async () => {
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

    await controller.handleMessage({ type: "closeNode", nodeId: "window:20" });
    await runtime.events.tabRemoved.flush();
    await runtime.events.windowRemoved.flush();
    await runtime.events.sessionChanged.flush();
    await controller.handleMessage({ type: "restoreNode", nodeId: "window:20" });

    let state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["window:20"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.status).toBe("live");

    expectCommandAck(await controller.handleMessage({ type: "deleteNode", nodeId: "window:20" }), true);

    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["window:20"]).toBeUndefined();
    expect(state.nodes["tab:2"]).toBeUndefined();
    const deletePatch = runtime.broadcasts
      .filter((message): message is { type: string; deletedNodeIds: NodeId[] } =>
        Boolean(message && typeof message === "object" && (message as { type?: unknown }).type === "treeStructureUpdated")
      )
      .at(-1);
    expect(deletePatch?.deletedNodeIds).toEqual(expect.arrayContaining(["window:20", "tab:2"]));

    await runtime.events.tabRemoved.flush();
    await runtime.events.windowRemoved.flush();
    await runtime.events.sessionChanged.flush();

    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["window:20"]).toBeUndefined();
    expect(state.nodes["tab:2"]).toBeUndefined();
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
    runtime.windows = [];
    const result = await controller.handleMessage({ type: "refresh" });
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

    expectCommandAck(result, true);
    expect(state.nodes["window:10"]?.status).toBe("closed");
    expect(state.nodes["tab:1"]?.status).toBe("closed");
    expect(state.nodes["tab:1"]?.live).toBeUndefined();
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
    await controller.flushPendingSaves();
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
    await controller.flushPendingSaves();
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
    expect(storageSetCallsExcludingLifecycleJournal(runtime)).toHaveLength(1);
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
    expect(storageSetCallsExcludingLifecycleJournal(runtime)).toHaveLength(1);
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
    await controller.flushPendingSaves();
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
    expect(storageSetCallsExcludingLifecycleJournal(runtime)).toHaveLength(1);
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
    await controller.flushPendingSaves();
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
    expect(storageSetCallsExcludingLifecycleJournal(runtime)).toHaveLength(1);
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
