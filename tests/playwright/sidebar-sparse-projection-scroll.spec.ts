import { expect, test, type Page } from "@playwright/test";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

test.describe("sidebar sparse projection scrolling", () => {
  test("paints a fetched middle slice without requiring a second scroll", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page);

    const result = await page.evaluate(async () => {
      const viewport = document.querySelector<HTMLElement>("main");
      if (!viewport) {
        throw new Error("Missing sidebar viewport");
      }
      const rowHeight = (() => {
        const parsed = Number.parseFloat(
          window.getComputedStyle(document.documentElement).getPropertyValue("--node-row-height")
        );
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 18;
      })();
      const targetRowIndex = 250;
      const visibleRows = () => {
        const viewportTop = viewport.scrollTop;
        const viewportBottom = viewportTop + viewport.clientHeight;
        return [...document.querySelectorAll<HTMLElement>(".node")]
          .map((node) => Number.parseInt(node.dataset.rowIndex ?? "", 10))
          .filter((index) => Number.isFinite(index))
          .filter((index) => {
            const top = index * rowHeight;
            const bottom = (index + 1) * rowHeight;
            return bottom > viewportTop && top < viewportBottom;
          });
      };
      const treeHeightRows = () => {
        const tree = document.querySelector<HTMLElement>("#tree");
        return tree ? Math.round(tree.getBoundingClientRect().height / rowHeight) : 0;
      };
      const nextFrame = async () => {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      };
      const waitForSparseRequest = async () => {
        await (window as typeof window & { __waitForSparseRequest?: () => Promise<void> }).__waitForSparseRequest?.();
      };
      const resolveNextSparseSlice = () => {
        (window as typeof window & { __resolveNextSparseSlice?: () => void }).__resolveNextSparseSlice?.();
      };
      const sparseRequestCount = () =>
        (window as typeof window & { __sparseRequestCount?: () => number }).__sparseRequestCount?.() ?? 0;

      await nextFrame();
      await nextFrame();
      viewport.scrollTop = targetRowIndex * rowHeight;
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
      await waitForSparseRequest();
      await nextFrame();
      const beforeResolveRows = visibleRows();
      const beforeResolveTreeHeightRows = treeHeightRows();
      const requestsBeforeResolve = sparseRequestCount();
      resolveNextSparseSlice();
      await nextFrame();
      await nextFrame();

      return {
        beforeResolveRows,
        beforeResolveTreeHeightRows,
        afterResolveRows: visibleRows(),
        requestsBeforeResolve,
        requestsAfterResolve: sparseRequestCount()
      };
    });

    expect(result.beforeResolveRows).toEqual([]);
    expect(result.beforeResolveTreeHeightRows).toBe(1_001);
    expect(result.requestsBeforeResolve).toBe(1);
    expect(result.afterResolveRows.length).toBeGreaterThan(0);
    expect(Math.min(...result.afterResolveRows)).toBeLessThanOrEqual(250);
    expect(Math.max(...result.afterResolveRows)).toBeGreaterThanOrEqual(250);
    expect(result.requestsAfterResolve).toBe(1);
    expect(issues).toEqual([]);
  });

  test("uses an older sparse response if it still covers the current scrollbar jump", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page);

    const result = await page.evaluate(async () => {
      const viewport = document.querySelector<HTMLElement>("main");
      if (!viewport) {
        throw new Error("Missing sidebar viewport");
      }
      const rowHeight = (() => {
        const parsed = Number.parseFloat(
          window.getComputedStyle(document.documentElement).getPropertyValue("--node-row-height")
        );
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 18;
      })();
      const visibleRows = () => {
        const viewportTop = viewport.scrollTop;
        const viewportBottom = viewportTop + viewport.clientHeight;
        return [...document.querySelectorAll<HTMLElement>(".node")]
          .map((node) => Number.parseInt(node.dataset.rowIndex ?? "", 10))
          .filter((index) => Number.isFinite(index))
          .filter((index) => {
            const top = index * rowHeight;
            const bottom = (index + 1) * rowHeight;
            return bottom > viewportTop && top < viewportBottom;
          });
      };
      const nextFrame = async () => {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      };
      const waitForSparseRequestCount = async (count: number) => {
        await (window as typeof window & {
          __waitForSparseRequestCount?: (count: number) => Promise<void>;
        }).__waitForSparseRequestCount?.(count);
      };
      const resolveSparseSliceAt = (index: number) => {
        (window as typeof window & { __resolveSparseSliceAt?: (index: number) => void }).__resolveSparseSliceAt?.(index);
      };
      const sparseRequestCount = () =>
        (window as typeof window & { __sparseRequestCount?: () => number }).__sparseRequestCount?.() ?? 0;

      await nextFrame();
      await nextFrame();
      viewport.scrollTop = 250 * rowHeight;
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
      await waitForSparseRequestCount(1);

      viewport.scrollTop = 258 * rowHeight;
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
      await waitForSparseRequestCount(2);
      await nextFrame();
      const beforeResolveRows = visibleRows();

      resolveSparseSliceAt(0);
      await nextFrame();
      await nextFrame();

      return {
        beforeResolveRows,
        afterFirstResolveRows: visibleRows(),
        requestsAfterFirstResolve: sparseRequestCount()
      };
    });

    expect(result.beforeResolveRows).toEqual([]);
    expect(result.requestsAfterFirstResolve).toBe(2);
    expect(result.afterFirstResolveRows.length).toBeGreaterThan(0);
    expect(Math.min(...result.afterFirstResolveRows)).toBeLessThanOrEqual(258);
    expect(Math.max(...result.afterFirstResolveRows)).toBeGreaterThanOrEqual(258);
    expect(issues).toEqual([]);
  });

  test("paints an intersecting stale search response during a fast scrollbar jump", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page);

    const result = await page.evaluate(async () => {
      const viewport = document.querySelector<HTMLElement>("main");
      const search = document.querySelector<HTMLInputElement>("#search");
      if (!viewport || !search) {
        throw new Error("Missing sidebar viewport or search input");
      }
      const rowHeight = (() => {
        const parsed = Number.parseFloat(
          window.getComputedStyle(document.documentElement).getPropertyValue("--node-row-height")
        );
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 18;
      })();
      const visibleRows = () => {
        const viewportTop = viewport.scrollTop;
        const viewportBottom = viewportTop + viewport.clientHeight;
        return [...document.querySelectorAll<HTMLElement>(".node")]
          .map((node) => Number.parseInt(node.dataset.rowIndex ?? "", 10))
          .filter((index) => Number.isFinite(index))
          .filter((index) => {
            const top = index * rowHeight;
            const bottom = (index + 1) * rowHeight;
            return bottom > viewportTop && top < viewportBottom;
          });
      };
      const nextFrame = async () => {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      };
      const waitForSparseRequestCount = async (count: number) => {
        await (window as typeof window & {
          __waitForSparseRequestCount?: (count: number) => Promise<void>;
        }).__waitForSparseRequestCount?.(count);
      };
      const resolveSparseSliceAt = (index: number) => {
        (window as typeof window & { __resolveSparseSliceAt?: (index: number) => void }).__resolveSparseSliceAt?.(index);
      };
      const sparseRequestCount = () =>
        (window as typeof window & { __sparseRequestCount?: () => number }).__sparseRequestCount?.() ?? 0;

      search.focus();
      search.value = "needle";
      search.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "needle"
      }));
      await waitForSparseRequestCount(1);
      resolveSparseSliceAt(0);
      await nextFrame();
      await nextFrame();
      const requestsAfterSearch = sparseRequestCount();

      viewport.scrollTop = 330 * rowHeight;
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
      await waitForSparseRequestCount(requestsAfterSearch + 1);

      viewport.scrollTop = 380 * rowHeight;
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
      await waitForSparseRequestCount(requestsAfterSearch + 2);
      await nextFrame();
      const beforeResolveRows = visibleRows();

      resolveSparseSliceAt(0);
      await nextFrame();
      await nextFrame();

      return {
        beforeResolveRows,
        afterFirstResolveRows: visibleRows(),
        requestsAfterFirstResolve: sparseRequestCount()
      };
    });

    expect(result.beforeResolveRows).toEqual([]);
    expect(result.requestsAfterFirstResolve).toBe(3);
    expect(result.afterFirstResolveRows.length).toBeGreaterThan(0);
    expect(Math.min(...result.afterFirstResolveRows)).toBeLessThanOrEqual(380);
    expect(Math.max(...result.afterFirstResolveRows)).toBeGreaterThanOrEqual(380);
    expect(issues).toEqual([]);
  });

  test("does not refetch forever when the bottom viewport rounds past total rows", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page);

    const result = await page.evaluate(async () => {
      const viewport = document.querySelector<HTMLElement>("main");
      if (!viewport) {
        throw new Error("Missing sidebar viewport");
      }
      const rowHeight = (() => {
        const parsed = Number.parseFloat(
          window.getComputedStyle(document.documentElement).getPropertyValue("--node-row-height")
        );
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 18;
      })();
      const waitForSparseRequestCount = async (count: number) => {
        await (window as typeof window & {
          __waitForSparseRequestCount?: (count: number) => Promise<void>;
        }).__waitForSparseRequestCount?.(count);
      };
      const resolveSparseSliceAt = (index: number) => {
        (window as typeof window & { __resolveSparseSliceAt?: (index: number) => void }).__resolveSparseSliceAt?.(index);
      };
      const sparseRequestCount = () =>
        (window as typeof window & { __sparseRequestCount?: () => number }).__sparseRequestCount?.() ?? 0;
      const nextFrame = async () => {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      };

      Object.defineProperty(viewport, "clientHeight", {
        configurable: true,
        value: 52 * rowHeight
      });
      viewport.scrollTop = (1_001 - 51) * rowHeight;
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
      await waitForSparseRequestCount(1);

      resolveSparseSliceAt(0);
      await nextFrame();
      await nextFrame();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 80));

      return {
        requestCount: sparseRequestCount(),
        visibleRows: [...document.querySelectorAll<HTMLElement>(".node")]
          .map((node) => Number.parseInt(node.dataset.rowIndex ?? "", 10))
          .filter((index) => Number.isFinite(index))
      };
    });

    expect(result.requestCount).toBe(1);
    expect(Math.max(...result.visibleRows)).toBe(1_000);
    expect(issues).toEqual([]);
  });
});

