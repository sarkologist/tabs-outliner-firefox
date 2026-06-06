import { describe, expect, it, vi } from "vitest";

import {
  LARGE_RESTORE_NODE_THRESHOLD,
  analyzeRestoreScope,
  bootstrapFromWindows,
  closeTab,
  closeWindow,
  deleteLiveTabNodeByTabId,
  deleteNode,
  flattenSubtreeOneLevel,
  moveNode,
  moveSubtreeToBottomTopLevel,
  moveSubtreeToTopLevel,
  moveTabToNewClosedWindow,
  moveTabToNewLiveWindow,
  planRestore,
  promoteChildrenOneLevel,
  projectLiveTabs,
  reconcileWithWindows,
  repairState,
  renameGroup,
  restoreNodes,
  wrapNodeInGroup
} from "./outline.js";
import { buildOutlineLookup } from "./outline-lookup.js";
import type { NodeId, OutlineNode, OutlineState, RuntimeWindow } from "./types.js";
import { makeSidebarStartupState } from "../perf/sidebar-startup-shapes.js";
import { generatedTraceConfig, generatedTraceTimeoutMs } from "../test/generated-traces.test-support.js";

const windows: RuntimeWindow[] = [
  {
    id: 10,
    incognito: false,
    focused: true,
    tabs: [
      {
        id: 1,
        windowId: 10,
        index: 0,
        active: true,
        url: "https://example.com/",
        title: "Example",
        favIconUrl: "https://example.com/favicon.ico"
      },
      {
        id: 2,
        windowId: 10,
        index: 1,
        active: false,
        openerTabId: 1,
        url: "https://example.com/child",
        title: "Child"
      },
      {
        id: 3,
        windowId: 10,
        index: 2,
        active: false,
        url: "about:blank",
        title: "Blank"
      }
    ]
  },
  {
    id: 11,
    incognito: true,
    focused: false,
    tabs: [
      {
        id: 4,
        windowId: 11,
        index: 0,
        active: true,
        url: "https://private.example/",
        title: "Private"
      }
    ]
  }
];

function reachableNodeIds(state: OutlineState): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  function visit(nodeId: string): void {
    if (seen.has(nodeId)) {
      return;
    }
    seen.add(nodeId);
    const node = state.nodes[nodeId];
    if (!node) {
      return;
    }
    ids.push(nodeId);
    for (const childId of node.childIds) {
      visit(childId);
    }
  }

  for (const rootId of state.rootIds) {
    visit(rootId);
  }

  return ids.sort();
}

function expectPreviouslyClosedNodesPreserved(previous: OutlineState, next: OutlineState): void {
  const reachable = new Set(reachableNodeIds(next));
  for (const [nodeId, previousNode] of Object.entries(previous.nodes)) {
    if (previousNode.status !== "closed") {
      continue;
    }
    const nextNode = next.nodes[nodeId];
    expect(nextNode, `previously closed node ${nodeId} must still exist`).toBeDefined();
    expect(
      nextNode?.status === "live" || reachable.has(nodeId),
      `previously closed node ${nodeId} must be live or reachable`
    ).toBe(true);
  }
}

function largeFlatLiveState(tabCount: number): OutlineState {
  const windowNode = {
    id: "window:10",
    kind: "window" as const,
    status: "live" as const,
    childIds: [] as string[],
    title: "Group",
    active: true,
    collapsed: false,
    createdAt: 1000,
    updatedAt: 1000,
    live: { windowId: 10 }
  };
  const state: OutlineState = {
    version: 1,
    rootIds: [windowNode.id],
    nodes: {
      [windowNode.id]: windowNode
    }
  };

  for (let index = 1; index <= tabCount; index += 1) {
    const id = `tab:${index}`;
    windowNode.childIds.push(id);
    state.nodes[id] = {
      id,
      kind: "tab",
      status: "live",
      parentId: windowNode.id,
      childIds: [],
      title: `Tab ${index}`,
      url: `https://large.example/${index}`,
      active: index === 1,
      collapsed: false,
      createdAt: 1000,
      updatedAt: 1000,
      live: { tabId: index, windowId: 10 }
    };
  }

  return state;
}

function largeFlatClosedState(tabCount: number): OutlineState {
  const windowNode = {
    id: "window:10",
    kind: "window" as const,
    status: "live" as const,
    childIds: [] as string[],
    title: "Group",
    active: true,
    collapsed: false,
    createdAt: 1000,
    updatedAt: 1000,
    live: { windowId: 10 }
  };
  const state: OutlineState = {
    version: 1,
    rootIds: [windowNode.id],
    nodes: {
      [windowNode.id]: windowNode
    }
  };

  for (let index = 1; index <= tabCount; index += 1) {
    const id = `tab:${index}`;
    windowNode.childIds.push(id);
    state.nodes[id] = {
      id,
      kind: "tab",
      status: "closed",
      parentId: windowNode.id,
      childIds: [],
      title: `Saved ${index}`,
      url: `https://saved.example/${index}`,
      collapsed: false,
      createdAt: 1000,
      updatedAt: 1000,
      closedAt: 2000 + index,
      restore: {
        url: `https://saved.example/${index}`,
        title: `Saved ${index}`
      }
    };
  }

  return state;
}

