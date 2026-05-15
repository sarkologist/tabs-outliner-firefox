import { describe, expect, it, vi } from "vitest";

import { createBackgroundController } from "./controller.js";
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
        remove: vi.fn(async () => undefined),
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
    expect(runtime.api.tabs.remove).toHaveBeenCalledWith(2);

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

  it("does not delete tab nodes from tab removal events during window close", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
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

    await runtime.events.tabRemoved.emit(1, { windowId: 10, isWindowClosing: true });

    let state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["window:10"]?.status).toBe("live");
    expect(state.nodes["tab:1"]?.status).toBe("live");

    runtime.windows = [];
    runtime.tabs = [];
    await runtime.events.windowRemoved.emit(10);

    state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["window:10"]?.status).toBe("closed");
    expect(state.nodes["window:10"]?.restore?.sessionId).toBe("session-window-10");
    expect(state.nodes["tab:1"]?.status).toBe("closed");
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
    const state = (await controller.handleMessage({ type: "refresh" })) as OutlineState;

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
    const state = (await controller.handleMessage({ type: "refresh" })) as OutlineState;

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

    const restored = (await controller.handleMessage({ type: "restoreNode", nodeId: "window:20" })) as OutlineState;
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

    const deleted = (await controller.handleMessage({ type: "deleteNode", nodeId: "tab:2" })) as OutlineState;

    expect(runtime.api.tabs.remove).toHaveBeenCalledWith(2);
    expect(deleted.nodes["tab:2"]).toBeUndefined();
    expect(deleted.nodes["window:10"]?.childIds).toEqual(["tab:1"]);

    const lastSave = vi.mocked(runtime.api.storage.local.set).mock.calls.at(-1)?.[0] as
      | Record<string, OutlineState>
      | undefined;
    expect(lastSave?.[STATE_KEY]?.nodes["tab:2"]).toBeUndefined();

    const lastBroadcast = runtime.broadcasts.at(-1) as { type?: string; state?: OutlineState } | undefined;
    expect(lastBroadcast?.type).toBe("stateUpdated");
    expect(lastBroadcast?.state?.nodes["tab:2"]).toBeUndefined();

    const afterRemoveEvent = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(afterRemoveEvent.nodes["tab:2"]).toBeUndefined();
    expect(afterRemoveEvent.nodes["tab:1"]?.status).toBe("live");
    expect(afterRemoveEvent.nodes["window:10"]?.childIds).toEqual(["tab:1"]);
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

    const deleted = (await controller.handleMessage({ type: "deleteNode", nodeId: "tab:1" })) as OutlineState;

    expect(runtime.api.tabs.remove).toHaveBeenCalledWith(1);
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
