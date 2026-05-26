import { expect, test, type Page } from "@playwright/test";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

test.describe("sidebar projection hunt", () => {
  test("psh-scroll-rejected-slice-recovers-without-second-user-scroll", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.rejectSliceAt(0);
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        requestCount: api.sparseRequestCount(),
        visibleRows: api.visibleRows()
      };
    });

    expect(result.requestCount).toBeGreaterThan(1);
    expect(result.visibleRows).toContain(250);
    expect(issues).toEqual([]);
  });

  test("psh-stale-noncovering-slice-is-followed-by-current-slice", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { start: 500, end: 540 });
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(2);
      return {
        requestCount: api.sparseRequestCount(),
        visibleRows: api.visibleRows()
      };
    });

    expect(result.requestCount).toBe(2);
    expect(result.visibleRows).toContain(250);
    expect(issues).toEqual([]);
  });

  test("psh-stale-covering-window-survives-latest-noncovering-slice", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      await api.scrollToRow(260);
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0, { start: 240, end: 310 });
      await api.waitForIdleFrames(2);
      const before = api.visibleRows();
      api.resolveSliceAt(0, { start: 700, end: 760 });
      await api.waitForIdleFrames(2);
      return {
        before,
        after: api.visibleRows(),
        requestCount: api.sparseRequestCount()
      };
    });

    expect(result.before).toContain(260);
    expect(result.after).toContain(260);
    expect(result.requestCount).toBe(2);
    expect(issues).toEqual([]);
  });

  test("psh-rejected-stale-request-does-not-block-current-slice", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      await api.scrollToRow(360);
      await api.waitForSparseRequestCount(2);
      api.rejectSliceAt(0);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(2);
      return {
        requestCount: api.sparseRequestCount(),
        visibleRows: api.visibleRows()
      };
    });

    expect(result.requestCount).toBe(2);
    expect(result.visibleRows).toContain(360);
    expect(issues).toEqual([]);
  });

  test("psh-full-state-broadcast-recovers-after-rejected-slice", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.rejectSliceAt(0);
      await api.waitForIdleFrames(2);
      api.emitFullStateBroadcast();
      await api.waitForVisibleRow(250);
      return {
        requestCount: api.sparseRequestCount(),
        visibleRows: api.visibleRows()
      };
    });

    expect(result.requestCount).toBeGreaterThanOrEqual(1);
    expect(result.visibleRows).toContain(250);
    expect(issues).toEqual([]);
  });

  test("psh-three-jump-out-of-order-covering-slice-paints-current-viewport", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      await api.scrollToRow(360);
      await api.waitForSparseRequestCount(2);
      await api.scrollToRow(368);
      await api.waitForSparseRequestCount(3);
      api.resolveSliceAt(1, { start: 330, end: 410 });
      await api.waitForIdleFrames(2);
      return {
        requestCount: api.sparseRequestCount(),
        visibleRows: api.visibleRows()
      };
    });

    expect(result.requestCount).toBe(3);
    expect(result.visibleRows).toContain(368);
    expect(issues).toEqual([]);
  });

  test("psh-full-hydration-preserves-middle-sparse-window", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(2);
      const before = api.visibleRows();
      api.resolveFullState();
      await api.waitForIdleFrames(6);
      return {
        before,
        after: api.visibleRows(),
        scrollRow: api.viewportStartRow()
      };
    });

    expect(result.before).toContain(250);
    expect(result.after).toContain(250);
    expect(result.scrollRow).toBeGreaterThanOrEqual(245);
    expect(result.scrollRow).toBeLessThanOrEqual(255);
    expect(issues).toEqual([]);
  });

  test("psh-hover-actions-survive-full-hydration", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const row = nodeRow(page, "tab:800");
    await row.hover();
    await expect(row.getByRole("button", { name: "Close", exact: true })).toBeVisible();

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.resolveFullState();
      await api.waitForIdleFrames(6);
    });

    await expect(row.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-visible-close-command-works-during-hydration", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const row = nodeRow(page, "tab:800");
    await row.hover();
    await row.getByRole("button", { name: "Close", exact: true }).click();

    await expect(sentCommands(page)).resolves.toEqual([{ type: "closeNode", nodeId: "tab:800" }]);
    expect(issues).toEqual([]);
  });

  test("psh-toggle-covered-row-works-during-hydration", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const row = nodeRow(page, "window:1");
    await row.hover();
    await row.getByRole("button", { name: "Collapse", exact: true }).click();

    await expect(sentCommands(page)).resolves.toEqual([{ type: "toggleCollapsed", nodeId: "window:1" }]);
    expect(issues).toEqual([]);
  });

  test("psh-rename-covered-row-works-during-hydration", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const row = nodeRow(page, "window:1");
    await row.hover();
    await row.getByRole("button", { name: "Rename", exact: true }).click();

    const input = row.getByRole("textbox", { name: "Rename Window", exact: true });
    await expect(input).toBeVisible();
    await input.fill("Renamed sparse window");
    await input.press("Enter");

    await expect(sentCommands(page)).resolves.toEqual([
      { type: "renameGroup", nodeId: "window:1", title: "Renamed sparse window" }
    ]);
    await expect(input).toHaveCount(0);
    expect(issues).toEqual([]);
  });

  test("psh-movement-controls-hidden-while-partial", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const row = nodeRow(page, "tab:800");
    await row.hover();

    await expect(row.getByRole("button", { name: "Move to top level", exact: true })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Cut", exact: true })).toHaveCount(0);
    expect(issues).toEqual([]);
  });

  test("psh-cut-paste-shortcuts-disabled-while-partial", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await nodeRow(page, "tab:800").locator(".node-label").focus();
    await page.keyboard.press("Control+X");
    await nodeRow(page, "tab:801").locator(".node-label").focus();
    await page.keyboard.press("Control+V");

    await expect(sentCommands(page)).resolves.toEqual([]);
    expect(issues).toEqual([]);
  });

  test("psh-coverage-missing-snapshot-keeps-actions-readonly", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: false, fullStatePending: true });

    const row = nodeRow(page, "tab:799");
    await row.hover();

    await expect(row.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    await row.locator(".node-label").click();
    await expect(sentCommands(page)).resolves.toEqual([{ type: "focusNode", nodeId: "tab:799" }]);
    expect(issues).toEqual([]);
  });

  test("psh-patch-delete-hovered-row-clears-visible-actions", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const row = nodeRow(page, "tab:800");
    await row.hover();
    await expect(row.getByRole("button", { name: "Delete", exact: true })).toBeVisible();

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitDeletePatch(["tab:800"]);
      await api.waitForIdleFrames(2);
    });

    await expect(page.locator(nodeSelector("tab:800"))).toHaveCount(0);
    expect(issues).toEqual([]);
  });

  test("psh-patch-update-hovered-row-keeps-actions-stable", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const row = nodeRow(page, "tab:800");
    await row.hover();
    await expect(row.getByRole("button", { name: "Close", exact: true })).toBeVisible();

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitTitlePatch("tab:800", "Updated visible row");
      await api.waitForIdleFrames(2);
    });

    await expect(row).toContainText("Updated visible row");
    await expect(row.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-state-updated-while-hovering-preserves-actions", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const row = nodeRow(page, "tab:800");
    await row.hover();
    await expect(row.getByRole("button", { name: "Close", exact: true })).toBeVisible();

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitFullStateBroadcast();
      await api.waitForIdleFrames(3);
    });

    await expect(row.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-state-updated-while-scrolled-to-sparse-window-preserves-viewport", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(2);
      const before = api.visibleRows();
      api.emitFullStateBroadcast();
      await api.waitForIdleFrames(3);
      return {
        before,
        after: api.visibleRows()
      };
    });

    expect(result.before).toContain(250);
    expect(result.after).toContain(250);
    expect(issues).toEqual([]);
  });

  test("psh-restored-single-tab-delete-during-hydration-removes-shell", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadRestoredWindowSidebar(page, { fullStatePending: true });

    const row = nodeRow(page, "tab:2");
    await row.hover();
    await row.getByRole("button", { name: "Delete", exact: true }).click();

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitDeletePatch(["tab:2", "window:20"]);
      await api.waitForIdleFrames(2);
    });

    await expect(page.locator(nodeSelector("tab:2"))).toHaveCount(0);
    await expect(page.locator(nodeSelector("window:20"))).toHaveCount(0);
    await expect(sentCommands(page)).resolves.toEqual([{ type: "deleteNode", nodeId: "tab:2" }]);
    expect(issues).toEqual([]);
  });

  test("psh-incomplete-restore-does-not-fallback-to-partial-scope", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadClosedRestoreSidebar(page, { fullStatePending: true, invalidRestoreScope: true });

    await nodeRow(page, "window:30").getByRole("button", { name: "Restore Closed Window", exact: true }).click();

    await expect(sentCommands(page)).resolves.toEqual([{ type: "analyzeRestoreScope", nodeId: "window:30" }]);
    expect(issues).toEqual([]);
  });

  test("psh-incomplete-restore-uses-background-scope-confirmation", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadClosedRestoreSidebar(page, { fullStatePending: true });

    page.on("dialog", async (dialog) => {
      expect(dialog.message()).toContain("Restore 4 restorable closed nodes");
      await dialog.accept();
    });
    await nodeRow(page, "window:30").getByRole("button", { name: "Restore Closed Window", exact: true }).click();

    await expect(sentCommands(page)).resolves.toEqual([
      { type: "analyzeRestoreScope", nodeId: "window:30" },
      { type: "restoreNode", nodeId: "window:30", confirmedLargeRestore: true }
    ]);
    expect(issues).toEqual([]);
  });

  test("psh-unloaded-delete-patch-preserves-visible-sparse-window", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(2);
      const before = api.visibleRows();
      api.emitDeletePatch(["tab:900"]);
      await api.waitForIdleFrames(2);
      return {
        before,
        after: api.visibleRows()
      };
    });

    expect(result.before).toContain(250);
    expect(result.after).toContain(250);
    await expect(page.locator(nodeSelector("tab:900"))).toHaveCount(0);
    expect(issues).toEqual([]);
  });

  test("psh-unloaded-title-patch-preserves-visible-sparse-window", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(2);
      const before = api.visibleRows();
      api.emitTitlePatch("tab:900", "Updated unloaded row");
      await api.waitForIdleFrames(2);
      return {
        before,
        after: api.visibleRows()
      };
    });

    expect(result.before).toContain(250);
    expect(result.after).toContain(250);
    await expect(page.locator(nodeSelector("tab:900"))).toHaveCount(0);
    expect(issues).toEqual([]);
  });

  test("psh-visible-sparse-delete-patch-keeps-neighbor-visible", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(2);
      const before = api.visibleRows();
      api.emitDeletePatch(["tab:250"]);
      await api.waitForIdleFrames(2);
      return {
        before,
        after: api.visibleRows()
      };
    });

    expect(result.before).toContain(250);
    await expect(page.locator(nodeSelector("tab:250"))).toHaveCount(0);
    expect(result.after).toContain(251);
    expect(issues).toEqual([]);
  });
});

