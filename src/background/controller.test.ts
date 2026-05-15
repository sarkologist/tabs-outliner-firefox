import { describe, expect, it, vi } from "vitest";

import { createBackgroundController } from "./controller.js";
import { STATE_KEY } from "./storage.js";
import type { OutlineState, RuntimeTab, RuntimeWindow } from "../model/types.js";

type Listener<TArgs extends unknown[]> = (...args: TArgs) => unknown | Promise<unknown>;

class FakeEvent<TArgs extends unknown[]> {
  private listeners: Listener<TArgs>[] = [];

  addListener(listener: Listener<TArgs>): void {
    this.listeners.push(listener);
  }

  removeListener(listener: Listener<TArgs>): void {
    this.listeners = this.listeners.filter((candidate) => candidate !== listener);
  }

  async emit(...args: TArgs): Promise<void> {
    for (const listener of this.listeners) {
      await listener(...args);
    }
  }
}

type FakeRuntime = {
  api: WebExtensionBrowser;
  events: {
    tabCreated: FakeEvent<[RuntimeTab]>;
    tabUpdated: FakeEvent<[number, Partial<RuntimeTab>, RuntimeTab]>;
    tabRemoved: FakeEvent<[number, { windowId: number; isWindowClosing: boolean }]>;
    windowRemoved: FakeEvent<[number]>;
  };
  tabs: RuntimeTab[];
  windows: RuntimeWindow[];
  broadcasts: unknown[];
};

