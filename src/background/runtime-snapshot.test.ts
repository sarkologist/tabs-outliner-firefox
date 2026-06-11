import { describe, expect, it, vi } from "vitest";

import { getNormalWindows, getNormalWindowsIncludingTabs } from "./runtime-snapshot.js";
import type { RuntimeTab, RuntimeWindow } from "../model/types.js";

function snapshotApi(windows: RuntimeWindow[], tabs: RuntimeTab[]): Pick<WebExtensionBrowser, "windows" | "tabs"> {
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
