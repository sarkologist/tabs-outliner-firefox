import { expect, test, type Page } from "@playwright/test";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

type HarnessHistoryStatus = {
  canUndo: boolean;
  canRedo: boolean;
  undoDepth: number;
  redoDepth: number;
  undoLabel?: string;
  redoLabel?: string;
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

  test("psh-close-command-broadcast-removes-visible-row-during-hydration", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const row = nodeRow(page, "tab:800");
    await row.hover();
    await row.getByRole("button", { name: "Close", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      const before = api.visibleRows();
      api.emitDeletePatch(["tab:800"]);
      await api.waitForIdleFrames(3);
      return {
        before,
        after: api.visibleRows(),
        commands: api.sentCommands()
      };
    });

    expect(result.commands).toEqual([{ type: "closeNode", nodeId: "tab:800" }]);
    expect(result.before).toContain(800);
    await expect(page.locator(nodeSelector("tab:800"))).toHaveCount(0);
    expect(result.after).toContain(801);
    expect(issues).toEqual([]);
  });

  test("psh-close-command-delete-then-full-broadcast-keeps-row-removed", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const row = nodeRow(page, "tab:800");
    await row.hover();
    await row.getByRole("button", { name: "Close", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitDeletePatch(["tab:800"]);
      await api.waitForIdleFrames(2);
      const afterDelete = api.visibleRows();
      api.emitFullStateBroadcast();
      await api.waitForIdleFrames(4);
      return {
        afterDelete,
        afterBroadcast: api.visibleRows(),
        commands: api.sentCommands(),
        targetExists: Boolean(document.querySelector("[data-node-id='tab:800']"))
      };
    });

    expect(result.commands).toEqual([{ type: "closeNode", nodeId: "tab:800" }]);
    expect(result.afterDelete).toContain(801);
    expect(result.afterBroadcast).toContain(801);
    expect(result.targetExists).toBe(false);
    await expect(page.locator(nodeSelector("tab:800"))).toHaveCount(0);
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

  test("psh-move-to-top-level-remains-available-while-partial", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const row = nodeRow(page, "tab:800");
    await row.hover();
    await expect(row.getByRole("button", { name: "Cut", exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Paste", exact: true })).toHaveCount(0);
    await row.getByRole("button", { name: "Move to top level", exact: true }).click();

    await expect(sentCommands(page)).resolves.toEqual([{ type: "moveSubtreeToTopLevel", nodeId: "tab:800" }]);
    expect(issues).toEqual([]);
  });

  test("psh-cut-covered-row-marks-sparse-row-while-partial", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const row = nodeRow(page, "tab:800");
    await row.hover();
    await row.getByRole("button", { name: "Cut", exact: true }).click();

    await expect(page.locator(nodeSelector("tab:800"))).toHaveClass(/is-cut/);
    await expect(sentCommands(page)).resolves.toEqual([]);
    expect(issues).toEqual([]);
  });

  test("psh-keyboard-cut-works-and-paste-waits-while-partial", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await nodeRow(page, "tab:800").locator(".node-label").focus();
    await page.keyboard.press("Control+X");
    await expect(page.locator(nodeSelector("tab:800"))).toHaveClass(/is-cut/);
    await nodeRow(page, "tab:801").locator(".node-label").focus();
    await page.keyboard.press("Control+V");

    await expect(sentCommands(page)).resolves.toEqual([]);
    expect(issues).toEqual([]);
  });

  test("psh-cut-full-hydration-restores-paste-target", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await nodeRow(page, "tab:800").hover();
    await nodeRow(page, "tab:800").getByRole("button", { name: "Cut", exact: true }).click();
    await expect(page.locator(nodeSelector("tab:800"))).toHaveClass(/is-cut/);
    await nodeRow(page, "tab:801").hover();
    await expect(nodeRow(page, "tab:801").getByRole("button", { name: "Paste", exact: true })).toHaveCount(0);

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.resolveFullState();
      await api.waitForIdleFrames(6);
    });

    await nodeRow(page, "tab:801").hover();
    await nodeRow(page, "tab:801").getByRole("button", { name: "Paste", exact: true }).click();

    await expect(sentCommands(page)).resolves.toEqual([
      { type: "moveNode", nodeId: "tab:800", parentId: "window:1", index: 800 }
    ]);
    await expect(page.locator(nodeSelector("tab:800"))).not.toHaveClass(/is-cut/);
    expect(issues).toEqual([]);
  });

  test("psh-cut-full-hydration-history-status-paste-still-sends-move", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
    });

    await nodeRow(page, "tab:800").hover();
    await nodeRow(page, "tab:800").getByRole("button", { name: "Cut", exact: true }).click();
    await expect(page.locator(nodeSelector("tab:800"))).toHaveClass(/is-cut/);

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 2, redoDepth: 0, undoLabel: "cut source" });
      api.resolveFullState();
      await api.waitForIdleFrames(8);
    });

    await nodeRow(page, "tab:801").hover();
    await nodeRow(page, "tab:801").getByRole("button", { name: "Paste", exact: true }).click();

    await expect(sentCommands(page)).resolves.toEqual([
      { type: "moveNode", nodeId: "tab:800", parentId: "window:1", index: 800 }
    ]);
    await expect(page.locator(nodeSelector("tab:800"))).not.toHaveClass(/is-cut/);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-cut-node-deleted-before-hydration-clears-cut", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await nodeRow(page, "tab:800").hover();
    await nodeRow(page, "tab:800").getByRole("button", { name: "Cut", exact: true }).click();
    await expect(page.locator(nodeSelector("tab:800"))).toHaveClass(/is-cut/);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitDeletePatch(["tab:800"]);
      await api.waitForIdleFrames(4);
      return {
        visibleRows: api.visibleRows(),
        commands: api.sentCommands()
      };
    });

    await expect(page.locator(nodeSelector("tab:800"))).toHaveCount(0);
    await nodeRow(page, "tab:801").hover();
    await expect(nodeRow(page, "tab:801").getByRole("button", { name: "Paste", exact: true })).toHaveCount(0);
    expect(result.visibleRows).toContain(801);
    expect(result.commands).toEqual([]);
    expect(issues).toEqual([]);
  });

  test("psh-undo-during-sparse-window-preserves-viewport", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "sparse edit" }
    });

    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForVisibleRow(250);
      return { before: api.visibleRows() };
    });

    expect(result.before).toContain(250);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const afterUndo = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitDeletePatch(Array.from({ length: 28 }, (_value, index) => `tab:${250 + index}`));
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        visibleRows: api.visibleRows(),
        commands: api.sentCommands(),
        requestCount: api.sparseRequestCount()
      };
    });

    expect(afterUndo.commands).toEqual([{ type: "undo" }]);
    expect(afterUndo.requestCount).toBe(2);
    expect(afterUndo.visibleRows).toContain(250);
    expect(afterUndo.visibleRows).not.toContain(249);
    await expect(page.locator(nodeSelector("tab:250"))).toHaveCount(0);
    expect(issues).toEqual([]);
  });

  test("psh-redo-keyboard-during-pending-slice-keeps-intent", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "sparse redo" }
    });

    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
    });

    await page.keyboard.press("Control+Shift+Z");
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.resolveSliceAt(0, { start: 700, end: 760 });
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        visibleRows: api.visibleRows()
      };
    });

    expect(result.commands).toEqual([{ type: "redo" }]);
    expect(result.requests).toHaveLength(2);
    expect(result.visibleRows).toContain(250);
    await expect(nodeRow(page, "tab:250")).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-redo-toolbar-during-pending-slice-keeps-intent", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "toolbar redo" }
    });

    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
    });

    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "toolbar redo" });
      api.resolveSliceAt(0, { start: 700, end: 760 });
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0);
      await api.waitForVisibleRow(250);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        visibleRows: api.visibleRows()
      };
    });

    expect(result.commands).toEqual([{ type: "redo" }]);
    expect(result.requests).toHaveLength(2);
    expect(result.visibleRows).toContain(250);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeDisabled();
    await expect(nodeRow(page, "tab:250")).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-undo-full-broadcast-beats-stale-scroll-slice", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "sparse edit" }
    });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      return { beforeRequests: api.projectionRequests() };
    });
    expect(result.beforeRequests).toHaveLength(1);

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const afterBroadcast = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitFullStateBroadcast();
      await api.waitForVisibleRow(250);
      const beforeStale = api.visibleRows();
      api.resolveSliceAt(0, { start: 700, end: 760 });
      await api.waitForIdleFrames(4);
      return {
        beforeStale,
        afterStale: api.visibleRows(),
        commands: api.sentCommands(),
        requests: api.projectionRequests()
      };
    });

    expect(afterBroadcast.commands).toEqual([{ type: "undo" }]);
    expect(afterBroadcast.requests).toHaveLength(1);
    expect(afterBroadcast.beforeStale).toContain(250);
    expect(afterBroadcast.afterStale).toContain(250);
    await expect(nodeRow(page, "tab:250")).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-missing-coverage-undo-patch-keeps-row-actions-readonly", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      includeCoverage: false,
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
    });

    const row = nodeRow(page, "tab:799");
    await row.hover();
    await expect(row.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitTitlePatch("tab:799", "Readonly patched row");
      await api.waitForIdleFrames(4);
    });

    await expect(row).toContainText("Readonly patched row");
    await row.hover();
    await expect(row.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Move to top level", exact: true })).toHaveCount(0);
    await expect(sentCommands(page)).resolves.toEqual([{ type: "undo" }]);
    expect(issues).toEqual([]);
  });

  test("psh-drag-blocked-while-partial-recovers-after-hydration", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: false, fullStatePending: true });

    await dragAfter(page, "tab:800", "tab:801");
    const beforeHydration = await page.evaluate(async () => {
      await projectionHuntApi().waitForIdleFrames(2);
      return {
        commands: projectionHuntApi().sentCommands(),
        visibleRows: projectionHuntApi().visibleRows()
      };
    });

    expect(beforeHydration.commands).toEqual([]);
    expect(beforeHydration.visibleRows).toContain(800);

    await nodeRow(page, "tab:800").hover();
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.resolveFullState();
      await api.waitForIdleFrames(20);
    });
    await dragAfter(page, "tab:800", "tab:801");
    const afterHydration = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForIdleFrames(2);
      return {
        commands: api.sentCommands(),
        visibleRows: api.visibleRows()
      };
    });

    expect(afterHydration.commands).toHaveLength(1);
    expect(afterHydration.commands[0]).toMatchObject({ type: "moveNode", nodeId: "tab:800" });
    expect(afterHydration.visibleRows).toContain(800);
    expect(issues).toEqual([]);
  });

  test("psh-move-to-root-history-status-stale-slice-keeps-command-and-viewport", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
    });

    const row = nodeRow(page, "tab:800");
    await row.hover();
    await row.getByRole("button", { name: "Move to top level", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(900);
      await api.waitForSparseRequestCount(1);
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 2, redoDepth: 0, undoLabel: "move to root" });
      api.resolveSliceAt(0, { start: 760, end: 840 });
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0);
      await api.waitForVisibleRow(900);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        visibleRows: api.visibleRows()
      };
    });

    expect(result.commands).toEqual([{ type: "moveSubtreeToTopLevel", nodeId: "tab:800" }]);
    expect(result.requests).toHaveLength(2);
    expect(result.visibleRows).toContain(900);
    await expect(nodeRow(page, "tab:900")).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-drag-after-hydration-baseline-sends-command", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: false, fullStatePending: true });

    await nodeRow(page, "tab:800").hover();
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.resolveFullState();
      await api.waitForIdleFrames(20);
    });
    await dragAfter(page, "tab:800", "tab:801");

    await expect(sentCommands(page)).resolves.toHaveLength(1);
    await expect(sentCommands(page)).resolves.toEqual([
      expect.objectContaining({ type: "moveNode", nodeId: "tab:800" })
    ]);
    expect(issues).toEqual([]);
  });

  test("psh-drag-after-hydration-history-status-broadcast-keeps-command-and-viewport", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      includeCoverage: false,
      fullStatePending: true,
      historyStatus: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
    });

    await nodeRow(page, "tab:800").hover();
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.resolveFullState();
      await api.waitForIdleFrames(20);
    });
    await dragAfter(page, "tab:800", "tab:801");
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "drag move" });
      api.emitFullStateBroadcast();
      await api.waitForIdleFrames(6);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        visibleRows: api.visibleRows()
      };
    });

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({ type: "moveNode", nodeId: "tab:800" });
    expect(result.requests).toHaveLength(0);
    expect(result.visibleRows).toContain(800);
    await expect(nodeRow(page, "tab:800")).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-undo-stale-scroll-response-after-search-keeps-query", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
    });

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
    });
    await page.locator("#search").fill("Tab 900");
    await page.waitForFunction(() => projectionHuntApi().sparseRequestCount() >= 2);

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
      const afterStaleScroll = {
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        hasScrollRow: Boolean(document.querySelector("[data-node-id='tab:250']")),
        visibleRows: api.visibleRows()
      };
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        afterStaleScroll,
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toContainEqual({ type: "undo" });
    expect(result.requests.map((request) => request.query)).toEqual(["", "Tab 900"]);
    expect(result.afterStaleScroll.searchValue).toBe("Tab 900");
    expect(result.afterStaleScroll.hasScrollRow).toBe(false);
    expect(result.searchValue).toBe("Tab 900");
    expect(result.visibleRows).toContain(1);
    expect(result.countText).toBe("1 match / 1001 items");
    await expect(nodeRow(page, "tab:900")).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-cut-clear-search-delete-pending-cut-keeps-outline", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await nodeRow(page, "tab:800").hover();
    await nodeRow(page, "tab:800").getByRole("button", { name: "Cut", exact: true }).click();
    await expect(page.locator(nodeSelector("tab:800"))).toHaveClass(/is-cut/);

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });
    await expect(nodeRow(page, "tab:900")).toBeVisible();

    await page.locator("#clear-search").click();
    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(2);
      api.emitDeletePatch(["tab:800"]);
      await api.waitForIdleFrames(2);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        requests: api.projectionRequests(),
        commands: api.sentCommands(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        countText: document.querySelector("#state-count")?.textContent ?? "",
        cutExists: Boolean(document.querySelector("[data-node-id='tab:800']")),
        cutMarkers: document.querySelectorAll(".is-cut").length
      };
    });

    expect(result.requests.slice(0, 2).map((request) => request.query)).toEqual(["Tab 900", ""]);
    expect(result.requests.slice(2).every((request) => request.query === "")).toBe(true);
    expect(result.commands).toEqual([]);
    expect(result.searchValue).toBe("");
    expect(result.countText).toMatch(/^100[01] items \/ 0 saved$/);
    expect(result.visibleRows.length).toBeGreaterThan(0);
    expect(result.cutExists).toBe(false);
    expect(result.cutMarkers).toBe(0);
    expect(issues).toEqual([]);
  });

  test("psh-temporal-heat-undo-scroll-search-clear-stale-order", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "temporal edit" }
    });

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
    });
    await page.locator("#search").fill("Tab 900");
    await page.waitForFunction(() => projectionHuntApi().sparseRequestCount() >= 2);
    await page.locator("#clear-search").click();
    await page.waitForFunction(() => projectionHuntApi().sparseRequestCount() >= 3);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.resolveSliceAt(1);
      await api.waitForIdleFrames(2);
      const afterStaleSearch = {
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        targetExists: Boolean(document.querySelector("[data-node-id='tab:900']")),
        visibleRows: api.visibleRows()
      };
      api.resolveSliceAt(0, { start: 700, end: 760 });
      await api.waitForIdleFrames(2);
      const afterStaleScroll = {
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        targetExists: Boolean(document.querySelector("[data-node-id='tab:900']")),
        visibleRows: api.visibleRows()
      };
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        afterStaleSearch,
        afterStaleScroll,
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toContainEqual({ type: "undo" });
    expect(result.requests.slice(0, 3).map((request) => request.query)).toEqual(["", "Tab 900", ""]);
    expect(result.requests.slice(3).every((request) => request.query === "")).toBe(true);
    expect(result.afterStaleSearch.searchValue).toBe("");
    expect(result.afterStaleSearch.targetExists).toBe(false);
    expect(result.afterStaleScroll.searchValue).toBe("");
    expect(result.afterStaleScroll.targetExists).toBe(false);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows.length).toBeGreaterThan(0);
    expect(issues).toEqual([]);
  });

  test("psh-undo-history-status-update-while-slice-pending-keeps-viewport", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "pending sparse edit" }
    });

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
    });
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "pending sparse edit" });
      await api.waitForIdleFrames(2);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        visibleRows: api.visibleRows(),
        requests: api.projectionRequests()
      };
    });

    expect(result.commands).toContainEqual({ type: "undo" });
    expect(result.requests).toHaveLength(1);
    expect(result.visibleRows).toContain(250);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
    await expect(nodeRow(page, "tab:250")).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-redo-delete-broadcast-during-pending-slice-refills-current-window", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote delete" }
    });

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { start: 250, end: 278 });
      await api.waitForVisibleRow(250);
    });
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitDeletePatch(Array.from({ length: 28 }, (_value, index) => `tab:${250 + index}`));
      await api.waitForSparseRequestCount(2);
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote delete" });
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requestCount: api.sparseRequestCount(),
        visibleRows: api.visibleRows()
      };
    });

    expect(result.commands).toEqual([{ type: "redo" }]);
    expect(result.requestCount).toBe(2);
    expect(result.visibleRows.length).toBeGreaterThan(0);
    expect(result.visibleRows).toContain(250);
    await expect(page.locator(nodeSelector("tab:250"))).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeDisabled();
    expect(issues).toEqual([]);
  });

  test("psh-cut-undo-delete-broadcast-clears-local-cut-and-keeps-viewport", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
    });

    await nodeRow(page, "tab:800").hover();
    await nodeRow(page, "tab:800").getByRole("button", { name: "Cut", exact: true }).click();
    await expect(page.locator(nodeSelector("tab:800"))).toHaveClass(/is-cut/);

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" });
      api.emitDeletePatch(["tab:800"]);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        visibleRows: api.visibleRows(),
        cutMarkers: document.querySelectorAll(".is-cut").length
      };
    });

    expect(result.commands).toContainEqual({ type: "undo" });
    expect(result.visibleRows).toContain(801);
    expect(result.cutMarkers).toBe(0);
    await expect(page.locator(nodeSelector("tab:800"))).toHaveCount(0);
    await nodeRow(page, "tab:801").hover();
    await expect(nodeRow(page, "tab:801").getByRole("button", { name: "Paste", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-missing-coverage-redo-full-hydration-restores-actions-after-status", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      includeCoverage: false,
      fullStatePending: true,
      historyStatus: { canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote redo" }
    });

    const row = nodeRow(page, "tab:799");
    await row.hover();
    await expect(row.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote redo" });
      api.resolveFullState();
      await api.waitForIdleFrames(10);
    });

    await row.hover();
    await expect(row.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Move to top level", exact: true })).toBeVisible();
    await expect(sentCommands(page)).resolves.toEqual([{ type: "redo" }]);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeDisabled();
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

  test("psh-coverage-missing-snapshot-restores-actions-after-full-hydration", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: false, fullStatePending: true });

    const row = nodeRow(page, "tab:799");
    await row.hover();
    await expect(row.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.resolveFullState();
      await api.waitForIdleFrames(6);
    });

    await row.hover();
    await expect(row.getByRole("button", { name: "Close", exact: true })).toBeVisible();
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

  test("psh-visible-sparse-delete-refills-exposed-viewport-without-scroll", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { start: 250, end: 278 });
      await api.waitForIdleFrames(2);

      const before = api.visibleRows();
      const deletedNodeIds = Array.from({ length: 28 }, (_value, index) => `tab:${250 + index}`);
      api.emitDeletePatch(deletedNodeIds);
      await api.waitForSparseRequestCount(2);
      const afterLocalDelete = api.visibleRows();

      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        before,
        afterLocalDelete,
        afterRefill: api.visibleRows(),
        requests: api.projectionRequests(),
        deletedStillRendered: deletedNodeIds.some((nodeId) => Boolean(document.querySelector(`[data-node-id="${nodeId}"]`)))
      };
    });

    expect(result.before).toContain(250);
    expect(result.afterLocalDelete).not.toContain(250);
    expect(result.requests).toHaveLength(2);
    expect(result.requests.at(-1)).toMatchObject({ query: "" });
    expect(result.afterRefill).toContain(250);
    await expect(nodeRow(page, "tab:278")).toBeVisible();
    expect(result.deletedStillRendered).toBe(false);
    expect(issues).toEqual([]);
  });

  test("psh-clear-search-ignores-stale-query-response", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      const search = document.querySelector<HTMLInputElement>("#search");
      const clear = document.querySelector<HTMLButtonElement>("#clear-search");
      if (!search || !clear) {
        throw new Error("Missing search controls");
      }

      search.focus();
      search.value = "Tab 900";
      search.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "Tab 900"
      }));
      await api.waitForSparseRequestCount(1);

      clear.click();
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(2);
      api.resolveSliceAt(0);
      if (api.sparseRequestCount() > 2) {
        api.resolveSliceAt(0);
      }
      await api.waitForIdleFrames(3);

      return {
        requests: api.projectionRequests(),
        searchValue: search.value,
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows()
      };
    });

    expect(result.requests[0]?.query).toBe("Tab 900");
    expect(result.requests.slice(1).every((request) => request.query === "")).toBe(true);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows.length).toBeGreaterThan(0);
    expect(issues).toEqual([]);
  });

  test("psh-search-rejected-query-keeps-current-outline-painted", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      const search = document.querySelector<HTMLInputElement>("#search");
      if (!search) {
        throw new Error("Missing search input");
      }

      search.focus();
      search.value = "Tab 900";
      search.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "Tab 900"
      }));
      await api.waitForSparseRequestCount(1);
      api.rejectSliceAt(0);
      await api.waitForIdleFrames(4);

      return {
        requests: api.projectionRequests(),
        searchValue: search.value,
        visibleRows: api.visibleRows(),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({ query: "Tab 900" });
    expect(result.searchValue).toBe("Tab 900");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows).toContain(800);
    expect(issues.filter((issue) => issue.kind !== "console")).toEqual([]);
  });

  test("psh-clear-search-rejected-response-restores-outline-chrome", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      const clear = document.querySelector<HTMLButtonElement>("#clear-search");
      if (!clear) {
        throw new Error("Missing clear search button");
      }

      clear.click();
      await api.waitForSparseRequestCount(2);
      api.rejectSliceAt(0);
      await api.waitForIdleFrames(4);

      return {
        requests: api.projectionRequests(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        countText: document.querySelector("#state-count")?.textContent ?? "",
        targetExists: Boolean(document.querySelector("[data-node-id='tab:900']"))
      };
    });

    expect(result.requests.map((request) => request.query)).toEqual(["Tab 900", ""]);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.targetExists).toBe(false);
    expect(result.visibleRows.length).toBeGreaterThan(0);
    expect(issues.filter((issue) => issue.kind !== "console")).toEqual([]);
  });

  test("psh-clear-search-rejected-after-redo-status-keeps-outline-chrome", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" }
    });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });
    await page.locator("#clear-search").click();
    await page.waitForFunction(() => projectionHuntApi().sparseRequestCount() >= 2);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" });
      api.rejectSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        countText: document.querySelector("#state-count")?.textContent ?? "",
        targetExists: Boolean(document.querySelector("[data-node-id='tab:900']"))
      };
    });

    expect(result.commands).toEqual([{ type: "redo" }]);
    expect(result.requests.map((request) => request.query)).toEqual(["Tab 900", ""]);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.targetExists).toBe(false);
    expect(result.visibleRows.length).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeDisabled();
    expect(issues.filter((issue) => issue.kind !== "console")).toEqual([]);
  });

  test("psh-show-in-tree-target-slice-centers-remote-row", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });

    const row = nodeRow(page, "tab:900");
    await expect(row).toBeVisible();
    await row.hover();
    await row.getByRole("button", { name: "Show in tree", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
      return {
        requests: api.projectionRequests(),
        visibleRows: api.visibleRows(),
        viewportStartRow: api.viewportStartRow()
      };
    });

    await expect(page.locator(`${nodeSelector("tab:900")}.is-reveal-highlight`)).toBeVisible();
    await expect(page.locator("#search")).toHaveValue("");
    expect(result.requests).toContainEqual(expect.objectContaining({ query: "", targetNodeId: "tab:900" }));
    expect(result.requests.at(-1)).toMatchObject({ query: "" });
    expect(result.visibleRows).toContain(900);
    expect(result.viewportStartRow).toBeGreaterThanOrEqual(880);
    expect(result.viewportStartRow).toBeLessThanOrEqual(920);
    expect(issues).toEqual([]);
  });

  test("psh-show-in-tree-undo-status-before-target-slice-keeps-target-intent", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
    });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });

    const row = nodeRow(page, "tab:900");
    await expect(row).toBeVisible();
    await row.hover();
    await row.getByRole("button", { name: "Show in tree", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sparseRequestCount() >= 2);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Undo", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForIdleFrames(4);
      api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" });
      await api.waitForIdleFrames(2);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        viewportStartRow: api.viewportStartRow()
      };
    });

    expect(result.commands).toContainEqual({ type: "undo" });
    expect(result.requests).toContainEqual(expect.objectContaining({ query: "", targetNodeId: "tab:900" }));
    expect(result.searchValue).toBe("");
    expect(result.visibleRows).toContain(900);
    expect(result.viewportStartRow).toBeGreaterThanOrEqual(880);
    expect(result.viewportStartRow).toBeLessThanOrEqual(920);
    await expect(page.locator(`${nodeSelector("tab:900")}.is-reveal-highlight`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-show-in-tree-rejected-target-after-history-status-keeps-outline-painted", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
    });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });

    const row = nodeRow(page, "tab:900");
    await expect(row).toBeVisible();
    await row.hover();
    await row.getByRole("button", { name: "Show in tree", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sparseRequestCount() >= 2);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" });
      api.rejectSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        countText: document.querySelector("#state-count")?.textContent ?? "",
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(result.commands).toEqual([{ type: "expandAncestors", nodeId: "tab:900" }]);
    expect(result.requests).toContainEqual(expect.objectContaining({ query: "", targetNodeId: "tab:900" }));
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows.length).toBeGreaterThan(0);
    expect(result.hasRevealHighlight).toBe(false);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
    expect(issues.filter((issue) => issue.kind !== "console")).toEqual([]);
  });

  test("psh-show-in-tree-target-deleted-after-history-status-keeps-outline-painted", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
    });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });

    const row = nodeRow(page, "tab:900");
    await expect(row).toBeVisible();
    await row.hover();
    await row.getByRole("button", { name: "Show in tree", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(2);
      api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" });
      api.emitDeletePatch(["tab:900"]);
      await api.waitForIdleFrames(2);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        targetExists: Boolean(document.querySelector("[data-node-id='tab:900']")),
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(result.commands).toEqual([{ type: "expandAncestors", nodeId: "tab:900" }]);
    expect(result.requests).toContainEqual(expect.objectContaining({ query: "", targetNodeId: "tab:900" }));
    expect(result.searchValue).toBe("");
    expect(result.targetExists).toBe(false);
    expect(result.visibleRows.length).toBeGreaterThan(0);
    expect(result.hasRevealHighlight).toBe(false);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-show-in-tree-full-broadcast-after-history-status-keeps-target-intent", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
    });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });

    const row = nodeRow(page, "tab:900");
    await expect(row).toBeVisible();
    await row.hover();
    await row.getByRole("button", { name: "Show in tree", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(2);
      api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" });
      api.emitFullStateBroadcast();
      await api.waitForIdleFrames(2);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        viewportStartRow: api.viewportStartRow(),
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(result.commands).toEqual([{ type: "expandAncestors", nodeId: "tab:900" }]);
    expect(result.requests).toContainEqual(expect.objectContaining({ query: "", targetNodeId: "tab:900" }));
    expect(result.searchValue).toBe("");
    expect(result.visibleRows).toContain(900);
    expect(result.viewportStartRow).toBeGreaterThanOrEqual(880);
    expect(result.viewportStartRow).toBeLessThanOrEqual(920);
    expect(result.hasRevealHighlight).toBe(true);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-show-in-tree-keyboard-undo-before-target-slice-sends-command", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
    });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });

    const row = nodeRow(page, "tab:900");
    await expect(row).toBeVisible();
    await row.hover();
    await row.getByRole("button", { name: "Show in tree", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sparseRequestCount() >= 2);
    await row.locator(".node-label").focus();
    await page.keyboard.press("Control+Z");
    await page.waitForFunction(() => projectionHuntApi().sentCommands().some((command) => (
      typeof command === "object" && command !== null && (command as { type?: unknown }).type === "undo"
    )));

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" });
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        viewportStartRow: api.viewportStartRow()
      };
    });

    expect(result.commands).toEqual([
      { type: "expandAncestors", nodeId: "tab:900" },
      { type: "undo" }
    ]);
    expect(result.requests).toContainEqual(expect.objectContaining({ query: "", targetNodeId: "tab:900" }));
    expect(result.searchValue).toBe("");
    expect(result.visibleRows).toContain(900);
    expect(result.viewportStartRow).toBeGreaterThanOrEqual(880);
    expect(result.viewportStartRow).toBeLessThanOrEqual(920);
    await expect(page.locator(`${nodeSelector("tab:900")}.is-reveal-highlight`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-show-in-tree-target-deleted-before-slice-keeps-viewport-painted", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });

    const row = nodeRow(page, "tab:900");
    await expect(row).toBeVisible();
    await row.hover();
    await row.getByRole("button", { name: "Show in tree", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(2);
      api.emitDeletePatch(["tab:900"]);
      await api.waitForIdleFrames(2);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        requests: api.projectionRequests(),
        visibleRows: api.visibleRows(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        targetExists: Boolean(document.querySelector("[data-node-id='tab:900']"))
      };
    });

    expect(result.requests).toContainEqual(expect.objectContaining({ query: "", targetNodeId: "tab:900" }));
    expect(result.requests.at(-1)).toMatchObject({ query: "" });
    expect(result.searchValue).toBe("");
    expect(result.targetExists).toBe(false);
    expect(result.visibleRows.length).toBeGreaterThan(0);
    expect(issues).toEqual([]);
  });

  test("psh-show-in-tree-noncovering-target-response-restores-outline", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });

    const row = nodeRow(page, "tab:900");
    await expect(row).toBeVisible();
    await row.hover();
    await row.getByRole("button", { name: "Show in tree", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0, { start: 200, end: 230 });
      await api.waitForIdleFrames(4);
      return {
        requests: api.projectionRequests(),
        visibleRows: api.visibleRows(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight")),
        targetExists: Boolean(document.querySelector("[data-node-id='tab:900']"))
      };
    });

    expect(result.requests.at(-1)).toMatchObject({ query: "", targetNodeId: "tab:900" });
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows).toContain(800);
    expect(result.visibleRows).not.toContain(200);
    expect(result.targetExists).toBe(false);
    expect(result.hasRevealHighlight).toBe(false);
    expect(issues).toEqual([]);
  });

  test("psh-rapid-show-in-tree-last-target-wins-highlight", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Tab 90");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });

    await expect(nodeRow(page, "tab:900")).toBeVisible();
    await expect(nodeRow(page, "tab:901")).toBeVisible();
    await nodeRow(page, "tab:900").hover();
    await nodeRow(page, "tab:900").getByRole("button", { name: "Show in tree", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sparseRequestCount() >= 2);

    await page.locator("#search").fill("Tab 901");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(3);
      api.resolveSliceAt(1);
      await api.waitForIdleFrames(3);
    });

    await expect(nodeRow(page, "tab:901")).toBeVisible();
    await nodeRow(page, "tab:901").hover();
    await nodeRow(page, "tab:901").getByRole("button", { name: "Show in tree", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(4);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
      const afterStaleFirstTarget = {
        visibleRows: api.visibleRows(),
        hasTab900Highlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight")),
        hasTab901Highlight: Boolean(document.querySelector("[data-node-id='tab:901'].is-reveal-highlight")),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? ""
      };

      api.resolveSliceAt(0);
      await api.waitForVisibleRow(901);
      await api.waitForIdleFrames(3);
      return {
        requests: api.projectionRequests(),
        afterStaleFirstTarget,
        finalVisibleRows: api.visibleRows(),
        finalSearchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        finalViewportStartRow: api.viewportStartRow(),
        hasTab900Highlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight")),
        hasTab901Highlight: Boolean(document.querySelector("[data-node-id='tab:901'].is-reveal-highlight"))
      };
    });

    expect(result.requests.map((request) => ({
      query: request.query,
      targetNodeId: request.targetNodeId
    }))).toEqual([
      { query: "Tab 90", targetNodeId: undefined },
      { query: "", targetNodeId: "tab:900" },
      { query: "Tab 901", targetNodeId: undefined },
      { query: "", targetNodeId: "tab:901" }
    ]);
    expect(result.afterStaleFirstTarget.searchValue).toBe("");
    expect(result.afterStaleFirstTarget.hasTab900Highlight).toBe(false);
    expect(result.finalSearchValue).toBe("");
    expect(result.finalVisibleRows).toContain(901);
    expect(result.finalViewportStartRow).toBeGreaterThanOrEqual(881);
    expect(result.finalViewportStartRow).toBeLessThanOrEqual(921);
    expect(result.hasTab900Highlight).toBe(false);
    expect(result.hasTab901Highlight).toBe(true);
    await expect(page.locator(`${nodeSelector("tab:901")}.is-reveal-highlight`)).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-show-in-tree-hover-controls-survive-background-refill", async ({ page }) => {
    test.fail(true, "PT-017: show-in-tree target reveal can lose its target after background refill");
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });

    await expect(nodeRow(page, "tab:900")).toBeVisible();
    await nodeRow(page, "tab:900").hover();
    await nodeRow(page, "tab:900").getByRole("button", { name: "Show in tree", exact: true }).click();

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0);
      await api.waitForVisibleRow(900);
      await api.waitForIdleFrames(3);
    });

    const targetRow = nodeRow(page, "tab:900");
    await expect(targetRow).toBeVisible();
    await expect(page.locator(`${nodeSelector("tab:900")}.is-reveal-highlight`)).toBeVisible();
    await targetRow.hover();
    await expect(targetRow.getByRole("button", { name: "Cut", exact: true })).toBeVisible();
    await expect(targetRow.getByRole("button", { name: "Move to top level", exact: true })).toBeVisible();
    await expect(targetRow.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    await expect(targetRow.getByRole("button", { name: "Delete", exact: true })).toBeVisible();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitDeletePatch(Array.from({ length: 28 }, (_value, index) => `tab:${901 + index}`));
      await api.waitForIdleFrames(3);
      if (api.sparseRequestCount() > 2) {
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(4);
      }
      return {
        requests: api.projectionRequests(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        hasRevealHighlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight")),
        deletedStillRendered: Array.from({ length: 28 }, (_value, index) => (
          Boolean(document.querySelector(`[data-node-id="tab:${901 + index}"]`))
        )).some(Boolean)
      };
    });

    expect(result.searchValue).toBe("");
    expect(result.visibleRows).toContain(900);
    expect(result.hasRevealHighlight).toBe(true);
    expect(result.deletedStillRendered).toBe(false);
    await targetRow.hover();
    await expect(targetRow.getByRole("button", { name: "Cut", exact: true })).toBeVisible();
    await expect(targetRow.getByRole("button", { name: "Move to top level", exact: true })).toBeVisible();
    await expect(targetRow.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    await expect(result.requests).toContainEqual(expect.objectContaining({ query: "", targetNodeId: "tab:900" }));
    expect(issues).toEqual([]);
  });

  test("psh-target-response-after-rejected-new-query-does-not-reveal-stale-target", async ({ page }) => {
    test.fail(true, "PT-016: rejected newer search can leave older search projection under the current query");
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });

    const row = nodeRow(page, "tab:900");
    await expect(row).toBeVisible();
    await row.hover();
    await row.getByRole("button", { name: "Show in tree", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sparseRequestCount() >= 2);

    await page.locator("#search").fill("Tab 91");

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(3);
      api.rejectSliceAt(1);
      await api.waitForIdleFrames(3);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        requests: api.projectionRequests(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight")),
        hasTab900: Boolean(document.querySelector("[data-node-id='tab:900']")),
        hasTab91: Boolean(document.querySelector("[data-node-id='tab:91']"))
      };
    });

    expect(result.requests.map((request) => ({
      query: request.query,
      targetNodeId: request.targetNodeId
    }))).toEqual([
      { query: "Tab 900", targetNodeId: undefined },
      { query: "", targetNodeId: "tab:900" },
      { query: "Tab 91", targetNodeId: undefined }
    ]);
    expect(result.searchValue).toBe("Tab 91");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows).toContain(800);
    expect(result.hasRevealHighlight).toBe(false);
    expect(result.hasTab900).toBe(false);
    expect(result.hasTab91).toBe(false);
    expect(issues.filter((issue) => issue.kind !== "console")).toEqual([]);
  });

  test("psh-show-in-tree-stale-target-after-search-clear-keeps-outline", async ({ page }) => {
    test.fail(true, "PT-018: stale target response can restore old search chrome after clear-search");
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });

    await expect(nodeRow(page, "tab:900")).toBeVisible();
    await nodeRow(page, "tab:900").hover();
    await nodeRow(page, "tab:900").getByRole("button", { name: "Show in tree", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sparseRequestCount() >= 2);

    await page.locator("#search").fill("Tab 91");
    await page.waitForFunction(() => projectionHuntApi().sparseRequestCount() >= 3);
    await page.locator("#clear-search").click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(4);

      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
      const afterStaleTarget = {
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight")),
        hasTab900: Boolean(document.querySelector("[data-node-id='tab:900']"))
      };

      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
      const afterStaleSearch = {
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasTab91: Boolean(document.querySelector("[data-node-id='tab:91']"))
      };

      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        requests: api.projectionRequests(),
        afterStaleTarget,
        afterStaleSearch,
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight")),
        hasTab900: Boolean(document.querySelector("[data-node-id='tab:900']")),
        hasTab91: Boolean(document.querySelector("[data-node-id='tab:91']"))
      };
    });

    expect(result.requests.map((request) => ({
      query: request.query,
      targetNodeId: request.targetNodeId
    }))).toEqual([
      { query: "Tab 900", targetNodeId: undefined },
      { query: "", targetNodeId: "tab:900" },
      { query: "Tab 91", targetNodeId: undefined },
      { query: "", targetNodeId: undefined }
    ]);
    expect(result.afterStaleTarget.searchValue).toBe("");
    expect(result.afterStaleTarget.countText).toBe("1001 items / 0 saved");
    expect(result.afterStaleTarget.visibleRows).toContain(800);
    expect(result.afterStaleTarget.hasRevealHighlight).toBe(false);
    expect(result.afterStaleTarget.hasTab900).toBe(false);
    expect(result.afterStaleSearch.searchValue).toBe("");
    expect(result.afterStaleSearch.countText).toBe("1001 items / 0 saved");
    expect(result.afterStaleSearch.visibleRows).toContain(800);
    expect(result.afterStaleSearch.hasTab91).toBe(false);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows.length).toBeGreaterThan(0);
    expect(result.hasRevealHighlight).toBe(false);
    expect(result.hasTab900).toBe(false);
    expect(result.hasTab91).toBe(false);
    expect(issues).toEqual([]);
  });

  test("psh-show-in-tree-missing-coverage-restores-actions-after-hydration", async ({ page }) => {
    test.fail(true, "PT-019: target projection without coverage can expose edit actions while hydrating");
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: false, fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });

    await expect(nodeRow(page, "tab:900")).toBeVisible();
    await nodeRow(page, "tab:900").hover();
    await nodeRow(page, "tab:900").getByRole("button", { name: "Show in tree", exact: true }).click();

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0);
      await api.waitForVisibleRow(900);
      await api.waitForIdleFrames(3);
    });

    const targetRow = nodeRow(page, "tab:900");
    await expect(targetRow).toBeVisible();
    await expect(page.locator(`${nodeSelector("tab:900")}.is-reveal-highlight`)).toBeVisible();
    await targetRow.hover();
    await expect(targetRow.getByRole("button", { name: "Cut", exact: true })).toHaveCount(0);
    await expect(targetRow.getByRole("button", { name: "Move to top level", exact: true })).toHaveCount(0);
    await expect(targetRow.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.resolveFullState();
      await api.waitForIdleFrames(20);
      return {
        requests: api.projectionRequests(),
        visibleRows: api.visibleRows(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        hasRevealHighlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight"))
      };
    });

    expect(result.requests.map((request) => ({
      query: request.query,
      targetNodeId: request.targetNodeId
    }))).toEqual([
      { query: "Tab 900", targetNodeId: undefined },
      { query: "", targetNodeId: "tab:900" }
    ]);
    expect(result.searchValue).toBe("");
    expect(result.visibleRows).toContain(900);
    expect(result.hasRevealHighlight).toBe(true);
    await targetRow.hover();
    await expect(targetRow.getByRole("button", { name: "Cut", exact: true })).toBeVisible();
    await expect(targetRow.getByRole("button", { name: "Move to top level", exact: true })).toBeVisible();
    await expect(targetRow.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-two-sidebars-target-and-search-intents-survive-shared-title-patch", async ({ page }) => {
    test.fail(true, "Duplicate PT-017: background patch can dislodge a target reveal");
    const issuesA = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, { fullStatePending: true });

      await page.locator("#search").fill("Tab 900");
      await page.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(3);
      });

      await pageB.locator("#search").fill("Tab 91");
      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(3);
      });

      await expect(nodeRow(page, "tab:900")).toBeVisible();
      await expect(nodeRow(pageB, "tab:91")).toBeVisible();
      await nodeRow(page, "tab:900").hover();
      await nodeRow(page, "tab:900").getByRole("button", { name: "Show in tree", exact: true }).click();

      await page.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForSparseRequestCount(2);
        api.resolveSliceAt(0);
        await api.waitForVisibleRow(900);
        await api.waitForIdleFrames(3);
      });

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitTitlePatch("tab:91", "Tab 91 patched from shared background");
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows(),
            hasTab900Highlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight")),
            hasTab91: Boolean(document.querySelector("[data-node-id='tab:91']"))
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitTitlePatch("tab:91", "Tab 91 patched from shared background");
          await api.waitForIdleFrames(4);
          if (api.sparseRequestCount() > 1) {
            api.resolveSliceAt(0);
            await api.waitForIdleFrames(4);
          }
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            visibleRows: api.visibleRows(),
            tab91Text: document.querySelector("[data-node-id='tab:91']")?.textContent ?? ""
          };
        })
      ]);

      expect(resultA.commands).toContainEqual({ type: "expandAncestors", nodeId: "tab:900" });
      expect(resultA.requests.map((request) => ({
        query: request.query,
        targetNodeId: request.targetNodeId
      }))).toEqual([
        { query: "Tab 900", targetNodeId: undefined },
        { query: "", targetNodeId: "tab:900" }
      ]);
      expect(resultA.searchValue).toBe("");
      expect(resultA.visibleRows).toContain(900);
      expect(resultA.hasTab900Highlight).toBe(true);
      expect(resultA.hasTab91).toBe(false);

      expect(resultB.commands).toEqual([]);
      expect(resultB.requests.map((request) => request.query)).toContain("Tab 91");
      expect(resultB.searchValue).toBe("Tab 91");
      expect(resultB.countText).toBe("11 matches / 1001 items");
      expect(resultB.visibleRows).toContain(1);
      expect(resultB.tab91Text).toContain("Tab 91 patched from shared background");
      await expect(page.locator(`${nodeSelector("tab:900")}.is-reveal-highlight`)).toBeVisible();
      await expect(nodeRow(pageB, "tab:91")).toContainText("Tab 91 patched from shared background");
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-two-sidebars-search-and-scroll-intents-survive-shared-title-patch", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, { fullStatePending: true });

      await page.locator("#search").fill("Tab 91");
      await page.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(3);
      });

      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.scrollToRow(250);
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0);
        await api.waitForVisibleRow(250);
        await api.waitForIdleFrames(3);
      });

      await expect(nodeRow(page, "tab:91")).toBeVisible();
      await expect(nodeRow(pageB, "tab:250")).toBeVisible();

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitTitlePatch("tab:91", "Tab 91 patched from shared background");
          await api.waitForIdleFrames(4);
          if (api.sparseRequestCount() > 1) {
            api.resolveSliceAt(0);
            await api.waitForIdleFrames(4);
          }
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            visibleRows: api.visibleRows(),
            tab91Text: document.querySelector("[data-node-id='tab:91']")?.textContent ?? ""
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitTitlePatch("tab:91", "Tab 91 patched from shared background");
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            visibleRows: api.visibleRows(),
            hasTab91: Boolean(document.querySelector("[data-node-id='tab:91']"))
          };
        })
      ]);

      expect(resultA.commands).toEqual([]);
      expect(resultA.requests.map((request) => request.query)).toContain("Tab 91");
      expect(resultA.searchValue).toBe("Tab 91");
      expect(resultA.countText).toBe("11 matches / 1001 items");
      expect(resultA.visibleRows).toContain(1);
      expect(resultA.tab91Text).toContain("Tab 91 patched from shared background");

      expect(resultB.commands).toEqual([]);
      expect(resultB.requests.map((request) => request.query)).toEqual([""]);
      expect(resultB.searchValue).toBe("");
      expect(resultB.countText).toBe("1001 items / 0 saved");
      expect(resultB.visibleRows).toContain(250);
      expect(resultB.hasTab91).toBe(false);
      await expect(nodeRow(page, "tab:91")).toContainText("Tab 91 patched from shared background");
      await expect(nodeRow(pageB, "tab:250")).toBeVisible();
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-two-sidebars-independent-searches-survive-shared-history-patch", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
    });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, {
        fullStatePending: true,
        historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
      });

      await page.locator("#search").fill("Tab 91");
      await page.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(3);
      });

      await pageB.locator("#search").fill("Tab 900");
      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(3);
      });

      await expect(nodeRow(page, "tab:91")).toBeVisible();
      await expect(nodeRow(pageB, "tab:900")).toBeVisible();

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" });
          api.emitTitlePatch("tab:91", "Tab 91 shared history patched");
          await api.waitForIdleFrames(4);
          if (api.sparseRequestCount() > 1) {
            api.resolveSliceAt(0);
            await api.waitForIdleFrames(4);
          }
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequestCount: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            visibleRows: api.visibleRows(),
            tab91Text: document.querySelector("[data-node-id='tab:91']")?.textContent ?? "",
            hasTab900: Boolean(document.querySelector("[data-node-id='tab:900']"))
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" });
          api.emitTitlePatch("tab:900", "Tab 900 shared history patched");
          await api.waitForIdleFrames(4);
          if (api.sparseRequestCount() > 1) {
            api.resolveSliceAt(0);
            await api.waitForIdleFrames(4);
          }
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequestCount: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            visibleRows: api.visibleRows(),
            tab900Text: document.querySelector("[data-node-id='tab:900']")?.textContent ?? "",
            hasTab91: Boolean(document.querySelector("[data-node-id='tab:91']"))
          };
        })
      ]);

      expect(resultA.commands).toEqual([]);
      expect(resultA.requests.every((request) => request.query === "Tab 91")).toBe(true);
      expect(resultA.stateRequestCount).toBe(0);
      expect(resultA.searchValue).toBe("Tab 91");
      expect(resultA.countText).toBe("11 matches / 1001 items");
      expect(resultA.visibleRows).toContain(1);
      expect(resultA.tab91Text).toContain("Tab 91 shared history patched");
      expect(resultA.hasTab900).toBe(false);

      expect(resultB.commands).toEqual([]);
      expect(resultB.requests.every((request) => request.query === "Tab 900")).toBe(true);
      expect(resultB.stateRequestCount).toBe(0);
      expect(resultB.searchValue).toBe("Tab 900");
      expect(resultB.countText).toBe("1 match / 1001 items");
      expect(resultB.visibleRows).toContain(1);
      expect(resultB.tab900Text).toContain("Tab 900 shared history patched");
      expect(resultB.hasTab91).toBe(false);
      await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
      await expect(pageB.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
      await expect(pageB.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
      await expect(nodeRow(page, "tab:91")).toContainText("Tab 91 shared history patched");
      await expect(nodeRow(pageB, "tab:900")).toContainText("Tab 900 shared history patched");
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-clear-search-in-one-sidebar-preserves-other-sidebar-search", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, { fullStatePending: true });

      await page.locator("#search").fill("Tab 91");
      await page.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(3);
      });

      await pageB.locator("#search").fill("Tab 900");
      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(3);
      });

      await page.locator("#clear-search").click();

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          await api.waitForSparseRequestCount(2);
          api.emitFullStateBroadcast();
          await api.waitForIdleFrames(2);
          api.resolveSliceAt(0);
          await api.waitForIdleFrames(5);
          if (api.sparseRequestCount() > 2) {
            api.resolveSliceAt(0);
            await api.waitForIdleFrames(4);
          }
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequestCount: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            visibleRows: api.visibleRows(),
            hasSearchResult: Boolean(document.querySelector("[data-node-id='tab:91']")),
            hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitFullStateBroadcast();
          await api.waitForIdleFrames(4);
          if (api.sparseRequestCount() > 1) {
            api.resolveSliceAt(0);
            await api.waitForIdleFrames(4);
          }
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequestCount: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            visibleRows: api.visibleRows(),
            hasTab900: Boolean(document.querySelector("[data-node-id='tab:900']")),
            hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
          };
        })
      ]);

      expect(resultA.commands).toEqual([]);
      expect(resultA.requests.map((request) => request.query)).toEqual(["Tab 91", ""]);
      expect(resultA.stateRequestCount).toBe(0);
      expect(resultA.searchValue).toBe("");
      expect(resultA.countText).toBe("1001 items / 0 saved");
      expect(resultA.visibleRows.length).toBeGreaterThan(0);
      expect(resultA.hasSearchResult).toBe(false);
      expect(resultA.hasRevealHighlight).toBe(false);

      expect(resultB.commands).toEqual([]);
      expect(resultB.requests.every((request) => request.query === "Tab 900")).toBe(true);
      expect(resultB.stateRequestCount).toBe(0);
      expect(resultB.searchValue).toBe("Tab 900");
      expect(resultB.countText).toBe("1 match / 1001 items");
      expect(resultB.visibleRows).toContain(1);
      expect(resultB.hasTab900).toBe(true);
      expect(resultB.hasRevealHighlight).toBe(false);
      await expect(page.locator("#search")).toHaveValue("");
      await expect(pageB.locator("#search")).toHaveValue("Tab 900");
      await expect(nodeRow(pageB, "tab:900")).toBeVisible();
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-two-sidebars-query-replacement-keeps-other-search-independent", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
    });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, {
        fullStatePending: true,
        historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
      });

      await page.evaluate(async () => {
        const api = projectionHuntApi();
        const search = document.querySelector<HTMLInputElement>("#search");
        if (!search) {
          throw new Error("Missing search input");
        }

        search.focus();
        search.value = "Tab 90";
        search.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "Tab 90"
        }));
        await api.waitForSparseRequestCount(1);

        search.value = "Tab 91";
        search.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          inputType: "insertReplacementText",
          data: "Tab 91"
        }));
        await api.waitForSparseRequestCount(2);
      });

      await pageB.locator("#search").fill("Tab 900");
      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(3);
      });
      await expect(nodeRow(pageB, "tab:900")).toBeVisible();

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" });
          api.resolveSliceAt(0);
          await api.waitForIdleFrames(3);
          const afterStale = {
            hasTab90: Boolean(document.querySelector("[data-node-id='tab:90']")),
            hasTab900: Boolean(document.querySelector("[data-node-id='tab:900']")),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? ""
          };

          api.resolveSliceAt(0);
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequestCount: api.stateRequestCount(),
            afterStale,
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            visibleRows: api.visibleRows(),
            hasTab91: Boolean(document.querySelector("[data-node-id='tab:91']")),
            hasTab900: Boolean(document.querySelector("[data-node-id='tab:900']"))
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" });
          api.emitTitlePatch("tab:900", "Tab 900 independent query patched");
          await api.waitForIdleFrames(4);
          if (api.sparseRequestCount() > 1) {
            api.resolveSliceAt(0);
            await api.waitForIdleFrames(4);
          }
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequestCount: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            visibleRows: api.visibleRows(),
            tab900Text: document.querySelector("[data-node-id='tab:900']")?.textContent ?? "",
            hasTab91: Boolean(document.querySelector("[data-node-id='tab:91']"))
          };
        })
      ]);

      expect(resultA.commands).toEqual([]);
      expect(resultA.requests.map((request) => request.query)).toEqual(["Tab 90", "Tab 91"]);
      expect(resultA.stateRequestCount).toBe(0);
      expect(resultA.afterStale.searchValue).toBe("Tab 91");
      expect(resultA.afterStale.hasTab90).toBe(false);
      expect(resultA.afterStale.hasTab900).toBe(false);
      expect(resultA.searchValue).toBe("Tab 91");
      expect(resultA.countText).toBe("11 matches / 1001 items");
      expect(resultA.visibleRows).toContain(1);
      expect(resultA.hasTab91).toBe(true);
      expect(resultA.hasTab900).toBe(false);

      expect(resultB.commands).toEqual([]);
      expect(resultB.requests.every((request) => request.query === "Tab 900")).toBe(true);
      expect(resultB.stateRequestCount).toBe(0);
      expect(resultB.searchValue).toBe("Tab 900");
      expect(resultB.countText).toBe("1 match / 1001 items");
      expect(resultB.visibleRows).toContain(1);
      expect(resultB.tab900Text).toContain("Tab 900 independent query patched");
      expect(resultB.hasTab91).toBe(false);
      await expect(page.locator("#search")).toHaveValue("Tab 91");
      await expect(pageB.locator("#search")).toHaveValue("Tab 900");
      await expect(nodeRow(page, "tab:91")).toBeVisible();
      await expect(nodeRow(pageB, "tab:900")).toContainText("Tab 900 independent query patched");
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-two-sidebars-clear-search-and-painted-scroll-stay-independent", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, { fullStatePending: true });

      await page.locator("#search").fill("Tab 900");
      await page.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(3);
      });
      await expect(nodeRow(page, "tab:900")).toBeVisible();

      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.scrollToRow(320);
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0, { start: 300, end: 360 });
        await api.waitForVisibleRow(320);
        await api.waitForIdleFrames(3);
      });
      await expect(nodeRow(pageB, "tab:320")).toBeVisible();

      await page.locator("#clear-search").click();

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          await api.waitForSparseRequestCount(2);
          api.emitFullStateBroadcast();
          await api.waitForIdleFrames(2);
          api.resolveSliceAt(0);
          await api.waitForIdleFrames(5);
          if (api.sparseRequestCount() > 2) {
            api.resolveSliceAt(0);
            await api.waitForIdleFrames(4);
          }
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequestCount: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            visibleRows: api.visibleRows(),
            hasTab900: Boolean(document.querySelector("[data-node-id='tab:900']")),
            hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitFullStateBroadcast();
          await api.waitForIdleFrames(5);
          if (api.sparseRequestCount() > 1) {
            api.resolveSliceAt(0, { start: 300, end: 360 });
            await api.waitForIdleFrames(4);
          }
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequestCount: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            visibleRows: api.visibleRows(),
            hasTab320: Boolean(document.querySelector("[data-node-id='tab:320']")),
            hasTab900: Boolean(document.querySelector("[data-node-id='tab:900']")),
            hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
          };
        })
      ]);

      expect(resultA.commands).toEqual([]);
      expect(resultA.requests.map((request) => request.query)).toEqual(["Tab 900", ""]);
      expect(resultA.stateRequestCount).toBe(0);
      expect(resultA.searchValue).toBe("");
      expect(resultA.countText).toBe("1001 items / 0 saved");
      expect(resultA.visibleRows.length).toBeGreaterThan(0);
      expect(resultA.hasTab900).toBe(false);
      expect(resultA.hasRevealHighlight).toBe(false);

      expect(resultB.commands).toEqual([]);
      expect(resultB.requests.length).toBeGreaterThanOrEqual(1);
      expect(resultB.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
      expect(resultB.stateRequestCount).toBe(0);
      expect(resultB.searchValue).toBe("");
      expect(resultB.countText).toBe("1001 items / 0 saved");
      expect(resultB.visibleRows).toContain(320);
      expect(resultB.hasTab320).toBe(true);
      expect(resultB.hasTab900).toBe(false);
      expect(resultB.hasRevealHighlight).toBe(false);
      await expect(page.locator("#search")).toHaveValue("");
      await expect(pageB.locator("#search")).toHaveValue("");
      await expect(nodeRow(pageB, "tab:320")).toBeVisible();
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-two-sidebars-independent-scrolls-ignore-stale-cross-slices", async ({ page }) => {
    test.fail(true, "PT-021: background patch while a sparse scroll slice is pending can strand the scroll intent");
    const issuesA = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, { fullStatePending: true });

      await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          await api.scrollToRow(250);
          await api.waitForSparseRequestCount(1);
          await api.scrollToRow(260);
          await api.waitForSparseRequestCount(2);
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          await api.scrollToRow(900);
          await api.waitForSparseRequestCount(1);
        })
      ]);

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitTitlePatch("tab:900", "Tab 900 cross scroll patched");
          await api.waitForIdleFrames(2);
          api.resolveSliceAt(0, { start: 700, end: 760 });
          await api.waitForIdleFrames(2);
          const afterStale = api.visibleRows();
          api.resolveSliceAt(0, { start: 240, end: 310 });
          await api.waitForVisibleRow(260);
          await api.waitForIdleFrames(3);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequestCount: api.stateRequestCount(),
            afterStale,
            visibleRows: api.visibleRows(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            hasTab900: Boolean(document.querySelector("[data-node-id='tab:900']"))
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitTitlePatch("tab:900", "Tab 900 cross scroll patched");
          await api.waitForIdleFrames(2);
          api.resolveSliceAt(0, { start: 880, end: 940 });
          await api.waitForIdleFrames(5);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequestCount: api.stateRequestCount(),
            visibleRows: api.visibleRows(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            tab900Text: document.querySelector("[data-node-id='tab:900']")?.textContent ?? ""
          };
        })
      ]);

      expect(resultA.commands).toEqual([]);
      expect(resultA.requests).toHaveLength(2);
      expect(resultA.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
      expect(resultA.stateRequestCount).toBe(0);
      expect(resultA.afterStale.length).toBeGreaterThan(0);
      expect(resultA.searchValue).toBe("");
      expect(resultA.countText).toBe("1001 items / 0 saved");
      expect(resultA.visibleRows).toContain(260);
      expect(resultA.hasTab900).toBe(false);

      expect(resultB.commands).toEqual([]);
      expect(resultB.requests).toHaveLength(1);
      expect(resultB.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
      expect(resultB.stateRequestCount).toBe(0);
      expect(resultB.searchValue).toBe("");
      expect(resultB.countText).toBe("1001 items / 0 saved");
      expect(resultB.visibleRows).toContain(900);
      expect(resultB.tab900Text).toContain("Tab 900 cross scroll patched");
      await expect(nodeRow(page, "tab:260")).toBeVisible();
      await expect(nodeRow(pageB, "tab:900")).toContainText("Tab 900 cross scroll patched");
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-temporal-two-sidebars-search-scroll-undo-patch-keeps-intents", async ({ page }) => {
    test.fail(true, "PT-020: undo/history ordering can strand a pending scroll intent on the old slice");
    const issuesA = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
    });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, {
        fullStatePending: true,
        historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
      });

      await page.locator("#search").fill("Tab 91");
      await page.waitForFunction(() => projectionHuntApi().sparseRequestCount() >= 1);

      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.scrollToRow(250);
        await api.waitForSparseRequestCount(1);
        await api.scrollToRow(260);
        await api.waitForSparseRequestCount(2);
      });

      await pageB.getByRole("button", { name: "Undo", exact: true }).click();
      await pageB.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" });
          api.emitTitlePatch("tab:91", "Tab 91 temporal patched");
          api.resolveSliceAt(0);
          await api.waitForIdleFrames(5);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            visibleRows: api.visibleRows(),
            tab91Text: document.querySelector("[data-node-id='tab:91']")?.textContent ?? ""
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" });
          api.emitTitlePatch("tab:91", "Tab 91 temporal patched");
          api.resolveSliceAt(0, { start: 240, end: 310 });
          await api.waitForIdleFrames(2);
          const afterFirstSlice = api.visibleRows();
          api.resolveSliceAt(0, { start: 700, end: 760 });
          await api.waitForIdleFrames(5);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            afterFirstSlice,
            visibleRows: api.visibleRows(),
            hasTab91: Boolean(document.querySelector("[data-node-id='tab:91']"))
          };
        })
      ]);

      expect(resultA.commands).toEqual([]);
      expect(resultA.requests.map((request) => request.query)).toEqual(["Tab 91"]);
      expect(resultA.searchValue).toBe("Tab 91");
      expect(resultA.countText).toBe("11 matches / 1001 items");
      expect(resultA.visibleRows).toContain(1);
      expect(resultA.tab91Text).toContain("Tab 91 temporal patched");

      expect(resultB.commands).toEqual([{ type: "undo" }]);
      expect(resultB.requests.map((request) => request.query)).toEqual(["", ""]);
      expect(resultB.searchValue).toBe("");
      expect(resultB.countText).toBe("1001 items / 0 saved");
      expect(resultB.afterFirstSlice).toContain(260);
      expect(resultB.visibleRows).toContain(260);
      expect(resultB.hasTab91).toBe(false);
      await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
      await expect(pageB.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
      await expect(pageB.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-show-in-tree-stale-target-response-does-not-overwrite-new-search", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });

    const row = nodeRow(page, "tab:900");
    await expect(row).toBeVisible();
    await row.hover();
    await row.getByRole("button", { name: "Show in tree", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      const search = document.querySelector<HTMLInputElement>("#search");
      if (!search) {
        throw new Error("Missing search input");
      }
      await api.waitForSparseRequestCount(2);

      search.focus();
      search.value = "Tab 91";
      search.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "Tab 91"
      }));
      await api.waitForSparseRequestCount(3);

      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
      const afterStaleTarget = {
        searchValue: search.value,
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight")),
        visibleRows: api.visibleRows()
      };

      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
      return {
        requests: api.projectionRequests(),
        afterStaleTarget,
        finalSearchValue: search.value,
        finalVisibleRows: api.visibleRows(),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.requests.map((request) => ({
      query: request.query,
      targetNodeId: request.targetNodeId
    }))).toEqual([
      { query: "Tab 900", targetNodeId: undefined },
      { query: "", targetNodeId: "tab:900" },
      { query: "Tab 91", targetNodeId: undefined }
    ]);
    expect(result.afterStaleTarget.searchValue).toBe("Tab 91");
    expect(result.afterStaleTarget.hasRevealHighlight).toBe(false);
    expect(result.finalSearchValue).toBe("Tab 91");
    expect(result.finalVisibleRows).toContain(1);
    expect(result.countText).toBe("11 matches / 1001 items");
    await expect(nodeRow(page, "tab:91")).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-show-in-tree-stale-target-with-state-broadcast-keeps-new-search", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });

    const row = nodeRow(page, "tab:900");
    await expect(row).toBeVisible();
    await row.hover();
    await row.getByRole("button", { name: "Show in tree", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      const search = document.querySelector<HTMLInputElement>("#search");
      if (!search) {
        throw new Error("Missing search input");
      }
      await api.waitForSparseRequestCount(2);

      search.focus();
      search.value = "Tab 91";
      search.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "Tab 91"
      }));
      await api.waitForSparseRequestCount(3);

      api.emitFullStateBroadcast();
      await api.waitForIdleFrames(3);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
      const afterStaleTarget = {
        searchValue: search.value,
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight")),
        visibleRows: api.visibleRows(),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };

      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
      return {
        requests: api.projectionRequests(),
        afterStaleTarget,
        finalSearchValue: search.value,
        finalVisibleRows: api.visibleRows(),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.requests.map((request) => ({
      query: request.query,
      targetNodeId: request.targetNodeId
    }))).toEqual([
      { query: "Tab 900", targetNodeId: undefined },
      { query: "", targetNodeId: "tab:900" },
      { query: "Tab 91", targetNodeId: undefined }
    ]);
    expect(result.afterStaleTarget.searchValue).toBe("Tab 91");
    expect(result.afterStaleTarget.hasRevealHighlight).toBe(false);
    expect(result.finalSearchValue).toBe("Tab 91");
    expect(result.finalVisibleRows).toContain(1);
    expect(result.countText).toBe("11 matches / 1001 items");
    await expect(nodeRow(page, "tab:91")).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-show-in-tree-rejected-target-response-restores-cleared-outline", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });

    const row = nodeRow(page, "tab:900");
    await expect(row).toBeVisible();
    await row.hover();
    await row.getByRole("button", { name: "Show in tree", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(2);
      api.rejectSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        requests: api.projectionRequests(),
        visibleRows: api.visibleRows(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        targetExists: Boolean(document.querySelector("[data-node-id='tab:900']"))
      };
    });

    expect(result.requests.at(-1)).toMatchObject({ query: "", targetNodeId: "tab:900" });
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.targetExists).toBe(false);
    expect(result.visibleRows.length).toBeGreaterThan(0);
    expect(issues.filter((issue) => issue.kind !== "console")).toEqual([]);
  });

  test("psh-search-refreshes-after-background-title-patch", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
      api.emitTitlePatch("tab:900", "Tab 900 updated remotely");
      await api.waitForIdleFrames(3);
      if (api.sparseRequestCount() > 1) {
        api.resolveSliceAt(0);
      }
      await api.waitForIdleFrames(3);
    });

    await expect(nodeRow(page, "tab:900")).toContainText("Tab 900 updated remotely");
    await expect(page.locator("#search")).toHaveValue("Tab 900");
    expect(issues).toEqual([]);
  });

  test("psh-search-background-patch-history-status-preserves-results", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
    });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
      api.emitHistoryStatus({ canUndo: true, canRedo: true, undoDepth: 2, redoDepth: 1, undoLabel: "rename", redoLabel: "rename" });
      api.emitTitlePatch("tab:900", "Tab 900 history patched");
      await api.waitForIdleFrames(3);
      if (api.sparseRequestCount() > 1) {
        api.resolveSliceAt(0);
      }
      await api.waitForIdleFrames(3);
    });

    await expect(nodeRow(page, "tab:900")).toContainText("Tab 900 history patched");
    await expect(page.locator("#search")).toHaveValue("Tab 900");
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-full-state-broadcast-while-search-active-keeps-query-results", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
      api.emitFullStateBroadcast();
      await api.waitForIdleFrames(4);
    });

    await expect(page.locator("#search")).toHaveValue("Tab 900");
    await expect(nodeRow(page, "tab:900")).toBeVisible();
    await expect(page.locator("#state-count")).toHaveText("1 match / 1001 items");
    expect(issues).toEqual([]);
  });

  test("psh-query-replacement-with-state-broadcast-keeps-current-query", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      const search = document.querySelector<HTMLInputElement>("#search");
      if (!search) {
        throw new Error("Missing search input");
      }

      search.focus();
      search.value = "Tab 90";
      search.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "Tab 90"
      }));
      await api.waitForSparseRequestCount(1);

      search.value = "Tab 900";
      search.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "0"
      }));
      await api.waitForSparseRequestCount(2);

      api.resolveSliceAt(0);
      await api.waitForIdleFrames(2);
      api.emitFullStateBroadcast();
      await api.waitForIdleFrames(3);
      const afterBroadcast = {
        searchValue: search.value,
        hasStaleTab90: Boolean(document.querySelector("[data-node-id='tab:90']")),
        hasCurrentTab900: Boolean(document.querySelector("[data-node-id='tab:900']")),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };

      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
      return {
        requests: api.projectionRequests(),
        afterBroadcast,
        searchValue: search.value,
        visibleRows: api.visibleRows(),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.requests.map((request) => request.query)).toEqual(["Tab 90", "Tab 900"]);
    expect(result.afterBroadcast.searchValue).toBe("Tab 900");
    expect(result.afterBroadcast.hasStaleTab90).toBe(false);
    expect(result.afterBroadcast.countText).not.toContain("Tab 90");
    expect(result.searchValue).toBe("Tab 900");
    expect(result.visibleRows).toContain(1);
    expect(result.countText).toBe("1 match / 1001 items");
    await expect(nodeRow(page, "tab:900")).toBeVisible();
    await expect(page.locator(nodeSelector("tab:90"))).toHaveCount(0);
    expect(issues).toEqual([]);
  });

  test("psh-scroll-search-broadcast-clear-resolves-current-outline", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      const search = document.querySelector<HTMLInputElement>("#search");
      const clear = document.querySelector<HTMLButtonElement>("#clear-search");
      if (!search || !clear) {
        throw new Error("Missing search controls");
      }

      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);

      search.focus();
      search.value = "Tab 900";
      search.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "Tab 900"
      }));
      await api.waitForSparseRequestCount(2);

      api.emitFullStateBroadcast();
      await api.waitForIdleFrames(2);
      let resolvedSlices = 0;
      api.resolveSliceAt(0);
      resolvedSlices += 1;
      await api.waitForIdleFrames(2);
      const afterStaleScroll = {
        searchValue: search.value,
        visibleRows: api.visibleRows(),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };

      api.resolveSliceAt(0);
      resolvedSlices += 1;
      await api.waitForIdleFrames(3);
      const afterSearch = {
        searchValue: search.value,
        hasSearchResult: Boolean(document.querySelector("[data-node-id='tab:900']")),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };

      clear.click();
      await api.waitForSparseRequestCount(3);
      api.resolveSliceAt(0);
      resolvedSlices += 1;
      await api.waitForIdleFrames(4);
      if (api.sparseRequestCount() > resolvedSlices) {
        api.resolveSliceAt(0);
        resolvedSlices += 1;
        await api.waitForIdleFrames(4);
      }

      return {
        requests: api.projectionRequests(),
        afterStaleScroll,
        afterSearch,
        searchValue: search.value,
        visibleRows: api.visibleRows(),
        countText: document.querySelector("#state-count")?.textContent ?? "",
        targetExists: Boolean(document.querySelector("[data-node-id='tab:900']"))
      };
    });

    expect(result.requests.slice(0, 2).map((request) => request.query)).toEqual(["", "Tab 900"]);
    expect(result.requests.slice(2).length).toBeGreaterThanOrEqual(1);
    expect(result.requests.slice(2).every((request) => request.query === "")).toBe(true);
    expect(result.afterStaleScroll.searchValue).toBe("Tab 900");
    expect(result.afterStaleScroll.visibleRows.length).toBeGreaterThan(0);
    expect(result.afterSearch.searchValue).toBe("Tab 900");
    expect(result.afterSearch.hasSearchResult).toBe(true);
    expect(result.afterSearch.countText).toBe("1 match / 1001 items");
    expect(result.searchValue).toBe("");
    expect(result.visibleRows.length).toBeGreaterThan(0);
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.targetExists).toBe(false);
    expect(issues).toEqual([]);
  });

  test("psh-query-replacement-ignores-stale-first-response", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      const search = document.querySelector<HTMLInputElement>("#search");
      if (!search) {
        throw new Error("Missing search input");
      }

      search.focus();
      search.value = "Tab 90";
      search.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "Tab 90"
      }));
      await api.waitForSparseRequestCount(1);

      search.value = "Tab 900";
      search.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "0"
      }));
      await api.waitForSparseRequestCount(2);

      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
      const afterStale = {
        hasTab90: Boolean(document.querySelector("[data-node-id='tab:90']")),
        hasTab900: Boolean(document.querySelector("[data-node-id='tab:900']"))
      };

      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);

      return {
        requests: api.projectionRequests(),
        searchValue: search.value,
        afterStale,
        visibleRows: api.visibleRows(),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.requests.map((request) => request.query)).toEqual(["Tab 90", "Tab 900"]);
    expect(result.searchValue).toBe("Tab 900");
    expect(result.afterStale.hasTab90).toBe(false);
    expect(result.visibleRows).toContain(1);
    expect(result.countText).toBe("1 match / 1001 items");
    await expect(nodeRow(page, "tab:900")).toBeVisible();
    await expect(page.locator(nodeSelector("tab:90"))).toHaveCount(0);
    expect(issues).toEqual([]);
  });

  test("psh-search-prunes-visible-row-after-title-stops-matching", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });

    await expect(nodeRow(page, "tab:900")).toBeVisible();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitTitlePatch("tab:900", "Renamed away from query");
      await api.waitForIdleFrames(3);
      return {
        requests: api.projectionRequests(),
        visibleRows: api.visibleRows(),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.requests.map((request) => request.query)).toEqual(["Tab 900"]);
    expect(result.visibleRows).toEqual([]);
    expect(result.countText).toBe("0 matches / 1001 items");
    await expect(page.locator(nodeSelector("tab:900"))).toHaveCount(0);
    await expect(page.locator("#search")).toHaveValue("Tab 900");
    expect(issues).toEqual([]);
  });
});

