import type { OutlineNode, OutlineState, RuntimeTab, RuntimeWindow, RuntimeWindowState } from "../model/types.js";

type Listener<TArgs extends unknown[]> = (...args: TArgs) => unknown | Promise<unknown>;

export class FakeWebExtensionEvent<TArgs extends unknown[]> {
  private listeners: Listener<TArgs>[] = [];
  private pending: PromiseLike<unknown>[] = [];

  addListener(listener: Listener<TArgs>): void {
    this.listeners.push(listener);
  }

  removeListener(listener: Listener<TArgs>): void {
    this.listeners = this.listeners.filter((candidate) => candidate !== listener);
  }

  async emit(...args: TArgs): Promise<void> {
    this.dispatch(...args);
    await this.flush();
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

  async emitFirst(...args: TArgs): Promise<unknown> {
    const results: unknown[] = [];
    for (const listener of this.listeners) {
      try {
        results.push(await listener(...args));
      } catch (error) {
        await Promise.reject(error);
      }
    }
    return results.find((result) => result !== undefined);
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

  clear(): void {
    this.listeners = [];
    this.pending = [];
  }

  private track(result: unknown): void {
    if (isPromiseLike(result)) {
      this.pending.push(result);
    }
  }
}

type FakeAlarm = {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
};

type StorageChange = {
  oldValue?: unknown;
  newValue?: unknown;
};

type FakeWindowType = "normal" | "popup" | "panel";

type FakeRuntimeWindow = RuntimeWindow & {
  type?: FakeWindowType;
};

type FakeWindowCreateData = {
  url?: string | string[];
  tabId?: number;
  type?: FakeWindowType;
  state?: RuntimeWindowState;
  focused?: boolean;
};

type FakeRuntimeOptions = {
  initialStorage?: Record<string, unknown>;
  nextTabId?: number;
  nextWindowId?: number;
};

export type FakeRuntimeSideEffect = {
  kind: string;
  args: unknown[];
};

export type FakeRuntimeProtocolLog = {
  kind: "page.sendMessage" | "background.broadcast";
  message: unknown;
};

export type RuntimeModelInvariantReport = {
  duplicateLiveTabIds: number[];
  duplicateLiveWindowIds: number[];
  missingRuntimeTabIds: number[];
  staleLiveTabIds: number[];
  staleLiveWindowIds: number[];
};

export type FakeWebExtensionRuntime = {
  api: WebExtensionBrowser;
  events: {
    installed: FakeWebExtensionEvent<[]>;
    startup: FakeWebExtensionEvent<[]>;
    alarm: FakeWebExtensionEvent<[FakeAlarm]>;
    command: FakeWebExtensionEvent<[string]>;
    runtimeMessage: FakeWebExtensionEvent<[unknown, { tab?: RuntimeTab }]>;
    storageChanged: FakeWebExtensionEvent<[Record<string, StorageChange>, string]>;
    tabActivated: FakeWebExtensionEvent<[{ tabId: number; windowId: number; previousTabId?: number }]>;
    tabAttached: FakeWebExtensionEvent<[number, { newWindowId: number; newPosition: number }]>;
    tabCreated: FakeWebExtensionEvent<[RuntimeTab]>;
    tabDetached: FakeWebExtensionEvent<[number, { oldWindowId: number; oldPosition: number }]>;
    tabMoved: FakeWebExtensionEvent<[number, { windowId: number; fromIndex: number; toIndex: number }]>;
    tabRemoved: FakeWebExtensionEvent<[number, { windowId: number; isWindowClosing: boolean }]>;
    tabUpdated: FakeWebExtensionEvent<[number, Partial<RuntimeTab>, RuntimeTab]>;
    windowBoundsChanged: FakeWebExtensionEvent<[RuntimeWindow]>;
    windowFocusChanged: FakeWebExtensionEvent<[number]>;
    windowRemoved: FakeWebExtensionEvent<[number]>;
    sessionChanged: FakeWebExtensionEvent<[]>;
  };
  windows: FakeRuntimeWindow[];
  tabs: RuntimeTab[];
  sideEffects: FakeRuntimeSideEffect[];
  protocol: FakeRuntimeProtocolLog[];
  runtimeBroadcasts: unknown[];
  alarms: Map<string, FakeAlarm>;
  storageSnapshot(): Record<string, unknown>;
  setStorage(items: Record<string, unknown>): Promise<void>;
  addRuntimeBroadcastListener(listener: (message: unknown) => void | Promise<void>): () => void;
  addStorageChangeListener(
    listener: (changes: Record<string, StorageChange>, areaName: string) => void | Promise<void>
  ): () => void;
  sendMessageFromPage(message: unknown): Promise<unknown>;
  createTabFromBrowser(tab: Partial<RuntimeTab> & Pick<RuntimeTab, "windowId">): Promise<RuntimeTab>;
  updateTabFromBrowser(tabId: number, changes: Partial<RuntimeTab>): Promise<RuntimeTab | undefined>;
  activateTabFromBrowser(tabId: number): Promise<void>;
  moveTabFromBrowser(tabId: number, moveProperties: { windowId?: number; index: number }): Promise<RuntimeTab | undefined>;
  closeTabFromBrowser(tabId: number): Promise<void>;
  createWindowFromBrowser(createData?: FakeWindowCreateData): Promise<RuntimeWindow>;
  closeWindowFromBrowser(windowId: number): Promise<void>;
  runtimeTabOrder(windowId: number): number[];
  liveTabIds(): number[];
  liveWindowIds(): number[];
  invariantReport(state: OutlineState): RuntimeModelInvariantReport;
  assertRuntimeModelInvariants(state: OutlineState): void;
  flush(): Promise<void>;
};

export function createFakeWebExtensionRuntime(
  windows: RuntimeWindow[],
  tabs: RuntimeTab[],
  options: FakeRuntimeOptions = {}
): FakeWebExtensionRuntime {
  const installed = new FakeWebExtensionEvent<[]>();
  const startup = new FakeWebExtensionEvent<[]>();
  const alarm = new FakeWebExtensionEvent<[FakeAlarm]>();
  const command = new FakeWebExtensionEvent<[string]>();
  const runtimeMessage = new FakeWebExtensionEvent<[unknown, { tab?: RuntimeTab }]>();
  const storageChanged = new FakeWebExtensionEvent<[Record<string, StorageChange>, string]>();
  const tabActivated = new FakeWebExtensionEvent<[{ tabId: number; windowId: number; previousTabId?: number }]>();
  const tabAttached = new FakeWebExtensionEvent<[number, { newWindowId: number; newPosition: number }]>();
  const tabCreated = new FakeWebExtensionEvent<[RuntimeTab]>();
  const tabDetached = new FakeWebExtensionEvent<[number, { oldWindowId: number; oldPosition: number }]>();
  const tabMoved = new FakeWebExtensionEvent<[number, { windowId: number; fromIndex: number; toIndex: number }]>();
  const tabRemoved = new FakeWebExtensionEvent<[number, { windowId: number; isWindowClosing: boolean }]>();
  const tabUpdated = new FakeWebExtensionEvent<[number, Partial<RuntimeTab>, RuntimeTab]>();
  const windowBoundsChanged = new FakeWebExtensionEvent<[RuntimeWindow]>();
  const windowFocusChanged = new FakeWebExtensionEvent<[number]>();
  const windowRemoved = new FakeWebExtensionEvent<[number]>();
  const sessionChanged = new FakeWebExtensionEvent<[]>();

  const storage = new Map<string, unknown>(Object.entries(options.initialStorage ?? {}));
  const runtimeBroadcastListeners = new Set<(message: unknown) => void | Promise<void>>();
  const storageChangeListeners = new Set<
    (changes: Record<string, StorageChange>, areaName: string) => void | Promise<void>
  >();
  const alarms = new Map<string, FakeAlarm>();
  const sideEffects: FakeRuntimeSideEffect[] = [];
  const protocol: FakeRuntimeProtocolLog[] = [];
  const runtimeBroadcasts: unknown[] = [];

  let nextTabId = options.nextTabId ?? Math.max(0, ...tabs.map((tab) => tab.id)) + 1;
  let nextWindowId = options.nextWindowId ?? Math.max(0, ...windows.map((windowInfo) => windowInfo.id)) + 1;

  const runtime: FakeWebExtensionRuntime = {
    windows: windows.map((windowInfo) => ({
      ...copyWindowWithoutTabs(windowInfo),
      type: (windowInfo as FakeRuntimeWindow).type ?? "normal"
    })),
    tabs: tabs.map(copyTab),
    sideEffects,
    protocol,
    runtimeBroadcasts,
    alarms,
    events: {
      installed,
      startup,
      alarm,
      command,
      runtimeMessage,
      storageChanged,
      tabActivated,
      tabAttached,
      tabCreated,
      tabDetached,
      tabMoved,
      tabRemoved,
      tabUpdated,
      windowBoundsChanged,
      windowFocusChanged,
      windowRemoved,
      sessionChanged
    },
    api: undefined as unknown as WebExtensionBrowser,
    storageSnapshot: () => Object.fromEntries(storage),
    async setStorage(items) {
      await setStorageItems(items);
    },
    addRuntimeBroadcastListener(listener) {
      runtimeBroadcastListeners.add(listener);
      return () => runtimeBroadcastListeners.delete(listener);
    },
    addStorageChangeListener(listener) {
      storageChangeListeners.add(listener);
      return () => storageChangeListeners.delete(listener);
    },
    async sendMessageFromPage(message) {
      protocol.push({ kind: "page.sendMessage", message: clone(message) });
      return runtimeMessage.emitFirst(clone(message), {});
    },
    async createTabFromBrowser(tab) {
      const next = normalizeCreatedTab(runtime, {
        id: tab.id ?? nextTabId++,
        windowId: tab.windowId,
        index: tab.index ?? runtime.tabs.filter((candidate) => candidate.windowId === tab.windowId).length,
        active: tab.active ?? true,
        ...(tab.openerTabId !== undefined ? { openerTabId: tab.openerTabId } : {}),
        ...(tab.url !== undefined ? { url: tab.url } : {}),
        ...(tab.title !== undefined ? { title: tab.title } : {}),
        ...(tab.favIconUrl !== undefined ? { favIconUrl: tab.favIconUrl } : {}),
        ...(tab.incognito !== undefined ? { incognito: tab.incognito } : {})
      });
      await createTab(runtime, next, true);
      return copyTab(next);
    },
    async updateTabFromBrowser(tabId, changes) {
      return updateTab(runtime, tabId, changes, true);
    },
    async activateTabFromBrowser(tabId) {
      const tab = runtime.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) {
        return;
      }
      const previous = runtime.tabs.find((candidate) => candidate.windowId === tab.windowId && candidate.active);
      runtime.tabs = runtime.tabs.map((candidate) => candidate.windowId === tab.windowId
        ? { ...candidate, active: candidate.id === tabId }
        : copyTab(candidate));
      const activeInfo: { tabId: number; windowId: number; previousTabId?: number } = {
        tabId,
        windowId: tab.windowId
      };
      if (previous) {
        activeInfo.previousTabId = previous.id;
      }
      await tabActivated.emit(activeInfo);
    },
    async moveTabFromBrowser(tabId, moveProperties) {
      const tab = runtime.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) {
        return undefined;
      }
      const oldWindowId = tab.windowId;
      const oldPosition = tab.index;
      const targetWindowId = moveProperties.windowId ?? oldWindowId;
      const moved = moveTabs(runtime, [tabId], { windowId: targetWindowId, index: moveProperties.index })[0];
      if (!moved) {
        return undefined;
      }
      if (targetWindowId === oldWindowId) {
        await tabMoved.emit(tabId, { windowId: targetWindowId, fromIndex: oldPosition, toIndex: moved.index });
      } else {
        await tabDetached.emit(tabId, { oldWindowId, oldPosition });
        await tabAttached.emit(tabId, { newWindowId: targetWindowId, newPosition: moved.index });
      }
      return copyTab(moved);
    },
    async closeTabFromBrowser(tabId) {
      await closeTab(runtime, tabId, true);
    },
    async createWindowFromBrowser(createData = {}) {
      const windowInfo = createWindow(runtime, createData, () => nextWindowId++, () => nextTabId++);
      for (const tab of windowInfo.tabs ?? []) {
        await tabCreated.emit(copyTab(tab));
      }
      return windowInfo;
    },
    async closeWindowFromBrowser(windowId) {
      await closeWindow(runtime, windowId, true);
    },
    runtimeTabOrder(windowId) {
      return runtime.tabs
        .filter((tab) => tab.windowId === windowId)
        .sort((left, right) => left.index - right.index)
        .map((tab) => tab.id);
    },
    liveTabIds() {
      return runtime.tabs.map((tab) => tab.id).sort((left, right) => left - right);
    },
    liveWindowIds() {
      return runtime.windows.map((windowInfo) => windowInfo.id).sort((left, right) => left - right);
    },
    invariantReport(state) {
      return runtimeModelInvariantReport(state, runtime);
    },
    assertRuntimeModelInvariants(state) {
      const report = runtimeModelInvariantReport(state, runtime);
      const failures = Object.entries(report).filter(([, values]) => values.length > 0);
      if (failures.length > 0) {
        throw new Error(`Runtime/model invariant failure: ${JSON.stringify(report)}`);
      }
    },
    async flush() {
      for (const event of Object.values(runtime.events)) {
        await event.flush();
      }
    }
  };

