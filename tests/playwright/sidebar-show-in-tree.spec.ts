import { expect, test, type Page } from "@playwright/test";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

test.describe("sidebar search result show in tree", () => {
  test("clears search, expands ancestors, and scrolls the full tree to the result", async ({
    page
  }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page);

    await page.getByRole("searchbox", { name: "Search tabs" }).fill("needle");
    await expect(page.getByRole("treeitem")).toHaveCount(3);

    await nodeRow(page, "window:1").hover();
    await expect(
      nodeRow(page, "window:1").getByRole("button", { name: "Show in tree" })
    ).toHaveCount(0);
    await nodeRow(page, "tab:parent").hover();
    await expect(
      nodeRow(page, "tab:parent").getByRole("button", { name: "Show in tree" })
    ).toHaveCount(0);

    await nodeRow(page, "tab:target").hover();
    await nodeRow(page, "tab:target").getByRole("button", { name: "Show in tree" }).click();

    await expect(page.getByRole("searchbox", { name: "Search tabs" })).toHaveValue("");
    await expect(page.getByRole("button", { name: "Clear search" })).toBeHidden();
    await expect(page.locator(nodeSelector("tab:target"))).toBeVisible();
    await expect(page.locator(`${nodeSelector("tab:target")}.is-reveal-highlight`)).toBeVisible();
    await expect(page.locator(nodeSelector("tab:target"))).toHaveAttribute("data-row-index", "82");
    await expect(outlineCollapseState(page)).resolves.toEqual({
      windowCollapsed: false,
      parentCollapsed: false
    });
    expect(await scrollTop(page)).toBeGreaterThan(500);
    await expect(page.locator(`${nodeSelector("tab:target")}.is-reveal-highlight`)).toHaveCount(0, {
      timeout: 2500
    });
    expect(issues).toEqual([]);
  });

  test("centers the target through the background before full hydration", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSparseSidebar(page);

    await page.getByRole("searchbox", { name: "Search tabs" }).fill("needle");
    await expect(page.locator(nodeSelector("tab:target"))).toBeVisible();

    await nodeRow(page, "tab:target").hover();
    await nodeRow(page, "tab:target").getByRole("button", { name: "Show in tree" }).click();

    await expect(page.getByRole("searchbox", { name: "Search tabs" })).toHaveValue("");
    await expect(page.locator(`${nodeSelector("tab:target")}.is-reveal-highlight`)).toBeVisible();
    await expect(page.locator(nodeSelector("tab:target"))).toHaveAttribute("data-row-index", "900");
    expect(await scrollTop(page)).toBeGreaterThan(15_000);

    const metrics = await page.evaluate(() => {
      const messages =
        (
          window as typeof window & {
            __showInTreeMessages?: Array<{
              type: string;
              query: string;
              centerRowIndex: number;
              targetNodeId?: string;
            }>;
          }
        ).__showInTreeMessages ?? [];
      return {
        projectionRequests: messages
          .filter((message) => message.type === "getTreeProjectionSlice")
          .map((message) => ({
            query: message.query,
            centerRowIndex: message.centerRowIndex,
            targetNodeId: message.targetNodeId
          })),
        hydrationRequests: messages.filter((message) => message.type === "getState").length
      };
    });

    expect(metrics.projectionRequests).toEqual([
      { query: "needle", centerRowIndex: 0, targetNodeId: undefined },
      { query: "", centerRowIndex: 0, targetNodeId: "tab:target" }
    ]);
    expect(metrics.hydrationRequests).toBe(0);
    expect(issues).toEqual([]);
  });
});

