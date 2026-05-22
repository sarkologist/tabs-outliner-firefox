import { expect, test, type Page } from "@playwright/test";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

const TAB_COUNT = 50_000;
const ACTIVE_TAB_ID = 40_000;
const TARGET_NODE_ID = `tab:${ACTIVE_TAB_ID}`;

test.describe("sidebar startup interaction profile", () => {
  test("profiles hover feedback against a sparse startup snapshot while hydration is pending", async ({ page }, testInfo) => {
    const issues = collectPageIssues(page);

    await page.addInitScript(({ snapshot }) => {
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
          },
          connect: () => ({
            onMessage: { addListener: () => undefined },
            onDisconnect: { addListener: () => undefined }
          })
        },
        storage: {
          local: {
            get: async () => ({}),
            set: async () => undefined
          },
          onChanged: {
            addListener: () => undefined
          }
        },
        windows: {
          getCurrent: async () => ({ id: 1 })
        }
      };
    }, {
      snapshot: fixtureActiveCenteredSnapshot(TAB_COUNT, ACTIVE_TAB_ID)
    });

    await page.goto("/sidebar/sidebar.html");
    await expect(page.locator(`.node[data-node-id='${TARGET_NODE_ID}'].is-active`)).toBeVisible();
    await page.waitForFunction(() => Boolean(window.tabsOutlinerProfile));
    await page.evaluate(async () => {
      await window.tabsOutlinerProfile?.enable();
      await window.tabsOutlinerProfile?.clear();
    });

    const result = await page.evaluate(async (targetNodeId) => {
      const row = document.querySelector(`.node[data-node-id="${CSS.escape(targetNodeId)}"] > .node-row`);
      if (!(row instanceof HTMLElement)) {
        throw new Error(`Missing target row for ${targetNodeId}`);
      }

      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new PointerEvent("pointerover", {
        bubbles: true,
        clientX: rect.left + 20,
        clientY: rect.top + rect.height / 2,
        pointerType: "mouse"
      }));

      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

      const snapshot = await window.tabsOutlinerProfile?.snapshot();
      const summary = await window.tabsOutlinerProfile?.summary();
      const entries = snapshot?.sidebar.entries ?? [];
      const pointerEntries = entries.filter((entry) => entry.name === "sidebar.input.pointerDelay");
      const hoverFeedbackEntries = entries.filter((entry) => entry.name === "sidebar.input.hoverFeedbackDelay");
      const hoverFrameEntries = entries.filter((entry) => entry.name === "sidebar.input.hoverFrameDelay");
      const hoverGuideEntries = entries.filter((entry) => entry.name === "sidebar.hoverGuide");
      const messages = (window as typeof window & { __sidebarBootMessages?: Array<{ type: string; at: number }> })
        .__sidebarBootMessages ?? [];
      const tree = document.querySelector<HTMLElement>("#tree");
      const viewport = document.querySelector<HTMLElement>("main");
      const target = document.querySelector<HTMLElement>(`.node[data-node-id="${CSS.escape(targetNodeId)}"]`);

      return {
        targetVisible: Boolean(target && target.offsetParent !== null),
        targetRowIndex: target?.dataset.rowIndex,
        treeHeight: tree?.style.height,
        scrollTop: viewport?.scrollTop ?? 0,
        hydrationRequests: messages.filter((message) => message.type === "getState").length,
        initialSnapshotRequests: messages.filter((message) => message.type === "getInitialTreeSnapshot").length,
        pointerOutcomes: pointerEntries.map((entry) => entry.detail?.outcome ?? "none"),
        clearMissingRowCount: pointerEntries.filter((entry) => entry.detail?.outcome === "clear-missing-row").length,
        hoverFeedbackCount: hoverFeedbackEntries.length,
        hoverFrameCount: hoverFrameEntries.length,
        hoverGuideCount: hoverGuideEntries.length,
        pointerDelay: summary?.find((row) => row.name === "sidebar.input.pointerDelay"),
        hoverFeedbackDelay: summary?.find((row) => row.name === "sidebar.input.hoverFeedbackDelay"),
        hoverFrameDelay: summary?.find((row) => row.name === "sidebar.input.hoverFrameDelay"),
        hoverGuide: summary?.find((row) => row.name === "sidebar.hoverGuide")
      };
    }, TARGET_NODE_ID);

    await testInfo.attach("startup-sparse-hover-profile.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json"
    });
    console.log(`startup-sparse-hover ${JSON.stringify(result)}`);

    expect(result.targetVisible).toBe(true);
    expect(result.initialSnapshotRequests).toBe(1);
    expect(result.hydrationRequests).toBeGreaterThanOrEqual(0);
    expect(result.pointerOutcomes.length).toBeGreaterThan(0);
    expect(result.clearMissingRowCount).toBe(0);
    expect(result.hoverFeedbackCount).toBeGreaterThan(0);
    expect(result.hoverFrameCount).toBeGreaterThan(0);
    expect(result.hoverGuideCount).toBeGreaterThan(0);
    expect(result.hoverFeedbackDelay?.maxMs).toBeLessThan(16);
    expect(result.hoverFrameDelay?.maxMs).toBeLessThan(50);
    expect(issues).toEqual([]);
  });
});

function fixtureActiveCenteredSnapshot(tabCount: number, activeTabId: number) {
  const now = 1_700_000_000_000;
  const rowLimit = 256;
  const startTabId = Math.max(1, activeTabId - Math.floor(rowLimit / 2));
  const tabIds = Array.from(
    { length: Math.min(rowLimit, tabCount - startTabId + 1) },
    (_value, index) => `tab:${startTabId + index}`
  );
  const rows = tabIds.map((nodeId) => {
    const tabId = Number.parseInt(nodeId.slice("tab:".length), 10);
    return {
      nodeId,
      depth: 1,
      index: tabId,
      parentRowIndex: 0,
      subtreeEndIndex: tabId + 1,
      childCount: 0,
      visibleChildCount: 0,
      expanded: true,
      searchRevealsCollapsedChildren: false,
      isSearchMatch: false,
      isSearchPath: false,
      insideActiveWindow: true
    };
  });
  return {
    type: "initialTreeSnapshot",
    version: 1,
    revision: 124,
    hydrating: true,
    state: {
      version: 1,
      rootIds: [],
      nodes: Object.fromEntries(
        tabIds.map((id) => {
          const tabId = Number.parseInt(id.slice("tab:".length), 10);
          return [
            id,
            {
              id,
              kind: "tab",
              status: "live",
              parentId: "window:1",
              childIds: [],
              title: `Tab ${tabId}`,
              url: `https://paint.example/${tabId}`,
              active: tabId === activeTabId,
              collapsed: false,
              createdAt: now,
              updatedAt: now,
              live: { tabId, windowId: 1 }
            }
          ];
        })
      )
    },
    projection: {
      query: "",
      isSearchActive: false,
      rows,
      matchingNodeIds: [],
      visibleNodeIds: rows.map((row) => row.nodeId),
      activeTabNodeId: `tab:${activeTabId}`,
      activeTabRowIndex: activeTabId,
      totalRowCount: tabCount + 1,
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