  runtime.api = {
    action: {
      onClicked: new FakeWebExtensionEvent<[]>() as never
    },
    alarms: {
      create(name, alarmInfo = {}) {
        sideEffects.push({ kind: "alarms.create", args: [name, clone(alarmInfo)] });
        alarms.set(name, {
          name,
          scheduledTime: alarmInfo.when ??
            Date.now() + Math.max(0, alarmInfo.delayInMinutes ?? alarmInfo.periodInMinutes ?? 0) * 60 * 1000,
          ...(typeof alarmInfo.periodInMinutes === "number" ? { periodInMinutes: alarmInfo.periodInMinutes } : {})
        });
      },
      clear: async (name) => {
        sideEffects.push({ kind: "alarms.clear", args: [name] });
        return alarms.delete(name);
      },
      get: async (name) => alarms.get(name),
      onAlarm: alarm as never
    },
    sidebarAction: {
      open: async () => {
        sideEffects.push({ kind: "sidebarAction.open", args: [] });
      },
      toggle: async () => {
        sideEffects.push({ kind: "sidebarAction.toggle", args: [] });
      }
    },
    commands: {
      onCommand: command as never,
      getAll: async () => [],
      update: async (details) => {
        sideEffects.push({ kind: "commands.update", args: [clone(details)] });
      },
      reset: async (name) => {
        sideEffects.push({ kind: "commands.reset", args: [name] });
      }
    },
    runtime: {
      onInstalled: installed as never,
      onStartup: startup as never,
      onMessage: runtimeMessage as never,
      getURL: (path) => `moz-extension://extension-id/${path}`,
      openOptionsPage: async () => {
        sideEffects.push({ kind: "runtime.openOptionsPage", args: [] });
      },
      sendMessage: async (message) => {
        const payload = clone(message);
        protocol.push({ kind: "background.broadcast", message: payload });
        runtimeBroadcasts.push(payload);
        await Promise.all([...runtimeBroadcastListeners].map((listener) => listener(clone(payload))));
        return undefined;
      }
    },
    downloads: {
      download: async (options) => {
        sideEffects.push({ kind: "downloads.download", args: [clone(options)] });
        return sideEffects.filter((effect) => effect.kind === "downloads.download").length;
      }
    },
    storage: {
      onChanged: storageChanged as never,
      local: {
        get: async (key) => storageGet(storage, key),
        set: setStorageItems,
        remove: async (keys) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          const changes: Record<string, StorageChange> = {};
          for (const key of keyList) {
            if (storage.has(key)) {
              changes[key] = { oldValue: clone(storage.get(key)) };
            }
            storage.delete(key);
          }
          if (Object.keys(changes).length > 0) {
            await emitStorageChanged(changes);
          }
        }
      }
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getCurrent: async (getInfo = {}) => {
        const windows = matchingWindows(runtime, getInfo.windowTypes);
        const focused = windows.find((candidate) => candidate.focused) ?? windows[0];
        if (!focused) {
          throw new Error("Missing current window");
        }
        return windowForApi(runtime, focused, getInfo.populate);
      },
      get: async (windowId, getInfo = {}) => {
        const windowInfo = runtime.windows.find((candidate) => candidate.id === windowId);
        if (!windowInfo || !windowTypeAllowed(windowInfo, getInfo.windowTypes)) {
          throw new Error(`Missing window: ${windowId}`);
        }
        return windowForApi(runtime, windowInfo, getInfo.populate);
      },
      getAll: async (getInfo = {}) =>
        matchingWindows(runtime, getInfo.windowTypes).map((windowInfo) =>
          windowForApi(runtime, windowInfo, getInfo.populate)
        ),
      update: async (windowId, updateInfo) => {
        sideEffects.push({ kind: "windows.update", args: [windowId, clone(updateInfo)] });
        const windowInfo = runtime.windows.find((candidate) => candidate.id === windowId);
        if (!windowInfo) {
          throw new Error(`Missing window: ${windowId}`);
        }
        if (updateInfo.focused) {
          runtime.windows = runtime.windows.map((candidate) => ({
            ...candidate,
            focused: candidate.id === windowId
          }));
          windowFocusChanged.dispatch(windowId);
        }
        if (updateInfo.state) {
          windowInfo.state = updateInfo.state;
          windowBoundsChanged.dispatch(copyWindowWithoutTabs(windowInfo));
        }
        return windowForApi(runtime, windowInfo, false);
      },
      remove: async (windowId) => {
        sideEffects.push({ kind: "windows.remove", args: [windowId] });
        await closeWindow(runtime, windowId, false);
      },
      create: async (createData = {}) => {
        sideEffects.push({ kind: "windows.create", args: [clone(createData)] });
        return createWindow(runtime, createData, () => nextWindowId++, () => nextTabId++);
      },
      onFocusChanged: windowFocusChanged as never,
      onBoundsChanged: windowBoundsChanged as never,
      onRemoved: windowRemoved as never
    },
    tabs: {
      query: async (queryInfo = {}) =>
        runtime.tabs
          .filter((tab) => tabMatchesQuery(tab, queryInfo))
          .sort((left, right) => left.windowId - right.windowId || left.index - right.index)
          .map(copyTab),
      update: async (tabId, updateProperties = {}) => {
        sideEffects.push({ kind: "tabs.update", args: [tabId, clone(updateProperties)] });
        const updated = await updateTab(runtime, tabId, updateProperties, false);
        if (!updated) {
          throw new Error(`Missing tab: ${tabId}`);
        }
        return updated;
      },
      remove: async (tabId) => {
        const tabIds = Array.isArray(tabId) ? tabId : [tabId];
        sideEffects.push({ kind: "tabs.remove", args: [clone(tabIds)] });
        for (const currentTabId of tabIds) {
          await closeTab(runtime, currentTabId, false);
        }
      },
      create: async (createProperties) => {
        sideEffects.push({ kind: "tabs.create", args: [clone(createProperties)] });
        const tab = normalizeCreatedTab(runtime, {
          id: nextTabId++,
          windowId: createProperties.windowId ?? focusedWindowId(runtime),
          active: createProperties.active ?? true,
          url: createProperties.url,
          title: createProperties.url
        });
        await createTab(runtime, tab, false);
        return copyTab(tab);
      },
      move: async (tabIds, moveProperties) => {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        sideEffects.push({ kind: "tabs.move", args: [clone(ids), clone(moveProperties)] });
        const moved = moveTabs(runtime, ids, {
          windowId: moveProperties.windowId ?? runtime.tabs.find((tab) => tab.id === ids[0])?.windowId ?? focusedWindowId(runtime),
          index: moveProperties.index
        });
        return Array.isArray(tabIds) ? moved.map(copyTab) : copyTab(moved[0]!);
      },
      onActivated: tabActivated as never,
      onAttached: tabAttached as never,
      onCreated: tabCreated as never,
      onDetached: tabDetached as never,
      onMoved: tabMoved as never,
      onRemoved: tabRemoved as never,
      onUpdated: tabUpdated as never
    },
    sessions: {
      getRecentlyClosed: async () => [{ tab: { sessionId: "recent-session" } as RuntimeTab }],
      restore: async (sessionId) => {
        sideEffects.push({ kind: "sessions.restore", args: [sessionId] });
        const tab = normalizeCreatedTab(runtime, {
          id: nextTabId++,
          windowId: focusedWindowId(runtime),
          active: true,
          url: `about:restored-${sessionId}`,
          title: `Restored ${sessionId}`
        });
        await createTab(runtime, tab, false);
        return { tab };
      },
      onChanged: sessionChanged as never
    }
  };

  async function setStorageItems(items: Record<string, unknown>): Promise<void> {
    const changes: Record<string, StorageChange> = {};
    for (const [key, value] of Object.entries(items)) {
      changes[key] = {
        oldValue: clone(storage.get(key)),
        newValue: clone(value)
      };
      storage.set(key, clone(value));
    }
    if (Object.keys(changes).length > 0) {
      await emitStorageChanged(changes);
    }
  }

  async function emitStorageChanged(changes: Record<string, StorageChange>): Promise<void> {
    await storageChanged.emit(clone(changes), "local");
    await Promise.all([...storageChangeListeners].map((listener) => listener(clone(changes), "local")));
  }

  return runtime;
}

