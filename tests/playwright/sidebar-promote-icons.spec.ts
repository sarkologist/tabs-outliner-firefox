import { expect, test, type Page } from "@playwright/test";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

test.describe("sidebar promote children and icons", () => {
  test("discovers flatten/promote actions through icons and updates outline state", async ({
    page
  }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page);

    for (const buttonId of [
      "undo-history",
      "redo-history",
      "toolbar-overflow",
      "open-sidebar-window",
      "open-options"
    ]) {
      await expect(page.locator(`#${buttonId} svg`), `${buttonId} uses an SVG icon`).toHaveCount(1);
    }
    await expect(page.locator("#export-tree")).toBeHidden();
    await expect(page.locator("#import-tree")).toBeHidden();
    await expect(page.locator("#refresh")).toBeHidden();

    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.locator("#toolbar-overflow-menu")).toBeVisible();
    for (const buttonId of ["export-tree", "import-tree", "refresh"]) {
      await expect(page.locator(`#${buttonId}`), `${buttonId} is in overflow`).toBeVisible();
      await expect(page.locator(`#${buttonId} svg`), `${buttonId} uses an SVG icon`).toHaveCount(1);
    }
    await page.keyboard.press("Escape");
    await expect(page.locator("#toolbar-overflow-menu")).toBeHidden();

    await page.getByRole("searchbox", { name: "Search tabs" }).fill("Alpha");
    await expect(page.locator("#clear-search svg")).toHaveCount(1);
    await page.locator("#clear-search").click();

    await nodeRow(page, "tab:a").hover();
    const promote = nodeRow(page, "tab:a").getByRole("button", {
      name: "Promote children",
      exact: true
    });
    const flatten = nodeRow(page, "tab:a").getByRole("button", { name: "Flatten", exact: true });
    await expect(promote).toHaveAttribute("title", "Promote children");
    await expect(promote.locator("svg")).toHaveCount(1);
    await expect(flatten).toHaveAttribute("title", "Flatten");
    await expect(flatten.locator("svg")).toHaveCount(1);
    await expect(nodeRow(page, "tab:b").locator(".twisty svg")).toHaveCount(1);

    await promote.click();
    await expect(outlineChildIds(page, "window:1")).resolves.toEqual([
      "tab:a",
      "tab:a1",
      "tab:b",
      "tab:c"
    ]);
    await expect(outlineChildIds(page, "tab:a")).resolves.toEqual([]);
    await expect(outlineParentId(page, "tab:a1")).resolves.toBe("window:1");
    await expect(page.locator(".node[data-node-id='tab:a1']")).toHaveAttribute("aria-level", "2");

    await nodeRow(page, "tab:b").hover();
    await nodeRow(page, "tab:b").getByRole("button", { name: "Flatten", exact: true }).click();
    await expect(outlineChildIds(page, "tab:b")).resolves.toEqual(["tab:b1", "tab:b1i"]);
    await expect(outlineChildIds(page, "tab:b1")).resolves.toEqual([]);
    await expect(outlineParentId(page, "tab:b1i")).resolves.toBe("tab:b");
    await expect(visibleNodeOrder(page)).resolves.toEqual([
      "window:1",
      "tab:a",
      "tab:a1",
      "tab:a1i",
      "tab:b",
      "tab:b1",
      "tab:b1i",
      "tab:c",
      "window:2",
      "tab:z"
    ]);

    expect(issues).toEqual([]);
  });

  test("moves a subtree to top level through an icon action", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page);

    await nodeRow(page, "tab:a").hover();
    const moveToTop = nodeRow(page, "tab:a").getByRole("button", {
      name: "Move to top level",
      exact: true
    });
    await expect(moveToTop).toHaveAttribute("title", "Move to top level");
    await expect(moveToTop.locator("svg")).toHaveCount(1);

    await moveToTop.click();

    await expect(outlineRootIds(page)).resolves.toEqual([
      "window:1",
      "window:top:tab:a",
      "window:2"
    ]);
    await expect(outlineChildIds(page, "window:1")).resolves.toEqual(["tab:b", "tab:c"]);
    await expect(outlineChildIds(page, "window:top:tab:a")).resolves.toEqual(["tab:a"]);
    await expect(outlineParentId(page, "tab:a")).resolves.toBe("window:top:tab:a");
    await expect(page.locator(".node[data-node-id='window:top:tab:a']")).toHaveAttribute(
      "aria-level",
      "1"
    );
    await expect(visibleNodeOrder(page)).resolves.toEqual([
      "window:1",
      "tab:b",
      "tab:b1",
      "tab:b1i",
      "tab:c",
      "window:top:tab:a",
      "tab:a",
      "tab:a1",
      "tab:a1i",
      "window:2",
      "tab:z"
    ]);

    expect(issues).toEqual([]);
  });

  test("moves a subtree to the bottom top level through an icon action", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page);

    await nodeRow(page, "tab:a").hover();
    const moveToBottom = nodeRow(page, "tab:a").getByRole("button", {
      name: "Move to bottom",
      exact: true
    });
    await expect(moveToBottom).toHaveAttribute("title", "Move to bottom");
    await expect(moveToBottom.locator("svg")).toHaveCount(1);

    await moveToBottom.click();

    await expect(outlineRootIds(page)).resolves.toEqual([
      "window:1",
      "window:2",
      "window:bottom:tab:a"
    ]);
    await expect(outlineChildIds(page, "window:1")).resolves.toEqual(["tab:b", "tab:c"]);
    await expect(outlineChildIds(page, "window:bottom:tab:a")).resolves.toEqual(["tab:a"]);
    await expect(outlineParentId(page, "tab:a")).resolves.toBe("window:bottom:tab:a");
    await expect(page.locator(".node[data-node-id='window:bottom:tab:a']")).toHaveAttribute(
      "aria-level",
      "1"
    );
    await expect(visibleNodeOrder(page)).resolves.toEqual([
      "window:1",
      "tab:b",
      "tab:b1",
      "tab:b1i",
      "tab:c",
      "window:2",
      "tab:z",
      "window:bottom:tab:a",
      "tab:a",
      "tab:a1",
      "tab:a1i"
    ]);

    expect(issues).toEqual([]);
  });

  test("moves a top-level group to the bottom through an icon action", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page);

    await nodeRow(page, "window:1").hover();
    const moveToBottom = nodeRow(page, "window:1").getByRole("button", {
      name: "Move to bottom",
      exact: true
    });
    await expect(moveToBottom).toHaveAttribute("title", "Move to bottom");
    await expect(moveToBottom.locator("svg")).toHaveCount(1);

    await moveToBottom.click();

    await expect(outlineRootIds(page)).resolves.toEqual(["window:2", "window:1"]);
    await expect(outlineChildIds(page, "window:1")).resolves.toEqual(["tab:a", "tab:b", "tab:c"]);
    await expect(outlineParentId(page, "window:1")).resolves.toBeUndefined();
    await expect(visibleNodeOrder(page)).resolves.toEqual([
      "window:2",
      "tab:z",
      "window:1",
      "tab:a",
      "tab:a1",
      "tab:a1i",
      "tab:b",
      "tab:b1",
      "tab:b1i",
      "tab:c"
    ]);

    expect(issues).toEqual([]);
  });
});

