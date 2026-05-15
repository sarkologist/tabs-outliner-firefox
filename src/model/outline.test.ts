import { describe, expect, it } from "vitest";

import {
  bootstrapFromWindows,
  closeTab,
  closeWindow,
  deleteLiveTabNodeByTabId,
  deleteNode,
  moveNode,
  moveTabToNewClosedWindow,
  moveTabToNewLiveWindow,
  planRestore,
  projectLiveTabs,
  reconcileWithWindows,
  repairState,
  restoreNodes
} from "./outline.js";
import type { OutlineState, RuntimeWindow } from "./types.js";

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

describe("outline model", () => {
  it("bootstraps normal windows and places opener tabs as children", () => {
    const state = bootstrapFromWindows(windows, { now: 1000 });

    expect(state.rootIds).toEqual(["window:10"]);
    expect(state.nodes["window:10"]?.title).toBe("Window");
    expect(state.nodes["window:10"]?.active).toBe(true);
    expect(state.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:3"]);
    expect(state.nodes["tab:1"]?.childIds).toEqual(["tab:2"]);
    expect(state.nodes["tab:2"]?.parentId).toBe("tab:1");
    expect(state.nodes["tab:4"]).toBeUndefined();
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
    expect(moved.nodes["window:42"]?.title).toBe("Window");
    expect(moved.nodes["window:10"]?.title).toBe("Window");
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
      title: "Window",
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
        url: "https://example.com/child",
        title: "Child"
      }
    ]);

    expect(restored.nodes["tab:2"]?.status).toBe("live");
    expect(restored.nodes["tab:2"]?.live).toEqual({ tabId: 22, windowId: 10 });
    expect(Object.keys(restored.nodes).filter((id) => id === "tab:2")).toHaveLength(1);
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

  it("repairs stored window titles to the generic label", () => {
    const state = closeWindow(bootstrapFromWindows(windows, { now: 1000 }), 10, {
      now: 2000,
      sessionId: "session-window-10"
    });
    state.nodes["window:10"]!.title = "Window 10";

    const repaired = repairState(state);

    expect(repaired.nodes["window:10"]?.title).toBe("Window");
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
    expect(reconciled.nodes["window:10"]?.title).toBe("Window");
    expect(reconciled.nodes["window:10"]?.active).toBe(true);
    expect(reconciled.nodes["tab:1"]?.title).toBe("Example updated");
    expect(reconciled.nodes["tab:1"]?.childIds).toEqual(["tab:2", "tab:5"]);
    expect(reconciled.nodes["tab:5"]?.parentId).toBe("tab:1");
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
});