function storageGet(
  storage: Map<string, unknown>,
  key?: string | string[] | Record<string, unknown> | null
): Record<string, unknown> {
  if (typeof key === "string") {
    return storage.has(key) ? { [key]: clone(storage.get(key)) } : {};
  }
  if (Array.isArray(key)) {
    return Object.fromEntries(key.flatMap((entry) => storage.has(entry) ? [[entry, clone(storage.get(entry))]] : []));
  }
  if (key && typeof key === "object") {
    const result: Record<string, unknown> = {};
    for (const [entry, fallback] of Object.entries(key)) {
      result[entry] = storage.has(entry) ? clone(storage.get(entry)) : clone(fallback);
    }
    return result;
  }
  return Object.fromEntries([...storage.entries()].map(([entry, value]) => [entry, clone(value)]));
}

function windowForApi(runtime: FakeWebExtensionRuntime, windowInfo: FakeRuntimeWindow, populate?: boolean): RuntimeWindow {
  const windowCopy = copyWindowWithoutTabs(windowInfo);
  if (!populate) {
    return windowCopy;
  }
  return {
    ...windowCopy,
    tabs: runtime.tabs
      .filter((tab) => tab.windowId === windowInfo.id)
      .sort((left, right) => left.index - right.index)
      .map(copyTab)
  };
}