async function loadSidebar(page: Page): Promise<void> {
  await page.addInitScript((initialState) => {
    type Node = {
      id: string;
      parentId?: string;
      childIds: string[];
    };
    type State = {
      rootIds: string[];
      nodes: Record<string, Node>;
    };

    let state = structuredClone(initialState) as State;
    const listeners: Array<(message: unknown) => void> = [];
    (window as typeof window & { __outlineState?: State }).__outlineState = state;

    function replaceState(next: State): void {
      state = next;
      (window as typeof window & { __outlineState?: State }).__outlineState = state;
      for (const listener of listeners) {
        listener({ type: "stateUpdated", state: structuredClone(state) });
      }
    }

    function promoteChildren(nodeId: string): State {
      const node = state.nodes[nodeId];
      if (!node?.parentId || node.childIds.length === 0) {
        return state;
      }
      const parent = state.nodes[node.parentId];
      if (!parent) {
        return state;
      }

      const next = structuredClone(state) as State;
      const nextNode = next.nodes[nodeId]!;
      const nextParent = next.nodes[node.parentId]!;
      const promotedChildIds = [...nextNode.childIds];
      const index = nextParent.childIds.indexOf(nodeId);
      nextParent.childIds.splice(
        index >= 0 ? index + 1 : nextParent.childIds.length,
        0,
        ...promotedChildIds
      );
      nextNode.childIds = [];
      for (const childId of promotedChildIds) {
        next.nodes[childId]!.parentId = node.parentId;
      }
      return next;
    }

    function flattenSubtree(nodeId: string): State {
      const node = state.nodes[nodeId];
      if (!node) {
        return state;
      }

      const next = structuredClone(state) as State;
      const nextNode = next.nodes[nodeId]!;
      const flattenedChildIds: string[] = [];
      for (const childId of node.childIds) {
        const child = state.nodes[childId];
        if (!child) {
          flattenedChildIds.push(childId);
          continue;
        }
        const promotedChildIds = [...child.childIds];
        flattenedChildIds.push(childId, ...promotedChildIds);
        next.nodes[childId]!.childIds = [];
        for (const promotedChildId of promotedChildIds) {
          next.nodes[promotedChildId]!.parentId = nodeId;
        }
      }
      nextNode.childIds = flattenedChildIds;
      return next;
    }

    function moveSubtreeToTopLevel(nodeId: string): State {
      const node = state.nodes[nodeId];
      if (!node?.parentId) {
        return state;
      }
      const rootAncestorId = rootAncestorIdFor(nodeId);
      if (!rootAncestorId) {
        return state;
      }

      const next = structuredClone(state) as State;
      let movingId = nodeId;
      const nextNode = next.nodes[nodeId]!;

      if (!isGroupLike(node)) {
        const wrapperId = `window:top:${nodeId}`;
        const oldSiblings = nextNode.parentId
          ? next.nodes[nextNode.parentId]?.childIds
          : next.rootIds;
        if (!oldSiblings) {
          return state;
        }
        const oldIndex = oldSiblings.indexOf(nodeId);
        if (oldIndex < 0) {
          return state;
        }
        next.nodes[wrapperId] = {
          id: wrapperId,
          kind: "window",
          status: "live",
          parentId: nextNode.parentId,
          title: "Group",
          childIds: [nodeId],
          collapsed: false,
          createdAt: Date.now(),
          updatedAt: Date.now()
        } as Node;
        oldSiblings.splice(oldIndex, 1, wrapperId);
        nextNode.parentId = wrapperId;
        movingId = wrapperId;
      }

      const moving = next.nodes[movingId];
      if (!moving?.parentId) {
        return next;
      }
      removeId(next.nodes[moving.parentId]?.childIds, movingId);
      const rootIndex = next.rootIds.indexOf(rootAncestorId);
      next.rootIds.splice(rootIndex >= 0 ? rootIndex + 1 : next.rootIds.length, 0, movingId);
      delete moving.parentId;
      return next;
    }

    function moveSubtreeToBottomTopLevel(nodeId: string): State {
      const node = state.nodes[nodeId];
      if (!node) {
        return state;
      }

      const next = structuredClone(state) as State;
      let movingId = nodeId;
      const nextNode = next.nodes[nodeId]!;

      if (!node.parentId) {
        if (!isGroupLike(node)) {
          return state;
        }
        const rootIndex = next.rootIds.indexOf(nodeId);
        if (rootIndex < 0 || rootIndex === next.rootIds.length - 1) {
          return state;
        }
        next.rootIds.splice(rootIndex, 1);
        next.rootIds.push(nodeId);
        return next;
      }

      if (!isGroupLike(node)) {
        const wrapperId = `window:bottom:${nodeId}`;
        const oldSiblings = nextNode.parentId
          ? next.nodes[nextNode.parentId]?.childIds
          : next.rootIds;
        if (!oldSiblings) {
          return state;
        }
        const oldIndex = oldSiblings.indexOf(nodeId);
        if (oldIndex < 0) {
          return state;
        }
        next.nodes[wrapperId] = {
          id: wrapperId,
          kind: "window",
          status: "live",
          parentId: nextNode.parentId,
          title: "Group",
          childIds: [nodeId],
          collapsed: false,
          createdAt: Date.now(),
          updatedAt: Date.now()
        } as Node;
        oldSiblings.splice(oldIndex, 1, wrapperId);
        nextNode.parentId = wrapperId;
        movingId = wrapperId;
      }

      const moving = next.nodes[movingId];
      if (!moving?.parentId) {
        return next;
      }
      removeId(next.nodes[moving.parentId]?.childIds, movingId);
      next.rootIds.push(movingId);
      delete moving.parentId;
      return next;
    }

    function rootAncestorIdFor(nodeId: string): string | undefined {
      let current = state.nodes[nodeId];
      const visited = new Set<string>();
      while (current?.parentId && !visited.has(current.id)) {
        visited.add(current.id);
        current = state.nodes[current.parentId];
      }
      return current?.id;
    }

    function isGroupLike(node: { kind?: string }): boolean {
      return node.kind === "window" || node.kind === "group";
    }

    function removeId(ids: string[] | undefined, id: string): void {
      const index = ids?.indexOf(id) ?? -1;
      if (ids && index >= 0) {
        ids.splice(index, 1);
      }
    }

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
              runtimeTabCount: 6,
              liveTabNodeCount: 6,
              visibleLiveTabNodeCount: 6,
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
          if (type === "promoteChildren") {
            replaceState(promoteChildren((message as { nodeId: string }).nodeId));
            return { type: "commandAck", stateChanged: true };
          }
          if (type === "flattenSubtree") {
            replaceState(flattenSubtree((message as { nodeId: string }).nodeId));
            return { type: "commandAck", stateChanged: true };
          }
          if (type === "moveSubtreeToTopLevel") {
            replaceState(moveSubtreeToTopLevel((message as { nodeId: string }).nodeId));
            return { type: "commandAck", stateChanged: true };
          }
          if (type === "moveSubtreeToBottomTopLevel") {
            replaceState(moveSubtreeToBottomTopLevel((message as { nodeId: string }).nodeId));
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
  }, fixtureState());

  await page.goto("/sidebar/sidebar.html");
  await expect(page.getByRole("treeitem")).toHaveCount(10);
}

function nodeRow(page: Page, nodeId: string) {
  return page.locator(`.node[data-node-id='${cssString(nodeId)}'] > .node-row`);
}

async function visibleNodeOrder(page: Page): Promise<string[]> {
  return page
    .locator(".node")
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.nodeId ?? ""));
}