async function loadLargeSparseSidebar(
  page: Page,
  options: { fullStatePending?: boolean; includeCoverage?: boolean; historyStatus?: HarnessHistoryStatus } = {}
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
      ...(options.historyStatus ? { historyStatus: options.historyStatus } : {}),
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

async function dragAfter(page: Page, sourceId: string, targetId: string): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  try {
    await nodeRow(page, sourceId).dispatchEvent("dragstart", {
      bubbles: true,
      cancelable: true,
      dataTransfer
    });
    const clientY = await nodeRow(page, targetId).evaluate((row) => row.getBoundingClientRect().bottom - 1);
    await nodeRow(page, targetId).dispatchEvent("dragover", {
      bubbles: true,
      cancelable: true,
      clientY,
      dataTransfer
    });
    await nodeRow(page, targetId).dispatchEvent("drop", {
      bubbles: true,
      cancelable: true,
      clientY,
      dataTransfer
    });
    await nodeRow(page, sourceId).dispatchEvent("dragend", {
      bubbles: true,
      cancelable: true,
      dataTransfer
    });
  } finally {
    await dataTransfer.dispose();
  }
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
  emitHistoryStatus(status: HarnessHistoryStatus): void;
  sentCommands(): unknown[];
  stateRequestCount(): number;
  projectionRequests(): Array<{ centerRowIndex: number; rowLimit: number; query: string; targetNodeId?: string }>;
};