async function loadLargeSparseSidebar(
  page: Page,
  options: { fullStatePending?: boolean; includeCoverage?: boolean } = {}
): Promise<void> {
  await page.addInitScript(({ installerSource, harnessOptions }) => {
    const install = (0, eval)(`(${installerSource})`) as typeof installProjectionHuntHarness;
    install(harnessOptions);
  }, {
    installerSource: installProjectionHuntHarness.toString(),
    harnessOptions: {
      totalRows: 1001,
      initialStart: 760,
      initialEnd: 840,
      activeTabId: 800,
      fullStatePending: Boolean(options.fullStatePending),
      includeCoverage: options.includeCoverage !== false,
      restoredFixture: false
    }
  });

  await page.goto("/sidebar/sidebar.html");
  await waitForSidebarAppReady(page);
  await expect(page.locator(nodeSelector("tab:800"))).toBeVisible();
}

async function loadRestoredWindowSidebar(
  page: Page,
  options: { fullStatePending?: boolean } = {}
): Promise<void> {
  await page.addInitScript(({ installerSource, harnessOptions }) => {
    const install = (0, eval)(`(${installerSource})`) as typeof installProjectionHuntHarness;
    install(harnessOptions);
  }, {
    installerSource: installProjectionHuntHarness.toString(),
    harnessOptions: {
      totalRows: 4,
      initialStart: 1,
      initialEnd: 4,
      activeTabId: 2,
      fullStatePending: Boolean(options.fullStatePending),
      includeCoverage: true,
      restoredFixture: true
    }
  });

  await page.goto("/sidebar/sidebar.html");
  await waitForSidebarAppReady(page);
  await expect(page.locator(nodeSelector("tab:2"))).toBeVisible();
}

