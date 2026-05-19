import { describe, expect, it } from "vitest";

import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import {
  applyDeleteTreeStructurePatchToProjection,
  applyInsertTreeStructurePatchToProjection,
  buildVisibleTreeProjection,
  calculateVirtualRange,
  refreshVisibleRowStructure
} from "./visible-tree.js";

const LARGE_NODE_COUNT = 50_000;

describe("visible tree projection", () => {
  it("calculates bounded virtual ranges for a 50k-node tree during jump scrolling", () => {
    const rowCount = LARGE_NODE_COUNT;
    const rowHeight = 18;
    const viewportHeight = 720;
    const overscan = 24;
    const positions = [
      0,
      rowHeight * 12_345,
      rowHeight * 49_500,
      rowHeight * rowCount
    ];

    for (const scrollTop of positions) {
      const range = calculateVirtualRange(rowCount, scrollTop, viewportHeight, rowHeight, overscan);

      expect(range.start).toBeGreaterThanOrEqual(0);
      expect(range.end).toBeLessThanOrEqual(rowCount);
      expect(range.end - range.start).toBeLessThanOrEqual(Math.ceil(viewportHeight / rowHeight) + overscan * 2);
      expect(range.totalHeight).toBe(rowCount * rowHeight);
      expect(range.offsetTop).toBe(range.start * rowHeight);
    }
  });

  it("flattens a 50k-node wide tree without rendering collapsed descendants", () => {
    const state = wideState(LARGE_NODE_COUNT);

    const projection = buildVisibleTreeProjection(state, "");

    expect(projection.nodeCount).toBe(LARGE_NODE_COUNT + 1);
    expect(projection.closedCount).toBe(0);
    expect(projection.rows).toHaveLength(LARGE_NODE_COUNT + 1);
    expect(projection.rows[0]).toMatchObject({
      nodeId: "window:1",
      depth: 0,
      visibleChildCount: LARGE_NODE_COUNT
    });
    expect(projection.rows[1]).toMatchObject({
      nodeId: "tab:1",
      depth: 1
    });
  });

  it("tracks parent row indexes and exclusive subtree boundaries for visible rows", () => {
    const state = outlineState([
      windowNode("window:1", ["tab:a", "tab:d"], { active: true }),
      tabNode("tab:a", "window:1", "A", ["tab:b", "tab:c"]),
      tabNode("tab:b", "tab:a", "B"),
      tabNode("tab:c", "tab:a", "C"),
      tabNode("tab:d", "window:1", "D"),
      windowNode("window:2", ["tab:e"]),
      tabNode("tab:e", "window:2", "E")
    ]);

    const projection = buildVisibleTreeProjection(state, "");

    expect(rowStructure(projection)).toEqual([
      { nodeId: "window:1", index: 0, parentRowIndex: undefined, subtreeEndIndex: 5 },
      { nodeId: "tab:a", index: 1, parentRowIndex: 0, subtreeEndIndex: 4 },
      { nodeId: "tab:b", index: 2, parentRowIndex: 1, subtreeEndIndex: 3 },
      { nodeId: "tab:c", index: 3, parentRowIndex: 1, subtreeEndIndex: 4 },
      { nodeId: "tab:d", index: 4, parentRowIndex: 0, subtreeEndIndex: 5 },
      { nodeId: "window:2", index: 5, parentRowIndex: undefined, subtreeEndIndex: 7 },
      { nodeId: "tab:e", index: 6, parentRowIndex: 5, subtreeEndIndex: 7 }
    ]);
  });

  it("bounds subtrees to descendants revealed by collapsed and search-visible projections", () => {
    const state = outlineState([
      windowNode("window:1", ["tab:parent"], { active: true }),
      tabNode("tab:parent", "window:1", "Parent", ["tab:hidden", "tab:match"], { collapsed: true }),
      tabNode("tab:hidden", "tab:parent", "Hidden", ["tab:hidden-child"]),
      tabNode("tab:hidden-child", "tab:hidden", "Hidden child"),
      tabNode("tab:match", "tab:parent", "Needle")
    ]);

    const collapsedProjection = buildVisibleTreeProjection(state, "");
    expect(rowStructure(collapsedProjection)).toEqual([
      { nodeId: "window:1", index: 0, parentRowIndex: undefined, subtreeEndIndex: 2 },
      { nodeId: "tab:parent", index: 1, parentRowIndex: 0, subtreeEndIndex: 2 }
    ]);

    const searchProjection = buildVisibleTreeProjection(state, "needle");
    expect(rowStructure(searchProjection)).toEqual([
      { nodeId: "window:1", index: 0, parentRowIndex: undefined, subtreeEndIndex: 3 },
      { nodeId: "tab:parent", index: 1, parentRowIndex: 0, subtreeEndIndex: 3 },
      { nodeId: "tab:match", index: 2, parentRowIndex: 1, subtreeEndIndex: 3 }
    ]);
  });

  it("recomputes row metadata after virtual projection rows are filtered", () => {
    const state = outlineState([
      windowNode("window:1", ["tab:a", "tab:d"], { active: true }),
      tabNode("tab:a", "window:1", "A", ["tab:b", "tab:c"]),
      tabNode("tab:b", "tab:a", "B"),
      tabNode("tab:c", "tab:a", "C"),
      tabNode("tab:d", "window:1", "D")
    ]);
    const projection = buildVisibleTreeProjection(state, "");

    projection.rows = projection.rows.filter((row) => row.nodeId !== "tab:b");
    refreshVisibleRowStructure(projection.rows);

    expect(rowStructure(projection)).toEqual([
      { nodeId: "window:1", index: 0, parentRowIndex: undefined, subtreeEndIndex: 4 },
      { nodeId: "tab:a", index: 1, parentRowIndex: 0, subtreeEndIndex: 3 },
      { nodeId: "tab:c", index: 2, parentRowIndex: 1, subtreeEndIndex: 3 },
      { nodeId: "tab:d", index: 3, parentRowIndex: 0, subtreeEndIndex: 4 }
    ]);
  });

  it("tracks the active tab while building the projection", () => {
    const state = wideState(10, { activeTabIndex: 7 });

    const projection = buildVisibleTreeProjection(state, "");

    expect(projection.activeTabNodeId).toBe("tab:7");
    expect(projection.activeTabRowIndex).toBe(7);
  });

  it("keeps outliner sidebar pages visible without using them as active-scroll targets", () => {
    const state = outlineState([
      windowNode("window:outliner", ["tab:outliner"], { active: true }),
      tabNode("tab:outliner", "window:outliner", "Tab Session Outliner", [], {
        active: true,
        url: "moz-extension://extension-id/sidebar/sidebar.html"
      }),
      windowNode("window:external", ["tab:external"], { active: true }),
      tabNode("tab:external", "window:external", "External", [], {
        active: true,
        url: "https://external.example/"
      })
    ]);

    const projection = buildVisibleTreeProjection(state, "");

    expect(projection.visibleNodeIds).toContain("tab:outliner");
    expect(projection.activeTabNodeId).toBe("tab:external");
    expect(projection.activeTabRowIndex).toBe(3);
  });

  it("chooses the active tab under the newly active window", () => {
    const state = outlineState([
      windowNode("window:old", ["tab:old"], { active: false }),
      tabNode("tab:old", "window:old", "Old active tab", [], { active: true }),
      windowNode("window:restored", ["tab:restored"], { active: true }),
      tabNode("tab:restored", "window:restored", "Restored active tab", [], { active: true })
    ]);

    const projection = buildVisibleTreeProjection(state, "");

    expect(projection.activeTabNodeId).toBe("tab:restored");
    expect(projection.activeTabRowIndex).toBe(3);
  });

  it("remembers a hidden active tab without assigning it a visible row", () => {
    const state = wideState(10, { activeTabIndex: 7, collapsedRoot: true });

    const projection = buildVisibleTreeProjection(state, "");

    expect(projection.activeTabNodeId).toBe("tab:7");
    expect(projection.activeTabRowIndex).toBeUndefined();
    expect(projection.visibleNodeIdSet.has("tab:7")).toBe(false);
  });

  it("searches a 50k-node deep tree without recursive stack overflow", () => {
    const state = deepState(LARGE_NODE_COUNT);

    const projection = buildVisibleTreeProjection(state, "needle");

    expect(projection.matchCount).toBe(1);
    expect(projection.rows).toHaveLength(LARGE_NODE_COUNT + 1);
    expect(projection.rows.at(-1)?.nodeId).toBe(`tab:${LARGE_NODE_COUNT}`);
  });

  it("applies active-search delete patches without rebuilding the projection", () => {
    const state = outlineState([
      windowNode("window:1", ["tab:parent", "tab:other"], { active: true }),
      tabNode("tab:parent", "window:1", "Parent", ["tab:child"]),
      tabNode("tab:child", "tab:parent", "Needle child"),
      tabNode("tab:other", "window:1", "Other")
    ]);
    const projection = buildVisibleTreeProjection(state, "needle");
    const next = outlineState([
      windowNode("window:1", ["tab:other"], { active: true }),
      tabNode("tab:other", "window:1", "Other")
    ]);

    const applied = applyDeleteTreeStructurePatchToProjection(next, projection, {
      deletedNodeIds: ["tab:parent", "tab:child"],
      updatedNodes: [next.nodes["window:1"]!],
      rootIds: ["window:1"],
      deletedClosedCount: 0
    });

    expect(applied).toBe(true);
    expect(projection.rows).toEqual([]);
    expect(projection.visibleNodeIds).toEqual([]);
    expect(projection.visibleNodeIdSet.size).toBe(0);
    expect(projection.matchingNodeIds.size).toBe(0);
    expect(projection.nodeCount).toBe(2);
    expect(projection.closedCount).toBe(0);
    expect(projection.matchCount).toBe(0);
  });

  it("keeps matching parents visible when an active-search delete removes their last child", () => {
    const state = outlineState([
      windowNode("window:1", ["tab:parent"], { active: true }),
      tabNode("tab:parent", "window:1", "Needle parent", ["tab:child"]),
      tabNode("tab:child", "tab:parent", "Needle child")
    ]);
    const projection = buildVisibleTreeProjection(state, "needle");
    const next = outlineState([
      windowNode("window:1", ["tab:parent"], { active: true }),
      tabNode("tab:parent", "window:1", "Needle parent")
    ]);

    const applied = applyDeleteTreeStructurePatchToProjection(next, projection, {
      deletedNodeIds: ["tab:child"],
      updatedNodes: [next.nodes["tab:parent"]!],
      rootIds: ["window:1"],
      deletedClosedCount: 0
    });

    expect(applied).toBe(true);
    expect(rowStructure(projection)).toEqual([
      { nodeId: "window:1", index: 0, parentRowIndex: undefined, subtreeEndIndex: 2 },
      { nodeId: "tab:parent", index: 1, parentRowIndex: 0, subtreeEndIndex: 2 }
    ]);
    expect(projection.matchingNodeIds).toEqual(new Set(["tab:parent"]));
    expect(projection.visibleNodeIds).toEqual(["window:1", "tab:parent"]);
    expect(projection.matchCount).toBe(1);
    expect(projection.rows[1]).toMatchObject({
      childCount: 0,
      visibleChildCount: 0,
      expanded: false,
      isSearchMatch: true,
      isSearchPath: false
    });
  });

  it("falls back when a delete patch also moves a row out of a removed group", () => {
    const state = outlineState([
      groupNode("group:wrapper", ["window:1"]),
      windowNode("window:1", ["tab:1"], { active: true, parentId: "group:wrapper" }),
      tabNode("tab:1", "window:1", "One", [], { active: true }),
      windowNode("window:2", ["tab:2"]),
      tabNode("tab:2", "window:2", "Two")
    ]);
    const projection = buildVisibleTreeProjection(state, "");
    const next = outlineState([
      windowNode("window:2", ["tab:2"]),
      tabNode("tab:2", "window:2", "Two"),
      windowNode("window:1", ["tab:1"], { active: true }),
      tabNode("tab:1", "window:1", "One", [], { active: true })
    ]);

    const applied = applyDeleteTreeStructurePatchToProjection(next, projection, {
      deletedNodeIds: ["group:wrapper"],
      updatedNodes: [next.nodes["window:1"]!],
      rootIds: ["window:2", "window:1"],
      deletedClosedCount: 0
    });

    expect(applied).toBe(false);
    expect(rowStructure(projection)).toEqual([
      { nodeId: "group:wrapper", index: 0, parentRowIndex: undefined, subtreeEndIndex: 3 },
      { nodeId: "window:1", index: 1, parentRowIndex: 0, subtreeEndIndex: 3 },
      { nodeId: "tab:1", index: 2, parentRowIndex: 1, subtreeEndIndex: 3 },
      { nodeId: "window:2", index: 3, parentRowIndex: undefined, subtreeEndIndex: 5 },
      { nodeId: "tab:2", index: 4, parentRowIndex: 3, subtreeEndIndex: 5 }
    ]);
  });

  it("applies non-search insertion patches without rebuilding the projection", () => {
    const state = outlineState([
      windowNode("window:1", ["tab:1"], { active: true }),
      tabNode("tab:1", "window:1", "One", [], { active: true })
    ]);
    const projection = buildVisibleTreeProjection(state, "");
    const next = outlineState([
      windowNode("window:1", ["tab:1", "tab:2"], { active: true }),
      tabNode("tab:1", "window:1", "One"),
      tabNode("tab:2", "window:1", "Two", [], { active: true })
    ]);

    const applied = applyInsertTreeStructurePatchToProjection(next, projection, {
      deletedNodeIds: [],
      updatedNodes: [next.nodes["window:1"]!, next.nodes["tab:1"]!, next.nodes["tab:2"]!],
      rootIds: ["window:1"],
      deletedClosedCount: 0
    });

    expect(applied).toBe(true);
    expect(rowStructure(projection)).toEqual([
      { nodeId: "window:1", index: 0, parentRowIndex: undefined, subtreeEndIndex: 3 },
      { nodeId: "tab:1", index: 1, parentRowIndex: 0, subtreeEndIndex: 2 },
      { nodeId: "tab:2", index: 2, parentRowIndex: 0, subtreeEndIndex: 3 }
    ]);
    expect(projection.nodeCount).toBe(3);
    expect(projection.closedCount).toBe(0);
    expect(projection.visibleNodeIds).toEqual(["window:1", "tab:1", "tab:2"]);
    expect(projection.visibleNodeIdSet).toEqual(new Set(["window:1", "tab:1", "tab:2"]));
    expect(projection.activeTabNodeId).toBe("tab:2");
    expect(projection.activeTabRowIndex).toBe(2);
    expect(projection.rows[2]?.insideActiveWindow).toBe(true);
  });

  it("falls back instead of applying insertion patches to active search projections", () => {
    const state = outlineState([
      windowNode("window:1", ["tab:1"], { active: true }),
      tabNode("tab:1", "window:1", "Needle one")
    ]);
    const projection = buildVisibleTreeProjection(state, "needle");
    const next = outlineState([
      windowNode("window:1", ["tab:1", "tab:2"], { active: true }),
      tabNode("tab:1", "window:1", "Needle one"),
      tabNode("tab:2", "window:1", "Needle two")
    ]);

    const applied = applyInsertTreeStructurePatchToProjection(next, projection, {
      deletedNodeIds: [],
      updatedNodes: [next.nodes["window:1"]!, next.nodes["tab:2"]!],
      rootIds: ["window:1"],
      deletedClosedCount: 0
    });

    expect(applied).toBe(false);
    expect(projection.visibleNodeIds).toEqual(["window:1", "tab:1"]);
  });
});