function matchingWindows(runtime: FakeWebExtensionRuntime, windowTypes?: string[]): FakeRuntimeWindow[] {
  return runtime.windows.filter((windowInfo) => windowTypeAllowed(windowInfo, windowTypes));
}

function windowTypeAllowed(windowInfo: FakeRuntimeWindow, windowTypes?: string[]): boolean {
  return new Set(windowTypes ?? ["normal", "popup", "panel"]).has(windowInfo.type ?? "normal");
}

function normalizeCreatedTab(
  runtime: FakeWebExtensionRuntime,
  // Historically callers may omit `index`; reindexWindowTabs assigns it after insertion.
  tab: Omit<RuntimeTab, "index"> & { index?: number }
): RuntimeTab {
  if (!runtime.windows.some((windowInfo) => windowInfo.id === tab.windowId)) {
    throw new Error(`Missing window for tab: ${tab.windowId}`);
  }
  return {
    ...tab,
    title: tab.title ?? tab.url ?? "Untitled",
    url: tab.url ?? "about:blank"
  } as RuntimeTab;
}

async function createTab(runtime: FakeWebExtensionRuntime, tab: RuntimeTab, awaitListeners: boolean): Promise<void> {
  insertTab(runtime, tab);
  await fire(runtime.events.tabCreated, awaitListeners, copyTab(tab));
}

