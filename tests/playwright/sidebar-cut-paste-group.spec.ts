import { expect, test, type Page } from "@playwright/test";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

test.describe("sidebar cut/paste with groups", () => {
  test("rebuilds visible rows when paste removes the source wrapper group", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page);

    await nodeRow(page, "window:1").hover();
    await nodeRow(page, "window:1").getByRole("button", { name: "Cut", exact: true }).click();
    await nodeRow(page, "window:2").hover();
    await nodeRow(page, "window:2").getByRole("button", { name: "Paste", exact: true }).click();

    await expect(page.locator(nodeSelector("group:wrapper"))).toHaveCount(0);
    await expect(page.getByRole("treeitem")).toHaveCount(4);
    await expect(page.locator(nodeSelector("window:1"))).toHaveAttribute("aria-level", "1");
    await expect(page.locator(nodeSelector("window:1"))).toHaveAttribute("data-row-index", "2");
    await expect(visibleNodeOrder(page)).resolves.toEqual(["window:2", "tab:b", "window:1", "tab:a"]);
    await expect(outlineRootIds(page)).resolves.toEqual(["window:2", "window:1"]);
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
          const type = typeof message === "object" && message ? (message as { type?: unknown }).type : undefined;
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
              runtimeTabCount: 2,
              liveTabNodeCount: 2,
              visibleLiveTabNodeCount: 2,
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
          if (type === "moveNode") {
            const previous = structuredClone(state);
            applyMoveNode(state, message as { nodeId: string; parentId?: string; index: number });
            const update = treeStructureUpdate(previous, state);
            for (const listener of listeners) {
              listener(structuredClone(update));
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

    function applyMoveNode(
      outline: {
        rootIds: string[];
        nodes: Record<string, { id: string; parentId?: string; childIds: string[]; kind: string }>;
      },
      command: { nodeId: string; parentId?: string; index: number }
    ): void {
      const node = outline.nodes[command.nodeId];
      if (!node) {
        return;
      }

      const oldParentId = node.parentId;
      const oldSiblings = oldParentId ? outline.nodes[oldParentId]?.childIds : outline.rootIds;
      removeId(oldSiblings, command.nodeId);

      const newSiblings = command.parentId ? outline.nodes[command.parentId]?.childIds : outline.rootIds;
      if (!newSiblings) {
        return;
      }
      const boundedIndex = Math.max(0, Math.min(command.index, newSiblings.length));
      newSiblings.splice(boundedIndex, 0, command.nodeId);
      if (command.parentId) {
        node.parentId = command.parentId;
      } else {
        delete node.parentId;
      }

      removeEmptyContainersFrom(outline, oldParentId);
    }

    function removeEmptyContainersFrom(
      outline: {
        rootIds: string[];
        nodes: Record<string, { id: string; parentId?: string; childIds: string[]; kind: string }>;
      },
      startNodeId: string | undefined
    ): void {
      let currentId = startNodeId;
      while (currentId) {
        const current = outline.nodes[currentId];
        if (!current || (current.kind !== "window" && current.kind !== "group") || current.childIds.length > 0) {
          return;
        }

        const parentId = current.parentId;
        delete outline.nodes[currentId];
        if (parentId) {
          removeId(outline.nodes[parentId]?.childIds, currentId);
          currentId = parentId;
        } else {
          removeId(outline.rootIds, currentId);
          return;
        }
      }
    }

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

    function removeId(ids: string[] | undefined, id: string): void {
      const index = ids?.indexOf(id) ?? -1;
      if (ids && index >= 0) {
        ids.splice(index, 1);
      }
    }
  }, fixtureState());

  await page.goto("/sidebar/sidebar.html");
  await expect(page.getByRole("treeitem")).toHaveCount(5);
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

async function outlineRootIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...(((window as typeof window & { __outlineState?: { rootIds?: string[] } }).__outlineState?.rootIds) ?? [])
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
    rootIds: ["group:wrapper", "window:2"],
    nodes: {
      "group:wrapper": {
        id: "group:wrapper",
        kind: "group",
        status: "neutral",
        title: "Wrapper",
        childIds: ["window:1"],
        collapsed: false,
        createdAt: now,
        updatedAt: now
      },
      "window:1": {
        id: "window:1",
        kind: "window",
        status: "live",
        parentId: "group:wrapper",
        title: "Window 1",
        childIds: ["tab:a"],
        active: true,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { windowId: 1 }
      },
      "tab:a": {
        id: "tab:a",
        kind: "tab",
        status: "live",
        parentId: "window:1",
        title: "A",
        childIds: [],
        active: true,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { tabId: 1, windowId: 1 }
      },
      "window:2": {
        id: "window:2",
        kind: "window",
        status: "live",
        title: "Window 2",
        childIds: ["tab:b"],
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { windowId: 2 }
      },
      "tab:b": {
        id: "tab:b",
        kind: "tab",
        status: "live",
        parentId: "window:2",
        title: "B",
        childIds: [],
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { tabId: 2, windowId: 2 }
      }
    }
  };
}
