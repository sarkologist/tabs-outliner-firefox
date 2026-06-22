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
        await (
          window as typeof window & { __waitForSparseRequest?: () => Promise<void> }
        ).__waitForSparseRequest?.();
      };
      const resolveNextSparseSlice = () => {
        (
          window as typeof window & { __resolveNextSparseSlice?: () => void }
        ).__resolveNextSparseSlice?.();
      };
      const sparseRequestCount = () =>
        (
          window as typeof window & { __sparseRequestCount?: () => number }
        ).__sparseRequestCount?.() ?? 0;

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

  test("keeps manual scroll position when a sparse slice replaces the active slice", async ({
    page
  }) => {
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
      const waitForSparseRequest = async () => {
        await (
          window as typeof window & { __waitForSparseRequest?: () => Promise<void> }
        ).__waitForSparseRequest?.();
      };
      const resolveNextSparseSlice = () => {
        (
          window as typeof window & { __resolveNextSparseSlice?: () => void }
        ).__resolveNextSparseSlice?.();
      };
      const nextFrame = async () => {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      };

      const targetScrollTop = 250 * rowHeight;
      viewport.scrollTop = targetScrollTop;
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
      await waitForSparseRequest();
      const beforeResolveScrollTop = viewport.scrollTop;

      resolveNextSparseSlice();
      await nextFrame();
      await nextFrame();

      return {
        beforeResolveScrollTop,
        afterResolveScrollTop: viewport.scrollTop,
        activeRowScrollTop: 800 * rowHeight
      };
    });

    expect(result.beforeResolveScrollTop).toBeGreaterThan(0);
    expect(result.afterResolveScrollTop).toBe(result.beforeResolveScrollTop);
    expect(result.afterResolveScrollTop).not.toBe(result.activeRowScrollTop);
    expect(issues).toEqual([]);
  });

  test("reveals a browser-duplicated active tab after manual sparse scrolling", async ({
    page
  }) => {
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
      const nextFrame = async () => {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      };
      const waitForSparseRequestCount = async (count: number) => {
        await (
          window as typeof window & {
            __waitForSparseRequestCount?: (count: number) => Promise<void>;
          }
        ).__waitForSparseRequestCount?.(count);
      };
      const resolveNextSparseSlice = () => {
        (
          window as typeof window & { __resolveNextSparseSlice?: () => void }
        ).__resolveNextSparseSlice?.();
      };
      const sparseRequestCount = () =>
        (
          window as typeof window & { __sparseRequestCount?: () => number }
        ).__sparseRequestCount?.() ?? 0;
      const lastSparseRequest = () =>
        (
          window as typeof window & {
            __lastSparseRequest?: () => {
              centerRowIndex: number;
              rowLimit: number;
              query: string;
              targetNodeId?: string;
            };
          }
        ).__lastSparseRequest?.();
      const duplicateActiveTab = () => {
        (window as typeof window & { __duplicateActiveTab?: () => void }).__duplicateActiveTab?.();
      };

      viewport.scrollTop = 250 * rowHeight;
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
      await waitForSparseRequestCount(1);
      resolveNextSparseSlice();
      await nextFrame();
      await nextFrame();

      const requestsBeforeDuplicate = sparseRequestCount();
      duplicateActiveTab();
      await waitForSparseRequestCount(requestsBeforeDuplicate + 1);
      const duplicateRequest = lastSparseRequest();
      resolveNextSparseSlice();
      await nextFrame();
      await nextFrame();

      const duplicateRow = document.querySelector<HTMLElement>(
        ".node[data-node-id='tab\\:duplicate']"
      );
      return {
        duplicateRequest,
        duplicateVisible: Boolean(duplicateRow),
        duplicateActive: duplicateRow?.classList.contains("is-active") ?? false,
        duplicateRowIndex: Number.parseInt(duplicateRow?.dataset.rowIndex ?? "", 10),
        scrollTop: viewport.scrollTop,
        duplicateCenteredScrollTop: Math.max(
          0,
          801 * rowHeight + rowHeight / 2 - viewport.clientHeight / 2
        )
      };
    });

    expect(result.duplicateRequest?.targetNodeId).toBe("tab:duplicate");
    expect(result.duplicateVisible).toBe(true);
    expect(result.duplicateActive).toBe(true);
    expect(result.duplicateRowIndex).toBe(801);
    expect(result.scrollTop).toBeGreaterThan(700 * 18);
    expect(Math.abs(result.scrollTop - result.duplicateCenteredScrollTop)).toBeLessThan(36);
    expect(issues).toEqual([]);
  });

  test("reveals a browser-created tab in a detached window outside the sparse rows", async ({
    page
  }) => {
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
      const nextFrame = async () => {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      };
      const waitForSparseRequestCount = async (count: number) => {
        await (
          window as typeof window & {
            __waitForSparseRequestCount?: (count: number) => Promise<void>;
          }
        ).__waitForSparseRequestCount?.(count);
      };
      const resolveNextSparseSlice = () => {
        (
          window as typeof window & { __resolveNextSparseSlice?: () => void }
        ).__resolveNextSparseSlice?.();
      };
      const sparseRequestCount = () =>
        (
          window as typeof window & { __sparseRequestCount?: () => number }
        ).__sparseRequestCount?.() ?? 0;
      const lastSparseRequest = () =>
        (
          window as typeof window & {
            __lastSparseRequest?: () => {
              centerRowIndex: number;
              rowLimit: number;
              query: string;
              targetNodeId?: string;
            };
          }
        ).__lastSparseRequest?.();
      const detachActiveTabToNewWindow = () => {
        (
          window as typeof window & { __detachActiveTabToNewWindow?: () => void }
        ).__detachActiveTabToNewWindow?.();
      };
      const createTabInDetachedWindow = () => {
        (
          window as typeof window & { __createTabInDetachedWindow?: () => void }
        ).__createTabInDetachedWindow?.();
      };

      const requestsBeforeDetach = sparseRequestCount();
      detachActiveTabToNewWindow();
      await waitForSparseRequestCount(requestsBeforeDetach + 1);
      const detachRequest = lastSparseRequest();
      resolveNextSparseSlice();
      await nextFrame();
      await nextFrame();
      const scrollTopAfterDetach = viewport.scrollTop;

      const requestsBeforeCreate = sparseRequestCount();
      createTabInDetachedWindow();
      await waitForSparseRequestCount(requestsBeforeCreate + 1);
      const createRequest = lastSparseRequest();
      resolveNextSparseSlice();
      await nextFrame();
      await nextFrame();

      const createdRow = document.querySelector<HTMLElement>(
        ".node[data-node-id='tab\\:detached-new']"
      );
      return {
        detachRequest,
        createRequest,
        scrollTopAfterDetach,
        createdVisible: Boolean(createdRow),
        createdActive: createdRow?.classList.contains("is-active") ?? false,
        createdRowIndex: Number.parseInt(createdRow?.dataset.rowIndex ?? "", 10),
        scrollTop: viewport.scrollTop,
        expectedCreatedScrollTop: Math.min(
          Math.max(0, 1_002 * rowHeight + rowHeight / 2 - viewport.clientHeight / 2),
          Math.max(0, 1_003 * rowHeight - viewport.clientHeight)
        )
      };
    });

    expect(result.detachRequest?.targetNodeId).toBe("tab:800");
    expect(result.scrollTopAfterDetach).toBeGreaterThan(900 * 18);
    expect(result.createRequest?.targetNodeId).toBe("tab:detached-new");
    expect(result.createdVisible).toBe(true);
    expect(result.createdActive).toBe(true);
    expect(result.createdRowIndex).toBe(1_002);
    expect(result.scrollTop).toBeGreaterThan(900 * 18);
    expect(Math.abs(result.scrollTop - result.expectedCreatedScrollTop)).toBeLessThan(36);
    expect(issues).toEqual([]);
  });

  test("uses an older sparse response if it still covers the current scrollbar jump", async ({
    page
  }) => {
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
        await (
          window as typeof window & {
            __waitForSparseRequestCount?: (count: number) => Promise<void>;
          }
        ).__waitForSparseRequestCount?.(count);
      };
      const resolveSparseSliceAt = (index: number) => {
        (
          window as typeof window & { __resolveSparseSliceAt?: (index: number) => void }
        ).__resolveSparseSliceAt?.(index);
      };
      const sparseRequestCount = () =>
        (
          window as typeof window & { __sparseRequestCount?: () => number }
        ).__sparseRequestCount?.() ?? 0;

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

  test("paints an intersecting stale search response during a fast scrollbar jump", async ({
    page
  }) => {
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
        await (
          window as typeof window & {
            __waitForSparseRequestCount?: (count: number) => Promise<void>;
          }
        ).__waitForSparseRequestCount?.(count);
      };
      const resolveSparseSliceAt = (index: number) => {
        (
          window as typeof window & { __resolveSparseSliceAt?: (index: number) => void }
        ).__resolveSparseSliceAt?.(index);
      };
      const sparseRequestCount = () =>
        (
          window as typeof window & { __sparseRequestCount?: () => number }
        ).__sparseRequestCount?.() ?? 0;

      search.focus();
      search.value = "needle";
      search.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "needle"
        })
      );
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

  test("does not refetch forever when the bottom viewport rounds past total rows", async ({
    page
  }) => {
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
        await (
          window as typeof window & {
            __waitForSparseRequestCount?: (count: number) => Promise<void>;
          }
        ).__waitForSparseRequestCount?.(count);
      };
      const resolveSparseSliceAt = (index: number) => {
        (
          window as typeof window & { __resolveSparseSliceAt?: (index: number) => void }
        ).__resolveSparseSliceAt?.(index);
      };
      const sparseRequestCount = () =>
        (
          window as typeof window & { __sparseRequestCount?: () => number }
        ).__sparseRequestCount?.() ?? 0;
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
    let totalRows = 1_001;
    let activeTabNodeId = "tab:800";
    const duplicateNodeId = "tab:duplicate";
    const duplicateRowIndex = 801;
    const duplicateTabRuntimeId = 1001;
    const detachedWindowNodeId = "window:detached";
    const detachedNewTabNodeId = "tab:detached-new";
    const detachedWindowRuntimeId = 2;
    const detachedNewTabRuntimeId = 1002;
    let duplicateInserted = false;
    let activeTabDetached = false;
    let detachedNewTabInserted = false;
    const listeners: Array<(message: unknown) => void> = [];
    const sparseRequests: Array<{
      centerRowIndex: number;
      rowLimit: number;
      query: string;
      targetNodeId?: string;
    }> = [];
    const runtimeMessages: string[] = [];
    const pendingResponses: Array<{
      request: { centerRowIndex: number; rowLimit: number; query: string; targetNodeId?: string };
      resolve: (value: unknown) => void;
    }> = [];

    Object.assign(
      window as typeof window & {
        __sparseRequestCount?: () => number;
        __lastSparseRequest?: () =>
          | { centerRowIndex: number; rowLimit: number; query: string; targetNodeId?: string }
          | undefined;
        __waitForSparseRequest?: () => Promise<void>;
        __waitForSparseRequestCount?: (count: number) => Promise<void>;
        __waitForRuntimeMessage?: (type: string) => Promise<void>;
        __resolveNextSparseSlice?: () => void;
        __resolveSparseSliceAt?: (index: number) => void;
        __duplicateActiveTab?: () => void;
        __detachActiveTabToNewWindow?: () => void;
        __createTabInDetachedWindow?: () => void;
      },
      {
        __sparseRequestCount: () => sparseRequests.length,
        __lastSparseRequest: () => sparseRequests.at(-1),
        __waitForSparseRequest: async () => {
          await (
            window as typeof window & {
              __waitForSparseRequestCount?: (count: number) => Promise<void>;
            }
          ).__waitForSparseRequestCount?.(1);
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
          (
            window as typeof window & { __resolveSparseSliceAt?: (index: number) => void }
          ).__resolveSparseSliceAt?.(index);
        },
        __resolveSparseSliceAt: (index: number) => {
          const pending = pendingResponses[index];
          if (!pending) {
            throw new Error(`No sparse slice request at index ${index}`);
          }
          pendingResponses.splice(index, 1);
          pending.resolve(
            sliceSnapshot(
              pending.request.centerRowIndex,
              pending.request.rowLimit,
              pending.request.query,
              pending.request.targetNodeId
            )
          );
        },
        __duplicateActiveTab: () => {
          if (duplicateInserted) {
            return;
          }
          if (activeTabDetached) {
            return;
          }
          duplicateInserted = true;
          totalRows += 1;
          activeTabNodeId = duplicateNodeId;
          const message = {
            type: "treeStructureUpdated",
            deletedNodeIds: [],
            updatedNodes: [
              windowNode(),
              outlineTabNode("tab:800"),
              outlineTabNode(duplicateNodeId)
            ],
            rootIds: ["window:1"],
            deletedLiveTabCount: 0
          };
          for (const listener of listeners) {
            listener(structuredClone(message));
          }
        },
        __detachActiveTabToNewWindow: () => {
          if (activeTabDetached) {
            return;
          }
          activeTabDetached = true;
          totalRows += 1;
          activeTabNodeId = "tab:800";
          const message = {
            type: "treeStructureUpdated",
            deletedNodeIds: [],
            updatedNodes: [windowNode(), detachedWindowNode(), outlineTabNode("tab:800")],
            rootIds: ["window:1", detachedWindowNodeId],
            deletedLiveTabCount: 0
          };
          for (const listener of listeners) {
            listener(structuredClone(message));
          }
        },
        __createTabInDetachedWindow: () => {
          if (!activeTabDetached || detachedNewTabInserted) {
            return;
          }
          detachedNewTabInserted = true;
          totalRows += 1;
          activeTabNodeId = detachedNewTabNodeId;
          const message = {
            type: "treeStructureUpdated",
            deletedNodeIds: [],
            updatedNodes: [
              detachedWindowNode(),
              outlineTabNode("tab:800"),
              outlineTabNode(detachedNewTabNodeId)
            ],
            rootIds: ["window:1", detachedWindowNodeId],
            deletedLiveTabCount: 0
          };
          for (const listener of listeners) {
            listener(structuredClone(message));
          }
        }
      }
    );

    window.browser = {
      runtime: {
        sendMessage: async (message: unknown) => {
          const type =
            typeof message === "object" && message
              ? String((message as { type?: unknown }).type)
              : "";
          runtimeMessages.push(type);
          if (type === "getInitialTreeSnapshot") {
            return initialSnapshot();
          }
          if (type === "getTreeProjectionSlice") {
            const centerRowIndex = Number((message as { centerRowIndex?: unknown }).centerRowIndex);
            const rowLimit = Number((message as { rowLimit?: unknown }).rowLimit);
            const query =
              typeof (message as { query?: unknown }).query === "string"
                ? (message as { query: string }).query
                : "";
            const targetNodeId =
              typeof (message as { targetNodeId?: unknown }).targetNodeId === "string"
                ? (message as { targetNodeId: string }).targetNodeId
                : undefined;
            const request = {
              centerRowIndex,
              rowLimit,
              query,
              ...(targetNodeId ? { targetNodeId } : {})
            };
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
          addListener: (listener: (message: unknown) => void) => {
            listeners.push(listener);
          }
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
      const rows = [windowRow(), ...outlineRows(760, 840)];
      return snapshotFromRows(rows);
    }

    function sliceSnapshot(
      centerRowIndex: number,
      rowLimit: number,
      query = "",
      targetNodeId?: string
    ) {
      const requestedCenterRowIndex = targetNodeId
        ? (rowIndexForNodeId(targetNodeId) ?? centerRowIndex)
        : centerRowIndex;
      const half = Math.floor(Math.max(1, rowLimit) / 2);
      const start = Math.max(query ? 0 : 1, Math.floor(requestedCenterRowIndex) - half);
      const end = Math.min(totalRows, start + Math.max(1, Math.floor(rowLimit)));
      return snapshotFromRows(query ? searchRows(start, end) : outlineRows(start, end), query);
    }

    function snapshotFromRows(
      rows: Array<Record<string, unknown> & { nodeId: string }>,
      query = ""
    ) {
      const activeTabRowIndex = rowIndexForNodeId(activeTabNodeId);
      const rootIds = activeTabDetached ? ["window:1", detachedWindowNodeId] : ["window:1"];
      return {
        type: "initialTreeSnapshot",
        version: 1,
        revision: 1,
        hydrating: true,
        state: {
          version: 1,
          rootIds,
          nodes: Object.fromEntries([
            ["window:1", windowNode()],
            ...(activeTabDetached ? [[detachedWindowNodeId, detachedWindowNode()]] : []),
            ...rows
              .filter((row) => row.nodeId.startsWith("tab:") || row.nodeId.startsWith("search:"))
              .map((row) => {
                return [
                  row.nodeId,
                  query ? searchNode(Number(row.index)) : outlineTabNode(row.nodeId)
                ];
              })
          ])
        },
        projection: {
          query,
          isSearchActive: Boolean(query),
          rows,
          matchingNodeIds: query ? rows.map((row) => row.nodeId) : [],
          visibleNodeIds: rows.map((row) => row.nodeId),
          activeTabNodeId,
          activeTabRowIndex,
          totalRowCount: totalRows,
          nodeCount: totalRows,
          liveTabCount: query ? 0 : totalRows,
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
        active: !activeTabDetached,
        collapsed: false,
        childIds: sourceWindowChildIds(),
        createdAt: now,
        updatedAt: now,
        live: { windowId: 1 }
      };
    }

    function detachedWindowNode() {
      return {
        id: detachedWindowNodeId,
        kind: "window",
        status: "live",
        title: "Detached Window",
        active: true,
        collapsed: false,
        childIds: detachedWindowChildIds(),
        createdAt: now,
        updatedAt: now,
        live: { windowId: detachedWindowRuntimeId }
      };
    }

    function sourceWindowChildIds() {
      const ids = Array.from({ length: 1_000 }, (_value, index) => `tab:${index + 1}`);
      if (!activeTabDetached) {
        return ids;
      }
      return ids.filter((nodeId) => nodeId !== "tab:800");
    }

    function detachedWindowChildIds() {
      return detachedNewTabInserted ? ["tab:800", detachedNewTabNodeId] : ["tab:800"];
    }

    function outlineTabNode(nodeId: string) {
      const tabId = runtimeTabIdForNodeId(nodeId);
      const inDetachedWindow =
        activeTabDetached && (nodeId === "tab:800" || nodeId === detachedNewTabNodeId);
      return {
        id: nodeId,
        kind: "tab",
        status: "live",
        parentId: inDetachedWindow ? detachedWindowNodeId : "window:1",
        title: nodeId === duplicateNodeId ? "Duplicated Tab" : `Tab ${tabId}`,
        url: `https://sparse.example/${tabId}`,
        active: nodeId === activeTabNodeId,
        collapsed: false,
        childIds: [],
        createdAt: now,
        updatedAt: now,
        live: { tabId, windowId: inDetachedWindow ? detachedWindowRuntimeId : 1 }
      };
    }

    function runtimeTabIdForNodeId(nodeId: string) {
      if (nodeId === duplicateNodeId) {
        return duplicateTabRuntimeId;
      }
      if (nodeId === detachedNewTabNodeId) {
        return detachedNewTabRuntimeId;
      }
      return Number.parseInt(nodeId.split(":")[1] ?? "", 10);
    }

    function nodeIdForRowIndex(rowIndex: number) {
      if (activeTabDetached) {
        if (rowIndex === 0) {
          return "window:1";
        }
        if (rowIndex < 800) {
          return `tab:${rowIndex}`;
        }
        if (rowIndex < 1_000) {
          return `tab:${rowIndex + 1}`;
        }
        if (rowIndex === 1_000) {
          return detachedWindowNodeId;
        }
        if (rowIndex === 1_001) {
          return "tab:800";
        }
        if (detachedNewTabInserted && rowIndex === 1_002) {
          return detachedNewTabNodeId;
        }
      }
      if (!duplicateInserted || rowIndex < duplicateRowIndex) {
        return `tab:${rowIndex}`;
      }
      if (rowIndex === duplicateRowIndex) {
        return duplicateNodeId;
      }
      return `tab:${rowIndex - 1}`;
    }

    function rowIndexForNodeId(nodeId: string) {
      if (activeTabDetached) {
        if (nodeId === "window:1") {
          return 0;
        }
        if (nodeId === detachedWindowNodeId) {
          return 1_000;
        }
        if (nodeId === "tab:800") {
          return 1_001;
        }
        if (nodeId === detachedNewTabNodeId) {
          return detachedNewTabInserted ? 1_002 : undefined;
        }
        if (!nodeId.startsWith("tab:")) {
          return undefined;
        }
        const tabId = Number.parseInt(nodeId.split(":")[1] ?? "", 10);
        if (!Number.isFinite(tabId)) {
          return undefined;
        }
        return tabId < 800 ? tabId : tabId - 1;
      }
      if (nodeId === duplicateNodeId) {
        return duplicateInserted ? duplicateRowIndex : undefined;
      }
      if (!nodeId.startsWith("tab:")) {
        return undefined;
      }
      const tabId = Number.parseInt(nodeId.split(":")[1] ?? "", 10);
      if (!Number.isFinite(tabId)) {
        return undefined;
      }
      return duplicateInserted && tabId >= duplicateRowIndex ? tabId + 1 : tabId;
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
        subtreeEndIndex: activeTabDetached ? 1_000 : totalRows,
        childCount: sourceWindowChildIds().length,
        visibleChildCount: sourceWindowChildIds().length,
        expanded: true,
        searchRevealsCollapsedChildren: false,
        isSearchMatch: false,
        isSearchPath: false,
        insideActiveWindow: false
      };
    }

    function detachedWindowRow() {
      return {
        nodeId: detachedWindowNodeId,
        depth: 0,
        index: 1_000,
        subtreeEndIndex: totalRows,
        childCount: detachedWindowChildIds().length,
        visibleChildCount: detachedWindowChildIds().length,
        expanded: true,
        searchRevealsCollapsedChildren: false,
        isSearchMatch: false,
        isSearchPath: false,
        insideActiveWindow: false
      };
    }

    function outlineRows(startInclusive: number, endExclusive: number) {
      const rows = Array.from(
        { length: Math.max(0, endExclusive - startInclusive) },
        (_value, index) => {
          const rowIndex = startInclusive + index;
          const nodeId = nodeIdForRowIndex(rowIndex);
          if (!nodeId) {
            return undefined;
          }
          if (nodeId === detachedWindowNodeId) {
            return detachedWindowRow();
          }
          const insideDetachedWindow =
            activeTabDetached && (nodeId === "tab:800" || nodeId === detachedNewTabNodeId);
          return {
            nodeId,
            depth: insideDetachedWindow ? 1 : 1,
            index: rowIndex,
            parentRowIndex: insideDetachedWindow ? 1_000 : 0,
            subtreeEndIndex: rowIndex + 1,
            childCount: 0,
            visibleChildCount: 0,
            expanded: true,
            searchRevealsCollapsedChildren: false,
            isSearchMatch: false,
            isSearchPath: false,
            insideActiveWindow: insideDetachedWindow || !activeTabDetached
          };
        }
      );
      return rows.filter((row): row is Record<string, unknown> & { nodeId: string } =>
        Boolean(row)
      );
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
    await (
      window as typeof window & {
        __waitForRuntimeMessage?: (type: string) => Promise<void>;
      }
    ).__waitForRuntimeMessage?.("getHistoryStatus");
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
    issues.push({
      kind: "requestfailed",
      text: `${request.url()} ${request.failure()?.errorText ?? ""}`
    });
  });
  return issues;
}