describe("outline model", () => {
  it("bootstraps normal windows and places opener tabs as children", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });

    expect(state.rootIds).toEqual(["window:10"]);
    expect(state.nodes["window:10"]?.title).toBe("Group");
    expect(state.nodes["window:10"]?.active).toBe(true);
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:3"]);
    expect(state.nodes["tab:1"]?.childIds).toEqual(["tab:2"]);
    expect(state.nodes["tab:2"]?.parentId).toBe("tab:1");
    expect(state.nodes["tab:4"]).toBeUndefined();
  });

  it("keeps blank opener tabs as window siblings", () => {
    const state = bootstrapFromWindows([
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: false,
            url: "https://calendar.example/week",
            title: "Google Calendar"
          },
          {
            id: 2,
            windowId: 10,
            index: 1,
            active: false,
            openerTabId: 1,
            url: "about:newtab",
            title: "New Tab"
          },
          {
            id: 3,
            windowId: 10,
            index: 2,
            active: true,
            openerTabId: 2,
            url: "about:blank",
            title: "New Tab"
          }
        ]
      }
    ], { now: 1000 });

    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:2", "tab:3"]);
    expect(state.nodes["tab:1"]?.childIds).toEqual([]);
    expect(state.nodes["tab:2"]?.childIds).toEqual([]);
    expect(state.nodes["tab:2"]?.parentId).toBe("window:10");
    expect(state.nodes["tab:3"]?.parentId).toBe("window:10");
  });

  it("renames groups with trimmed custom titles", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });

    const renamed = renameGroup(state, "window:10", "  Research  ", { now: 2000 });

    expect(state.nodes["window:10"]?.title).toBe("Group");
    expect(renamed.nodes["window:10"]?.title).toBe("Research");
    expect(renamed.nodes["window:10"]?.customTitle).toBe("Research");
    expect(renamed.nodes["window:10"]?.updatedAt).toBe(2000);
  });

  it("renames groups without copying unrelated nodes", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });

    const renamed = renameGroup(state, "window:10", "Research", { now: 2000 });
    const unchanged = renameGroup(renamed, "window:10", " Research ", { now: 3000 });

    expect(renamed.nodes["window:10"]).not.toBe(state.nodes["window:10"]);
    expect(renamed.nodes["tab:1"]).toBe(state.nodes["tab:1"]);
    expect(renamed.nodes["tab:2"]).toBe(state.nodes["tab:2"]);
    expect(unchanged).toBe(renamed);
  });

  it("clears blank group names back to the generic label", () => {
    const renamed = renameGroup(bootstrapFromWindows(windows, { now: 1000 }), "window:10", "Research", {
      now: 2000
    });

    const cleared = renameGroup(renamed, "window:10", "   ", { now: 3000 });

    expect(cleared.nodes["window:10"]?.title).toBe("Group");
    expect(cleared.nodes["window:10"]?.customTitle).toBeUndefined();
    expect(cleared.nodes["window:10"]?.updatedAt).toBe(3000);
  });

  it("does not rename tab nodes", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });

    const renamed = renameGroup(state, "tab:1", "Research", { now: 2000 });

    expect(renamed).toBe(state);
    expect(renamed.nodes["tab:1"]?.title).toBe("Example");
  });

  it("keeps tabs under their owning window when opener metadata crosses windows", () => {
    const state = bootstrapFromWindows([
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://source.example/",
            title: "Source"
          }
        ]
      },
      {
        id: 20,
        incognito: false,
        focused: false,
        tabs: [
          {
            id: 5,
            windowId: 20,
            index: 0,
            active: true,
            openerTabId: 1,
            url: "https://target.example/",
            title: "Target"
          }
        ]
      }
    ], { now: 1000 });

    expect(state.nodes["window:20"]?.childIds).toEqual(["tab:5"]);
    expect(state.nodes["tab:1"]?.childIds).toEqual([]);
    expect(state.nodes["tab:5"]?.parentId).toBe("window:20");
  });

  it("captures closed tabs in place with restore metadata", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });
    const next = closeTab(state, 2, {
      now: 2000,
      sessionId: "session-tab-2"
    });

    expect(next.nodes["tab:2"]?.status).toBe("closed");
    expect(next.nodes["tab:2"]?.live).toBeUndefined();
    expect(next.nodes["tab:2"]?.closedAt).toBe(2000);
    expect(next.nodes["tab:2"]?.restore?.sessionId).toBe("session-tab-2");
    expect(next.nodes["tab:2"]?.restore?.url).toBe("https://example.com/child");
  });

  it("closes a single tab without cloning unrelated nodes", () => {
    const state = largeFlatLiveState(50_000);
    const next = closeTab(state, 50_000, {
      now: 2000,
      sessionId: "session-tab-50000"
    });

    expect(next.nodes["tab:50000"]).not.toBe(state.nodes["tab:50000"]);
    expect(next.nodes["tab:50000"]?.status).toBe("closed");
    expect(next.nodes["tab:1"]).toBe(state.nodes["tab:1"]);
    expect(next.nodes["tab:25000"]).toBe(state.nodes["tab:25000"]);
    expect(next.nodes["window:10"]).toBe(state.nodes["window:10"]);
  });

  it("captures only the closed tab and promotes its children", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });
    const next = closeTab(state, 1, {
      now: 2000,
      sessionId: "session-tab-1"
    });

    expect(next.nodes["tab:1"]?.status).toBe("closed");
    expect(next.nodes["tab:1"]?.childIds).toEqual([]);
    expect(next.nodes["tab:2"]?.status).toBe("live");
    expect(next.nodes["tab:2"]?.parentId).toBe("window:10");
    expect(next.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:2", "tab:3"]);
  });

  it("captures closed windows and descendants in place", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });
    const next = closeWindow(state, 10, {
      now: 3000,
      sessionId: "session-window-10"
    });

    expect(next.nodes["window:10"]?.status).toBe("closed");
    expect(next.nodes["tab:1"]?.status).toBe("closed");
    expect(next.nodes["tab:2"]?.status).toBe("closed");
    expect(next.nodes["window:10"]?.restore?.sessionId).toBe("session-window-10");
  });

  it("does not restamp already closed descendants when a restored window closes", () => {
    const state: OutlineState = {
      version: 1,
      rootIds: ["imported:window:1000:1"],
      nodes: {
        "imported:window:1000:1": {
          id: "imported:window:1000:1",
          kind: "window",
          status: "live",
          childIds: ["imported:tab:1000:2", "imported:tab:1000:3"],
          title: "Group",
          active: true,
          collapsed: false,
          createdAt: 1000,
          updatedAt: 2000,
          live: { windowId: 42 }
        },
        "imported:tab:1000:2": {
          id: "imported:tab:1000:2",
          kind: "tab",
          status: "live",
          parentId: "imported:window:1000:1",
          childIds: [],
          title: "Restored imported",
          url: "https://images.example/restored.jpg",
          active: true,
          collapsed: false,
          createdAt: 1000,
          updatedAt: 2000,
          live: { tabId: 21, windowId: 42 },
          restoredFromClosed: true
        },
        "imported:tab:1000:3": {
          id: "imported:tab:1000:3",
          kind: "tab",
          status: "closed",
          parentId: "imported:window:1000:1",
          childIds: [],
          title: "Never restored imported",
          url: "https://images.example/closed.jpg",
          active: true,
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          closedAt: 1000,
          restore: {
            url: "https://images.example/closed.jpg",
            title: "Never restored imported"
          }
        }
      }
    };

    const next = closeWindow(state, 42, {
      now: 3000,
      sessionId: "session-restored-imported-window"
    });

    expect(next.nodes["imported:window:1000:1"]).toMatchObject({
      status: "closed",
      closedAt: 3000,
      restore: { sessionId: "session-restored-imported-window" }
    });
    expect(next.nodes["imported:tab:1000:2"]).toMatchObject({
      status: "closed",
      closedAt: 3000,
      restore: {
        url: "https://images.example/restored.jpg",
        title: "Restored imported"
      }
    });
    expect(next.nodes["imported:tab:1000:3"]).toMatchObject({
      status: "closed",
      closedAt: 1000,
      restore: {
        url: "https://images.example/closed.jpg",
        title: "Never restored imported"
      }
    });
    expect(next.nodes["imported:tab:1000:3"]?.active).toBeUndefined();
  });

  it("promotes nested foreign live windows when their outline parent window closes", () => {
    const state = wrapNodeInGroup(bootstrapFromWindows(windows, { now: 1000 }), "tab:1", {
      now: 2000,
      liveWindow: {
        id: 42,
        focused: true,
        incognito: false
      }
    });

    const next = closeWindow(state, 10, {
      now: 3000,
      sessionId: "session-window-10"
    });

    expect(next.rootIds).toEqual(["window:10", "window:42"]);
    expect(next.nodes["window:10"]?.status).toBe("closed");
    expect(next.nodes["window:10"]?.childIds).toEqual(["tab:3"]);
    expect(next.nodes["tab:3"]?.status).toBe("closed");
    expect(next.nodes["window:42"]?.status).toBe("live");
    expect(next.nodes["window:42"]?.parentId).toBeUndefined();
    expect(next.nodes["window:42"]?.childIds).toEqual(["tab:1"]);
    expect(next.nodes["tab:1"]?.status).toBe("live");
    expect(next.nodes["tab:1"]?.parentId).toBe("window:42");
    expect(next.nodes["tab:2"]?.status).toBe("live");
    expect(next.nodes["tab:2"]?.parentId).toBe("tab:1");
  });

  it("promotes foreign live tabs when their outline parent window closes", () => {
    const state: OutlineState = {
      version: 1,
      rootIds: ["window:10", "window:20"],
      nodes: {
        "window:10": {
          id: "window:10",
          kind: "window",
          status: "live",
          childIds: ["tab:1"],
          title: "Window 10",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          live: { windowId: 10 }
        },
        "tab:1": {
          id: "tab:1",
          kind: "tab",
          status: "live",
          parentId: "window:10",
          childIds: [],
          title: "Owner tab",
          url: "https://owner.example/",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          live: { tabId: 1, windowId: 10 }
        },
        "window:20": {
          id: "window:20",
          kind: "window",
          status: "live",
          childIds: ["tab:2", "tab:3"],
          title: "Window 20",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          live: { windowId: 20 }
        },
        "tab:2": {
          id: "tab:2",
          kind: "tab",
          status: "live",
          parentId: "window:20",
          childIds: ["tab:4"],
          title: "Foreign tab",
          url: "https://foreign.example/",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          live: { tabId: 2, windowId: 10 }
        },
        "tab:3": {
          id: "tab:3",
          kind: "tab",
          status: "live",
          parentId: "window:20",
          childIds: [],
          title: "Closed tab",
          url: "https://closed.example/",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          live: { tabId: 3, windowId: 20 }
        },
        "tab:4": {
          id: "tab:4",
          kind: "tab",
          status: "live",
          parentId: "tab:2",
          childIds: [],
          title: "Closed child",
          url: "https://closed-child.example/",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          live: { tabId: 4, windowId: 20 }
        }
      }
    };

    const next = closeWindow(state, 20, {
      now: 2000,
      sessionId: "session-window-20"
    });

    expect(next.nodes["window:20"]?.status).toBe("closed");
    expect(next.nodes["window:20"]?.childIds).toEqual(["tab:4", "tab:3"]);
    expect(next.nodes["tab:3"]?.status).toBe("closed");
    expect(next.nodes["tab:4"]?.status).toBe("closed");
    expect(next.nodes["tab:4"]?.parentId).toBe("window:20");
    expect(next.nodes["tab:2"]?.status).toBe("live");
    expect(next.nodes["tab:2"]?.parentId).toBe("window:10");
    expect(next.nodes["tab:2"]?.childIds).toEqual([]);
    expect(next.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:2"]);
  });

  it("deletes a live tab node by runtime id and promotes its live children", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });

    const deleted = deleteLiveTabNodeByTabId(state, 1);

    expect(deleted.nodes["tab:1"]).toBeUndefined();
    expect(deleted.nodes["window:10"]?.childIds).toEqual(["tab:2", "tab:3"]);
    expect(deleted.nodes["tab:2"]?.parentId).toBe("window:10");
    expect(deleted.nodes["tab:2"]?.status).toBe("live");
    expect(deleted.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: 10 });
    expect(deleted.nodes["tab:3"]?.status).toBe("live");
  });

  it("preserves closed child restore metadata when deleting a live tab node", () => {
    const state = closeTab(bootstrapFromWindows(windows, { now: 1000 }), 2, {
      now: 2000,
      sessionId: "session-tab-2"
    });

    const deleted = deleteLiveTabNodeByTabId(state, 1);

    expect(deleted.nodes["tab:1"]).toBeUndefined();
    expect(deleted.nodes["window:10"]?.childIds).toEqual(["tab:2", "tab:3"]);
    expect(deleted.nodes["tab:2"]?.parentId).toBe("window:10");
    expect(deleted.nodes["tab:2"]?.status).toBe("closed");
    expect(deleted.nodes["tab:2"]?.restore).toEqual({
      sessionId: "session-tab-2",
      url: "https://example.com/child",
      title: "Child"
    });
  });

  it("does not change state for an unknown live tab id deletion", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });

    expect(deleteLiveTabNodeByTabId(state, 999)).toBe(state);
  });

  it("removes an empty window after deleting its only live tab node by runtime id", () => {
    const state = bootstrapFromWindows([
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://solo.example/",
            title: "Solo"
          }
        ]
      }
    ], { now: 1000 });

    const deleted = deleteLiveTabNodeByTabId(state, 1);

    expect(deleted.nodes["tab:1"]).toBeUndefined();
    expect(deleted.nodes["window:10"]).toBeUndefined();
    expect(deleted.rootIds).toEqual([]);
  });

  it("moves a subtree and projects live tabs in preorder", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });
    const moved = moveNode(state, "tab:3", {
      parentId: "tab:1",
      index: 0
    });

    expect(moved.nodes["tab:1"]?.childIds).toEqual(["tab:3", "tab:2"]);
    expect(projectLiveTabs(moved, "window:10")).toEqual([
      { tabId: 1, windowId: 10 },
      { tabId: 3, windowId: 10 },
      { tabId: 2, windowId: 10 }
    ]);
  });

  it("keeps a closed single-tab window session with its tab when the tab is moved out", () => {
    const state = bootstrapFromWindows([
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://source.example/",
            title: "Source"
          }
        ]
      },
      {
        id: 20,
        incognito: false,
        focused: false,
        tabs: [
          {
            id: 2,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://target.example/",
            title: "Target"
          }
        ]
      }
    ], { now: 1000 });
    const closedSource = closeWindow(state, 10, { now: 2000, sessionId: "source-window-session" });
    const closedTarget = closeWindow(closedSource, 20, { now: 3000, sessionId: "target-window-session" });

    const moved = moveNode(closedTarget, "tab:1", { parentId: "window:20", index: 1 });

    expect(moved.nodes["window:10"]).toBeUndefined();
    expect(moved.nodes["tab:1"]?.restore).toMatchObject({
      sessionId: "source-window-session",
      url: "https://source.example/",
      title: "Source"
    });
    expect(moved.nodes["window:20"]?.childIds).toEqual(["tab:2", "tab:1"]);
  });

  it("projects live tabs with a caller-provided lookup without rebuilding it", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });
    const moved = moveNode(state, "tab:3", {
      parentId: "tab:1",
      index: 0
    });
    const lookup = buildOutlineLookup(moved);
    const originalValues = Object.values;
    let nodeTableScans = 0;
    const valuesSpy = vi.spyOn(Object, "values").mockImplementation(((value: object) => {
      if (value === moved.nodes) {
        nodeTableScans += 1;
      }
      return originalValues(value as never);
    }) as typeof Object.values);

    try {
      expect(projectLiveTabs(moved, "window:10", lookup)).toEqual([
        { tabId: 1, windowId: 10 },
        { tabId: 3, windowId: 10 },
        { tabId: 2, windowId: 10 }
      ]);
      expect(nodeTableScans).toBe(0);
    } finally {
      valuesSpy.mockRestore();
    }
  });

  it("indexes live projections and closed restore counts while scanning window ownership", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });
    const moved = moveNode(state, "tab:3", {
      parentId: "tab:1",
      index: 0
    });
    const windowNode = moved.nodes["window:10"]!;
    const withClosed: OutlineState = {
      ...moved,
      nodes: {
        ...moved.nodes,
        "window:10": {
          ...windowNode,
          childIds: [...windowNode.childIds, "tab:closed"]
        },
        "tab:closed": {
          id: "tab:closed",
          kind: "tab",
          status: "closed",
          parentId: "window:10",
          childIds: [],
          title: "Closed",
          url: "https://closed.example/",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          closedAt: 2000,
          restore: {
            url: "https://closed.example/",
            title: "Closed"
          }
        }
      }
    };

    const lookup = buildOutlineLookup(withClosed);

    expect(lookup.liveTabProjectionsByWindowNodeId.get("window:10")).toEqual([
      { tabId: 1, windowId: 10 },
      { tabId: 3, windowId: 10 },
      { tabId: 2, windowId: 10 }
    ]);
    expect(lookup.closedRestoreCandidateCountsByWindowNodeId.get("window:10")).toBe(1);
    expect(lookup.windowNodeIdsWithClosedRestoreCandidates.has("window:10")).toBe(true);
  });

  it("moves a subtree without copying unrelated nodes", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });

    const moved = moveNode(state, "tab:3", {
      parentId: "tab:1",
      index: 0
    });

    expect(moved.nodes["window:10"]).not.toBe(state.nodes["window:10"]);
    expect(moved.nodes["tab:1"]).not.toBe(state.nodes["tab:1"]);
    expect(moved.nodes["tab:3"]).not.toBe(state.nodes["tab:3"]);
    expect(moved.nodes["tab:2"]).toBe(state.nodes["tab:2"]);
  });

  it("flattens one subtree level below a node while preserving preorder", () => {
    const state = bootstrapFromWindows([
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://parent.example/",
            title: "Parent"
          },
          {
            id: 2,
            windowId: 10,
            index: 1,
            active: false,
            openerTabId: 1,
            url: "https://child-a.example/",
            title: "Child A"
          },
          {
            id: 3,
            windowId: 10,
            index: 2,
            active: false,
            openerTabId: 2,
            url: "https://grandchild-a.example/",
            title: "Grandchild A"
          },
          {
            id: 4,
            windowId: 10,
            index: 3,
            active: false,
            openerTabId: 1,
            url: "https://child-b.example/",
            title: "Child B"
          },
          {
            id: 5,
            windowId: 10,
            index: 4,
            active: false,
            openerTabId: 4,
            url: "https://grandchild-b.example/",
            title: "Grandchild B"
          }
        ]
      }
    ], { now: 1000 });

    const flattened = flattenSubtreeOneLevel(state, "tab:1");

    expect(flattened.nodes["tab:1"]?.childIds).toEqual(["tab:2", "tab:3", "tab:4", "tab:5"]);
    expect(flattened.nodes["tab:2"]?.childIds).toEqual([]);
    expect(flattened.nodes["tab:4"]?.childIds).toEqual([]);
    expect(flattened.nodes["tab:3"]?.parentId).toBe("tab:1");
    expect(flattened.nodes["tab:5"]?.parentId).toBe("tab:1");
    expect(projectLiveTabs(flattened, "window:10")).toEqual([
      { tabId: 1, windowId: 10 },
      { tabId: 2, windowId: 10 },
      { tabId: 3, windowId: 10 },
      { tabId: 4, windowId: 10 },
      { tabId: 5, windowId: 10 }
    ]);
  });

  it("flattens one subtree level without copying unrelated nodes", () => {
    const state = bootstrapFromWindows([
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://parent.example/",
            title: "Parent"
          },
          {
            id: 2,
            windowId: 10,
            index: 1,
            active: false,
            openerTabId: 1,
            url: "https://child.example/",
            title: "Child"
          },
          {
            id: 3,
            windowId: 10,
            index: 2,
            active: false,
            openerTabId: 2,
            url: "https://grandchild.example/",
            title: "Grandchild"
          },
          {
            id: 4,
            windowId: 10,
            index: 3,
            active: false,
            url: "https://sibling.example/",
            title: "Sibling"
          }
        ]
      }
    ], { now: 1000 });

    const flattened = flattenSubtreeOneLevel(state, "tab:1");

    expect(flattened.nodes["tab:1"]).not.toBe(state.nodes["tab:1"]);
    expect(flattened.nodes["tab:2"]).not.toBe(state.nodes["tab:2"]);
    expect(flattened.nodes["tab:3"]).not.toBe(state.nodes["tab:3"]);
    expect(flattened.nodes["tab:4"]).toBe(state.nodes["tab:4"]);
  });

  it("repeatedly flattens deeper child subtrees at the same node", () => {
    const nested = moveNode(bootstrapFromWindows(windows, { now: 1000 }), "tab:3", {
      parentId: "tab:2",
      index: 0
    });

    const once = flattenSubtreeOneLevel(nested, "window:10");
    const twice = flattenSubtreeOneLevel(once, "window:10");

    expect(once.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:2"]);
    expect(once.nodes["tab:1"]?.childIds).toEqual([]);
    expect(once.nodes["tab:2"]?.childIds).toEqual(["tab:3"]);
    expect(twice.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:2", "tab:3"]);
    expect(twice.nodes["tab:2"]?.childIds).toEqual([]);
    expect(twice.nodes["tab:3"]?.parentId).toBe("window:10");
  });

  it("promotes one node's children without flattening sibling subtrees", () => {
    const state = bootstrapFromWindows([
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://a.example/",
            title: "A"
          },
          {
            id: 2,
            windowId: 10,
            index: 1,
            active: false,
            openerTabId: 1,
            url: "https://a-child.example/",
            title: "a1"
          },
          {
            id: 3,
            windowId: 10,
            index: 2,
            active: false,
            url: "https://b.example/",
            title: "B"
          },
          {
            id: 4,
            windowId: 10,
            index: 3,
            active: false,
            openerTabId: 3,
            url: "https://b-child.example/",
            title: "b1"
          }
        ]
      }
    ], { now: 1000 });

    const promoted = promoteChildrenOneLevel(state, "tab:1");

    expect(promoted.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:2", "tab:3"]);
    expect(promoted.nodes["tab:1"]?.childIds).toEqual([]);
    expect(promoted.nodes["tab:2"]?.parentId).toBe("window:10");
    expect(promoted.nodes["tab:3"]?.childIds).toEqual(["tab:4"]);
    expect(promoted.nodes["tab:4"]?.parentId).toBe("tab:3");
    expect(projectLiveTabs(promoted, "window:10")).toEqual([
      { tabId: 1, windowId: 10 },
      { tabId: 2, windowId: 10 },
      { tabId: 3, windowId: 10 },
      { tabId: 4, windowId: 10 }
    ]);
  });

  it("leaves promote children as a no-op for leaves, roots, missing nodes, and live window containers", () => {
    const state = wrapNodeInGroup(bootstrapFromWindows(windows, { now: 1000 }), "tab:1", {
      now: 2000,
      liveWindow: {
        id: 42,
        focused: true,
        incognito: false
      }
    });
    const liveWindowWrapperId = state.nodes["tab:1"]?.parentId;
    expect(liveWindowWrapperId).toBeDefined();

    expect(promoteChildrenOneLevel(state, "tab:2")).toBe(state);
    expect(promoteChildrenOneLevel(state, "window:10")).toBe(state);
    expect(promoteChildrenOneLevel(state, "missing")).toBe(state);
    expect(promoteChildrenOneLevel(state, liveWindowWrapperId!)).toBe(state);
  });

  it("promotes children without copying unrelated nodes", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });

    const promoted = promoteChildrenOneLevel(state, "tab:1");

    expect(promoted.nodes["window:10"]).not.toBe(state.nodes["window:10"]);
    expect(promoted.nodes["tab:1"]).not.toBe(state.nodes["tab:1"]);
    expect(promoted.nodes["tab:2"]).not.toBe(state.nodes["tab:2"]);
    expect(promoted.nodes["tab:3"]).toBe(state.nodes["tab:3"]);
    expect(promoted.nodes["window:11"]).toBe(state.nodes["window:11"]);
    expect(promoted.nodes["tab:4"]).toBe(state.nodes["tab:4"]);
  });

  it("wraps a live tab subtree in a new live window", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });
    const moved = moveTabToNewLiveWindow(state, "tab:1", {
      id: 42,
      focused: true,
      incognito: false
    }, { now: 2000 });

    expect(moved.rootIds).toEqual(["window:10", "window:42"]);
    expect(moved.nodes["window:10"]?.childIds).toEqual(["tab:3"]);
    expect(moved.nodes["window:42"]?.childIds).toEqual(["tab:1"]);
    expect(moved.nodes["window:42"]?.status).toBe("live");
    expect(moved.nodes["window:42"]?.title).toBe("Group");
    expect(moved.nodes["window:10"]?.title).toBe("Group");
    expect(moved.nodes["window:42"]?.active).toBe(true);
    expect(moved.nodes["window:10"]?.active).toBe(false);
    expect(moved.nodes["window:42"]?.live).toEqual({ windowId: 42 });
    expect(moved.nodes["tab:1"]?.parentId).toBe("window:42");
    expect(moved.nodes["tab:1"]?.live).toEqual({ tabId: 1, windowId: 42 });
    expect(moved.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: 42 });
    expect(projectLiveTabs(moved, "window:42")).toEqual([
      { tabId: 1, windowId: 42 },
      { tabId: 2, windowId: 42 }
    ]);
  });

  it("inserts a new live window at the requested root index", () => {
    const state = bootstrapFromWindows([
      ...windows,
      {
        id: 20,
        incognito: false,
        focused: false,
        tabs: [
          {
            id: 5,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://target.example/",
            title: "Target"
          }
        ]
      }
    ], { now: 1000 });

    const moved = moveTabToNewLiveWindow(state, "tab:1", {
      id: 42,
      focused: true,
      incognito: false
    }, { now: 2000, rootIndex: 1 });

    expect(moved.rootIds).toEqual(["window:10", "window:42", "window:20"]);
    expect(moved.nodes["window:42"]?.childIds).toEqual(["tab:1"]);
  });

  it("wraps a closed tab in a closed window placeholder", () => {
    const state = closeTab(bootstrapFromWindows(windows, { now: 1000 }), 1, {
      now: 2000,
      sessionId: "session-tab-1"
    });
    const moved = moveTabToNewClosedWindow(state, "tab:1", { now: 3000 });
    const placeholderId = moved.rootIds[1]!;

    expect(placeholderId).toBe("window:placeholder:3000");
    expect(moved.nodes["window:10"]?.childIds).toEqual(["tab:2", "tab:3"]);
    expect(moved.nodes[placeholderId]).toMatchObject({
      kind: "window",
      status: "closed",
      childIds: ["tab:1"],
      title: "Group",
      closedAt: 3000
    });
    expect(moved.nodes[placeholderId]?.live).toBeUndefined();
    expect(moved.nodes[placeholderId]?.restore).toBeUndefined();
    expect(moved.nodes["tab:1"]?.parentId).toBe(placeholderId);
    expect(moved.nodes["tab:1"]?.status).toBe("closed");
    expect(planRestore(moved, placeholderId).map((plan) => ({
      ...plan,
      windowNodeId: plan.windowNodeId
    }))).toEqual([
      {
        nodeId: "tab:1",
        kind: "session",
        sessionId: "session-tab-1",
        fallbackTarget: { kind: "url", url: "https://example.com/" },
        windowNodeId: placeholderId
      }
    ]);
  });

  it("wraps a live tab in a new live window group at the same outline position", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });

    const wrapped = wrapNodeInGroup(state, "tab:1", {
      now: 3000,
      liveWindow: {
        id: 42,
        focused: true,
        incognito: false
      }
    });

    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:3"]);
    expect(wrapped.nodes["window:10"]?.childIds).toEqual(["window:42", "tab:3"]);
    expect(wrapped.nodes["window:42"]).toMatchObject({
      kind: "window",
      status: "live",
      parentId: "window:10",
      childIds: ["tab:1"],
      title: "Group",
      collapsed: false,
      active: true,
      live: { windowId: 42 }
    });
    expect(wrapped.nodes["tab:1"]?.parentId).toBe("window:42");
    expect(wrapped.nodes["tab:1"]?.live).toEqual({ tabId: 1, windowId: 42 });
    expect(wrapped.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: 42 });
    expect(projectLiveTabs(wrapped, "window:42")).toEqual([
      { tabId: 1, windowId: 42 },
      { tabId: 2, windowId: 42 }
    ]);
  });

  it("wraps a closed tab in a closed window group at the same outline position", () => {
    const state = closeTab(bootstrapFromWindows(windows, { now: 1000 }), 1, {
      now: 2000,
      sessionId: "session-tab-1"
    });

    const wrapped = wrapNodeInGroup(state, "tab:1", { now: 3000 });
    const placeholderId = "window:placeholder:3000";

    expect(wrapped.nodes["window:10"]?.childIds).toEqual([placeholderId, "tab:2", "tab:3"]);
    expect(wrapped.nodes[placeholderId]).toMatchObject({
      kind: "window",
      status: "closed",
      parentId: "window:10",
      childIds: ["tab:1"],
      title: "Group",
      collapsed: false,
      closedAt: 3000
    });
    expect(wrapped.nodes["tab:1"]?.parentId).toBe(placeholderId);
    expect(planRestore(wrapped, placeholderId)).toEqual([
      {
        nodeId: "tab:1",
        kind: "session",
        sessionId: "session-tab-1",
        fallbackTarget: { kind: "url", url: "https://example.com/" },
        windowNodeId: placeholderId
      }
    ]);
  });

  it("wraps a root group/window row in a neutral outline group", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });

    const wrapped = wrapNodeInGroup(state, "window:10", { now: 3000 });

    expect(wrapped.rootIds).toEqual(["group:3000"]);
    expect(wrapped.nodes["group:3000"]).toMatchObject({
      kind: "group",
      status: "neutral",
      childIds: ["window:10"],
      title: "Group",
      collapsed: false
    });
    expect(wrapped.nodes["group:3000"]?.parentId).toBeUndefined();
    expect(wrapped.nodes["window:10"]?.parentId).toBe("group:3000");
  });

  it("wraps existing neutral group rows in another neutral group", () => {
    const state = wrapNodeInGroup(bootstrapFromWindows(windows, { now: 1000 }), "window:10", { now: 3000 });

    const wrapped = wrapNodeInGroup(state, "group:3000", { now: 4000 });

    expect(wrapped.rootIds).toEqual(["group:4000"]);
    expect(wrapped.nodes["group:4000"]).toMatchObject({
      kind: "group",
      status: "neutral",
      childIds: ["group:3000"],
      title: "Group"
    });
    expect(wrapped.nodes["group:3000"]?.parentId).toBe("group:4000");
  });

  it("preserves unrelated node identities when wrapping a node in a group", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });

    const wrapped = wrapNodeInGroup(state, "tab:1", {
      now: 3000,
      liveWindow: {
        id: 42,
        focused: true,
        incognito: false
      }
    });

    expect(wrapped.nodes["window:10"]).not.toBe(state.nodes["window:10"]);
    expect(wrapped.nodes["tab:1"]).not.toBe(state.nodes["tab:1"]);
    expect(wrapped.nodes["tab:2"]).not.toBe(state.nodes["tab:2"]);
    expect(wrapped.nodes["tab:3"]).toBe(state.nodes["tab:3"]);
  });

  it("preserves the source window session when wrapping its only closed tab", () => {
    const state = closeWindow(bootstrapFromWindows([
      ...windows,
      {
        id: 20,
        incognito: false,
        focused: false,
        tabs: [
          {
            id: 5,
            windowId: 20,
            index: 0,
            active: true,
            url: "about:debugging#/runtime/this-firefox",
            title: "Debugging - Runtime / this-firefox"
          }
        ]
      }
    ], { now: 1000 }), 20, {
      now: 2000,
      sessionId: "session-window-20"
    });
    const moved = moveTabToNewClosedWindow(state, "tab:5", { now: 3000 });
    const placeholderId = moved.rootIds.at(-1)!;

    expect(moved.nodes["window:20"]).toBeUndefined();
    expect(moved.nodes[placeholderId]).toMatchObject({
      kind: "window",
      status: "closed",
      childIds: ["tab:5"],
      restore: {
        sessionId: "session-window-20"
      }
    });
    expect(planRestore(moved, placeholderId)).toEqual([
      {
        nodeId: placeholderId,
        kind: "session",
        sessionId: "session-window-20",
        windowNodeId: placeholderId
      }
    ]);
  });

  it("plans session restores first and url fallback second", () => {
    const state = closeTab(bootstrapFromWindows(windows, { now: 1000 }), 2, {
      now: 2000,
      sessionId: "session-tab-2"
    });

    expect(planRestore(state, "tab:2")).toEqual([
      {
        nodeId: "tab:2",
        kind: "session",
        sessionId: "session-tab-2",
        fallbackTarget: { kind: "url", url: "https://example.com/child" },
        windowNodeId: "window:10"
      }
    ]);
  });

  it("keeps the closed window destination when planning create restores", () => {
    const state = closeWindow(bootstrapFromWindows(windows, { now: 1000 }), 10, {
      now: 2000,
      sessionId: "session-window-10"
    });

    expect(planRestore(state, "tab:2")).toEqual([
      {
        nodeId: "tab:2",
        kind: "create",
        target: { kind: "url", url: "https://example.com/child" },
        windowNodeId: "window:10"
      }
    ]);
  });

  it("plans blank create targets for closed about blank and newtab nodes", () => {
    const state = closeWindow(bootstrapFromWindows([
      {
        id: 10,
        focused: true,
        incognito: false,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "about:newtab",
            title: "New Tab"
          },
          {
            id: 2,
            windowId: 10,
            index: 1,
            active: false,
            url: "about:blank",
            title: "New Tab"
          }
        ]
      }
    ], { now: 1000 }), 10, { now: 2000 });

    expect(planRestore(state, "window:10")).toEqual([
      {
        nodeId: "tab:1",
        kind: "create",
        target: { kind: "blank" },
        windowNodeId: "window:10"
      },
      {
        nodeId: "tab:2",
        kind: "create",
        target: { kind: "blank" },
        windowNodeId: "window:10"
      }
    ]);
    expect(analyzeRestoreScope(state, "window:10")).toMatchObject({
      nodeIds: ["tab:1", "tab:2"],
      totalCount: 2,
      tabCount: 2,
      windowCount: 0
    });
  });

  it("counts unique restorable closed nodes in a restore subtree", () => {
    const tabCount = LARGE_RESTORE_NODE_THRESHOLD + 1;
    const state = closeWindow(bootstrapFromWindows([windowWithTabs(10, tabCount)], { now: 1000 }), 10, {
      now: 2000,
      sessionId: "session-window-10"
    });

    const scope = analyzeRestoreScope(state, "window:10");

    expect(scope).toEqual({
      nodeIds: ["window:10", ...Array.from({ length: tabCount }, (_value, index) => `tab:${index + 1}`)],
      totalCount: tabCount + 1,
      tabCount,
      windowCount: 1,
      threshold: LARGE_RESTORE_NODE_THRESHOLD,
      requiresConfirmation: true
    });
  });

  it("ignores live nodes and closed nodes without restore plans when counting restore scope", () => {
    let state = closeTab(bootstrapFromWindows(windows, { now: 1000 }), 2, {
      now: 2000,
      sessionId: "session-tab-2"
    });
    const closedWithoutRestore = {
      ...state.nodes["tab:3"]!,
      status: "closed" as const
    };
    delete closedWithoutRestore.live;
    delete closedWithoutRestore.restore;
    state = {
      ...state,
      nodes: {
        ...state.nodes,
        "tab:3": closedWithoutRestore
      }
    };

    expect(analyzeRestoreScope(state, "window:10")).toMatchObject({
      nodeIds: ["tab:2"],
      totalCount: 1,
      tabCount: 1,
      windowCount: 0,
      requiresConfirmation: false
    });
  });

  it("requires large restore confirmation only above the threshold", () => {
    const atThreshold = closeWindow(
      bootstrapFromWindows([windowWithTabs(10, LARGE_RESTORE_NODE_THRESHOLD)], { now: 1000 }),
      10,
      { now: 2000 }
    );
    const aboveThreshold = closeWindow(
      bootstrapFromWindows([windowWithTabs(10, LARGE_RESTORE_NODE_THRESHOLD + 1)], { now: 1000 }),
      10,
      { now: 2000 }
    );

    expect(analyzeRestoreScope(atThreshold, "window:10")).toMatchObject({
      totalCount: LARGE_RESTORE_NODE_THRESHOLD,
      requiresConfirmation: false
    });
    expect(analyzeRestoreScope(aboveThreshold, "window:10")).toMatchObject({
      totalCount: LARGE_RESTORE_NODE_THRESHOLD + 1,
      requiresConfirmation: true
    });
  });

  it("reattaches restored live ids without duplicating nodes", () => {
    const state = closeTab(bootstrapFromWindows(windows, { now: 1000 }), 2, {
      now: 2000,
      sessionId: "session-tab-2"
    });
    const restored = restoreNodes(state, [
      {
        nodeId: "tab:2",
        tabId: 22,
        windowId: 10,
        active: false,
        url: "https://example.com/child",
        title: "Child"
      }
    ]);

    expect(restored.nodes["tab:2"]?.status).toBe("live");
    expect(restored.nodes["tab:2"]?.live).toEqual({ tabId: 22, windowId: 10 });
    expect(restored.nodes["tab:2"]?.active).toBe(false);
    expect(restored.nodes["tab:2"]?.restoredFromClosed).toBe(true);
    expect(Object.keys(restored.nodes).filter((id) => id === "tab:2")).toHaveLength(1);
  });

  it("closes restored tab subgroup runtime owners as closed subtrees", () => {
    const state: OutlineState = {
      version: 1,
      rootIds: ["window:parent"],
      nodes: {
        "window:parent": {
          id: "window:parent",
          kind: "window",
          status: "closed",
          childIds: ["tab:root"],
          title: "Imported parent",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          closedAt: 1000
        },
        "tab:root": {
          id: "tab:root",
          kind: "tab",
          status: "live",
          parentId: "window:parent",
          childIds: ["tab:child"],
          title: "Restored root",
          url: "https://restore.example/root",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 2000,
          restoredFromClosed: true,
          live: { tabId: 41, windowId: 42 }
        },
        "tab:child": {
          id: "tab:child",
          kind: "tab",
          status: "live",
          parentId: "tab:root",
          childIds: [],
          title: "Restored child",
          url: "https://restore.example/child",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 2000,
          restoredFromClosed: true,
          live: { tabId: 43, windowId: 42 }
        }
      }
    };

    const closed = closeWindow(state, 42, {
      now: 3000,
      sessionId: "session-restored-owner",
      closedBy: "outliner"
    });

    expect(closed.nodes["window:parent"]).toMatchObject({
      status: "closed",
      childIds: ["tab:root"]
    });
    expect(closed.nodes["tab:root"]).toMatchObject({
      status: "closed",
      childIds: ["tab:child"],
      restore: expect.objectContaining({
        sessionId: "session-restored-owner",
        url: "https://restore.example/root",
        title: "Restored root",
        closedBy: "outliner"
      })
    });
    expect(closed.nodes["tab:child"]).toMatchObject({
      status: "closed",
      restore: expect.objectContaining({
        url: "https://restore.example/child",
        title: "Restored child",
        closedBy: "outliner"
      })
    });
    expect(closed.nodes["tab:root"]?.live).toBeUndefined();
    expect(closed.nodes["tab:child"]?.live).toBeUndefined();
  });

  it("keeps a restored tab's saved title while runtime reports transient titles", () => {
    const state = closeTab(bootstrapFromWindows(windows, { now: 1000 }), 2, {
      now: 2000,
      sessionId: "session-tab-2"
    });

    for (const transientTitle of ["New Tab", "new tab", "https://example.com/child"]) {
      const restored = restoreNodes(state, [
        {
          nodeId: "tab:2",
          tabId: 22,
          windowId: 10,
          active: false,
          url: "https://example.com/child",
          title: transientTitle
        }
      ]);

      expect(restored.nodes["tab:2"]?.title).toBe("Child");
      expect(restored.nodes["tab:2"]?.url).toBe("https://example.com/child");
      expect(restored.nodes["tab:2"]?.restoredFromClosed).toBe(true);
    }

    const rootUrlState = closeTab(bootstrapFromWindows(windows, { now: 1000 }), 1, {
      now: 2000,
      sessionId: "session-tab-1"
    });
    const restoredRootUrl = restoreNodes(rootUrlState, [
      {
        nodeId: "tab:1",
        tabId: 21,
        windowId: 10,
        active: false,
        url: "https://example.com/",
        title: "https://example.com"
      }
    ]);

    expect(restoredRootUrl.nodes["tab:1"]?.title).toBe("Example");
    expect(restoredRootUrl.nodes["tab:1"]?.url).toBe("https://example.com/");

    const localState = closeTab(bootstrapFromWindows([
      {
        id: 20,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 20,
            windowId: 20,
            index: 0,
            active: true,
            url: "http://localhost:8089/restored",
            title: "Saved Local"
          }
        ]
      }
    ], { now: 1000 }), 20, {
      now: 2000,
      sessionId: "session-local"
    });
    const restoredLocal = restoreNodes(localState, [
      {
        nodeId: "tab:20",
        tabId: 21,
        windowId: 20,
        active: true,
        url: "http://localhost:8089/restored",
        title: "localhost:8089/"
      }
    ]);

    expect(restoredLocal.nodes["tab:20"]?.title).toBe("Saved Local");
    expect(restoredLocal.nodes["tab:20"]?.url).toBe("http://localhost:8089/restored");
  });

  it("updates a restored tab once runtime reports a meaningful title", () => {
    const state = closeTab(bootstrapFromWindows(windows, { now: 1000 }), 2, {
      now: 2000,
      sessionId: "session-tab-2"
    });
    const restored = restoreNodes(state, [
      {
        nodeId: "tab:2",
        tabId: 22,
        windowId: 10,
        active: false,
        url: "https://example.com/child",
        title: "New Tab"
      }
    ]);

    const reconciled = reconcileWithWindows(restored, [
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://example.com/",
            title: "Example"
          },
          {
            id: 22,
            windowId: 10,
            index: 1,
            active: false,
            url: "https://example.com/child",
            title: "Loaded child"
          }
        ]
      }
    ], { now: 5000 });

    expect(restored.nodes["tab:2"]?.title).toBe("Child");
    expect(reconciled.nodes["tab:2"]?.title).toBe("Loaded child");
  });

  it("marks restored closed window nodes that become live", () => {
    const state = closeWindow(bootstrapFromWindows(windows, { now: 1000 }), 10, {
      now: 2000,
      sessionId: "session-window-10"
    });
    const restored = restoreNodes(state, [
      {
        nodeId: "window:10",
        windowId: 20
      },
      {
        nodeId: "tab:1",
        tabId: 11,
        windowId: 20,
        url: "https://example.com/",
        title: "Example"
      }
    ]);

    expect(restored.nodes["window:10"]?.status).toBe("live");
    expect(restored.nodes["window:10"]?.restoredFromClosed).toBe(true);
    expect(restored.nodes["tab:1"]?.status).toBe("live");
    expect(restored.nodes["tab:1"]?.restoredFromClosed).toBe(true);
  });

  it("preserves a restored closed window under closed ancestors", () => {
    let state = bootstrapFromWindows([
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://parent.example/",
            title: "Parent"
          }
        ]
      },
      {
        id: 20,
        incognito: false,
        focused: false,
        tabs: [
          {
            id: 2,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://child.example/",
            title: "Child"
          }
        ]
      }
    ], { now: 1000 });
    state = closeWindow(state, 20, { now: 2000, sessionId: "session-window-20" });
    state = closeWindow(state, 10, { now: 3000, sessionId: "session-window-10" });
    state = {
      ...state,
      rootIds: ["window:10"],
      nodes: {
        ...state.nodes,
        "window:10": {
          ...state.nodes["window:10"]!,
          childIds: [...state.nodes["window:10"]!.childIds, "window:20"]
        },
        "window:20": {
          ...state.nodes["window:20"]!,
          parentId: "window:10"
        }
      }
    };

    const restored = restoreNodes(state, [
      {
        nodeId: "window:20",
        windowId: 30,
        active: true
      },
      {
        nodeId: "tab:2",
        tabId: 22,
        windowId: 30,
        active: true,
        url: "https://child.example/",
        title: "Child"
      }
    ]);

    expect(restored.rootIds).toEqual(["window:10"]);
    expect(restored.nodes["window:10"]?.status).toBe("closed");
    expect(restored.nodes["window:10"]?.childIds).toEqual(["tab:1", "window:20"]);
    expect(restored.nodes["window:20"]?.status).toBe("live");
    expect(restored.nodes["window:20"]?.parentId).toBe("window:10");
    expect(restored.nodes["tab:2"]?.parentId).toBe("window:20");
  });

  it("preserves a restored child-bearing tab subgroup under closed ancestors", () => {
    const state: OutlineState = {
      version: 1,
      rootIds: ["window:parent"],
      nodes: {
        "window:parent": {
          id: "window:parent",
          kind: "window",
          status: "closed",
          childIds: ["tab:subgroup"],
          title: "Imported parent",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          closedAt: 1000
        },
        "tab:subgroup": {
          id: "tab:subgroup",
          kind: "tab",
          status: "closed",
          parentId: "window:parent",
          childIds: ["tab:child"],
          title: "Imported subgroup",
          url: "https://subgroup.example/",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          closedAt: 1000,
          restore: {
            url: "https://subgroup.example/",
            title: "Imported subgroup"
          }
        },
        "tab:child": {
          id: "tab:child",
          kind: "tab",
          status: "closed",
          parentId: "tab:subgroup",
          childIds: [],
          title: "Imported child",
          url: "https://subgroup.example/child",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          closedAt: 1000,
          restore: {
            url: "https://subgroup.example/child",
            title: "Imported child"
          }
        }
      }
    };

    const restored = restoreNodes(state, [
      {
        nodeId: "tab:subgroup",
        tabId: 10,
        windowId: 50,
        url: "https://subgroup.example/",
        title: "Imported subgroup"
      },
      {
        nodeId: "tab:child",
        tabId: 11,
        windowId: 50,
        url: "https://subgroup.example/child",
        title: "Imported child"
      }
    ]);

    expect(restored.rootIds).toEqual(["window:parent"]);
    expect(restored.nodes["window:parent"]?.status).toBe("closed");
    expect(restored.nodes["window:parent"]?.childIds).toEqual(["tab:subgroup"]);
    expect(restored.nodes["tab:subgroup"]).toMatchObject({
      status: "live",
      parentId: "window:parent",
      childIds: ["tab:child"]
    });
    expect(restored.nodes["tab:child"]).toMatchObject({
      status: "live",
      parentId: "tab:subgroup"
    });
  });

  it("preserves a restored child-bearing tab subgroup through runtime reconciliation", () => {
    const state: OutlineState = {
      version: 1,
      rootIds: ["window:parent"],
      nodes: {
        "window:parent": {
          id: "window:parent",
          kind: "window",
          status: "closed",
          childIds: ["tab:subgroup"],
          title: "Imported parent",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          closedAt: 1000
        },
        "tab:subgroup": {
          id: "tab:subgroup",
          kind: "tab",
          status: "closed",
          parentId: "window:parent",
          childIds: ["tab:child"],
          title: "Imported subgroup",
          url: "https://subgroup.example/",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          closedAt: 1000,
          restore: {
            url: "https://subgroup.example/",
            title: "Imported subgroup"
          }
        },
        "tab:child": {
          id: "tab:child",
          kind: "tab",
          status: "closed",
          parentId: "tab:subgroup",
          childIds: [],
          title: "Imported child",
          url: "https://subgroup.example/child",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          closedAt: 1000,
          restore: {
            url: "https://subgroup.example/child",
            title: "Imported child"
          }
        }
      }
    };
    const restored = restoreNodes(state, [
      {
        nodeId: "tab:subgroup",
        tabId: 10,
        windowId: 50,
        url: "https://subgroup.example/",
        title: "Imported subgroup"
      },
      {
        nodeId: "tab:child",
        tabId: 11,
        windowId: 50,
        url: "https://subgroup.example/child",
        title: "Imported child"
      }
    ]);

    const reconciled = reconcileWithWindows(restored, [
      {
        id: 50,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 10,
            windowId: 50,
            index: 0,
            active: true,
            url: "https://subgroup.example/",
            title: "Imported subgroup"
          },
          {
            id: 11,
            windowId: 50,
            index: 1,
            active: false,
            url: "https://subgroup.example/child",
            title: "Imported child"
          }
        ]
      }
    ], { now: 2000 });

    expect(reconciled.rootIds).toEqual(["window:parent"]);
    expect(reconciled.nodes["window:parent"]?.status).toBe("closed");
    expect(reconciled.nodes["window:parent"]?.childIds).toEqual(["tab:subgroup"]);
    expect(reconciled.nodes["tab:subgroup"]).toMatchObject({
      status: "live",
      parentId: "window:parent",
      childIds: ["tab:child"],
      live: { tabId: 10, windowId: 50 }
    });
    expect(reconciled.nodes["tab:child"]).toMatchObject({
      status: "live",
      parentId: "tab:subgroup",
      live: { tabId: 11, windowId: 50 }
    });
  });

  it("reattaches restored tab subgroup children when the subgroup tab closes", () => {
    const state: OutlineState = {
      version: 1,
      rootIds: ["window:10", "window:parent"],
      nodes: {
        "window:10": {
          id: "window:10",
          kind: "window",
          status: "live",
          childIds: [],
          title: "Group",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          live: { windowId: 10 }
        },
        "window:parent": {
          id: "window:parent",
          kind: "window",
          status: "closed",
          childIds: ["tab:subgroup"],
          title: "Imported parent",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          closedAt: 1000
        },
        "tab:subgroup": {
          id: "tab:subgroup",
          kind: "tab",
          status: "live",
          parentId: "window:parent",
          childIds: ["tab:child"],
          title: "Imported subgroup",
          url: "https://subgroup.example/",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          restoredFromClosed: true,
          live: { tabId: 10, windowId: 10 }
        },
        "tab:child": {
          id: "tab:child",
          kind: "tab",
          status: "live",
          parentId: "tab:subgroup",
          childIds: [],
          title: "Imported child",
          url: "https://subgroup.example/child",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          restoredFromClosed: true,
          live: { tabId: 11, windowId: 10 }
        }
      }
    };

    const closed = closeTab(state, 10, {
      now: 2000,
      sessionId: "session-subgroup"
    });

    expect(closed.nodes["window:parent"]?.status).toBe("closed");
    expect(closed.nodes["window:parent"]?.childIds).toEqual(["tab:subgroup"]);
    expect(closed.nodes["tab:subgroup"]).toMatchObject({
      status: "closed",
      parentId: "window:parent",
      childIds: []
    });
    expect(closed.nodes["window:10"]?.childIds).toEqual(["tab:child"]);
    expect(closed.nodes["tab:child"]).toMatchObject({
      status: "live",
      parentId: "window:10",
      live: { tabId: 11, windowId: 10 }
    });
  });

  it("updates stale browser-created provenance when a closed window is restored live", () => {
    const browserCreated = bootstrapFromWindows([
      {
        id: 21,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 100,
            windowId: 21,
            index: 0,
            active: true,
            url: "https://external.example/",
            title: "External"
          }
        ]
      }
    ], { now: 1000 });
    browserCreated.nodes["window:21"]!.runtimeProvenance = "browserCreated";
    const state = closeWindow(browserCreated, 21, { now: 2000 });

    const restored = restoreNodes(state, [
      {
        nodeId: "window:21",
        windowId: 22,
        active: true
      },
      {
        nodeId: "tab:100",
        tabId: 101,
        windowId: 22,
        active: true,
        url: "https://external.example/",
        title: "External"
      }
    ]);

    expect(restored.nodes["window:21"]?.status).toBe("live");
    expect(restored.nodes["window:21"]?.restoredFromClosed).toBe(true);
    expect(restored.nodes["window:21"]?.runtimeProvenance).toBe("commandCreated");
  });

  it("marks restored focused windows active and clears the previous active window", () => {
    const state = closeWindow(bootstrapFromWindows([
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://active.example/",
            title: "Active"
          }
        ]
      },
      {
        id: 20,
        incognito: false,
        focused: false,
        tabs: [
          {
            id: 2,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://restored.example/",
            title: "Restored"
          }
        ]
      }
    ], { now: 1000 }), 20, {
      now: 2000,
      sessionId: "session-window-20"
    });

    const restored = restoreNodes(state, [
      {
        nodeId: "window:20",
        windowId: 30,
        active: true
      },
      {
        nodeId: "tab:2",
        tabId: 22,
        windowId: 30,
        active: true,
        url: "https://restored.example/",
        title: "Restored"
      }
    ]);

    expect(restored.nodes["window:10"]?.active).toBe(false);
    expect(restored.nodes["window:20"]?.active).toBe(true);
  });

  it("keeps the current active window when restoring an unfocused window", () => {
    const state = closeWindow(bootstrapFromWindows([
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://active.example/",
            title: "Active"
          }
        ]
      },
      {
        id: 20,
        incognito: false,
        focused: false,
        tabs: [
          {
            id: 2,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://restored.example/",
            title: "Restored"
          }
        ]
      }
    ], { now: 1000 }), 20, {
      now: 2000,
      sessionId: "session-window-20"
    });

    const restored = restoreNodes(state, [
      {
        nodeId: "window:20",
        windowId: 30,
        active: false
      },
      {
        nodeId: "tab:2",
        tabId: 22,
        windowId: 30,
        active: true,
        url: "https://restored.example/",
        title: "Restored"
      }
    ]);

    expect(restored.nodes["window:10"]?.active).toBe(true);
    expect(restored.nodes["window:20"]?.active).toBe(false);
  });

  it("preserves unchanged node identities when restoring a single node", () => {
    const state = largeFlatClosedState(50_000);

    const restored = restoreNodes(state, [
      {
        nodeId: "tab:50000",
        tabId: 100000,
        windowId: 10,
        url: "https://saved.example/50000",
        title: "Saved 50000"
      }
    ]);

    expect(restored.nodes["tab:50000"]).not.toBe(state.nodes["tab:50000"]);
    expect(restored.nodes["tab:50000"]?.status).toBe("live");
    expect(restored.nodes["tab:1"]).toBe(state.nodes["tab:1"]);
    expect(restored.nodes["tab:25000"]).toBe(state.nodes["tab:25000"]);
    expect(restored.nodes["window:10"]).toBe(state.nodes["window:10"]);
  });

  it("deletes closed nodes but keeps promoted live children", () => {
    const state = closeTab(bootstrapFromWindows(windows, { now: 1000 }), 1, {
      now: 2000,
      sessionId: "session-tab-1"
    });

    const deleted = deleteNode(state, "tab:1");

    expect(deleted.nodes["tab:1"]).toBeUndefined();
    expect(deleted.nodes["tab:2"]?.status).toBe("live");
    expect(deleted.nodes["tab:2"]?.parentId).toBe("window:10");
    expect(deleted.nodes["window:10"]?.childIds).toEqual(["tab:2", "tab:3"]);
  });

  it("refuses to delete live nodes", () => {
    const state: OutlineState = bootstrapFromWindows(windows, { now: 1000 });

    expect(() => deleteNode(state, "tab:1")).toThrow(/live node/i);
  });

  it("deletes live subtrees when explicitly allowed", () => {
    const state: OutlineState = bootstrapFromWindows(windows, { now: 1000 });

    const deleted = deleteNode(state, "tab:1", { allowLive: true });

    expect(deleted.nodes["tab:1"]).toBeUndefined();
    expect(deleted.nodes["tab:2"]).toBeUndefined();
    expect(deleted.nodes["window:10"]?.childIds).toEqual(["tab:3"]);
  });

  it("preserves externally owned live tabs when deleting a live subtree", () => {
    const state: OutlineState = {
      version: 1,
      rootIds: ["window:10", "group:1"],
      nodes: {
        "window:10": {
          id: "window:10",
          kind: "window",
          status: "live",
          childIds: ["tab:1"],
          title: "Window 10",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          live: { windowId: 10 }
        },
        "tab:1": {
          id: "tab:1",
          kind: "tab",
          status: "live",
          parentId: "window:10",
          childIds: [],
          title: "Owner tab",
          url: "https://owner.example/",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          live: { tabId: 1, windowId: 10 }
        },
        "group:1": {
          id: "group:1",
          kind: "group",
          status: "neutral",
          childIds: ["window:20"],
          title: "Group",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000
        },
        "window:20": {
          id: "window:20",
          kind: "window",
          status: "live",
          parentId: "group:1",
          childIds: ["tab:2", "tab:3"],
          title: "Window 20",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          live: { windowId: 20 }
        },
        "tab:2": {
          id: "tab:2",
          kind: "tab",
          status: "live",
          parentId: "window:20",
          childIds: ["tab:4"],
          title: "Foreign tab",
          url: "https://foreign.example/",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          live: { tabId: 2, windowId: 10 }
        },
        "tab:3": {
          id: "tab:3",
          kind: "tab",
          status: "live",
          parentId: "window:20",
          childIds: [],
          title: "Deleted tab",
          url: "https://deleted.example/",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          live: { tabId: 3, windowId: 20 }
        },
        "tab:4": {
          id: "tab:4",
          kind: "tab",
          status: "live",
          parentId: "tab:2",
          childIds: [],
          title: "Nested deleted tab",
          url: "https://nested-deleted.example/",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          live: { tabId: 4, windowId: 20 }
        }
      }
    };

    const deleted = deleteNode(state, "group:1", { allowLive: true });

    expect(deleted.rootIds).toEqual(["window:10"]);
    expect(deleted.nodes["group:1"]).toBeUndefined();
    expect(deleted.nodes["window:20"]).toBeUndefined();
    expect(deleted.nodes["tab:3"]).toBeUndefined();
    expect(deleted.nodes["tab:4"]).toBeUndefined();
    expect(deleted.nodes["tab:2"]?.status).toBe("live");
    expect(deleted.nodes["tab:2"]?.parentId).toBe("window:10");
    expect(deleted.nodes["tab:2"]?.childIds).toEqual([]);
    expect(deleted.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:2"]);
  });

  it("preserves unchanged node identities when deleting a single live leaf", () => {
    const state = largeFlatLiveState(50_000);

    const deleted = deleteNode(state, "tab:50000", { allowLive: true });

    expect(deleted.nodes["tab:50000"]).toBeUndefined();
    expect(deleted.nodes["tab:1"]).toBe(state.nodes["tab:1"]);
    expect(deleted.nodes["tab:25000"]).toBe(state.nodes["tab:25000"]);
    expect(deleted.nodes["window:10"]).not.toBe(state.nodes["window:10"]);
    expect(deleted.nodes["window:10"]?.childIds).toHaveLength(49_999);
    expect(state.nodes["window:10"]?.childIds).toHaveLength(50_000);
  });

  it("removes a window when its only child is deleted", () => {
    const state = bootstrapFromWindows([
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://solo.example/",
            title: "Solo"
          }
        ]
      }
    ], { now: 1000 });

    const deleted = deleteNode(state, "tab:1", { allowLive: true });

    expect(deleted.nodes["tab:1"]).toBeUndefined();
    expect(deleted.nodes["window:10"]).toBeUndefined();
    expect(deleted.rootIds).toEqual([]);
  });

  it("removes a window when its only child is moved elsewhere", () => {
    const state = bootstrapFromWindows([
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://solo.example/",
            title: "Solo"
          }
        ]
      },
      {
        id: 20,
        incognito: false,
        focused: false,
        tabs: [
          {
            id: 2,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://target.example/",
            title: "Target"
          }
        ]
      }
    ], { now: 1000 });

    const moved = moveNode(state, "tab:1", { parentId: "window:20", index: 1 });

    expect(moved.nodes["window:10"]).toBeUndefined();
    expect(moved.rootIds).toEqual(["window:20"]);
    expect(moved.nodes["window:20"]?.childIds).toEqual(["tab:2", "tab:1"]);
    expect(moved.nodes["tab:1"]?.parentId).toBe("window:20");
  });

  it("removes a neutral group when its only child is moved elsewhere", () => {
    const state = wrapNodeInGroup(bootstrapFromWindows([
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://one.example/",
            title: "One"
          }
        ]
      },
      {
        id: 20,
        incognito: false,
        focused: false,
        tabs: [
          {
            id: 2,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://two.example/",
            title: "Two"
          }
        ]
      }
    ], { now: 1000 }), "window:10", { now: 3000 });
    const wrapperId = state.nodes["window:10"]?.parentId;

    const moved = moveNode(state, "window:10", { index: 2 });

    expect(wrapperId).toMatch(/^group:/);
    expect(moved.nodes[wrapperId!]).toBeUndefined();
    expect(moved.rootIds).toEqual(["window:20", "window:10"]);
    expect(moved.nodes["window:10"]?.parentId).toBeUndefined();
  });

  it("moves nested group-like subtrees to root after their ultimate ancestor", () => {
    const wrapped = wrapNodeInGroup(bootstrapFromWindows([
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://one.example/",
            title: "One"
          }
        ]
      },
      {
        id: 20,
        incognito: false,
        focused: false,
        tabs: [
          {
            id: 2,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://two.example/",
            title: "Two"
          }
        ]
      }
    ], { now: 1000 }), "window:10", { now: 3000 });
    const wrapperId = wrapped.nodes["window:10"]?.parentId;
    const nested = moveNode(wrapped, "window:20", { parentId: wrapperId, index: 1 });

    const moved = moveSubtreeToTopLevel(nested, "window:10", { now: 4000 });

    expect(wrapperId).toMatch(/^group:/);
    expect(moved.rootIds).toEqual([wrapperId, "window:10"]);
    expect(moved.nodes[wrapperId!]?.childIds).toEqual(["window:20"]);
    expect(moved.nodes["window:10"]?.parentId).toBeUndefined();
    expect(moved.nodes["tab:1"]?.parentId).toBe("window:10");
  });

  it("wraps live tabs before moving them to root after their ultimate ancestor", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });

    const moved = moveSubtreeToTopLevel(state, "tab:1", {
      now: 3000,
      liveWindow: {
        id: 42,
        focused: true,
        incognito: false
      }
    });

    expect(moved.rootIds).toEqual(["window:10", "window:42"]);
    expect(moved.nodes["window:10"]?.childIds).toEqual(["tab:3"]);
    expect(moved.nodes["window:42"]).toMatchObject({
      kind: "window",
      status: "live",
      childIds: ["tab:1"],
      title: "Group",
      live: { windowId: 42 }
    });
    expect(moved.nodes["tab:1"]?.parentId).toBe("window:42");
    expect(moved.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: 42 });
  });

  it("wraps closed tabs before moving them to root after their ultimate ancestor", () => {
    const state = closeTab(bootstrapFromWindows(windows, { now: 1000 }), 1, {
      now: 2000,
      sessionId: "session-tab-1"
    });

    const moved = moveSubtreeToTopLevel(state, "tab:1", { now: 3000 });
    const placeholderId = "window:placeholder:3000";

    expect(moved.rootIds).toEqual(["window:10", placeholderId]);
    expect(moved.nodes["window:10"]?.childIds).toEqual(["tab:2", "tab:3"]);
    expect(moved.nodes[placeholderId]).toMatchObject({
      kind: "window",
      status: "closed",
      childIds: ["tab:1"],
      title: "Group"
    });
    expect(moved.nodes["tab:1"]?.parentId).toBe(placeholderId);
  });

  it("does not move root rows to top level", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });

    const moved = moveSubtreeToTopLevel(state, "window:10", { now: 3000 });

    expect(moved).toBe(state);
  });

  it("removes emptied ancestors when moving a wrapped tab to top level", () => {
    const state = bootstrapFromWindows([
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://solo.example/",
            title: "Solo"
          }
        ]
      }
    ], { now: 1000 });

    const moved = moveSubtreeToTopLevel(state, "tab:1", {
      now: 3000,
      liveWindow: {
        id: 42,
        focused: true,
        incognito: false
      }
    });

    expect(moved.nodes["window:10"]).toBeUndefined();
    expect(moved.rootIds).toEqual(["window:42"]);
    expect(moved.nodes["window:42"]?.childIds).toEqual(["tab:1"]);
    expect(moved.nodes["tab:1"]?.parentId).toBe("window:42");
  });

  it("wraps live tabs before moving them to the bottom top level", () => {
    const state = bootstrapFromWindows([
      ...windows,
      {
        id: 20,
        incognito: false,
        focused: false,
        tabs: [
          {
            id: 20,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://last.example/",
            title: "Last"
          }
        ]
      }
    ], { now: 1000 });

    const moved = moveSubtreeToBottomTopLevel(state, "tab:1", {
      now: 3000,
      liveWindow: {
        id: 42,
        focused: true,
        incognito: false
      }
    });

    expect(moved.rootIds).toEqual(["window:10", "window:20", "window:42"]);
    expect(moved.nodes["window:10"]?.childIds).toEqual(["tab:3"]);
    expect(moved.nodes["window:42"]?.childIds).toEqual(["tab:1"]);
    expect(moved.nodes["tab:1"]?.childIds).toEqual(["tab:2"]);
    expect(moved.nodes["tab:1"]?.parentId).toBe("window:42");
    expect(moved.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: 42 });
  });

  it("moves nested group-like subtrees to the bottom top level", () => {
    const wrapped = wrapNodeInGroup(bootstrapFromWindows([
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://one.example/",
            title: "One"
          }
        ]
      },
      {
        id: 20,
        incognito: false,
        focused: false,
        tabs: [
          {
            id: 2,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://two.example/",
            title: "Two"
          }
        ]
      },
      {
        id: 30,
        incognito: false,
        focused: false,
        tabs: [
          {
            id: 3,
            windowId: 30,
            index: 0,
            active: true,
            url: "https://three.example/",
            title: "Three"
          }
        ]
      }
    ], { now: 1000 }), "window:10", { now: 3000 });
    const wrapperId = wrapped.nodes["window:10"]?.parentId;
    const nested = moveNode(wrapped, "window:20", { parentId: wrapperId, index: 1 });

    const moved = moveSubtreeToBottomTopLevel(nested, "window:10", { now: 4000 });

    expect(moved.rootIds).toEqual([wrapperId, "window:30", "window:10"]);
    expect(moved.nodes[wrapperId!]?.childIds).toEqual(["window:20"]);
    expect(moved.nodes["window:10"]?.parentId).toBeUndefined();
    expect(moved.nodes["tab:1"]?.parentId).toBe("window:10");
  });

  it("moves root group-like rows to the bottom top level", () => {
    const state = bootstrapFromWindows([
      ...windows,
      {
        id: 20,
        incognito: false,
        focused: false,
        tabs: [
          {
            id: 20,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://last.example/",
            title: "Last"
          }
        ]
      }
    ], { now: 1000 });

    const moved = moveSubtreeToBottomTopLevel(state, "window:10", { now: 3000 });

    expect(moved.rootIds).toEqual(["window:20", "window:10"]);
    expect(moved.nodes["window:10"]?.parentId).toBeUndefined();
    expect(moved.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:3"]);
  });

  it("does not move missing or already-bottom root rows to bottom top level", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });

    expect(moveSubtreeToBottomTopLevel(state, "window:10", { now: 3000 })).toBe(state);
    expect(moveSubtreeToBottomTopLevel(state, "missing", { now: 3000 })).toBe(state);
  });

  it("repairs cyclic and duplicate child links in stored state", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });
    state.nodes["tab:1"]!.childIds = ["tab:2", "tab:2", "tab:1", "missing"];
    state.nodes["tab:2"]!.childIds = ["tab:1"];
    state.rootIds = ["window:10", "window:10", "missing-root"];

    const repaired = repairState(state);

    expect(repaired.rootIds).toEqual(["window:10"]);
    expect(repaired.nodes["tab:1"]?.childIds).toEqual(["tab:2"]);
    expect(repaired.nodes["tab:2"]?.childIds).toEqual([]);
  });

  it("repairs legacy stored group titles to the generic label", () => {
    const state = closeWindow(bootstrapFromWindows(windows, { now: 1000 }), 10, {
      now: 2000,
      sessionId: "session-window-10"
    });
    state.nodes["window:10"]!.title = "Window 10";

    const repaired = repairState(state);

    expect(repaired.nodes["window:10"]?.title).toBe("Group");
  });

  it("preserves custom group titles during repair", () => {
    const state = renameGroup(bootstrapFromWindows(windows, { now: 1000 }), "window:10", "Research", {
      now: 2000
    });

    const repaired = repairState(state);

    expect(repaired.nodes["window:10"]?.title).toBe("Research");
    expect(repaired.nodes["window:10"]?.customTitle).toBe("Research");
  });

  it("repairs closed tab children in live windows by promoting them", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });
    state.nodes["tab:1"] = {
      ...state.nodes["tab:1"]!,
      status: "closed",
      closedAt: 2000,
      restore: {
        url: "https://example.com/",
        title: "Example"
      }
    };
    delete state.nodes["tab:1"]!.live;
    delete state.nodes["tab:1"]!.active;

    const repaired = repairState(state);

    expect(repaired.nodes["tab:1"]?.childIds).toEqual([]);
    expect(repaired.nodes["tab:2"]?.parentId).toBe("window:10");
    expect(repaired.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:2", "tab:3"]);
  });

  it("keeps closed window tab subtrees intact during repair", () => {
    const state = closeWindow(bootstrapFromWindows(windows, { now: 1000 }), 10, {
      now: 2000,
      sessionId: "session-window-10"
    });

    const repaired = repairState(state);

    expect(repaired.nodes["window:10"]?.status).toBe("closed");
    expect(repaired.nodes["tab:1"]?.status).toBe("closed");
    expect(repaired.nodes["tab:1"]?.childIds).toEqual(["tab:2"]);
    expect(repaired.nodes["tab:2"]?.parentId).toBe("tab:1");
  });

  it("repairs stored state by pruning empty windows", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });
    state.nodes["window:empty-parent"] = {
      id: "window:empty-parent",
      kind: "window",
      status: "closed",
      childIds: ["window:empty-child"],
      title: "Window",
      collapsed: false,
      createdAt: 1000,
      updatedAt: 1000,
      closedAt: 1000
    };
    state.nodes["window:empty-child"] = {
      id: "window:empty-child",
      kind: "window",
      status: "closed",
      parentId: "window:empty-parent",
      childIds: [],
      title: "Window",
      collapsed: false,
      createdAt: 1000,
      updatedAt: 1000,
      closedAt: 1000
    };
    state.rootIds.push("window:empty-parent");

    const repaired = repairState(state);

    expect(repaired.nodes["window:empty-child"]).toBeUndefined();
    expect(repaired.nodes["window:empty-parent"]).toBeUndefined();
    expect(repaired.rootIds).toEqual(["window:10"]);
  });

  it("reconciles stored closed nodes with currently open browser state", () => {
    const stored = closeTab(bootstrapFromWindows(windows, { now: 1000 }), 2, {
      now: 2000,
      sessionId: "session-tab-2"
    });
    stored.nodes["window:10"]!.title = "Current window";

    const reconciled = reconcileWithWindows(stored, [
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://example.com/",
            title: "Example updated"
          },
          {
            id: 5,
            windowId: 10,
            index: 1,
            active: false,
            openerTabId: 1,
            url: "https://new.example/",
            title: "New child"
          }
        ]
      }
    ], { now: 4000 });

    expect(reconciled.nodes["tab:2"]?.status).toBe("closed");
    expect(reconciled.nodes["window:10"]?.title).toBe("Group");
    expect(reconciled.nodes["window:10"]?.active).toBe(true);
    expect(reconciled.nodes["tab:1"]?.title).toBe("Example updated");
    expect(reconciled.nodes["tab:1"]?.childIds).toEqual(["tab:2", "tab:5"]);
    expect(reconciled.nodes["tab:5"]?.parentId).toBe("tab:1");
    expectPreviouslyClosedNodesPreserved(stored, reconciled);
  });

  it("does not delete empty closed containers during runtime reconciliation", () => {
    const stored = bootstrapFromWindows(windows, { now: 1000 });
    stored.nodes["window:closed-empty"] = {
      id: "window:closed-empty",
      kind: "window",
      status: "closed",
      childIds: [],
      title: "Saved Empty",
      collapsed: false,
      createdAt: 1000,
      updatedAt: 2000,
      closedAt: 2000
    };
    stored.rootIds.push("window:closed-empty");

    const reconciled = reconcileWithWindows(stored, [
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://example.com/",
            title: "Example"
          }
        ]
      }
    ], { now: 4000 });

    expect(reconciled.nodes["window:closed-empty"]).toMatchObject({
      kind: "window",
      status: "closed",
      childIds: []
    });
    expect(reconciled.rootIds).toContain("window:closed-empty");
    expectPreviouslyClosedNodesPreserved(stored, reconciled);
  });

  it("preserves custom group titles during reconciliation", () => {
    const stored = renameGroup(bootstrapFromWindows(windows, { now: 1000 }), "window:10", "Research", {
      now: 2000
    });

    const reconciled = reconcileWithWindows(stored, [
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://example.com/",
            title: "Example updated"
          }
        ]
      }
    ], { now: 4000 });

    expect(reconciled.nodes["window:10"]?.title).toBe("Research");
    expect(reconciled.nodes["window:10"]?.customTitle).toBe("Research");
  });

  it("deletes missing live tabs in open windows during full reconciliation", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });

    const reconciled = reconcileWithWindows(state, [
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 2,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://example.com/child",
            title: "Child"
          },
          {
            id: 3,
            windowId: 10,
            index: 1,
            active: false,
            url: "about:blank",
            title: "Blank"
          }
        ]
      }
    ], { now: 4000 });

    expect(reconciled.nodes["tab:1"]).toBeUndefined();
    expect(reconciled.nodes["tab:2"]?.status).toBe("live");
    expect(reconciled.nodes["tab:2"]?.parentId).toBe("window:10");
    expect(reconciled.nodes["window:10"]?.childIds).toEqual(["tab:2", "tab:3"]);
  });

  it("reconciles a 50k-node live window with a small runtime deletion", () => {
    const state = largeFlatLiveState(50_000);
    const tabs = Array.from({ length: 49_999 }, (_, index) => {
      const tabId = index + 2;
      return {
        id: tabId,
        windowId: 10,
        index,
        active: tabId === 2,
        url: `https://large.example/${tabId}`,
        title: `Tab ${tabId}`
      };
    });

    const reconciled = reconcileWithWindows(state, [
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs
      }
    ], { now: 4000 });

    expect(reconciled.nodes["tab:1"]).toBeUndefined();
    expect(reconciled.nodes["window:10"]?.childIds).toHaveLength(49_999);
    expect(reconciled.nodes["window:10"]?.childIds[0]).toBe("tab:2");
    expect(reconciled.nodes["tab:2"]?.active).toBe(true);
  }, 15_000);

  it("does not close absent live tabs during partial event reconciliation", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });

    const reconciled = reconcileWithWindows(state, [
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 5,
            windowId: 10,
            index: 3,
            active: true,
            url: "about:newtab",
            title: "New Tab"
          }
        ]
      }
    ], { now: 2000 }, { closeMissing: false });

    expect(reconciled.nodes["tab:1"]?.status).toBe("live");
    expect(reconciled.nodes["tab:2"]?.status).toBe("live");
    expect(reconciled.nodes["tab:3"]?.status).toBe("live");
    expect(reconciled.nodes["tab:5"]?.status).toBe("live");
  });

  it("preserves outline nesting while ordering live-tab preorder from runtime indices", () => {
    const state = moveNode(bootstrapFromWindows(windows, { now: 1000 }), "tab:3", {
      parentId: "tab:1",
      index: 0
    });

    const reconciled = reconcileWithWindows(state, windows, { now: 2000 }, { respectRuntimeTabOrder: true });

    expect(reconciled.nodes["tab:1"]?.childIds).toEqual(["tab:2", "tab:3"]);
    expect(reconciled.nodes["tab:3"]?.parentId).toBe("tab:1");
    expect(reconciled.nodes["window:10"]?.childIds).toEqual(["tab:1"]);
    expect(projectLiveTabs(reconciled, "window:10").map((tab) => tab.tabId)).toEqual([1, 2, 3]);
  });

  it("orders live-tab preorder in an order-page-heavy tree without repeated subtree scans", () => {
    const state = makeSidebarStartupState({
      shape: "order-page-heavy",
      tabs: 19_433,
      liveTabs: 50
    });
    const tabs = Array.from({ length: 51 }, (_, index) => {
      const tabId = index < 50 ? index + 1 : 19_434;
      return {
        id: tabId,
        windowId: 10,
        index,
        active: index === 50,
        url: index < 50 ? `https://large.example/${tabId}` : "https://startup.example/",
        title: index < 50 ? `Tab ${tabId}` : "Startup Tab"
      };
    });

    const start = performance.now();
    const reconciled = reconcileWithWindows(state, [
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs
      }
    ], { now: 2000 }, {
      closeMissing: false,
      respectRuntimeTabOrder: true
    });
    const durationMs = performance.now() - start;

    expect(durationMs).toBeLessThan(1500);
    expect(reconciled.nodes["tab:19434"]?.parentId).toBe("window:10");
    expect(reconciled.nodes["tab:19434"]?.active).toBe(true);
    expect(projectLiveTabs(reconciled, "window:10").map((tab) => tab.tabId).at(-1)).toBe(19_434);
  }, 25_000);

  it("keeps existing parent links during partial event reconciliation", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });

    const reconciled = reconcileWithWindows(state, [
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 2,
            windowId: 10,
            index: 1,
            active: true,
            openerTabId: 1,
            url: "https://example.com/child",
            title: "Child"
          }
        ]
      }
    ], { now: 2000 }, { closeMissing: false });

    expect(reconciled.nodes["tab:1"]?.childIds).toEqual(["tab:2"]);
    expect(reconciled.nodes["tab:2"]?.parentId).toBe("tab:1");
    expect(reconciled.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:3"]);
  });

  it("repairs nodes whose parent link exists but whose parent omits them", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });
    state.nodes["tab:1"]!.childIds = [];
    state.nodes["tab:2"]!.parentId = "tab:1";

    const repaired = repairState(state);

    expect(repaired.nodes["tab:1"]?.childIds).toEqual(["tab:2"]);
    expect(repaired.nodes["tab:2"]?.parentId).toBe("tab:1");
  });

  it("repairs root live tabs by reattaching them to their owning window", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });
    state.nodes["window:10"]!.childIds = ["tab:1"];
    delete state.nodes["tab:3"]!.parentId;
    state.rootIds = ["window:10", "tab:3"];

    const repaired = repairState(state);

    expect(repaired.rootIds).toEqual(["window:10"]);
    expect(repaired.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:3"]);
    expect(repaired.nodes["tab:3"]?.parentId).toBe("window:10");
  });

  it("reattaches orphaned live tabs during partial event reconciliation", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });
    state.nodes["window:10"]!.childIds = ["tab:1"];
    delete state.nodes["tab:3"]!.parentId;
    state.rootIds = ["window:10", "tab:3"];

    const reconciled = reconcileWithWindows(state, [
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 5,
            windowId: 10,
            index: 3,
            active: true,
            url: "https://new.example/",
            title: "New"
          }
        ]
      }
    ], { now: 2000 }, { closeMissing: false });

    expect(reconciled.rootIds).toEqual(["window:10"]);
    expect(reconciled.nodes["tab:3"]?.parentId).toBe("window:10");
    expect(reconciled.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:5", "tab:3"]);
    expect(reconciled.nodes["tab:5"]?.status).toBe("live");
  });

  it("does not reuse a closed window node when a new runtime window has the same id", () => {
    const closed = closeWindow(
      bootstrapFromWindows([
        {
          id: 10,
          incognito: false,
          focused: true,
          tabs: [
            {
              id: 1,
              windowId: 10,
              index: 0,
              active: true,
              url: "https://saved.example/",
              title: "Saved"
            }
          ]
        }
      ], { now: 1000 }),
      10,
      { now: 1500 }
    );

    const reconciled = reconcileWithWindows(
      closed,
      [
        {
          id: 10,
          incognito: false,
          focused: true,
          tabs: [
            {
              id: 1,
              windowId: 10,
              index: 0,
              active: true,
              url: "https://current.example/",
              title: "Current"
            }
          ]
        }
      ],
      { now: 2000 }
    );

    expect(reconciled.nodes["window:10"]?.status).toBe("closed");
    expect(reconciled.nodes["tab:1"]?.status).toBe("closed");
    expect(reconciled.nodes["window:10:2000"]).toMatchObject({
      kind: "window",
      status: "live",
      live: { windowId: 10 },
      childIds: ["tab:1:2000"]
    });
    expect(reconciled.nodes["tab:1:2000"]).toMatchObject({
      kind: "tab",
      status: "live",
      live: { tabId: 1, windowId: 10 }
    });
  });

  it("does not reattach tabs from a closed window whose root was temporarily omitted", () => {
    const closed = closeWindow(
      bootstrapFromWindows([
        {
          id: 10,
          incognito: false,
          focused: true,
          tabs: [
            {
              id: 1,
              windowId: 10,
              index: 0,
              active: true,
              url: "https://saved.example/",
              title: "Saved"
            }
          ]
        }
      ], { now: 1000 }),
      10,
      { now: 1500 }
    );
    closed.rootIds = [];

    const reconciled = reconcileWithWindows(
      closed,
      [
        {
          id: 20,
          incognito: false,
          focused: true,
          tabs: [
            {
              id: 5,
              windowId: 20,
              index: 0,
              active: true,
              url: "https://saved.example/",
              title: "Current"
            }
          ]
        }
      ],
      { now: 2000 }
    );

    expect(reconciled.rootIds).toEqual(["window:20", "window:10"]);
    expect(reconciled.nodes["window:10"]).toMatchObject({
      kind: "window",
      status: "closed",
      childIds: ["tab:1"]
    });
    expect(reconciled.nodes["tab:1"]).toMatchObject({
      kind: "tab",
      status: "closed",
      parentId: "window:10",
      restore: {
        url: "https://saved.example/",
        title: "Saved"
      }
    });
    expect(reconciled.nodes["tab:5"]).toMatchObject({
      kind: "tab",
      status: "live",
      parentId: "window:20",
      live: { tabId: 5, windowId: 20 }
    });
  });

  it("repairs orphaned parent cycles into reachable roots", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });
    state.rootIds = ["window:10"];
    state.nodes["window:10"]!.childIds = ["tab:3"];
    state.nodes["tab:1"]!.parentId = "tab:2";
    state.nodes["tab:1"]!.childIds = ["tab:2"];
    state.nodes["tab:2"]!.parentId = "tab:1";
    state.nodes["tab:2"]!.childIds = ["tab:1"];

    const repaired = repairState(state);

    expect(reachableNodeIds(repaired)).toEqual(Object.keys(repaired.nodes).sort());
  });

  it("reattaches a natively restored closed tab in place", () => {
    const stored = closeTab(bootstrapFromWindows(windows, { now: 1000 }), 2, {
      now: 2000,
      sessionId: "session-tab-2"
    });

    const reconciled = reconcileWithWindows(stored, [
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://example.com/",
            title: "Example"
          },
          {
            id: 22,
            windowId: 10,
            index: 1,
            active: false,
            url: "https://example.com/child",
            title: "Child"
          }
        ]
      }
    ], { now: 5000 });

    expect(reconciled.nodes["tab:2"]?.status).toBe("live");
    expect(reconciled.nodes["tab:2"]?.live).toEqual({ tabId: 22, windowId: 10 });
    expect(reconciled.nodes["tab:2"]?.restoredFromClosed).toBe(true);
    expect(reconciled.nodes["tab:2"]?.parentId).toBe("tab:1");
    expect(reconciled.nodes["tab:22"]).toBeUndefined();
    expect(reconciled.nodes["tab:1"]?.childIds).toEqual(["tab:2"]);
  });

  it("does not reattach excluded closed blank restore candidates", () => {
    const closed = closeWindow(bootstrapFromWindows(windows, { now: 1000 }), 10, {
      now: 2000,
      sessionId: "session-window-10"
    });
    const restored = restoreNodes(closed, [
      {
        nodeId: "window:10",
        windowId: 20,
        active: true
      },
      {
        nodeId: "tab:1",
        tabId: 11,
        windowId: 20,
        active: false,
        url: "https://example.com/",
        title: "Example"
      }
    ]);

    const reconciled = reconcileWithWindows(restored, [
      {
        id: 20,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 11,
            windowId: 20,
            index: 0,
            active: false,
            url: "https://example.com/",
            title: "Example"
          },
          {
            id: 22,
            windowId: 20,
            index: 1,
            active: true,
            url: "about:newtab",
            title: "New Tab"
          }
        ]
      }
    ], { now: 5000 }, { excludedClosedRestoreNodeIds: new Set(["tab:3"]) });

    expect(reconciled.nodes["tab:3"]?.status).toBe("closed");
    expect(reconciled.nodes["tab:22"]).toMatchObject({
      kind: "tab",
      status: "live",
      parentId: "window:10",
      live: { tabId: 22, windowId: 20 }
    });
  });

  it("replaces a native restore about:blank placeholder when the real url arrives", () => {
    const stored = closeTab(bootstrapFromWindows(windows, { now: 1000 }), 2, {
      now: 2000,
      sessionId: "session-tab-2"
    });
    const withPlaceholder = reconcileWithWindows(stored, [
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://example.com/",
            title: "Example"
          },
          {
            id: 22,
            windowId: 10,
            index: 1,
            active: false,
            url: "about:blank",
            title: "New Tab"
          }
        ]
      }
    ], { now: 5000 });

    expect(withPlaceholder.nodes["tab:22"]?.status).toBe("live");
    expect(withPlaceholder.nodes["tab:2"]?.status).toBe("closed");

    const reconciled = reconcileWithWindows(withPlaceholder, [
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://example.com/",
            title: "Example"
          },
          {
            id: 22,
            windowId: 10,
            index: 1,
            active: false,
            url: "https://example.com/child",
            title: "Child"
          }
        ]
      }
    ], { now: 6000 });

    expect(reconciled.nodes["tab:2"]?.status).toBe("live");
    expect(reconciled.nodes["tab:2"]?.live).toEqual({ tabId: 22, windowId: 10 });
    expect(reconciled.nodes["tab:22"]).toBeUndefined();
    expect(reconciled.nodes["tab:1"]?.childIds).toEqual(["tab:2"]);
  });

  it("reconciles cross-window opener tabs back into their owning window", () => {
    const stored = bootstrapFromWindows([
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://source.example/",
            title: "Source"
          },
          {
            id: 5,
            windowId: 20,
            index: 0,
            active: true,
            openerTabId: 1,
            url: "https://target.example/",
            title: "Target"
          }
        ]
      }
    ], { now: 1000 });

    const reconciled = reconcileWithWindows(stored, [
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs: [
          {
            id: 1,
            windowId: 10,
            index: 0,
            active: true,
            url: "https://source.example/",
            title: "Source"
          }
        ]
      },
      {
        id: 20,
        incognito: false,
        focused: false,
        tabs: [
          {
            id: 5,
            windowId: 20,
            index: 0,
            active: true,
            openerTabId: 1,
            url: "https://target.example/",
            title: "Target"
          }
        ]
      }
    ], { now: 2000 });

    expect(reconciled.nodes["window:20"]?.childIds).toEqual(["tab:5"]);
    expect(reconciled.nodes["tab:1"]?.childIds).toEqual([]);
    expect(reconciled.nodes["tab:5"]?.parentId).toBe("window:20");
  });

  it("preserves model invariants and previous states across generated structural traces", () => {
    const config = generatedTraceConfig({
      defaultSeedCount: 24,
      defaultSteps: 18,
      soakSeedCount: 96,
      soakSteps: 48
    });
    for (const seed of config.seeds) {
      runGeneratedModelTrace(seed, config.steps);
    }
  }, generatedTraceTimeoutMs(10_000, 120_000));
});

