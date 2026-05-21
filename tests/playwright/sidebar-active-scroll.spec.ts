import { expect, test, type Page } from "@playwright/test";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

test.describe("sidebar active-tab scrolling", () => {
  test("scrolls to an active tab after search previously hid it", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page);

    await page.getByRole("searchbox", { name: "Search tabs" }).fill("needle");
    await expect(page.getByRole("treeitem")).toHaveCount(2);

    await dispatchSidebarMessage(page, {
      type: "activeStateUpdated",
      updates: [
        { nodeId: "tab:1", active: false },
        { nodeId: "tab:80", active: true }
      ]
    });
    await expect(page.locator(nodeSelector("tab:80"))).toHaveCount(0);

    await page.getByRole("button", { name: "Clear search" }).click();

    await expect(page.locator(`${nodeSelector("tab:80")}.is-active`)).toBeVisible();
    await expect(page.locator(nodeSelector("tab:80"))).toHaveAttribute("data-row-index", "80");
    expect(await scrollTop(page)).toBeGreaterThan(500);
    expect(issues).toEqual([]);
  });

  test("does not scroll a sidebar away from its own window after a later focus echo", async ({ page }) => {
    const issues = collectPageIssues(page);
    const state = groupedWindowFixtureState();
    await loadSidebar(page, state, { currentWindowId: 42 });

    await expect(page.locator(`${nodeSelector("tab:new-active")}.is-active`)).toBeVisible();
    const groupedScrollTop = await scrollTop(page);
    expect(groupedScrollTop).toBeGreaterThan(500);

    await dispatchSidebarMessage(page, {
      type: "nodeStateUpdated",
      updatedNodes: [
        {
          ...state.nodes["window:10"],
          active: true
        },
        {
          ...state.nodes["window:42"],
          active: false
        }
      ],
      closedCountDelta: 0
    });

    await expect(page.locator(nodeSelector("tab:new-active"))).toBeVisible();
    expect(await scrollTop(page)).toBe(groupedScrollTop);
    expect(issues).toEqual([]);
  });
});

async function loadSidebar(
  page: Page,
  state: ReturnType<typeof fixtureState> = fixtureState(),
  options: { currentWindowId?: number } = {}
): Promise<void> {
  await page.addInitScript((state) => {
    const listeners: Array<(message: unknown) => void> = [];
    (window as typeof window & { __dispatchSidebarMessage?: (message: unknown) => void }).__dispatchSidebarMessage = (
      message
    ) => {
      for (const listener of listeners) {
        listener(structuredClone(message));
      }
    };
    window.browser = {
      runtime: {
        sendMessage: async (message: unknown) => {
          const type = typeof message === "object" && message ? (message as { type?: unknown }).type : undefined;
          if (type === "getState") {
            return structuredClone(state);
          }
          if (type === "getDiagnostics") {
            const tabCount = state.nodes["window:1"].childIds.length;
            return {
              runtimeTabCount: tabCount,
              liveTabNodeCount: tabCount,
              visibleLiveTabNodeCount: tabCount,
              hiddenLiveTabNodeCount: 0,
              missingRuntimeTabIds: []
            };
          }
          if (type === "getPerformanceTrace") {
            return undefined;
          }
          if (type === "setPerformanceTraceEnabled" || type === "clearPerformanceTrace") {
            return undefined;
          }
          return { ok: true };
        },
        onMessage: {
          addListener: (listener: (message: unknown) => void) => {
            listeners.push(listener);
          }
        }
      },
      windows: {
        getCurrent: async () =>
          typeof state.currentWindowId === "number" ? { id: state.currentWindowId } : undefined
      },
      storage: {
        local: {
          get: async () => ({}),
          set: async () => undefined
        }
      }
    };
  }, { ...state, currentWindowId: options.currentWindowId });

  await page.goto("/sidebar/sidebar.html");
  await expect(page.locator("#state-count")).toHaveText(`${Object.keys(state.nodes).length} items / 0 saved`);
}

async function dispatchSidebarMessage(page: Page, message: unknown): Promise<void> {
  await page.evaluate((payload) => {
    const dispatch = (window as typeof window & { __dispatchSidebarMessage?: (message: unknown) => void })
      .__dispatchSidebarMessage;
    if (!dispatch) {
      throw new Error("Missing sidebar message dispatcher");
    }
    dispatch(payload);
  }, message);
}

async function scrollTop(page: Page): Promise<number> {
  return page.locator("main").evaluate((element) => element.scrollTop);
}

function nodeSelector(nodeId: string): string {
  return `.node[data-node-id='${cssString(nodeId)}']`;
}

function cssString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function collectPageIssues(page: Page): ConsoleIssue[] {
  const issues: ConsoleIssue[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      issues.push({ kind: "console", text: message.text() });
    }
  });
  page.on("pageerror", (error) => {
    issues.push({ kind: "pageerror", text: error.message });
  });
  page.on("requestfailed", (request) => {
    issues.push({ kind: "requestfailed", text: `${request.url()} ${request.failure()?.errorText ?? ""}` });
  });
  return issues;
}

function fixtureState() {
  const now = 1_700_000_000_000;
  const tabIds = Array.from({ length: 120 }, (_value, index) => `tab:${index + 1}`);
  return {
    version: 1,
    rootIds: ["window:1"],
    nodes: {
      "window:1": {
        id: "window:1",
        kind: "window",
        status: "live",
        title: "Window",
        childIds: tabIds,
        active: true,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { windowId: 1 }
      },
      ...Object.fromEntries(
        tabIds.map((id, index) => [
          id,
          {
            id,
            kind: "tab",
            status: "live",
            parentId: "window:1",
            title: index === 0 ? "Needle home" : `Tab ${index + 1}`,
            url: `https://active-scroll.example/${index + 1}`,
            childIds: [],
            active: index === 0,
            collapsed: false,
            createdAt: now,
            updatedAt: now,
            live: { tabId: index + 1, windowId: 1 }
          }
        ])
      )
    }
  };
}

function groupedWindowFixtureState() {
  const now = 1_700_000_000_000;
  const oldTabIds = Array.from({ length: 80 }, (_value, index) => `tab:old-${index + 1}`);
  return {
    version: 1,
    rootIds: ["window:10"],
    nodes: {
      "window:10": {
        id: "window:10",
        kind: "window",
        status: "live",
        title: "Original window",
        childIds: [...oldTabIds, "window:42"],
        active: false,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { windowId: 10 }
      },
      ...Object.fromEntries(
        oldTabIds.map((id, index) => [
          id,
          {
            id,
            kind: "tab",
            status: "live",
            parentId: "window:10",
            title: `Old tab ${index + 1}`,
            url: `https://old.example/${index + 1}`,
            childIds: [],
            active: index === 0,
            collapsed: false,
            createdAt: now,
            updatedAt: now,
            live: { tabId: index + 1, windowId: 10 }
          }
        ])
      ),
      "window:42": {
        id: "window:42",
        kind: "window",
        status: "live",
        parentId: "window:10",
        title: "Grouped window",
        childIds: ["tab:new-active"],
        active: true,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { windowId: 42 }
      },
      "tab:new-active": {
        id: "tab:new-active",
        kind: "tab",
        status: "live",
        parentId: "window:42",
        title: "Grouped active tab",
        url: "https://grouped.example/",
        childIds: [],
        active: true,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { tabId: 420, windowId: 42 }
      }
    }
  };
}