function wideState(
  tabCount: number,
  options: { activeTabIndex?: number; collapsedRoot?: boolean } = {}
): OutlineState {
  const root = windowNode("window:1", [], { active: true, collapsed: options.collapsedRoot });
  const nodes: Record<NodeId, OutlineNode> = {
    [root.id]: root
  };

  for (let index = 1; index <= tabCount; index += 1) {
    const id = `tab:${index}`;
    root.childIds.push(id);
    nodes[id] = tabNode(id, "window:1", `Tab ${index}`, [], { active: index === options.activeTabIndex });
  }

  return {
    version: 1,
    rootIds: [root.id],
    nodes
  };
}

function deepState(depth: number): OutlineState {
  const root = windowNode("window:1", ["tab:1"], { active: true });
  const nodes: Record<NodeId, OutlineNode> = {
    [root.id]: root
  };

  for (let index = 1; index <= depth; index += 1) {
    const id = `tab:${index}`;
    const childId = index === depth ? undefined : `tab:${index + 1}`;
    nodes[id] = tabNode(
      id,
      index === 1 ? "window:1" : `tab:${index - 1}`,
      index === depth ? "Needle" : `Tab ${index}`,
      childId ? [childId] : []
    );
  }

  return {
    version: 1,
    rootIds: [root.id],
    nodes
  };
}

