import { describe, expect, it } from "vitest";

import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import { generatedTraceConfig, generatedTraceTimeoutMs } from "../test/generated-traces.test-support.js";
import {
  applyDeleteTreeStructurePatchToProjection,
  applyCrossParentLeafMoveTreeStructurePatchToProjection,
  applyInsertTreeStructurePatchToProjection,
  applySameParentReorderTreeStructurePatchToProjection,
  buildVisibleTreeProjection,
  calculateVirtualRange,
  isAlreadyAppliedDeletePatch,
  refreshVisibleRowStructure,
  sameParentReorderTreeStructurePatchInfo,
  type VisibleTreeProjection
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

  it("applies trailing leaf delete patches without rebuilding projection arrays", () => {
    const state = wideState(LARGE_NODE_COUNT, { activeTabIndex: 1 });
    const projection = buildVisibleTreeProjection(state, "");
    const rows = projection.rows;
    const visibleNodeIds = projection.visibleNodeIds;
    const visibleNodeIdSet = projection.visibleNodeIdSet;
    const deletedNodeId = `tab:${LARGE_NODE_COUNT}`;
    const next = cloneOutlineStateForTest(state);
    const root = next.nodes["window:1"]!;
    root.childIds = root.childIds.filter((childId) => childId !== deletedNodeId);
    delete next.nodes[deletedNodeId];

    const applied = applyDeleteTreeStructurePatchToProjection(next, projection, {
      deletedNodeIds: [deletedNodeId],
      updatedNodes: [root],
      rootIds: ["window:1"],
      deletedClosedCount: 0
    });

    expect(applied).toBe(true);
    expect(projection.rows).toBe(rows);
    expect(projection.visibleNodeIds).toBe(visibleNodeIds);
    expect(projection.visibleNodeIdSet).toBe(visibleNodeIdSet);
    expect(projection.rows).toHaveLength(LARGE_NODE_COUNT);
    expect(projection.visibleNodeIds).toHaveLength(LARGE_NODE_COUNT);
    expect(projection.visibleNodeIdSet.has(deletedNodeId)).toBe(false);
    expect(projection.rows.at(-1)).toMatchObject({
      nodeId: `tab:${LARGE_NODE_COUNT - 1}`,
      index: LARGE_NODE_COUNT - 1,
      parentRowIndex: 0,
      subtreeEndIndex: LARGE_NODE_COUNT
    });
    expect(projection.rows[0]).toMatchObject({
      nodeId: "window:1",
      childCount: LARGE_NODE_COUNT - 1,
      visibleChildCount: LARGE_NODE_COUNT - 1,
      subtreeEndIndex: LARGE_NODE_COUNT
    });
    expect(projection.activeTabNodeId).toBe("tab:1");
    expect(projection.activeTabRowIndex).toBe(1);
  });

  it("applies same-parent reorder patches without rebuilding projection arrays", () => {
    const state = wideState(LARGE_NODE_COUNT, { activeTabIndex: 1 });
    const projection = buildVisibleTreeProjection(state, "");
    const rows = projection.rows;
    const visibleNodeIds = projection.visibleNodeIds;
    const visibleNodeIdSet = projection.visibleNodeIdSet;
    const movedNodeId = `tab:${LARGE_NODE_COUNT}`;
    const next = cloneOutlineStateForTest(state);
    const root = next.nodes["window:1"]!;
    root.childIds = root.childIds.filter((childId) => childId !== movedNodeId);
    root.childIds.splice(0, 0, movedNodeId);
    next.nodes[movedNodeId] = {
      ...next.nodes[movedNodeId]!,
      childIds: [...next.nodes[movedNodeId]!.childIds]
    };

    const applied = applySameParentReorderTreeStructurePatchToProjection(next, projection, {
      deletedNodeIds: [],
      updatedNodes: [root, next.nodes[movedNodeId]!],
      rootIds: ["window:1"],
      deletedClosedCount: 0
    });

    expect(applied).toBe(true);
    expect(projection.rows).toBe(rows);
    expect(projection.visibleNodeIds).toBe(visibleNodeIds);
    expect(projection.visibleNodeIdSet).toBe(visibleNodeIdSet);
    expect(projection.rows.slice(0, 4).map((row) => row.nodeId)).toEqual([
      "window:1",
      movedNodeId,
      "tab:1",
      "tab:2"
    ]);
    expect(projection.visibleNodeIds.slice(0, 4)).toEqual([
      "window:1",
      movedNodeId,
      "tab:1",
      "tab:2"
    ]);
    expect(projection.rows[1]).toMatchObject({
      nodeId: movedNodeId,
      index: 1,
      parentRowIndex: 0,
      subtreeEndIndex: 2
    });
    expect(projection.rows[2]).toMatchObject({
      nodeId: "tab:1",
      index: 2,
      parentRowIndex: 0,
      subtreeEndIndex: 3
    });
  });

  it("describes same-parent leaf reorder ranges for sidebar DOM reuse", () => {
    const state = wideState(LARGE_NODE_COUNT, { activeTabIndex: 1 });
    const projection = buildVisibleTreeProjection(state, "");
    const movedNodeId = "tab:40";
    const next = cloneOutlineStateForTest(state);
    const root = next.nodes["window:1"]!;
    root.childIds = root.childIds.filter((childId) => childId !== movedNodeId);
    root.childIds.splice(0, 0, movedNodeId);
    next.nodes[movedNodeId] = {
      ...next.nodes[movedNodeId]!,
      childIds: [...next.nodes[movedNodeId]!.childIds]
    };

    expect(sameParentReorderTreeStructurePatchInfo(next, projection, {
      deletedNodeIds: [],
      updatedNodes: [root, next.nodes[movedNodeId]!],
      rootIds: ["window:1"],
      deletedClosedCount: 0
    })).toEqual({
      parentId: "window:1",
      parentRowIndex: 0,
      movedNodeId,
      movedStart: 40,
      movedEnd: 41,
      movedSize: 1,
      insertionIndex: 1
    });
  });

  it("applies cross-parent visible leaf move patches in place", () => {
    const state = outlineState([
      windowNode("window:1", ["tab:a", "tab:b"]),
      tabNode("tab:a", "window:1", "A"),
      tabNode("tab:b", "window:1", "B"),
      windowNode("window:2", ["tab:c"], { active: true }),
      tabNode("tab:c", "window:2", "C", [], { active: true })
    ]);
    const projection = buildVisibleTreeProjection(state, "");
    const rows = projection.rows;
    const visibleNodeIds = projection.visibleNodeIds;
    const visibleNodeIdSet = projection.visibleNodeIdSet;
    const next = outlineState([
      windowNode("window:1", ["tab:a"]),
      tabNode("tab:a", "window:1", "A"),
      windowNode("window:2", ["tab:c", "tab:b"], { active: true }),
      tabNode("tab:c", "window:2", "C", [], { active: true }),
      tabNode("tab:b", "window:2", "B")
    ]);

    const applied = applyCrossParentLeafMoveTreeStructurePatchToProjection(next, projection, {
      deletedNodeIds: [],
      updatedNodes: [next.nodes["window:1"]!, next.nodes["window:2"]!, next.nodes["tab:b"]!],
      rootIds: ["window:1", "window:2"],
      deletedClosedCount: 0
    });

    expect(applied).toBe(true);
    expect(projection.rows).toBe(rows);
    expect(projection.visibleNodeIds).toBe(visibleNodeIds);
    expect(projection.visibleNodeIdSet).toBe(visibleNodeIdSet);
    expect(projection.rows.map((row) => row.nodeId)).toEqual([
      "window:1",
      "tab:a",
      "window:2",
      "tab:c",
      "tab:b"
    ]);
    expect(projection.visibleNodeIds).toEqual([
      "window:1",
      "tab:a",
      "window:2",
      "tab:c",
      "tab:b"
    ]);
    expect(projection.rows[0]).toMatchObject({
      nodeId: "window:1",
      index: 0,
      subtreeEndIndex: 2,
      childCount: 1,
      visibleChildCount: 1
    });
    expect(projection.rows[2]).toMatchObject({
      nodeId: "window:2",
      index: 2,
      subtreeEndIndex: 5,
      childCount: 2,
      visibleChildCount: 2
    });
    expect(projection.rows[4]).toMatchObject({
      nodeId: "tab:b",
      index: 4,
      parentRowIndex: 2,
      subtreeEndIndex: 5
    });
    expect(projection.activeTabNodeId).toBe("tab:c");
    expect(projection.activeTabRowIndex).toBe(3);
  });

  it("rejects same-parent reorder ranges when full projection child metadata is stale", () => {
    const state = wideState(LARGE_NODE_COUNT, { activeTabIndex: 1 });
    const projection = buildVisibleTreeProjection(state, "");
    projection.rows[0] = {
      ...projection.rows[0]!,
      visibleChildCount: LARGE_NODE_COUNT - 1
    };
    const movedNodeId = "tab:40";
    const next = cloneOutlineStateForTest(state);
    const root = next.nodes["window:1"]!;
    root.childIds = root.childIds.filter((childId) => childId !== movedNodeId);
    root.childIds.splice(0, 0, movedNodeId);
    next.nodes[movedNodeId] = {
      ...next.nodes[movedNodeId]!,
      childIds: [...next.nodes[movedNodeId]!.childIds]
    };

    expect(sameParentReorderTreeStructurePatchInfo(next, projection, {
      deletedNodeIds: [],
      updatedNodes: [root, next.nodes[movedNodeId]!],
      rootIds: ["window:1"],
      deletedClosedCount: 0
    })).toBeUndefined();
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

  it("wraps an existing visible subtree without flattening the previous sibling", () => {
    const state = outlineState([
      windowNode("window:1", ["tab:previous", "tab:target", "tab:after"], { active: true }),
      tabNode("tab:previous", "window:1", "Previous", ["tab:previous-child"]),
      tabNode("tab:previous-child", "tab:previous", "Previous child"),
      tabNode("tab:target", "window:1", "Target", ["tab:target-child"]),
      tabNode("tab:target-child", "tab:target", "Target child"),
      tabNode("tab:after", "window:1", "After")
    ]);
    const projection = buildVisibleTreeProjection(state, "");
    const next = outlineState([
      windowNode("window:1", ["tab:previous", "group:wrapper", "tab:after"], { active: true }),
      tabNode("tab:previous", "window:1", "Previous", ["tab:previous-child"]),
      tabNode("tab:previous-child", "tab:previous", "Previous child"),
      groupNode("group:wrapper", ["tab:target"], "window:1"),
      tabNode("tab:target", "group:wrapper", "Target", ["tab:target-child"]),
      tabNode("tab:target-child", "tab:target", "Target child"),
      tabNode("tab:after", "window:1", "After")
    ]);

    const applied = applyInsertTreeStructurePatchToProjection(next, projection, {
      deletedNodeIds: [],
      updatedNodes: [next.nodes["window:1"]!, next.nodes["group:wrapper"]!, next.nodes["tab:target"]!],
      rootIds: ["window:1"],
      deletedClosedCount: 0
    });

    expect(applied).toBe(true);
    expect(projection.rows.map(({ nodeId, depth, parentRowIndex, subtreeEndIndex }) => ({
      nodeId,
      depth,
      parentRowIndex,
      subtreeEndIndex
    }))).toEqual([
      { nodeId: "window:1", depth: 0, parentRowIndex: undefined, subtreeEndIndex: 7 },
      { nodeId: "tab:previous", depth: 1, parentRowIndex: 0, subtreeEndIndex: 3 },
      { nodeId: "tab:previous-child", depth: 2, parentRowIndex: 1, subtreeEndIndex: 3 },
      { nodeId: "group:wrapper", depth: 1, parentRowIndex: 0, subtreeEndIndex: 6 },
      { nodeId: "tab:target", depth: 2, parentRowIndex: 3, subtreeEndIndex: 6 },
      { nodeId: "tab:target-child", depth: 3, parentRowIndex: 4, subtreeEndIndex: 6 },
      { nodeId: "tab:after", depth: 1, parentRowIndex: 0, subtreeEndIndex: 7 }
    ]);
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

  it("keeps incremental insert and delete patches equivalent to fresh projections across generated traces", () => {
    const config = generatedTraceConfig({
      defaultSeedCount: 24,
      defaultSteps: 12,
      soakSeedCount: 96,
      soakSteps: 48
    });
    for (const seed of config.seeds) {
      runGeneratedPatchEquivalenceTrace(seed, config.steps);
    }
  }, generatedTraceTimeoutMs(10_000, 120_000));
});

describe("isAlreadyAppliedDeletePatch", () => {
  it("recognises a delete already reflected in state so the broadcast echo can be skipped", () => {
    const state = outlineState([
      windowNode("window:1", ["tab:1", "tab:2"], { active: true }),
      tabNode("tab:1", "window:1", "One", [], { active: true }),
      tabNode("tab:2", "window:1", "Two")
    ]);
    const projection = buildVisibleTreeProjection(state, "");
    expect(projection.nodeCount).toBe(3);

    const next = outlineState([
      windowNode("window:1", ["tab:1"], { active: true }),
      tabNode("tab:1", "window:1", "One", [], { active: true })
    ]);
    const deletePatch = {
      deletedNodeIds: ["tab:2"],
      updatedNodes: [next.nodes["window:1"]!],
      rootIds: ["window:1"],
      deletedClosedCount: 0
    };

    // Before the delete is applied, the node is still present -> the patch must run.
    expect(isAlreadyAppliedDeletePatch(state, deletePatch.deletedNodeIds)).toBe(false);
    expect(applyDeleteTreeStructurePatchToProjection(next, projection, deletePatch)).toBe(true);
    expect(projection.nodeCount).toBe(2);

    // The optimistic-delete echo carries the same delta after the node is gone. The guard flags it,
    // so the sidebar skips re-applying it -- re-applying would double-decrement the counts below.
    expect(isAlreadyAppliedDeletePatch(next, deletePatch.deletedNodeIds)).toBe(true);
    applyDeleteTreeStructurePatchToProjection(next, projection, deletePatch);
    expect(projection.nodeCount).toBeLessThan(2);
  });

  it("only flags deltas whose every deleted node is absent", () => {
    const state = outlineState([
      windowNode("window:1", ["tab:1"], { active: true }),
      tabNode("tab:1", "window:1", "One", [], { active: true })
    ]);

    expect(isAlreadyAppliedDeletePatch(state, [])).toBe(false);
    expect(isAlreadyAppliedDeletePatch(state, ["tab:1"])).toBe(false);
    expect(isAlreadyAppliedDeletePatch(state, ["tab:1", "tab:404"])).toBe(false);
    expect(isAlreadyAppliedDeletePatch(state, ["tab:404"])).toBe(true);
  });
});

type GeneratedPatchOperation = {
  name: string;
  kind: "insert" | "delete";
  next: OutlineState;
  deletedNodeIds: NodeId[];
  updatedNodes: OutlineNode[];
};

function runGeneratedPatchEquivalenceTrace(seed: number, steps: number): void {
  let state = generatedPatchState(seed);
  let nextTabOrdinal = seed * 1000;
  let nextGroupOrdinal = seed * 1000;
  const rng = seededRandom(seed);
  const history = [`seed ${seed}`];

  for (let step = 0; step < steps; step += 1) {
    const preferredOperation = step % 3;
    const operation =
      generatedPatchOperation(state, preferredOperation, rng, nextTabOrdinal, nextGroupOrdinal) ??
      generatedPatchOperation(state, (preferredOperation + 1) % 3, rng, nextTabOrdinal, nextGroupOrdinal) ??
      generatedPatchOperation(state, (preferredOperation + 2) % 3, rng, nextTabOrdinal, nextGroupOrdinal);
    if (!operation) {
      break;
    }

    if (operation.name.startsWith("insert")) {
      nextTabOrdinal += 1;
    } else if (operation.name.startsWith("wrap")) {
      nextGroupOrdinal += 1;
    }

    const label = `step ${step + 1}: ${operation.name}`;
    history.push(label);
    const projection = buildVisibleTreeProjection(state, "");
    const applied = applyGeneratedPatchOperation(operation, projection);

    expect(applied, history.join("\n")).toBe(true);
    expect(projectionSnapshot(projection), history.join("\n")).toEqual(
      projectionSnapshot(buildVisibleTreeProjection(operation.next, ""))
    );
    state = operation.next;
  }
}

function generatedPatchOperation(
  state: OutlineState,
  operationIndex: number,
  rng: () => number,
  nextTabOrdinal: number,
  nextGroupOrdinal: number
): GeneratedPatchOperation | undefined {
  if (operationIndex === 0) {
    return wrapVisibleNodeOperation(state, rng, nextGroupOrdinal);
  }
  if (operationIndex === 1) {
    return insertVisibleLeafOperation(state, rng, nextTabOrdinal);
  }
  return deleteVisibleSubtreeOperation(state, rng);
}

function applyGeneratedPatchOperation(
  operation: GeneratedPatchOperation,
  projection: VisibleTreeProjection
): boolean {
  const patch = {
    deletedNodeIds: operation.deletedNodeIds,
    updatedNodes: operation.updatedNodes,
    rootIds: operation.next.rootIds,
    deletedClosedCount: 0
  };
  return operation.kind === "insert"
    ? applyInsertTreeStructurePatchToProjection(operation.next, projection, patch)
    : applyDeleteTreeStructurePatchToProjection(operation.next, projection, patch);
}

function wideState(
  tabCount: number,
  options: { activeTabIndex?: number; collapsedRoot?: boolean } = {}
): OutlineState {
  const root = windowNode("window:1", [], {
    active: true,
    ...(options.collapsedRoot !== undefined ? { collapsed: options.collapsedRoot } : {})
  });
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

function projectionSnapshot(projection: VisibleTreeProjection) {
  return {
    rows: projection.rows.map((row) => ({
      nodeId: row.nodeId,
      depth: row.depth,
      index: row.index,
      parentRowIndex: row.parentRowIndex,
      subtreeEndIndex: row.subtreeEndIndex,
      childCount: row.childCount,
      visibleChildCount: row.visibleChildCount,
      expanded: row.expanded,
      searchRevealsCollapsedChildren: row.searchRevealsCollapsedChildren,
      isSearchMatch: row.isSearchMatch,
      isSearchPath: row.isSearchPath,
      insideActiveWindow: row.insideActiveWindow
    })),
    matchingNodeIds: [...projection.matchingNodeIds].sort(),
    visibleNodeIds: [...projection.visibleNodeIds],
    visibleNodeIdSet: [...projection.visibleNodeIdSet].sort(),
    activeTabNodeId: projection.activeTabNodeId,
    activeTabRowIndex: projection.activeTabRowIndex,
    nodeCount: projection.nodeCount,
    closedCount: projection.closedCount,
    matchCount: projection.matchCount
  };
}

function generatedPatchState(seed: number): OutlineState {
  const baseTabId = seed * 100;
  return outlineState([
    windowNode("window:1", ["tab:a", "tab:b", "tab:c", "tab:d"], { active: true }),
    tabNode("tab:a", "window:1", "A", ["tab:a1", "tab:a2"], { active: true }),
    tabNode("tab:a1", "tab:a", "A1"),
    tabNode("tab:a2", "tab:a", "A2", ["tab:a2i"]),
    tabNode("tab:a2i", "tab:a2", "A2 inner"),
    tabNode("tab:b", "window:1", "B", ["tab:b1"]),
    tabNode("tab:b1", "tab:b", "B1"),
    tabNode("tab:c", "window:1", "C"),
    tabNode("tab:d", "window:1", "D", ["tab:d1", `tab:seed:${baseTabId}`]),
    tabNode("tab:d1", "tab:d", "D1"),
    tabNode(`tab:seed:${baseTabId}`, "tab:d", `Seed ${seed}`)
  ]);
}

function wrapVisibleNodeOperation(
  state: OutlineState,
  rng: () => number,
  nextGroupOrdinal: number
): GeneratedPatchOperation | undefined {
  const projection = buildVisibleTreeProjection(state, "");
  const targetId = pickOne(
    rng,
    projection.rows
      .map((row) => row.nodeId)
      .filter((nodeId) => Boolean(state.nodes[nodeId]?.parentId))
  );
  const target = targetId ? state.nodes[targetId] : undefined;
  if (!target?.parentId) {
    return undefined;
  }

  const next = cloneOutlineStateForTest(state);
  const parent = next.nodes[target.parentId];
  const moving = next.nodes[target.id];
  if (!parent || !moving) {
    return undefined;
  }

  const wrapperId = `group:generated:${nextGroupOrdinal}`;
  const targetIndex = parent.childIds.indexOf(target.id);
  if (targetIndex < 0 || next.nodes[wrapperId]) {
    return undefined;
  }

  parent.childIds.splice(targetIndex, 1, wrapperId);
  moving.parentId = wrapperId;
  const wrapper = groupNode(wrapperId, [moving.id], parent.id);
  next.nodes[wrapper.id] = wrapper;

  return {
    name: `wrap ${target.id}`,
    kind: "insert",
    next,
    deletedNodeIds: [],
    updatedNodes: [parent, wrapper, moving]
  };
}

function insertVisibleLeafOperation(
  state: OutlineState,
  rng: () => number,
  nextTabOrdinal: number
): GeneratedPatchOperation | undefined {
  const projection = buildVisibleTreeProjection(state, "");
  const parentId = pickOne(
    rng,
    projection.rows
      .filter((row) => row.expanded)
      .map((row) => row.nodeId)
      .filter((nodeId) => Boolean(state.nodes[nodeId]))
  );
  const parent = parentId ? state.nodes[parentId] : undefined;
  if (!parent) {
    return undefined;
  }

  const next = cloneOutlineStateForTest(state);
  const nextParent = next.nodes[parent.id];
  if (!nextParent) {
    return undefined;
  }

  const nodeId = `tab:generated:${nextTabOrdinal}`;
  if (next.nodes[nodeId]) {
    return undefined;
  }

  const insertionIndex = Math.floor(rng() * (nextParent.childIds.length + 1));
  const tab = tabNode(nodeId, nextParent.id, `Generated ${nextTabOrdinal}`, [], {
    url: `https://generated.example/${nextTabOrdinal}`
  });
  tab.live = {
    tabId: nextTabOrdinal,
    windowId: nearestRuntimeWindowId(next, nextParent.id)
  };
  nextParent.childIds.splice(insertionIndex, 0, tab.id);
  next.nodes[tab.id] = tab;

  return {
    name: `insert ${tab.id} under ${nextParent.id}`,
    kind: "insert",
    next,
    deletedNodeIds: [],
    updatedNodes: [nextParent, tab]
  };
}

function deleteVisibleSubtreeOperation(
  state: OutlineState,
  rng: () => number
): GeneratedPatchOperation | undefined {
  const projection = buildVisibleTreeProjection(state, "");
  const targetId = pickOne(
    rng,
    projection.rows
      .map((row) => row.nodeId)
      .filter((nodeId) => Boolean(state.nodes[nodeId]?.parentId))
  );
  const target = targetId ? state.nodes[targetId] : undefined;
  if (!target?.parentId) {
    return undefined;
  }

  const next = cloneOutlineStateForTest(state);
  const parent = next.nodes[target.parentId];
  if (!parent) {
    return undefined;
  }
  const deletedNodeIds = collectSubtreeIds(state, target.id);
  parent.childIds = parent.childIds.filter((childId) => childId !== target.id);
  for (const deletedNodeId of deletedNodeIds) {
    delete next.nodes[deletedNodeId];
  }

  return {
    name: `delete ${target.id}`,
    kind: "delete",
    next,
    deletedNodeIds,
    updatedNodes: [parent]
  };
}

function cloneOutlineStateForTest(state: OutlineState): OutlineState {
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

function collectSubtreeIds(state: OutlineState, nodeId: NodeId): NodeId[] {
  const ids: NodeId[] = [];
  const stack = [nodeId];
  const visited = new Set<NodeId>();
  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);
    const node = state.nodes[currentId];
    if (!node) {
      continue;
    }
    ids.push(currentId);
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push(node.childIds[index]!);
    }
  }
  return ids;
}

function nearestRuntimeWindowId(state: OutlineState, nodeId: NodeId): number {
  let current = state.nodes[nodeId];
  const visited = new Set<NodeId>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.kind === "window" && current.live && "windowId" in current.live) {
      return current.live.windowId;
    }
    current = current.parentId ? state.nodes[current.parentId] : undefined;
  }
  return 1;
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
