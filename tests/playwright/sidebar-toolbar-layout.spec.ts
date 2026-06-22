import { expect, test, type Page } from "@playwright/test";
import type { OutlineDiagnostics } from "../../src/background/diagnostics";

// The outline agrees with the browser: the diagnostics line must render nothing (no "Firefox N").
const ALL_CLEAR: OutlineDiagnostics = {
  runtimeTabCount: 3,
  liveTabNodeCount: 3,
  visibleLiveTabNodeCount: 3,
  closedTabNodeCount: 0,
  hiddenLiveTabNodeCount: 0,
  missingRuntimeTabIds: [],
  missingRuntimeTabs: []
};

// The browser reports two tabs the outline no longer holds: a data-integrity warning that must stay
// visible even though the happy path was decluttered.
const MISSING_TABS: OutlineDiagnostics = {
  runtimeTabCount: 41,
  liveTabNodeCount: 39,
  visibleLiveTabNodeCount: 39,
  closedTabNodeCount: 0,
  hiddenLiveTabNodeCount: 0,
  missingRuntimeTabIds: [7, 8],
  missingRuntimeTabs: [
    { id: 7, windowId: 1 },
    { id: 8, windowId: 1 }
  ]
};

// Layout-sensitive change: the toolbar dropped the "Tabs" heading and the happy-path "Firefox N"
// diagnostics line, and now leads with the search box. These tests drive the real built sidebar so
// the grid resolution (search vs. counter vs. buttons) and the diagnostics wiring are exercised, and
// capture screenshots at the narrow docked width and the wide full-size width for visual review.
test.describe("sidebar toolbar layout", () => {
  test("leads with search; counter ellipsizes narrow and fills wide; no heading or Firefox line", async ({
    page
  }) => {
    const pageErrors = collectPageErrors(page);
    await installSidebarRuntime(page, ALL_CLEAR);

    await page.setViewportSize({ width: 360, height: 520 });
    await page.goto("/sidebar/sidebar.html");

    await expect(page.locator("#state-count")).toHaveText("20964 / 48");
    // The toolbar shows just the numbers; the explanatory words live in the hover tooltip.
    await expect(page.locator("#state-count")).toHaveAttribute(
      "title",
      "20964 items · 48 open tabs"
    );
    await expect(page.locator("header.toolbar h1")).toHaveCount(0);

    // The diagnostics line actually loaded and rendered blank -- not merely "not yet loaded".
    await triggerDiagnosticsLoad(page);
    await expect(page.locator("#diagnostics")).toHaveText("");

    const search = page.locator("#search");
    await expect(search).toBeVisible();

    // The compact numeric counter fits without clipping even on the narrow docked sidebar, leaving
    // the search box a usable width.
    const narrowSearch = await search.boundingBox();
    expect(narrowSearch?.width ?? 0).toBeGreaterThan(90);
    expect(await isClipped(page, "#state-count")).toBe(false);
    await page
      .locator("header.toolbar")
      .screenshot({ path: "test-results/toolbar-narrow-360.png" });

    // On the wide full-size sidebar the search absorbs the slack and the counter stays fully visible.
    await page.setViewportSize({ width: 900, height: 520 });
    const wideSearch = await search.boundingBox();
    expect(wideSearch?.width ?? 0).toBeGreaterThan(narrowSearch?.width ?? 0);
    expect(await isClipped(page, "#state-count")).toBe(false);
    await page.locator("header.toolbar").screenshot({ path: "test-results/toolbar-wide-900.png" });

    expect(pageErrors).toEqual([]);
  });

  test("still surfaces the missing-tab data-integrity warning", async ({ page }) => {
    const pageErrors = collectPageErrors(page);
    await installSidebarRuntime(page, MISSING_TABS);

    await page.setViewportSize({ width: 360, height: 520 });
    await page.goto("/sidebar/sidebar.html");
    await expect(page.locator("#state-count")).toHaveText("20964 / 48");

    // Decluttering the all-clear case must not silence warnings -- this is the data-loss signal.
    await triggerDiagnosticsLoad(page);
    await expect(page.locator("#diagnostics")).toHaveText("41 live / outline 39 / missing 2");
    await expect(page.locator("#diagnostics")).not.toContainText("Firefox");

    expect(pageErrors).toEqual([]);
  });
});

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

async function installSidebarRuntime(page: Page, diagnostics: OutlineDiagnostics): Promise<void> {
  await page.addInitScript(
    ({ snapshot, diagnostics: diagnosticsResult }) => {
      const messageTypes: string[] = [];
      (window as typeof window & { __messageTypes?: string[] }).__messageTypes = messageTypes;
      window.browser = {
        runtime: {
          sendMessage: async (message: unknown) => {
            const type =
              typeof message === "object" && message
                ? String((message as { type?: unknown }).type)
                : "";
            messageTypes.push(type);
            if (type === "getInitialTreeSnapshot") {
              return structuredClone(snapshot);
            }
            if (type === "getState") {
              return new Promise(() => undefined);
            }
            if (type === "getDiagnostics") {
              return structuredClone(diagnosticsResult);
            }
            return undefined;
          },
          onMessage: { addListener: () => undefined }
        },
        storage: {
          local: { get: async () => ({}), set: async () => undefined }
        }
      };
    },
    { snapshot: toolbarFixtureSnapshot(), diagnostics }
  );
}

// Dispatching visibilitychange while the document is visible runs the sidebar's scheduleLoad, which
// round-trips getDiagnostics after its debounce. Awaiting the recorded call makes the subsequent
// textContent assertion meaningful (the line loaded), not just "still default".
async function triggerDiagnosticsLoad(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as typeof window & { __messageTypes?: string[] }).__messageTypes?.filter(
              (type) => type === "getDiagnostics"
            ).length ?? 0
        ),
      { timeout: 9000 }
    )
    .toBeGreaterThan(0);
}

async function isClipped(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).evaluate((element) => element.scrollWidth > element.clientWidth);
}

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
      liveTabCount: 48,
      matchCount: 0
    }
  };
}
