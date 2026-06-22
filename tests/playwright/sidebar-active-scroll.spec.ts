import { expect, test, type Page } from "@playwright/test";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

type SidebarFixtureNode = {
  id: string;
  kind: "window" | "tab" | "group";
  status: "live" | "closed" | "neutral";
  parentId?: string;
  title: string;
  url?: string;
  childIds: string[];
  active?: boolean;
  collapsed: boolean;
  createdAt: number;
  updatedAt: number;
  live?: {
    tabId?: number;
    windowId: number;
  };
};

type SidebarFixtureState = {
  version: number;
  rootIds: string[];
  nodes: Record<string, SidebarFixtureNode>;
};

const MOVE_TO_TOP_SPACER_COUNT = 90;

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

  test("does not scroll a full-size sidebar to the focused window's active tab", async ({
    page
  }) => {
    const issues = collectPageIssues(page);
    // A full-size sidebar is the detached, whole-tree popup (opened via ?view=window). Its own popup
    // window owns no browser tabs, so -- unlike a docked per-window sidebar -- it must NOT follow the
    // focused window's active tab; otherwise it "jumps to the last-focused window" on every focus or
    // active-tab change. The currentWindowId is the popup's own id, absent from the outline.
    await loadSidebar(page, fixtureState(), { currentWindowId: 999, fullSizeView: true });

    // tab:1 is the active tab and sits at the top, so the view starts unscrolled.
    await expect(page.locator(`${nodeSelector("tab:1")}.is-active`)).toBeVisible();
    expect(await scrollTop(page)).toBeLessThan(100);

    // The focused window switches its active tab to one far down the outline.
    await dispatchSidebarMessage(page, {
      type: "activeStateUpdated",
      updates: [
        { nodeId: "tab:1", active: false },
        { nodeId: "tab:100", active: true }
      ]
    });

    // The update is applied (tab:1 is no longer the active row) but the full-size view stays put --
    // pre-fix it scrolled down to tab:100, the focused window's active tab.
    await expect(page.locator(`${nodeSelector("tab:1")}.is-active`)).toHaveCount(0);
    expect(await scrollTop(page)).toBeLessThan(100);
    expect(issues).toEqual([]);
  });

  test("a full-size sidebar opens at the top, not the focused window's deep active tab", async ({
    page
  }) => {
    const issues = collectPageIssues(page);
    const state = fixtureState();
    // The focused window's active tab is far down the outline.
    state.nodes["tab:1"]!.active = false;
    state.nodes["tab:100"]!.active = true;
    await loadSidebar(page, state, { currentWindowId: 999, fullSizeView: true });

    // The full-size view opens anchored at the top (window:1 at row 0), NOT centered/scrolled on the
    // deep active tab -- pre-fix the active-centered first paint scrolled it down (and an active-
    // centered sparse boot could leave the top blank).
    await expect(page.locator(nodeSelector("window:1"))).toHaveAttribute("data-row-index", "0");
    await expect(page.locator(nodeSelector("window:1"))).toBeVisible();
    expect(await scrollTop(page)).toBeLessThan(100);
    expect(issues).toEqual([]);
  });

  test("does not scroll a sidebar away from its own window after a later focus echo", async ({
    page
  }) => {
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
      liveTabCountDelta: 0
    });

    await expect(page.locator(nodeSelector("tab:new-active"))).toBeVisible();
    expect(await scrollTop(page)).toBe(groupedScrollTop);
    expect(issues).toEqual([]);
  });

  test("follows a scoped active tab after move to top level relocates its window", async ({
    page
  }) => {
    const issues = collectPageIssues(page);
    const state = moveToTopLevelFixtureState();
    await loadSidebar(page, state, { currentWindowId: 42 });

    await expect(page.locator(nodeSelector("tab:scoped-active"))).toBeVisible();
    await expect(page.locator(nodeSelector("tab:scoped-active"))).toHaveAttribute(
      "data-row-index",
      "4"
    );
    const initialScrollTop = await scrollTop(page);
    expect(initialScrollTop).toBeLessThan(100);

    await dispatchSidebarMessage(page, moveScopedWindowToTopLevelPatch(state));

    const movedWindowRowIndex = 3 + MOVE_TO_TOP_SPACER_COUNT;
    await expect(page.locator(nodeSelector("window:42"))).toHaveAttribute("aria-level", "1");
    await expect(page.locator(nodeSelector("window:42"))).toHaveAttribute(
      "data-row-index",
      String(movedWindowRowIndex)
    );
    await expect(page.locator(nodeSelector("tab:scoped-active"))).toHaveAttribute(
      "data-row-index",
      String(movedWindowRowIndex + 1)
    );
    await expect(page.locator(nodeSelector("tab:scoped-active"))).toBeVisible();
    expect(await scrollTop(page)).toBeGreaterThan(initialScrollTop + 500);
    expect(issues).toEqual([]);
  });
});

