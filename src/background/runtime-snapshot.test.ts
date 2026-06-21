import { describe, expect, it, vi } from "vitest";

import {
  getNormalWindow,
  getNormalWindows,
  getNormalWindowShells,
  getNormalWindowsIncludingTabs,
  getWindowTabsByIds
} from "./runtime-snapshot.js";
import type { RuntimeTab, RuntimeWindow } from "../model/types.js";

function snapshotApi(
  windows: RuntimeWindow[],
  tabs: RuntimeTab[]
): Pick<WebExtensionBrowser, "windows" | "tabs"> {
  return {
    windows: {
      WINDOW_ID_NONE: -1,
      getCurrent: vi.fn(),
      get: vi.fn(async (windowId: number) => {
        const windowInfo = windows.find((candidate) => candidate.id === windowId);
        if (!windowInfo) {
          throw new Error(`Missing window: ${windowId}`);
        }
        return windowInfo;
      }),
      getAll: vi.fn(async () => windows),
      update: vi.fn(),
      remove: vi.fn(),
      create: vi.fn(),
      onFocusChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      },
      onRemoved: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      }
    },
    tabs: {
      query: vi.fn(async () => tabs),
      update: vi.fn(),
      remove: vi.fn(),
      create: vi.fn(),
      move: vi.fn(),
      onActivated: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      },
      onCreated: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      },
      onUpdated: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      },
      onRemoved: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      }
    }
  };
}

describe("runtime snapshot", () => {
  it("uses tabs.query as source of truth so discarded tabs are retained", async () => {
    const api = snapshotApi(
      [
        {
          id: 10,
          focused: true,
          incognito: false,
          tabs: []
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 1,
          active: false,
          discarded: true,
          url: "https://sleepy.example/",
          title: "Discarded but visible"
        },
        {
          id: 2,
          windowId: 10,
          index: 0,
          active: true,
          discarded: false,
          url: "https://awake.example/",
          title: "Awake"
        }
      ]
    );

    await expect(getNormalWindows(api)).resolves.toEqual([
      {
        id: 10,
        focused: true,
        incognito: false,
        tabs: [
          expect.objectContaining({ id: 2, url: "https://awake.example/" }),
          expect.objectContaining({ id: 1, url: "https://sleepy.example/" })
        ]
      }
    ]);
    expect(api.windows.getAll).toHaveBeenCalledWith({
      populate: false,
      windowTypes: ["normal"]
    });
    expect(api.tabs.query).toHaveBeenCalledWith({});
  });

  it("filters private windows and private tabs", async () => {
    const api = snapshotApi(
      [
        {
          id: 10,
          focused: true,
          incognito: false
        },
        {
          id: 11,
          focused: false,
          incognito: true
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          incognito: false,
          url: "https://normal.example/",
          title: "Normal"
        },
        {
          id: 2,
          windowId: 11,
          index: 0,
          active: true,
          incognito: true,
          url: "https://private.example/",
          title: "Private"
        }
      ]
    );

    await expect(getNormalWindows(api)).resolves.toEqual([
      {
        id: 10,
        focused: true,
        incognito: false,
        tabs: [expect.objectContaining({ id: 1 })]
      }
    ]);
  });

  it("merges event tabs into the runtime snapshot when query lags behind", async () => {
    const api = snapshotApi(
      [
        {
          id: 10,
          focused: true,
          incognito: false,
          tabs: []
        }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://existing.example/",
          title: "Existing"
        }
      ]
    );

    await expect(
      getNormalWindowsIncludingTabs(api, [
        {
          id: 2,
          windowId: 10,
          index: 1,
          active: false,
          url: "about:newtab",
          title: "New Tab"
        }
      ])
    ).resolves.toEqual([
      {
        id: 10,
        focused: true,
        incognito: false,
        tabs: [
          expect.objectContaining({ id: 1 }),
          expect.objectContaining({ id: 2, url: "about:newtab" })
        ]
      }
    ]);
  });

  it("ignores stale event tabs when a fresh query has the tab in another window", async () => {
    const api = snapshotApi(
      [
        {
          id: 10,
          focused: false,
          incognito: false,
          tabs: []
        },
        {
          id: 20,
          focused: true,
          incognito: false,
          tabs: []
        }
      ],
      [
        {
          id: 1,
          windowId: 20,
          index: 0,
          active: true,
          url: "https://fresh.example/",
          title: "Fresh"
        }
      ]
    );

    await expect(
      getNormalWindowsIncludingTabs(api, [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: false,
          url: "https://stale.example/",
          title: "Stale"
        }
      ])
    ).resolves.toEqual([
      {
        id: 10,
        focused: false,
        incognito: false,
        tabs: []
      },
      {
        id: 20,
        focused: true,
        incognito: false,
        tabs: [
          expect.objectContaining({
            id: 1,
            windowId: 20,
            url: "https://fresh.example/"
          })
        ]
      }
    ]);
  });
});