function runGeneratedModelTrace(seed: number, steps: number): void {
  let state = generatedModelState(seed);
  let now = seed * 1000;
  const rng = seededRandom(seed);
  const history = [`seed ${seed}`];
  expectValidGeneratedModelState(state, history);

  for (let step = 0; step < steps; step += 1) {
    const before = cloneGeneratedModelState(state);
    const operation = generatedModelOperation(state, rng, now);
    if (!operation) {
      break;
    }
    now += 1;
    history.push(`step ${step + 1}: ${operation.name}`);

    expect(state, history.join("\n")).toEqual(before);
    expectValidGeneratedModelState(operation.next, history);
    state = operation.next;
  }
}

type GeneratedModelOperation = {
  name: string;
  next: OutlineState;
};

function generatedModelOperation(
  state: OutlineState,
  rng: () => number,
  now: number
): GeneratedModelOperation | undefined {
  const operationOrder = [0, 1, 2, 3, 4, 5]
    .map((operation) => ({ operation, sort: rng() }))
    .sort((left, right) => left.sort - right.sort)
    .map((entry) => entry.operation);

  for (const operation of operationOrder) {
    const result =
      operation === 0 ? generatedModelMove(state, rng, now) :
      operation === 1 ? generatedModelWrap(state, rng, now) :
      operation === 2 ? generatedModelFlatten(state, rng) :
      operation === 3 ? generatedModelPromote(state, rng) :
      operation === 4 ? generatedModelRename(state, rng, now) :
      generatedModelDelete(state, rng);
    if (result && result.next !== state) {
      return result;
    }
  }
  return undefined;
}

