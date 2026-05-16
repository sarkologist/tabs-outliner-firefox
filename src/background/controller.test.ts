import { describe, expect, it, vi } from "vitest";

import type { BrowserAdapter } from "./adapter.js";
import { createBackgroundController } from "./controller.js";
import type { CommandAck } from "./commands.js";
import { STATE_KEY } from "./storage.js";
import type { OutlineState, RuntimeTab, RuntimeWindow } from "../model/types.js";

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
    tabCreated: FakeEvent<[RuntimeTab]>;
    tabActivated: FakeEvent<[{ tabId: number; windowId: number; previousTabId?: number }]>;
    tabUpdated: FakeEvent<[number, Partial<RuntimeTab>, RuntimeTab]>;
    tabRemoved: FakeEvent<[number, { windowId: number; isWindowClosing: boolean }]>;
    windowFocusChanged: FakeEvent<[number]>;
    windowRemoved: FakeEvent<[number]>;
    sessionChanged: FakeEvent<[]>;
  };
  tabs: RuntimeTab[];
  windows: RuntimeWindow[];
  broadcasts: unknown[];
  setNextTabQueryResult(tabs: RuntimeTab[]): void;
};

type TabCloseEventOrder =
  | "tabRemovedThenSessionChanged"
  | "sessionChangedThenTabRemoved"
  | "tabRemovedOnly"
  | "sessionChangedOnly";

type FakeRuntimeOptions = {
  browserLikeTabRemove?: TabCloseEventOrder;
};