function fakeRuntime(windows: RuntimeWindow[], tabs: RuntimeTab[]): FakeRuntime {
  const tabCreated = new FakeEvent<[RuntimeTab]>();
  const tabUpdated = new FakeEvent<[number, Partial<RuntimeTab>, RuntimeTab]>();
  const tabRemoved = new FakeEvent<[number, { windowId: number; isWindowClosing: boolean }]>();
  const windowRemoved = new FakeEvent<[number]>();
  const storage = new Map<string, unknown>();
  const broadcasts: unknown[] = [];
  const runtime: FakeRuntime = {
    windows,
    tabs,
    broadcasts,
    events: {
      tabCreated,
      tabUpdated,
      tabRemoved,
      windowRemoved
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
        getAll: vi.fn(async () => runtime.windows),
        update: vi.fn(async (windowId: number) => runtime.windows.find((windowInfo) => windowInfo.id === windowId)!),
        remove: vi.fn(async () => undefined),
        create: vi.fn(async () => {
          throw new Error("not implemented");
        }),
        onRemoved: windowRemoved as never
      },
      tabs: {
        query: vi.fn(async () => runtime.tabs),
        update: vi.fn(async (tabId: number) => runtime.tabs.find((tab) => tab.id === tabId)!),
        remove: vi.fn(async () => undefined),
        create: vi.fn(async () => {
          throw new Error("not implemented");
        }),
        move: vi.fn(async () => []),
        onCreated: tabCreated as never,
        onUpdated: tabUpdated as never,
        onRemoved: tabRemoved as never
      },
      sessions: {
        getRecentlyClosed: vi.fn(async () => [{ tab: { sessionId: "recent-session" } } as never]),
        restore: vi.fn(async () => ({})),
        onChanged: new FakeEvent<[]>() as never
      }
    }
  };

  return runtime;
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

    await runtime.events.tabCreated.emit({
      id: 2,
      windowId: 10,
      index: 1,
      active: true,
      url: "about:newtab",
      title: "New Tab"
    });

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
      runtime.events.tabCreated.emit({
        id: 2,
        windowId: 10,
        index: 1,
        active: false,
        url: "about:newtab",
        title: "New Tab"
      }),
      runtime.events.tabCreated.emit({
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

  it("closes explicit removed tabs while preserving other live tabs", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
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

    runtime.tabs = runtime.tabs.filter((tab) => tab.id !== 2);
    await runtime.events.tabRemoved.emit(2, { windowId: 10, isWindowClosing: false });

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:1"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.status).toBe("closed");
  });

  it("reattaches tabs restored through native browser undo close", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        }
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

    runtime.tabs = runtime.tabs.filter((tab) => tab.id !== 2);
    await runtime.events.tabRemoved.emit(2, { windowId: 10, isWindowClosing: false });

    await runtime.events.tabCreated.emit({
      id: 22,
      windowId: 10,
      index: 1,
      active: true,
      url: "about:blank",
      title: "New Tab"
    });
    runtime.tabs = [
      ...runtime.tabs,
      {
        id: 22,
        windowId: 10,
        index: 1,
        active: true,
        url: "https://two.example/",
        title: "Two"
      }
    ];
    await runtime.events.tabUpdated.emit(22, { url: "https://two.example/", title: "Two" }, runtime.tabs[1]!);

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:2"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.live).toEqual({ tabId: 22, windowId: 10 });
    expect(state.nodes["tab:22"]).toBeUndefined();
    expect(liveTabIds(state)).toEqual([1, 22]);
  });

  it("does not reattach saved closed nodes when duplicating a live tab", async () => {
    const runtime = fakeRuntime(
      [
        {
          id: 10,
          focused: true,
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

    runtime.tabs = runtime.tabs.filter((tab) => tab.id !== 2);
    await runtime.events.tabRemoved.emit(2, { windowId: 10, isWindowClosing: false });

    runtime.tabs = [
      ...runtime.tabs,
      {
        id: 22,
        windowId: 10,
        index: 1,
        active: true,
        openerTabId: 1,
        url: "https://same.example/",
        title: "Original"
      }
    ];
    await runtime.events.tabCreated.emit(runtime.tabs[1]!);

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(state.nodes["tab:2"]?.status).toBe("closed");
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

    runtime.tabs = [runtime.tabs[1]!];
    await runtime.events.tabUpdated.emit(2, { active: true }, runtime.tabs[0]!);

    await runtime.events.tabCreated.emit({
      id: 4,
      windowId: 10,
      index: 3,
      active: true,
      url: "about:newtab",
      title: "New Tab"
    });

    runtime.tabs = [
      {
        id: 1,
        windowId: 10,
        index: 0,
        active: false,
        url: "https://one.example/",
        title: "One"
      },
      {
        id: 3,
        windowId: 10,
        index: 1,
        active: false,
        url: "https://three.example/",
        title: "Three"
      },
      {
        id: 4,
        windowId: 10,
        index: 2,
        active: true,
        url: "about:newtab",
        title: "New Tab"
      }
    ];
    await runtime.events.tabRemoved.emit(2, { windowId: 10, isWindowClosing: false });

    await runtime.events.tabCreated.emit({
      id: 22,
      windowId: 10,
      index: 1,
      active: true,
      url: "about:blank",
      title: "New Tab"
    });
    runtime.tabs = [
      runtime.tabs[0]!,
      {
        id: 22,
        windowId: 10,
        index: 1,
        active: true,
        url: "https://two.example/",
        title: "Two"
      },
      {
        ...runtime.tabs[1]!,
        index: 2
      },
      {
        ...runtime.tabs[2]!,
        index: 3
      }
    ];
    await runtime.events.tabUpdated.emit(22, { url: "https://two.example/", title: "Two" }, runtime.tabs[1]!);

    const state = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(reachableNodeIds(state)).toEqual(Object.keys(state.nodes).sort());
    expect(liveTabIds(state)).toEqual([1, 3, 4, 22]);
    expect(state.nodes["tab:2"]?.status).toBe("live");
    expect(state.nodes["tab:2"]?.live).toEqual({ tabId: 22, windowId: 10 });
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

    expect(state.nodes["tab:1"]?.status).toBe("closed");
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
    vi.mocked(runtime.api.tabs.query).mockImplementation(async (queryInfo: Record<string, unknown> = {}) => {
      const windowId = queryInfo.windowId;
      return typeof windowId === "number"
        ? runtime.tabs.filter((tab) => tab.windowId === windowId)
        : runtime.tabs;
    });
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
    runtime.tabs = [...runtime.tabs, restoredTab];
    await runtime.events.tabCreated.emit(restoredTab);

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

    runtime.tabs = runtime.tabs.filter((tab) => tab.id !== 2);
    await runtime.events.tabRemoved.emit(2, { windowId: 10, isWindowClosing: false });

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

    runtime.tabs = [];
    await runtime.events.tabRemoved.emit(1, { windowId: 10, isWindowClosing: false });

    const afterRemoveEvent = (await controller.handleMessage({ type: "getState" })) as OutlineState;
    expect(afterRemoveEvent.nodes["tab:1"]).toBeUndefined();
    expect(afterRemoveEvent.nodes["window:10"]).toBeUndefined();
    expect(afterRemoveEvent.rootIds).toEqual([]);
  });
});