function generatedModelMove(state: OutlineState, rng: () => number, now: number): GeneratedModelOperation | undefined {
  const nodeId = pickOne(rng, generatedMovableNodeIds(state));
  if (!nodeId) {
    return undefined;
  }
  const parentId = pickOne(rng, generatedValidMoveParentIds(state, nodeId));
  const siblingCount = parentId ? state.nodes[parentId]?.childIds.length ?? 0 : state.rootIds.length;
  return {
    name: `move ${nodeId} under ${parentId ?? "root"}`,
    next: moveNode(state, nodeId, {
      ...(parentId ? { parentId } : {}),
      index: Math.floor(rng() * (siblingCount + 1)),
      now
    })
  };
}

function generatedModelWrap(state: OutlineState, rng: () => number, now: number): GeneratedModelOperation | undefined {
  const nodeId = pickOne(rng, generatedMovableNodeIds(state));
  return nodeId
    ? { name: `wrap ${nodeId}`, next: wrapNodeInGroup(state, nodeId, { now }) }
    : undefined;
}

function generatedModelFlatten(state: OutlineState, rng: () => number): GeneratedModelOperation | undefined {
  const nodeId = pickOne(
    rng,
    Object.values(state.nodes)
      .filter((node) => node.childIds.some((childId) => (state.nodes[childId]?.childIds.length ?? 0) > 0))
      .map((node) => node.id)
  );
  return nodeId
    ? { name: `flatten ${nodeId}`, next: flattenSubtreeOneLevel(state, nodeId) }
    : undefined;
}

