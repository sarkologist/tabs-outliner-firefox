import { expect, test, type Page } from "@playwright/test";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

test.describe("sidebar restored single-tab window delete", () => {
  test("does not leave clicked delete actions stuck while the delete patch is pending", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page, { emitPatchOnDelete: false, sparseInitialSnapshot: true });

    const restoredTab = nodeRow(page, "tab:2");
    await restoredTab.hover();
    const deleteButton = restoredTab.getByRole("button", { name: "Delete", exact: true });
    await expect(deleteButton).toBeVisible();

    await deleteButton.click();
    await page.mouse.move(1, 1);

    await expect(deleteButton).toBeHidden();
    await expect(sentSidebarCommands(page)).resolves.toEqual([{ type: "deleteNode", nodeId: "tab:2" }]);
    expect(issues).toEqual([]);
  });

  test("removes the restored window shell when deleting its only restored tab", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page, { emitPatchOnDelete: true, sparseInitialSnapshot: false });

    const restoredTab = nodeRow(page, "tab:2");
    await restoredTab.hover();
    await restoredTab.getByRole("button", { name: "Delete", exact: true }).click();

    await expect(page.locator(nodeSelector("tab:2"))).toHaveCount(0);
    await expect(page.locator(nodeSelector("window:20"))).toHaveCount(0);
    await expect(visibleNodeOrder(page)).resolves.toEqual(["window:10", "tab:1"]);
    await expect(sentSidebarCommands(page)).resolves.toEqual([{ type: "deleteNode", nodeId: "tab:2" }]);
    expect(issues).toEqual([]);
  });
});

