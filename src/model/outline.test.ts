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
        fallbackUrl: "https://example.com/",
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
        fallbackUrl: "https://example.com/",
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
      },
      {
        nodeId: "tab:5",
        kind: "url",
        url: "about:debugging#/runtime/this-firefox",
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
        fallbackUrl: "https://example.com/child",
        windowNodeId: "window:10"
      }
    ]);
  });

  it("keeps the closed window destination when planning url restores", () => {
    const state = closeWindow(bootstrapFromWindows(windows, { now: 1000 }), 10, {
      now: 2000,
      sessionId: "session-window-10"
    });

    expect(planRestore(state, "tab:2")).toEqual([
      {
        nodeId: "tab:2",
        kind: "url",
        url: "https://example.com/child",
        windowNodeId: "window:10"
      }
    ]);
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

  it("keeps existing outline placement authoritative during reconciliation", () => {
    const state = moveNode(bootstrapFromWindows(windows, { now: 1000 }), "tab:3", {
      parentId: "tab:1",
      index: 0
    });

    const reconciled = reconcileWithWindows(state, windows, { now: 2000 });

    expect(reconciled.nodes["tab:1"]?.childIds).toEqual(["tab:3", "tab:2"]);
    expect(reconciled.nodes["tab:3"]?.parentId).toBe("tab:1");
    expect(reconciled.nodes["window:10"]?.childIds).toEqual(["tab:1"]);
  });

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
