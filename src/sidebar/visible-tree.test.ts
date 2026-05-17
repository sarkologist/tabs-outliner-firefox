import { describe, expect, it } from "vitest";

import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import { buildVisibleTreeProjection, calculateVirtualRange } from "./visible-tree.js";

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

  it("tracks the active tab while building the projection", () => {
    const state = wideState(10, { activeTabIndex: 7 });

    const projection = buildVisibleTreeProjection(state, "");

    expect(projection.activeTabNodeId).toBe("tab:7");
    expect(projection.activeTabRowIndex).toBe(7);
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

function windowNode(
  id: NodeId,
  childIds: NodeId[],
  options: Partial<Pick<OutlineNode, "active" | "collapsed">> = {}
): OutlineNode {
  return {
    id,
    kind: "window",
    status: "live",
    childIds,
    title: "Window",
    active: options.active ?? false,
    collapsed: options.collapsed ?? false,
    createdAt: 1,
    updatedAt: 1,
    live: { windowId: 1 }
  };
}

function tabNode(
  id: NodeId,
  parentId: NodeId,
  title: string,
  childIds: NodeId[] = [],
  options: Partial<Pick<OutlineNode, "active">> = {}
): OutlineNode {
  return {
    id,
    kind: "tab",
    status: "live",
    parentId,
    childIds,
    title,
    active: options.active ?? false,
    collapsed: false,
    createdAt: 1,
    updatedAt: 1,
    live: { tabId: Number(id.replace(/\D/g, "")) || 1, windowId: 1 }
  };
}