async function updateTab(
  runtime: FakeWebExtensionRuntime,
  tabId: number,
  changes: Partial<RuntimeTab>,
  awaitListeners: boolean
): Promise<RuntimeTab | undefined> {
  const existing = runtime.tabs.find((candidate) => candidate.id === tabId);
  if (!existing) {
    return undefined;
  }
  if (changes.active) {
    runtime.tabs = runtime.tabs.map((candidate) => candidate.windowId === existing.windowId
      ? { ...candidate, active: candidate.id === tabId }
      : copyTab(candidate));
  }
  runtime.tabs = runtime.tabs.map((candidate) => candidate.id === tabId ? { ...candidate, ...changes } : candidate);
  const updated = runtime.tabs.find((candidate) => candidate.id === tabId);
  if (!updated) {
    return undefined;
  }
  await fire(runtime.events.tabUpdated, awaitListeners, tabId, clone(changes), copyTab(updated));
  return copyTab(updated);
}

function insertTab(runtime: FakeWebExtensionRuntime, tab: RuntimeTab): void {
  runtime.tabs = runtime.tabs.map((candidate) => candidate.windowId === tab.windowId
    ? {
        ...candidate,
        index: candidate.index >= tab.index ? candidate.index + 1 : candidate.index,
        ...(tab.active ? { active: false } : {})
      }
    : candidate);
  runtime.tabs.push(copyTab(tab));
  reindexWindowTabs(runtime, tab.windowId);
}