function generatedModelPromote(state: OutlineState, rng: () => number): GeneratedModelOperation | undefined {
  const nodeId = pickOne(
    rng,
    Object.values(state.nodes)
      .filter((node) => node.parentId && node.childIds.length > 0 && !(node.kind === "window" && node.status === "live"))
      .map((node) => node.id)
  );
  return nodeId
    ? { name: `promote ${nodeId}`, next: promoteChildrenOneLevel(state, nodeId) }
    : undefined;
}

function generatedModelRename(state: OutlineState, rng: () => number, now: number): GeneratedModelOperation | undefined {
  const nodeId = pickOne(
    rng,
    Object.values(state.nodes)
      .filter((node) => node.kind === "window" || node.kind === "group")
      .map((node) => node.id)
  );
  return nodeId
    ? { name: `rename ${nodeId}`, next: renameGroup(state, nodeId, `Generated ${now}`, { now }) }
    : undefined;
}

function generatedModelDelete(state: OutlineState, rng: () => number): GeneratedModelOperation | undefined {
  const nodeId = pickOne(rng, generatedMovableNodeIds(state));
  return nodeId
    ? { name: `delete ${nodeId}`, next: deleteNode(state, nodeId) }
    : undefined;
}

function generatedModelState(seed: number): OutlineState {
  const now = seed * 1000;
  return {
    version: 1,
    rootIds: ["window:generated"],
    nodes: {
      "window:generated": generatedClosedWindow("window:generated", ["tab:a", "tab:b", "group:g"], now),
      "tab:a": generatedClosedTab("tab:a", "window:generated", ["tab:a1", "tab:a2"], now),
      "tab:a1": generatedClosedTab("tab:a1", "tab:a", [], now),
      "tab:a2": generatedClosedTab("tab:a2", "tab:a", ["tab:a2i"], now),
      "tab:a2i": generatedClosedTab("tab:a2i", "tab:a2", [], now),
      "tab:b": generatedClosedTab("tab:b", "window:generated", ["tab:b1"], now),
      "tab:b1": generatedClosedTab("tab:b1", "tab:b", [], now),
      "group:g": generatedNeutralGroup("group:g", "window:generated", ["tab:g1"]),
      "tab:g1": generatedClosedTab("tab:g1", "group:g", [`tab:seed:${seed}`], now),
      [`tab:seed:${seed}`]: generatedClosedTab(`tab:seed:${seed}`, "tab:g1", [], now)
    }
  };
}