async function loadSidebar(
  page: Page,
  options: { emitPatchOnDelete: boolean; sparseInitialSnapshot: boolean }
): Promise<void> {
  await page.addInitScript(({ state: initialState, emitPatchOnDelete, sparseInitialSnapshot }) => {
    const state = structuredClone(initialState);
    const listeners: Array<(message: unknown) => void> = [];
    const sentCommands: unknown[] = [];

    Object.assign(window as typeof window & {
      __outlineState?: unknown;
      __sentSidebarCommands?: unknown[];
    }, {
      __outlineState: state,
      __sentSidebarCommands: sentCommands
    });

    window.browser = {
      runtime: {
        sendMessage: async (message: unknown) => {
          const type = typeof message === "object" && message ? (message as { type?: unknown }).type : undefined;
          if (type === "getInitialTreeSnapshot") {
            return sparseInitialSnapshot ? initialTreeSnapshot(state) : undefined;
          }
          if (type === "getState") {
            if (sparseInitialSnapshot) {
              return new Promise(() => undefined);
            }
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
              runtimeTabCount: 2,
              liveTabNodeCount: 2,
              visibleLiveTabNodeCount: 2,
              hiddenLiveTabNodeCount: 0,
              missingRuntimeTabIds: []
            };
          }
          if (
            type === "getPerformanceTrace" ||
            type === "setPerformanceTraceEnabled" ||
            type === "clearPerformanceTrace"
          ) {
            return undefined;
          }
          if (type === "deleteNode") {
            sentCommands.push(structuredClone(message));
            if (emitPatchOnDelete) {
              const previous = structuredClone(state);
              delete state.nodes["tab:2"];
              delete state.nodes["window:20"];
              state.rootIds = state.rootIds.filter((nodeId: string) => nodeId !== "window:20");
              for (const listener of listeners) {
                listener(treeStructureUpdate(previous, state));
              }
            }
            return { type: "commandAck", stateChanged: true };
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

    function treeStructureUpdate(
      previous: { rootIds: string[]; nodes: Record<string, unknown> },
      next: { rootIds: string[]; nodes: Record<string, unknown> }
    ) {
      const deletedNodeIds = Object.keys(previous.nodes).filter((nodeId) => !(nodeId in next.nodes));
      const updatedNodes = Object.keys(next.nodes)
        .filter((nodeId) => JSON.stringify(previous.nodes[nodeId]) !== JSON.stringify(next.nodes[nodeId]))
        .map((nodeId) => next.nodes[nodeId]);
      return {
        type: "treeStructureUpdated",
        deletedNodeIds,
        updatedNodes,
        rootIds: [...next.rootIds],
        deletedClosedCount: 0
      };
    }

    function initialTreeSnapshot(outline: {
      version: number;
      rootIds: string[];
      nodes: Record<string, { id: string; childIds: string[]; collapsed?: boolean; kind: string; active?: boolean }>;
    }) {
      const rows = [
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
        {
          nodeId: "tab:1",
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
        },
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
        {
          nodeId: "tab:2",
          depth: 1,
          index: 3,
          parentRowIndex: 2,
          subtreeEndIndex: 4,
          childCount: 0,
          visibleChildCount: 0,
          expanded: true,
          searchRevealsCollapsedChildren: false,
          isSearchMatch: false,
          isSearchPath: false,
          insideActiveWindow: true
        }
      ];
      return {
        type: "initialTreeSnapshot",
        version: 1,
        revision: 1,
        state: structuredClone(outline),
        projection: {
          query: "",
          isSearchActive: false,
          rows,
          matchingNodeIds: [],
          visibleNodeIds: rows.map((row) => row.nodeId),
          activeTabNodeId: "tab:2",
          activeTabRowIndex: 3,
          totalRowCount: 6,
          nodeCount: 6,
          closedCount: 0,
          matchCount: 0
        },
        coverage: {
          startRowIndex: 0,
          endRowIndex: 4,
          editableNodeIds: rows.map((row) => row.nodeId),
          completeSubtreeNodeIds: rows.map((row) => row.nodeId),
          completeSiblingParentIds: ["window:10", "window:20"]
        },
        hydrating: true
      };
    }
  }, {
    state: fixtureState(),
    emitPatchOnDelete: options.emitPatchOnDelete,
    sparseInitialSnapshot: options.sparseInitialSnapshot
  });

  await page.goto("/sidebar/sidebar.html");
  await expect(page.getByRole("treeitem")).toHaveCount(4);
}

function nodeRow(page: Page, nodeId: string) {
  return page.locator(`${nodeSelector(nodeId)} > .node-row`);
}

function nodeSelector(nodeId: string): string {
  return `.node[data-node-id='${cssString(nodeId)}']`;
}

async function visibleNodeOrder(page: Page): Promise<string[]> {
  return page.$$eval(".node", (nodes) =>
    nodes
      .map((node) => ({
        nodeId: (node as HTMLElement).dataset.nodeId ?? "",
        rowIndex: Number.parseInt((node as HTMLElement).dataset.rowIndex ?? "", 10)
      }))
      .sort((left, right) => left.rowIndex - right.rowIndex)
      .map((entry) => entry.nodeId)
  );
}

async function sentSidebarCommands(page: Page): Promise<unknown[]> {
  return page.evaluate(() => [
    ...((window as typeof window & { __sentSidebarCommands?: unknown[] }).__sentSidebarCommands ?? [])
  ]);
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

function fixtureState() {
  const now = 1_700_000_000_000;
  return {
    version: 1,
    rootIds: ["window:10", "window:20"],
    nodes: {
      "window:10": {
        id: "window:10",
        kind: "window",
        status: "live",
        title: "Group",
        childIds: ["tab:1"],
        active: false,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { windowId: 10 }
      },
      "tab:1": {
        id: "tab:1",
        kind: "tab",
        status: "live",
        parentId: "window:10",
        title: "Existing tab",
        url: "https://existing.example/",
        childIds: [],
        active: false,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { tabId: 1, windowId: 10 }
      },
      "window:20": {
        id: "window:20",
        kind: "window",
        status: "live",
        title: "Group",
        childIds: ["tab:2"],
        active: true,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        restoredFromClosed: true,
        live: { windowId: 42 }
      },
      "tab:2": {
        id: "tab:2",
        kind: "tab",
        status: "live",
        parentId: "window:20",
        title: "Yandex Images: search for simple image search",
        url: "about:blank",
        childIds: [],
        active: true,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        restoredFromClosed: true,
        live: { tabId: 22, windowId: 42 }
      }
    }
  };
}
