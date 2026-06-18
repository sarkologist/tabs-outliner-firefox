import { expect, test, type Page } from "@playwright/test";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

test.describe("sidebar neutral group close action", () => {
  test("shows Close for neutral groups with live descendants only", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page);

    const outerGroup = nodeRow(page, "group:outer");
    await outerGroup.hover();
    await expect(outerGroup.getByRole("button", { name: "Close", exact: true })).toBeVisible();

    const closedOnlyGroup = nodeRow(page, "group:closed-only");
    await closedOnlyGroup.hover();
    await expect(closedOnlyGroup.getByRole("button", { name: "Close", exact: true })).toHaveCount(
      0
    );
    await expect(closedOnlyGroup.getByRole("button", { name: "Restore", exact: true })).toHaveCount(
      0
    );

    await outerGroup.hover();
    await outerGroup.getByRole("button", { name: "Close", exact: true }).click();

    await expect(sentSidebarCommands(page)).resolves.toEqual([
      { type: "closeNode", nodeId: "group:outer" }
    ]);
    expect(issues).toEqual([]);
  });

  test("uses the closed row title for restore while keeping Close for live descendants", async ({
    page
  }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page);

    const closedParent = nodeRow(page, "window:closed-parent");
    await closedParent.hover();
    await expect(closedParent.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    await expect(closedParent.getByRole("button", { name: "Restore", exact: true })).toHaveCount(0);
    await expect(
      closedParent.getByRole("button", { name: "Restore Closed parent", exact: true })
    ).toBeVisible();

    await closedParent.getByRole("button", { name: "Close", exact: true }).click();

    await expect(sentSidebarCommands(page)).resolves.toEqual([
      { type: "closeNode", nodeId: "window:closed-parent" }
    ]);
    await clearSentSidebarCommands(page);

    await closedParent.getByRole("button", { name: "Restore Closed parent", exact: true }).click();

    await expect(sentSidebarCommands(page)).resolves.toEqual([
      { type: "restoreNode", nodeId: "window:closed-parent" }
    ]);
    expect(issues).toEqual([]);
  });

  test("restores an imported closed group through its descendant restore scope", async ({
    page
  }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page);

    const importedGroup = nodeRow(page, "window:imported-group");
    await importedGroup
      .getByRole("button", { name: "Restore Imported group", exact: true })
      .click();

    await expect(sentSidebarCommands(page)).resolves.toEqual([
      { type: "restoreNode", nodeId: "window:imported-group" }
    ]);
    expect(issues).toEqual([]);
  });

  test("offers restore for live containers that still have closed descendants", async ({
    page
  }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page);

    const partiallyRestored = nodeRow(page, "window:1");
    await partiallyRestored.hover();
    await partiallyRestored.getByRole("button", { name: "Restore", exact: true }).click();

    await expect(sentSidebarCommands(page)).resolves.toEqual([
      { type: "restoreNode", nodeId: "window:1" }
    ]);
    expect(issues).toEqual([]);
  });

  test("restores mixed live containers from the row label", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page);

    await nodeRow(page, "window:1")
      .getByRole("button", { name: "Restore Window", exact: true })
      .click();

    await expect(sentSidebarCommands(page)).resolves.toEqual([
      { type: "restoreNode", nodeId: "window:1" }
    ]);
    expect(issues).toEqual([]);
  });
});