function moveTabs(
  runtime: FakeWebExtensionRuntime,
  tabIds: number[],
  moveProperties: { windowId: number; index: number }
): RuntimeTab[] {
  const moving = tabIds.flatMap((tabId) => {
    const tab = runtime.tabs.find((candidate) => candidate.id === tabId);
    return tab ? [copyTab(tab)] : [];
  });
  if (moving.length === 0) {
    return [];
  }
  const targetWindowId = moveProperties.windowId;
  const movingIds = new Set(moving.map((tab) => tab.id));
  const affectedWindowIds = new Set<number>([targetWindowId, ...moving.map((tab) => tab.windowId)]);
  const remaining = runtime.tabs.filter((tab) => !movingIds.has(tab.id));
  const targetTabs = remaining
    .filter((tab) => tab.windowId === targetWindowId)
    .sort((left, right) => left.index - right.index)
    .map(copyTab);
  const boundedIndex = Math.max(0, Math.min(moveProperties.index, targetTabs.length));
  targetTabs.splice(boundedIndex, 0, ...moving.map((tab) => ({ ...tab, windowId: targetWindowId })));
  const reindexedTargetTabs = targetTabs.map((tab, index) => ({ ...tab, index }));
  runtime.tabs = [
    ...remaining.filter((tab) => tab.windowId !== targetWindowId).map(copyTab),
    ...reindexedTargetTabs
  ];
  for (const windowId of [...affectedWindowIds].filter((windowId) => windowId !== targetWindowId)) {
    reindexWindowTabs(runtime, windowId);
  }
  removeEmptyRuntimeWindows(runtime, [...affectedWindowIds].filter((windowId) => windowId !== targetWindowId));
  return moving.map((tab) => copyTab(runtime.tabs.find((candidate) => candidate.id === tab.id)!));
}

