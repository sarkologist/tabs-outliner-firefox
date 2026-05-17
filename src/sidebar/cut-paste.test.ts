import { describe, expect, it } from "vitest";

import { moveNode } from "../model/outline.js";
import type { BackgroundCommand } from "../background/commands.js";
import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import {
  cutSubtreeRowRange,
  isCutPasteShortcutEligibleTarget,
  isRowInCutSubtree,
  keyboardCutPasteAction,
  nextPendingCutNodeId,
  nodeIdForCutPasteTarget,
  pasteAfterCommand
} from "./cut-paste.js";

describe("cut/paste shortcut helpers", () => {
  it("detects cut and paste shortcuts for focused tree rows", () => {
    const target = {
      nodeId: "tab:a",
      tagName: "BUTTON"
    };

    expect(keyboardCutPasteAction({ key: "x", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, target))
      .toBe("cut");
    expect(keyboardCutPasteAction({ key: "V", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, target))
      .toBe("paste");
    expect(nodeIdForCutPasteTarget(target)).toBe("tab:a");
  });

  it("ignores shortcuts from editable targets", () => {
    expect(isCutPasteShortcutEligibleTarget({ nodeId: "tab:a", tagName: "INPUT" })).toBe(false);
    expect(isCutPasteShortcutEligibleTarget({ nodeId: "tab:a", tagName: "TEXTAREA" })).toBe(false);
    expect(isCutPasteShortcutEligibleTarget({ nodeId: "tab:a", tagName: "BUTTON", isContentEditable: true })).toBe(
      false
    );
    expect(
      keyboardCutPasteAction({ key: "x", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, {
        nodeId: "tab:a",
        tagName: "INPUT"
      })
    ).toBeUndefined();
  });
});

describe("pasteAfterCommand", () => {
  it("mirrors drag/drop command generation for paste-after", () => {
    const state = outlineState(["tab:a", "tab:b", "tab:c"]);

    expect(pasteAfterCommand(state, "tab:a", "tab:c")).toEqual({
      type: "moveNode",
      nodeId: "tab:a",
      parentId: "window:1",
      index: 2
    });
  });

  it("rejects paste onto the source or one of its descendants", () => {
    const state = outlineState(["tab:a", "tab:b"]);
    state.nodes["tab:a"]!.childIds = ["tab:a-child"];
    state.nodes["tab:a-child"] = tabNode("tab:a-child", "tab:a");

    expect(pasteAfterCommand(state, "tab:a", "tab:a")).toBeUndefined();
    expect(pasteAfterCommand(state, "tab:a", "tab:a-child")).toBeUndefined();
  });

  it("clears stale pending cuts when the source disappears", () => {
    const state = outlineState(["tab:a"]);

    expect(nextPendingCutNodeId(state, "tab:a")).toBe("tab:a");
    expect(nextPendingCutNodeId(state, "tab:missing")).toBeUndefined();
    expect(nextPendingCutNodeId(state, undefined)).toBeUndefined();
  });

  it("marks rows inside the visible cut subtree range", () => {
    const rows = [
      { nodeId: "window:1", index: 0, subtreeEndIndex: 5 },
      { nodeId: "tab:a", index: 1, subtreeEndIndex: 4 },
      { nodeId: "tab:a-child", index: 2, subtreeEndIndex: 3 },
      { nodeId: "tab:a-other", index: 3, subtreeEndIndex: 4 },
      { nodeId: "tab:b", index: 4, subtreeEndIndex: 5 }
    ];

    const range = cutSubtreeRowRange(rows, "tab:a");

    expect(range).toEqual({ startIndex: 1, endIndex: 4 });
    expect(rows.map((row) => isRowInCutSubtree(row, range))).toEqual([false, true, true, true, false]);
  });
});

describe("cut/paste generated traces", () => {
  it("keeps outline invariants and live tab ids across many paste-after moves", () => {
    let state = outlineState(["tab:a", "tab:b", "tab:c", "tab:d", "tab:e"]);
    state.nodes["tab:a"]!.childIds = ["tab:a-child"];
    state.nodes["tab:a-child"] = tabNode("tab:a-child", "tab:a");

    const originalLiveRefs = liveRefsByNodeId(state);
    const operations: Array<[sourceId: NodeId, targetId: NodeId]> = [
      ["tab:e", "tab:b"],
      ["tab:c", "tab:a-child"],
      ["tab:b", "tab:e"],
      ["tab:a-child", "tab:d"],
      ["tab:d", "tab:a"],
      ["tab:e", "tab:c"],
      ["tab:b", "tab:a-child"],
      ["tab:c", "tab:d"]
    ];

    for (const [sourceId, targetId] of operations) {
      const command = pasteAfterCommand(state, sourceId, targetId);
      if (isMoveNodeCommand(command)) {
        state = moveNode(state, command.nodeId, {
          ...(command.parentId ? { parentId: command.parentId } : {}),
          index: command.index
        });
      }
      expectValidOutline(state);
      expect(liveRefsByNodeId(state)).toEqual(originalLiveRefs);
    }
  });
});

function isMoveNodeCommand(command: BackgroundCommand | undefined): command is Extract<BackgroundCommand, { type: "moveNode" }> {
  return command?.type === "moveNode";
}

function outlineState(tabIds: NodeId[]): OutlineState {
  return {
    version: 1,
    rootIds: ["window:1"],
    nodes: {
      "window:1": windowNode(tabIds),
      ...Object.fromEntries(tabIds.map((id, index) => [id, tabNode(id, "window:1", index + 1)]))
    }
  };
}

function windowNode(childIds: NodeId[]): OutlineNode {
  return {
    id: "window:1",
    kind: "window",
    status: "live",
    childIds,
    title: "Window",
    collapsed: false,
    createdAt: 1,
    updatedAt: 1,
    live: { windowId: 1 }
  };
}

function tabNode(id: NodeId, parentId: NodeId, tabId = Number(id.replace(/\D/g, "")) || 1): OutlineNode {
  return {
    id,
    kind: "tab",
    status: "live",
    parentId,
    childIds: [],
    title: id,
    collapsed: false,
    createdAt: 1,
    updatedAt: 1,
    live: { tabId, windowId: 1 }
  };
}

function expectValidOutline(state: OutlineState): void {
  const seenRootIds = new Set<NodeId>();
  for (const rootId of state.rootIds) {
    expect(seenRootIds.has(rootId)).toBe(false);
    seenRootIds.add(rootId);
    expect(state.nodes[rootId]).toBeDefined();
    expect(state.nodes[rootId]?.parentId).toBeUndefined();
  }

  for (const [nodeId, node] of Object.entries(state.nodes)) {
    const childIds = new Set<NodeId>();
    for (const childId of node.childIds) {
      expect(childIds.has(childId)).toBe(false);
      childIds.add(childId);
      expect(state.nodes[childId]).toBeDefined();
      expect(state.nodes[childId]?.parentId).toBe(nodeId);
    }
    expect(hasCycle(state, nodeId)).toBe(false);
  }
}

function hasCycle(state: OutlineState, nodeId: NodeId): boolean {
  const seen = new Set<NodeId>();
  let current = state.nodes[nodeId];
  while (current?.parentId) {
    if (seen.has(current.id)) {
      return true;
    }
    seen.add(current.id);
    current = state.nodes[current.parentId];
  }
  return false;
}

function liveRefsByNodeId(state: OutlineState): Record<NodeId, { tabId?: number; windowId?: number }> {
  return Object.fromEntries(
    Object.entries(state.nodes)
      .filter(([, node]) => node.live)
      .map(([nodeId, node]) => [nodeId, { ...node.live }])
  );
}
