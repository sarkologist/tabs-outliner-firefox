import { describe, expect, it } from "vitest";

import {
  HISTORY_LIMIT,
  applyOutlineDelta,
  createEmptyHistoryState,
  createHistoryEntry,
  historyStatus,
  pushUndoEntry
} from "./history.js";
import { bootstrapFromWindows, deleteNode, moveNode, renameGroup } from "../model/outline.js";
import type { OutlineState, RuntimeWindow } from "../model/types.js";

const runtimeWindows: RuntimeWindow[] = [
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
        url: "https://one.example/",
        title: "One"
      },
      {
        id: 2,
        windowId: 10,
        index: 1,
        active: false,
        url: "https://two.example/",
        title: "Two"
      }
    ]
  }
];

describe("outline history", () => {
  it("stores compact undo and redo deltas for node state edits", () => {
    const previous = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const next = renameGroup(previous, "window:10", "Research", { now: 2000 });

    const entry = createHistoryEntry("renameGroup", previous, next);

    expect(entry).toBeDefined();
    expect(entry?.undo.updatedNodes.map((node) => node.id)).toEqual(["window:10"]);
    expect(entry?.undo.deletedNodeIds).toEqual([]);
    expect(entry?.redo.updatedNodes.map((node) => node.id)).toEqual(["window:10"]);
    expect(entry?.redo.deletedNodeIds).toEqual([]);
    expect(applyOutlineDelta(next, entry!.undo).nodes["window:10"]?.title).toBe("Group");
    expect(applyOutlineDelta(previous, entry!.redo).nodes["window:10"]?.title).toBe("Research");
  });

  it("stores structural deltas without copying untouched nodes", () => {
    const previous = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const next = moveNode(previous, "tab:2", { parentId: "tab:1", index: 0 });

    const entry = createHistoryEntry("moveNode", previous, next);

    expect(entry).toBeDefined();
    expect(entry?.redo.updatedNodes.map((node) => node.id).sort()).toEqual(["tab:1", "tab:2", "window:10"]);
    expect(entry?.undo.updatedNodes.map((node) => node.id).sort()).toEqual(["tab:1", "tab:2", "window:10"]);
    expect(applyOutlineDelta(next, entry!.undo).nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:2"]);
    expect(applyOutlineDelta(previous, entry!.redo).nodes["tab:1"]?.childIds).toEqual(["tab:2"]);
  });

  it("stores deleted subtree nodes for undo without storing untouched siblings", () => {
    const previous = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const next = deleteNode(previous, "tab:2", { allowLive: true });

    const entry = createHistoryEntry("deleteNode", previous, next);

    expect(entry).toBeDefined();
    expect(entry?.undo.updatedNodes.map((node) => node.id).sort()).toEqual(["tab:2", "window:10"]);
    expect(entry?.undo.deletedNodeIds).toEqual([]);
    expect(entry?.redo.updatedNodes.map((node) => node.id)).toEqual(["window:10"]);
    expect(entry?.redo.deletedNodeIds).toEqual(["tab:2"]);
    expect(entry?.undo.updatedNodes.some((node) => node.id === "tab:1")).toBe(false);
    expect(applyOutlineDelta(next, entry!.undo).nodes["tab:2"]?.title).toBe("Two");
    expect(applyOutlineDelta(previous, entry!.redo).nodes["tab:2"]).toBeUndefined();
  });

  it("clears redo entries and keeps only the newest bounded undo entries", () => {
    let history = {
      ...createEmptyHistoryState(),
      redoStack: [
        createHistoryEntry("renameGroup", emptyState(), emptyStateWithWindowTitle("Redo"))!
      ]
    };

    for (let index = 0; index < HISTORY_LIMIT + 3; index += 1) {
      history = pushUndoEntry(
        history,
        createHistoryEntry("renameGroup", emptyStateWithWindowTitle(`Before ${index}`), emptyStateWithWindowTitle(`After ${index}`))!
      );
    }

    expect(history.undoStack).toHaveLength(HISTORY_LIMIT);
    expect(history.redoStack).toEqual([]);
    expect(history.undoStack[0]?.undo.updatedNodes[0]?.title).toBe("Before 3");
    expect(historyStatus(history)).toMatchObject({
      canUndo: true,
      canRedo: false,
      undoDepth: HISTORY_LIMIT,
      redoDepth: 0
    });
  });
});

function emptyState(): OutlineState {
  return {
    version: 1,
    rootIds: [],
    nodes: {}
  };
}

function emptyStateWithWindowTitle(title: string): OutlineState {
  return {
    version: 1,
    rootIds: ["window:10"],
    nodes: {
      "window:10": {
        id: "window:10",
        kind: "window",
        status: "closed",
        childIds: [],
        title,
        collapsed: false,
        createdAt: 1000,
        updatedAt: 1000,
        closedAt: 1000
      }
    }
  };
}