async function loadSidebar(
  page: Page,
  state: SidebarFixtureState = fixtureState(),
  options: { currentWindowId?: number; fullSizeView?: boolean } = {}
): Promise<void> {
  await page.addInitScript(
    (state) => {
      const listeners: Array<(message: unknown) => void> = [];
      (
        window as typeof window & { __dispatchSidebarMessage?: (message: unknown) => void }
      ).__dispatchSidebarMessage = (message) => {
        for (const listener of listeners) {
          listener(structuredClone(message));
        }
      };
      window.browser = {
        runtime: {
          sendMessage: async (message: unknown) => {
            const type =
              typeof message === "object" && message
                ? (message as { type?: unknown }).type
                : undefined;
            if (type === "getState") {
              return structuredClone(state);
            }
            if (type === "getDiagnostics") {
              const tabCount = Object.values(state.nodes).filter(
                (node) => node.kind === "tab" && node.status === "live"
              ).length;
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
    },
    { ...state, currentWindowId: options.currentWindowId }
  );

  // The full-size sidebar is the same page opened in its own popup window; the background marks that
  // URL with `?view=window` so the page can tell itself apart from a docked per-window sidebar.
  await page.goto(
    options.fullSizeView ? "/sidebar/sidebar.html?view=window" : "/sidebar/sidebar.html"
  );
  await expect(page.locator("#state-count")).toHaveText(
    `${Object.keys(state.nodes).length} / ${
      Object.values(state.nodes).filter(
        (node) =>
          node.kind === "tab" &&
          node.status === "live" &&
          Boolean(node.live && "tabId" in node.live)
      ).length
    }`
  );
}

async function dispatchSidebarMessage(page: Page, message: unknown): Promise<void> {
  await page.evaluate((payload) => {
    const dispatch = (
      window as typeof window & { __dispatchSidebarMessage?: (message: unknown) => void }
    ).__dispatchSidebarMessage;
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
    issues.push({
      kind: "requestfailed",
      text: `${request.url()} ${request.failure()?.errorText ?? ""}`
    });
  });
  return issues;
}

function fixtureState(): SidebarFixtureState {
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

function groupedWindowFixtureState(): SidebarFixtureState {
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

function moveToTopLevelFixtureState(): SidebarFixtureState {
  const now = 1_700_000_000_000;
  const spacerIds = Array.from(
    { length: MOVE_TO_TOP_SPACER_COUNT },
    (_value, index) => `group:spacer-${index + 1}`
  );
  return {
    version: 1,
    rootIds: ["window:global", "group:container"],
    nodes: {
      "window:global": {
        id: "window:global",
        kind: "window",
        status: "live",
        title: "Global focused window",
        childIds: ["tab:global-active"],
        active: true,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { windowId: 10 }
      },
      "tab:global-active": {
        id: "tab:global-active",
        kind: "tab",
        status: "live",
        parentId: "window:global",
        title: "Global active tab",
        url: "https://global.example/",
        childIds: [],
        active: true,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { tabId: 10, windowId: 10 }
      },
      "group:container": {
        id: "group:container",
        kind: "group",
        status: "neutral",
        title: "Research group",
        childIds: ["window:42", ...spacerIds],
        collapsed: false,
        createdAt: now,
        updatedAt: now
      },
      "window:42": {
        id: "window:42",
        kind: "window",
        status: "live",
        parentId: "group:container",
        title: "Sidebar scoped window",
        childIds: ["tab:scoped-active"],
        active: false,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { windowId: 42 }
      },
      "tab:scoped-active": {
        id: "tab:scoped-active",
        kind: "tab",
        status: "live",
        parentId: "window:42",
        title: "Scoped active tab",
        url: "https://scoped.example/",
        childIds: [],
        active: true,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { tabId: 420, windowId: 42 }
      },
      ...Object.fromEntries(
        spacerIds.map((id, index) => [
          id,
          {
            id,
            kind: "group" as const,
            status: "neutral" as const,
            parentId: "group:container",
            title: `Spacer ${index + 1}`,
            childIds: [],
            collapsed: false,
            createdAt: now,
            updatedAt: now
          }
        ])
      )
    }
  };
}

function moveScopedWindowToTopLevelPatch(state: SidebarFixtureState) {
  const group = state.nodes["group:container"]!;
  const scopedWindow = state.nodes["window:42"]!;
  const { parentId: _parentId, ...topLevelScopedWindow } = scopedWindow;
  return {
    type: "treeStructureUpdated",
    deletedNodeIds: [],
    updatedNodes: [
      {
        ...group,
        childIds: group.childIds.filter((nodeId) => nodeId !== "window:42")
      },
      topLevelScopedWindow
    ],
    rootIds: ["window:global", "group:container", "window:42"],
    deletedLiveTabCount: 0
  };
}
