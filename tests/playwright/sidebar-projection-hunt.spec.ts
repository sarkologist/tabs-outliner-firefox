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
  test("psh stale restored subgroup slice after external delete does not repaint", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadRestoredSubgroupSidebar(page, { fullStatePending: true });
    await page.locator("#search").fill("restored-subgroup.example");

    const result = await page.evaluate(async () => {
      const staleQuery = "restored-subgroup.example";
      const deletedNodeIds = ["window:restored-subgroup", "tab:performance", "tab:annotate", "tab:s3", "tab:offscreen"];
      const api = projectionHuntApi();
      await api.waitForProjectionRequest(staleQuery);
      api.emitDeletePatch(deletedNodeIds);
      await api.waitForIdleFrames(4);
      const afterDelete = {
        visibleRows: api.visibleRows(),
        hasGroup: Boolean(document.querySelector("[data-node-id='window:restored-subgroup']")),
        hasPerformance: Boolean(document.querySelector("[data-node-id='tab:performance']")),
        hasAnnotate: Boolean(document.querySelector("[data-node-id='tab:annotate']")),
        hasS3: Boolean(document.querySelector("[data-node-id='tab:s3']"))
      };

      api.resolveSliceForQuery(staleQuery, { staleAtRequest: true });
      await api.waitForIdleFrames(6);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        afterDelete,
        afterStale: {
          visibleRows: api.visibleRows(),
          hasGroup: Boolean(document.querySelector("[data-node-id='window:restored-subgroup']")),
          hasPerformance: Boolean(document.querySelector("[data-node-id='tab:performance']")),
          hasAnnotate: Boolean(document.querySelector("[data-node-id='tab:annotate']")),
          hasS3: Boolean(document.querySelector("[data-node-id='tab:s3']")),
          hasStaleActionButton: Boolean(document.querySelector("[data-node-id='window:restored-subgroup'] button"))
        }
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests.length).toBeGreaterThanOrEqual(1);
    expect(result.requests[0]).toEqual(expect.objectContaining({
      query: "restored-subgroup.example",
      targetNodeId: undefined
    }));
    expect(result.stateRequests).toBe(0);
    expect(result.afterDelete.visibleRows).not.toContain(0);
    expect(result.afterDelete.hasGroup).toBe(false);
    expect(result.afterDelete.hasPerformance).toBe(false);
    expect(result.afterDelete.hasAnnotate).toBe(false);
    expect(result.afterDelete.hasS3).toBe(false);
    expect(result.afterStale.visibleRows).not.toContain(0);
    expect(result.afterStale.hasGroup).toBe(false);
    expect(result.afterStale.hasPerformance).toBe(false);
    expect(result.afterStale.hasAnnotate).toBe(false);
    expect(result.afterStale.hasS3).toBe(false);
    expect(result.afterStale.hasStaleActionButton).toBe(false);
    expect(issues).toEqual([]);
  });

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

  test("psh-passive-slice-resolution-preserves-scroll-and-side-effects", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.nextFrame();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      const beforeScrollTop = api.scrollTop();
      const scrollTopHistoryBefore = api.scrollTopHistory();
      const stateRequestsBefore = api.stateRequestCount();
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        beforeScrollTop,
        afterScrollTop: api.scrollTop(),
        scrollTopHistoryBefore,
        scrollTopHistory: api.scrollTopHistory(),
        commands: api.sentCommands(),
        stateRequestsBefore,
        stateRequestsAfter: api.stateRequestCount(),
        visibleRows: api.visibleRows(),
        expectedVisibleRows: api.expectedVisibleRows()
      };
    });

    expectScrollTopPreserved(result.afterScrollTop, result.beforeScrollTop);
    expect(result.scrollTopHistory).toEqual(result.scrollTopHistoryBefore);
    expect(result.visibleRows).toEqual(result.expectedVisibleRows);
    expect(result.visibleRows).toContain(250);
    expectPassiveProjectionSideEffects(result);
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
      const beforeScrollTop = api.scrollTop();
      const scrollTopHistoryBefore = api.scrollTopHistory();
      const stateRequestsBefore = api.stateRequestCount();
      api.resolveFullState();
      await api.waitForIdleFrames(6);
      return {
        before,
        after: api.visibleRows(),
        beforeScrollTop,
        afterScrollTop: api.scrollTop(),
        scrollTopHistoryBefore,
        scrollTopHistory: api.scrollTopHistory(),
        scrollRow: api.viewportStartRow(),
        commands: api.sentCommands(),
        stateRequestsBefore,
        stateRequestsAfter: api.stateRequestCount(),
        expectedVisibleRows: api.expectedVisibleRows()
      };
    });

    expect(result.before).toContain(250);
    expect(result.after).toContain(250);
    expect(result.after).toEqual(result.expectedVisibleRows);
    expectScrollTopPreserved(result.afterScrollTop, result.beforeScrollTop);
    expect(result.scrollTopHistory).toEqual(result.scrollTopHistoryBefore);
    expectPassiveProjectionSideEffects(result);
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

  test("psh-covered-sparse-drag-drop-sends-command-before-hydration", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    await dragAfter(page, "tab:800", "tab:801");
    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForIdleFrames(2);
      return {
        commands: api.sentCommands(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows()
      };
    });

    expect(result.commands).toEqual([
      expect.objectContaining({ type: "moveNode", nodeId: "tab:800", parentId: "window:1", index: 800 })
    ]);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toContain(800);
    expect(issues).toEqual([]);
  });

  test("psh-missing-coverage-drag-drop-requests-sparse-refill-without-hydration", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: false, fullStatePending: true });

    await dragAfter(page, "tab:800", "tab:801");
    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForIdleFrames(2);
      return {
        commands: api.sentCommands(),
        stateRequests: api.stateRequestCount(),
        sparseRequests: api.sparseRequestCount(),
        visibleRows: api.visibleRows()
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.stateRequests).toBe(0);
    expect(result.sparseRequests).toBeGreaterThan(0);
    expect(result.visibleRows).toContain(800);
    expect(issues).toEqual([]);
  });

  test("psh-covered-sparse-root-drag-drop-sends-command-before-hydration", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    await dragToRoot(page, "tab:800");
    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForIdleFrames(2);
      return {
        commands: api.sentCommands(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows()
      };
    });

    expect(result.commands).toEqual([
      expect.objectContaining({ type: "moveNodeToNewWindow", nodeId: "tab:800", index: 1 })
    ]);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toContain(800);
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

  test("psh-hover-action-inventory-covered-window-and-tab-while-partial", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    const windowRow = nodeRow(page, "window:1");
    await windowRow.hover();
    await expect(windowRow.getByRole("button", { name: "Collapse", exact: true })).toBeVisible();
    await expect(windowRow.getByRole("button", { name: "Rename", exact: true })).toBeVisible();

    const tabRow = nodeRow(page, "tab:800");
    await tabRow.hover();
    await expect(tabRow.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    await expect(tabRow.getByRole("button", { name: "Cut", exact: true })).toBeVisible();
    await expect(tabRow.getByRole("button", { name: "Move to top level", exact: true })).toBeVisible();
    await expect(tabRow.getByRole("button", { name: "Delete", exact: true })).toBeVisible();

    const result = await page.evaluate(() => ({
      commands: projectionHuntApi().sentCommands(),
      stateRequests: projectionHuntApi().stateRequestCount()
    }));
    expect(result.commands).toEqual([]);
    expect(result.stateRequests).toBe(0);
    expect(issues).toEqual([]);
  });

  test("psh move to bottom visible for sparse root named group with unloaded tail", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSparseNamedGroupSidebar(page, { fullStatePending: true });

    const row = nodeRow(page, "window:named-group");
    await row.hover();
    const moveToBottom = row.getByRole("button", { name: "Move to bottom", exact: true });
    await expect(moveToBottom).toBeVisible();

    await moveToBottom.click();

    const result = await page.evaluate(() => ({
      commands: projectionHuntApi().sentCommands()
    }));
    expect(result.commands).toContainEqual({
      type: "moveSubtreeToBottomTopLevel",
      nodeId: "window:named-group"
    });
    expect(issues).toEqual([]);
  });

  test("psh-rename-input-undo-shortcut-stays-local-during-hydration", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: true, undoDepth: 1, redoDepth: 1, undoLabel: "remote undo", redoLabel: "remote redo" }
    });

    const row = nodeRow(page, "window:1");
    await row.hover();
    await row.getByRole("button", { name: "Rename", exact: true }).click();
    const input = row.getByRole("textbox", { name: "Rename Window", exact: true });
    await expect(input).toBeVisible();

    await input.fill("Sparse draft");
    await page.keyboard.press("Control+Z");
    await page.keyboard.press("Control+Shift+Z");
    await expect(input).toBeVisible();
    await expect(sentCommands(page)).resolves.toEqual([]);

    await input.fill("Sparse final");
    await input.press("Enter");

    await expect(sentCommands(page)).resolves.toEqual([
      { type: "renameGroup", nodeId: "window:1", title: "Sparse final" }
    ]);
    await expect(input).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-cut-source-delete-stale-slice-clears-cut-and-refills-current-window", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await nodeRow(page, "tab:800").hover();
    await nodeRow(page, "tab:800").getByRole("button", { name: "Cut", exact: true }).click();
    await expect(page.locator(nodeSelector("tab:800"))).toHaveClass(/is-cut/);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.emitDeletePatch(["tab:800"]);
      await api.waitForIdleFrames(2);
      api.resolveSliceAt(0, { start: 760, end: 840 });
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        requests: api.projectionRequests(),
        visibleRows: api.visibleRows(),
        cutMarkers: document.querySelectorAll(".is-cut").length,
        deletedCutExists: Boolean(document.querySelector("[data-node-id='tab:800']"))
      };
    });

    expect(result.requests).toHaveLength(2);
    expect(result.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
    expect(result.visibleRows).toContain(250);
    expect(result.cutMarkers).toBe(0);
    expect(result.deletedCutExists).toBe(false);
    await nodeRow(page, "tab:250").hover();
    await expect(nodeRow(page, "tab:250").getByRole("button", { name: "Paste", exact: true })).toHaveCount(0);
    await expect(sentCommands(page)).resolves.toEqual([]);
    expect(issues).toEqual([]);
  });

  test("psh-missing-coverage-refill-enables-next-covered-drag-without-hydration", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: false, fullStatePending: true });

    await dragAfter(page, "tab:800", "tab:801");
    await expect(sentCommands(page)).resolves.toEqual([]);

    const afterBlockedDrag = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { start: 760, end: 840, includeCoverage: true });
      await api.waitForIdleFrames(4);
      return {
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows()
      };
    });

    expect(afterBlockedDrag.requests).toHaveLength(1);
    expect(afterBlockedDrag.stateRequests).toBe(0);
    expect(afterBlockedDrag.visibleRows).toContain(800);

    await dragAfter(page, "tab:800", "tab:801");
    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForIdleFrames(2);
      return {
        commands: api.sentCommands(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows()
      };
    });

    expect(result.commands).toEqual([
      expect.objectContaining({ type: "moveNode", nodeId: "tab:800", parentId: "window:1", index: 800 })
    ]);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toContain(800);
    expect(issues).toEqual([]);
  });

  test("psh-root-drop-missing-coverage-rejected-refill-clears-preview", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: false, fullStatePending: true });

    await dragToRoot(page, "tab:800");
    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.rejectSliceAt(0);
      await api.waitForIdleFrames(4);
      const marker = document.querySelector<HTMLElement>("[data-testid='drop-marker']");
      const root = document.querySelector<HTMLElement>("main");
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        markerClassName: marker?.className ?? "",
        rootDropTarget: root?.classList.contains("root-drop-target") ?? false,
        visibleRows: api.visibleRows()
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests).toHaveLength(1);
    expect(result.stateRequests).toBe(0);
    expect(result.markerClassName).not.toMatch(/drop-root|drop-before|drop-after|drop-inside/);
    expect(result.rootDropTarget).toBe(false);
    expect(result.visibleRows).toContain(800);
    expect(issues).toEqual([]);
  });

  test("psh-root-drop-stale-refill-after-dragend-does-not-resurrect-preview", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: false, fullStatePending: true });

    await dragToRoot(page, "tab:800");
    const afterAbandonedDrag = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { start: 780, end: 840, includeCoverage: true });
      await api.waitForIdleFrames(4);
      const marker = document.querySelector<HTMLElement>("[data-testid='drop-marker']");
      const root = document.querySelector<HTMLElement>("main");
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        markerClassName: marker?.className ?? "",
        rootDropTarget: root?.classList.contains("root-drop-target") ?? false,
        visibleRows: api.visibleRows()
      };
    });

    expect(afterAbandonedDrag.commands).toEqual([]);
    expect(afterAbandonedDrag.requests).toHaveLength(1);
    expect(afterAbandonedDrag.stateRequests).toBe(0);
    expect(afterAbandonedDrag.markerClassName).not.toMatch(/drop-root|drop-before|drop-after|drop-inside/);
    expect(afterAbandonedDrag.rootDropTarget).toBe(false);
    expect(afterAbandonedDrag.visibleRows).toContain(800);

    await dragToRoot(page, "tab:800");
    const afterFreshDrag = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForIdleFrames(2);
      return {
        commands: api.sentCommands(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows()
      };
    });

    expect(afterFreshDrag.commands).toEqual([
      expect.objectContaining({ type: "moveNodeToNewWindow", nodeId: "tab:800", index: 1 })
    ]);
    expect(afterFreshDrag.stateRequests).toBe(0);
    expect(afterFreshDrag.visibleRows).toContain(800);
    expect(issues).toEqual([]);
  });

  test("psh-two-sidebars-drag-and-search-stay-independent-after-shared-move", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, { includeCoverage: true, fullStatePending: true });
      await pageB.locator("#search").fill("Tab 900");
      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0);
        await api.waitForVisibleRow(1);
      });

      await dragAfter(page, "tab:800", "tab:801");
      await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitMovePatch("tab:800", "window:1", 800);
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows()
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitMovePatch("tab:800", "window:1", 800);
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows(),
            countText: document.querySelector("#state-count")?.textContent ?? ""
          };
        })
      ]);

      expect(resultA.commands).toEqual([
        expect.objectContaining({ type: "moveNode", nodeId: "tab:800", parentId: "window:1", index: 800 })
      ]);
      expect(resultA.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
      expect(resultA.stateRequests).toBe(0);
      expect(resultA.searchValue).toBe("");
      expect(resultA.visibleRows).toContain(800);

      expect(resultB.commands).toEqual([]);
      expect(resultB.requests).toEqual([
        expect.objectContaining({ query: "Tab 900", targetNodeId: undefined })
      ]);
      expect(resultB.stateRequests).toBe(0);
      expect(resultB.searchValue).toBe("Tab 900");
      expect(resultB.visibleRows).toContain(1);
      expect(resultB.countText).toBe("1 match / 1001 items");
      await expect(nodeRow(pageB, "tab:900")).toBeVisible();
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-active-rename-blocks-drag-and-survives-unrelated-move-patch", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    const row = nodeRow(page, "window:1");
    await row.hover();
    await row.getByRole("button", { name: "Rename", exact: true }).click();
    const input = row.getByRole("textbox", { name: "Rename Window", exact: true });
    await expect(input).toBeVisible();
    await input.fill("Rename during patch");

    await dragAfter(page, "window:1", "tab:800");
    const duringRename = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitMovePatch("tab:802", "window:1", 799);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows()
      };
    });

    expect(duringRename.commands).toEqual([]);
    expect(duringRename.stateRequests).toBe(0);
    expect(duringRename.visibleRows).toContain(0);
    await expect(input).toBeVisible();
    await expect(input).toHaveValue("Rename during patch");

    await input.press("Enter");
    await expect(sentCommands(page)).resolves.toEqual([
      { type: "renameGroup", nodeId: "window:1", title: "Rename during patch" }
    ]);
    expect(issues).toEqual([]);
  });

  test("psh-covered-row-drop-move-patch-clears-drag-preview-and-keeps-actions", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    await dragAfter(page, "tab:800", "tab:801");
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitMovePatch("tab:800", "window:1", 800);
      await api.waitForIdleFrames(4);
      const marker = document.querySelector<HTMLElement>("[data-testid='drop-marker']");
      const root = document.querySelector<HTMLElement>("main");
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        markerClassName: marker?.className ?? "",
        rootDropTarget: root?.classList.contains("root-drop-target") ?? false,
        visibleRows: api.visibleRows()
      };
    });

    expect(result.commands).toEqual([
      expect.objectContaining({ type: "moveNode", nodeId: "tab:800", parentId: "window:1", index: 800 })
    ]);
    expect(result.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
    expect(result.stateRequests).toBe(0);
    expect(result.markerClassName).not.toMatch(/drop-root|drop-before|drop-after|drop-inside/);
    expect(result.rootDropTarget).toBe(false);
    expect(result.visibleRows).toContain(800);

    if (result.requests.length > 0) {
      await page.evaluate(async () => {
        const api = projectionHuntApi();
        api.resolveSliceAt(0, { start: 760, end: 840, includeCoverage: true });
        await api.waitForIdleFrames(4);
      });
    }
    const row = nodeRow(page, "tab:800");
    await row.hover();
    await expect(row.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-focus-click-delete-patch-stale-refill-keeps-current-viewport", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { start: 240, end: 310 });
      await api.waitForVisibleRow(260);
    });

    await nodeRow(page, "tab:260").locator(".node-label").click();
    await expect(sentCommands(page)).resolves.toEqual([{ type: "focusNode", nodeId: "tab:260" }]);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(500);
      await api.waitForSparseRequestCount(2);
      api.emitDeletePatch(["tab:260"]);
      await api.waitForIdleFrames(2);
      api.resolveSliceAt(0, { start: 240, end: 310 });
      await api.waitForSparseRequestCount(3);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows(),
        deletedFocusedExists: Boolean(document.querySelector("[data-node-id='tab:260']"))
      };
    });

    expect(result.commands).toEqual([{ type: "focusNode", nodeId: "tab:260" }]);
    expect(result.requests).toHaveLength(3);
    expect(result.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toContain(500);
    expect(result.deletedFocusedExists).toBe(false);
    await expect(nodeRow(page, "tab:500")).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-sparse-append-delete-before-hydration-keeps-global-count", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      const countText = () => document.querySelector("#state-count")?.textContent ?? "";
      const before = countText();
      api.emitAppendTabPatch(2000);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      const afterAppend = countText();
      api.emitDeletePatch(["tab:2000"]);
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        before,
        afterAppend,
        afterDelete: countText(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount()
      };
    });

    expect(result.before).toBe("1001 items / 0 saved");
    expect(result.afterAppend).toBe("1002 items / 0 saved");
    expect(result.afterDelete).toBe("1001 items / 0 saved");
    expect(result.requests).toHaveLength(2);
    expect(result.stateRequests).toBe(0);
    expect(issues).toEqual([]);
  });

  test("psh-keyboard-cut-delete-patch-stale-refill-clears-local-cut-before-paste", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await nodeRow(page, "tab:800").locator(".node-label").focus();
    await page.keyboard.press("Control+X");
    await expect(page.locator(nodeSelector("tab:800"))).toHaveClass(/is-cut/);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.emitDeletePatch(["tab:800"]);
      await api.waitForIdleFrames(2);
      api.resolveSliceAt(0, { start: 760, end: 840 });
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0);
      await api.waitForVisibleRow(250);
      return {
        requests: api.projectionRequests(),
        visibleRows: api.visibleRows(),
        cutMarkers: document.querySelectorAll(".is-cut").length,
        deletedCutExists: Boolean(document.querySelector("[data-node-id='tab:800']"))
      };
    });

    await nodeRow(page, "tab:250").locator(".node-label").focus();
    await page.keyboard.press("Control+V");

    expect(result.requests).toHaveLength(2);
    expect(result.visibleRows).toContain(250);
    expect(result.cutMarkers).toBe(0);
    expect(result.deletedCutExists).toBe(false);
    await expect(sentCommands(page)).resolves.toEqual([]);
    expect(issues).toEqual([]);
  });

  test("psh-two-sidebars-keyboard-cut-and-search-patch-stay-independent", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, { includeCoverage: true, fullStatePending: true });
      await pageB.locator("#search").fill("Tab 900");
      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0);
        await api.waitForVisibleRow(1);
      });

      await nodeRow(page, "tab:800").locator(".node-label").focus();
      await page.keyboard.press("Control+X");
      await expect(page.locator(nodeSelector("tab:800"))).toHaveClass(/is-cut/);

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitTitlePatch("tab:800", "Cut row patched in first sidebar");
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            cutMarkers: document.querySelectorAll(".is-cut").length,
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows()
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitTitlePatch("tab:800", "Cut row patched in background");
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows(),
            countText: document.querySelector("#state-count")?.textContent ?? ""
          };
        })
      ]);

      expect(resultA.commands).toEqual([]);
      expect(resultA.requests).toEqual([]);
      expect(resultA.stateRequests).toBe(1);
      expect(resultA.cutMarkers).toBe(1);
      expect(resultA.searchValue).toBe("");
      expect(resultA.visibleRows).toContain(800);

      expect(resultB.commands).toEqual([]);
      expect(resultB.requests).toEqual([
        expect.objectContaining({ query: "Tab 900", targetNodeId: undefined })
      ]);
      expect(resultB.stateRequests).toBe(0);
      expect(resultB.searchValue).toBe("Tab 900");
      expect(resultB.visibleRows).toContain(1);
      expect(resultB.countText).toBe("1 match / 1001 items");
      await expect(nodeRow(pageB, "tab:900")).toBeVisible();
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-close-delete-history-stale-refill-keeps-neighbor-actions", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
    });

    const row = nodeRow(page, "tab:800");
    await row.hover();
    await row.getByRole("button", { name: "Close", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "close tab" });
      api.emitDeletePatch(["tab:800"]);
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { start: 760, end: 840 });
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0);
      await api.waitForVisibleRow(250);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows(),
        deletedClosedExists: Boolean(document.querySelector("[data-node-id='tab:800']"))
      };
    });

    expect(result.commands).toEqual([{ type: "closeNode", nodeId: "tab:800" }]);
    expect(result.requests).toHaveLength(2);
    expect(result.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toContain(250);
    expect(result.deletedClosedExists).toBe(false);
    await nodeRow(page, "tab:250").hover();
    await expect(nodeRow(page, "tab:250").getByRole("button", { name: "Close", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-root-drop-history-full-broadcast-clears-preview-without-hydration", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      historyStatus: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
    });

    await dragToRoot(page, "tab:800");
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "move to root" });
      api.emitFullStateBroadcast();
      await api.waitForIdleFrames(6);
      const marker = document.querySelector<HTMLElement>("[data-testid='drop-marker']");
      const root = document.querySelector<HTMLElement>("main");
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        markerClassName: marker?.className ?? "",
        rootDropTarget: root?.classList.contains("root-drop-target") ?? false,
        visibleRows: api.visibleRows()
      };
    });

    expect(result.commands).toEqual([
      expect.objectContaining({ type: "moveNodeToNewWindow", nodeId: "tab:800", index: 1 })
    ]);
    expect(result.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
    expect(result.stateRequests).toBe(0);
    expect(result.markerClassName).not.toMatch(/drop-root|drop-before|drop-after|drop-inside/);
    expect(result.rootDropTarget).toBe(false);
    expect(result.visibleRows).toContain(800);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-two-sidebars-root-drag-and-show-in-tree-stay-independent", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, { includeCoverage: true, fullStatePending: true });
      await pageB.locator("#search").fill("Tab 900");
      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0);
        await api.waitForVisibleRow(1);
      });
      const resultRow = nodeRow(pageB, "tab:900");
      await resultRow.hover();
      await resultRow.getByRole("button", { name: "Show in tree", exact: true }).click();
      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForSparseRequestCount(2);
        api.resolveSliceAt(0, { start: 880, end: 940 });
        await api.waitForVisibleRow(900);
      });

      await dragToRoot(page, "tab:800");
      await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitMovePatch("tab:800", "window:1", 800);
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows()
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitMovePatch("tab:800", "window:1", 800);
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows(),
            hasRevealHighlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight"))
          };
        })
      ]);

      expect(resultA.commands).toEqual([
        expect.objectContaining({ type: "moveNodeToNewWindow", nodeId: "tab:800", index: 1 })
      ]);
      expect(resultA.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
      expect(resultA.stateRequests).toBe(0);
      expect(resultA.searchValue).toBe("");
      expect(resultA.visibleRows).toContain(800);

      expect(resultB.commands).toContainEqual({ type: "expandAncestors", nodeId: "tab:900" });
      expect(resultB.requests.map((request) => ({
        query: request.query,
        targetNodeId: request.targetNodeId
      })).slice(0, 2)).toEqual([
        { query: "Tab 900", targetNodeId: undefined },
        { query: "", targetNodeId: "tab:900" }
      ]);
      expect(resultB.stateRequests).toBe(0);
      expect(resultB.searchValue).toBe("");
      expect(resultB.visibleRows).toContain(900);
      expect(resultB.hasRevealHighlight).toBe(true);
      await expect(page.locator(nodeSelector("tab:800"))).toBeVisible();
      await expect(pageB.locator(`${nodeSelector("tab:900")}.is-reveal-highlight`)).toBeVisible();
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
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

  test("psh-delayed-restore-dismiss-after-history-status-keeps-outline", async ({ page }) => {
    const issues = collectPageIssues(page);
    const dialogMessages: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogMessages.push(dialog.message());
      await dialog.dismiss();
    });
    await loadClosedRestoreSidebar(page, { fullStatePending: true, delayRestoreScope: true });

    await nodeRow(page, "window:30").getByRole("button", { name: "Restore Closed Window", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({
        canUndo: true,
        canRedo: false,
        undoDepth: 1,
        redoDepth: 0,
        undoLabel: "restore prompt peer edit"
      });
      api.resolveRestoreScope();
      await api.waitForIdleFrames(8);
      return {
        commands: api.sentCommands(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows(),
        closedWindowExists: Boolean(document.querySelector("[data-node-id='window:30']")),
        closedTabExists: Boolean(document.querySelector("[data-node-id='tab:30']")),
        undoEnabled: !document.querySelector<HTMLButtonElement>("#undo")?.disabled,
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([{ type: "analyzeRestoreScope", nodeId: "window:30" }]);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toContain(0);
    expect(result.closedWindowExists).toBe(true);
    expect(result.closedTabExists).toBe(true);
    expect(result.undoEnabled).toBe(true);
    expect(result.countText).toContain("saved");
    expect(dialogMessages).toHaveLength(1);
    expect(dialogMessages[0]).toContain("Restore 4 restorable closed nodes");
    expect(issues).toEqual([]);
  });

  test("psh-closed-tab-direct-restore-after-search-refill-skips-window-scope", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadClosedRestoreSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Closed tab 30");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForProjectionRequest("Closed tab 30");
      api.resolveSliceForQuery("Closed tab 30");
      await api.waitForVisibleRow(1);
    });
    await nodeRow(page, "tab:30").getByRole("button", { name: /Restore Closed tab 30/ }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitDeletePatch(["tab:30"]);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        closedWindowExists: Boolean(document.querySelector("[data-node-id='window:30']")),
        closedTabExists: Boolean(document.querySelector("[data-node-id='tab:30']")),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([{ type: "restoreNode", nodeId: "tab:30" }]);
    expect(result.requests).toContainEqual(expect.objectContaining({ query: "Closed tab 30", targetNodeId: undefined }));
    expect(result.requests.every((request) => request.query === "Closed tab 30" && request.targetNodeId === undefined))
      .toBe(true);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("Closed tab 30");
    expect(result.closedWindowExists).toBe(false);
    expect(result.closedTabExists).toBe(false);
    expect(result.countText).toBe("0 matches / 3 items");
    expect(issues).toEqual([]);
  });

  test("psh-two-sidebars-closed-tab-restore-and-target-owner-stay-independent", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    await loadClosedRestoreSidebar(page, { fullStatePending: true });
    await nodeRow(page, "tab:30").getByRole("button", { name: /Restore Closed tab 30/ }).click();

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, { includeCoverage: true, fullStatePending: true });
      await pageB.locator("#search").fill("Tab 900");
      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForProjectionRequest("Tab 900");
        api.resolveSliceForQuery("Tab 900");
        await api.waitForVisibleRow(1);
      });
      await nodeRow(pageB, "tab:900").hover();
      await nodeRow(pageB, "tab:900").getByRole("button", { name: "Show in tree", exact: true }).click();
      await pageB.waitForFunction(() => projectionHuntApi().projectionRequests().some((request) => request.targetNodeId === "tab:900"));

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "restore closed tab" });
          api.emitDeletePatch(["tab:30"]);
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            stateRequests: api.stateRequestCount(),
            visibleRows: api.visibleRows(),
            closedWindowExists: Boolean(document.querySelector("[data-node-id='window:30']")),
            closedTabExists: Boolean(document.querySelector("[data-node-id='tab:30']")),
            countText: document.querySelector("#state-count")?.textContent ?? ""
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "peer restore" });
          api.resolveSliceForTarget("tab:900", { start: 880, end: 940 });
          await api.waitForVisibleRow(900);
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows(),
            hasTargetHighlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight")),
            hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900'].is-search-match"))
          };
        })
      ]);

      expect(resultA.commands).toEqual([{ type: "restoreNode", nodeId: "tab:30" }]);
      expect(resultA.stateRequests).toBe(0);
      expect(resultA.visibleRows).toContain(0);
      expect(resultA.closedWindowExists).toBe(true);
      expect(resultA.closedTabExists).toBe(false);
      expect(resultA.countText).toBe("3 items / 3 saved");

      expect(resultB.commands).toEqual([{ type: "expandAncestors", nodeId: "tab:900" }]);
      expect(resultB.requests).toContainEqual(expect.objectContaining({ query: "Tab 900", targetNodeId: undefined }));
      expect(resultB.requests).toContainEqual(expect.objectContaining({ query: "", targetNodeId: "tab:900" }));
      expect(resultB.stateRequests).toBe(0);
      expect(resultB.searchValue).toBe("");
      expect(resultB.visibleRows).toContain(900);
      expect(resultB.hasTargetHighlight).toBe(true);
      expect(resultB.hasSearchRow).toBe(false);
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-two-sidebars-root-drop-and-delayed-restore-prompt-stay-independent", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    await loadRestoredWindowSidebar(page, { fullStatePending: true });
    await dragToRoot(page, "tab:2");

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    const dialogMessagesB: string[] = [];
    pageB.on("dialog", async (dialog) => {
      dialogMessagesB.push(dialog.message());
      await dialog.dismiss();
    });
    try {
      await loadClosedRestoreSidebar(pageB, { fullStatePending: true, delayRestoreScope: true });
      await nodeRow(pageB, "window:30").getByRole("button", { name: "Restore Closed Window", exact: true }).click();
      await pageB.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "root drop" });
          await api.waitForIdleFrames(4);
          const marker = document.querySelector<HTMLElement>("[data-testid='drop-marker']");
          const root = document.querySelector<HTMLElement>("main");
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            visibleRows: api.visibleRows(),
            markerClassName: marker?.className ?? "",
            rootDropTarget: root?.classList.contains("root-drop-target") ?? false
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitHistoryStatus({
            canUndo: true,
            canRedo: false,
            undoDepth: 1,
            redoDepth: 0,
            undoLabel: "peer root drop"
          });
          api.resolveRestoreScope();
          await api.waitForIdleFrames(8);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            visibleRows: api.visibleRows(),
            closedWindowExists: Boolean(document.querySelector("[data-node-id='window:30']")),
            closedTabExists: Boolean(document.querySelector("[data-node-id='tab:30']")),
            undoEnabled: !document.querySelector<HTMLButtonElement>("#undo")?.disabled
          };
        })
      ]);

      expect(resultA.commands).toEqual([{ type: "moveNodeToNewWindow", nodeId: "tab:2", index: 2 }]);
      expect(resultA.requests).toEqual([]);
      expect(resultA.stateRequests).toBe(0);
      expect(resultA.visibleRows).toContain(3);
      expect(resultA.markerClassName).not.toMatch(/drop-root|drop-before|drop-after|drop-inside/);
      expect(resultA.rootDropTarget).toBe(false);

      expect(resultB.commands).toEqual([{ type: "analyzeRestoreScope", nodeId: "window:30" }]);
      expect(resultB.requests).toEqual([]);
      expect(resultB.stateRequests).toBe(0);
      expect(resultB.visibleRows).toContain(0);
      expect(resultB.closedWindowExists).toBe(true);
      expect(resultB.closedTabExists).toBe(true);
      expect(resultB.undoEnabled).toBe(true);
      expect(dialogMessagesB).toHaveLength(1);
      expect(dialogMessagesB[0]).toContain("Restore 4 restorable closed nodes");
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
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

  test("psh-search-visible-delete-refills-current-query-results", async ({ page }) => {
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

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitDeletePatch(["tab:900"]);
      await api.waitForIdleFrames(3);
      if (api.sparseRequestCount() > 1) {
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(4);
      }
      return {
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasDeletedMatch: Boolean(document.querySelector("[data-node-id='tab:900']")),
        hasRemainingMatch: Boolean(document.querySelector("[data-node-id='tab:90']")),
        hasOutlineRow: Boolean(document.querySelector("[data-node-id='tab:250']"))
      };
    });

    expect(result.requests.every((request) => request.query === "Tab 90")).toBe(true);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("Tab 90");
    expect(result.countText).toBe("10 matches / 1000 items");
    expect(result.visibleRows).toContain(1);
    expect(result.hasDeletedMatch).toBe(false);
    expect(result.hasRemainingMatch).toBe(true);
    expect(result.hasOutlineRow).toBe(false);
    await expect(page.locator("#search")).toHaveValue("Tab 90");
    await expect(page.locator(nodeSelector("tab:900"))).toHaveCount(0);
    expect(issues).toEqual([]);
  });

  test("psh-show-in-tree-target-moved-before-slice-keeps-reveal-current", async ({ page }) => {
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
      api.emitMovePatch("tab:900", "window:1", 119);
      await api.waitForIdleFrames(3);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(5);
      return {
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasRevealHighlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight")),
        targetText: document.querySelector("[data-node-id='tab:900']")?.textContent ?? ""
      };
    });

    expect(result.requests.map((request) => ({
      query: request.query,
      targetNodeId: request.targetNodeId
    }))).toEqual([
      { query: "Tab 900", targetNodeId: undefined },
      { query: "", targetNodeId: "tab:900" }
    ]);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows).toContain(120);
    expect(result.hasRevealHighlight).toBe(true);
    expect(result.targetText).toContain("Tab 900");
    await expect(page.locator(`${nodeSelector("tab:900")}.is-reveal-highlight`)).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-owner-replacement-resets-coverage-actions", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const coveredRow = nodeRow(page, "tab:800");
    await expect(coveredRow).toBeVisible();
    await coveredRow.hover();
    await expect(coveredRow.getByRole("button", { name: "Cut", exact: true })).toBeVisible();
    await expect(coveredRow.getByRole("button", { name: "Move to top level", exact: true })).toBeVisible();

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });

    const searchResultRow = nodeRow(page, "tab:900");
    await expect(searchResultRow).toBeVisible();
    await searchResultRow.hover();
    await searchResultRow.getByRole("button", { name: "Show in tree", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0, { includeCoverage: false });
      await api.waitForIdleFrames(4);
      return {
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows()
      };
    });

    expect(result.requests.map((request) => ({
      query: request.query,
      targetNodeId: request.targetNodeId
    }))).toEqual([
      { query: "Tab 900", targetNodeId: undefined },
      { query: "", targetNodeId: "tab:900" }
    ]);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows).toContain(900);

    const searchRow = nodeRow(page, "tab:900");
    await expect(searchRow).toBeVisible();
    await searchRow.hover();
    await expect(searchRow.getByRole("button", { name: "Cut", exact: true })).toHaveCount(0);
    await expect(searchRow.getByRole("button", { name: "Move to top level", exact: true })).toHaveCount(0);
    await expect(searchRow.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.resolveFullState();
      await api.waitForIdleFrames(20);
    });
    await searchRow.hover();
    await expect(searchRow.getByRole("button", { name: "Cut", exact: true })).toBeVisible();
    await expect(searchRow.getByRole("button", { name: "Move to top level", exact: true })).toBeVisible();
    await expect(searchRow.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-show-in-tree-deleted-target-rejected-response-restores-outline", async ({ page }) => {
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
      api.rejectSliceAt(0);
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
        targetExists: Boolean(document.querySelector("[data-node-id='tab:900']")),
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(result.commands).toEqual([{ type: "expandAncestors", nodeId: "tab:900" }]);
    expect(result.requests).toContainEqual(expect.objectContaining({ query: "", targetNodeId: "tab:900" }));
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1000 items / 0 saved");
    expect(result.visibleRows.length).toBeGreaterThan(0);
    expect(result.targetExists).toBe(false);
    expect(result.hasRevealHighlight).toBe(false);
    await expect(page.locator(nodeSelector("tab:900"))).toHaveCount(0);
    expect(issues.filter((issue) => issue.kind !== "console")).toEqual([]);
  });

  test("psh-search-patch-clear-stale-refresh-keeps-outline-owner", async ({ page }) => {
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

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitTitlePatch("tab:900", "Renamed away from query");
      await api.waitForSparseRequestCount(2);
    });
    await page.locator("#clear-search").click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(3);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(2);
      const afterStaleSearchRefresh = {
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasDeletedQueryRow: Boolean(document.querySelector("[data-node-id='tab:900']"))
      };
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(5);
      if (api.sparseRequestCount() > 3) {
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(4);
      }
      return {
        requests: api.projectionRequests(),
        afterStaleSearchRefresh,
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasDeletedQueryRow: Boolean(document.querySelector("[data-node-id='tab:900']")),
        hasOutlineRow: Boolean(document.querySelector("[data-node-id='tab:800']"))
      };
    });

    expect(result.requests.map((request) => request.query)).toEqual(["Tab 900", "Tab 900", ""]);
    expect(result.afterStaleSearchRefresh.searchValue).toBe("");
    expect(result.afterStaleSearchRefresh.hasDeletedQueryRow).toBe(false);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows.length).toBeGreaterThan(0);
    expect(result.hasDeletedQueryRow).toBe(false);
    expect(result.hasOutlineRow).toBe(true);
    await expect(page.locator("#search")).toHaveValue("");
    expect(issues).toEqual([]);
  });

  test("psh-visible-delete-stale-scroll-response-refills-current-window", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { start: 250, end: 278 });
      await api.waitForVisibleRow(250);

      await api.scrollToRow(700);
      await api.waitForSparseRequestCount(2);
      await api.scrollToRow(250);
      await api.waitForVisibleRow(250);

      api.emitDeletePatch(Array.from({ length: 28 }, (_value, index) => `tab:${250 + index}`));
      await api.waitForSparseRequestCount(3);
      api.resolveSliceAt(0, { start: 700, end: 760 });
      await api.waitForIdleFrames(2);
      const afterStaleScroll = {
        visibleRows: api.visibleRows(),
        hasDeletedRow: Boolean(document.querySelector("[data-node-id='tab:250']"))
      };

      api.resolveSliceAt(0, { start: 250, end: 310 });
      await api.waitForIdleFrames(5);
      if (api.sparseRequestCount() > 3) {
        api.resolveSliceAt(0, { start: 250, end: 310 });
        await api.waitForIdleFrames(4);
      }

      return {
        requests: api.projectionRequests(),
        afterStaleScroll,
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasDeletedRow: Boolean(document.querySelector("[data-node-id='tab:250']")),
        hasRefillRow: Boolean(document.querySelector("[data-node-id='tab:278']"))
      };
    });

    expect(result.requests.map((request) => request.query).every((query) => query === "")).toBe(true);
    expect(result.afterStaleScroll.hasDeletedRow).toBe(false);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("973 items / 0 saved");
    expect(result.visibleRows.length).toBeGreaterThan(0);
    expect(result.visibleRows).toContain(250);
    expect(result.hasDeletedRow).toBe(false);
    expect(result.hasRefillRow).toBe(true);
    await expect(page.locator(nodeSelector("tab:250"))).toHaveCount(0);
    await expect(nodeRow(page, "tab:278")).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-two-sidebars-undo-full-broadcast-keeps-search-and-scroll-owners", async ({ page }) => {
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

      await page.locator("#search").fill("Tab 900");
      await page.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(3);
      });

      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.scrollToRow(320);
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0, { start: 300, end: 360 });
        await api.waitForVisibleRow(320);
        await api.waitForIdleFrames(3);
      });

      await expect(nodeRow(page, "tab:900")).toBeVisible();
      await expect(nodeRow(pageB, "tab:320")).toBeVisible();
      await pageB.getByRole("button", { name: "Undo", exact: true }).click();

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" });
          api.emitFullStateBroadcast();
          await api.waitForIdleFrames(5);
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
            hasTab320: Boolean(document.querySelector("[data-node-id='tab:320']"))
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          await api.waitForIdleFrames(2);
          api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" });
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
            hasTab900: Boolean(document.querySelector("[data-node-id='tab:900']")),
            hasTab320: Boolean(document.querySelector("[data-node-id='tab:320']"))
          };
        })
      ]);

      expect(resultA.commands).toEqual([]);
      expect(resultA.requests.map((request) => request.query)).toEqual(["Tab 900"]);
      expect(resultA.stateRequestCount).toBe(0);
      expect(resultA.searchValue).toBe("Tab 900");
      expect(resultA.countText).toBe("1 match / 1001 items");
      expect(resultA.visibleRows).toContain(1);
      expect(resultA.hasTab900).toBe(true);
      expect(resultA.hasTab320).toBe(false);

      expect(resultB.commands).toEqual([{ type: "undo" }]);
      expect(resultB.requests.map((request) => request.query)).toEqual([""]);
      expect(resultB.stateRequestCount).toBe(0);
      expect(resultB.searchValue).toBe("");
      expect(resultB.countText).toBe("1001 items / 0 saved");
      expect(resultB.visibleRows).toContain(320);
      expect(resultB.hasTab900).toBe(false);
      expect(resultB.hasTab320).toBe(true);
      await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
      await expect(pageB.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
      await expect(pageB.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
      await expect(nodeRow(page, "tab:900")).toBeVisible();
      await expect(nodeRow(pageB, "tab:320")).toBeVisible();
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-search-title-patch-full-broadcast-keeps-query-owner", async ({ page }) => {
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
      api.emitTitlePatch("tab:900", "Tab 900 patched before full broadcast");
      await api.waitForIdleFrames(3);
      if (api.sparseRequestCount() > 1) {
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(4);
      }
      api.emitFullStateBroadcast();
      await api.waitForIdleFrames(5);
      if (api.sparseRequestCount() > 1) {
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(4);
      }
      return {
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        tab900Text: document.querySelector("[data-node-id='tab:900']")?.textContent ?? "",
        hasOutlineRow: Boolean(document.querySelector("[data-node-id='tab:800']")),
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(result.requests.every((request) => request.query === "Tab 900")).toBe(true);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("Tab 900");
    expect(result.countText).toBe("1 match / 1001 items");
    expect(result.visibleRows).toContain(1);
    expect(result.tab900Text).toContain("Tab 900 patched before full broadcast");
    expect(result.hasOutlineRow).toBe(false);
    expect(result.hasRevealHighlight).toBe(false);
    await expect(nodeRow(page, "tab:900")).toContainText("Tab 900 patched before full broadcast");
    expect(issues).toEqual([]);
  });

  test("psh-visible-move-patch-refills-current-window-without-count-drift", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { start: 240, end: 310 });
      await api.waitForVisibleRow(260);

      api.emitMovePatch("tab:260", "window:1", 899);
      await api.waitForIdleFrames(4);
      if (api.sparseRequestCount() > 1) {
        api.resolveSliceAt(0, { start: 240, end: 310 });
        await api.waitForIdleFrames(4);
      }

      return {
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasMovedRowAtOldViewport: Boolean(document.querySelector("[data-node-id='tab:260']")),
        hasNeighborRow: Boolean(document.querySelector("[data-node-id='tab:261']")),
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(result.requests.map((request) => request.query).every((query) => query === "")).toBe(true);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows.length).toBeGreaterThan(0);
    expect(result.visibleRows).toContain(250);
    expect(result.hasMovedRowAtOldViewport).toBe(false);
    expect(result.hasNeighborRow).toBe(true);
    expect(result.hasRevealHighlight).toBe(false);
    await expect(page.locator(nodeSelector("tab:260"))).toHaveCount(0);
    await expect(nodeRow(page, "tab:261")).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-two-sidebars-move-patch-preserves-search-and-scroll-owners", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, { fullStatePending: true });

      await page.locator("#search").fill("Tab 260");
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
        api.resolveSliceAt(0, { start: 240, end: 310 });
        await api.waitForVisibleRow(260);
        await api.waitForIdleFrames(3);
      });

      await expect(nodeRow(page, "tab:260")).toBeVisible();
      await expect(nodeRow(pageB, "tab:260")).toBeVisible();

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitMovePatch("tab:260", "window:1", 899);
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
            hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:260']")),
            hasOutlineNeighbor: Boolean(document.querySelector("[data-node-id='tab:261']"))
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitMovePatch("tab:260", "window:1", 899);
          await api.waitForIdleFrames(4);
          if (api.sparseRequestCount() > 1) {
            api.resolveSliceAt(0, { start: 240, end: 310 });
            await api.waitForIdleFrames(4);
          }
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequestCount: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            visibleRows: api.visibleRows(),
            hasMovedRowAtOldViewport: Boolean(document.querySelector("[data-node-id='tab:260']")),
            hasNeighborRow: Boolean(document.querySelector("[data-node-id='tab:261']"))
          };
        })
      ]);

      expect(resultA.commands).toEqual([]);
      expect(resultA.requests.every((request) => request.query === "Tab 260")).toBe(true);
      expect(resultA.stateRequestCount).toBe(0);
      expect(resultA.searchValue).toBe("Tab 260");
      expect(resultA.countText).toBe("1 match / 1001 items");
      expect(resultA.visibleRows).toContain(1);
      expect(resultA.hasSearchRow).toBe(true);
      expect(resultA.hasOutlineNeighbor).toBe(false);

      expect(resultB.commands).toEqual([]);
      expect(resultB.requests.every((request) => request.query === "")).toBe(true);
      expect(resultB.stateRequestCount).toBe(0);
      expect(resultB.searchValue).toBe("");
      expect(resultB.countText).toBe("1001 items / 0 saved");
      expect(resultB.visibleRows).toContain(250);
      expect(resultB.hasMovedRowAtOldViewport).toBe(false);
      expect(resultB.hasNeighborRow).toBe(true);
      await expect(nodeRow(page, "tab:260")).toBeVisible();
      await expect(pageB.locator(nodeSelector("tab:260"))).toHaveCount(0);
      await expect(nodeRow(pageB, "tab:261")).toBeVisible();
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-focus-command-after-visible-move-patch-keeps-scroll-owner", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { start: 240, end: 310 });
      await api.waitForVisibleRow(260);
      api.emitMovePatch("tab:260", "window:1", 899);
      await api.waitForIdleFrames(4);
      if (api.sparseRequestCount() > 1) {
        api.resolveSliceAt(0, { start: 240, end: 310 });
        await api.waitForIdleFrames(4);
      }
    });

    await expect(nodeRow(page, "tab:261")).toBeVisible();
    await nodeRow(page, "tab:261").locator(".node-label").click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasMovedRowAtOldViewport: Boolean(document.querySelector("[data-node-id='tab:260']")),
        hasFocusedRow: Boolean(document.querySelector("[data-node-id='tab:261']"))
      };
    });

    expect(result.commands).toEqual([{ type: "focusNode", nodeId: "tab:261" }]);
    expect(result.requests.every((request) => request.query === "")).toBe(true);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows).toContain(250);
    expect(result.hasMovedRowAtOldViewport).toBe(false);
    expect(result.hasFocusedRow).toBe(true);
    await expect(nodeRow(page, "tab:261")).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-rejected-search-after-outline-move-patch-keeps-scroll-owner", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { start: 240, end: 310 });
      await api.waitForVisibleRow(260);
    });

    await page.locator("#search").fill("Tab 260");

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(2);
      api.emitMovePatch("tab:260", "window:1", 899);
      await api.waitForIdleFrames(3);
      api.rejectSliceAt(0);
      await api.waitForIdleFrames(5);
      if (api.sparseRequestCount() > 2) {
        api.resolveSliceAt(0, { start: 240, end: 310 });
        await api.waitForIdleFrames(4);
      }
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasMovedRowAtOldViewport: Boolean(document.querySelector("[data-node-id='tab:260']")),
        hasNeighborRow: Boolean(document.querySelector("[data-node-id='tab:261']")),
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests.map((request) => request.query)).toEqual(["", "Tab 260"]);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("Tab 260");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows).toContain(250);
    expect(result.hasMovedRowAtOldViewport).toBe(false);
    expect(result.hasNeighborRow).toBe(true);
    expect(result.hasRevealHighlight).toBe(false);
    await expect(page.locator("#search")).toHaveValue("Tab 260");
    await expect(nodeRow(page, "tab:261")).toBeVisible();
    expect(issues.filter((issue) => issue.kind !== "console")).toEqual([]);
  });

  test("psh-history-status-after-visible-move-patch-keeps-scroll-actions", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
    });

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { start: 240, end: 310 });
      await api.waitForVisibleRow(260);
      api.emitMovePatch("tab:260", "window:1", 899);
      api.emitHistoryStatus({ canUndo: true, canRedo: true, undoDepth: 2, redoDepth: 1, undoLabel: "move", redoLabel: "move" });
      await api.waitForIdleFrames(4);
      if (api.sparseRequestCount() > 1) {
        api.resolveSliceAt(0, { start: 240, end: 310 });
        await api.waitForIdleFrames(4);
      }
    });

    const neighbor = nodeRow(page, "tab:261");
    await expect(neighbor).toBeVisible();
    await neighbor.hover();
    await expect(neighbor.getByRole("button", { name: "Close", exact: true })).toBeVisible();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForIdleFrames(2);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasMovedRowAtOldViewport: Boolean(document.querySelector("[data-node-id='tab:260']")),
        hasNeighborRow: Boolean(document.querySelector("[data-node-id='tab:261']")),
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows).toContain(250);
    expect(result.hasMovedRowAtOldViewport).toBe(false);
    expect(result.hasNeighborRow).toBe(true);
    expect(result.hasRevealHighlight).toBe(false);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-full-broadcast-after-visible-move-patch-keeps-scroll-owner", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { start: 240, end: 310 });
      await api.waitForVisibleRow(260);
      api.emitMovePatch("tab:260", "window:1", 899);
      await api.waitForIdleFrames(3);
      api.emitFullStateBroadcast();
      await api.waitForIdleFrames(4);
      if (api.sparseRequestCount() > 1) {
        api.resolveSliceAt(0, { start: 240, end: 310 });
        await api.waitForIdleFrames(4);
      }
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasMovedRowAtOldViewport: Boolean(document.querySelector("[data-node-id='tab:260']")),
        hasNeighborRow: Boolean(document.querySelector("[data-node-id='tab:261']")),
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows).toContain(250);
    expect(result.hasMovedRowAtOldViewport).toBe(false);
    expect(result.hasNeighborRow).toBe(true);
    expect(result.hasRevealHighlight).toBe(false);
    await expect(page.locator(nodeSelector("tab:260"))).toHaveCount(0);
    await expect(nodeRow(page, "tab:261")).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-title-patch-while-scroll-refill-pending-keeps-current-window", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.emitTitlePatch("tab:260", "Tab 260 patched before refill");
      await api.waitForIdleFrames(3);
      api.resolveSliceAt(0, { start: 240, end: 310 });
      await api.waitForVisibleRow(260);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        tab260Text: document.querySelector("[data-node-id='tab:260']")?.textContent ?? "",
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows).toContain(250);
    expect(result.tab260Text).toContain("Tab 260 patched before refill");
    expect(result.hasRevealHighlight).toBe(false);
    await expect(nodeRow(page, "tab:260")).toContainText("Tab 260 patched before refill");
    expect(issues).toEqual([]);
  });

  test("psh-search-missing-coverage-title-patch-restores-actions-after-hydration", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { includeCoverage: false });
      api.emitTitlePatch("tab:900", "Tab 900 search coverage patched");
      await api.waitForIdleFrames(5);
      if (api.sparseRequestCount() > 1) {
        api.resolveSliceAt(0, { includeCoverage: false });
        await api.waitForIdleFrames(4);
      }
    });

    const resultRow = nodeRow(page, "tab:900");
    await expect(resultRow).toContainText("Tab 900 search coverage patched");
    await resultRow.hover();
    await expect(resultRow.getByRole("button", { name: "Cut", exact: true })).toHaveCount(0);
    await expect(resultRow.getByRole("button", { name: "Move to top level", exact: true })).toHaveCount(0);
    await expect(resultRow.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);

    const beforeHydration = await page.evaluate(() => {
      const api = projectionHuntApi();
      return {
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows()
      };
    });

    expect(beforeHydration.requests.every((request) => request.query === "Tab 900")).toBe(true);
    expect(beforeHydration.stateRequestCount).toBe(0);
    expect(beforeHydration.searchValue).toBe("Tab 900");
    expect(beforeHydration.countText).toBe("1 match / 1001 items");
    expect(beforeHydration.visibleRows).toContain(1);

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.resolveFullState();
      await api.waitForIdleFrames(20);
    });

    await expect(page.locator("#search")).toHaveValue("Tab 900");
    await resultRow.hover();
    await expect(resultRow.getByRole("button", { name: "Cut", exact: true })).toBeVisible();
    await expect(resultRow.getByRole("button", { name: "Move to top level", exact: true })).toBeVisible();
    await expect(resultRow.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-show-in-tree-missing-coverage-history-status-keeps-reveal-readonly", async ({ page }) => {
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

    const resultRow = nodeRow(page, "tab:900");
    await expect(resultRow).toBeVisible();
    await resultRow.hover();
    await resultRow.getByRole("button", { name: "Show in tree", exact: true }).click();

    const beforeHydration = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(2);
      api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" });
      api.resolveSliceAt(0, { includeCoverage: false });
      await api.waitForIdleFrames(5);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasRevealHighlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight"))
      };
    });

    expect(beforeHydration.commands).toContainEqual({ type: "expandAncestors", nodeId: "tab:900" });
    expect(beforeHydration.requests.map((request) => ({
      query: request.query,
      targetNodeId: request.targetNodeId
    }))).toEqual([
      { query: "Tab 900", targetNodeId: undefined },
      { query: "", targetNodeId: "tab:900" }
    ]);
    expect(beforeHydration.stateRequestCount).toBe(0);
    expect(beforeHydration.searchValue).toBe("");
    expect(beforeHydration.countText).toBe("1001 items / 0 saved");
    expect(beforeHydration.visibleRows).toContain(900);
    expect(beforeHydration.hasRevealHighlight).toBe(true);

    const targetRow = nodeRow(page, "tab:900");
    await targetRow.hover();
    await expect(targetRow.getByRole("button", { name: "Cut", exact: true })).toHaveCount(0);
    await expect(targetRow.getByRole("button", { name: "Move to top level", exact: true })).toHaveCount(0);
    await expect(targetRow.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.resolveFullState();
      await api.waitForIdleFrames(20);
    });

    await expect(page.locator(`${nodeSelector("tab:900")}.is-reveal-highlight`)).toBeVisible();
    await targetRow.hover();
    await expect(targetRow.getByRole("button", { name: "Cut", exact: true })).toBeVisible();
    await expect(targetRow.getByRole("button", { name: "Move to top level", exact: true })).toBeVisible();
    await expect(targetRow.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-outline-missing-coverage-full-broadcast-restores-actions", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { start: 240, end: 310, includeCoverage: false });
      await api.waitForVisibleRow(260);
      await api.waitForIdleFrames(5);
    });

    const coveredByRowsOnly = nodeRow(page, "tab:260");
    await expect(coveredByRowsOnly).toBeVisible();
    await coveredByRowsOnly.hover();
    await expect(coveredByRowsOnly.getByRole("button", { name: "Cut", exact: true })).toHaveCount(0);
    await expect(coveredByRowsOnly.getByRole("button", { name: "Move to top level", exact: true })).toHaveCount(0);
    await expect(coveredByRowsOnly.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);

    const beforeHydration = await page.evaluate(() => {
      const api = projectionHuntApi();
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(beforeHydration.commands).toEqual([]);
    expect(beforeHydration.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
    expect(beforeHydration.stateRequestCount).toBe(0);
    expect(beforeHydration.searchValue).toBe("");
    expect(beforeHydration.countText).toBe("1001 items / 0 saved");
    expect(beforeHydration.visibleRows).toContain(250);
    expect(beforeHydration.hasRevealHighlight).toBe(false);

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitFullStateBroadcast();
      await api.waitForIdleFrames(5);
      if (api.sparseRequestCount() > 1) {
        api.resolveSliceAt(0, { start: 240, end: 310, includeCoverage: false });
        await api.waitForIdleFrames(4);
      }
    });

    await coveredByRowsOnly.hover();
    await expect(coveredByRowsOnly.getByRole("button", { name: "Cut", exact: true })).toBeVisible();
    await expect(coveredByRowsOnly.getByRole("button", { name: "Move to top level", exact: true })).toBeVisible();
    await expect(coveredByRowsOnly.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-title-patch-before-search-response-builds-current-row", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.emitTitlePatch("tab:900", "Tab 900 patched before search response");
      await api.waitForIdleFrames(3);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        tab900Text: document.querySelector("[data-node-id='tab:900']")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests.every((request) => request.query === "Tab 900")).toBe(true);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("Tab 900");
    expect(result.countText).toBe("1 match / 1001 items");
    expect(result.visibleRows).toContain(1);
    expect(result.tab900Text).toContain("Tab 900 patched before search response");
    await expect(nodeRow(page, "tab:900")).toContainText("Tab 900 patched before search response");
    expect(issues).toEqual([]);
  });

  test("psh-title-patch-after-search-response-admission-updates-current-row", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { includeCoverage: false });
      await api.waitForIdleFrames(5);
      api.emitTitlePatch("tab:900", "Tab 900 patched after search response");
      await api.waitForIdleFrames(4);
      if (api.sparseRequestCount() > 1) {
        api.resolveSliceAt(0, { includeCoverage: false });
        await api.waitForIdleFrames(4);
      }
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        tab900Text: document.querySelector("[data-node-id='tab:900']")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests.every((request) => request.query === "Tab 900")).toBe(true);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("Tab 900");
    expect(result.countText).toBe("1 match / 1001 items");
    expect(result.visibleRows).toContain(1);
    expect(result.tab900Text).toContain("Tab 900 patched after search response");
    await expect(nodeRow(page, "tab:900")).toContainText("Tab 900 patched after search response");
    expect(issues).toEqual([]);
  });

  test("psh-search-missing-coverage-full-broadcast-restores-actions", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { includeCoverage: false });
      await api.waitForIdleFrames(5);
    });

    const resultRow = nodeRow(page, "tab:900");
    await expect(resultRow).toBeVisible();
    await resultRow.hover();
    await expect(resultRow.getByRole("button", { name: "Cut", exact: true })).toHaveCount(0);
    await expect(resultRow.getByRole("button", { name: "Move to top level", exact: true })).toHaveCount(0);
    await expect(resultRow.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitFullStateBroadcast();
      await api.waitForIdleFrames(5);
      if (api.sparseRequestCount() > 1) {
        api.resolveSliceAt(0, { includeCoverage: false });
        await api.waitForIdleFrames(4);
      }
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests.every((request) => request.query === "Tab 900")).toBe(true);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("Tab 900");
    expect(result.countText).toBe("1 match / 1001 items");
    expect(result.visibleRows).toContain(1);
    expect(result.hasRevealHighlight).toBe(false);
    await resultRow.hover();
    await expect(resultRow.getByRole("button", { name: "Cut", exact: true })).toBeVisible();
    await expect(resultRow.getByRole("button", { name: "Move to top level", exact: true })).toBeVisible();
    await expect(resultRow.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-outline-visible-title-patch-keeps-scroll-window", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { start: 240, end: 310 });
      await api.waitForVisibleRow(260);
      api.emitTitlePatch("tab:260", "Tab 260 patched while visible");
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        tab260Text: document.querySelector("[data-node-id='tab:260']")?.textContent ?? "",
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows).toContain(250);
    expect(result.tab260Text).toContain("Tab 260 patched while visible");
    expect(result.hasRevealHighlight).toBe(false);
    await expect(nodeRow(page, "tab:260")).toContainText("Tab 260 patched while visible");
    expect(issues).toEqual([]);
  });

  test("psh-search-title-patch-after-admission-survives-full-broadcast", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
      api.emitTitlePatch("tab:900", "Tab 900 patched before broadcast");
      await api.waitForIdleFrames(4);
      if (api.sparseRequestCount() > 1) {
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(4);
      }
      api.emitFullStateBroadcast();
      await api.waitForIdleFrames(4);
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
        tab900Text: document.querySelector("[data-node-id='tab:900']")?.textContent ?? "",
        hasOutlineRow: Boolean(document.querySelector("[data-node-id='tab:260']")),
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests.every((request) => request.query === "Tab 900")).toBe(true);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("Tab 900");
    expect(result.countText).toBe("1 match / 1001 items");
    expect(result.visibleRows).toContain(1);
    expect(result.tab900Text).toContain("Tab 900 patched before broadcast");
    expect(result.hasOutlineRow).toBe(false);
    expect(result.hasRevealHighlight).toBe(false);
    await expect(nodeRow(page, "tab:900")).toContainText("Tab 900 patched before broadcast");
    expect(issues).toEqual([]);
  });

  test("psh-show-in-tree-title-patch-after-target-admission-keeps-reveal", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });

    const resultRow = nodeRow(page, "tab:900");
    await expect(resultRow).toBeVisible();
    await resultRow.hover();
    await resultRow.getByRole("button", { name: "Show in tree", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0);
      await api.waitForVisibleRow(900);
      api.emitTitlePatch("tab:900", "Tab 900 reveal patched");
      await api.waitForIdleFrames(4);
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
        tab900Text: document.querySelector("[data-node-id='tab:900']")?.textContent ?? "",
        hasRevealHighlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight"))
      };
    });

    expect(result.commands).toContainEqual({ type: "expandAncestors", nodeId: "tab:900" });
    expect(result.requests.map((request) => ({
      query: request.query,
      targetNodeId: request.targetNodeId
    }))).toEqual([
      { query: "Tab 900", targetNodeId: undefined },
      { query: "", targetNodeId: "tab:900" }
    ]);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows).toContain(900);
    expect(result.tab900Text).toContain("Tab 900 reveal patched");
    expect(result.hasRevealHighlight).toBe(true);

    const targetRow = nodeRow(page, "tab:900");
    await expect(targetRow).toContainText("Tab 900 reveal patched");
    await targetRow.hover();
    await expect(targetRow.getByRole("button", { name: "Cut", exact: true })).toBeVisible();
    await expect(targetRow.getByRole("button", { name: "Move to top level", exact: true })).toBeVisible();
    await expect(targetRow.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-outline-history-status-title-patch-keeps-covered-actions", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
    });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { start: 240, end: 310 });
      await api.waitForVisibleRow(260);
      api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" });
      api.emitTitlePatch("tab:260", "Tab 260 history patched");
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        tab260Text: document.querySelector("[data-node-id='tab:260']")?.textContent ?? "",
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows).toContain(250);
    expect(result.tab260Text).toContain("Tab 260 history patched");
    expect(result.hasRevealHighlight).toBe(false);

    const row = nodeRow(page, "tab:260");
    await expect(row).toContainText("Tab 260 history patched");
    await row.hover();
    await expect(row.getByRole("button", { name: "Cut", exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Move to top level", exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-two-sidebars-visible-title-patches-keep-independent-owners", async ({ page }) => {
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

      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.scrollToRow(250);
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0, { start: 240, end: 310 });
        await api.waitForVisibleRow(260);
      });

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitTitlePatch("tab:900", "Tab 900 sidebar A patched");
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
            hasTab260: Boolean(document.querySelector("[data-node-id='tab:260']")),
            hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitTitlePatch("tab:260", "Tab 260 sidebar B patched");
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequestCount: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            visibleRows: api.visibleRows(),
            tab260Text: document.querySelector("[data-node-id='tab:260']")?.textContent ?? "",
            hasTab900: Boolean(document.querySelector("[data-node-id='tab:900']")),
            hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
          };
        })
      ]);

      expect(resultA.commands).toEqual([]);
      expect(resultA.requests.every((request) => request.query === "Tab 900")).toBe(true);
      expect(resultA.stateRequestCount).toBe(0);
      expect(resultA.searchValue).toBe("Tab 900");
      expect(resultA.countText).toBe("1 match / 1001 items");
      expect(resultA.visibleRows).toContain(1);
      expect(resultA.tab900Text).toContain("Tab 900 sidebar A patched");
      expect(resultA.hasTab260).toBe(false);
      expect(resultA.hasRevealHighlight).toBe(false);

      expect(resultB.commands).toEqual([]);
      expect(resultB.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
      expect(resultB.stateRequestCount).toBe(0);
      expect(resultB.searchValue).toBe("");
      expect(resultB.countText).toBe("1001 items / 0 saved");
      expect(resultB.visibleRows).toContain(250);
      expect(resultB.tab260Text).toContain("Tab 260 sidebar B patched");
      expect(resultB.hasTab900).toBe(false);
      expect(resultB.hasRevealHighlight).toBe(false);
      await expect(nodeRow(page, "tab:900")).toContainText("Tab 900 sidebar A patched");
      await expect(nodeRow(pageB, "tab:260")).toContainText("Tab 260 sidebar B patched");
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-clear-search-after-covered-title-patch-keeps-outline-window", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { start: 240, end: 310 });
      await api.waitForVisibleRow(260);
      api.emitTitlePatch("tab:260", "Tab 260 patched before search clear");
      await api.waitForIdleFrames(4);
    });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(4);
    });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      const search = document.querySelector<HTMLInputElement>("#search");
      if (!search) {
        throw new Error("Missing search input");
      }
      search.focus();
      search.value = "";
      search.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "deleteContentBackward",
        data: null
      }));
      await api.waitForIdleFrames(8);
      if (api.sparseRequestCount() > 2) {
        api.resolveSliceAt(0, { start: 240, end: 310 });
        await api.waitForIdleFrames(4);
      }
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: search.value,
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        tab260Text: document.querySelector("[data-node-id='tab:260']")?.textContent ?? "",
        hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900']")),
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(result.commands).toEqual([]);
    const requestOwners = result.requests.map((request) => ({
      query: request.query,
      targetNodeId: request.targetNodeId
    }));
    expect(requestOwners.slice(0, 2)).toEqual([
      { query: "", targetNodeId: undefined },
      { query: "Tab 900", targetNodeId: undefined }
    ]);
    expect(requestOwners.slice(2).every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows).toContain(250);
    expect(result.tab260Text).toContain("Tab 260 patched before search clear");
    expect(result.hasSearchRow).toBe(false);
    expect(result.hasRevealHighlight).toBe(false);
    await expect(nodeRow(page, "tab:260")).toContainText("Tab 260 patched before search clear");
    expect(issues).toEqual([]);
  });

  test("psh-clear-search-after-initial-title-patch-keeps-initial-outline", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitTitlePatch("tab:2", "Tab 2 patched before search clear");
      await api.waitForIdleFrames(4);
    });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForIdleFrames(8);
      if (api.sparseRequestCount() > 0) {
        api.resolveSliceAt(0);
      }
      await api.waitForIdleFrames(4);
    });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      const search = document.querySelector<HTMLInputElement>("#search");
      if (!search) {
        throw new Error("Missing search input");
      }
      search.focus();
      search.value = "";
      search.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "deleteContentBackward",
        data: null
      }));
      await api.waitForIdleFrames(8);
      if (api.sparseRequestCount() > 1) {
        api.resolveSliceAt(0, { start: 1, end: 64 });
        await api.waitForIdleFrames(4);
      }
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: search.value,
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        tab2Text: document.querySelector("[data-node-id='tab:2']")?.textContent ?? "",
        hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900']")),
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests.every((request) => (
      (request.query === "Tab 900" || request.query === "") &&
      request.targetNodeId === undefined
    ))).toBe(true);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows.length).toBeGreaterThan(0);
    if (result.tab2Text) {
      expect(result.tab2Text).toContain("Tab 2 patched before search clear");
    }
    expect(result.hasSearchRow).toBe(false);
    expect(result.hasRevealHighlight).toBe(false);
    expect(issues).toEqual([]);
  });

  test("psh-active-outline-title-patch-full-broadcast-keeps-owner", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitTitlePatch("tab:800", "Tab 800 patched before full broadcast");
      await api.waitForIdleFrames(4);
      api.emitFullStateBroadcast();
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        tab800Text: document.querySelector("[data-node-id='tab:800']")?.textContent ?? "",
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows).toContain(800);
    expect(result.tab800Text).toContain("Tab 800 patched before full broadcast");
    expect(result.hasRevealHighlight).toBe(false);
    await expect(nodeRow(page, "tab:800")).toContainText("Tab 800 patched before full broadcast");
    expect(issues).toEqual([]);
  });

  test("psh-clear-search-after-active-refill-title-patch-keeps-active-window", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitTitlePatch("tab:800", "Tab 800 patched before active clear");
      await api.waitForIdleFrames(4);
      api.emitFullStateBroadcast();
      await api.waitForVisibleRow(800);
      await api.waitForIdleFrames(4);
    });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForIdleFrames(8);
      if (api.sparseRequestCount() > 0) {
        api.resolveSliceAt(0);
      }
      await api.waitForIdleFrames(4);
    });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      const search = document.querySelector<HTMLInputElement>("#search");
      if (!search) {
        throw new Error("Missing search input");
      }
      search.focus();
      search.value = "";
      search.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "deleteContentBackward",
        data: null
      }));
      await api.waitForIdleFrames(8);
      if (api.sparseRequestCount() > 1) {
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(4);
      }
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: search.value,
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        tab800Text: document.querySelector("[data-node-id='tab:800']")?.textContent ?? "",
        hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900']")),
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests.every((request) => (
      (request.query === "Tab 900" || request.query === "") &&
      request.targetNodeId === undefined
    ))).toBe(true);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows).toContain(800);
    expect(result.tab800Text).toContain("Tab 800 patched before active clear");
    expect(result.hasSearchRow).toBe(false);
    expect(result.hasRevealHighlight).toBe(false);
    await expect(nodeRow(page, "tab:800")).toContainText("Tab 800 patched before active clear");
    expect(issues).toEqual([]);
  });

  test("psh-two-sidebars-title-patch-clear-search-preserves-other-scroll", async ({ page }) => {
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
        await api.waitForIdleFrames(4);
      });

      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.scrollToRow(250);
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0, { start: 240, end: 310 });
        await api.waitForVisibleRow(260);
        api.emitTitlePatch("tab:260", "Tab 260 other sidebar patched");
        await api.waitForIdleFrames(4);
      });

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitTitlePatch("tab:900", "Tab 900 before sidebar A clear");
          await api.waitForIdleFrames(4);
          if (api.sparseRequestCount() > 1) {
            api.resolveSliceAt(0);
            await api.waitForIdleFrames(4);
          }
          const search = document.querySelector<HTMLInputElement>("#search");
          if (!search) {
            throw new Error("Missing search input");
          }
          search.focus();
          search.value = "";
          search.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "deleteContentBackward",
            data: null
          }));
          await api.waitForIdleFrames(8);
          if (api.sparseRequestCount() > 2) {
            api.resolveSliceAt(0, { start: 1, end: 64 });
            await api.waitForIdleFrames(4);
          }
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequestCount: api.stateRequestCount(),
            searchValue: search.value,
            countText: document.querySelector("#state-count")?.textContent ?? "",
            visibleRows: api.visibleRows(),
            hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900']")),
            hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          await api.waitForIdleFrames(8);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequestCount: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            visibleRows: api.visibleRows(),
            tab260Text: document.querySelector("[data-node-id='tab:260']")?.textContent ?? "",
            hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
          };
        })
      ]);

      expect(resultA.commands).toEqual([]);
      expect(resultA.requests.at(0)).toMatchObject({ query: "Tab 900", targetNodeId: undefined });
      expect(resultA.requests.slice(1).every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
      expect(resultA.stateRequestCount).toBe(0);
      expect(resultA.searchValue).toBe("");
      expect(resultA.countText).toBe("1001 items / 0 saved");
      expect(resultA.visibleRows).toContain(1);
      expect(resultA.hasSearchRow).toBe(false);
      expect(resultA.hasRevealHighlight).toBe(false);

      expect(resultB.commands).toEqual([]);
      expect(resultB.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
      expect(resultB.stateRequestCount).toBe(0);
      expect(resultB.searchValue).toBe("");
      expect(resultB.countText).toBe("1001 items / 0 saved");
      expect(resultB.visibleRows).toContain(250);
      expect(resultB.tab260Text).toContain("Tab 260 other sidebar patched");
      expect(resultB.hasRevealHighlight).toBe(false);
      await expect(nodeRow(pageB, "tab:260")).toContainText("Tab 260 other sidebar patched");
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-active-outline-history-status-full-broadcast-keeps-actions", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
    });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" });
      api.emitTitlePatch("tab:800", "Tab 800 active broadcast patched");
      api.emitFullStateBroadcast();
      await api.waitForIdleFrames(6);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        tab800Text: document.querySelector("[data-node-id='tab:800']")?.textContent ?? "",
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests).toEqual([]);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows).toContain(800);
    expect(result.tab800Text).toContain("Tab 800 active broadcast patched");
    expect(result.hasRevealHighlight).toBe(false);

    const row = nodeRow(page, "tab:800");
    await expect(row).toContainText("Tab 800 active broadcast patched");
    await row.hover();
    await expect(row.getByRole("button", { name: "Cut", exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Move to top level", exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-two-sidebars-active-broadcast-and-scroll-patch-stay-independent", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, { fullStatePending: true });

      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.scrollToRow(250);
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0, { start: 240, end: 310 });
        await api.waitForVisibleRow(260);
      });

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitTitlePatch("tab:800", "Tab 800 sidebar A broadcast patched");
          api.emitFullStateBroadcast();
          await api.waitForIdleFrames(6);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequestCount: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            visibleRows: api.visibleRows(),
            tab800Text: document.querySelector("[data-node-id='tab:800']")?.textContent ?? "",
            hasTab260: Boolean(document.querySelector("[data-node-id='tab:260']")),
            hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitHistoryStatus({ canUndo: true, canRedo: true, undoDepth: 2, redoDepth: 1, undoLabel: "scroll edit", redoLabel: "scroll edit" });
          api.emitTitlePatch("tab:260", "Tab 260 sidebar B scroll patched");
          await api.waitForIdleFrames(6);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequestCount: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            visibleRows: api.visibleRows(),
            tab260Text: document.querySelector("[data-node-id='tab:260']")?.textContent ?? "",
            hasTab800: Boolean(document.querySelector("[data-node-id='tab:800']")),
            hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
          };
        })
      ]);

      expect(resultA.commands).toEqual([]);
      expect(resultA.requests).toEqual([]);
      expect(resultA.stateRequestCount).toBe(0);
      expect(resultA.searchValue).toBe("");
      expect(resultA.countText).toBe("1001 items / 0 saved");
      expect(resultA.visibleRows).toContain(800);
      expect(resultA.tab800Text).toContain("Tab 800 sidebar A broadcast patched");
      expect(resultA.hasTab260).toBe(false);
      expect(resultA.hasRevealHighlight).toBe(false);

      expect(resultB.commands).toEqual([]);
      expect(resultB.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
      expect(resultB.stateRequestCount).toBe(0);
      expect(resultB.searchValue).toBe("");
      expect(resultB.countText).toBe("1001 items / 0 saved");
      expect(resultB.visibleRows).toContain(250);
      expect(resultB.tab260Text).toContain("Tab 260 sidebar B scroll patched");
      expect(resultB.hasTab800).toBe(false);
      expect(resultB.hasRevealHighlight).toBe(false);

      const activeRow = nodeRow(page, "tab:800");
      await activeRow.hover();
      await expect(activeRow.getByRole("button", { name: "Cut", exact: true })).toBeVisible();
      const scrollRow = nodeRow(pageB, "tab:260");
      await scrollRow.hover();
      await expect(scrollRow.getByRole("button", { name: "Cut", exact: true })).toBeVisible();
      await expect(pageB.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
      await expect(pageB.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-move-refill-search-ignores-stale-scroll-response", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.emitMovePatch("tab:260", "window:1", 899);
      await api.waitForIdleFrames(4);
    });

    await page.locator("#search").fill("Tab 900");

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(3);
      api.resolveSliceAt(2);
      await api.waitForIdleFrames(4);
      const afterCurrentSearch = {
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900']")),
        hasMovedOutlineRow: Boolean(document.querySelector("[data-node-id='tab:260']")),
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };

      api.resolveSliceAt(0, { start: 240, end: 310 });
      await api.waitForIdleFrames(4);
      api.resolveSliceAt(0, { start: 240, end: 310 });
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        afterCurrentSearch,
        finalSearchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        finalCountText: document.querySelector("#state-count")?.textContent ?? "",
        finalVisibleRows: api.visibleRows(),
        finalHasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900']")),
        finalHasMovedOutlineRow: Boolean(document.querySelector("[data-node-id='tab:260']")),
        finalHasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests.map((request) => ({
      query: request.query,
      targetNodeId: request.targetNodeId
    }))).toEqual([
      { query: "", targetNodeId: undefined },
      { query: "", targetNodeId: undefined },
      { query: "Tab 900", targetNodeId: undefined }
    ]);
    expect(result.stateRequestCount).toBe(0);
    expect(result.afterCurrentSearch.searchValue).toBe("Tab 900");
    expect(result.afterCurrentSearch.countText).toBe("1 match / 1001 items");
    expect(result.afterCurrentSearch.visibleRows).toContain(1);
    expect(result.afterCurrentSearch.hasSearchRow).toBe(true);
    expect(result.afterCurrentSearch.hasMovedOutlineRow).toBe(false);
    expect(result.afterCurrentSearch.hasRevealHighlight).toBe(false);
    expect(result.finalSearchValue).toBe("Tab 900");
    expect(result.finalCountText).toBe("1 match / 1001 items");
    expect(result.finalVisibleRows).toContain(1);
    expect(result.finalHasSearchRow).toBe(true);
    expect(result.finalHasMovedOutlineRow).toBe(false);
    expect(result.finalHasRevealHighlight).toBe(false);
    await expect(nodeRow(page, "tab:900")).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-show-in-tree-history-status-title-patch-keeps-reveal-actions", async ({ page }) => {
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

    const resultRow = nodeRow(page, "tab:900");
    await expect(resultRow).toBeVisible();
    await resultRow.hover();
    await resultRow.getByRole("button", { name: "Show in tree", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0);
      await api.waitForVisibleRow(900);
      api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" });
      api.emitTitlePatch("tab:900", "Tab 900 reveal history patched");
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
        tab900Text: document.querySelector("[data-node-id='tab:900']")?.textContent ?? "",
        hasRevealHighlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight"))
      };
    });

    expect(result.commands).toContainEqual({ type: "expandAncestors", nodeId: "tab:900" });
    expect(result.requests.map((request) => ({
      query: request.query,
      targetNodeId: request.targetNodeId
    }))).toEqual([
      { query: "Tab 900", targetNodeId: undefined },
      { query: "", targetNodeId: "tab:900" }
    ]);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(result.visibleRows).toContain(900);
    expect(result.tab900Text).toContain("Tab 900 reveal history patched");
    expect(result.hasRevealHighlight).toBe(true);

    const targetRow = nodeRow(page, "tab:900");
    await expect(targetRow).toContainText("Tab 900 reveal history patched");
    await targetRow.hover();
    await expect(targetRow.getByRole("button", { name: "Cut", exact: true })).toBeVisible();
    await expect(targetRow.getByRole("button", { name: "Move to top level", exact: true })).toBeVisible();
    await expect(targetRow.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-two-sidebars-delete-search-result-history-broadcast-keeps-owners", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote delete" }
    });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, {
        fullStatePending: true,
        historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote delete" }
      });

      await page.locator("#search").fill("Tab 900");
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
        api.resolveSliceAt(0, { start: 240, end: 310 });
        await api.waitForVisibleRow(260);
      });

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote delete" });
          api.emitDeletePatch(["tab:900"]);
          await api.waitForIdleFrames(4);
          if (api.sparseRequestCount() > 1) {
            api.resolveSliceAt(0);
            await api.waitForIdleFrames(4);
          }
          api.emitFullStateBroadcast();
          await api.waitForIdleFrames(4);
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
            hasDeletedMatch: Boolean(document.querySelector("[data-node-id='tab:900']")),
            hasOutlineRow: Boolean(document.querySelector("[data-node-id='tab:260']")),
            hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote delete" });
          api.emitDeletePatch(["tab:900"]);
          await api.waitForIdleFrames(4);
          if (api.sparseRequestCount() > 1) {
            api.resolveSliceAt(0, { start: 240, end: 310 });
            await api.waitForIdleFrames(4);
          }
          api.emitFullStateBroadcast();
          await api.waitForIdleFrames(4);
          if (api.sparseRequestCount() > 2) {
            api.resolveSliceAt(0, { start: 240, end: 310 });
            await api.waitForIdleFrames(4);
          }
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequestCount: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            visibleRows: api.visibleRows(),
            tab260Text: document.querySelector("[data-node-id='tab:260']")?.textContent ?? "",
            hasDeletedMatch: Boolean(document.querySelector("[data-node-id='tab:900']")),
            hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
          };
        })
      ]);

      expect(resultA.commands).toEqual([]);
      expect(resultA.requests.every((request) => request.query === "Tab 900" && request.targetNodeId === undefined)).toBe(true);
      expect(resultA.stateRequestCount).toBe(0);
      expect(resultA.searchValue).toBe("Tab 900");
      expect(resultA.countText).toMatch(/^0 matches \/ \d+ items$/);
      expect(resultA.visibleRows).toEqual([]);
      expect(resultA.hasDeletedMatch).toBe(false);
      expect(resultA.hasOutlineRow).toBe(false);
      expect(resultA.hasRevealHighlight).toBe(false);

      expect(resultB.commands).toEqual([]);
      expect(resultB.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
      expect(resultB.stateRequestCount).toBe(0);
      expect(resultB.searchValue).toBe("");
      expect(resultB.countText).toMatch(/^\d+ items \/ 0 saved$/);
      expect(resultB.visibleRows).toContain(250);
      expect(resultB.tab260Text).toContain("Tab 260");
      expect(resultB.hasDeletedMatch).toBe(false);
      expect(resultB.hasRevealHighlight).toBe(false);
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

  test("psh-show-in-tree-neighbor-delete-refill-keeps-target-actions", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
    });

    const resultRow = nodeRow(page, "tab:900");
    await expect(resultRow).toBeVisible();
    await resultRow.hover();
    await resultRow.getByRole("button", { name: "Show in tree", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0, { start: 880, end: 940 });
      await api.waitForVisibleRow(900);
      api.emitDeletePatch(["tab:899"]);
      await api.waitForIdleFrames(5);
      if (api.sparseRequestCount() > 2) {
        api.resolveSliceAt(0, { start: 880, end: 940 });
        await api.waitForIdleFrames(4);
      }
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequestCount: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasTarget: Boolean(document.querySelector("[data-node-id='tab:900']")),
        hasDeletedNeighbor: Boolean(document.querySelector("[data-node-id='tab:899']")),
        hasRevealHighlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight"))
      };
    });

    expect(result.commands).toContainEqual({ type: "expandAncestors", nodeId: "tab:900" });
    expect(result.requests.map((request) => ({
      query: request.query,
      targetNodeId: request.targetNodeId
    })).slice(0, 2)).toEqual([
      { query: "Tab 900", targetNodeId: undefined },
      { query: "", targetNodeId: "tab:900" }
    ]);
    expect(result.requests.slice(2).every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
    expect(result.stateRequestCount).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toMatch(/^\d+ items \/ 0 saved$/);
    expect(result.visibleRows).toContain(900);
    expect(result.hasTarget).toBe(true);
    expect(result.hasDeletedNeighbor).toBe(false);
    expect(result.hasRevealHighlight).toBe(true);

    const targetRow = nodeRow(page, "tab:900");
    await expect(targetRow).toBeVisible();
    await expect(page.locator(`${nodeSelector("tab:900")}.is-reveal-highlight`)).toBeVisible();
    await targetRow.hover();
    await expect(targetRow.getByRole("button", { name: "Cut", exact: true })).toBeVisible();
    await expect(targetRow.getByRole("button", { name: "Move to top level", exact: true })).toBeVisible();
    await expect(targetRow.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-paste-after-hydration-ignores-stale-scroll-refill", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await nodeRow(page, "tab:800").hover();
    await nodeRow(page, "tab:800").getByRole("button", { name: "Cut", exact: true }).click();
    await expect(page.locator(nodeSelector("tab:800"))).toHaveClass(/is-cut/);

    const prePaste = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveFullState();
      await api.waitForVisibleRow(250);
      api.resolveSliceAt(0, { start: 760, end: 840 });
      await api.waitForIdleFrames(4);
      await api.scrollToRow(800);
      await api.waitForVisibleRow(801);
      return {
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows(),
        cutMarkers: document.querySelectorAll(".is-cut").length
      };
    });

    await nodeRow(page, "tab:801").hover();
    await nodeRow(page, "tab:801").getByRole("button", { name: "Paste", exact: true }).click();

    expect(prePaste.requests).toHaveLength(1);
    expect(prePaste.stateRequests).toBe(1);
    expect(prePaste.visibleRows).toContain(801);
    expect(prePaste.cutMarkers).toBe(1);
    await expect(sentCommands(page)).resolves.toEqual([
      { type: "moveNode", nodeId: "tab:800", parentId: "window:1", index: 800 }
    ]);
    await expect(page.locator(nodeSelector("tab:800"))).not.toHaveClass(/is-cut/);
    expect(issues).toEqual([]);
  });

  test("psh-move-to-root-stale-refill-keeps-current-window-actions", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { fullStatePending: true });

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { start: 240, end: 310 });
      await api.waitForVisibleRow(250);
    });

    await nodeRow(page, "tab:250").hover();
    await nodeRow(page, "tab:250").getByRole("button", { name: "Move to top level", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(500);
      await api.waitForSparseRequestCount(2);
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "move to root" });
      api.resolveSliceAt(0, { start: 240, end: 310 });
      await api.waitForSparseRequestCount(3);
      api.resolveSliceAt(0, { start: 480, end: 540 });
      await api.waitForVisibleRow(500);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows()
      };
    });

    expect(result.commands).toEqual([{ type: "moveSubtreeToTopLevel", nodeId: "tab:250" }]);
    expect(result.requests).toHaveLength(3);
    expect(result.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toContain(500);
    await expect(nodeRow(page, "tab:500")).toBeVisible();
    await nodeRow(page, "tab:500").hover();
    await expect(nodeRow(page, "tab:500").getByRole("button", { name: "Move to top level", exact: true })).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-confirmed-restore-delete-patch-removes-closed-shell", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadClosedRestoreSidebar(page, { fullStatePending: true });

    page.on("dialog", async (dialog) => {
      expect(dialog.message()).toContain("Restore 4 restorable closed nodes");
      await dialog.accept();
    });
    await nodeRow(page, "window:30").getByRole("button", { name: "Restore Closed Window", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitDeletePatch(["window:30", "tab:30", "tab:31", "tab:32"]);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows(),
        closedWindowExists: Boolean(document.querySelector("[data-node-id='window:30']")),
        closedTabExists: Boolean(document.querySelector("[data-node-id='tab:30']"))
      };
    });

    expect(result.commands).toEqual([
      { type: "analyzeRestoreScope", nodeId: "window:30" },
      { type: "restoreNode", nodeId: "window:30", confirmedLargeRestore: true }
    ]);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toEqual([]);
    expect(result.closedWindowExists).toBe(false);
    expect(result.closedTabExists).toBe(false);
    expect(issues).toEqual([]);
  });

  test("psh-invalid-restore-scope-history-update-keeps-restore-local", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadClosedRestoreSidebar(page, { fullStatePending: true, invalidRestoreScope: true });

    await nodeRow(page, "window:30").getByRole("button", { name: "Restore Closed Window", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "background restore" });
      await api.waitForIdleFrames(3);
      return {
        commands: api.sentCommands(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows()
      };
    });

    expect(result.commands).toEqual([{ type: "analyzeRestoreScope", nodeId: "window:30" }]);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toContain(0);
    await expect(nodeRow(page, "window:30").getByRole("button", { name: "Restore Closed Window", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-closed-restore-search-clear-keeps-local-restore-actions", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadClosedRestoreSidebar(page, { fullStatePending: true, invalidRestoreScope: true });

    await nodeRow(page, "window:30").getByRole("button", { name: "Restore Closed Window", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);
    await page.locator("#search").fill("Closed tab 30");
    await expect(nodeRow(page, "tab:30")).toBeVisible();
    await page.locator("#clear-search").click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "restore check" });
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        closedWindowExists: Boolean(document.querySelector("[data-node-id='window:30']")),
        closedTabExists: Boolean(document.querySelector("[data-node-id='tab:30']")),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([{ type: "analyzeRestoreScope", nodeId: "window:30" }]);
    expect(result.requests).toEqual([expect.objectContaining({ query: "", targetNodeId: undefined })]);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.visibleRows).toContain(0);
    expect(result.closedWindowExists).toBe(true);
    expect(result.closedTabExists).toBe(true);
    expect(result.countText).toBe("4 items / 4 saved");
    await expect(nodeRow(page, "window:30").getByRole("button", { name: "Restore Closed Window", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-closed-search-clear-stale-query-keeps-restore-actions", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadClosedRestoreSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Closed tab 31");
    await page.evaluate(async () => {
      await projectionHuntApi().waitForProjectionRequest("Closed tab 31");
    });
    await page.locator("#clear-search").click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForProjectionRequest("");
      api.resolveSliceForQuery("Closed tab 31");
      await api.waitForIdleFrames(2);
      api.resolveSliceForQuery("");
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        closedWindowExists: Boolean(document.querySelector("[data-node-id='window:30']")),
        closedTab30Exists: Boolean(document.querySelector("[data-node-id='tab:30']")),
        staleClosedTabExists: Boolean(document.querySelector("[data-node-id='tab:31']")),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests[0]).toMatchObject({ query: "Closed tab 31", targetNodeId: undefined });
    expect(result.requests.slice(1).every((request) => request.query === "" && request.targetNodeId === undefined))
      .toBe(true);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.visibleRows).toContain(0);
    expect(result.closedWindowExists).toBe(true);
    expect(result.closedTab30Exists).toBe(true);
    expect(result.staleClosedTabExists).toBe(false);
    expect(result.countText).toBe("4 items / 4 saved");
    await expect(nodeRow(page, "window:30").getByRole("button", { name: "Restore Closed Window", exact: true })).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-closed-tab-query-replacement-last-restore-target-wins", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadClosedRestoreSidebar(page, { fullStatePending: true });

    await page.locator("#search").fill("Closed tab 30");
    await page.evaluate(async () => {
      await projectionHuntApi().waitForProjectionRequest("Closed tab 30");
    });
    await page.locator("#search").fill("Closed tab 31");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForProjectionRequest("Closed tab 31");
      api.resolveSliceForQuery("Closed tab 30");
      await api.waitForIdleFrames(2);
      api.resolveSliceForQuery("Closed tab 31");
      await api.waitForVisibleRow(1);
      await api.waitForIdleFrames(4);
    });

    await expect(page.locator(nodeSelector("tab:30"))).toHaveCount(0);
    await expect(nodeRow(page, "tab:31")).toBeVisible();
    await nodeRow(page, "tab:31").getByRole("button", { name: /Restore Closed tab 31/ }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForIdleFrames(2);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        hasLatestTarget: Boolean(document.querySelector("[data-node-id='tab:31']")),
        hasStaleTarget: Boolean(document.querySelector("[data-node-id='tab:30']"))
      };
    });

    expect(result.commands).toEqual([{ type: "restoreNode", nodeId: "tab:31" }]);
    expect(result.requests[0]).toMatchObject({ query: "Closed tab 30", targetNodeId: undefined });
    expect(result.requests[1]).toMatchObject({ query: "Closed tab 31", targetNodeId: undefined });
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("Closed tab 31");
    expect(result.visibleRows).toContain(1);
    expect(result.hasLatestTarget).toBe(true);
    expect(result.hasStaleTarget).toBe(false);
    expect(issues).toEqual([]);
  });

  test("psh-closed-child-restore-keeps-parent-preflight", async ({ page }) => {
    const issues = collectPageIssues(page);
    const dialogMessages: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogMessages.push(dialog.message());
      await dialog.dismiss();
    });
    await loadClosedRestoreSidebar(page, { fullStatePending: true, delayRestoreScope: true });

    await nodeRow(page, "window:30").getByRole("button", { name: "Restore Closed Window", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);
    await page.locator("#search").fill("Closed tab 31");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForProjectionRequest("Closed tab 31");
      api.resolveSliceForQuery("Closed tab 31");
      await api.waitForVisibleRow(1);
    });
    await nodeRow(page, "tab:31").getByRole("button", { name: /Restore Closed tab 31/ }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 2);

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "restore closed child" });
      api.emitDeletePatch(["tab:31"]);
      api.resolveRestoreScope();
      await api.waitForIdleFrames(8);
    });
    await page.locator("#clear-search").click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForProjectionRequest("");
      api.resolveSliceForQuery("");
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        closedWindowExists: Boolean(document.querySelector("[data-node-id='window:30']")),
        closedTab30Exists: Boolean(document.querySelector("[data-node-id='tab:30']")),
        restoredChildExists: Boolean(document.querySelector("[data-node-id='tab:31']")),
        undoEnabled: !document.querySelector<HTMLButtonElement>("#undo")?.disabled
      };
    });

    expect(result.commands).toEqual([
      { type: "analyzeRestoreScope", nodeId: "window:30" },
      { type: "restoreNode", nodeId: "tab:31" }
    ]);
    expect(result.requests.slice(0, -1).every((request) => (
      request.query === "Closed tab 31" && request.targetNodeId === undefined
    ))).toBe(true);
    expect(result.requests.at(-1)).toMatchObject({ query: "", targetNodeId: undefined });
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.visibleRows).toContain(0);
    expect(result.closedWindowExists).toBe(true);
    expect(result.closedTab30Exists).toBe(true);
    expect(result.restoredChildExists).toBe(false);
    expect(result.undoEnabled).toBe(true);
    expect(dialogMessages).toEqual([]);
    await expect(nodeRow(page, "window:30").getByRole("button", { name: "Restore Closed Window", exact: true })).toBeVisible();
    expect(issues).toEqual([]);
  });

  test("psh-restore-scope-response-after-delete-does-not-prompt-stale-restore", async ({ page }) => {
    const issues = collectPageIssues(page);
    const dialogMessages: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogMessages.push(dialog.message());
      await dialog.dismiss();
    });
    await loadClosedRestoreSidebar(page, { fullStatePending: true, delayRestoreScope: true });

    await nodeRow(page, "window:30").getByRole("button", { name: "Restore Closed Window", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "delete closed window" });
      api.emitDeletePatch(["window:30", "tab:30", "tab:31", "tab:32"]);
      api.resolveRestoreScope();
      await api.waitForIdleFrames(8);
      return {
        commands: api.sentCommands(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows(),
        closedWindowExists: Boolean(document.querySelector("[data-node-id='window:30']")),
        closedTabExists: Boolean(document.querySelector("[data-node-id='tab:30']")),
        undoEnabled: !document.querySelector<HTMLButtonElement>("#undo")?.disabled
      };
    });

    expect(result.commands).toEqual([{ type: "analyzeRestoreScope", nodeId: "window:30" }]);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toEqual([]);
    expect(result.closedWindowExists).toBe(false);
    expect(result.closedTabExists).toBe(false);
    expect(result.undoEnabled).toBe(true);
    expect(dialogMessages).toEqual([]);
    expect(issues).toEqual([]);
  });

  test("psh-delayed-restore-scope-child-delete-invalidates-prompt", async ({ page }) => {
    const issues = collectPageIssues(page);
    const dialogMessages: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogMessages.push(dialog.message());
      await dialog.dismiss();
    });
    await loadClosedRestoreSidebar(page, { fullStatePending: true, delayRestoreScope: true });

    await nodeRow(page, "window:30").getByRole("button", { name: "Restore Closed Window", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "delete closed tab" });
      api.emitDeletePatch(["tab:30"]);
      api.resolveRestoreScope();
      await api.waitForIdleFrames(8);
      return {
        commands: api.sentCommands(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows(),
        closedWindowExists: Boolean(document.querySelector("[data-node-id='window:30']")),
        deletedClosedTabExists: Boolean(document.querySelector("[data-node-id='tab:30']")),
        undoEnabled: !document.querySelector<HTMLButtonElement>("#undo")?.disabled,
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([{ type: "analyzeRestoreScope", nodeId: "window:30" }]);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toContain(0);
    expect(result.closedWindowExists).toBe(true);
    expect(result.deletedClosedTabExists).toBe(false);
    expect(result.undoEnabled).toBe(true);
    expect(result.countText).toBe("3 items / 3 saved");
    expect(dialogMessages).toEqual([]);
    expect(issues).toEqual([]);
  });

  test("psh-restored-delete-neighbor-title-patch-before-tree-patch-keeps-live-actions", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadRestoredWindowSidebar(page, { fullStatePending: true });

    await nodeRow(page, "tab:2").hover();
    await nodeRow(page, "tab:2").getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitTitlePatch("tab:1", "Existing tab patched before restored delete");
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "delete restored tab" });
      api.emitDeletePatch(["tab:2", "window:20"]);
      await api.waitForIdleFrames(5);
      return {
        commands: api.sentCommands(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows(),
        restoredTabExists: Boolean(document.querySelector("[data-node-id='tab:2']")),
        restoredWindowExists: Boolean(document.querySelector("[data-node-id='window:20']")),
        liveTabText: document.querySelector("[data-node-id='tab:1']")?.textContent ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([{ type: "deleteNode", nodeId: "tab:2" }]);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toContain(1);
    expect(result.restoredTabExists).toBe(false);
    expect(result.restoredWindowExists).toBe(false);
    expect(result.liveTabText).toContain("Existing tab patched before restored delete");
    expect(result.countText).toBe("2 items / 0 saved");
    await expect(nodeRow(page, "tab:1")).toBeVisible();
    await expect(nodeRow(page, "tab:1")).toContainText("Existing tab patched before restored delete");
    await nodeRow(page, "tab:1").hover();
    await expect(nodeRow(page, "tab:1").getByRole("button", { name: "Close", exact: true })).toBeVisible();
    await expect(nodeRow(page, "tab:1").getByRole("button", { name: "Cut", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-restored-delete-command-search-replacement-keeps-query-owner", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadRestoredWindowSidebar(page, { fullStatePending: true });

    await nodeRow(page, "tab:2").hover();
    await nodeRow(page, "tab:2").getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);
    await page.locator("#search").fill("Existing");

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "delete restored tab" });
      api.emitDeletePatch(["tab:2", "window:20"]);
      await api.waitForVisibleRow(1);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        restoredTabExists: Boolean(document.querySelector("[data-node-id='tab:2']")),
        liveTabExists: Boolean(document.querySelector("[data-node-id='tab:1']")),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([{ type: "deleteNode", nodeId: "tab:2" }]);
    expect(result.requests).toEqual([]);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("Existing");
    expect(result.visibleRows).toContain(1);
    expect(result.restoredTabExists).toBe(false);
    expect(result.liveTabExists).toBe(true);
    expect(result.countText).toBe("2 matches / 2 items");
    await expect(nodeRow(page, "tab:1")).toBeVisible();
    await expect(nodeRow(page, "tab:1")).toContainText("Existing tab");
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-drag-preview-search-replacement-clears-preview-without-command", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    try {
      await nodeRow(page, "tab:800").dispatchEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer
      });
      const clientY = await nodeRow(page, "tab:801").evaluate((row) => row.getBoundingClientRect().bottom - 1);
      await nodeRow(page, "tab:801").dispatchEvent("dragover", {
        bubbles: true,
        cancelable: true,
        clientY,
        dataTransfer
      });
      await expect(page.locator("[data-testid='drop-marker']")).toHaveClass(/drop-after/);

      await page.locator("#search").fill("Tab 900");
      await nodeRow(page, "tab:800").dispatchEvent("dragend", {
        bubbles: true,
        cancelable: true,
        dataTransfer
      });
    } finally {
      await dataTransfer.dispose();
    }

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForVisibleRow(1);
      await api.waitForIdleFrames(4);
      const marker = document.querySelector<HTMLElement>("[data-testid='drop-marker']");
      const root = document.querySelector<HTMLElement>("main");
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        markerClassName: marker?.className ?? "",
        rootDropTarget: root?.classList.contains("root-drop-target") ?? false,
        hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900']"))
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests).toEqual([expect.objectContaining({ query: "Tab 900", targetNodeId: undefined })]);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("Tab 900");
    expect(result.visibleRows).toContain(1);
    expect(result.markerClassName).not.toMatch(/drop-root|drop-before|drop-after|drop-inside/);
    expect(result.rootDropTarget).toBe(false);
    expect(result.hasSearchRow).toBe(true);
    expect(issues).toEqual([]);
  });

  test("psh-drag-preview-keyboard-undo-search-replacement-clears-preview", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
    });

    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    try {
      await nodeRow(page, "tab:800").dispatchEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer
      });
      const clientY = await nodeRow(page, "tab:801").evaluate((row) => row.getBoundingClientRect().bottom - 1);
      await nodeRow(page, "tab:801").dispatchEvent("dragover", {
        bubbles: true,
        cancelable: true,
        clientY,
        dataTransfer
      });
      await expect(page.locator("[data-testid='drop-marker']")).toHaveClass(/drop-after/);

      await page.keyboard.press("Control+Z");
      await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);
      await page.locator("#search").fill("Tab 900");
      await nodeRow(page, "tab:800").dispatchEvent("dragend", {
        bubbles: true,
        cancelable: true,
        dataTransfer
      });
    } finally {
      await dataTransfer.dispose();
    }

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" });
      await api.waitForProjectionRequest("Tab 900");
      api.resolveSliceForQuery("Tab 900");
      await api.waitForVisibleRow(1);
      await api.waitForIdleFrames(4);
      const marker = document.querySelector<HTMLElement>("[data-testid='drop-marker']");
      const root = document.querySelector<HTMLElement>("main");
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        markerClassName: marker?.className ?? "",
        rootDropTarget: root?.classList.contains("root-drop-target") ?? false,
        hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900']"))
      };
    });

    expect(result.commands).toEqual([{ type: "undo" }]);
    expect(result.requests).toEqual([expect.objectContaining({ query: "Tab 900", targetNodeId: undefined })]);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("Tab 900");
    expect(result.visibleRows).toContain(1);
    expect(result.markerClassName).not.toMatch(/drop-root|drop-before|drop-after|drop-inside/);
    expect(result.rootDropTarget).toBe(false);
    expect(result.hasSearchRow).toBe(true);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-drag-refill-target-owner-stale-response-keeps-target", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: false, fullStatePending: true });

    await dragAfter(page, "tab:800", "tab:839");
    await page.evaluate(async () => {
      await projectionHuntApi().waitForSparseRequestCount(1);
    });
    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForProjectionRequest("Tab 900");
      api.resolveSliceForQuery("Tab 900");
      await api.waitForVisibleRow(1);
    });
    await nodeRow(page, "tab:900").hover();
    await nodeRow(page, "tab:900").getByRole("button", { name: "Show in tree", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForTargetProjectionRequest("tab:900");
      api.emitMovePatch("tab:801", "window:1", 800);
      api.resolveSliceAt(0, { start: 780, end: 840, includeCoverage: true });
      await api.waitForIdleFrames(3);
      api.resolveSliceForTarget("tab:900");
      await api.waitForVisibleRow(900);
      await api.waitForIdleFrames(4);
      const marker = document.querySelector<HTMLElement>("[data-testid='drop-marker']");
      const root = document.querySelector<HTMLElement>("main");
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        hasTarget: Boolean(document.querySelector("[data-node-id='tab:900']")),
        hasTargetHighlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight")),
        markerClassName: marker?.className ?? "",
        rootDropTarget: root?.classList.contains("root-drop-target") ?? false
      };
    });

    expect(result.commands).toEqual([{ type: "expandAncestors", nodeId: "tab:900" }]);
    expect(result.requests).toContainEqual(expect.objectContaining({ query: "", targetNodeId: undefined }));
    expect(result.requests).toContainEqual(expect.objectContaining({ query: "Tab 900", targetNodeId: undefined }));
    expect(result.requests).toContainEqual(expect.objectContaining({ query: "", targetNodeId: "tab:900" }));
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.visibleRows).toContain(900);
    expect(result.hasTarget).toBe(true);
    expect(result.hasTargetHighlight).toBe(true);
    expect(result.markerClassName).not.toMatch(/drop-root|drop-before|drop-after|drop-inside/);
    expect(result.rootDropTarget).toBe(false);
    expect(issues).toEqual([]);
  });

  test("psh-keyboard-cut-query-replacement-undo-keeps-current-search", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" }
    });

    await nodeRow(page, "tab:800").locator(".node-label").focus();
    await page.keyboard.press("Control+X");
    await expect(page.locator(nodeSelector("tab:800"))).toHaveClass(/is-cut/);
    await page.locator("#search").fill("Tab 90");
    await page.evaluate(async () => {
      await projectionHuntApi().waitForProjectionRequest("Tab 90");
    });
    await page.locator("#search").fill("Tab 91");
    await page.evaluate(async () => {
      await projectionHuntApi().waitForProjectionRequest("Tab 91");
    });
    await nodeRow(page, "tab:800").locator(".node-label").focus();
    await page.keyboard.press("Control+Z");
    await page.waitForFunction(() => projectionHuntApi().sentCommands().some((command) => (
      typeof command === "object" && command !== null && (command as { type?: unknown }).type === "undo"
    )));

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" });
      api.resolveSliceForQuery("Tab 90");
      await api.waitForIdleFrames(2);
      api.resolveSliceForQuery("Tab 91");
      await api.waitForVisibleRow(1);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        cutMarkers: document.querySelectorAll(".is-cut").length,
        hasTab91: Boolean(document.querySelector("[data-node-id='tab:91']")),
        hasTab90: Boolean(document.querySelector("[data-node-id='tab:90']")),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([{ type: "undo" }]);
    expect(result.requests).toEqual([
      expect.objectContaining({ query: "Tab 90", targetNodeId: undefined }),
      expect.objectContaining({ query: "Tab 91", targetNodeId: undefined })
    ]);
    expect(result.stateRequests).toBe(1);
    expect(result.searchValue).toBe("Tab 91");
    expect(result.visibleRows).toContain(1);
    expect(result.cutMarkers).toBe(0);
    expect(result.hasTab91).toBe(true);
    expect(result.hasTab90).toBe(false);
    expect(result.countText).toBe("11 matches / 1001 items");
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-rename-blur-search-replacement-keeps-query-owner", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    const row = nodeRow(page, "window:1");
    await row.hover();
    await row.getByRole("button", { name: "Rename", exact: true }).click();
    const input = row.getByRole("textbox", { name: "Rename Window", exact: true });
    await expect(input).toBeVisible();
    await input.fill("Renamed during search replacement");

    await page.locator("#search").fill("Tab 900");
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      if (api.projectionRequests()[0]?.query !== "Tab 900") {
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(2);
      }
      await api.waitForProjectionRequest("Tab 900");
      api.resolveSliceForQuery("Tab 900");
      await api.waitForVisibleRow(1);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        renameInputs: document.querySelectorAll(".node-rename-input").length,
        hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900']")),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([
      { type: "renameGroup", nodeId: "window:1", title: "Renamed during search replacement" }
    ]);
    expect(result.requests).toContainEqual(expect.objectContaining({ query: "Tab 900", targetNodeId: undefined }));
    expect(result.requests.at(-1)).toMatchObject({ query: "Tab 900", targetNodeId: undefined });
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("Tab 900");
    expect(result.visibleRows).toContain(1);
    expect(result.renameInputs).toBe(0);
    expect(result.hasSearchRow).toBe(true);
    expect(result.countText).toBe("1 match / 1001 items");
    expect(issues).toEqual([]);
  });

  test("psh-cut-search-clear-hydration-paste-keeps-current-outline", async ({ page }) => {
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
      await api.waitForVisibleRow(1);
    });

    await page.locator("#clear-search").click();
    const beforePaste = await page.evaluate(async () => {
      const api = projectionHuntApi();
      const previousRequestCount = api.sparseRequestCount();
      for (let frame = 0; frame < 120; frame += 1) {
        if (api.sparseRequestCount() > previousRequestCount || api.visibleRows().includes(800)) {
          break;
        }
        await api.nextFrame();
      }
      if (api.sparseRequestCount() > previousRequestCount) {
        api.resolveSliceAt(0, { start: 760, end: 840 });
      }
      api.resolveFullState();
      await api.waitForVisibleRow(801);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        cutMarkers: document.querySelectorAll(".is-cut").length,
        hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900']"))
      };
    });

    await nodeRow(page, "tab:801").hover();
    await nodeRow(page, "tab:801").getByRole("button", { name: "Paste", exact: true }).click();

    expect(beforePaste.commands).toEqual([]);
    expect(beforePaste.requests[0]).toEqual(expect.objectContaining({ query: "Tab 900", targetNodeId: undefined }));
    expect(beforePaste.requests.slice(1).every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
    expect(beforePaste.stateRequests).toBe(1);
    expect(beforePaste.searchValue).toBe("");
    expect(beforePaste.visibleRows).toContain(801);
    expect(beforePaste.cutMarkers).toBe(1);
    expect(beforePaste.hasSearchRow).toBe(false);
    await expect(sentCommands(page)).resolves.toEqual([
      { type: "moveNode", nodeId: "tab:800", parentId: "window:1", index: 800 }
    ]);
    await expect(page.locator(nodeSelector("tab:800"))).not.toHaveClass(/is-cut/);
    expect(issues).toEqual([]);
  });

  test("psh-two-sidebars-paste-and-target-reveal-stay-independent", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, { includeCoverage: true, fullStatePending: true });
      await pageB.locator("#search").fill("Tab 900");
      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0);
        await api.waitForVisibleRow(1);
      });
      await nodeRow(pageB, "tab:900").hover();
      await nodeRow(pageB, "tab:900").getByRole("button", { name: "Show in tree", exact: true }).click();
      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForSparseRequestCount(2);
        api.resolveSliceAt(0, { start: 880, end: 940 });
        await api.waitForVisibleRow(900);
      });

      await nodeRow(page, "tab:800").hover();
      await nodeRow(page, "tab:800").getByRole("button", { name: "Cut", exact: true }).click();
      await page.evaluate(async () => {
        const api = projectionHuntApi();
        api.resolveFullState();
        await api.waitForIdleFrames(6);
      });
      await nodeRow(page, "tab:801").hover();
      await nodeRow(page, "tab:801").getByRole("button", { name: "Paste", exact: true }).click();
      await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitMovePatch("tab:800", "window:1", 800);
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows(),
            cutMarkers: document.querySelectorAll(".is-cut").length
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitMovePatch("tab:800", "window:1", 800);
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows(),
            hasRevealHighlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight")),
            hasTarget: Boolean(document.querySelector("[data-node-id='tab:900']"))
          };
        })
      ]);

      expect(resultA.commands).toEqual([
        { type: "moveNode", nodeId: "tab:800", parentId: "window:1", index: 800 }
      ]);
      expect(resultA.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
      expect(resultA.stateRequests).toBe(1);
      expect(resultA.searchValue).toBe("");
      expect(resultA.visibleRows).toContain(800);
      expect(resultA.cutMarkers).toBe(0);

      expect(resultB.commands).toContainEqual({ type: "expandAncestors", nodeId: "tab:900" });
      expect(resultB.requests.map((request) => ({
        query: request.query,
        targetNodeId: request.targetNodeId
      })).slice(0, 2)).toEqual([
        { query: "Tab 900", targetNodeId: undefined },
        { query: "", targetNodeId: "tab:900" }
      ]);
      expect(resultB.stateRequests).toBe(0);
      expect(resultB.searchValue).toBe("");
      expect(resultB.visibleRows).toContain(900);
      expect(resultB.hasRevealHighlight).toBe(true);
      expect(resultB.hasTarget).toBe(true);
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-two-sidebars-keyboard-undo-and-target-stale-scroll-stay-independent", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "sidebar A edit" }
    });

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
    });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, {
        includeCoverage: true,
        fullStatePending: true,
        historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "sidebar B edit" }
      });
      await pageB.locator("#search").fill("Tab 900");
      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForProjectionRequest("Tab 900");
        api.resolveSliceForQuery("Tab 900");
        await api.waitForVisibleRow(1);
      });
      await nodeRow(pageB, "tab:900").hover();
      await nodeRow(pageB, "tab:900").getByRole("button", { name: "Show in tree", exact: true }).click();
      await pageB.waitForFunction(() => projectionHuntApi().projectionRequests().some((request) => request.targetNodeId === "tab:900"));

      await page.keyboard.press("Control+Z");
      await page.waitForFunction(() => projectionHuntApi().sentCommands().some((command) => (
        typeof command === "object" && command !== null && (command as { type?: unknown }).type === "undo"
      )));

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "sidebar A edit" });
          api.emitTitlePatch("tab:250", "Tab 250 stale scroll patched");
          api.resolveSliceAt(0, { start: 240, end: 310 });
          await api.waitForVisibleRow(250);
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows(),
            rowText: document.querySelector("[data-node-id='tab:250']")?.textContent ?? ""
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "sidebar B edit" });
          api.emitTitlePatch("tab:900", "Tab 900 target temporal patched");
          api.resolveSliceForTarget("tab:900", { start: 880, end: 940 });
          await api.waitForVisibleRow(900);
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows(),
            hasTargetHighlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight")),
            targetText: document.querySelector("[data-node-id='tab:900']")?.textContent ?? ""
          };
        })
      ]);

      expect(resultA.commands).toEqual([{ type: "undo" }]);
      expect(resultA.requests).toEqual([expect.objectContaining({ query: "", targetNodeId: undefined })]);
      expect(resultA.stateRequests).toBe(0);
      expect(resultA.searchValue).toBe("");
      expect(resultA.visibleRows).toContain(250);
      expect(resultA.rowText).toContain("Tab 250 stale scroll patched");
      await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();

      expect(resultB.commands).toEqual([{ type: "expandAncestors", nodeId: "tab:900" }]);
      expect(resultB.requests).toContainEqual(expect.objectContaining({ query: "Tab 900", targetNodeId: undefined }));
      expect(resultB.requests).toContainEqual(expect.objectContaining({ query: "", targetNodeId: "tab:900" }));
      expect(resultB.stateRequests).toBe(0);
      expect(resultB.searchValue).toBe("");
      expect(resultB.visibleRows).toContain(900);
      expect(resultB.hasTargetHighlight).toBe(true);
      expect(resultB.targetText).toContain("Tab 900 target temporal patched");
      await expect(pageB.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
      await expect(pageB.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-two-sidebars-keyboard-undo-and-target-history-only-stay-independent", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "sidebar A edit" }
    });

    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.scrollToRow(250);
      await api.waitForSparseRequestCount(1);
    });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, {
        includeCoverage: true,
        fullStatePending: true,
        historyStatus: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "sidebar B edit" }
      });
      await pageB.locator("#search").fill("Tab 900");
      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForProjectionRequest("Tab 900");
        api.resolveSliceForQuery("Tab 900");
        await api.waitForVisibleRow(1);
      });
      await nodeRow(pageB, "tab:900").hover();
      await nodeRow(pageB, "tab:900").getByRole("button", { name: "Show in tree", exact: true }).click();
      await pageB.waitForFunction(() => projectionHuntApi().projectionRequests().some((request) => request.targetNodeId === "tab:900"));

      await page.keyboard.press("Control+Z");
      await page.waitForFunction(() => projectionHuntApi().sentCommands().some((command) => (
        typeof command === "object" && command !== null && (command as { type?: unknown }).type === "undo"
      )));

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "sidebar A edit" });
          api.resolveSliceAt(0, { start: 240, end: 310 });
          await api.waitForVisibleRow(250);
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows()
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitHistoryStatus({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "sidebar B edit" });
          api.resolveSliceForTarget("tab:900", { start: 880, end: 940 });
          await api.waitForVisibleRow(900);
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows(),
            hasTargetHighlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight")),
            hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900'].is-search-match"))
          };
        })
      ]);

      expect(resultA.commands).toEqual([{ type: "undo" }]);
      expect(resultA.requests).toEqual([expect.objectContaining({ query: "", targetNodeId: undefined })]);
      expect(resultA.stateRequests).toBe(0);
      expect(resultA.searchValue).toBe("");
      expect(resultA.visibleRows).toContain(250);
      await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();

      expect(resultB.commands).toEqual([{ type: "expandAncestors", nodeId: "tab:900" }]);
      expect(resultB.requests).toContainEqual(expect.objectContaining({ query: "Tab 900", targetNodeId: undefined }));
      expect(resultB.requests).toContainEqual(expect.objectContaining({ query: "", targetNodeId: "tab:900" }));
      expect(resultB.stateRequests).toBe(0);
      expect(resultB.searchValue).toBe("");
      expect(resultB.visibleRows).toContain(900);
      expect(resultB.hasTargetHighlight).toBe(true);
      expect(resultB.hasSearchRow).toBe(false);
      await expect(pageB.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
      await expect(pageB.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-rename-escape-search-replacement-keeps-query-owner", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    const row = nodeRow(page, "window:1");
    await row.hover();
    await row.getByRole("button", { name: "Rename", exact: true }).click();
    const input = row.getByRole("textbox", { name: "Rename Window", exact: true });
    await expect(input).toBeVisible();
    await input.fill("Canceled rename before search");
    await input.press("Escape");
    await expect(input).toHaveCount(0);

    await page.locator("#search").fill("Tab 900");
    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      if (api.projectionRequests()[0]?.query !== "Tab 900") {
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(2);
      }
      await api.waitForProjectionRequest("Tab 900");
      api.resolveSliceForQuery("Tab 900");
      await api.waitForVisibleRow(1);
      await api.waitForIdleFrames(3);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        renameInputs: document.querySelectorAll(".node-rename-input").length,
        hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900']")),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests).toContainEqual(expect.objectContaining({ query: "Tab 900", targetNodeId: undefined }));
    expect(result.requests.at(-1)).toMatchObject({ query: "Tab 900", targetNodeId: undefined });
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("Tab 900");
    expect(result.visibleRows).toContain(1);
    expect(result.renameInputs).toBe(0);
    expect(result.hasSearchRow).toBe(true);
    expect(result.countText).toBe("1 match / 1001 items");
    expect(issues).toEqual([]);
  });

  test("psh-rename-enter-then-search-keeps-query-owner", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    const row = nodeRow(page, "window:1");
    await row.hover();
    await row.getByRole("button", { name: "Rename", exact: true }).click();
    const input = row.getByRole("textbox", { name: "Rename Window", exact: true });
    await expect(input).toBeVisible();
    await input.fill("Committed before search");
    await input.press("Enter");
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    await page.locator("#search").fill("Tab 900");
    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      if (api.projectionRequests()[0]?.query !== "Tab 900") {
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(2);
      }
      await api.waitForProjectionRequest("Tab 900");
      api.resolveSliceForQuery("Tab 900");
      await api.waitForVisibleRow(1);
      await api.waitForIdleFrames(3);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        renameInputs: document.querySelectorAll(".node-rename-input").length,
        hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900']")),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([
      { type: "renameGroup", nodeId: "window:1", title: "Committed before search" }
    ]);
    expect(result.requests).toContainEqual(expect.objectContaining({ query: "Tab 900", targetNodeId: undefined }));
    expect(result.requests.at(-1)).toMatchObject({ query: "Tab 900", targetNodeId: undefined });
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("Tab 900");
    expect(result.visibleRows).toContain(1);
    expect(result.renameInputs).toBe(0);
    expect(result.hasSearchRow).toBe(true);
    expect(result.countText).toBe("1 match / 1001 items");
    expect(issues).toEqual([]);
  });

  test("psh-rename-escape-show-in-tree-replacement-keeps-target-owner", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    const row = nodeRow(page, "window:1");
    await row.hover();
    await row.getByRole("button", { name: "Rename", exact: true }).click();
    const input = row.getByRole("textbox", { name: "Rename Window", exact: true });
    await expect(input).toBeVisible();
    await input.fill("Canceled before target replacement");
    await input.press("Escape");
    await expect(input).toHaveCount(0);

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      if (api.projectionRequests()[0]?.query !== "Tab 900") {
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(2);
      }
      await api.waitForProjectionRequest("Tab 900");
      api.resolveSliceForQuery("Tab 900");
      await api.waitForVisibleRow(1);
    });

    await nodeRow(page, "tab:900").hover();
    await nodeRow(page, "tab:900").getByRole("button", { name: "Show in tree", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForTargetProjectionRequest("tab:900");
      api.resolveSliceForTarget("tab:900", { start: 880, end: 940 });
      await api.waitForVisibleRow(900);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        renameInputs: document.querySelectorAll(".node-rename-input").length,
        hasTargetHighlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight")),
        hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900'].is-search-match")),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([{ type: "expandAncestors", nodeId: "tab:900" }]);
    expect(result.requests).toContainEqual(expect.objectContaining({ query: "Tab 900", targetNodeId: undefined }));
    expect(result.requests.at(-1)).toMatchObject({ query: "", targetNodeId: "tab:900" });
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.visibleRows).toContain(900);
    expect(result.renameInputs).toBe(0);
    expect(result.hasTargetHighlight).toBe(true);
    expect(result.hasSearchRow).toBe(false);
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(issues).toEqual([]);
  });

  test("psh-rename-enter-show-in-tree-replacement-keeps-target-owner", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    const row = nodeRow(page, "window:1");
    await row.hover();
    await row.getByRole("button", { name: "Rename", exact: true }).click();
    const input = row.getByRole("textbox", { name: "Rename Window", exact: true });
    await expect(input).toBeVisible();
    await input.fill("Committed before target replacement");
    await input.press("Enter");
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      if (api.projectionRequests()[0]?.query !== "Tab 900") {
        api.resolveSliceAt(0);
        await api.waitForIdleFrames(2);
      }
      await api.waitForProjectionRequest("Tab 900");
      api.resolveSliceForQuery("Tab 900");
      await api.waitForVisibleRow(1);
    });

    await nodeRow(page, "tab:900").hover();
    await nodeRow(page, "tab:900").getByRole("button", { name: "Show in tree", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForTargetProjectionRequest("tab:900");
      api.resolveSliceForTarget("tab:900", { start: 880, end: 940 });
      await api.waitForVisibleRow(900);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        renameInputs: document.querySelectorAll(".node-rename-input").length,
        hasTargetHighlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight")),
        hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900'].is-search-match")),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([
      { type: "renameGroup", nodeId: "window:1", title: "Committed before target replacement" },
      { type: "expandAncestors", nodeId: "tab:900" }
    ]);
    expect(result.requests).toContainEqual(expect.objectContaining({ query: "Tab 900", targetNodeId: undefined }));
    expect(result.requests.at(-1)).toMatchObject({ query: "", targetNodeId: "tab:900" });
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.visibleRows).toContain(900);
    expect(result.renameInputs).toBe(0);
    expect(result.hasTargetHighlight).toBe(true);
    expect(result.hasSearchRow).toBe(false);
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(issues).toEqual([]);
  });

  test("psh-close-command-search-replacement-keeps-query-owner", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    await nodeRow(page, "tab:800").hover();
    await nodeRow(page, "tab:800").getByRole("button", { name: "Close", exact: true }).click();
    await page.locator("#search").fill("Tab 900");
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForVisibleRow(1);
      await api.waitForIdleFrames(3);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900']")),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([{ type: "closeNode", nodeId: "tab:800" }]);
    expect(result.requests).toEqual([expect.objectContaining({ query: "Tab 900", targetNodeId: undefined })]);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("Tab 900");
    expect(result.visibleRows).toContain(1);
    expect(result.hasSearchRow).toBe(true);
    expect(result.countText).toBe("1 match / 1001 items");
    expect(issues).toEqual([]);
  });

  test("psh-move-to-root-command-search-replacement-keeps-query-owner", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    await nodeRow(page, "tab:800").hover();
    await nodeRow(page, "tab:800").getByRole("button", { name: "Move to top level", exact: true }).click();
    await page.locator("#search").fill("Tab 900");
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForVisibleRow(1);
      await api.waitForIdleFrames(3);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900']")),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([{ type: "moveSubtreeToTopLevel", nodeId: "tab:800" }]);
    expect(result.requests).toEqual([expect.objectContaining({ query: "Tab 900", targetNodeId: undefined })]);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("Tab 900");
    expect(result.visibleRows).toContain(1);
    expect(result.hasSearchRow).toBe(true);
    expect(result.countText).toBe("1 match / 1001 items");
    expect(issues).toEqual([]);
  });

  test("psh-close-command-search-clear-stale-response-keeps-outline-owner", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    await nodeRow(page, "tab:800").hover();
    await nodeRow(page, "tab:800").getByRole("button", { name: "Close", exact: true }).click();
    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      await projectionHuntApi().waitForSparseRequestCount(1);
    });
    await page.locator("#clear-search").click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      const requestCountAfterClear = api.sparseRequestCount();
      for (let frame = 0; frame < 120; frame += 1) {
        if (api.sparseRequestCount() > requestCountAfterClear || api.visibleRows().includes(800)) {
          break;
        }
        await api.nextFrame();
      }
      api.resolveSliceAt(0);
      await api.waitForIdleFrames(3);
      if (api.sparseRequestCount() > requestCountAfterClear) {
        api.resolveSliceAt(0, { start: 760, end: 840 });
        await api.waitForVisibleRow(800);
      } else {
        await api.waitForVisibleRow(800);
      }
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900']")),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([{ type: "closeNode", nodeId: "tab:800" }]);
    expect(result.requests[0]).toEqual(expect.objectContaining({ query: "Tab 900", targetNodeId: undefined }));
    expect(result.requests.slice(1).every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.visibleRows).toContain(800);
    expect(result.hasSearchRow).toBe(false);
    expect(result.countText).toBe("1001 items / 0 saved");
    expect(issues).toEqual([]);
  });

  test("psh-restored-delete-history-full-broadcast-keeps-live-neighbor", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadRestoredWindowSidebar(page, { fullStatePending: true });

    await nodeRow(page, "tab:2").hover();
    await nodeRow(page, "tab:2").getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "delete restored tab" });
      api.emitDeletePatch(["tab:2", "window:20"]);
      api.emitFullStateBroadcast();
      await api.waitForIdleFrames(5);
      return {
        commands: api.sentCommands(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows(),
        restoredTabExists: Boolean(document.querySelector("[data-node-id='tab:2']")),
        restoredWindowExists: Boolean(document.querySelector("[data-node-id='window:20']")),
        liveTabExists: Boolean(document.querySelector("[data-node-id='tab:1']")),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([{ type: "deleteNode", nodeId: "tab:2" }]);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toContain(0);
    expect(result.restoredTabExists).toBe(false);
    expect(result.restoredWindowExists).toBe(false);
    expect(result.liveTabExists).toBe(true);
    expect(result.countText).toBe("2 items / 0 saved");
    await expect(nodeRow(page, "tab:1")).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-two-sidebars-restored-delete-and-search-stay-independent", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    await loadRestoredWindowSidebar(page, { fullStatePending: true });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, { includeCoverage: true, fullStatePending: true });
      await pageB.locator("#search").fill("Tab 900");
      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0);
        await api.waitForVisibleRow(1);
      });

      await nodeRow(page, "tab:2").hover();
      await nodeRow(page, "tab:2").getByRole("button", { name: "Delete", exact: true }).click();
      await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitDeletePatch(["tab:2", "window:20"]);
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            stateRequests: api.stateRequestCount(),
            visibleRows: api.visibleRows(),
            restoredTabExists: Boolean(document.querySelector("[data-node-id='tab:2']")),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? ""
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitDeletePatch(["tab:2", "window:20"]);
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows(),
            hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900']")),
            countText: document.querySelector("#state-count")?.textContent ?? ""
          };
        })
      ]);

      expect(resultA.commands).toEqual([{ type: "deleteNode", nodeId: "tab:2" }]);
      expect(resultA.stateRequests).toBe(0);
      expect(resultA.visibleRows).toContain(0);
      expect(resultA.restoredTabExists).toBe(false);
      expect(resultA.searchValue).toBe("");
      expect(resultA.countText).toBe("2 items / 0 saved");

      expect(resultB.commands).toEqual([]);
      expect(resultB.requests).toEqual([expect.objectContaining({ query: "Tab 900", targetNodeId: undefined })]);
      expect(resultB.stateRequests).toBe(0);
      expect(resultB.searchValue).toBe("Tab 900");
      expect(resultB.visibleRows).toContain(1);
      expect(resultB.hasSearchRow).toBe(true);
      expect(resultB.countText).toBe("1 match / 999 items");
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-close-command-show-in-tree-replacement-keeps-target-owner", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    await nodeRow(page, "tab:800").hover();
    await nodeRow(page, "tab:800").getByRole("button", { name: "Close", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForVisibleRow(1);
    });

    await nodeRow(page, "tab:900").hover();
    await nodeRow(page, "tab:900").getByRole("button", { name: "Show in tree", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(2);
      api.emitDeletePatch(["tab:800"]);
      api.resolveSliceAt(0, { start: 880, end: 940 });
      await api.waitForVisibleRow(900);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        hasTargetHighlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight")),
        closedSourceExists: Boolean(document.querySelector("[data-node-id='tab:800']"))
      };
    });

    expect(result.commands).toEqual([
      { type: "closeNode", nodeId: "tab:800" },
      { type: "expandAncestors", nodeId: "tab:900" }
    ]);
    expect(result.requests).toContainEqual(expect.objectContaining({ query: "Tab 900", targetNodeId: undefined }));
    expect(result.requests.at(-1)).toMatchObject({ query: "", targetNodeId: "tab:900" });
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.visibleRows).toContain(900);
    expect(result.hasTargetHighlight).toBe(true);
    expect(result.closedSourceExists).toBe(false);
    expect(issues).toEqual([]);
  });

  test("psh-two-sidebars-target-and-clear-search-stay-independent", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForVisibleRow(1);
    });
    await nodeRow(page, "tab:900").hover();
    await nodeRow(page, "tab:900").getByRole("button", { name: "Show in tree", exact: true }).click();
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0, { start: 880, end: 940 });
      await api.waitForVisibleRow(900);
    });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, { includeCoverage: true, fullStatePending: true });
      await pageB.locator("#search").fill("Tab 91");
      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForSparseRequestCount(1);
        api.resolveSliceAt(0);
        await api.waitForVisibleRow(1);
      });
      const beforeClearRequestCount = await pageB.evaluate(() => projectionHuntApi().sparseRequestCount());
      await pageB.locator("#clear-search").click();
      await pageB.evaluate(async (previousRequestCount) => {
        const api = projectionHuntApi();
        for (let frame = 0; frame < 120; frame += 1) {
          if (api.visibleRows().includes(800) || api.sparseRequestCount() > previousRequestCount) {
            break;
          }
          await api.nextFrame();
        }
        if (!api.visibleRows().includes(800)) {
          api.resolveSliceAt(0, { start: 760, end: 840 });
          await api.waitForVisibleRow(800);
        }
        await api.waitForIdleFrames(4);
      }, beforeClearRequestCount);

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitTitlePatch("tab:900", "Tab 900 target sidebar patched");
          await api.waitForIdleFrames(4);
          return {
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows(),
            hasTargetHighlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight"))
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitTitlePatch("tab:800", "Tab 800 clear sidebar patched");
          await api.waitForIdleFrames(4);
          return {
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows(),
            hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:91']")),
            hasOutlineRow: Boolean(document.querySelector("[data-node-id='tab:800']"))
          };
        })
      ]);

      expect(resultA.requests).toContainEqual(expect.objectContaining({ query: "", targetNodeId: "tab:900" }));
      expect(resultA.stateRequests).toBe(0);
      expect(resultA.searchValue).toBe("");
      expect(resultA.visibleRows).toContain(900);
      expect(resultA.hasTargetHighlight).toBe(true);

      expect(resultB.requests[0]).toEqual(expect.objectContaining({ query: "Tab 91", targetNodeId: undefined }));
      expect(resultB.stateRequests).toBe(0);
      expect(resultB.searchValue).toBe("");
      expect(resultB.visibleRows).toContain(800);
      expect(resultB.hasSearchRow).toBe(false);
      expect(resultB.hasOutlineRow).toBe(true);
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-cut-search-clear-keeps-paste-blocked-before-hydration", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    await nodeRow(page, "tab:800").hover();
    await nodeRow(page, "tab:800").getByRole("button", { name: "Cut", exact: true }).click();
    await expect(page.locator(nodeSelector("tab:800"))).toHaveClass(/is-cut/);

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0);
      await api.waitForVisibleRow(1);
    });

    const beforeClearRequestCount = await page.evaluate(() => projectionHuntApi().sparseRequestCount());
    await page.locator("#clear-search").click();
    const result = await page.evaluate(async (previousRequestCount) => {
      const api = projectionHuntApi();
      for (let frame = 0; frame < 120; frame += 1) {
        if (api.visibleRows().includes(801) || api.sparseRequestCount() > previousRequestCount) {
          break;
        }
        await api.nextFrame();
      }
      if (!api.visibleRows().includes(801)) {
        api.resolveSliceAt(0, { start: 760, end: 840 });
        await api.waitForVisibleRow(801);
      }
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        cutMarkers: document.querySelectorAll(".is-cut").length,
        hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900']"))
      };
    }, beforeClearRequestCount);

    await nodeRow(page, "tab:801").hover();
    await expect(nodeRow(page, "tab:801").getByRole("button", { name: "Paste", exact: true })).toHaveCount(0);

    expect(result.commands).toEqual([]);
    expect(result.requests[0]).toEqual(expect.objectContaining({ query: "Tab 900", targetNodeId: undefined }));
    expect(result.searchValue).toBe("");
    expect(result.visibleRows).toContain(801);
    expect(result.cutMarkers).toBe(1);
    expect(result.hasSearchRow).toBe(false);
    expect(issues).toEqual([]);
  });

  test("psh-keyboard-paste-during-pending-show-in-tree-target-waits", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    await nodeRow(page, "tab:800").locator(".node-label").focus();
    await page.keyboard.press("Control+X");
    await expect(page.locator(nodeSelector("tab:800"))).toHaveClass(/is-cut/);

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForProjectionRequest("Tab 900");
      api.resolveSliceForQuery("Tab 900");
      await api.waitForVisibleRow(1);
    });

    await nodeRow(page, "tab:900").hover();
    await nodeRow(page, "tab:900").getByRole("button", { name: "Show in tree", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().projectionRequests().some((request) => request.targetNodeId === "tab:900"));
    await nodeRow(page, "tab:900").locator(".node-label").focus();
    await page.keyboard.press("Control+V");

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.resolveSliceForTarget("tab:900", { start: 880, end: 940 });
      await api.waitForVisibleRow(900);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        cutMarkers: document.querySelectorAll(".is-cut").length,
        hasTargetHighlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight")),
        hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900'].is-search-match"))
      };
    });

    expect(result.commands).toEqual([{ type: "expandAncestors", nodeId: "tab:900" }]);
    expect(result.requests).toContainEqual(expect.objectContaining({ query: "Tab 900", targetNodeId: undefined }));
    expect(result.requests).toContainEqual(expect.objectContaining({ query: "", targetNodeId: "tab:900" }));
    expect(result.stateRequests).toBe(1);
    expect(result.searchValue).toBe("");
    expect(result.visibleRows).toContain(900);
    expect(result.cutMarkers).toBe(0);
    expect(result.hasTargetHighlight).toBe(true);
    expect(result.hasSearchRow).toBe(false);
    await nodeRow(page, "tab:900").hover();
    await expect(nodeRow(page, "tab:900").getByRole("button", { name: "Paste", exact: true })).toHaveCount(0);
    expect(issues).toEqual([]);
  });

  test("psh-delayed-restore-scope-search-input-keeps-local-restore-after-dismiss", async ({ page }) => {
    const issues = collectPageIssues(page);
    const dialogMessages: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogMessages.push(dialog.message());
      await dialog.dismiss();
    });
    await loadClosedRestoreSidebar(page, { fullStatePending: true, delayRestoreScope: true });

    await nodeRow(page, "window:30").getByRole("button", { name: "Restore Closed Window", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);
    await page.locator("#search").fill("Closed tab 30");
    await expect(nodeRow(page, "tab:30")).toBeVisible();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "restore check" });
      api.resolveRestoreScope();
      await api.waitForIdleFrames(8);
      return {
        commands: api.sentCommands(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        closedTabExists: Boolean(document.querySelector("[data-node-id='tab:30']")),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([{ type: "analyzeRestoreScope", nodeId: "window:30" }]);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("Closed tab 30");
    expect(result.visibleRows).toContain(1);
    expect(result.closedTabExists).toBe(true);
    expect(result.countText).toBe("4 items / 4 saved");
    expect(dialogMessages).toHaveLength(1);
    expect(dialogMessages[0]).toContain("Restore 4 restorable closed nodes");
    expect(issues).toEqual([]);
  });

  test("psh-keyboard-redo-query-replacement-keeps-current-search", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      historyStatus: { canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" }
    });

    await page.locator("#search").fill("Tab 90");
    await page.evaluate(async () => {
      await projectionHuntApi().waitForProjectionRequest("Tab 90");
    });
    await page.locator("#search").fill("Tab 91");
    await page.evaluate(async () => {
      await projectionHuntApi().waitForProjectionRequest("Tab 91");
    });
    await nodeRow(page, "tab:800").locator(".node-label").focus();
    await page.keyboard.press("Control+Shift+Z");
    await page.waitForFunction(() => projectionHuntApi().sentCommands().some((command) => (
      typeof command === "object" && command !== null && (command as { type?: unknown }).type === "redo"
    )));

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" });
      api.resolveSliceForQuery("Tab 90");
      await api.waitForIdleFrames(2);
      api.resolveSliceForQuery("Tab 91");
      await api.waitForVisibleRow(1);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        hasTab91: Boolean(document.querySelector("[data-node-id='tab:91']")),
        hasTab90: Boolean(document.querySelector("[data-node-id='tab:90']")),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([{ type: "redo" }]);
    expect(result.requests).toEqual([
      expect.objectContaining({ query: "Tab 90", targetNodeId: undefined }),
      expect.objectContaining({ query: "Tab 91", targetNodeId: undefined })
    ]);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("Tab 91");
    expect(result.visibleRows).toContain(1);
    expect(result.hasTab91).toBe(true);
    expect(result.hasTab90).toBe(false);
    expect(result.countText).toBe("11 matches / 1001 items");
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeDisabled();
    expect(issues).toEqual([]);
  });

  test("psh-two-sidebars-restore-dialog-and-target-owner-stay-independent", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    const dialogMessages: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogMessages.push(dialog.message());
      await dialog.dismiss();
    });
    await loadClosedRestoreSidebar(page, { fullStatePending: true, delayRestoreScope: true });
    await nodeRow(page, "window:30").getByRole("button", { name: "Restore Closed Window", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, { includeCoverage: true, fullStatePending: true });
      await pageB.locator("#search").fill("Tab 900");
      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForProjectionRequest("Tab 900");
        api.resolveSliceForQuery("Tab 900");
        await api.waitForVisibleRow(1);
      });
      await nodeRow(pageB, "tab:900").hover();
      await nodeRow(pageB, "tab:900").getByRole("button", { name: "Show in tree", exact: true }).click();
      await pageB.waitForFunction(() => projectionHuntApi().projectionRequests().some((request) => request.targetNodeId === "tab:900"));

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "restore check" });
          api.resolveRestoreScope();
          await api.waitForIdleFrames(8);
          return {
            commands: api.sentCommands(),
            stateRequests: api.stateRequestCount(),
            visibleRows: api.visibleRows(),
            closedWindowExists: Boolean(document.querySelector("[data-node-id='window:30']"))
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "target check" });
          api.resolveSliceForTarget("tab:900", { start: 880, end: 940 });
          await api.waitForVisibleRow(900);
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows(),
            hasTargetHighlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight")),
            hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900'].is-search-match"))
          };
        })
      ]);

      expect(resultA.commands).toEqual([{ type: "analyzeRestoreScope", nodeId: "window:30" }]);
      expect(resultA.stateRequests).toBe(0);
      expect(resultA.visibleRows).toContain(0);
      expect(resultA.closedWindowExists).toBe(true);
      expect(dialogMessages).toHaveLength(1);
      expect(dialogMessages[0]).toContain("Restore 4 restorable closed nodes");

      expect(resultB.commands).toEqual([{ type: "expandAncestors", nodeId: "tab:900" }]);
      expect(resultB.requests).toContainEqual(expect.objectContaining({ query: "Tab 900", targetNodeId: undefined }));
      expect(resultB.requests).toContainEqual(expect.objectContaining({ query: "", targetNodeId: "tab:900" }));
      expect(resultB.stateRequests).toBe(0);
      expect(resultB.searchValue).toBe("");
      expect(resultB.visibleRows).toContain(900);
      expect(resultB.hasTargetHighlight).toBe(true);
      expect(resultB.hasSearchRow).toBe(false);
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-delayed-restore-scope-search-clear-keeps-local-restore-after-dismiss", async ({ page }) => {
    const issues = collectPageIssues(page);
    const dialogMessages: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogMessages.push(dialog.message());
      await dialog.dismiss();
    });
    await loadClosedRestoreSidebar(page, { fullStatePending: true, delayRestoreScope: true });

    await nodeRow(page, "window:30").getByRole("button", { name: "Restore Closed Window", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);
    await page.locator("#search").fill("Closed tab 30");
    await expect(nodeRow(page, "tab:30")).toBeVisible();
    await page.locator("#clear-search").click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "restore check" });
      api.resolveRestoreScope();
      await api.waitForIdleFrames(8);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        closedWindowExists: Boolean(document.querySelector("[data-node-id='window:30']")),
        closedTabExists: Boolean(document.querySelector("[data-node-id='tab:30']")),
        countText: document.querySelector("#state-count")?.textContent ?? ""
      };
    });

    expect(result.commands).toEqual([{ type: "analyzeRestoreScope", nodeId: "window:30" }]);
    expect(result.requests).toEqual([expect.objectContaining({ query: "", targetNodeId: undefined })]);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.visibleRows).toContain(0);
    expect(result.closedWindowExists).toBe(true);
    expect(result.closedTabExists).toBe(true);
    expect(result.countText).toBe("4 items / 4 saved");
    expect(dialogMessages).toHaveLength(1);
    expect(dialogMessages[0]).toContain("Restore 4 restorable closed nodes");
    expect(issues).toEqual([]);
  });

  test("psh-keyboard-redo-during-pending-show-in-tree-target-keeps-target-owner", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      historyStatus: { canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "target redo" }
    });

    await page.locator("#search").fill("Tab 900");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForProjectionRequest("Tab 900");
      api.resolveSliceForQuery("Tab 900");
      await api.waitForVisibleRow(1);
    });
    await nodeRow(page, "tab:900").hover();
    await nodeRow(page, "tab:900").getByRole("button", { name: "Show in tree", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().projectionRequests().some((request) => request.targetNodeId === "tab:900"));
    await nodeRow(page, "tab:900").locator(".node-label").focus();
    await page.keyboard.press("Control+Shift+Z");
    await page.waitForFunction(() => projectionHuntApi().sentCommands().some((command) => (
      typeof command === "object" && command !== null && (command as { type?: unknown }).type === "redo"
    )));

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "target redo" });
      api.resolveSliceForTarget("tab:900", { start: 880, end: 940 });
      await api.waitForVisibleRow(900);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        hasTargetHighlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight")),
        hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900'].is-search-match"))
      };
    });

    expect(result.commands).toEqual([
      { type: "expandAncestors", nodeId: "tab:900" },
      { type: "redo" }
    ]);
    expect(result.requests).toContainEqual(expect.objectContaining({ query: "Tab 900", targetNodeId: undefined }));
    expect(result.requests).toContainEqual(expect.objectContaining({ query: "", targetNodeId: "tab:900" }));
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.visibleRows).toContain(900);
    expect(result.hasTargetHighlight).toBe(true);
    expect(result.hasSearchRow).toBe(false);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeDisabled();
    expect(issues).toEqual([]);
  });

  test("psh-two-sidebars-restore-dialog-and-redo-query-stay-independent", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    const dialogMessages: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogMessages.push(dialog.message());
      await dialog.dismiss();
    });
    await loadClosedRestoreSidebar(page, { fullStatePending: true, delayRestoreScope: true });
    await nodeRow(page, "window:30").getByRole("button", { name: "Restore Closed Window", exact: true }).click();
    await page.waitForFunction(() => projectionHuntApi().sentCommands().length === 1);

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, {
        includeCoverage: true,
        fullStatePending: true,
        historyStatus: { canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1, redoLabel: "remote edit" }
      });
      await pageB.locator("#search").fill("Tab 90");
      await pageB.evaluate(async () => {
        await projectionHuntApi().waitForProjectionRequest("Tab 90");
      });
      await pageB.locator("#search").fill("Tab 91");
      await pageB.evaluate(async () => {
        await projectionHuntApi().waitForProjectionRequest("Tab 91");
      });
      await nodeRow(pageB, "tab:800").locator(".node-label").focus();
      await pageB.keyboard.press("Control+Shift+Z");
      await pageB.waitForFunction(() => projectionHuntApi().sentCommands().some((command) => (
        typeof command === "object" && command !== null && (command as { type?: unknown }).type === "redo"
      )));

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.resolveRestoreScope();
          await api.waitForIdleFrames(8);
          return {
            commands: api.sentCommands(),
            stateRequests: api.stateRequestCount(),
            visibleRows: api.visibleRows(),
            closedWindowExists: Boolean(document.querySelector("[data-node-id='window:30']"))
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "remote edit" });
          api.resolveSliceForQuery("Tab 90");
          await api.waitForIdleFrames(2);
          api.resolveSliceForQuery("Tab 91");
          await api.waitForVisibleRow(1);
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows(),
            hasTab91: Boolean(document.querySelector("[data-node-id='tab:91']")),
            hasTab90: Boolean(document.querySelector("[data-node-id='tab:90']"))
          };
        })
      ]);

      expect(resultA.commands).toEqual([{ type: "analyzeRestoreScope", nodeId: "window:30" }]);
      expect(resultA.stateRequests).toBe(0);
      expect(resultA.visibleRows).toContain(0);
      expect(resultA.closedWindowExists).toBe(true);
      expect(dialogMessages).toHaveLength(1);
      expect(dialogMessages[0]).toContain("Restore 4 restorable closed nodes");

      expect(resultB.commands).toEqual([{ type: "redo" }]);
      expect(resultB.requests).toEqual([
        expect.objectContaining({ query: "Tab 90", targetNodeId: undefined }),
        expect.objectContaining({ query: "Tab 91", targetNodeId: undefined })
      ]);
      expect(resultB.stateRequests).toBe(0);
      expect(resultB.searchValue).toBe("Tab 91");
      expect(resultB.visibleRows).toContain(1);
      expect(resultB.hasTab91).toBe(true);
      expect(resultB.hasTab90).toBe(false);
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-drag-boundary-target-uses-covered-sibling-order-before-hydration", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    await dragAfter(page, "tab:800", "tab:839");

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForIdleFrames(3);
      const marker = document.querySelector<HTMLElement>("[data-testid='drop-marker']");
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows(),
        markerClassName: marker?.className ?? ""
      };
    });

    expect(result.commands).toEqual([{ type: "moveNode", nodeId: "tab:800", parentId: "window:1", index: 838 }]);
    expect(result.requests).toEqual([]);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toContain(800);
    expect(result.markerClassName).not.toMatch(/drop-root|drop-before|drop-after|drop-inside/);
    expect(issues).toEqual([]);
  });

  test("psh-drag-boundary-missing-coverage-refills-without-command", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: false, fullStatePending: true });

    await dragAfter(page, "tab:800", "tab:839");

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      await api.waitForIdleFrames(3);
      const marker = document.querySelector<HTMLElement>("[data-testid='drop-marker']");
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows(),
        markerClassName: marker?.className ?? ""
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests).toEqual([expect.objectContaining({ query: "", targetNodeId: undefined })]);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toContain(800);
    expect(result.markerClassName).not.toMatch(/drop-root|drop-before|drop-after|drop-inside/);
    expect(issues).toEqual([]);
  });

  test("psh-drag-boundary-missing-coverage-recovers-after-covered-refill", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: false, fullStatePending: true });

    await dragAfter(page, "tab:800", "tab:839");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { start: 760, end: 840, includeCoverage: true });
      await api.waitForVisibleRow(800);
      await api.waitForIdleFrames(3);
    });

    await dragAfter(page, "tab:800", "tab:839");

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForIdleFrames(3);
      const marker = document.querySelector<HTMLElement>("[data-testid='drop-marker']");
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows(),
        markerClassName: marker?.className ?? ""
      };
    });

    expect(result.commands).toEqual([{ type: "moveNode", nodeId: "tab:800", parentId: "window:1", index: 838 }]);
    expect(result.requests).toEqual([expect.objectContaining({ query: "", targetNodeId: undefined })]);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toContain(800);
    expect(result.markerClassName).not.toMatch(/drop-root|drop-before|drop-after|drop-inside/);
    expect(issues).toEqual([]);
  });

  test("psh-two-sidebars-boundary-drag-and-target-stay-independent", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    await loadLargeSparseSidebar(page, { includeCoverage: true, fullStatePending: true });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadLargeSparseSidebar(pageB, { includeCoverage: true, fullStatePending: true });
      await pageB.locator("#search").fill("Tab 900");
      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForProjectionRequest("Tab 900");
        api.resolveSliceForQuery("Tab 900");
        await api.waitForVisibleRow(1);
      });
      await nodeRow(pageB, "tab:900").hover();
      await nodeRow(pageB, "tab:900").getByRole("button", { name: "Show in tree", exact: true }).click();
      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForTargetProjectionRequest("tab:900");
        api.resolveSliceForTarget("tab:900", { start: 880, end: 940 });
        await api.waitForVisibleRow(900);
        await api.waitForIdleFrames(3);
      });

      await dragAfter(page, "tab:800", "tab:839");

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitMovePatch("tab:800", "window:1", 838);
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows()
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitMovePatch("tab:800", "window:1", 838);
          await api.waitForIdleFrames(4);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows(),
            hasTargetHighlight: Boolean(document.querySelector("[data-node-id='tab:900'].is-reveal-highlight")),
            hasSearchRow: Boolean(document.querySelector("[data-node-id='tab:900'].is-search-match"))
          };
        })
      ]);

      expect(resultA.commands).toEqual([{ type: "moveNode", nodeId: "tab:800", parentId: "window:1", index: 838 }]);
      expect(resultA.requests).toEqual([expect.objectContaining({ query: "", targetNodeId: undefined })]);
      expect(resultA.stateRequests).toBe(0);
      expect(resultA.searchValue).toBe("");
      expect(resultA.visibleRows).toContain(800);

      expect(resultB.commands).toEqual([{ type: "expandAncestors", nodeId: "tab:900" }]);
      expect(resultB.requests).toContainEqual(expect.objectContaining({ query: "Tab 900", targetNodeId: undefined }));
      expect(resultB.requests).toContainEqual(expect.objectContaining({ query: "", targetNodeId: "tab:900" }));
      expect(resultB.stateRequests).toBe(0);
      expect(resultB.searchValue).toBe("");
      expect(resultB.visibleRows).toContain(900);
      expect(resultB.hasTargetHighlight).toBe(true);
      expect(resultB.hasSearchRow).toBe(false);
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-collapsed-parent-inside-drop-missing-child-order-refills", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadCollapsedBoundarySidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      coverCollapsedParent: false
    });

    await dragInside(page, "tab:10", "group:collapsed");

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(1);
      await api.waitForIdleFrames(3);
      const marker = document.querySelector<HTMLElement>("[data-testid='drop-marker']");
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows(),
        hasHiddenChild: Boolean(document.querySelector("[data-node-id='tab:50']")),
        markerClassName: marker?.className ?? ""
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests).toEqual([expect.objectContaining({ query: "", targetNodeId: undefined })]);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toEqual([0, 1, 2, 3]);
    expect(result.hasHiddenChild).toBe(false);
    expect(result.markerClassName).not.toMatch(/drop-root|drop-before|drop-after|drop-inside/);
    expect(issues).toEqual([]);
  });

  test("psh-collapsed-parent-inside-drop-covered-child-order-sends-command", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadCollapsedBoundarySidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      coverCollapsedParent: true
    });

    await dragInside(page, "tab:10", "group:collapsed");

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForIdleFrames(3);
      const marker = document.querySelector<HTMLElement>("[data-testid='drop-marker']");
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows(),
        hasHiddenChild: Boolean(document.querySelector("[data-node-id='tab:50']")),
        markerClassName: marker?.className ?? ""
      };
    });

    expect(result.commands).toEqual([{ type: "moveNode", nodeId: "tab:10", parentId: "group:collapsed", index: 2 }]);
    expect(result.requests).toEqual([]);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toEqual([0, 1, 2, 3]);
    expect(result.hasHiddenChild).toBe(false);
    expect(result.markerClassName).not.toMatch(/drop-root|drop-before|drop-after|drop-inside/);
    expect(issues).toEqual([]);
  });

  test("psh-collapsed-parent-covered-drop-move-patch-keeps-children-hidden", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadCollapsedBoundarySidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      coverCollapsedParent: true
    });

    await dragInside(page, "tab:10", "group:collapsed");

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitMovePatch("tab:10", "group:collapsed", 2);
      await api.waitForIdleFrames(6);
      const marker = document.querySelector<HTMLElement>("[data-testid='drop-marker']");
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows(),
        hasSource: Boolean(document.querySelector("[data-node-id='tab:10']")),
        hasCollapsedParent: Boolean(document.querySelector("[data-node-id='group:collapsed']")),
        hasTail: Boolean(document.querySelector("[data-node-id='tab:90']")),
        hasHiddenChild: Boolean(document.querySelector("[data-node-id='tab:50']")),
        markerClassName: marker?.className ?? ""
      };
    });

    expect(result.commands).toEqual([{ type: "moveNode", nodeId: "tab:10", parentId: "group:collapsed", index: 2 }]);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toContain(0);
    expect(result.hasSource).toBe(false);
    expect(result.hasCollapsedParent).toBe(true);
    expect(result.hasTail).toBe(true);
    expect(result.hasHiddenChild).toBe(false);
    expect(result.markerClassName).not.toMatch(/drop-root|drop-before|drop-after|drop-inside/);
    expect(issues).toEqual([]);
  });

  test("psh-collapsed-search-hidden-child-missing-order-refills-without-command", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadCollapsedBoundarySidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      coverCollapsedParent: false
    });
    await page.locator("#search").fill("Hidden child");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForProjectionRequest("Hidden child");
      api.resolveSliceForQuery("Hidden child");
      await api.waitForVisibleRow(2);
      await api.waitForIdleFrames(3);
    });

    await dragAfter(page, "tab:50", "tab:51");

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(2);
      await api.waitForIdleFrames(3);
      const marker = document.querySelector<HTMLElement>("[data-testid='drop-marker']");
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        hasHiddenChild50: Boolean(document.querySelector("[data-node-id='tab:50']")),
        hasHiddenChild51: Boolean(document.querySelector("[data-node-id='tab:51']")),
        markerClassName: marker?.className ?? ""
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests).toEqual([
      expect.objectContaining({ query: "Hidden child", targetNodeId: undefined }),
      expect.objectContaining({ query: "Hidden child", targetNodeId: undefined })
    ]);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("Hidden child");
    expect(result.visibleRows).toContain(2);
    expect(result.hasHiddenChild50).toBe(true);
    expect(result.hasHiddenChild51).toBe(true);
    expect(result.markerClassName).not.toMatch(/drop-root|drop-before|drop-after|drop-inside/);
    expect(issues).toEqual([]);
  });

  test("psh-collapsed-search-hidden-child-covered-order-sends-command", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadCollapsedBoundarySidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      coverCollapsedParent: true
    });
    await page.locator("#search").fill("Hidden child");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForProjectionRequest("Hidden child");
      api.resolveSliceForQuery("Hidden child");
      await api.waitForVisibleRow(2);
      await api.waitForIdleFrames(3);
    });

    await dragAfter(page, "tab:50", "tab:51");

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForIdleFrames(3);
      const marker = document.querySelector<HTMLElement>("[data-testid='drop-marker']");
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        markerClassName: marker?.className ?? ""
      };
    });

    expect(result.commands).toEqual([{ type: "moveNode", nodeId: "tab:50", parentId: "group:collapsed", index: 1 }]);
    expect(result.requests).toEqual([expect.objectContaining({ query: "Hidden child", targetNodeId: undefined })]);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("Hidden child");
    expect(result.visibleRows).toContain(2);
    expect(result.markerClassName).not.toMatch(/drop-root|drop-before|drop-after|drop-inside/);
    expect(issues).toEqual([]);
  });

  test("psh-two-sidebars-collapsed-search-drop-and-outline-stay-independent", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    await loadCollapsedBoundarySidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      coverCollapsedParent: true
    });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadCollapsedBoundarySidebar(pageB, {
        includeCoverage: true,
        fullStatePending: true,
        coverCollapsedParent: false
      });
      await page.locator("#search").fill("Hidden child");
      await page.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForProjectionRequest("Hidden child");
        api.resolveSliceForQuery("Hidden child");
        await api.waitForVisibleRow(2);
        await api.waitForIdleFrames(3);
      });

      await dragAfter(page, "tab:50", "tab:51");

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitMovePatch("tab:50", "group:collapsed", 1);
          await api.waitForIdleFrames(6);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows(),
            hasHiddenChild50: Boolean(document.querySelector("[data-node-id='tab:50']")),
            hasHiddenChild51: Boolean(document.querySelector("[data-node-id='tab:51']"))
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitMovePatch("tab:50", "group:collapsed", 1);
          await api.waitForIdleFrames(6);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows(),
            hasHiddenChild50: Boolean(document.querySelector("[data-node-id='tab:50']")),
            hasCollapsedParent: Boolean(document.querySelector("[data-node-id='group:collapsed']"))
          };
        })
      ]);

      expect(resultA.commands).toEqual([{ type: "moveNode", nodeId: "tab:50", parentId: "group:collapsed", index: 1 }]);
      expect(resultA.requests).toEqual([expect.objectContaining({ query: "Hidden child", targetNodeId: undefined })]);
      expect(resultA.stateRequests).toBe(0);
      expect(resultA.searchValue).toBe("Hidden child");
      expect(resultA.visibleRows).toContain(2);
      expect(resultA.hasHiddenChild50).toBe(true);
      expect(resultA.hasHiddenChild51).toBe(true);

      expect(resultB.commands).toEqual([]);
      expect(resultB.requests).toEqual([]);
      expect(resultB.stateRequests).toBe(0);
      expect(resultB.searchValue).toBe("");
      expect(resultB.visibleRows).toEqual([0, 1, 2, 3]);
      expect(resultB.hasHiddenChild50).toBe(false);
      expect(resultB.hasCollapsedParent).toBe(true);
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-collapsed-parent-expand-patch-refills-hidden-children", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadCollapsedBoundarySidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      coverCollapsedParent: false
    });

    await nodeRow(page, "group:collapsed").getByRole("button", { name: "Expand", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitCollapsedPatch("group:collapsed", false);
      await api.waitForSparseRequestCount(1);
      api.resolveSliceAt(0, { includeCoverage: true });
      await api.waitForVisibleRow(3);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows(),
        hasHiddenChild50: Boolean(document.querySelector("[data-node-id='tab:50']")),
        hasHiddenChild51: Boolean(document.querySelector("[data-node-id='tab:51']")),
        groupExpanded: Boolean(document.querySelector("[data-node-id='group:collapsed'] [title='Collapse']"))
      };
    });

    expect(result.commands).toEqual([{ type: "toggleCollapsed", nodeId: "group:collapsed" }]);
    expect(result.requests).toEqual([expect.objectContaining({ query: "", targetNodeId: undefined })]);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toContain(3);
    expect(result.hasHiddenChild50).toBe(true);
    expect(result.hasHiddenChild51).toBe(true);
    expect(result.groupExpanded).toBe(true);
    expect(issues).toEqual([]);
  });

  test("psh-collapsed-parent-collapse-patch-hides-loaded-children", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadCollapsedBoundarySidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      coverCollapsedParent: true,
      startExpanded: true
    });

    await nodeRow(page, "group:collapsed").getByRole("button", { name: "Collapse", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitCollapsedPatch("group:collapsed", true);
      await api.waitForIdleFrames(6);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows(),
        hasHiddenChild50: Boolean(document.querySelector("[data-node-id='tab:50']")),
        hasHiddenChild51: Boolean(document.querySelector("[data-node-id='tab:51']")),
        groupCollapsed: Boolean(document.querySelector("[data-node-id='group:collapsed'] [title='Expand']"))
      };
    });

    expect(result.commands).toEqual([{ type: "toggleCollapsed", nodeId: "group:collapsed" }]);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toEqual([0, 1, 2, 3]);
    expect(result.hasHiddenChild50).toBe(false);
    expect(result.hasHiddenChild51).toBe(false);
    expect(result.groupCollapsed).toBe(true);
    expect(issues).toEqual([]);
  });

  test("psh-collapsed-hidden-child-show-in-tree-expand-patch-keeps-target-owner", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadCollapsedBoundarySidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      coverCollapsedParent: true
    });

    await page.locator("#search").fill("Hidden child");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForProjectionRequest("Hidden child");
      api.resolveSliceForQuery("Hidden child");
      await api.waitForVisibleRow(2);
      await api.waitForIdleFrames(3);
    });

    await nodeRow(page, "tab:50").hover();
    await nodeRow(page, "tab:50").getByRole("button", { name: "Show in tree", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForTargetProjectionRequest("tab:50");
      api.emitCollapsedPatch("group:collapsed", false);
      api.resolveSliceForTarget("tab:50", { includeCoverage: true });
      await api.waitForVisibleRow(3);
      await api.waitForIdleFrames(4);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        hasHiddenChild50: Boolean(document.querySelector("[data-node-id='tab:50']")),
        hasHiddenChild51: Boolean(document.querySelector("[data-node-id='tab:51']")),
        hasRevealHighlight: Boolean(document.querySelector("[data-node-id='tab:50'].is-reveal-highlight")),
        hasSearchMatch: Boolean(document.querySelector("[data-node-id='tab:50'].is-search-match")),
        groupExpanded: Boolean(document.querySelector("[data-node-id='group:collapsed'] [title='Collapse']"))
      };
    });

    expect(result.commands).toEqual([{ type: "expandAncestors", nodeId: "tab:50" }]);
    expect(result.requests.slice(0, 2).map((request) => ({
      query: request.query,
      targetNodeId: request.targetNodeId
    }))).toEqual([
      { query: "Hidden child", targetNodeId: undefined },
      { query: "", targetNodeId: "tab:50" }
    ]);
    expect(result.requests.slice(2).every((request) => request.query === "" && request.targetNodeId === undefined))
      .toBe(true);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.visibleRows).toContain(3);
    expect(result.hasHiddenChild50).toBe(true);
    expect(result.hasHiddenChild51).toBe(true);
    expect(result.hasRevealHighlight).toBe(true);
    expect(result.hasSearchMatch).toBe(false);
    expect(result.groupExpanded).toBe(true);
    expect(issues).toEqual([]);
  });

  test("psh-collapsed-search-clear-ignores-stale-hidden-child-response", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadCollapsedBoundarySidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      coverCollapsedParent: true
    });

    await page.locator("#search").fill("Hidden child");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForProjectionRequest("Hidden child");
    });
    await page.locator("#clear-search").click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(2);
      api.resolveSliceForQuery("Hidden child");
      await api.waitForIdleFrames(3);
      const afterStaleSearch = {
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasHiddenChild50: Boolean(document.querySelector("[data-node-id='tab:50']")),
        hasHiddenChild51: Boolean(document.querySelector("[data-node-id='tab:51']")),
        hasSearchChrome: Boolean(document.querySelector(".is-search-match, .is-search-path"))
      };

      api.resolveSliceAt(0, { includeCoverage: true });
      await api.waitForIdleFrames(4);
      return {
        requests: api.projectionRequests(),
        afterStaleSearch,
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasHiddenChild50: Boolean(document.querySelector("[data-node-id='tab:50']")),
        hasHiddenChild51: Boolean(document.querySelector("[data-node-id='tab:51']")),
        hasSearchChrome: Boolean(document.querySelector(".is-search-match, .is-search-path")),
        groupCollapsed: Boolean(document.querySelector("[data-node-id='group:collapsed'] [title='Expand']"))
      };
    });

    expect(result.requests[0]).toMatchObject({ query: "Hidden child", targetNodeId: undefined });
    expect(result.requests.slice(1).every((request) => request.query === "" && request.targetNodeId === undefined))
      .toBe(true);
    expect(result.afterStaleSearch.searchValue).toBe("");
    expect(result.afterStaleSearch.countText).toBe("6 items / 0 saved");
    expect(result.afterStaleSearch.hasHiddenChild50).toBe(false);
    expect(result.afterStaleSearch.hasHiddenChild51).toBe(false);
    expect(result.afterStaleSearch.hasSearchChrome).toBe(false);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("6 items / 0 saved");
    expect(result.visibleRows.length).toBeGreaterThan(0);
    expect(result.hasHiddenChild50).toBe(false);
    expect(result.hasHiddenChild51).toBe(false);
    expect(result.hasSearchChrome).toBe(false);
    expect(result.groupCollapsed).toBe(true);
    expect(issues).toEqual([]);
  });

  test("psh-collapsed-search-hidden-child-title-patch-prunes-current-query", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadCollapsedBoundarySidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      coverCollapsedParent: true
    });

    await page.locator("#search").fill("Hidden child");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForProjectionRequest("Hidden child");
      api.resolveSliceForQuery("Hidden child");
      await api.waitForVisibleRow(2);
      await api.waitForIdleFrames(3);
      api.emitTitlePatch("tab:50", "Renamed away from query");
      await api.waitForSparseRequestCount(2);
      api.resolveSliceForQuery("Hidden child");
      await api.waitForIdleFrames(4);
    });

    const result = await page.evaluate(() => ({
      requests: projectionHuntApi().projectionRequests(),
      stateRequests: projectionHuntApi().stateRequestCount(),
      searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
      countText: document.querySelector("#state-count")?.textContent ?? "",
      visibleRows: projectionHuntApi().visibleRows(),
      hasHiddenChild50: Boolean(document.querySelector("[data-node-id='tab:50']")),
      hasHiddenChild51: Boolean(document.querySelector("[data-node-id='tab:51']")),
      hasGroupPath: Boolean(document.querySelector("[data-node-id='group:collapsed'].is-search-path")),
      hasOutlineTail: Boolean(document.querySelector("[data-node-id='tab:90']"))
    }));

    expect(result.requests.map((request) => request.query)).toEqual(["Hidden child", "Hidden child"]);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("Hidden child");
    expect(result.countText).toBe("1 match / 6 items");
    expect(result.visibleRows).toContain(2);
    expect(result.hasHiddenChild50).toBe(false);
    expect(result.hasHiddenChild51).toBe(true);
    expect(result.hasGroupPath).toBe(true);
    expect(result.hasOutlineTail).toBe(false);
    expect(issues).toEqual([]);
  });

  test("psh-collapsed-search-hidden-child-delete-history-refills-current-query", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadCollapsedBoundarySidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      coverCollapsedParent: true,
      historyStatus: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
    });

    await page.locator("#search").fill("Hidden child");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForProjectionRequest("Hidden child");
      api.resolveSliceForQuery("Hidden child");
      await api.waitForVisibleRow(2);
      await api.waitForIdleFrames(3);
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "delete child" });
      api.emitDeletePatch(["tab:50"]);
      await api.waitForSparseRequestCount(2);
      api.resolveSliceForQuery("Hidden child");
      await api.waitForIdleFrames(4);
    });

    const result = await page.evaluate(() => ({
      requests: projectionHuntApi().projectionRequests(),
      stateRequests: projectionHuntApi().stateRequestCount(),
      searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
      countText: document.querySelector("#state-count")?.textContent ?? "",
      visibleRows: projectionHuntApi().visibleRows(),
      hasHiddenChild50: Boolean(document.querySelector("[data-node-id='tab:50']")),
      hasHiddenChild51: Boolean(document.querySelector("[data-node-id='tab:51']")),
      hasGroupPath: Boolean(document.querySelector("[data-node-id='group:collapsed'].is-search-path")),
      hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
    }));

    expect(result.requests.map((request) => request.query)).toEqual(["Hidden child", "Hidden child"]);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("Hidden child");
    expect(result.countText).toBe("1 match / 5 items");
    expect(result.visibleRows).toContain(2);
    expect(result.hasHiddenChild50).toBe(false);
    expect(result.hasHiddenChild51).toBe(true);
    expect(result.hasGroupPath).toBe(true);
    expect(result.hasRevealHighlight).toBe(false);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-collapsed-collapse-hovered-hidden-child-clears-actions", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadCollapsedBoundarySidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      coverCollapsedParent: true,
      startExpanded: true
    });

    await nodeRow(page, "tab:50").hover();
    await expect(nodeRow(page, "tab:50").getByRole("button", { name: "Cut", exact: true })).toBeVisible();
    await nodeRow(page, "group:collapsed").getByRole("button", { name: "Collapse", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitCollapsedPatch("group:collapsed", true);
      await api.waitForIdleFrames(6);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows(),
        hasHiddenChild50: Boolean(document.querySelector("[data-node-id='tab:50']")),
        hasHiddenChild51: Boolean(document.querySelector("[data-node-id='tab:51']")),
        hiddenChildActionCount: document.querySelectorAll("[data-node-id='tab:50'] button").length,
        groupCollapsed: Boolean(document.querySelector("[data-node-id='group:collapsed'] [title='Expand']"))
      };
    });

    expect(result.commands).toEqual([{ type: "toggleCollapsed", nodeId: "group:collapsed" }]);
    expect(result.requests).toEqual([]);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toEqual([0, 1, 2, 3]);
    expect(result.hasHiddenChild50).toBe(false);
    expect(result.hasHiddenChild51).toBe(false);
    expect(result.hiddenChildActionCount).toBe(0);
    expect(result.groupCollapsed).toBe(true);
    expect(issues).toEqual([]);
  });

  test("psh-collapsed-search-parent-delete-clears-hidden-path", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadCollapsedBoundarySidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      coverCollapsedParent: true,
      historyStatus: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
    });

    await page.locator("#search").fill("Hidden child");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForProjectionRequest("Hidden child");
      api.resolveSliceForQuery("Hidden child");
      await api.waitForVisibleRow(2);
      await api.waitForIdleFrames(3);
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "delete group" });
      api.emitDeletePatch(["group:collapsed", "tab:50", "tab:51"]);
      await api.waitForIdleFrames(4);
      if (api.sparseRequestCount() > 1) {
        api.resolveSliceForQuery("Hidden child");
        await api.waitForIdleFrames(4);
      }
    });

    const result = await page.evaluate(() => ({
      requests: projectionHuntApi().projectionRequests(),
      stateRequests: projectionHuntApi().stateRequestCount(),
      searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
      countText: document.querySelector("#state-count")?.textContent ?? "",
      visibleRows: projectionHuntApi().visibleRows(),
      hasGroupPath: Boolean(document.querySelector("[data-node-id='group:collapsed']")),
      hasHiddenChild50: Boolean(document.querySelector("[data-node-id='tab:50']")),
      hasHiddenChild51: Boolean(document.querySelector("[data-node-id='tab:51']")),
      hasOutlineTail: Boolean(document.querySelector("[data-node-id='tab:90']")),
      hiddenActionCount: document.querySelectorAll("[data-node-id='tab:50'] button, [data-node-id='tab:51'] button").length
    }));

    expect(result.requests[0]).toMatchObject({ query: "Hidden child", targetNodeId: undefined });
    expect(result.requests.slice(1).every((request) => request.query === "Hidden child" && request.targetNodeId === undefined))
      .toBe(true);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("Hidden child");
    expect(result.countText).toBe("0 matches / 3 items");
    expect(result.visibleRows).toEqual([]);
    expect(result.hasGroupPath).toBe(false);
    expect(result.hasHiddenChild50).toBe(false);
    expect(result.hasHiddenChild51).toBe(false);
    expect(result.hasOutlineTail).toBe(false);
    expect(result.hiddenActionCount).toBe(0);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-collapsed-search-clear-hides-hidden-results-and-clears-actions", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadCollapsedBoundarySidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      coverCollapsedParent: true
    });

    await page.locator("#search").fill("Hidden child");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForProjectionRequest("Hidden child");
      api.resolveSliceForQuery("Hidden child");
      await api.waitForVisibleRow(2);
      await api.waitForIdleFrames(3);
    });
    await nodeRow(page, "tab:50").hover();
    await expect(nodeRow(page, "tab:50").getByRole("button", { name: "Cut", exact: true })).toBeVisible();
    await page.locator("#clear-search").click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForSparseRequestCount(2);
      api.resolveSliceAt(0, { includeCoverage: true });
      await api.waitForIdleFrames(4);
      return {
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasHiddenChild50: Boolean(document.querySelector("[data-node-id='tab:50']")),
        hasHiddenChild51: Boolean(document.querySelector("[data-node-id='tab:51']")),
        hasSearchChrome: Boolean(document.querySelector(".is-search-match, .is-search-path")),
        hiddenActionCount: document.querySelectorAll("[data-node-id='tab:50'] button, [data-node-id='tab:51'] button").length,
        groupCollapsed: Boolean(document.querySelector("[data-node-id='group:collapsed'] [title='Expand']"))
      };
    });

    expect(result.requests[0]).toMatchObject({ query: "Hidden child", targetNodeId: undefined });
    expect(result.requests.slice(1).every((request) => request.query === "" && request.targetNodeId === undefined))
      .toBe(true);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("6 items / 0 saved");
    expect(result.visibleRows.length).toBeGreaterThan(0);
    expect(result.hasHiddenChild50).toBe(false);
    expect(result.hasHiddenChild51).toBe(false);
    expect(result.hasSearchChrome).toBe(false);
    expect(result.hiddenActionCount).toBe(0);
    expect(result.groupCollapsed).toBe(true);
    expect(issues).toEqual([]);
  });

  test("psh-collapsed-drag-preview-clears-when-parent-collapses-mid-drag", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadCollapsedBoundarySidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      coverCollapsedParent: true,
      startExpanded: true
    });

    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    try {
      await nodeRow(page, "tab:50").dispatchEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer
      });
      const clientY = await nodeRow(page, "tab:51").evaluate((row) => row.getBoundingClientRect().bottom - 1);
      await nodeRow(page, "tab:51").dispatchEvent("dragover", {
        bubbles: true,
        cancelable: true,
        clientY,
        dataTransfer
      });

      const result = await page.evaluate(async () => {
        const api = projectionHuntApi();
        const markerBefore = document.querySelector<HTMLElement>("[data-testid='drop-marker']");
        api.emitCollapsedPatch("group:collapsed", true);
        await api.waitForIdleFrames(6);
        const markerAfter = document.querySelector<HTMLElement>("[data-testid='drop-marker']");
        return {
          commands: api.sentCommands(),
          requests: api.projectionRequests(),
          stateRequests: api.stateRequestCount(),
          visibleRows: api.visibleRows(),
          hasHiddenChild50: Boolean(document.querySelector("[data-node-id='tab:50']")),
          hasHiddenChild51: Boolean(document.querySelector("[data-node-id='tab:51']")),
          markerBeforeClassName: markerBefore?.className ?? "",
          markerAfterClassName: markerAfter?.className ?? "",
          rootDropTarget: document.querySelector<HTMLElement>("main")?.classList.contains("root-drop-target") ?? false
        };
      });
      await page.locator("main").dispatchEvent("dragend", {
        bubbles: true,
        cancelable: true,
        dataTransfer
      });

      expect(result.commands).toEqual([]);
      expect(result.requests).toEqual([]);
      expect(result.stateRequests).toBe(0);
      expect(result.visibleRows).toEqual([0, 1, 2, 3]);
      expect(result.hasHiddenChild50).toBe(false);
      expect(result.hasHiddenChild51).toBe(false);
      expect(result.markerBeforeClassName).toMatch(/drop-after/);
      expect(result.markerAfterClassName).not.toMatch(/drop-root|drop-before|drop-after|drop-inside/);
      expect(result.rootDropTarget).toBe(false);
      expect(issues).toEqual([]);
    } finally {
      await dataTransfer.dispose();
    }
  });

  test("psh-two-sidebars-collapse-outline-keeps-other-search-hidden-results", async ({ page }) => {
    const issuesA = collectPageIssues(page);
    await loadCollapsedBoundarySidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      coverCollapsedParent: true,
      startExpanded: true
    });

    const pageB = await page.context().newPage();
    const issuesB = collectPageIssues(pageB);
    try {
      await loadCollapsedBoundarySidebar(pageB, {
        includeCoverage: true,
        fullStatePending: true,
        coverCollapsedParent: true
      });
      await pageB.locator("#search").fill("Hidden child");
      await pageB.evaluate(async () => {
        const api = projectionHuntApi();
        await api.waitForProjectionRequest("Hidden child");
        api.resolveSliceForQuery("Hidden child");
        await api.waitForVisibleRow(2);
        await api.waitForIdleFrames(3);
      });

      await nodeRow(page, "group:collapsed").getByRole("button", { name: "Collapse", exact: true }).click();

      const [resultA, resultB] = await Promise.all([
        page.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitCollapsedPatch("group:collapsed", true);
          await api.waitForIdleFrames(6);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            visibleRows: api.visibleRows(),
            hasHiddenChild50: Boolean(document.querySelector("[data-node-id='tab:50']")),
            groupCollapsed: Boolean(document.querySelector("[data-node-id='group:collapsed'] [title='Expand']"))
          };
        }),
        pageB.evaluate(async () => {
          const api = projectionHuntApi();
          api.emitCollapsedPatch("group:collapsed", true);
          await api.waitForIdleFrames(6);
          return {
            commands: api.sentCommands(),
            requests: api.projectionRequests(),
            stateRequests: api.stateRequestCount(),
            searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
            countText: document.querySelector("#state-count")?.textContent ?? "",
            visibleRows: api.visibleRows(),
            hasHiddenChild50: Boolean(document.querySelector("[data-node-id='tab:50']")),
            hasHiddenChild51: Boolean(document.querySelector("[data-node-id='tab:51']")),
            hasGroupPath: Boolean(document.querySelector("[data-node-id='group:collapsed'].is-search-path"))
          };
        })
      ]);

      expect(resultA.commands).toEqual([{ type: "toggleCollapsed", nodeId: "group:collapsed" }]);
      expect(resultA.requests).toEqual([]);
      expect(resultA.stateRequests).toBe(0);
      expect(resultA.searchValue).toBe("");
      expect(resultA.visibleRows).toEqual([0, 1, 2, 3]);
      expect(resultA.hasHiddenChild50).toBe(false);
      expect(resultA.groupCollapsed).toBe(true);

      expect(resultB.commands).toEqual([]);
      expect(resultB.requests).toEqual([expect.objectContaining({ query: "Hidden child", targetNodeId: undefined })]);
      expect(resultB.stateRequests).toBe(0);
      expect(resultB.searchValue).toBe("Hidden child");
      expect(resultB.countText).toBe("2 matches / 6 items");
      expect(resultB.visibleRows).toContain(2);
      expect(resultB.hasHiddenChild50).toBe(true);
      expect(resultB.hasHiddenChild51).toBe(true);
      expect(resultB.hasGroupPath).toBe(true);
      expect(issuesA).toEqual([]);
      expect(issuesB).toEqual([]);
    } finally {
      await pageB.close();
    }
  });

  test("psh-collapsed-expanded-child-delete-keeps-viewport-filled", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadCollapsedBoundarySidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      coverCollapsedParent: true,
      startExpanded: true,
      historyStatus: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
    });

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "delete child" });
      api.emitDeletePatch(["tab:50"]);
      await api.waitForIdleFrames(6);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasHiddenChild50: Boolean(document.querySelector("[data-node-id='tab:50']")),
        hasHiddenChild51: Boolean(document.querySelector("[data-node-id='tab:51']")),
        hasTail: Boolean(document.querySelector("[data-node-id='tab:90']")),
        groupExpanded: Boolean(document.querySelector("[data-node-id='group:collapsed'] [title='Collapse']"))
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests.every((request) => request.query === "" && request.targetNodeId === undefined)).toBe(true);
    expect(result.stateRequests).toBe(0);
    expect(result.countText).toBe("5 items / 0 saved");
    expect(result.visibleRows).toContain(3);
    expect(result.hasHiddenChild50).toBe(false);
    expect(result.hasHiddenChild51).toBe(true);
    expect(result.hasTail).toBe(true);
    expect(result.groupExpanded).toBe(true);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("psh-collapsed-search-hidden-child-full-broadcast-keeps-search-owner", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadCollapsedBoundarySidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      coverCollapsedParent: true
    });

    await page.locator("#search").fill("Hidden child");
    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForProjectionRequest("Hidden child");
      api.resolveSliceForQuery("Hidden child");
      await api.waitForVisibleRow(2);
      api.emitFullStateBroadcast();
      await api.waitForIdleFrames(8);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasHiddenChild50: Boolean(document.querySelector("[data-node-id='tab:50']")),
        hasHiddenChild51: Boolean(document.querySelector("[data-node-id='tab:51']")),
        hasGroupPath: Boolean(document.querySelector("[data-node-id='group:collapsed'].is-search-path")),
        hasRevealHighlight: Boolean(document.querySelector(".is-reveal-highlight"))
      };
    });

    expect(result.commands).toEqual([]);
    expect(result.requests).toEqual([expect.objectContaining({ query: "Hidden child", targetNodeId: undefined })]);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("Hidden child");
    expect(result.countText).toBe("2 matches / 6 items");
    expect(result.visibleRows).toContain(2);
    expect(result.hasHiddenChild50).toBe(true);
    expect(result.hasHiddenChild51).toBe(true);
    expect(result.hasGroupPath).toBe(true);
    expect(result.hasRevealHighlight).toBe(false);
    expect(issues).toEqual([]);
  });

  test("psh-collapsed-hidden-child-target-full-broadcast-keeps-reveal", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadCollapsedBoundarySidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      coverCollapsedParent: true
    });

    await page.locator("#search").fill("Hidden child");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForProjectionRequest("Hidden child");
      api.resolveSliceForQuery("Hidden child");
      await api.waitForVisibleRow(2);
      await api.waitForIdleFrames(3);
    });
    await nodeRow(page, "tab:50").hover();
    await nodeRow(page, "tab:50").getByRole("button", { name: "Show in tree", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForTargetProjectionRequest("tab:50");
      api.emitCollapsedPatch("group:collapsed", false);
      api.resolveSliceForTarget("tab:50", { includeCoverage: true });
      await api.waitForVisibleRow(3);
      api.emitFullStateBroadcast();
      await api.waitForIdleFrames(8);
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        hasHiddenChild50: Boolean(document.querySelector("[data-node-id='tab:50']")),
        hasRevealHighlight: Boolean(document.querySelector("[data-node-id='tab:50'].is-reveal-highlight")),
        hasSearchMatch: Boolean(document.querySelector("[data-node-id='tab:50'].is-search-match")),
        groupExpanded: Boolean(document.querySelector("[data-node-id='group:collapsed'] [title='Collapse']"))
      };
    });

    expect(result.commands).toEqual([{ type: "expandAncestors", nodeId: "tab:50" }]);
    expect(result.requests.slice(0, 2).map((request) => ({
      query: request.query,
      targetNodeId: request.targetNodeId
    }))).toEqual([
      { query: "Hidden child", targetNodeId: undefined },
      { query: "", targetNodeId: "tab:50" }
    ]);
    expect(result.requests.slice(2).every((request) => request.query === "" && request.targetNodeId === undefined))
      .toBe(true);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("6 items / 0 saved");
    expect(result.visibleRows).toContain(3);
    expect(result.hasHiddenChild50).toBe(true);
    expect(result.hasRevealHighlight).toBe(true);
    expect(result.hasSearchMatch).toBe(false);
    expect(result.groupExpanded).toBe(true);
    expect(issues).toEqual([]);
  });

  test("psh-collapsed-hidden-child-move-before-target-response-reveals-moved-row", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadCollapsedBoundarySidebar(page, {
      includeCoverage: true,
      fullStatePending: true,
      coverCollapsedParent: true
    });

    await page.locator("#search").fill("Hidden child");
    await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForProjectionRequest("Hidden child");
      api.resolveSliceForQuery("Hidden child");
      await api.waitForVisibleRow(2);
      await api.waitForIdleFrames(3);
    });
    await nodeRow(page, "tab:50").hover();
    await nodeRow(page, "tab:50").getByRole("button", { name: "Show in tree", exact: true }).click();

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForTargetProjectionRequest("tab:50");
      api.emitMovePatch("tab:50", "window:1", 2);
      api.resolveSliceForTarget("tab:50", { includeCoverage: true });
      await api.waitForVisibleRow(3);
      await api.waitForIdleFrames(6);
      const targetNode = document.querySelector<HTMLElement>("[data-node-id='tab:50']");
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        countText: document.querySelector("#state-count")?.textContent ?? "",
        visibleRows: api.visibleRows(),
        targetRowIndex: targetNode?.dataset.rowIndex ?? "",
        hasHiddenChild50: Boolean(targetNode),
        hasHiddenChild51: Boolean(document.querySelector("[data-node-id='tab:51']")),
        hasRevealHighlight: Boolean(document.querySelector("[data-node-id='tab:50'].is-reveal-highlight")),
        hasSearchMatch: Boolean(document.querySelector("[data-node-id='tab:50'].is-search-match")),
        groupCollapsed: Boolean(document.querySelector("[data-node-id='group:collapsed'] [title='Expand']"))
      };
    });

    expect(result.commands).toEqual([{ type: "expandAncestors", nodeId: "tab:50" }]);
    expect(result.requests.slice(0, 2).map((request) => ({
      query: request.query,
      targetNodeId: request.targetNodeId
    }))).toEqual([
      { query: "Hidden child", targetNodeId: undefined },
      { query: "", targetNodeId: "tab:50" }
    ]);
    expect(result.requests.slice(2).every((request) => request.query === "" && request.targetNodeId === undefined))
      .toBe(true);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("");
    expect(result.countText).toBe("6 items / 0 saved");
    expect(result.visibleRows).toContain(3);
    expect(result.targetRowIndex).toBe("3");
    expect(result.hasHiddenChild50).toBe(true);
    expect(result.hasHiddenChild51).toBe(false);
    expect(result.hasRevealHighlight).toBe(true);
    expect(result.hasSearchMatch).toBe(false);
    expect(result.groupCollapsed).toBe(true);
    expect(issues).toEqual([]);
  });

  test("psh-restored-tab-root-drop-creates-window-before-hydration", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadRestoredWindowSidebar(page, { fullStatePending: true });

    await dragToRoot(page, "tab:2");

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      await api.waitForIdleFrames(3);
      const marker = document.querySelector<HTMLElement>("[data-testid='drop-marker']");
      const root = document.querySelector<HTMLElement>("main");
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        visibleRows: api.visibleRows(),
        markerClassName: marker?.className ?? "",
        rootDropTarget: root?.classList.contains("root-drop-target") ?? false
      };
    });

    expect(result.commands).toEqual([{ type: "moveNodeToNewWindow", nodeId: "tab:2", index: 2 }]);
    expect(result.requests).toEqual([]);
    expect(result.stateRequests).toBe(0);
    expect(result.visibleRows).toContain(3);
    expect(result.markerClassName).not.toMatch(/drop-root|drop-before|drop-after|drop-inside/);
    expect(result.rootDropTarget).toBe(false);
    expect(issues).toEqual([]);
  });

  test("psh-restored-tab-root-drop-search-replacement-keeps-query-owner", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadRestoredWindowSidebar(page, { fullStatePending: true });

    await dragToRoot(page, "tab:2");
    await page.locator("#search").fill("Existing tab");

    const result = await page.evaluate(async () => {
      const api = projectionHuntApi();
      api.emitHistoryStatus({ canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0, undoLabel: "root drop" });
      await api.waitForIdleFrames(4);
      const marker = document.querySelector<HTMLElement>("[data-testid='drop-marker']");
      const root = document.querySelector<HTMLElement>("main");
      return {
        commands: api.sentCommands(),
        requests: api.projectionRequests(),
        stateRequests: api.stateRequestCount(),
        searchValue: document.querySelector<HTMLInputElement>("#search")?.value ?? "",
        visibleRows: api.visibleRows(),
        hasExistingTab: Boolean(document.querySelector("[data-node-id='tab:1']")),
        hasRestoredTab: Boolean(document.querySelector("[data-node-id='tab:2']")),
        markerClassName: marker?.className ?? "",
        rootDropTarget: root?.classList.contains("root-drop-target") ?? false
      };
    });

    expect(result.commands).toEqual([{ type: "moveNodeToNewWindow", nodeId: "tab:2", index: 2 }]);
    expect(result.requests).toEqual([]);
    expect(result.stateRequests).toBe(0);
    expect(result.searchValue).toBe("Existing tab");
    expect(result.visibleRows).toContain(1);
    expect(result.hasExistingTab).toBe(true);
    expect(result.hasRestoredTab).toBe(false);
    expect(result.markerClassName).not.toMatch(/drop-root|drop-before|drop-after|drop-inside/);
    expect(result.rootDropTarget).toBe(false);
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

async function loadRestoredSubgroupSidebar(
  page: Page,
  options: { fullStatePending?: boolean } = {}
): Promise<void> {
  await page.addInitScript(({ installerSource, harnessOptions }) => {
    const install = (0, eval)(`(${installerSource})`) as typeof installProjectionHuntHarness;
    install(harnessOptions);
  }, {
    installerSource: installProjectionHuntHarness.toString(),
    harnessOptions: {
      totalRows: 5,
      initialStart: 0,
      initialEnd: 4,
      activeTabId: 0,
      fullStatePending: Boolean(options.fullStatePending),
      includeCoverage: true,
      restoredFixture: false,
      restoredSubgroupFixture: true
    }
  });

  await page.goto("/sidebar/sidebar.html");
  await waitForSidebarAppReady(page);
  await expect(page.locator(nodeSelector("window:restored-subgroup"))).toBeVisible();
  await expect(page.locator(nodeSelector("tab:performance"))).toBeVisible();
  await expect(page.locator(nodeSelector("tab:annotate"))).toBeVisible();
  await expect(page.locator(nodeSelector("tab:s3"))).toBeVisible();
}

async function loadSparseNamedGroupSidebar(
  page: Page,
  options: { fullStatePending?: boolean } = {}
): Promise<void> {
  await page.addInitScript(({ installerSource, harnessOptions }) => {
    const install = (0, eval)(`(${installerSource})`) as typeof installProjectionHuntHarness;
    install(harnessOptions);
  }, {
    installerSource: installProjectionHuntHarness.toString(),
    harnessOptions: {
      totalRows: 6,
      initialStart: 0,
      initialEnd: 4,
      activeTabId: 0,
      fullStatePending: Boolean(options.fullStatePending),
      includeCoverage: true,
      restoredFixture: false,
      namedGroupRootsFixture: true
    }
  });

  await page.goto("/sidebar/sidebar.html");
  await waitForSidebarAppReady(page);
  await expect(page.locator(nodeSelector("window:named-group"))).toBeVisible();
  await expect(page.locator(nodeSelector("window:tail"))).toHaveCount(0);
}

async function loadClosedRestoreSidebar(
  page: Page,
  options: { fullStatePending?: boolean; invalidRestoreScope?: boolean; delayRestoreScope?: boolean } = {}
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
      invalidRestoreScope: Boolean(options.invalidRestoreScope),
      delayRestoreScope: Boolean(options.delayRestoreScope)
    }
  });

  await page.goto("/sidebar/sidebar.html");
  await waitForSidebarAppReady(page);
  await expect(page.locator(nodeSelector("window:30"))).toBeVisible();
}

