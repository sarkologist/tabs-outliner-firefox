import { expect, test, type Page } from "@playwright/test";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

const TAB_COUNT = 50_000;
const ACTIVE_TAB_ID = 40_000;
const TARGET_NODE_ID = `tab:${ACTIVE_TAB_ID}`;
const SCROLL_AWAY_ROW_INDEX = 10_000;
const FOLLOW_ON_SCROLL_DELTA_ROWS = 32;

test.describe("sidebar startup scroll-away profile", () => {
  test("profiles scrolling outside the sparse startup projection before hydration", async ({
    page
  }, testInfo) => {
    const issues = collectPageIssues(page);

    await page.addInitScript(
      ({ activeTabId, tabCount }) => {
        window.localStorage.setItem("tabsOutlinerProfileEnabled", "true");
        const messages: Array<{
          type: string;
          at: number;
          centerRowIndex?: number;
          rowLimit?: number;
        }> = [];
        (
          window as typeof window & { __sidebarBootMessages?: typeof messages }
        ).__sidebarBootMessages = messages;
        const fixtureSparseSnapshotWindow = (centerRowIndex: number, requestedRowLimit = 256) => {
          const now = 1_700_000_000_000;
          const rowLimit = Math.max(1, Math.min(256, Math.floor(requestedRowLimit)));
          const halfWindow = Math.floor(rowLimit / 2);
          const center = Math.max(1, Math.min(tabCount, Math.floor(centerRowIndex)));
          const endRowIndex = Math.min(tabCount + 1, center + halfWindow);
          const startTabId = Math.max(1, Math.min(center - halfWindow, endRowIndex - rowLimit));
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
        };
        window.browser = {
          runtime: {
            sendMessage: async (message: unknown) => {
              const type =
                typeof message === "object" && message
                  ? String((message as { type?: unknown }).type)
                  : "";
              const centerRowIndex =
                typeof message === "object" && message
                  ? Number((message as { centerRowIndex?: unknown }).centerRowIndex)
                  : Number.NaN;
              const rowLimit =
                typeof message === "object" && message
                  ? Number((message as { rowLimit?: unknown }).rowLimit)
                  : Number.NaN;
              messages.push({
                type,
                at: performance.now(),
                ...(Number.isFinite(centerRowIndex) ? { centerRowIndex } : {}),
                ...(Number.isFinite(rowLimit) ? { rowLimit } : {})
              });
              if (type === "getInitialTreeSnapshot") {
                return fixtureSparseSnapshotWindow(activeTabId);
              }
              if (type === "getInitialTreeSnapshotWindow" || type === "getTreeProjectionSlice") {
                return fixtureSparseSnapshotWindow(
                  Number.isFinite(centerRowIndex) ? centerRowIndex : activeTabId,
                  rowLimit
                );
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
      },
      {
        activeTabId: ACTIVE_TAB_ID,
        tabCount: TAB_COUNT
      }
    );

    await page.goto("/sidebar/sidebar.html");
    await expect(page.locator(`.node[data-node-id='${TARGET_NODE_ID}'].is-active`)).toBeVisible();
    await page.waitForFunction(() => Boolean(window.tabsOutlinerProfile));
    await page.evaluate(async () => {
      await window.tabsOutlinerProfile?.clear();
    });

    const result = await page.evaluate(
      async ({ targetRowIndex, followOnDeltaRows }) => {
        const viewport = document.querySelector<HTMLElement>("main");
        const tree = document.querySelector<HTMLElement>("#tree");
        if (!viewport || !tree) {
          throw new Error("Missing sidebar viewport");
        }

        const rowHeight = Number.parseFloat(
          window.getComputedStyle(document.documentElement).getPropertyValue("--node-row-height")
        );
        const effectiveRowHeight = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 18;
        const renderedRowIndexes = () =>
          [...document.querySelectorAll<HTMLElement>(".node")]
            .map((node) => Number.parseInt(node.dataset.rowIndex ?? "", 10))
            .filter((index) => Number.isFinite(index));
        const viewportRenderedRows = () => {
          const viewportTop = viewport.scrollTop;
          const viewportBottom = viewportTop + viewport.clientHeight;
          return renderedRowIndexes()
            .map((index) => ({
              index,
              top: index * effectiveRowHeight,
              bottom: (index + 1) * effectiveRowHeight
            }))
            .filter((row) => row.bottom > viewportTop && row.top < viewportBottom);
        };
        const targetScrollTop = targetRowIndex * effectiveRowHeight;
        const beforeIndexes = renderedRowIndexes();
        const startedAt = performance.now();
        viewport.scrollTop = targetScrollTop;
        viewport.dispatchEvent(new Event("scroll", { bubbles: true }));

        let rowsVisibleAt: number | undefined;
        for (let frame = 0; frame < 2; frame += 1) {
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
          if (rowsVisibleAt === undefined && viewportRenderedRows().length > 0) {
            rowsVisibleAt = performance.now();
          }
        }

        const afterRows = viewportRenderedRows();
        const viewportStartRow = Math.floor(viewport.scrollTop / effectiveRowHeight);
        const viewportEndRow = Math.ceil(
          (viewport.scrollTop + viewport.clientHeight) / effectiveRowHeight
        );
        const expectedViewportRows = Math.max(0, viewportEndRow - viewportStartRow);
        const visibleRowIndexes = afterRows.map((row) => row.index);
        const messages =
          (
            window as typeof window & {
              __sidebarBootMessages?: Array<{
                type: string;
                at: number;
                centerRowIndex?: number;
                rowLimit?: number;
              }>;
            }
          ).__sidebarBootMessages ?? [];
        const sparseWindowMessages = messages.filter(
          (message) =>
            message.type === "getInitialTreeSnapshotWindow" ||
            message.type === "getTreeProjectionSlice"
        );
        const sparseWindowRequestsBeforeFollowOn = sparseWindowMessages.length;
        const snapshot = await window.tabsOutlinerProfile?.snapshot();
        const summary = await window.tabsOutlinerProfile?.summary();
        const entries = snapshot?.sidebar.entries ?? [];

        const followOnTargetRowIndex = targetRowIndex + followOnDeltaRows;
        const followOnStartedAt = performance.now();
        viewport.scrollTop = followOnTargetRowIndex * effectiveRowHeight;
        viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
        let followOnRowsVisibleAt: number | undefined;
        if (viewportRenderedRows().length > 0) {
          followOnRowsVisibleAt = performance.now();
        }
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        if (followOnRowsVisibleAt === undefined && viewportRenderedRows().length > 0) {
          followOnRowsVisibleAt = performance.now();
        }

        const followOnRows = viewportRenderedRows();
        const followOnViewportStartRow = Math.floor(viewport.scrollTop / effectiveRowHeight);
        const followOnViewportEndRow = Math.ceil(
          (viewport.scrollTop + viewport.clientHeight) / effectiveRowHeight
        );
        const followOnExpectedViewportRows = Math.max(
          0,
          followOnViewportEndRow - followOnViewportStartRow
        );
        const sparseWindowRequestsAfterFollowOn = messages.filter(
          (message) =>
            message.type === "getInitialTreeSnapshotWindow" ||
            message.type === "getTreeProjectionSlice"
        ).length;

        return {
          targetRowIndex,
          targetScrollTop,
          actualScrollTop: viewport.scrollTop,
          rowHeight: effectiveRowHeight,
          viewportStartRow,
          viewportEndRow,
          expectedViewportRows,
          initialRenderedMinRow: Math.min(...beforeIndexes),
          initialRenderedMaxRow: Math.max(...beforeIndexes),
          visibleRowsAfterScroll: afterRows.length,
          visibleRowIndexes,
          missingViewportRows: Math.max(0, expectedViewportRows - afterRows.length),
          rowsVisibleMs: typeof rowsVisibleAt === "number" ? rowsVisibleAt - startedAt : undefined,
          followOnDeltaRows,
          followOnTargetRowIndex,
          followOnViewportStartRow,
          followOnViewportEndRow,
          followOnExpectedViewportRows,
          followOnVisibleRowsAfterScroll: followOnRows.length,
          followOnVisibleRowIndexes: followOnRows.map((row) => row.index),
          followOnMissingViewportRows: Math.max(
            0,
            followOnExpectedViewportRows - followOnRows.length
          ),
          followOnRowsVisibleMs:
            typeof followOnRowsVisibleAt === "number"
              ? followOnRowsVisibleAt - followOnStartedAt
              : undefined,
          followOnSparseWindowRequests:
            sparseWindowRequestsAfterFollowOn - sparseWindowRequestsBeforeFollowOn,
          waitedMs: performance.now() - startedAt,
          hydrationRequests: messages.filter((message) => message.type === "getState").length,
          initialSnapshotRequests: messages.filter(
            (message) => message.type === "getInitialTreeSnapshot"
          ).length,
          sparseWindowRequests: sparseWindowMessages.length,
          sparseWindowCenterRows: sparseWindowMessages
            .map((message) => message.centerRowIndex)
            .filter(
              (index): index is number => typeof index === "number" && Number.isFinite(index)
            ),
          sparseWindowRowLimits: sparseWindowMessages
            .map((message) => message.rowLimit)
            .filter(
              (rowLimit): rowLimit is number =>
                typeof rowLimit === "number" && Number.isFinite(rowLimit)
            ),
          treeHeight: tree.style.height,
          scrollDelay: summary?.find((row) => row.name === "sidebar.input.scrollDelay"),
          scrollDelayEntries: entries
            .filter((entry) => entry.name === "sidebar.input.scrollDelay")
            .map((entry) => ({
              durationMs: entry.durationMs,
              detail: entry.detail
            }))
        };
      },
      {
        followOnDeltaRows: FOLLOW_ON_SCROLL_DELTA_ROWS,
        targetRowIndex: SCROLL_AWAY_ROW_INDEX
      }
    );

    await testInfo.attach("startup-scroll-away-profile.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json"
    });
    console.log(`startup-scroll-away ${JSON.stringify(result)}`);

    expect(result.initialSnapshotRequests).toBe(1);
    expect(result.sparseWindowRequests).toBeGreaterThanOrEqual(1);
    expect(Math.max(...result.sparseWindowRowLimits)).toBeLessThanOrEqual(256);
    expect(result.hydrationRequests).toBe(0);
    expect(result.actualScrollTop).toBeGreaterThan(0);
    expect(result.initialRenderedMinRow).toBeLessThan(ACTIVE_TAB_ID);
    expect(result.initialRenderedMaxRow).toBeGreaterThan(ACTIVE_TAB_ID);
    expect(result.visibleRowsAfterScroll).toBe(result.expectedViewportRows);
    expect(result.rowsVisibleMs).toBeLessThan(32);
    expect(issues).toEqual([]);
  });
});

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