function generatedClosedWindow(id: NodeId, childIds: NodeId[], now: number, parentId?: NodeId): OutlineNode {
  return {
    id,
    kind: "window",
    status: "closed",
    ...(parentId ? { parentId } : {}),
    childIds,
    title: "Group",
    collapsed: false,
    createdAt: now,
    updatedAt: now,
    closedAt: now
  };
}

function generatedClosedTab(id: NodeId, parentId: NodeId, childIds: NodeId[], now: number): OutlineNode {
  return {
    id,
    kind: "tab",
    status: "closed",
    parentId,
    childIds,
    title: id,
    url: `https://model.example/${id}`,
    collapsed: false,
    createdAt: now,
    updatedAt: now,
    closedAt: now,
    restore: {
      url: `https://model.example/${id}`,
      title: id
    }
  };
}

function generatedNeutralGroup(id: NodeId, parentId: NodeId, childIds: NodeId[]): OutlineNode {
  return {
    id,
    kind: "group",
    status: "neutral",
    parentId,
    childIds,
    title: "Group",
    collapsed: false,
    createdAt: 1,
    updatedAt: 1
  };
}

function generatedMovableNodeIds(state: OutlineState): NodeId[] {
  return Object.values(state.nodes)
    .filter((node) => Boolean(node.parentId))
    .map((node) => node.id);
}

