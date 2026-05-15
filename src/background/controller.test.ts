import { describe, expect, it, vi } from "vitest";

import { createBackgroundController } from "./controller.js";
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
});
