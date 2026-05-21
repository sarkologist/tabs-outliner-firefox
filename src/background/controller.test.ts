import { describe, expect, it, vi } from "vitest";

import type { BrowserAdapter } from "./adapter.js";
import {
  AUTOMATIC_BACKUP_ALARM_NAME,
  AUTOMATIC_BACKUP_STATUS_STORAGE_KEY
} from "./backups.js";
import { createBackgroundController } from "./controller.js";
import type { CommandAck } from "./commands.js";
import { HISTORY_KEY, STATE_KEY, loadStateV2, outlineStateV2Items } from "./storage.js";
import { PORTABLE_TREE_SCHEMA } from "../model/portable-tree.js";
import type { OutlineState, RuntimeTab, RuntimeWindow } from "../model/types.js";
import { APP_PREFERENCES_STORAGE_KEY, DEFAULT_APP_PREFERENCES } from "../preferences.js";

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

  runtime.tabs = runtime.tabs.filter((candidate) => candidate.id !== tabId);
  reindexWindowTabs(runtime, tab.windowId);

  const emit = async (): Promise<void> => {
    const tabRemoved = (): Promise<void> | void => fireEvent(runtime.events.tabRemoved, options.awaitListeners, tabId, {
      windowId: tab.windowId,
      isWindowClosing: !runtime.windows.some((windowInfo) => windowInfo.id === tab.windowId)
    });
    const sessionChanged = (): Promise<void> | void => fireEvent(runtime.events.sessionChanged, options.awaitListeners);

    if (order === "tabRemovedThenSessionChanged") {
      await tabRemoved();
      await sessionChanged();
    } else if (order === "sessionChangedThenTabRemoved") {
      await sessionChanged();
      await tabRemoved();
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

async function closeRuntimeWindow(
  runtime: FakeRuntime,
  windowId: number,
  options: { awaitListeners: boolean }
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
    for (const tab of removedTabs) {
      await fireEvent(runtime.events.tabRemoved, options.awaitListeners, tab.id, {
        windowId,
        isWindowClosing: true
      });
    }
    await fireEvent(runtime.events.windowRemoved, options.awaitListeners, windowId);
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
  return Math.max(0, ...runtime.windows.map((windowInfo) => windowInfo.id)) + 1;
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
  history: string[];
  nativeDeletedNodeIds: Set<string>;
  expectedClosedNodeIds: Set<string>;
  staleTabs: RuntimeTab[];
  staleLiveEventTabs: RuntimeTab[];
  adversarialRuntimeQueries: boolean;
  rng: () => number;
};

type GeneratedTraceOptions = {
  adversarialRuntimeQueries?: boolean;
};

type GeneratedOperation = {
  name: string;
  run(context: GeneratedTraceContext): Promise<void>;
};

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

  return operations;
}

async function openGeneratedTab(context: GeneratedTraceContext): Promise<void> {
  const windowInfo = pickOne(context.rng, context.runtime.windows);
  const existingTabs = tabsInRuntimeWindow(context.runtime, windowInfo.id);
  const openerTab = existingTabs.length > 0 && context.rng() < 0.75
    ? pickOne(context.rng, existingTabs)
    : undefined;
  const tabId = context.nextTabId++;
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
    context.nativeDeletedNodeIds.add(tabNodeIdFor(tab.id));
    context.history.push(`native close last tab ${tab.id} in window ${tab.windowId}`);
    await closeRuntimeWindow(context.runtime, tab.windowId, { awaitListeners: true });
    const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
    const windowNodeId = windowNodeIdFor(tab.windowId);
    if (state.nodes[windowNodeId]) {
      context.expectedClosedNodeIds.add(windowNodeId);
      await pruneMissingExpectedClosedNodes(context, [windowNodeId]);
    } else {
      context.nativeDeletedNodeIds.add(windowNodeId);
      await pruneMissingExpectedClosedNodes(context, []);
    }
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

function snapshotReplacingTab(tabs: RuntimeTab[], replacement: RuntimeTab): RuntimeTab[] {
  const replaced = tabs.map((tab) => tab.id === replacement.id ? copyTab(replacement) : copyTab(tab));
  return replaced.some((tab) => tab.id === replacement.id)
    ? replaced
    : [...replaced, copyTab(replacement)];
}

function snapshotMissingTab(tabs: RuntimeTab[], tabId: number): RuntimeTab[] {
  return tabs.filter((tab) => tab.id !== tabId).map(copyTab);
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

async function runGeneratedTrace(seed: number, steps: number, options: GeneratedTraceOptions = {}): Promise<void> {
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
  const controller = createBackgroundController({ api: runtime.api, now: () => seed * 1000 });
  const context: GeneratedTraceContext = {
    runtime,
    controller,
    nextTabId: 100,
    history: [`seed ${seed}`],
    nativeDeletedNodeIds: new Set(),
    expectedClosedNodeIds: new Set(),
    staleTabs: [],
    staleLiveEventTabs: [],
    adversarialRuntimeQueries: options.adversarialRuntimeQueries ?? false,
    rng: seededRandom(seed)
  };

  await controller.ensureState();
  await assertGeneratedInvariants(context);

  for (let step = 0; step < steps; step += 1) {
    const operations = availableGeneratedOperations(context);
    if (operations.length === 0) {
      break;
    }

    const operation = pickOne(context.rng, operations);
    context.history.push(`step ${step + 1}: ${operation.name}`);
    await operation.run(context);
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
    history: [],
    nativeDeletedNodeIds: new Set(),
    expectedClosedNodeIds: new Set(),
    staleTabs: [],
    staleLiveEventTabs: [],
    adversarialRuntimeQueries: false,
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

  for (const nodeId of context.expectedClosedNodeIds) {
    if (context.nativeDeletedNodeIds.has(nodeId)) {
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
    await controller.ensureState();
    runtime.broadcasts.length = 0;
    vi.mocked(runtime.api.storage.local.set).mockClear();

    await updateTabFromBrowser(runtime, 2, {
      title: "Two updated",
      url: "https://two.example/updated"
    });
    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;

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
    await controller.ensureState();
    vi.mocked(runtime.api.tabs.query).mockClear();
    vi.mocked(runtime.api.windows.getAll).mockClear();
    vi.mocked(runtime.api.storage.local.set).mockClear();
    runtime.broadcasts.length = 0;

    const result = await controller.handleMessage({ type: "focusNode", nodeId: "tab:2" });
    await runtime.events.tabUpdated.flush();
    await runtime.events.windowFocusChanged.flush();
    await runtime.events.tabActivated.emit({ tabId: 2, windowId: 10, previousTabId: 1 });

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    const lastBroadcast = runtime.broadcasts.at(-1) as
      | { type?: string; updates?: Array<{ nodeId: string; active: boolean }> }
      | undefined;
    expectCommandAck(result, false);
    expect(state.nodes["tab:1"]?.active).toBe(false);
    expect(state.nodes["tab:2"]?.active).toBe(true);
    expect(runtime.api.tabs.query).not.toHaveBeenCalled();
    expect(runtime.api.windows.getAll).not.toHaveBeenCalled();
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
    for (let seed = 1; seed <= 24; seed += 1) {
      await runGeneratedTrace(seed, 32);
    }
  });

  it("preserves invariants across adversarial runtime query skew traces", async () => {
    for (let seed = 101; seed <= 112; seed += 1) {
      await runGeneratedTrace(seed, 40, { adversarialRuntimeQueries: true });
    }
  });

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
    expect(state.nodes["tab:5"]?.live).toEqual({
      tabId: 2,
      windowId: 11
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
      live: { tabId: 2, windowId: 11 }
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

  it("deletes a single-tab window when Firefox reports a native tab close as window-closing", async () => {
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
    expect(state.nodes["window:20"]).toBeUndefined();
    expect(state.nodes["tab:2"]).toBeUndefined();
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

    expectCommandAck(await controller.handleMessage({ type: "wrapNodeInGroup", nodeId: "tab:1" }), true);
    let state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
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