async function closeTab(runtime: FakeWebExtensionRuntime, tabId: number, awaitListeners: boolean): Promise<void> {
  const tab = runtime.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) {
    return;
  }
  const windowWillBecomeEmpty = runtime.tabs.filter((candidate) => candidate.windowId === tab.windowId).length === 1;
  runtime.tabs = runtime.tabs.filter((candidate) => candidate.id !== tabId);
  reindexWindowTabs(runtime, tab.windowId);
  if (windowWillBecomeEmpty) {
    removeEmptyRuntimeWindows(runtime, [tab.windowId]);
  }
  await fire(runtime.events.tabRemoved, awaitListeners, tabId, {
    windowId: tab.windowId,
    isWindowClosing: windowWillBecomeEmpty
  });
  if (windowWillBecomeEmpty) {
    await fire(runtime.events.windowRemoved, awaitListeners, tab.windowId);
  }
  await fire(runtime.events.sessionChanged, awaitListeners);
}

async function closeWindow(runtime: FakeWebExtensionRuntime, windowId: number, awaitListeners: boolean): Promise<void> {
  const removedTabs = runtime.tabs
    .filter((tab) => tab.windowId === windowId)
    .sort((left, right) => left.index - right.index)
    .map(copyTab);
  runtime.tabs = runtime.tabs.filter((tab) => tab.windowId !== windowId);
  runtime.windows = runtime.windows.filter((windowInfo) => windowInfo.id !== windowId);
  for (const tab of removedTabs) {
    await fire(runtime.events.tabRemoved, awaitListeners, tab.id, { windowId, isWindowClosing: true });
  }
  await fire(runtime.events.windowRemoved, awaitListeners, windowId);
  await fire(runtime.events.sessionChanged, awaitListeners);
}

function createWindow(
  runtime: FakeWebExtensionRuntime,
  createData: FakeWindowCreateData,
  nextWindowId: () => number,
  nextTabId: () => number
): RuntimeWindow {
  const windowId = nextWindowId();
  runtime.windows = runtime.windows
    .map((windowInfo) => ({ ...windowInfo, focused: false }))
    .concat({
      id: windowId,
      focused: createData.focused ?? true,
      incognito: false,
      type: createData.type ?? "normal",
      ...(createData.state ? { state: createData.state } : {})
    });

  if (typeof createData.tabId === "number") {
    const moved = moveTabs(runtime, [createData.tabId], { windowId, index: 0 });
    return {
      id: windowId,
      focused: true,
      incognito: false,
      ...(createData.state ? { state: createData.state } : {}),
      tabs: moved.map(copyTab)
    };
  }

  const urls = Array.isArray(createData.url) ? createData.url : createData.url ? [createData.url] : [];
  const createdTabs = urls.map((url, index) => ({
    id: nextTabId(),
    windowId,
    index,
    active: index === 0,
    url,
    title: url
  }));
  runtime.tabs.push(...createdTabs.map(copyTab));
  return {
    id: windowId,
    focused: true,
    incognito: false,
    ...(createData.state ? { state: createData.state } : {}),
    tabs: createdTabs.map(copyTab)
  };
}