async function outlineRootIds(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (window as typeof window & { __outlineState?: { rootIds: string[] } }).__outlineState
        ?.rootIds ?? []
  );
}

async function outlineChildIds(page: Page, nodeId: string): Promise<string[]> {
  return page.evaluate(
    (id) =>
      (
        window as typeof window & {
          __outlineState?: { nodes: Record<string, { childIds: string[] }> };
        }
      ).__outlineState?.nodes[id]?.childIds ?? [],
    nodeId
  );
}

async function outlineParentId(page: Page, nodeId: string): Promise<string | undefined> {
  return page.evaluate(
    (id) =>
      (
        window as typeof window & {
          __outlineState?: { nodes: Record<string, { parentId?: string }> };
        }
      ).__outlineState?.nodes[id]?.parentId,
    nodeId
  );
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
    rootIds: ["window:1", "window:2"],
    nodes: {
      "window:1": {
        id: "window:1",
        kind: "window",
        status: "live",
        title: "Window",
        childIds: ["tab:a", "tab:b", "tab:c"],
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
        title: "Alpha",
        url: "https://a.example/",
        childIds: ["tab:a1"],
        active: true,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { tabId: 1, windowId: 1 }
      },
      "tab:a1": {
        id: "tab:a1",
        kind: "tab",
        status: "live",
        parentId: "tab:a",
        title: "Alpha child",
        url: "https://a-child.example/",
        childIds: ["tab:a1i"],
        active: false,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { tabId: 2, windowId: 1 }
      },
      "tab:a1i": {
        id: "tab:a1i",
        kind: "tab",
        status: "live",
        parentId: "tab:a1",
        title: "Alpha inner",
        url: "https://a-inner.example/",
        childIds: [],
        active: false,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { tabId: 3, windowId: 1 }
      },
      "tab:b": {
        id: "tab:b",
        kind: "tab",
        status: "live",
        parentId: "window:1",
        title: "Beta",
        url: "https://b.example/",
        childIds: ["tab:b1"],
        active: false,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { tabId: 4, windowId: 1 }
      },
      "tab:b1": {
        id: "tab:b1",
        kind: "tab",
        status: "live",
        parentId: "tab:b",
        title: "Beta child",
        url: "https://b-child.example/",
        childIds: ["tab:b1i"],
        active: false,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { tabId: 5, windowId: 1 }
      },
      "tab:b1i": {
        id: "tab:b1i",
        kind: "tab",
        status: "live",
        parentId: "tab:b1",
        title: "Beta inner",
        url: "https://b-inner.example/",
        childIds: [],
        active: false,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { tabId: 6, windowId: 1 }
      },
      "tab:c": {
        id: "tab:c",
        kind: "tab",
        status: "live",
        parentId: "window:1",
        title: "Gamma",
        url: "https://c.example/",
        childIds: [],
        active: false,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { tabId: 7, windowId: 1 }
      },
      "window:2": {
        id: "window:2",
        kind: "window",
        status: "live",
        title: "Window",
        childIds: ["tab:z"],
        active: false,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { windowId: 2 }
      },
      "tab:z": {
        id: "tab:z",
        kind: "tab",
        status: "live",
        parentId: "window:2",
        title: "Zeta",
        url: "https://z.example/",
        childIds: [],
        active: false,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { tabId: 8, windowId: 2 }
      }
    }
  };
}