async function loadClosedRestoreSidebar(
  page: Page,
  options: { fullStatePending?: boolean; invalidRestoreScope?: boolean } = {}
): Promise<void> {
  await page.addInitScript(({ installerSource, harnessOptions }) => {
    const install = (0, eval)(`(${installerSource})`) as typeof installProjectionHuntHarness;
    install(harnessOptions);
  }, {
    installerSource: installProjectionHuntHarness.toString(),
    harnessOptions: {
      totalRows: 4,
      initialStart: 0,
      initialEnd: 4,
      activeTabId: 0,
      fullStatePending: Boolean(options.fullStatePending),
      includeCoverage: true,
      restoredFixture: false,
      closedRestoreFixture: true,
      invalidRestoreScope: Boolean(options.invalidRestoreScope)
    }
  });

  await page.goto("/sidebar/sidebar.html");
  await waitForSidebarAppReady(page);
  await expect(page.locator(nodeSelector("window:30"))).toBeVisible();
}

async function waitForSidebarAppReady(page: Page): Promise<void> {
  await page.waitForFunction(() => performance.getEntriesByName("tabs-outliner.boot.fullAppImport.end").length > 0);
}

function nodeRow(page: Page, nodeId: string) {
  return page.locator(`${nodeSelector(nodeId)} > .node-row`);
}

