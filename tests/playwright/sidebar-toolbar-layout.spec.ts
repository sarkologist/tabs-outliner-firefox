import { expect, test } from "@playwright/test";

// Layout-sensitive change: the toolbar dropped the "Tabs" heading and the happy-path "Firefox N"
// diagnostics line, and now leads with the search box. This drives the real built sidebar so the
// grid resolution (search vs. counter vs. buttons) is exercised, and captures screenshots at the
// narrow docked width and the wide full-size width for visual review.
test.describe("sidebar toolbar layout", () => {
  test("leads with the search box and shows no heading or Firefox line", async ({ page }) => {
    await page.addInitScript((snapshot) => {
      window.browser = {
        runtime: {
          sendMessage: async (message: unknown) => {
            const type =
              typeof message === "object" && message
                ? String((message as { type?: unknown }).type)
                : "";
            if (type === "getInitialTreeSnapshot") {
              return structuredClone(snapshot);
            }
            if (type === "getState") {
              return new Promise(() => undefined);
            }
            if (type === "getDiagnostics") {
              // All-clear: the outline agrees with the browser, so the diagnostics line stays blank.
              return {
                runtimeTabCount: 3,
                liveTabNodeCount: 3,
                visibleLiveTabNodeCount: 3,
                closedTabNodeCount: 0,
                hiddenLiveTabNodeCount: 0,
                missingRuntimeTabIds: []
              };
            }
            return undefined;
          },
          onMessage: { addListener: () => undefined }
        },
        storage: {
          local: { get: async () => ({}), set: async () => undefined }
        }
      };
    }, toolbarFixtureSnapshot());

    await page.setViewportSize({ width: 360, height: 520 });
    await page.goto("/sidebar/sidebar.html");

    await expect(page.locator("#state-count")).toHaveText("20964 items / 20916 saved");
    await expect(page.locator("header.toolbar h1")).toHaveCount(0);
    await expect(page.locator("#diagnostics")).toHaveText("");

    const header = page.locator("header.toolbar");
    const search = page.locator("#search");
    await expect(search).toBeVisible();

    // On the narrow docked sidebar the search box keeps a usable width rather than collapsing to a
    // sliver beside the long item counter.
    const narrowSearch = await search.boundingBox();
    expect(narrowSearch?.width ?? 0).toBeGreaterThan(90);
    await header.screenshot({ path: "test-results/toolbar-narrow-360.png" });

    // On the wide full-size sidebar the search box absorbs the slack instead of leaving a gap.
    await page.setViewportSize({ width: 900, height: 520 });
    const wideSearch = await search.boundingBox();
    expect(wideSearch?.width ?? 0).toBeGreaterThan(narrowSearch?.width ?? 0);
    await header.screenshot({ path: "test-results/toolbar-wide-900.png" });
  });
});

function toolbarFixtureSnapshot() {
  const now = 1_700_000_000_000;
  const tabIds = ["tab:1", "tab:2", "tab:3"];
  const rows = [
    {
      nodeId: "window:1",
      depth: 0,
      index: 0,
      subtreeEndIndex: tabIds.length + 1,
      childCount: tabIds.length,
      visibleChildCount: tabIds.length,
      expanded: true,
      searchRevealsCollapsedChildren: false,
      isSearchMatch: false,
      isSearchPath: false,
      insideActiveWindow: true
    },
    ...tabIds.map((nodeId, index) => ({
      nodeId,
      depth: 1,
      index: index + 1,
      parentRowIndex: 0,
      subtreeEndIndex: index + 2,
      childCount: 0,
      visibleChildCount: 0,
      expanded: true,
      searchRevealsCollapsedChildren: false,
      isSearchMatch: false,
      isSearchPath: false,
      insideActiveWindow: true
    }))
  ];
  return {
    type: "initialTreeSnapshot",
    version: 1,
    revision: 1,
    hydrating: false,
    state: {
      version: 1,
      rootIds: ["window:1"],
      nodes: {
        "window:1": {
          id: "window:1",
          kind: "window",
          status: "live",
          childIds: tabIds,
          title: "Window",
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
              childIds: [],
              title: `Tab ${index + 1}`,
              url: `https://example.test/${index + 1}`,
              active: index === 0,
              collapsed: false,
              createdAt: now,
              updatedAt: now,
              live: { tabId: index + 1, windowId: 1 }
            }
          ])
        )
      }
    },
    projection: {
      query: "",
      isSearchActive: false,
      rows,
      matchingNodeIds: [],
      visibleNodeIds: rows.map((row) => row.nodeId),
      activeTabNodeId: "tab:1",
      activeTabRowIndex: 1,
      totalRowCount: tabIds.length + 1,
      // Representative of a large saved session so the counter is long enough to compete with the
      // search box for width.
      nodeCount: 20964,
      closedCount: 20916,
      matchCount: 0
    }
  };
}