async function fire<TArgs extends unknown[]>(
  event: FakeWebExtensionEvent<TArgs>,
  awaitListeners: boolean,
  ...args: TArgs
): Promise<void> {
  if (awaitListeners) {
    await event.emit(...args);
    return;
  }
  event.dispatch(...args);
}

function reindexWindowTabs(runtime: FakeWebExtensionRuntime, windowId: number): void {
  const ordered = runtime.tabs
    .filter((tab) => tab.windowId === windowId)
    .sort((left, right) => left.index - right.index);
  ordered.forEach((tab, index) => {
    const runtimeTab = runtime.tabs.find((candidate) => candidate.id === tab.id);
    if (runtimeTab) {
      runtimeTab.index = index;
    }
  });
}

function removeEmptyRuntimeWindows(runtime: FakeWebExtensionRuntime, windowIds: number[]): void {
  const emptyWindowIds = new Set(
    windowIds.filter((windowId) => runtime.tabs.every((tab) => tab.windowId !== windowId))
  );
  if (emptyWindowIds.size === 0) {
    return;
  }
  runtime.windows = runtime.windows.filter((windowInfo) => !emptyWindowIds.has(windowInfo.id));
  if (!runtime.windows.some((windowInfo) => windowInfo.focused) && runtime.windows[0]) {
    runtime.windows = runtime.windows.map((windowInfo, index) => ({ ...windowInfo, focused: index === 0 }));
  }
}

function focusedWindowId(runtime: FakeWebExtensionRuntime): number {
  const windowId = runtime.windows.find((windowInfo) => windowInfo.focused)?.id ?? runtime.windows[0]?.id;
  if (typeof windowId !== "number") {
    throw new Error("Cannot choose a focused window");
  }
  return windowId;
}

function tabMatchesQuery(tab: RuntimeTab, queryInfo: Record<string, unknown>): boolean {
  if (typeof queryInfo.windowId === "number" && tab.windowId !== queryInfo.windowId) {
    return false;
  }
  if (queryInfo.active === true && !tab.active) {
    return false;
  }
  if (queryInfo.active === false && tab.active) {
    return false;
  }
  return true;
}

function runtimeModelInvariantReport(
  state: OutlineState,
  runtime: FakeWebExtensionRuntime
): RuntimeModelInvariantReport {
  const runtimeTabIds = new Set(runtime.tabs.map((tab) => tab.id));
  const runtimeWindowIds = new Set(runtime.windows.map((windowInfo) => windowInfo.id));
  const liveTabIds: number[] = [];
  const liveWindowIds: number[] = [];
  for (const node of Object.values(state.nodes)) {
    if (node.status !== "live" || !node.live) {
      continue;
    }
    if (node.kind === "tab" && isLiveTabNode(node)) {
      liveTabIds.push(node.live.tabId);
    }
    if (node.kind === "window" && "windowId" in node.live) {
      liveWindowIds.push(node.live.windowId);
    }
  }
  return {
    duplicateLiveTabIds: duplicates(liveTabIds),
    duplicateLiveWindowIds: duplicates(liveWindowIds),
    missingRuntimeTabIds: [...runtimeTabIds].filter((tabId) => !liveTabIds.includes(tabId)).sort(numberSort),
    staleLiveTabIds: liveTabIds.filter((tabId) => !runtimeTabIds.has(tabId)).sort(numberSort),
    staleLiveWindowIds: liveWindowIds.filter((windowId) => !runtimeWindowIds.has(windowId)).sort(numberSort)
  };
}

function isLiveTabNode(node: OutlineNode): node is OutlineNode & { live: { tabId: number; windowId: number } } {
  return Boolean(node.live && "tabId" in node.live && typeof node.live.tabId === "number");
}

function duplicates(values: number[]): number[] {
  const seen = new Set<number>();
  const duplicated = new Set<number>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicated.add(value);
    }
    seen.add(value);
  }
  return [...duplicated].sort(numberSort);
}

function numberSort(left: number, right: number): number {
  return left - right;
}

function copyTab(tab: RuntimeTab): RuntimeTab {
  return clone(tab);
}

function copyWindowWithoutTabs(windowInfo: RuntimeWindow): RuntimeWindow {
  const { tabs: _tabs, ...rest } = windowInfo;
  return clone(rest);
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && typeof value === "object" && "then" in value && typeof value.then === "function");
}