async function loadSidebar(page: Page): Promise<void> {
  await page.addInitScript((state) => {
    const listeners: Array<(message: unknown) => void> = [];
    const sentCommands: unknown[] = [];
    (window as typeof window & { __sentSidebarCommands?: unknown[] }).__sentSidebarCommands =
      sentCommands;

    window.browser = {
      runtime: {
        sendMessage: async (message: unknown) => {
          const type =
            typeof message === "object" && message
              ? (message as { type?: unknown }).type
              : undefined;
          if (type === "getState") {
            return structuredClone(state);
          }
          if (type === "getInitialTreeSnapshot") {
            return undefined;
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
              runtimeTabCount: 1,
              liveTabNodeCount: 1,
              visibleLiveTabNodeCount: 1,
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
          sentCommands.push(structuredClone(message));
          return { type: "commandAck", stateChanged: true };
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
  }, fixtureState());

  await page.goto("/sidebar/sidebar.html");
  await expect(page.getByRole("treeitem")).toHaveCount(14);
}

function nodeRow(page: Page, nodeId: string) {
  return page.locator(`.node[data-node-id='${cssString(nodeId)}'] > .node-row`);
}

async function sentSidebarCommands(page: Page): Promise<unknown[]> {
  return page.evaluate(() => [
    ...((window as typeof window & { __sentSidebarCommands?: unknown[] }).__sentSidebarCommands ??
      [])
  ]);
}

async function clearSentSidebarCommands(page: Page): Promise<void> {
  await page.evaluate(() => {
    const commands = (window as typeof window & { __sentSidebarCommands?: unknown[] })
      .__sentSidebarCommands;
    commands?.splice(0, commands.length);
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

function cssString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function fixtureState() {
  const now = 1_700_000_000_000;
  return {
    version: 1,
    rootIds: ["group:outer", "window:closed-parent", "group:closed-only", "window:imported-group"],
    nodes: {
      "group:outer": {
        id: "group:outer",
        kind: "group",
        status: "neutral",
        title: "Outer",
        childIds: ["group:inner"],
        collapsed: false,
        createdAt: now,
        updatedAt: now
      },
      "group:inner": {
        id: "group:inner",
        kind: "group",
        status: "neutral",
        parentId: "group:outer",
        title: "Inner",
        childIds: ["window:1"],
        collapsed: false,
        createdAt: now,
        updatedAt: now
      },
      "window:1": {
        id: "window:1",
        kind: "window",
        status: "live",
        parentId: "group:inner",
        title: "Window",
        childIds: ["tab:1", "tab:partially-restored-closed"],
        active: true,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { windowId: 1 }
      },
      "tab:1": {
        id: "tab:1",
        kind: "tab",
        status: "live",
        parentId: "window:1",
        title: "Example",
        url: "https://example.com/",
        childIds: [],
        active: true,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { tabId: 1, windowId: 1 }
      },
      "tab:partially-restored-closed": {
        id: "tab:partially-restored-closed",
        kind: "tab",
        status: "closed",
        parentId: "window:1",
        title: "Still closed",
        url: "https://partially-restored.example/",
        childIds: [],
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        closedAt: now,
        restore: { url: "https://partially-restored.example/", title: "Still closed" }
      },
      "window:closed-parent": {
        id: "window:closed-parent",
        kind: "window",
        status: "closed",
        title: "Closed parent",
        childIds: ["group:closed-parent-inner"],
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        closedAt: now,
        restore: { sessionId: "session-closed-parent", title: "Closed parent" }
      },
      "group:closed-parent-inner": {
        id: "group:closed-parent-inner",
        kind: "group",
        status: "neutral",
        parentId: "window:closed-parent",
        title: "Inner live group",
        childIds: ["window:2"],
        collapsed: false,
        createdAt: now,
        updatedAt: now
      },
      "window:2": {
        id: "window:2",
        kind: "window",
        status: "live",
        parentId: "group:closed-parent-inner",
        title: "Live nested window",
        childIds: ["tab:2"],
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { windowId: 2 }
      },
      "tab:2": {
        id: "tab:2",
        kind: "tab",
        status: "live",
        parentId: "window:2",
        title: "Nested live tab",
        url: "https://nested.example/",
        childIds: [],
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { tabId: 2, windowId: 2 }
      },
      "group:closed-only": {
        id: "group:closed-only",
        kind: "group",
        status: "neutral",
        title: "Closed only",
        childIds: ["tab:closed"],
        collapsed: false,
        createdAt: now,
        updatedAt: now
      },
      "tab:closed": {
        id: "tab:closed",
        kind: "tab",
        status: "closed",
        parentId: "group:closed-only",
        title: "Closed",
        url: "https://closed.example/",
        childIds: [],
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        closedAt: now,
        restore: { url: "https://closed.example/", title: "Closed" }
      },
      "window:imported-group": {
        id: "window:imported-group",
        kind: "window",
        status: "closed",
        title: "Imported group",
        childIds: ["tab:imported-a", "tab:imported-b"],
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        closedAt: now
      },
      "tab:imported-a": {
        id: "tab:imported-a",
        kind: "tab",
        status: "closed",
        parentId: "window:imported-group",
        title: "Imported A",
        url: "https://imported.example/a",
        childIds: [],
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        closedAt: now,
        restore: { url: "https://imported.example/a", title: "Imported A" }
      },
      "tab:imported-b": {
        id: "tab:imported-b",
        kind: "tab",
        status: "closed",
        parentId: "window:imported-group",
        title: "Imported B",
        url: "https://imported.example/b",
        childIds: [],
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        closedAt: now,
        restore: { url: "https://imported.example/b", title: "Imported B" }
      }
    }
  };
}