function outlineState(nodes: OutlineNode[]): OutlineState {
  return {
    version: 1,
    rootIds: nodes.filter((node) => !node.parentId).map((node) => node.id),
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node]))
  };
}

function rowStructure(projection: ReturnType<typeof buildVisibleTreeProjection>) {
  return projection.rows.map((row) => ({
    nodeId: row.nodeId,
    index: row.index,
    parentRowIndex: row.parentRowIndex,
    subtreeEndIndex: row.subtreeEndIndex
  }));
}

function windowNode(
  id: NodeId,
  childIds: NodeId[],
  options: Partial<Pick<OutlineNode, "active" | "collapsed" | "parentId">> = {}
): OutlineNode {
  return {
    id,
    kind: "window",
    status: "live",
    ...(options.parentId ? { parentId: options.parentId } : {}),
    childIds,
    title: "Window",
    active: options.active ?? false,
    collapsed: options.collapsed ?? false,
    createdAt: 1,
    updatedAt: 1,
    live: { windowId: 1 }
  };
}

function groupNode(id: NodeId, childIds: NodeId[], parentId?: NodeId): OutlineNode {
  return {
    id,
    kind: "group",
    status: "neutral",
    ...(parentId ? { parentId } : {}),
    childIds,
    title: "Group",
    collapsed: false,
    createdAt: 1,
    updatedAt: 1
  };
}

function tabNode(
  id: NodeId,
  parentId: NodeId,
  title: string,
  childIds: NodeId[] = [],
  options: Partial<Pick<OutlineNode, "active" | "collapsed" | "url">> = {}
): OutlineNode {
  return {
    id,
    kind: "tab",
    status: "live",
    parentId,
    childIds,
    title,
    ...(options.url ? { url: options.url } : {}),
    active: options.active ?? false,
    collapsed: options.collapsed ?? false,
    createdAt: 1,
    updatedAt: 1,
    live: { tabId: Number(id.replace(/\D/g, "")) || 1, windowId: 1 }
  };
}