function nodeSelector(nodeId: string): string {
  return `.node[data-node-id='${cssString(nodeId)}']`;
}

async function sentCommands(page: Page): Promise<unknown[]> {
  return page.evaluate(() => projectionHuntApi().sentCommands());
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

function cssString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

declare global {
  interface Window {
    projectionHuntApi?: () => ProjectionHuntApi;
  }
}

type ProjectionHuntApi = {
  nextFrame(): Promise<void>;
  waitForIdleFrames(count: number): Promise<void>;
  scrollToRow(rowIndex: number): Promise<void>;
  waitForSparseRequestCount(count: number): Promise<void>;
  sparseRequestCount(): number;
  resolveSliceAt(index: number, override?: { start?: number; end?: number }): void;
  rejectSliceAt(index: number): void;
  visibleRows(): number[];
  waitForVisibleRow(rowIndex: number): Promise<void>;
  viewportStartRow(): number;
  resolveFullState(): void;
  emitDeletePatch(nodeIds: string[]): void;
  emitTitlePatch(nodeId: string, title: string): void;
  emitFullStateBroadcast(): void;
  sentCommands(): unknown[];
};

function projectionHuntApi(): ProjectionHuntApi {
  const api = window.projectionHuntApi?.();
  if (!api) {
    throw new Error("Missing projection hunt api");
  }
  return api;
}

function installProjectionHuntHarness(options: {
  totalRows: number;
  initialStart: number;
  initialEnd: number;
  activeTabId: number;
  fullStatePending: boolean;
  includeCoverage: boolean;
  restoredFixture: boolean;
  closedRestoreFixture?: boolean;
  invalidRestoreScope?: boolean;
}) {
  const now = 1_700_000_000_000;
  const rowHeight = 18;
  const listeners: Array<(message: unknown) => void> = [];
  const sentCommands: unknown[] = [];
  const sliceRequests: Array<{ centerRowIndex: number; rowLimit: number }> = [];
  const pendingSlices: Array<{
    request: { centerRowIndex: number; rowLimit: number };
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  let fullState = initialFullState();
  let fullStateResolver: ((value: unknown) => void) | undefined;
  let fullStateResolveQueued = false;

  window.projectionHuntApi = () => ({
    nextFrame,
    waitForIdleFrames,
    scrollToRow,
    waitForSparseRequestCount,
    sparseRequestCount: () => sliceRequests.length,
    resolveSliceAt,
    rejectSliceAt,
    visibleRows,
    waitForVisibleRow,
    viewportStartRow,
    resolveFullState,
    emitDeletePatch,
    emitTitlePatch,
    emitFullStateBroadcast,
    sentCommands: () => structuredClone(sentCommands)
  });

  window.browser = {
    runtime: {
      sendMessage: async (message: unknown) => {
        const type = typeof message === "object" && message ? String((message as { type?: unknown }).type) : "";
        if (type === "getInitialTreeSnapshot") {
          return snapshotFromRows(initialRows(), { hydrating: true });
        }
        if (type === "getTreeProjectionSlice") {
          const centerRowIndex = Number((message as { centerRowIndex?: unknown }).centerRowIndex);
          const rowLimit = Number((message as { rowLimit?: unknown }).rowLimit);
          const request = { centerRowIndex, rowLimit };
          sliceRequests.push(request);
          return new Promise((resolve, reject) => {
            pendingSlices.push({ request, resolve, reject });
          });
        }
        if (type === "getState") {
          if (fullStateResolveQueued) {
            fullStateResolveQueued = false;
            return structuredClone(fullState);
          }
          if (options.fullStatePending) {
            return new Promise((resolve) => {
              fullStateResolver = resolve;
            });
          }
          return structuredClone(fullState);
        }
        if (type === "getHistoryStatus") {
          return { type: "historyStatus", canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 };
        }
        if (
          type === "getDiagnostics" ||
          type === "getPerformanceTrace" ||
          type === "setPerformanceTraceEnabled" ||
          type === "clearPerformanceTrace"
        ) {
          return undefined;
        }
        if (type === "analyzeRestoreScope") {
          sentCommands.push(structuredClone(message));
          if (options.invalidRestoreScope) {
            return { ok: false };
          }
          return {
            nodeIds: ["window:30", "tab:30", "tab:31", "tab:32"],
            totalCount: 4,
            tabCount: 3,
            windowCount: 1,
            threshold: 1,
            requiresConfirmation: true
          };
        }
        if (
          type === "closeNode" ||
          type === "deleteNode" ||
          type === "restoreNode" ||
          type === "toggleCollapsed" ||
          type === "moveNode" ||
          type === "wrapNodeInGroup" ||
          type === "renameGroup" ||
          type === "focusNode"
        ) {
          sentCommands.push(structuredClone(message));
          return { type: "commandAck", stateChanged: type !== "focusNode" };
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

  function resolveSliceAt(index: number, override: { start?: number; end?: number } = {}) {
    const pending = pendingSlices[index];
    if (!pending) {
      throw new Error(`No sparse slice request at index ${index}`);
    }
    pendingSlices.splice(index, 1);
    const rows = options.closedRestoreFixture
      ? closedRestoreRows()
      : options.restoredFixture
      ? restoredRows()
      : tabRows(
        override.start ?? Math.max(1, Math.floor(pending.request.centerRowIndex - pending.request.rowLimit / 2)),
        override.end ?? Math.min(options.totalRows, Math.floor(pending.request.centerRowIndex + pending.request.rowLimit / 2))
      );
    pending.resolve(snapshotFromRows(rows, { hydrating: true }));
  }

  function rejectSliceAt(index: number) {
    const pending = pendingSlices[index];
    if (!pending) {
      throw new Error(`No sparse slice request at index ${index}`);
    }
    pendingSlices.splice(index, 1);
    pending.reject(new Error("projection hunt rejected sparse slice"));
  }

  function resolveFullState() {
    if (!fullStateResolver) {
      fullStateResolveQueued = true;
      return;
    }
    fullStateResolver(structuredClone(fullState));
    fullStateResolver = undefined;
  }

  function emitDeletePatch(nodeIds: string[]) {
    const previous = structuredClone(fullState);
    for (const nodeId of nodeIds) {
      delete fullState.nodes[nodeId];
    }
    for (const node of Object.values(fullState.nodes) as Array<{ childIds?: string[] }>) {
      if (Array.isArray(node.childIds)) {
        node.childIds = node.childIds.filter((childId) => !nodeIds.includes(childId));
      }
    }
    fullState.rootIds = fullState.rootIds.filter((nodeId: string) => !nodeIds.includes(nodeId));
    emit(treeStructureUpdate(previous, fullState, nodeIds));
  }

  function emitTitlePatch(nodeId: string, title: string) {
    const node = fullState.nodes[nodeId];
    if (!node) {
      throw new Error(`Missing node ${nodeId}`);
    }
    node.title = title;
    node.updatedAt = now + 1;
    emit({ type: "nodeStateUpdated", updatedNodes: [structuredClone(node)], closedCountDelta: 0 });
  }

  function emitFullStateBroadcast() {
    emit({ type: "stateUpdated", state: structuredClone(fullState) });
  }

  function emit(message: unknown) {
    for (const listener of listeners) {
      listener(message);
    }
  }

  function treeStructureUpdate(previous: typeof fullState, next: typeof fullState, deletedNodeIds: string[]) {
    const updatedNodes = Object.keys(next.nodes)
      .filter((nodeId) => JSON.stringify(previous.nodes[nodeId]) !== JSON.stringify(next.nodes[nodeId]))
      .map((nodeId) => structuredClone(next.nodes[nodeId]));
    return {
      type: "treeStructureUpdated",
      deletedNodeIds,
      updatedNodes,
      rootIds: [...next.rootIds],
      deletedClosedCount: 0
    };
  }

  function snapshotFromRows(rows: Array<Record<string, unknown> & { nodeId: string; index: number }>, settings: { hydrating: boolean }) {
    const nodes = Object.fromEntries(
      rows
        .map((row) => fullState.nodes[row.nodeId])
        .filter(Boolean)
        .map((node) => [node.id, structuredClone(node)])
    );
    if (!options.restoredFixture && !options.closedRestoreFixture) {
      nodes["window:1"] = structuredClone(fullState.nodes["window:1"]);
    }
    const indexes = rows.map((row) => row.index);
    return {
      type: "initialTreeSnapshot",
      version: 1,
      revision: 1,
      hydrating: settings.hydrating,
      state: {
        version: 1,
        rootIds: [...fullState.rootIds],
        nodes
      },
      projection: {
        query: "",
        isSearchActive: false,
        rows,
        matchingNodeIds: [],
        visibleNodeIds: rows.map((row) => row.nodeId),
        ...activeProjectionTarget(),
        totalRowCount: options.totalRows,
        nodeCount: options.totalRows,
        closedCount: options.closedRestoreFixture ? 4 : 0,
        matchCount: 0
      },
      ...(options.includeCoverage
        ? {
            coverage: {
              startRowIndex: Math.min(...indexes),
              endRowIndex: Math.max(...indexes) + 1,
              editableNodeIds: rows.map((row) => row.nodeId),
              completeSubtreeNodeIds: completeSubtreeNodeIdsForRows(rows),
              completeSiblingParentIds: completeSiblingParentIdsForRows()
            }
          }
        : {})
    };
  }

  function initialFullState() {
    if (options.closedRestoreFixture) {
      return closedRestoreState();
    }
    return options.restoredFixture ? restoredState() : largeState();
  }

  function initialRows() {
    if (options.closedRestoreFixture) {
      return closedRestoreRows();
    }
    return options.restoredFixture
      ? restoredRows()
      : [windowRow(), ...tabRows(options.initialStart, options.initialEnd)];
  }

  function activeProjectionTarget() {
    if (options.closedRestoreFixture) {
      return {
        activeTabNodeId: "window:30",
        activeTabRowIndex: 0
      };
    }
    return options.activeTabId > 0
      ? {
          activeTabNodeId: `tab:${options.activeTabId}`,
          activeTabRowIndex: options.activeTabId
        }
      : {};
  }

  function completeSubtreeNodeIdsForRows(rows: Array<{ nodeId: string }>) {
    const nodeIds = rows.map((row) => row.nodeId);
    return options.closedRestoreFixture ? nodeIds.filter((nodeId) => nodeId !== "window:30") : nodeIds;
  }

  function completeSiblingParentIdsForRows() {
    if (options.closedRestoreFixture) {
      return [];
    }
    return options.restoredFixture ? ["window:10", "window:20"] : ["window:1"];
  }

  function largeState() {
    const childIds = Array.from({ length: options.totalRows - 1 }, (_value, index) => `tab:${index + 1}`);
    return {
      version: 1,
      rootIds: ["window:1"],
      nodes: Object.fromEntries([
        ["window:1", {
          id: "window:1",
          kind: "window",
          status: "live",
          title: "Window",
          active: true,
          collapsed: false,
          childIds,
          createdAt: now,
          updatedAt: now,
          live: { windowId: 1 }
        }],
        ...childIds.map((nodeId, index) => {
          const tabId = index + 1;
          return [nodeId, tabNode(tabId)];
        })
      ])
    };
  }

  function restoredState() {
    return {
      version: 1,
      rootIds: ["window:10", "window:20"],
      nodes: {
        "window:10": {
          id: "window:10",
          kind: "window",
          status: "live",
          title: "Existing Window",
          active: false,
          collapsed: false,
          childIds: ["tab:1"],
          createdAt: now,
          updatedAt: now,
          live: { windowId: 10 }
        },
        "tab:1": tabNode(1, { parentId: "window:10", title: "Existing tab", active: false }),
        "window:20": {
          id: "window:20",
          kind: "window",
          status: "live",
          title: "Restored Window",
          active: true,
          collapsed: false,
          childIds: ["tab:2"],
          createdAt: now,
          updatedAt: now,
          restoredFromClosed: true,
          live: { windowId: 20 }
        },
        "tab:2": tabNode(2, {
          parentId: "window:20",
          title: "Restored single tab",
          active: true,
          restoredFromClosed: true
        })
      }
    };
  }

  function closedRestoreState() {
    return {
      version: 1,
      rootIds: ["window:30"],
      nodes: {
        "window:30": {
          id: "window:30",
          kind: "window",
          status: "closed",
          title: "Closed Window",
          active: false,
          collapsed: false,
          childIds: ["tab:30", "tab:31", "tab:32"],
          createdAt: now,
          updatedAt: now,
          closedAt: now,
          restore: { sessionId: "session-window-30" }
        },
        "tab:30": tabNode(30, { parentId: "window:30", title: "Closed tab 30", active: false, closed: true }),
        "tab:31": tabNode(31, { parentId: "window:30", title: "Closed tab 31", active: false, closed: true }),
        "tab:32": tabNode(32, { parentId: "window:30", title: "Closed tab 32", active: false, closed: true })
      }
    };
  }

  function tabNode(
    tabId: number,
    overrides: { parentId?: string; title?: string; active?: boolean; restoredFromClosed?: boolean; closed?: boolean } = {}
  ) {
    return {
      id: `tab:${tabId}`,
      kind: "tab",
      status: overrides.closed ? "closed" : "live",
      parentId: overrides.parentId ?? "window:1",
      title: overrides.title ?? `Tab ${tabId}`,
      url: `https://projection.example/${tabId}`,
      active: overrides.active ?? tabId === options.activeTabId,
      collapsed: false,
      childIds: [],
      createdAt: now,
      updatedAt: now,
      ...(overrides.closed ? { closedAt: now, restore: { url: `https://projection.example/${tabId}` } } : {}),
      ...(overrides.restoredFromClosed ? { restoredFromClosed: true } : {}),
      ...(overrides.closed ? {} : { live: { tabId, windowId: overrides.parentId === "window:20" ? 20 : 1 } })
    };
  }

  function windowRow() {
    return {
      nodeId: "window:1",
      depth: 0,
      index: 0,
      subtreeEndIndex: options.totalRows,
      childCount: options.totalRows - 1,
      visibleChildCount: options.totalRows - 1,
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
      return tabRow(tabId);
    });
  }

  function tabRow(tabId: number) {
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
      insideActiveWindow: tabId === options.activeTabId
    };
  }

  function restoredRows() {
    return [
      {
        nodeId: "window:10",
        depth: 0,
        index: 0,
        subtreeEndIndex: 2,
        childCount: 1,
        visibleChildCount: 1,
        expanded: true,
        searchRevealsCollapsedChildren: false,
        isSearchMatch: false,
        isSearchPath: false,
        insideActiveWindow: false
      },
      { ...tabRow(1), index: 1, parentRowIndex: 0, subtreeEndIndex: 2, insideActiveWindow: false },
      {
        nodeId: "window:20",
        depth: 0,
        index: 2,
        subtreeEndIndex: 4,
        childCount: 1,
        visibleChildCount: 1,
        expanded: true,
        searchRevealsCollapsedChildren: false,
        isSearchMatch: false,
        isSearchPath: false,
        insideActiveWindow: false
      },
      { ...tabRow(2), index: 3, parentRowIndex: 2, subtreeEndIndex: 4, insideActiveWindow: true }
    ];
  }

  function closedRestoreRows() {
    return [
      {
        nodeId: "window:30",
        depth: 0,
        index: 0,
        subtreeEndIndex: 4,
        childCount: 3,
        visibleChildCount: 3,
        expanded: true,
        searchRevealsCollapsedChildren: false,
        isSearchMatch: false,
        isSearchPath: false,
        insideActiveWindow: false
      },
      { ...tabRow(30), index: 1, parentRowIndex: 0, subtreeEndIndex: 2, insideActiveWindow: false }
    ];
  }

  async function nextFrame() {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  }

  async function waitForIdleFrames(count: number) {
    for (let index = 0; index < count; index += 1) {
      await nextFrame();
    }
  }

  async function scrollToRow(rowIndex: number) {
    const viewport = viewportElement();
    viewport.scrollTop = rowIndex * rowHeight;
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    await nextFrame();
  }

  async function waitForSparseRequestCount(count: number) {
    for (let index = 0; index < 180; index += 1) {
      if (sliceRequests.length >= count) {
        return;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
    }
    throw new Error(`Timed out waiting for ${count} sparse slice request(s)`);
  }

  async function waitForVisibleRow(rowIndex: number) {
    const startedAt = performance.now();
    while (performance.now() - startedAt < 4000) {
      if (visibleRows().includes(rowIndex)) {
        return;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
    }
    throw new Error(`Timed out waiting for visible row ${rowIndex}`);
  }

  function visibleRows() {
    const viewport = viewportElement();
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
  }

  function viewportStartRow() {
    return Math.floor(viewportElement().scrollTop / rowHeight);
  }

  function viewportElement() {
    const viewport = document.querySelector<HTMLElement>("main");
    if (!viewport) {
      throw new Error("Missing sidebar viewport");
    }
    return viewport;
  }
}