function fakeRuntime(windows: RuntimeWindow[], tabs: RuntimeTab[], options: FakeRuntimeOptions = {}): FakeRuntime {
  const tabCreated = new FakeEvent<[RuntimeTab]>();
  const tabActivated = new FakeEvent<[{ tabId: number; windowId: number; previousTabId?: number }]>();
  const tabUpdated = new FakeEvent<[number, Partial<RuntimeTab>, RuntimeTab]>();
  const tabRemoved = new FakeEvent<[number, { windowId: number; isWindowClosing: boolean }]>();
  const windowFocusChanged = new FakeEvent<[number]>();
  const windowRemoved = new FakeEvent<[number]>();
  const sessionChanged = new FakeEvent<[]>();
  const storage = new Map<string, unknown>();
  const broadcasts: unknown[] = [];
  let nextTabQueryResult: RuntimeTab[] | undefined;
  const runtime: FakeRuntime = {
    windows: windows.map(copyWindow),
    tabs: tabs.map(copyTab),
    broadcasts,
    setNextTabQueryResult(tabs) {
      nextTabQueryResult = tabs.map(copyTab);
    },
    events: {
      tabCreated,
      tabActivated,
      tabUpdated,
      tabRemoved,
      windowFocusChanged,
      windowRemoved,
      sessionChanged
    },
    api: {
      action: {
        onClicked: new FakeEvent<[]>() as never
      },
      sidebarAction: {
        open: vi.fn(async () => undefined),
        toggle: vi.fn(async () => undefined)
      },
      runtime: {
        onInstalled: new FakeEvent<[]>() as never,
        onStartup: new FakeEvent<[]>() as never,
        onMessage: new FakeEvent<[unknown, { tab?: RuntimeTab }]>() as never,
        sendMessage: vi.fn(async (message: unknown) => {
          broadcasts.push(message);
          return undefined;
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
            for (const [key, value] of Object.entries(items)) {
              storage.set(key, value);
            }
          }),
          remove: vi.fn(async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              storage.delete(key);
            }
          }),
          onChanged: new FakeEvent<[Record<string, { oldValue?: unknown; newValue?: unknown }>, string]>() as never
        }
      },
      windows: {
        WINDOW_ID_NONE: -1,
        getAll: vi.fn(async (getInfo: { populate?: boolean; windowTypes?: string[] } = {}) =>
          runtime.windows.map((windowInfo) => {
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
          })
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
        create: vi.fn(async () => {
          throw new Error("not implemented");
        }),
        onFocusChanged: windowFocusChanged as never,
        onRemoved: windowRemoved as never
      },
      tabs: {
        query: vi.fn(async (queryInfo: Record<string, unknown> = {}) => {
          const source = nextTabQueryResult ?? runtime.tabs;
          nextTabQueryResult = undefined;
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
        create: vi.fn(async () => {
          throw new Error("not implemented");
        }),
        move: vi.fn(async () => []),
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

function createTabFromBrowser(
  runtime: FakeRuntime,
  tab: RuntimeTab,
  options: { awaitListeners?: boolean; queryLag?: boolean } = {}
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
    runtime.setNextTabQueryResult(runtime.tabs.filter((candidate) => candidate.id !== tab.id));
  }

  const eventTab = copyTab(tab);
  if (options.awaitListeners === false) {
    runtime.events.tabCreated.dispatch(eventTab);
    return;
  }
  return runtime.events.tabCreated.emit(eventTab);
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
  const { tabs: _tabs, ...rest } = windowInfo;
  return { ...rest };
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
  rng: () => number;
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
  const staleTabsInOpenWindows = context.staleTabs.filter((tab) =>
    context.runtime.windows.some((windowInfo) => windowInfo.id === tab.windowId) &&
      !context.runtime.tabs.some((runtimeTab) => runtimeTab.id === tab.id)
  );
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
  if (closeableOutlinerTabs.length > 0) {
    operations.push({ name: "outliner-close-tab", run: outlinerCloseGeneratedTab });
  }
  if (context.runtime.windows.length > 1) {
    operations.push({ name: "outliner-close-window", run: outlinerCloseGeneratedWindow });
  }
  if (multiTabWindows.length > 0) {
    operations.push({ name: "native-close-window", run: nativeCloseGeneratedWindow });
  }
  if (context.runtime.tabs.length > 0 && staleTabsInOpenWindows.length > 0) {
    operations.push(
      { name: "stale-activation-snapshot", run: staleActivationSnapshot },
      { name: "stale-tab-created-event", run: staleCreatedEvent },
      { name: "stale-tab-updated-event", run: staleUpdatedEvent }
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

async function nativeCloseGeneratedTab(context: GeneratedTraceContext): Promise<void> {
  const tab = pickOne(context.rng, context.runtime.tabs);
  const tabsInWindow = tabsInRuntimeWindow(context.runtime, tab.windowId);
  context.staleTabs.push(copyTab(tab));

  if (tabsInWindow.length === 1) {
    context.nativeDeletedNodeIds.add(tabNodeIdFor(tab.id));
    if (await liveRuntimeWindowHasOtherOutlineChildren(context, tab.windowId, tabNodeIdFor(tab.id))) {
      context.expectedClosedNodeIds.add(windowNodeIdFor(tab.windowId));
    } else {
      context.nativeDeletedNodeIds.add(windowNodeIdFor(tab.windowId));
    }
    context.history.push(`native close last tab ${tab.id} in window ${tab.windowId}`);
    await closeRuntimeWindow(context.runtime, tab.windowId, { awaitListeners: true });
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
}

async function outlinerCloseGeneratedTab(context: GeneratedTraceContext): Promise<void> {
  const candidates = context.runtime.tabs.filter((tab) =>
    tabsInRuntimeWindow(context.runtime, tab.windowId).length > 1
  );
  const tab = pickOne(context.rng, candidates);
  context.expectedClosedNodeIds.add(tabNodeIdFor(tab.id));
  context.history.push(`outliner close tab ${tab.id}`);
  await context.controller.handleMessage({ type: "closeNode", nodeId: tabNodeIdFor(tab.id) });
}

async function outlinerCloseGeneratedWindow(context: GeneratedTraceContext): Promise<void> {
  const windowInfo = pickOne(context.rng, context.runtime.windows);
  const tabs = tabsInRuntimeWindow(context.runtime, windowInfo.id);
  context.expectedClosedNodeIds.add(windowNodeIdFor(windowInfo.id));
  for (const tab of tabs) {
    context.expectedClosedNodeIds.add(tabNodeIdFor(tab.id));
  }
  context.history.push(`outliner close window ${windowInfo.id} with ${tabs.length} tabs`);
  await context.controller.handleMessage({ type: "closeNode", nodeId: windowNodeIdFor(windowInfo.id) });
}

async function nativeCloseGeneratedWindow(context: GeneratedTraceContext): Promise<void> {
  const candidates = context.runtime.windows.filter((windowInfo) =>
    tabsInRuntimeWindow(context.runtime, windowInfo.id).length > 1
  );
  const windowInfo = pickOne(context.rng, candidates);
  const tabs = tabsInRuntimeWindow(context.runtime, windowInfo.id);
  context.expectedClosedNodeIds.add(windowNodeIdFor(windowInfo.id));
  for (const tab of tabs) {
    context.expectedClosedNodeIds.add(tabNodeIdFor(tab.id));
  }
  context.history.push(`native close multi-tab window ${windowInfo.id}`);
  await closeRuntimeWindow(context.runtime, windowInfo.id, { awaitListeners: true });
}

async function staleActivationSnapshot(context: GeneratedTraceContext): Promise<void> {
  const stale = pickOne(context.rng, staleTabsInOpenWindows(context));
  const target = pickOne(context.rng, context.runtime.tabs);
  context.runtime.setNextTabQueryResult([
    ...context.runtime.tabs.map((tab) => ({
      ...tab,
      active: tab.windowId === target.windowId ? tab.id === target.id : tab.active
    })),
    {
      ...stale,
      active: false
    }
  ]);
  context.history.push(`activate tab ${target.id} with stale tab ${stale.id} in query result`);
  await activateTabFromBrowser(context.runtime, target.id);
}

async function staleCreatedEvent(context: GeneratedTraceContext): Promise<void> {
  const stale = pickOne(context.rng, staleTabsInOpenWindows(context));
  context.history.push(`dispatch stale created event for tab ${stale.id}`);
  await context.runtime.events.tabCreated.emit(copyTab(stale));
}

async function staleUpdatedEvent(context: GeneratedTraceContext): Promise<void> {
  const stale = pickOne(context.rng, staleTabsInOpenWindows(context));
  context.history.push(`dispatch stale updated event for tab ${stale.id}`);
  await context.runtime.events.tabUpdated.emit(stale.id, { title: "Stale" }, {
    ...stale,
    title: "Stale"
  });
}

function staleTabsInOpenWindows(context: GeneratedTraceContext): RuntimeTab[] {
  return context.staleTabs.filter((tab) =>
    context.runtime.windows.some((windowInfo) => windowInfo.id === tab.windowId) &&
      !context.runtime.tabs.some((runtimeTab) => runtimeTab.id === tab.id)
  );
}

async function liveRuntimeWindowHasOtherOutlineChildren(
  context: GeneratedTraceContext,
  runtimeWindowId: number,
  excludedNodeId: string
): Promise<boolean> {
  const state = (await context.controller.handleMessage({ type: "getState" })) as OutlineState;
  const windowNode = liveWindowNodeForRuntimeWindow(state, runtimeWindowId);
  return Boolean(windowNode?.childIds.some((childId) => childId !== excludedNodeId));
}

async function runGeneratedTrace(seed: number, steps: number): Promise<void> {
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

    const lastSave = vi.mocked(runtime.api.storage.local.set).mock.calls.at(-1)?.[0] as
      | Record<string, OutlineState>
      | undefined;
    expect(lastSave?.[STATE_KEY]?.nodes["tab:2"]).toBeUndefined();

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

    const stateUpdates = runtime.broadcasts.filter((message): message is { type: string; state: OutlineState } => {
      return Boolean(
        message &&
          typeof message === "object" &&
          (message as { type?: unknown }).type === "stateUpdated" &&
          (message as { state?: unknown }).state
      );
    });
    expect(stateUpdates).toHaveLength(1);
    expect(stateUpdates[0]?.state.nodes["tab:2"]?.status).toBe("closed");
    expect(vi.mocked(runtime.api.storage.local.set)).toHaveBeenCalledTimes(1);
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

    const restoreResult = await controller.handleMessage({ type: "restoreNode", nodeId: "window:20" });
    const restored = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expectCommandAck(restoreResult, true);
    expect(restored.nodes["window:20"]?.live).toEqual({ windowId: 42 });
    expect(restored.nodes["tab:5"]?.status).toBe("closed");
    expect(restored.nodes["window:42"]).toBeUndefined();

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

    const lastSave = vi.mocked(runtime.api.storage.local.set).mock.calls.at(-1)?.[0] as
      | Record<string, OutlineState>
      | undefined;
    expect(lastSave?.[STATE_KEY]?.nodes["tab:2"]).toBeUndefined();

    const lastBroadcast = runtime.broadcasts.at(-1) as { type?: string; state?: OutlineState } | undefined;
    expect(runtime.broadcasts).toHaveLength(1);
    expect(lastBroadcast?.type).toBe("stateUpdated");
    expect(lastBroadcast?.state?.nodes["tab:2"]).toBeUndefined();

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
    expect(runtime.broadcasts).toHaveLength(1);
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

    const lastBroadcast = runtime.broadcasts.at(-1) as { type?: string; state?: OutlineState } | undefined;
    expect(lastBroadcast?.type).toBe("stateUpdated");
    expect(lastBroadcast?.state?.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:2"]);
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
    const lastBroadcast = runtime.broadcasts.at(-1) as { type?: string; state?: OutlineState } | undefined;

    expectCommandAck(result, true);
    expect(state.nodes["tab:1"]?.collapsed).toBe(true);
    expect(runtime.broadcasts).toHaveLength(1);
    expect(lastBroadcast?.type).toBe("stateUpdated");
    expect(lastBroadcast?.state?.nodes["tab:1"]?.collapsed).toBe(true);
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

    const lastSave = vi.mocked(runtime.api.storage.local.set).mock.calls.at(-1)?.[0] as
      | Record<string, OutlineState>
      | undefined;
    expect(lastSave?.[STATE_KEY]?.nodes["window:10"]).toBeUndefined();

    const lastBroadcast = runtime.broadcasts.at(-1) as { type?: string; state?: OutlineState } | undefined;
    expect(lastBroadcast?.type).toBe("stateUpdated");
    expect(lastBroadcast?.state?.nodes["window:10"]).toBeUndefined();

    const afterRemoveEvent = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(afterRemoveEvent.nodes["tab:1"]).toBeUndefined();
    expect(afterRemoveEvent.nodes["window:10"]).toBeUndefined();
    expect(afterRemoveEvent.rootIds).toEqual([]);
  });
});
