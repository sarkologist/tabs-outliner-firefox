import { expect, test, type Page } from "@playwright/test";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

test.describe("sidebar first paint", () => {
  test("paints the initial snapshot before full hydration starts", async ({ page }) => {
    const issues = collectPageIssues(page);
    await page.addInitScript((snapshot) => {
      const messages: Array<{ type: string; at: number }> = [];
      (window as typeof window & { __sidebarBootMessages?: typeof messages }).__sidebarBootMessages = messages;
      window.browser = {
        runtime: {
          sendMessage: async (message: unknown) => {
            const type = typeof message === "object" && message ? String((message as { type?: unknown }).type) : "";
            messages.push({ type, at: performance.now() });
            if (type === "getInitialTreeSnapshot") {
              return structuredClone(snapshot);
            }
            if (type === "getState") {
              return new Promise(() => undefined);
            }
            if (
              type === "getDiagnostics" ||
              type === "getPerformanceTrace" ||
              type === "setPerformanceTraceEnabled" ||
              type === "clearPerformanceTrace"
            ) {
              return undefined;
            }
            return { ok: true };
          },
          onMessage: {
            addListener: () => undefined
          }
        },
        storage: {
          local: {
            get: async () => ({}),
            set: async () => undefined
          }
        }
      };
    }, fixtureInitialSnapshot(50_000));

    await page.goto("/sidebar/sidebar.html");
    await expect(page.locator(".node[data-node-id='tab:1']")).toBeVisible();
    await expect(page.locator("#state-count")).toHaveText("50001 items / 0 saved");

    const metrics = await page.evaluate(() => {
      const messages = (window as typeof window & { __sidebarBootMessages?: Array<{ type: string; at: number }> })
        .__sidebarBootMessages ?? [];
      const firstRowsAt = performance.getEntriesByName("tabs-outliner.boot.firstRows").at(-1)?.startTime;
      const firstHydrationAt = messages.find((message) => message.type === "getState")?.at;
      return {
        firstRowsAt,
        firstHydrationAt,
        initialSnapshotRequests: messages.filter((message) => message.type === "getInitialTreeSnapshot").length,
        visibleRows: document.querySelectorAll(".node").length
      };
    });

    expect(metrics.firstRowsAt).toBeGreaterThan(0);
    expect(metrics.initialSnapshotRequests).toBe(1);
    expect(metrics.visibleRows).toBeGreaterThan(0);
    if (typeof metrics.firstHydrationAt === "number" && typeof metrics.firstRowsAt === "number") {
      expect(metrics.firstRowsAt).toBeLessThan(metrics.firstHydrationAt);
    }
    console.log("sidebar-first-paint", JSON.stringify(metrics));
    expect(issues).toEqual([]);
  });
});

function fixtureInitialSnapshot(tabCount: number) {
  const now = 1_700_000_000_000;
  const loadedTabCount = 255;
  const loadedTabIds = Array.from({ length: loadedTabCount }, (_value, index) => `tab:${index + 1}`);
  const rows = [
    {
      nodeId: "window:1",
      depth: 0,
      index: 0,
      subtreeEndIndex: loadedTabCount + 1,
      childCount: tabCount,
      visibleChildCount: tabCount,
      expanded: true,
      searchRevealsCollapsedChildren: false,
      isSearchMatch: false,
      isSearchPath: false,
      insideActiveWindow: true
    },
    ...loadedTabIds.map((nodeId, index) => ({
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
    revision: 123,
    hydrating: true,
    state: {
      version: 1,
      rootIds: ["window:1"],
      nodes: {
        "window:1": {
          id: "window:1",
          kind: "window",
          status: "live",
          childIds: loadedTabIds,
          title: "Window",
          active: true,
          collapsed: false,
          createdAt: now,
          updatedAt: now,
          live: { windowId: 1 }
        },
        ...Object.fromEntries(
          loadedTabIds.map((id, index) => [
            id,
            {
              id,
              kind: "tab",
              status: "live",
              parentId: "window:1",
              childIds: [],
              title: `Tab ${index + 1}`,
              url: `https://paint.example/${index + 1}`,
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
      nodeCount: tabCount + 1,
      closedCount: 0,
      matchCount: 0
    }
  };
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