// The extension's own full-size popup windows (sidebars, exported-tree viewer) are tracked by id in
// the controller. Firefox transiently reports a freshly-created type:"popup" window as
// type:"normal", so the windowTypes:["normal"] filter alone is not enough to keep the extension's
// own window out of a reconciliation snapshot -- it would be reconciled into the outline as a
// phantom "Group" window. excludeWindowIds drops those windows regardless of the reported type.
describe("runtime snapshot excludeWindowIds", () => {
  it("getNormalWindows omits an excluded window and its tabs even when reported as normal", async () => {
    const api = snapshotApi(
      [
        { id: 10, focused: false, incognito: false },
        // A full-size sidebar popup Firefox is momentarily reporting as a normal window.
        { id: 99, focused: true, incognito: false }
      ],
      [
        {
          id: 1,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://real.example/",
          title: "Real"
        },
        { id: 2, windowId: 99, index: 0, active: true, url: "about:blank", title: "New Tab" }
      ]
    );

    await expect(getNormalWindows(api, new Set([99]))).resolves.toEqual([
      {
        id: 10,
        focused: false,
        incognito: false,
        tabs: [expect.objectContaining({ id: 1 })]
      }
    ]);
  });

  it("getNormalWindowsIncludingTabs drops an event tab whose window is excluded", async () => {
    const api = snapshotApi(
      [
        { id: 10, focused: true, incognito: false },
        { id: 99, focused: false, incognito: false }
      ],
      [{ id: 1, windowId: 10, index: 0, active: true, url: "https://real.example/", title: "Real" }]
    );

    await expect(
      getNormalWindowsIncludingTabs(
        api,
        [{ id: 2, windowId: 99, index: 0, active: true, url: "about:blank", title: "New Tab" }],
        new Set([99])
      )
    ).resolves.toEqual([
      {
        id: 10,
        focused: true,
        incognito: false,
        tabs: [expect.objectContaining({ id: 1 })]
      }
    ]);
  });

  it("getNormalWindowShells omits excluded windows", async () => {
    const api = snapshotApi(
      [
        { id: 10, focused: false, incognito: false },
        { id: 99, focused: true, incognito: false }
      ],
      []
    );

    await expect(getNormalWindowShells(api, new Set([99]))).resolves.toEqual([
      { id: 10, focused: false, incognito: false, tabs: [] }
    ]);
  });

  it("getNormalWindow returns undefined for an excluded window id", async () => {
    const api = snapshotApi([{ id: 99, focused: true, incognito: false }], []);

    await expect(getNormalWindow(api, 99, new Set([99]))).resolves.toBeUndefined();
    await expect(getNormalWindow(api, 99)).resolves.toEqual({
      id: 99,
      focused: true,
      incognito: false,
      tabs: []
    });
  });
});

describe("getWindowTabsByIds", () => {
  const tabsByWindow: Record<number, RuntimeTab[]> = {
    10: [
      { id: 1, windowId: 10, index: 1, active: false, url: "https://one-b.example/", title: "1b" },
      { id: 2, windowId: 10, index: 0, active: true, url: "https://one-a.example/", title: "1a" }
    ],
    20: [
      { id: 3, windowId: 20, index: 0, active: true, url: "https://two.example/", title: "2" },
      {
        id: 4,
        windowId: 20,
        index: 1,
        active: false,
        incognito: true,
        url: "https://two-private.example/",
        title: "2p"
      }
    ],
    30: [{ id: 5, windowId: 30, index: 0, active: true, url: "https://three.example/", title: "3" }]
  };

  function scopedQueryApi(): Pick<WebExtensionBrowser, "windows" | "tabs"> {
    const api = snapshotApi([], []);
    api.tabs.query = vi.fn(async (queryInfo: { windowId?: number } = {}) =>
      typeof queryInfo.windowId === "number" ? (tabsByWindow[queryInfo.windowId] ?? []) : []
    );
    return api;
  }

  it("re-queries only the requested windows, scoped and de-duplicated", async () => {
    const api = scopedQueryApi();

    const result = await getWindowTabsByIds(api, [10, 30, 10]);

    expect(result.get(10)?.map((tab) => tab.id)).toEqual([2, 1]); // sorted by index
    expect(result.get(30)?.map((tab) => tab.id)).toEqual([5]);
    expect(result.has(20)).toBe(false);
    // One scoped query per distinct window id; never the global all-windows query.
    expect(vi.mocked(api.tabs.query).mock.calls).toEqual([[{ windowId: 10 }], [{ windowId: 30 }]]);
    expect(api.tabs.query).not.toHaveBeenCalledWith({});
  });

  it("drops incognito tabs from a window's re-read", async () => {
    const api = scopedQueryApi();

    const result = await getWindowTabsByIds(api, [20]);

    expect(result.get(20)?.map((tab) => tab.id)).toEqual([3]);
  });
});