async function loadCollapsedBoundarySidebar(
  page: Page,
  options: {
    fullStatePending?: boolean;
    includeCoverage?: boolean;
    coverCollapsedParent?: boolean;
    startExpanded?: boolean;
    historyStatus?: HarnessHistoryStatus;
  } = {}
): Promise<void> {
  await page.addInitScript(({ installerSource, harnessOptions }) => {
    const install = (0, eval)(`(${installerSource})`) as typeof installProjectionHuntHarness;
    install(harnessOptions);
  }, {
    installerSource: installProjectionHuntHarness.toString(),
    harnessOptions: {
      totalRows: options.startExpanded ? 6 : 4,
      initialStart: 0,
      initialEnd: options.startExpanded ? 6 : 4,
      activeTabId: 10,
      fullStatePending: Boolean(options.fullStatePending),
      includeCoverage: options.includeCoverage !== false,
      restoredFixture: false,
      collapsedBoundaryFixture: true,
      collapsedBoundaryInitiallyExpanded: Boolean(options.startExpanded),
      coveredSiblingParentIds: options.coverCollapsedParent
        ? ["window:1", "group:collapsed"]
        : ["window:1"],
      historyStatus: options.historyStatus
    }
  });

  await page.goto("/sidebar/sidebar.html");
  await waitForSidebarAppReady(page);
  await expect(page.locator(nodeSelector("group:collapsed"))).toBeVisible();
  if (options.startExpanded) {
    await expect(page.locator(nodeSelector("tab:50"))).toBeVisible();
  } else {
    await expect(page.locator(nodeSelector("tab:50"))).toHaveCount(0);
  }
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

function expectScrollTopPreserved(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
}

function expectPassiveProjectionSideEffects(result: {
  commands: unknown[];
  stateRequestsBefore: number;
  stateRequestsAfter: number;
}): void {
  expect(result.commands).toEqual([]);
  expect(result.stateRequestsAfter).toBe(result.stateRequestsBefore);
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

async function dragInside(page: Page, sourceId: string, targetId: string): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  try {
    await nodeRow(page, sourceId).dispatchEvent("dragstart", {
      bubbles: true,
      cancelable: true,
      dataTransfer
    });
    const clientY = await nodeRow(page, targetId).evaluate((row) => {
      const rect = row.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
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

async function dragToRoot(page: Page, sourceId: string): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  try {
    await nodeRow(page, sourceId).dispatchEvent("dragstart", {
      bubbles: true,
      cancelable: true,
      dataTransfer
    });
    await page.locator("main").dispatchEvent("dragover", {
      bubbles: true,
      cancelable: true,
      clientY: 500,
      dataTransfer
    });
    await page.locator("main").dispatchEvent("drop", {
      bubbles: true,
      cancelable: true,
      clientY: 500,
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
  waitForProjectionRequest(query: string): Promise<void>;
  waitForTargetProjectionRequest(targetNodeId: string): Promise<void>;
  scrollTop(): number;
  scrollTopHistory(): number[];
  sparseRequestCount(): number;
  resolveSliceAt(index: number, override?: ProjectionSliceOverride): void;
  resolveSliceForQuery(query: string, override?: ProjectionSliceOverride): void;
  resolveSliceForTarget(targetNodeId: string, override?: ProjectionSliceOverride): void;
  resolveRestoreScope(): void;
  rejectSliceAt(index: number): void;
  visibleRows(): number[];
  expectedVisibleRows(): number[];
  waitForVisibleRow(rowIndex: number): Promise<void>;
  viewportStartRow(): number;
  resolveFullState(): void;
  emitAppendTabPatch(tabId: number): void;
  emitDeletePatch(nodeIds: string[]): void;
  emitMovePatch(nodeId: string, parentId: string, index: number): void;
  emitCollapsedPatch(nodeId: string, collapsed: boolean): void;
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

type ProjectionSliceOverride = {
  start?: number;
  end?: number;
  includeCoverage?: boolean;
  staleAtRequest?: boolean;
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
  namedGroupRootsFixture?: boolean;
  restoredSubgroupFixture?: boolean;
  closedRestoreFixture?: boolean;
  collapsedBoundaryFixture?: boolean;
  collapsedBoundaryInitiallyExpanded?: boolean;
  coveredSiblingParentIds?: string[];
  invalidRestoreScope?: boolean;
  delayRestoreScope?: boolean;
  historyStatus?: HarnessHistoryStatus;
}) {
  const now = 1_700_000_000_000;
  const rowHeight = 18;
  const listeners: Array<(message: unknown) => void> = [];
  const sentCommands: unknown[] = [];
  const stateRequests: unknown[] = [];
  const sliceRequests: ProjectionSliceRequest[] = [];
  const scrollTopSamples: number[] = [];
  const pendingSlices: Array<{
    request: ProjectionSliceRequest;
    stateAtRequest: ReturnType<typeof initialFullState>;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  const fullState = initialFullState();
  let fullStateResolver: ((value: unknown) => void) | undefined;
  let fullStateResolveQueued = false;
  let restoreScopeResolver: ((value: unknown) => void) | undefined;
  let currentHistoryStatus = options.historyStatus ?? { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 };

  window.projectionHuntApi = () => ({
    nextFrame,
    waitForIdleFrames,
    scrollToRow,
    waitForSparseRequestCount,
    waitForProjectionRequest,
    waitForTargetProjectionRequest,
    scrollTop,
    scrollTopHistory,
    sparseRequestCount: () => sliceRequests.length,
    resolveSliceAt,
    resolveSliceForQuery,
    resolveSliceForTarget,
    resolveRestoreScope,
    rejectSliceAt,
    visibleRows,
    expectedVisibleRows,
    waitForVisibleRow,
    viewportStartRow,
    resolveFullState,
    emitAppendTabPatch,
    emitDeletePatch,
    emitMovePatch,
    emitCollapsedPatch,
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
          const stateAtRequest = structuredClone(fullState) as ReturnType<typeof initialFullState>;
          sliceRequests.push(request);
          return new Promise((resolve, reject) => {
            pendingSlices.push({ request, stateAtRequest, resolve, reject });
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
          const response = restoreScopeResponse();
          if (options.delayRestoreScope) {
            return new Promise((resolve) => {
              restoreScopeResolver = resolve;
            });
          }
          return response;
        }
        if (
          type === "closeNode" ||
          type === "deleteNode" ||
          type === "restoreNode" ||
          type === "toggleCollapsed" ||
          type === "moveNode" ||
          type === "moveNodeToNewWindow" ||
          type === "wrapNodeInGroup" ||
          type === "moveSubtreeToTopLevel" ||
          type === "moveSubtreeToBottomTopLevel" ||
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

  function resolveSliceAt(index: number, override: ProjectionSliceOverride = {}) {
    const pending = pendingSlices[index];
    if (!pending) {
      throw new Error(`No sparse slice request at index ${index}`);
    }
    pendingSlices.splice(index, 1);
    const sourceState = override.staleAtRequest ? pending.stateAtRequest : fullState;
    const projection = rowsForProjectionRequest(pending.request, override, sourceState);
    pending.resolve(snapshotFromRows(projection.rows, {
      hydrating: true,
      query: pending.request.query,
      totalRowCount: projection.totalRowCount,
      matchingNodeIds: projection.matchingNodeIds,
      ...(typeof override.includeCoverage === "boolean" ? { includeCoverage: override.includeCoverage } : {})
    }, sourceState));
  }

  function resolveSliceForQuery(
    query: string,
    override: ProjectionSliceOverride = {}
  ) {
    const index = pendingSlices.findIndex((pending) => pending.request.query === query);
    if (index < 0) {
      throw new Error(`No pending sparse slice request for query ${JSON.stringify(query)}`);
    }
    resolveSliceAt(index, override);
  }

  function resolveSliceForTarget(
    targetNodeId: string,
    override: ProjectionSliceOverride = {}
  ) {
    const index = pendingSlices.findIndex((pending) => pending.request.targetNodeId === targetNodeId);
    if (index < 0) {
      throw new Error(`No pending sparse slice request for target ${JSON.stringify(targetNodeId)}`);
    }
    resolveSliceAt(index, override);
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

  function emitAppendTabPatch(tabId: number) {
    const previous = structuredClone(fullState);
    const nodeId = `tab:${tabId}`;
    const parent = fullState.nodes["window:1"] as { childIds?: string[] } | undefined;
    if (!parent || !Array.isArray(parent.childIds)) {
      throw new Error("Cannot append tab without window:1");
    }
    parent.childIds.push(nodeId);
    fullState.nodes[nodeId] = tabNode(tabId);
    emit(treeStructureUpdate(previous, fullState, []));
  }

  function resolveRestoreScope() {
    if (!restoreScopeResolver) {
      throw new Error("No pending restore scope request");
    }
    restoreScopeResolver(restoreScopeResponse());
    restoreScopeResolver = undefined;
  }

  function restoreScopeResponse() {
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

  function emitMovePatch(nodeId: string, parentId: string, index: number) {
    const previous = structuredClone(fullState);
    const node = fullState.nodes[nodeId] as { parentId?: string } | undefined;
    const parent = fullState.nodes[parentId] as { childIds?: string[] } | undefined;
    if (!node || !parent || !Array.isArray(parent.childIds)) {
      throw new Error(`Cannot move ${nodeId} under ${parentId}`);
    }

    for (const candidate of Object.values(fullState.nodes) as Array<{ childIds?: string[] }>) {
      if (Array.isArray(candidate.childIds)) {
        candidate.childIds = candidate.childIds.filter((childId) => childId !== nodeId);
      }
    }
    const insertionIndex = Math.max(0, Math.min(parent.childIds.length, index));
    parent.childIds.splice(insertionIndex, 0, nodeId);
    node.parentId = parentId;
    emit(treeStructureUpdate(previous, fullState, []));
  }

  function emitCollapsedPatch(nodeId: string, collapsed: boolean) {
    const node = fullState.nodes[nodeId];
    if (!node) {
      throw new Error(`Missing node ${nodeId}`);
    }
    node.collapsed = collapsed;
    node.updatedAt = now + 1;
    emit({ type: "nodeStateUpdated", updatedNodes: [structuredClone(node)], closedCountDelta: 0 });
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
    const deletedClosedCount = deletedNodeIds.filter((nodeId) => previous.nodes[nodeId]?.status === "closed").length;
    return {
      type: "treeStructureUpdated",
      deletedNodeIds,
      updatedNodes,
      rootIds: [...next.rootIds],
      deletedClosedCount
    };
  }

  function snapshotFromRows(
    rows: Array<Record<string, unknown> & { nodeId: string; index: number }>,
    settings: {
      hydrating: boolean;
      query?: string;
      totalRowCount?: number;
      matchingNodeIds?: string[];
      includeCoverage?: boolean;
    },
    sourceState = fullState
  ) {
    const query = settings.query ?? "";
    const totalRowCount = settings.totalRowCount ?? options.totalRows;
    const matchingNodeIds = settings.matchingNodeIds ?? [];
    const nodes = Object.fromEntries(
      rows
        .map((row) => sourceState.nodes[row.nodeId])
        .filter(Boolean)
        .map((node) => [node.id, structuredClone(node)])
    );
    if (
      !options.restoredFixture &&
      !options.closedRestoreFixture &&
      !options.restoredSubgroupFixture &&
      !options.namedGroupRootsFixture
    ) {
      nodes["window:1"] = structuredClone(sourceState.nodes["window:1"]);
    }
    const loadedRootIds = new Set(rows.filter((row) => row.depth === 0).map((row) => row.nodeId));
    const indexes = rows.map((row) => row.index);
    return {
      type: "initialTreeSnapshot",
      version: 1,
      revision: 1,
      hydrating: settings.hydrating,
      state: {
        version: 1,
        rootIds: options.namedGroupRootsFixture
          ? sourceState.rootIds.filter((nodeId) => loadedRootIds.has(nodeId))
          : [...sourceState.rootIds],
        nodes
      },
      projection: {
        query,
        isSearchActive: query.length > 0,
        rows,
        matchingNodeIds,
        visibleNodeIds: rows.map((row) => row.nodeId),
        ...activeProjectionTarget(sourceState),
        totalRowCount,
        nodeCount: currentNodeCount(sourceState),
        closedCount: options.closedRestoreFixture ? 4 : 0,
        matchCount: matchingNodeIds.length
      },
      ...((settings.includeCoverage ?? options.includeCoverage)
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

  function rowsForProjectionRequest(
    request: ProjectionSliceRequest,
    override: { start?: number; end?: number },
    sourceState = fullState
  ) {
    if (request.query) {
      const rows = searchRowsForQuery(request.query, sourceState);
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
    if (options.restoredSubgroupFixture) {
      const centerRowIndex = request.targetNodeId ? rowIndexForNodeId(request.targetNodeId, sourceState) : request.centerRowIndex;
      const start = override.start ?? Math.max(0, Math.floor(centerRowIndex - request.rowLimit / 2));
      const end = override.end ?? Math.min(currentTotalRows(sourceState), Math.floor(centerRowIndex + request.rowLimit / 2));
      const rows = restoredSubgroupRows(sourceState).filter((row) => row.index >= start && row.index < end);
      return { rows, matchingNodeIds: [], totalRowCount: currentTotalRows(sourceState) };
    }
    if (options.namedGroupRootsFixture) {
      const centerRowIndex = request.targetNodeId ? rowIndexForNodeId(request.targetNodeId, sourceState) : request.centerRowIndex;
      const start = override.start ?? Math.max(0, Math.floor(centerRowIndex - request.rowLimit / 2));
      const end = override.end ?? Math.min(currentTotalRows(sourceState), Math.floor(centerRowIndex + request.rowLimit / 2));
      const rows = namedGroupRootRows(sourceState).filter((row) => row.index >= start && row.index < end);
      return { rows, matchingNodeIds: [], totalRowCount: currentTotalRows(sourceState) };
    }
    if (options.collapsedBoundaryFixture) {
      const centerRowIndex = request.targetNodeId ? rowIndexForNodeId(request.targetNodeId, sourceState) : request.centerRowIndex;
      const start = override.start ?? Math.max(0, Math.floor(centerRowIndex - request.rowLimit / 2));
      const end = override.end ?? Math.min(currentTotalRows(), Math.floor(centerRowIndex + request.rowLimit / 2));
      const rows = collapsedBoundaryRows().filter((row) => row.index >= start && row.index < end);
      return { rows, matchingNodeIds: [], totalRowCount: currentTotalRows() };
    }
    const centerRowIndex = request.targetNodeId ? rowIndexForNodeId(request.targetNodeId, sourceState) : request.centerRowIndex;
    const start = override.start ?? Math.max(1, Math.floor(centerRowIndex - request.rowLimit / 2));
    const end = override.end ?? Math.min(currentTotalRows(), Math.floor(centerRowIndex + request.rowLimit / 2));
    return { rows: tabRows(start, end), matchingNodeIds: [], totalRowCount: currentTotalRows() };
  }

  function searchRowsForQuery(query: string, sourceState = fullState) {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) {
      return [];
    }
    if (options.restoredSubgroupFixture) {
      return restoredSubgroupSearchRowsForQuery(normalizedQuery, sourceState);
    }
    if (options.collapsedBoundaryFixture) {
      return collapsedBoundarySearchRowsForQuery(normalizedQuery);
    }
    const matches = Object.values(sourceState.nodes)
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

  function restoredSubgroupSearchRowsForQuery(normalizedQuery: string, sourceState = fullState) {
    const window = sourceState.nodes["window:restored-subgroup"] as { childIds?: string[] } | undefined;
    const childIds = Array.isArray(window?.childIds) ? window.childIds : [];
    const matchingChildIds = childIds.filter((nodeId) => {
      const node = sourceState.nodes[nodeId] as { title?: string; url?: string } | undefined;
      return Boolean(
        node &&
        (
          String(node.title ?? "").toLocaleLowerCase().includes(normalizedQuery) ||
          String(node.url ?? "").toLocaleLowerCase().includes(normalizedQuery)
        )
      );
    });
    if (!window || matchingChildIds.length === 0) {
      return [];
    }
    const subtreeEndIndex = matchingChildIds.length + 1;
    return [
      {
        nodeId: "window:restored-subgroup",
        depth: 0,
        index: 0,
        subtreeEndIndex,
        childCount: childIds.length,
        visibleChildCount: matchingChildIds.length,
        expanded: true,
        searchRevealsCollapsedChildren: false,
        isSearchMatch: false,
        isSearchPath: true,
        insideActiveWindow: false
      },
      ...matchingChildIds.map((nodeId, index) => ({
        nodeId,
        depth: 1,
        index: index + 1,
        parentRowIndex: 0,
        subtreeEndIndex: index + 2,
        childCount: 0,
        visibleChildCount: 0,
        expanded: true,
        searchRevealsCollapsedChildren: false,
        isSearchMatch: true,
        isSearchPath: false,
        insideActiveWindow: nodeId === "tab:performance"
      }))
    ];
  }

  function collapsedBoundarySearchRowsForQuery(normalizedQuery: string) {
    const group = fullState.nodes["group:collapsed"] as { childIds?: string[] } | undefined;
    const childIds = Array.isArray(group?.childIds) ? group.childIds : [];
    const matches = childIds
      .map((nodeId) => fullState.nodes[nodeId])
      .filter((node): node is ReturnType<typeof tabNode> => (
        Boolean(node) &&
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
    const subtreeEndIndex = matches.length + 2;
    return [
      {
        ...searchWindowRow(subtreeEndIndex),
        visibleChildCount: 1
      },
      {
        nodeId: "group:collapsed",
        depth: 1,
        index: 1,
        parentRowIndex: 0,
        subtreeEndIndex,
        childCount: childIds.length,
        visibleChildCount: matches.length,
        expanded: true,
        searchRevealsCollapsedChildren: true,
        isSearchMatch: false,
        isSearchPath: true,
        insideActiveWindow: false
      },
      ...matches.map((tabId, index) => ({
        ...tabRow(tabId),
        depth: 2,
        index: index + 2,
        parentRowIndex: 1,
        subtreeEndIndex: index + 3,
        isSearchMatch: true,
        isSearchPath: false
      }))
    ];
  }

  function rowIndexForNodeId(nodeId: string, sourceState = fullState) {
    if (options.restoredSubgroupFixture) {
      const row = restoredSubgroupRows(sourceState).find((candidate) => candidate.nodeId === nodeId);
      if (row) {
        return row.index;
      }
    }
    if (options.namedGroupRootsFixture) {
      const row = namedGroupRootRows(sourceState).find((candidate) => candidate.nodeId === nodeId);
      if (row) {
        return row.index;
      }
    }
    if (options.collapsedBoundaryFixture) {
      const row = collapsedBoundaryRows().find((candidate) => candidate.nodeId === nodeId);
      if (row) {
        return row.index;
      }
    }
    if (nodeId === "window:1") {
      return 0;
    }
    const window = fullState.nodes["window:1"] as { childIds?: string[] } | undefined;
    const childIndex = Array.isArray(window?.childIds) ? window.childIds.indexOf(nodeId) : -1;
    if (childIndex >= 0) {
      return childIndex + 1;
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
    if (options.collapsedBoundaryFixture) {
      return collapsedBoundaryState();
    }
    if (options.restoredSubgroupFixture) {
      return restoredSubgroupState();
    }
    if (options.namedGroupRootsFixture) {
      return namedGroupRootState();
    }
    return options.restoredFixture ? restoredState() : largeState();
  }

  function initialRows() {
    if (options.closedRestoreFixture) {
      return closedRestoreRows();
    }
    if (options.collapsedBoundaryFixture) {
      return collapsedBoundaryRows();
    }
    if (options.restoredSubgroupFixture) {
      return restoredSubgroupRows().filter((row) => row.index >= options.initialStart && row.index < options.initialEnd);
    }
    if (options.namedGroupRootsFixture) {
      return namedGroupRootRows().filter((row) => row.index >= options.initialStart && row.index < options.initialEnd);
    }
    return options.restoredFixture
      ? restoredRows()
      : [windowRow(), ...tabRows(options.initialStart, options.initialEnd)];
  }

  function activeProjectionTarget(sourceState = fullState) {
    if (options.closedRestoreFixture) {
      return {
        activeTabNodeId: "window:30",
        activeTabRowIndex: 0
      };
    }
    if (options.restoredSubgroupFixture) {
      return sourceState.nodes["tab:performance"]
        ? {
            activeTabNodeId: "tab:performance",
            activeTabRowIndex: 1
          }
        : {};
    }
    if (options.namedGroupRootsFixture) {
      return sourceState.nodes["tab:rare-earth"]
        ? {
            activeTabNodeId: "tab:rare-earth",
            activeTabRowIndex: 1
          }
        : {};
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
    if (options.coveredSiblingParentIds) {
      return options.coveredSiblingParentIds;
    }
    if (options.restoredFixture) {
      return ["window:10", "window:20"];
    }
    if (options.restoredSubgroupFixture) {
      return ["window:restored-subgroup"];
    }
    if (options.namedGroupRootsFixture) {
      return ["window:named-group", "window:earth"];
    }
    return ["window:1"];
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

  function restoredSubgroupState() {
    return {
      version: 1,
      rootIds: ["window:restored-subgroup"],
      nodes: {
        "window:restored-subgroup": {
          id: "window:restored-subgroup",
          kind: "window",
          status: "live",
          title: "Group",
          active: true,
          collapsed: false,
          childIds: ["tab:performance", "tab:annotate", "tab:s3", "tab:offscreen"],
          createdAt: now,
          updatedAt: now,
          restoredFromClosed: true,
          live: { windowId: 40 }
        },
        "tab:performance": restoredSubgroupTabNode("tab:performance", 300, "Performance", true),
        "tab:annotate": restoredSubgroupTabNode(
          "tab:annotate",
          301,
          "Annotate DjVu | Search, Highlight, and Markup by converting DjVu to PDF",
          false
        ),
        "tab:s3": restoredSubgroupTabNode("tab:s3", 302, "djvu2pdf - S3 bucket", false),
        "tab:offscreen": restoredSubgroupTabNode("tab:offscreen", 303, "Offscreen restored child", false)
      }
    };
  }

  function restoredSubgroupTabNode(id: string, tabId: number, title: string, active: boolean) {
    return {
      id,
      kind: "tab",
      status: "live",
      parentId: "window:restored-subgroup",
      title,
      url: `https://restored-subgroup.example/${tabId}`,
      active,
      collapsed: false,
      childIds: [],
      createdAt: now,
      updatedAt: now,
      restoredFromClosed: true,
      live: { tabId, windowId: 40 }
    };
  }

  function namedGroupRootState() {
    return {
      version: 1,
      rootIds: ["window:named-group", "window:tail"],
      nodes: {
        "window:named-group": {
          id: "window:named-group",
          kind: "window",
          status: "live",
          title: "maps / earth / world",
          customTitle: "maps / earth / world",
          active: true,
          collapsed: false,
          childIds: ["tab:rare-earth", "window:earth"],
          createdAt: now,
          updatedAt: now,
          restoredFromClosed: true,
          live: { windowId: 40 }
        },
        "tab:rare-earth": namedGroupTabNode("tab:rare-earth", 401, "window:named-group", "Rare Earth - YouTube", true, 40),
        "window:earth": {
          id: "window:earth",
          kind: "window",
          status: "live",
          parentId: "window:named-group",
          title: "Google Earth",
          customTitle: "Google Earth",
          active: false,
          collapsed: false,
          childIds: ["tab:google-maps"],
          createdAt: now,
          updatedAt: now,
          restoredFromClosed: true,
          live: { windowId: 41 }
        },
        "tab:google-maps": namedGroupTabNode("tab:google-maps", 402, "window:earth", "Google Maps", false, 41),
        "window:tail": {
          id: "window:tail",
          kind: "window",
          status: "live",
          title: "Later root",
          active: false,
          collapsed: false,
          childIds: ["tab:tail"],
          createdAt: now,
          updatedAt: now,
          live: { windowId: 42 }
        },
        "tab:tail": namedGroupTabNode("tab:tail", 403, "window:tail", "Tail tab", false, 42)
      }
    };
  }

  function namedGroupTabNode(
    id: string,
    tabId: number,
    parentId: string,
    title: string,
    active: boolean,
    windowId: number
  ) {
    return {
      id,
      kind: "tab",
      status: "live",
      parentId,
      title,
      url: `https://named-group.example/${tabId}`,
      active,
      collapsed: false,
      childIds: [],
      createdAt: now,
      updatedAt: now,
      restoredFromClosed: true,
      live: { tabId, windowId }
    };
  }

  function collapsedBoundaryState() {
    return {
      version: 1,
      rootIds: ["window:1"],
      nodes: {
        "window:1": {
          id: "window:1",
          kind: "window",
          status: "live",
          title: "Window",
          active: true,
          collapsed: false,
          childIds: ["tab:10", "group:collapsed", "tab:90"],
          createdAt: now,
          updatedAt: now,
          live: { windowId: 1 }
        },
        "tab:10": tabNode(10, { parentId: "window:1", title: "Boundary source", active: true }),
        "group:collapsed": {
          id: "group:collapsed",
          kind: "group",
          status: "neutral",
          parentId: "window:1",
          title: "Collapsed saved group",
          active: false,
          collapsed: !options.collapsedBoundaryInitiallyExpanded,
          childIds: ["tab:50", "tab:51"],
          createdAt: now,
          updatedAt: now
        },
        "tab:50": tabNode(50, { parentId: "group:collapsed", title: "Hidden child 50", active: false }),
        "tab:51": tabNode(51, { parentId: "group:collapsed", title: "Hidden child 51", active: false }),
        "tab:90": tabNode(90, { parentId: "window:1", title: "Boundary tail", active: false })
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

  function currentTotalRows(sourceState = fullState) {
    if (options.closedRestoreFixture) {
      return closedRestoreRows().length;
    }
    if (options.collapsedBoundaryFixture) {
      return collapsedBoundaryRows().length;
    }
    if (options.restoredFixture) {
      return restoredRows().length;
    }
    if (options.restoredSubgroupFixture) {
      return restoredSubgroupRows(sourceState).length;
    }
    if (options.namedGroupRootsFixture) {
      return namedGroupRootRows(sourceState).length;
    }
    const window = sourceState.nodes["window:1"] as { childIds?: string[] } | undefined;
    return 1 + (Array.isArray(window?.childIds) ? window.childIds.length : 0);
  }

  function currentNodeCount(sourceState = fullState) {
    return Object.keys(sourceState.nodes).length;
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

  function restoredSubgroupRows(sourceState = fullState) {
    const window = sourceState.nodes["window:restored-subgroup"] as { childIds?: string[] } | undefined;
    if (!window) {
      return [];
    }
    const childIds = Array.isArray(window.childIds) ? window.childIds : [];
    const visibleChildIds = childIds.filter((nodeId) => Boolean(sourceState.nodes[nodeId]));
    return [
      {
        nodeId: "window:restored-subgroup",
        depth: 0,
        index: 0,
        subtreeEndIndex: 1 + visibleChildIds.length,
        childCount: childIds.length,
        visibleChildCount: visibleChildIds.length,
        expanded: true,
        searchRevealsCollapsedChildren: false,
        isSearchMatch: false,
        isSearchPath: false,
        insideActiveWindow: false
      },
      ...visibleChildIds.map((nodeId, index) => ({
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
        insideActiveWindow: nodeId === "tab:performance"
      }))
    ];
  }

  function namedGroupRootRows(sourceState = fullState) {
    const namedGroup = sourceState.nodes["window:named-group"] as { childIds?: string[] } | undefined;
    const earthGroup = sourceState.nodes["window:earth"] as { childIds?: string[] } | undefined;
    const tailGroup = sourceState.nodes["window:tail"] as { childIds?: string[] } | undefined;
    const rows: Array<Record<string, unknown> & { nodeId: string; index: number }> = [];

    if (namedGroup) {
      const namedChildren = Array.isArray(namedGroup.childIds) ? namedGroup.childIds : [];
      rows.push({
        nodeId: "window:named-group",
        depth: 0,
        index: 0,
        subtreeEndIndex: 4,
        childCount: namedChildren.length,
        visibleChildCount: namedChildren.length,
        expanded: true,
        searchRevealsCollapsedChildren: false,
        isSearchMatch: false,
        isSearchPath: false,
        insideActiveWindow: false
      });
      rows.push({
        nodeId: "tab:rare-earth",
        depth: 1,
        index: 1,
        parentRowIndex: 0,
        subtreeEndIndex: 2,
        childCount: 0,
        visibleChildCount: 0,
        expanded: true,
        searchRevealsCollapsedChildren: false,
        isSearchMatch: false,
        isSearchPath: false,
        insideActiveWindow: false
      });
    }
    if (earthGroup) {
      const earthChildren = Array.isArray(earthGroup.childIds) ? earthGroup.childIds : [];
      rows.push({
        nodeId: "window:earth",
        depth: 1,
        index: 2,
        parentRowIndex: 0,
        subtreeEndIndex: 4,
        childCount: earthChildren.length,
        visibleChildCount: earthChildren.length,
        expanded: true,
        searchRevealsCollapsedChildren: false,
        isSearchMatch: false,
        isSearchPath: false,
        insideActiveWindow: false
      });
      rows.push({
        nodeId: "tab:google-maps",
        depth: 2,
        index: 3,
        parentRowIndex: 2,
        subtreeEndIndex: 4,
        childCount: 0,
        visibleChildCount: 0,
        expanded: true,
        searchRevealsCollapsedChildren: false,
        isSearchMatch: false,
        isSearchPath: false,
        insideActiveWindow: false
      });
    }
    if (tailGroup) {
      const tailChildren = Array.isArray(tailGroup.childIds) ? tailGroup.childIds : [];
      rows.push({
        nodeId: "window:tail",
        depth: 0,
        index: 4,
        subtreeEndIndex: 6,
        childCount: tailChildren.length,
        visibleChildCount: tailChildren.length,
        expanded: true,
        searchRevealsCollapsedChildren: false,
        isSearchMatch: false,
        isSearchPath: false,
        insideActiveWindow: false
      });
      rows.push({
        nodeId: "tab:tail",
        depth: 1,
        index: 5,
        parentRowIndex: 4,
        subtreeEndIndex: 6,
        childCount: 0,
        visibleChildCount: 0,
        expanded: true,
        searchRevealsCollapsedChildren: false,
        isSearchMatch: false,
        isSearchPath: false,
        insideActiveWindow: false
      });
    }

    return rows;
  }

  function collapsedBoundaryRows() {
    const window = fullState.nodes["window:1"] as { childIds?: string[] } | undefined;
    const windowChildIds = Array.isArray(window?.childIds) ? window.childIds : [];
    const rows: Array<Record<string, unknown> & { nodeId: string; index: number }> = [];
    let nextRowIndex = 1;

    for (const childId of windowChildIds) {
      if (childId === "group:collapsed") {
        const group = fullState.nodes[childId] as { collapsed?: boolean; childIds?: string[] } | undefined;
        if (!group) {
          continue;
        }
        const groupCollapsed = group.collapsed !== false;
        const groupChildIds = Array.isArray(group.childIds) ? group.childIds : [];
        const visibleGroupChildIds = groupCollapsed
          ? []
          : groupChildIds.filter((nodeId) => Boolean(fullState.nodes[nodeId]));
        const groupIndex = nextRowIndex;
        nextRowIndex += 1;
        rows.push({
          nodeId: "group:collapsed",
          depth: 1,
          index: groupIndex,
          parentRowIndex: 0,
          subtreeEndIndex: groupIndex + 1 + visibleGroupChildIds.length,
          childCount: groupChildIds.length,
          visibleChildCount: visibleGroupChildIds.length,
          expanded: !groupCollapsed,
          searchRevealsCollapsedChildren: false,
          isSearchMatch: false,
          isSearchPath: false,
          insideActiveWindow: false
        });
        for (const groupChildId of visibleGroupChildIds) {
          const tabId = Number.parseInt(groupChildId.slice("tab:".length), 10);
          if (!Number.isFinite(tabId)) {
            continue;
          }
          rows.push({
            ...tabRow(tabId),
            depth: 2,
            index: nextRowIndex,
            parentRowIndex: groupIndex,
            subtreeEndIndex: nextRowIndex + 1,
            insideActiveWindow: false
          });
          nextRowIndex += 1;
        }
        continue;
      }

      if (!fullState.nodes[childId] || !childId.startsWith("tab:")) {
        continue;
      }
      const tabId = Number.parseInt(childId.slice("tab:".length), 10);
      if (!Number.isFinite(tabId)) {
        continue;
      }
      rows.push({
        ...tabRow(tabId),
        index: nextRowIndex,
        parentRowIndex: 0,
        subtreeEndIndex: nextRowIndex + 1,
        insideActiveWindow: tabId === options.activeTabId
      });
      nextRowIndex += 1;
    }

    const totalRows = rows.length + 1;
    return [
      {
        nodeId: "window:1",
        depth: 0,
        index: 0,
        subtreeEndIndex: totalRows,
        childCount: windowChildIds.length,
        visibleChildCount: rows.filter((row) => row.parentRowIndex === 0).length,
        expanded: true,
        searchRevealsCollapsedChildren: false,
        isSearchMatch: false,
        isSearchPath: false,
        insideActiveWindow: false
      },
      ...rows
    ];
  }

  async function nextFrame() {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    recordScrollTop();
  }

  async function waitForIdleFrames(count: number) {
    for (let index = 0; index < count; index += 1) {
      await nextFrame();
    }
  }

  async function scrollToRow(rowIndex: number) {
    const viewport = viewportElement();
    viewport.scrollTop = rowIndex * rowHeight;
    recordScrollTop();
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    await nextFrame();
  }

  function scrollTop() {
    recordScrollTop();
    return viewportElement().scrollTop;
  }

  function scrollTopHistory() {
    recordScrollTop();
    return [...scrollTopSamples];
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

  async function waitForProjectionRequest(query: string) {
    for (let index = 0; index < 180; index += 1) {
      if (sliceRequests.some((request) => request.query === query)) {
        return;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
    }
    throw new Error(`Timed out waiting for sparse slice request with query ${JSON.stringify(query)}`);
  }

  async function waitForTargetProjectionRequest(targetNodeId: string) {
    for (let index = 0; index < 180; index += 1) {
      if (sliceRequests.some((request) => request.targetNodeId === targetNodeId)) {
        return;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
    }
    throw new Error(`Timed out waiting for sparse slice request with target ${JSON.stringify(targetNodeId)}`);
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

  function expectedVisibleRows() {
    const viewport = viewportElement();
    const viewportTop = viewport.scrollTop;
    const viewportBottom = viewportTop + viewport.clientHeight;
    return allCurrentRows()
      .map((row) => row.index)
      .filter((index) => {
        const top = index * rowHeight;
        const bottom = (index + 1) * rowHeight;
        return bottom > viewportTop && top < viewportBottom;
      });
  }

  function allCurrentRows() {
    if (options.closedRestoreFixture) {
      return closedRestoreRows();
    }
    if (options.collapsedBoundaryFixture) {
      return collapsedBoundaryRows();
    }
    if (options.restoredFixture) {
      return restoredRows();
    }
    return [windowRow(), ...tabRows(1, currentTotalRows())];
  }

  function viewportStartRow() {
    return Math.floor(viewportElement().scrollTop / rowHeight);
  }

  function recordScrollTop() {
    const viewport = document.querySelector<HTMLElement>("main");
    if (!viewport) {
      return;
    }
    const current = viewport.scrollTop;
    if (scrollTopSamples.at(-1) !== current) {
      scrollTopSamples.push(current);
    }
  }

  function viewportElement() {
    const viewport = document.querySelector<HTMLElement>("main");
    if (!viewport) {
      throw new Error("Missing sidebar viewport");
    }
    return viewport;
  }
}
