import { describe, expect, it } from "vitest";
import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import {
  commandForDropPlacement,
  dropModeForPointer,
  dropPlacementForNode,
  dropPlacementForRoot
} from "./drop-target.js";

describe("dropModeForPointer", () => {
  it("maps top, middle, and bottom row thirds to drop modes", () => {
    expect(dropModeForPointer(4, 30)).toBe("before");
    expect(dropModeForPointer(15, 30)).toBe("inside");
    expect(dropModeForPointer(26, 30)).toBe("after");
  });
});

describe("dropPlacementForNode", () => {
  it("corrects the final index when moving an earlier sibling after a later sibling", () => {
    const state = outlineState(["tab:a", "tab:b", "tab:c", "tab:d"]);
    const placement = dropPlacementForNode(state, "tab:a", "tab:c", "after");

    expect(placement && commandForDropPlacement(placement)).toEqual({
      type: "moveNode",
      nodeId: "tab:a",
      parentId: "window:1",
      index: 2
    });
  });

  it("keeps the target index when moving a later sibling before an earlier sibling", () => {
    const state = outlineState(["tab:a", "tab:b", "tab:c", "tab:d"]);
    const placement = dropPlacementForNode(state, "tab:d", "tab:b", "before");

    expect(placement && commandForDropPlacement(placement)).toEqual({
      type: "moveNode",
      nodeId: "tab:d",
      parentId: "window:1",
      index: 1
    });
  });

  it("rejects self drops", () => {
    const state = outlineState(["tab:a", "tab:b"]);

    expect(dropPlacementForNode(state, "tab:a", "tab:a", "inside")).toBeUndefined();
  });

  it("rejects drops into a dragged node's own descendants", () => {
    const state = outlineState(["tab:a", "tab:b"]);
    state.nodes["tab:a"]!.childIds = ["tab:a-child"];
    state.nodes["tab:a-child"] = tabNode("tab:a-child", "tab:a");

    expect(dropPlacementForNode(state, "tab:a", "tab:a-child", "inside")).toBeUndefined();
  });
});

describe("dropPlacementForRoot", () => {
  it("creates a new-window command for tab nodes", () => {
    const state = outlineState(["tab:a"]);
    const placement = dropPlacementForRoot(state, "tab:a");

    expect(placement && commandForDropPlacement(placement)).toEqual({
      type: "moveNodeToNewWindow",
      nodeId: "tab:a"
    });
  });

  it("rejects non-tab nodes", () => {
    const state = outlineState(["tab:a"]);

    expect(dropPlacementForRoot(state, "window:1")).toBeUndefined();
  });
});

function outlineState(tabIds: NodeId[]): OutlineState {
  return {
    version: 1,
    rootIds: ["window:1"],
    nodes: {
      "window:1": windowNode(tabIds),
      ...Object.fromEntries(tabIds.map((id) => [id, tabNode(id, "window:1")]))
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

function tabNode(id: NodeId, parentId: NodeId): OutlineNode {
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
    live: { tabId: Number(id.replace(/\D/g, "")) || 1, windowId: 1 }
  };
}