async function loadSidebar(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const now = 1_700_000_000_000;
    const totalRows = 1_001;
    const activeTabId = 800;
    const sparseRequests: Array<{ centerRowIndex: number; rowLimit: number; query: string }> = [];
    const runtimeMessages: string[] = [];
    const pendingResponses: Array<{
      request: { centerRowIndex: number; rowLimit: number; query: string };
      resolve: (value: unknown) => void;
    }> = [];

    Object.assign(window as typeof window & {
      __sparseRequestCount?: () => number;
      __waitForSparseRequest?: () => Promise<void>;
      __waitForSparseRequestCount?: (count: number) => Promise<void>;
      __waitForRuntimeMessage?: (type: string) => Promise<void>;
      __resolveNextSparseSlice?: () => void;
      __resolveSparseSliceAt?: (index: number) => void;
    }, {
      __sparseRequestCount: () => sparseRequests.length,
      __waitForSparseRequest: async () => {
        await (window as typeof window & {
          __waitForSparseRequestCount?: (count: number) => Promise<void>;
        }).__waitForSparseRequestCount?.(1);
      },
      __waitForSparseRequestCount: async (count: number) => {
        for (let index = 0; index < 60; index += 1) {
          if (sparseRequests.length >= count) {
            return;
          }
          await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
        }
        throw new Error(`Timed out waiting for ${count} sparse slice request(s)`);
      },
      __waitForRuntimeMessage: async (expectedType: string) => {
        for (let index = 0; index < 60; index += 1) {
          if (runtimeMessages.includes(expectedType)) {
            return;
          }
          await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
        }
        throw new Error(`Timed out waiting for runtime message ${expectedType}`);
      },
      __resolveNextSparseSlice: () => {
        const index = pendingResponses.length - 1;
        (window as typeof window & { __resolveSparseSliceAt?: (index: number) => void }).__resolveSparseSliceAt?.(index);
      },
      __resolveSparseSliceAt: (index: number) => {
        const pending = pendingResponses[index];
        if (!pending) {
          throw new Error(`No sparse slice request at index ${index}`);
        }
        pendingResponses.splice(index, 1);
        pending.resolve(sliceSnapshot(pending.request.centerRowIndex, pending.request.rowLimit, pending.request.query));
      }
    });

    window.browser = {
      runtime: {
        sendMessage: async (message: unknown) => {
          const type = typeof message === "object" && message ? String((message as { type?: unknown }).type) : "";
          runtimeMessages.push(type);
          if (type === "getInitialTreeSnapshot") {
            return initialSnapshot();
          }
          if (type === "getTreeProjectionSlice") {
            const centerRowIndex = Number((message as { centerRowIndex?: unknown }).centerRowIndex);
            const rowLimit = Number((message as { rowLimit?: unknown }).rowLimit);
            const query = typeof (message as { query?: unknown }).query === "string"
              ? (message as { query: string }).query
              : "";
            const request = { centerRowIndex, rowLimit, query };
            sparseRequests.push(request);
            return new Promise((resolve) => {
              pendingResponses.push({ request, resolve });
            });
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
          return { type: "commandAck", stateChanged: false };
        },
        onMessage: {
          addListener: () => undefined
        },
        openOptionsPage: async () => undefined
      },
      storage: {
        local: {
          get: async () => ({}),
          set: async () => undefined
        },
        onChanged: {
          addListener: () => undefined
        }
      }
    };

    function initialSnapshot() {
      const rows = [
        windowRow(),
        ...tabRows(760, 840)
      ];
      return snapshotFromRows(rows);
    }

    function sliceSnapshot(centerRowIndex: number, rowLimit: number, query = "") {
      const half = Math.floor(Math.max(1, rowLimit) / 2);
      const start = Math.max(query ? 0 : 1, Math.floor(centerRowIndex) - half);
      const end = Math.min(totalRows, start + Math.max(1, Math.floor(rowLimit)));
      return snapshotFromRows(query ? searchRows(start, end) : tabRows(start, end), query);
    }

    function snapshotFromRows(rows: Array<Record<string, unknown> & { nodeId: string }>, query = "") {
      return {
        type: "initialTreeSnapshot",
        version: 1,
        revision: 1,
        hydrating: true,
        state: {
          version: 1,
          rootIds: ["window:1"],
          nodes: Object.fromEntries([
            ["window:1", windowNode()],
            ...rows
              .filter((row) => row.nodeId.startsWith("tab:") || row.nodeId.startsWith("search:"))
              .map((row) => {
                const tabId = Number.parseInt(row.nodeId.split(":")[1] ?? "", 10);
                return [row.nodeId, query ? searchNode(tabId) : tabNode(tabId)];
              })
          ])
        },
        projection: {
          query,
          isSearchActive: Boolean(query),
          rows,
          matchingNodeIds: query ? rows.map((row) => row.nodeId) : [],
          visibleNodeIds: rows.map((row) => row.nodeId),
          activeTabNodeId: `tab:${activeTabId}`,
          activeTabRowIndex: activeTabId,
          totalRowCount: totalRows,
          nodeCount: totalRows,
          closedCount: query ? totalRows : 0,
          matchCount: query ? totalRows : 0
        },
        coverage: {
          startRowIndex: Math.min(...rows.map((row) => Number(row.index))),
          endRowIndex: Math.max(...rows.map((row) => Number(row.index))) + 1,
          editableNodeIds: rows.map((row) => row.nodeId),
          completeSubtreeNodeIds: rows.map((row) => row.nodeId),
          completeSiblingParentIds: ["window:1"]
        }
      };
    }

    function windowNode() {
      return {
        id: "window:1",
        kind: "window",
        status: "live",
        title: "Window",
        active: true,
        collapsed: false,
        childIds: Array.from({ length: totalRows - 1 }, (_value, index) => `tab:${index + 1}`),
        createdAt: now,
        updatedAt: now,
        live: { windowId: 1 }
      };
    }

    function tabNode(tabId: number) {
      return {
        id: `tab:${tabId}`,
        kind: "tab",
        status: "live",
        parentId: "window:1",
        title: `Tab ${tabId}`,
        url: `https://sparse.example/${tabId}`,
        active: tabId === activeTabId,
        collapsed: false,
        childIds: [],
        createdAt: now,
        updatedAt: now,
        live: { tabId, windowId: 1 }
      };
    }

    function searchNode(rowIndex: number) {
      return {
        id: `search:${rowIndex}`,
        kind: "tab",
        status: "closed",
        title: `Needle ${rowIndex}`,
        url: `https://search.example/${rowIndex}`,
        active: false,
        collapsed: false,
        childIds: [],
        createdAt: now,
        updatedAt: now,
        closedAt: now + rowIndex,
        restore: {
          url: `https://search.example/${rowIndex}`,
          title: `Needle ${rowIndex}`
        }
      };
    }

    function windowRow() {
      return {
        nodeId: "window:1",
        depth: 0,
        index: 0,
        subtreeEndIndex: totalRows,
        childCount: totalRows - 1,
        visibleChildCount: totalRows - 1,
        expanded: true,
        searchRevealsCollapsedChildren: false,
        isSearchMatch: false,
        isSearchPath: false,
        insideActiveWindow: false
      };
    }

    function tabRows(startInclusive: number, endExclusive: number) {
      return Array.from({ length: Math.max(0, endExclusive - startInclusive) }, (_value, index) => {
        const tabId = startInclusive + index;
        return {
          nodeId: `tab:${tabId}`,
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
    }

    function searchRows(startInclusive: number, endExclusive: number) {
      return Array.from({ length: Math.max(0, endExclusive - startInclusive) }, (_value, index) => {
        const rowIndex = startInclusive + index;
        return {
          nodeId: `search:${rowIndex}`,
          depth: 0,
          index: rowIndex,
          subtreeEndIndex: rowIndex + 1,
          childCount: 0,
          visibleChildCount: 0,
          expanded: true,
          searchRevealsCollapsedChildren: false,
          isSearchMatch: true,
          isSearchPath: false,
          insideActiveWindow: true
        };
      });
    }
  });

  await page.goto("/sidebar/sidebar.html");
  await expect(page.locator(".node[data-node-id='tab\\:800'].is-active")).toBeVisible();
  await page.evaluate(async () => {
    await (window as typeof window & {
      __waitForRuntimeMessage?: (type: string) => Promise<void>;
    }).__waitForRuntimeMessage?.("getHistoryStatus");
  });
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