type ProjectionSliceRequest = {
  centerRowIndex: number;
  rowLimit: number;
  query: string;
  targetNodeId?: string;
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
  historyStatus?: HarnessHistoryStatus;
}) {
  const now = 1_700_000_000_000;
  const rowHeight = 18;
  const listeners: Array<(message: unknown) => void> = [];
  const sentCommands: unknown[] = [];
  const stateRequests: unknown[] = [];
  const sliceRequests: ProjectionSliceRequest[] = [];
  const pendingSlices: Array<{
    request: ProjectionSliceRequest;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  let fullState = initialFullState();
  let fullStateResolver: ((value: unknown) => void) | undefined;
  let fullStateResolveQueued = false;
  let currentHistoryStatus = options.historyStatus ?? { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 };

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
    emitHistoryStatus,
    sentCommands: () => structuredClone(sentCommands),
    stateRequestCount: () => stateRequests.length,
    projectionRequests: () => structuredClone(sliceRequests)
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
          const query = typeof (message as { query?: unknown }).query === "string"
            ? (message as { query: string }).query
            : "";
          const targetNodeId = typeof (message as { targetNodeId?: unknown }).targetNodeId === "string"
            ? (message as { targetNodeId: string }).targetNodeId
            : undefined;
          const request: ProjectionSliceRequest = { centerRowIndex, rowLimit, query, targetNodeId };
          sliceRequests.push(request);
          return new Promise((resolve, reject) => {
            pendingSlices.push({ request, resolve, reject });
          });
        }
        if (type === "getState") {
          stateRequests.push(structuredClone(message));
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
          return { type: "historyStatus", ...historyStatus() };
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
          type === "moveSubtreeToTopLevel" ||
          type === "renameGroup" ||
          type === "focusNode" ||
          type === "expandAncestors" ||
          type === "undo" ||
          type === "redo"
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
    const projection = rowsForProjectionRequest(pending.request, override);
    pending.resolve(snapshotFromRows(projection.rows, {
      hydrating: true,
      query: pending.request.query,
      totalRowCount: projection.totalRowCount,
      matchingNodeIds: projection.matchingNodeIds
    }));
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

  function historyStatus(): HarnessHistoryStatus {
    return currentHistoryStatus;
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

  function emitHistoryStatus(status: HarnessHistoryStatus) {
    currentHistoryStatus = status;
    emit({ type: "historyStatus", ...status });
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

  function snapshotFromRows(
    rows: Array<Record<string, unknown> & { nodeId: string; index: number }>,
    settings: {
      hydrating: boolean;
      query?: string;
      totalRowCount?: number;
      matchingNodeIds?: string[];
    }
  ) {
    const query = settings.query ?? "";
    const totalRowCount = settings.totalRowCount ?? options.totalRows;
    const matchingNodeIds = settings.matchingNodeIds ?? [];
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
        query,
        isSearchActive: query.length > 0,
        rows,
        matchingNodeIds,
        visibleNodeIds: rows.map((row) => row.nodeId),
        ...activeProjectionTarget(),
        totalRowCount,
        nodeCount: options.totalRows,
        closedCount: options.closedRestoreFixture ? 4 : 0,
        matchCount: matchingNodeIds.length
      },
      ...(options.includeCoverage
        ? {
            coverage: {
              startRowIndex: indexes.length ? Math.min(...indexes) : 0,
              endRowIndex: indexes.length ? Math.max(...indexes) + 1 : 0,
              editableNodeIds: rows.map((row) => row.nodeId),
              completeSubtreeNodeIds: completeSubtreeNodeIdsForRows(rows),
              completeSiblingParentIds: completeSiblingParentIdsForRows()
            }
          }
        : {})
    };
  }

  function rowsForProjectionRequest(request: ProjectionSliceRequest, override: { start?: number; end?: number }) {
    if (request.query) {
      const rows = searchRowsForQuery(request.query);
      return {
        rows,
        matchingNodeIds: rows.filter((row) => row.isSearchMatch).map((row) => row.nodeId),
        totalRowCount: rows.length
      };
    }
    if (options.closedRestoreFixture) {
      return { rows: closedRestoreRows(), matchingNodeIds: [], totalRowCount: closedRestoreRows().length };
    }
    if (options.restoredFixture) {
      return { rows: restoredRows(), matchingNodeIds: [], totalRowCount: restoredRows().length };
    }
    const centerRowIndex = request.targetNodeId ? rowIndexForNodeId(request.targetNodeId) : request.centerRowIndex;
    const start = override.start ?? Math.max(1, Math.floor(centerRowIndex - request.rowLimit / 2));
    const end = override.end ?? Math.min(currentTotalRows(), Math.floor(centerRowIndex + request.rowLimit / 2));
    return { rows: tabRows(start, end), matchingNodeIds: [], totalRowCount: currentTotalRows() };
  }

  function searchRowsForQuery(query: string) {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) {
      return [];
    }
    const matches = Object.values(fullState.nodes)
      .filter((node): node is ReturnType<typeof tabNode> => (
        node.kind === "tab" &&
        (
          String(node.title ?? "").toLocaleLowerCase().includes(normalizedQuery) ||
          String(node.url ?? "").toLocaleLowerCase().includes(normalizedQuery)
        )
      ))
      .map((node) => Number.parseInt(String(node.id).slice("tab:".length), 10))
      .filter((tabId) => Number.isFinite(tabId))
      .sort((left, right) => left - right);
    if (matches.length === 0) {
      return [];
    }
    return [
      searchWindowRow(matches.length + 1),
      ...matches.map((tabId, index) => ({
        ...tabRow(tabId),
        index: index + 1,
        parentRowIndex: 0,
        subtreeEndIndex: index + 2,
        isSearchMatch: true,
        isSearchPath: false
      }))
    ];
  }

  function rowIndexForNodeId(nodeId: string) {
    if (nodeId === "window:1") {
      return 0;
    }
    if (nodeId.startsWith("tab:")) {
      const tabId = Number.parseInt(nodeId.slice("tab:".length), 10);
      if (Number.isFinite(tabId)) {
        return tabId;
      }
    }
    return 0;
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
    const totalRows = currentTotalRows();
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

  function currentTotalRows() {
    if (options.closedRestoreFixture) {
      return closedRestoreRows().length;
    }
    if (options.restoredFixture) {
      return restoredRows().length;
    }
    const window = fullState.nodes["window:1"] as { childIds?: string[] } | undefined;
    return 1 + (Array.isArray(window?.childIds) ? window.childIds.length : 0);
  }

  function searchWindowRow(subtreeEndIndex: number) {
    return {
      ...windowRow(),
      subtreeEndIndex,
      childCount: subtreeEndIndex - 1,
      visibleChildCount: subtreeEndIndex - 1,
      isSearchMatch: false,
      isSearchPath: true
    };
  }

  function tabRows(startInclusive: number, endExclusive: number) {
    const window = fullState.nodes["window:1"] as { childIds?: string[] } | undefined;
    const childIds = Array.isArray(window?.childIds) ? window.childIds : [];
    return Array.from({ length: Math.max(0, endExclusive - startInclusive) }, (_value, index) => {
      const rowIndex = startInclusive + index;
      const nodeId = childIds[rowIndex - 1];
      const tabId = nodeId?.startsWith("tab:")
        ? Number.parseInt(nodeId.slice("tab:".length), 10)
        : Number.NaN;
      return Number.isFinite(tabId)
        ? { ...tabRow(tabId), index: rowIndex, subtreeEndIndex: rowIndex + 1 }
        : undefined;
    }).filter((row): row is ReturnType<typeof tabRow> => Boolean(row));
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