function generatedValidMoveParentIds(state: OutlineState, nodeId: NodeId): NodeId[] {
  return Object.values(state.nodes)
    .filter((node) => node.id !== nodeId && !generatedIsDescendant(state, node.id, nodeId))
    .map((node) => node.id);
}

function generatedIsDescendant(state: OutlineState, candidateId: NodeId, ancestorId: NodeId): boolean {
  let current = state.nodes[candidateId];
  const visited = new Set<NodeId>();
  while (current?.parentId && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.parentId === ancestorId) {
      return true;
    }
    current = state.nodes[current.parentId];
  }
  return false;
}

function expectValidGeneratedModelState(state: OutlineState, history: string[]): void {
  expect(new Set(state.rootIds).size, history.join("\n")).toBe(state.rootIds.length);
  expect(reachableNodeIds(state), history.join("\n")).toEqual(Object.keys(state.nodes).sort());
  for (const rootId of state.rootIds) {
    expect(state.nodes[rootId], history.join("\n")).toBeDefined();
    expect(state.nodes[rootId]?.parentId, history.join("\n")).toBeUndefined();
  }
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    expect(new Set(node.childIds).size, history.join("\n")).toBe(node.childIds.length);
    for (const childId of node.childIds) {
      expect(state.nodes[childId], history.join("\n")).toBeDefined();
      expect(state.nodes[childId]?.parentId, history.join("\n")).toBe(nodeId);
    }
  }
}

function cloneGeneratedModelState(state: OutlineState): OutlineState {
  return {
    version: state.version,
    rootIds: [...state.rootIds],
    nodes: Object.fromEntries(
      Object.entries(state.nodes).map(([nodeId, node]) => [
        nodeId,
        {
          ...node,
          childIds: [...node.childIds],
          ...(node.live ? { live: { ...node.live } } : {}),
          ...(node.restore ? { restore: { ...node.restore } } : {})
        }
      ])
    )
  };
}

function pickOne<T>(rng: () => number, values: readonly T[]): T | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values[Math.floor(rng() * values.length) % values.length];
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function windowWithTabs(windowId: number, tabCount: number): RuntimeWindow {
  return {
    id: windowId,
    incognito: false,
    focused: true,
    tabs: Array.from({ length: tabCount }, (_value, index) => ({
      id: index + 1,
      windowId,
      index,
      active: index === 0,
      url: `https://example.com/${index + 1}`,
      title: `Tab ${index + 1}`
    }))
  };
}
