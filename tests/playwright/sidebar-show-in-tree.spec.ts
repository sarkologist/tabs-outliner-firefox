import { expect, test, type Page } from "@playwright/test";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

test.describe("sidebar search result show in tree", () => {
  test("clears search, expands ancestors, and scrolls the full tree to the result", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page);

    await page.getByRole("searchbox", { name: "Search tabs" }).fill("needle");
    await expect(page.getByRole("treeitem")).toHaveCount(3);

    await nodeRow(page, "window:1").hover();
    await expect(nodeRow(page, "window:1").getByRole("button", { name: "Show in tree" })).toHaveCount(0);
    await nodeRow(page, "tab:parent").hover();
    await expect(nodeRow(page, "tab:parent").getByRole("button", { name: "Show in tree" })).toHaveCount(0);

    await nodeRow(page, "tab:target").hover();
    await nodeRow(page, "tab:target").getByRole("button", { name: "Show in tree" }).click();

    await expect(page.getByRole("searchbox", { name: "Search tabs" })).toHaveValue("");
    await expect(page.getByRole("button", { name: "Clear search" })).toBeHidden();
    await expect(page.locator(nodeSelector("tab:target"))).toBeVisible();
    await expect(page.locator(nodeSelector("tab:target"))).toHaveAttribute("data-row-index", "82");
    await expect(outlineCollapseState(page)).resolves.toEqual({
      windowCollapsed: false,
      parentCollapsed: false
    });
    expect(await scrollTop(page)).toBeGreaterThan(500);
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
    const state = (window as typeof window & {
      __outlineState?: { nodes?: Record<string, { collapsed?: boolean }> };
    }).__outlineState;
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
    issues.push({ kind: "requestfailed", text: `${request.url()} ${request.failure()?.errorText ?? ""}` });
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