async function loadSidebar(page: Page): Promise<void> {
  await page.addInitScript((initialState) => {
    const state = structuredClone(initialState);
    const listeners: Array<(message: unknown) => void> = [];
    (window as typeof window & { __outlineState?: unknown }).__outlineState = state;

    window.browser = {
      runtime: {
        sendMessage: async (message: unknown) => {
          const type =
            typeof message === "object" && message
              ? (message as { type?: unknown }).type
              : undefined;
          if (type === "getInitialTreeSnapshot") {
            return undefined;
          }
          if (type === "getState") {
            return structuredClone(state);
          }
          if (type === "getHistoryStatus") {
            return {
              type: "historyStatus",
              canUndo: false,
              canRedo: false,
              undoDepth: 0,
              redoDepth: 0
            };
          }
          if (type === "getDiagnostics") {
            return {
              runtimeTabCount: 82,
              liveTabNodeCount: 82,
              visibleLiveTabNodeCount: 82,
              hiddenLiveTabNodeCount: 0,
              missingRuntimeTabIds: []
            };
          }
          if (type === "getPerformanceTrace") {
            return undefined;
          }
          if (type === "setPerformanceTraceEnabled" || type === "clearPerformanceTrace") {
            return undefined;
          }
          if (type === "expandAncestors") {
            const updatedNodes = expandAncestors(state, (message as { nodeId?: string }).nodeId);
            if (updatedNodes.length > 0) {
              const update = {
                type: "nodeStateUpdated",
                updatedNodes,
                closedCountDelta: 0
              };
              for (const listener of listeners) {
                listener(structuredClone(update));
              }
            }
            return { type: "commandAck", stateChanged: updatedNodes.length > 0 };
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
        onChanged: {
          addListener: () => undefined
        },
        local: {
          get: async () => ({}),
          set: async () => undefined
        }
      }
    };

    function expandAncestors(
      outline: { nodes: Record<string, { id: string; parentId?: string; collapsed: boolean }> },
      nodeId: string | undefined
    ) {
      const updatedNodes: Array<{ id: string; parentId?: string; collapsed: boolean }> = [];
      let parentId = nodeId ? outline.nodes[nodeId]?.parentId : undefined;
      const visited = new Set<string>();

      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = outline.nodes[parentId];
        if (!parent) {
          break;
        }
        if (parent.collapsed) {
          parent.collapsed = false;
          updatedNodes.push(parent);
        }
        parentId = parent.parentId;
      }

      return updatedNodes.reverse();
    }
  }, fixtureState());

  await page.goto("/sidebar/sidebar.html");
  await expect(page.locator("#state-count")).toHaveText("83 items / 0 saved");
}

async function loadSparseSidebar(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const now = 1_700_000_000_000;
    const totalRows = 1_002;
    const targetRowIndex = 900;
    const parentRowIndex = 899;
    const targetNodeId = "tab:target";
    const messages: Array<{
      type: string;
      query: string;
      centerRowIndex: number;
      targetNodeId?: string;
    }> = [];
    const listeners: Array<(message: unknown) => void> = [];

    Object.assign(window as typeof window & { __showInTreeMessages?: typeof messages }, {
      __showInTreeMessages: messages
    });

    window.browser = {
      runtime: {
        sendMessage: async (message: unknown) => {
          const type =
            typeof message === "object" && message
              ? String((message as { type?: unknown }).type)
              : "";
          const query =
            typeof message === "object" &&
            message &&
            typeof (message as { query?: unknown }).query === "string"
              ? (message as { query: string }).query
              : "";
          const centerRowIndex =
            typeof message === "object" &&
            message &&
            typeof (message as { centerRowIndex?: unknown }).centerRowIndex === "number"
              ? (message as { centerRowIndex: number }).centerRowIndex
              : 0;
          const requestedTargetNodeId =
            typeof message === "object" &&
            message &&
            typeof (message as { targetNodeId?: unknown }).targetNodeId === "string"
              ? (message as { targetNodeId: string }).targetNodeId
              : undefined;
          messages.push({
            type,
            query,
            centerRowIndex,
            ...(requestedTargetNodeId ? { targetNodeId: requestedTargetNodeId } : {})
          });

          if (type === "getInitialTreeSnapshot") {
            return snapshotFromRows([windowRow(), ...tabRows(1, 256)]);
          }
          if (type === "getTreeProjectionSlice") {
            if (query) {
              return snapshotFromRows(
                [
                  windowRow({ search: true }),
                  parentRow({ search: true }),
                  targetRow({ search: true })
                ],
                query
              );
            }
            const center = requestedTargetNodeId === targetNodeId ? targetRowIndex : centerRowIndex;
            return nonSearchSlice(center);
          }
          if (type === "expandAncestors") {
            window.queueMicrotask(() => {
              const update = {
                type: "nodeStateUpdated",
                updatedNodes: [parentNode({ collapsed: false })],
                closedCountDelta: 0
              };
              for (const listener of listeners) {
                listener(structuredClone(update));
              }
            });
            return { type: "commandAck", stateChanged: true };
          }
          if (type === "getState") {
            return new Promise(() => undefined);
          }
          if (type === "getHistoryStatus") {
            return {
              type: "historyStatus",
              canUndo: false,
              canRedo: false,
              undoDepth: 0,
              redoDepth: 0
            };
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
        onChanged: {
          addListener: () => undefined
        },
        local: {
          get: async () => ({}),
          set: async () => undefined
        }
      }
    };

    function nonSearchSlice(centerRowIndex: number) {
      const rowLimit = 256;
      const half = Math.floor(rowLimit / 2);
      const start = Math.max(1, Math.min(centerRowIndex - half, totalRows - rowLimit));
      const end = Math.min(totalRows, start + rowLimit);
      const rows = rowsInRange(start, end);
      return snapshotFromRows(rows);
    }

    function rowsInRange(startInclusive: number, endExclusive: number) {
      const rows: Array<Record<string, unknown> & { nodeId: string; index: number }> = [];
      for (let rowIndex = startInclusive; rowIndex < endExclusive; rowIndex += 1) {
        if (rowIndex === parentRowIndex) {
          rows.push(parentRow());
        } else if (rowIndex === targetRowIndex) {
          rows.push(targetRow());
        } else {
          rows.push(tabRow(rowIndex));
        }
      }
      return rows;
    }

    function snapshotFromRows(
      rows: Array<Record<string, unknown> & { nodeId: string; index: number }>,
      query = ""
    ) {
      const loadedNodeIds = new Set(rows.map((row) => row.nodeId));
      return {
        type: "initialTreeSnapshot",
        version: 1,
        revision: 1,
        hydrating: true,
        state: {
          version: 1,
          rootIds: loadedNodeIds.has("window:1") ? ["window:1"] : [],
          nodes: Object.fromEntries(
            rows.map((row) => {
              if (row.nodeId === "window:1") {
                return [row.nodeId, windowNode(loadedNodeIds)];
              }
              if (row.nodeId === "tab:parent") {
                return [row.nodeId, parentNode({ collapsed: !query, loadedNodeIds })];
              }
              if (row.nodeId === targetNodeId) {
                return [row.nodeId, targetNode()];
              }
              const tabId = Number.parseInt(row.nodeId.split(":")[1] ?? "", 10);
              return [row.nodeId, tabNode(tabId)];
            })
          )
        },
        projection: {
          query,
          isSearchActive: Boolean(query),
          rows,
          matchingNodeIds: query ? [targetNodeId] : [],
          visibleNodeIds: rows.map((row) => row.nodeId),
          activeTabNodeId: "tab:1",
          activeTabRowIndex: 1,
          totalRowCount: query ? 100 : totalRows,
          nodeCount: totalRows,
          closedCount: 0,
          matchCount: query ? 1 : 0
        },
        coverage: {
          startRowIndex: Math.min(...rows.map((row) => row.index)),
          endRowIndex: Math.max(...rows.map((row) => row.index)) + 1,
          editableNodeIds: rows.map((row) => row.nodeId),
          completeSubtreeNodeIds: rows.map((row) => row.nodeId),
          completeSiblingParentIds: rows.map((row) => row.nodeId)
        }
      };
    }

    function windowNode(loadedNodeIds = new Set<string>()) {
      return {
        id: "window:1",
        kind: "window",
        status: "live",
        title: "Window",
        active: true,
        collapsed: false,
        childIds: windowChildIds().filter(
          (nodeId) => loadedNodeIds.size === 0 || loadedNodeIds.has(nodeId)
        ),
        createdAt: now,
        updatedAt: now,
        live: { windowId: 1 }
      };
    }

    function windowChildIds() {
      return [
        ...Array.from({ length: parentRowIndex - 1 }, (_value, index) => `tab:${index + 1}`),
        "tab:parent",
        ...Array.from(
          { length: totalRows - targetRowIndex - 1 },
          (_value, index) => `tab:${targetRowIndex + 1 + index}`
        )
      ];
    }

    function parentNode(options: { collapsed?: boolean; loadedNodeIds?: Set<string> } = {}) {
      return {
        id: "tab:parent",
        kind: "tab",
        status: "live",
        parentId: "window:1",
        title: "Container",
        url: "https://show-in-tree.example/container",
        childIds:
          !options.loadedNodeIds || options.loadedNodeIds.has(targetNodeId) ? [targetNodeId] : [],
        collapsed: options.collapsed ?? false,
        createdAt: now,
        updatedAt: now,
        live: { tabId: 9_000, windowId: 1 }
      };
    }

    function targetNode() {
      return {
        id: targetNodeId,
        kind: "tab",
        status: "live",
        parentId: "tab:parent",
        title: "Needle target",
        url: "https://show-in-tree.example/needle",
        active: false,
        collapsed: false,
        childIds: [],
        createdAt: now,
        updatedAt: now,
        live: { tabId: 9_001, windowId: 1 }
      };
    }

    function tabNode(tabId: number) {
      return {
        id: `tab:${tabId}`,
        kind: "tab",
        status: "live",
        parentId: "window:1",
        title: `Tab ${tabId}`,
        url: `https://show-in-tree.example/${tabId}`,
        active: tabId === 1,
        collapsed: false,
        childIds: [],
        createdAt: now,
        updatedAt: now,
        live: { tabId, windowId: 1 }
      };
    }

    function windowRow(options: { search?: boolean } = {}) {
      return {
        nodeId: "window:1",
        depth: 0,
        index: 0,
        subtreeEndIndex: options.search ? 3 : totalRows,
        childCount: windowChildIds().length,
        visibleChildCount: options.search ? 1 : windowChildIds().length,
        expanded: true,
        searchRevealsCollapsedChildren: false,
        isSearchMatch: false,
        isSearchPath: Boolean(options.search),
        insideActiveWindow: false
      };
    }

    function tabRow(rowIndex: number) {
      return {
        nodeId: `tab:${rowIndex}`,
        depth: 1,
        index: rowIndex,
        parentRowIndex: 0,
        subtreeEndIndex: rowIndex + 1,
        childCount: 0,
        visibleChildCount: 0,
        expanded: true,
        searchRevealsCollapsedChildren: false,
        isSearchMatch: false,
        isSearchPath: false,
        insideActiveWindow: true
      };
    }

    function tabRows(startInclusive: number, endExclusive: number) {
      return Array.from({ length: Math.max(0, endExclusive - startInclusive) }, (_value, index) =>
        tabRow(startInclusive + index)
      );
    }

    function parentRow(options: { search?: boolean } = {}) {
      return {
        nodeId: "tab:parent",
        depth: 1,
        index: options.search ? 1 : parentRowIndex,
        parentRowIndex: options.search ? 0 : undefined,
        subtreeEndIndex: options.search ? 3 : targetRowIndex + 1,
        childCount: 1,
        visibleChildCount: 1,
        expanded: true,
        searchRevealsCollapsedChildren: Boolean(options.search),
        isSearchMatch: false,
        isSearchPath: Boolean(options.search),
        insideActiveWindow: true
      };
    }

    function targetRow(options: { search?: boolean } = {}) {
      return {
        nodeId: targetNodeId,
        depth: 2,
        index: options.search ? 2 : targetRowIndex,
        parentRowIndex: options.search ? 1 : parentRowIndex,
        subtreeEndIndex: (options.search ? 2 : targetRowIndex) + 1,
        childCount: 0,
        visibleChildCount: 0,
        expanded: true,
        searchRevealsCollapsedChildren: false,
        isSearchMatch: Boolean(options.search),
        isSearchPath: false,
        insideActiveWindow: true
      };
    }
  });

  await page.goto("/sidebar/sidebar.html");
  await expect(page.locator(nodeSelector("tab:1"))).toBeVisible();
}

function nodeRow(page: Page, nodeId: string) {
  return page.locator(`${nodeSelector(nodeId)} > .node-row`);
}

function nodeSelector(nodeId: string): string {
  return `.node[data-node-id='${cssString(nodeId)}']`;
}

async function outlineCollapseState(page: Page): Promise<{
  windowCollapsed: boolean | undefined;
  parentCollapsed: boolean | undefined;
}> {
  return page.evaluate(() => {
    const state = (
      window as typeof window & {
        __outlineState?: { nodes?: Record<string, { collapsed?: boolean }> };
      }
    ).__outlineState;
    return {
      windowCollapsed: state?.nodes?.["window:1"]?.collapsed,
      parentCollapsed: state?.nodes?.["tab:parent"]?.collapsed
    };
  });
}

async function scrollTop(page: Page): Promise<number> {
  return page.locator("main").evaluate((element) => element.scrollTop);
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

function cssString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function fixtureState() {
  const now = 1_700_000_000_000;
  const siblingIds = Array.from({ length: 80 }, (_value, index) => `tab:${index + 1}`);
  return {
    version: 1,
    rootIds: ["window:1"],
    nodes: {
      "window:1": {
        id: "window:1",
        kind: "window",
        status: "live",
        title: "Window",
        childIds: [...siblingIds, "tab:parent"],
        active: true,
        collapsed: true,
        createdAt: now,
        updatedAt: now,
        live: { windowId: 1 }
      },
      ...Object.fromEntries(
        siblingIds.map((id, index) => [
          id,
          {
            id,
            kind: "tab",
            status: "live",
            parentId: "window:1",
            title: `Tab ${index + 1}`,
            url: `https://show-in-tree.example/${index + 1}`,
            childIds: [],
            active: index === 0,
            collapsed: false,
            createdAt: now,
            updatedAt: now,
            live: { tabId: index + 1, windowId: 1 }
          }
        ])
      ),
      "tab:parent": {
        id: "tab:parent",
        kind: "tab",
        status: "live",
        parentId: "window:1",
        title: "Container",
        url: "https://show-in-tree.example/container",
        childIds: ["tab:target"],
        collapsed: true,
        createdAt: now,
        updatedAt: now,
        live: { tabId: 100, windowId: 1 }
      },
      "tab:target": {
        id: "tab:target",
        kind: "tab",
        status: "live",
        parentId: "tab:parent",
        title: "Needle target",
        url: "https://show-in-tree.example/needle",
        childIds: [],
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { tabId: 101, windowId: 1 }
      }
    }
  };
}
