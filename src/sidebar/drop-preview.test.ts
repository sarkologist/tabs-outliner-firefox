import { describe, expect, it } from "vitest";

import type { DropPlacement } from "./drop-target.js";
import { dropPreviewForPlacement } from "./drop-preview.js";
import type { VisibleTreeRow } from "./visible-tree.js";

describe("dropPreviewForPlacement", () => {
  it("places after previews after an expanded target subtree", () => {
    const preview = dropPreviewForPlacement(nodePlacement("after", "tab:a"), expandedRows());

    expect(preview).toEqual({
      markerDepth: 1,
      markerRowIndex: 4,
      connector: {
        depth: 1,
        endRowIndex: 4,
        startRowIndex: 0
      }
    });
  });

  it("places inside previews at the end of an expanded target subtree", () => {
    const preview = dropPreviewForPlacement(nodePlacement("inside", "tab:a"), expandedRows());

    expect(preview).toEqual({
      markerDepth: 2,
      markerRowIndex: 4,
      connector: {
        depth: 2,
        endRowIndex: 4,
        startRowIndex: 1
      }
    });
  });

  it("places inside previews directly below collapsed targets", () => {
    const preview = dropPreviewForPlacement(nodePlacement("inside", "tab:a"), collapsedRows());

    expect(preview).toEqual({
      markerDepth: 2,
      markerRowIndex: 2,
      connector: {
        depth: 2,
        endRowIndex: 2,
        startRowIndex: 1
      }
    });
  });

  it("does not draw parent connectors for root placements", () => {
    const preview = dropPreviewForPlacement(
      {
        kind: "root",
        sourceId: "tab:b",
        index: 1,
        createsWindow: true
      },
      expandedRows()
    );

    expect(preview).toEqual({
      markerDepth: 0,
      markerRowIndex: 6
    });
  });
});

function nodePlacement(mode: "before" | "inside" | "after", targetId: string): DropPlacement {
  return {
    kind: "node",
    mode,
    sourceId: "tab:b",
    targetId,
    parentId: mode === "inside" ? targetId : "window:1",
    index: 0
  };
}

function expandedRows(): VisibleTreeRow[] {
  return [
    row("window:1", 0, 0, 6),
    row("tab:a", 1, 1, 4, 0),
    row("tab:a1", 2, 2, 3, 1),
    row("tab:a2", 3, 2, 4, 1),
    row("tab:source", 4, 1, 5, 0),
    row("tab:b", 5, 1, 6, 0)
  ];
}

function collapsedRows(): VisibleTreeRow[] {
  return [
    row("window:1", 0, 0, 4),
    {
      ...row("tab:a", 1, 1, 2, 0),
      childCount: 2,
      visibleChildCount: 0,
      expanded: false
    },
    row("tab:source", 2, 1, 3, 0),
    row("tab:b", 3, 1, 4, 0)
  ];
}

function row(
  nodeId: string,
  index: number,
  depth: number,
  subtreeEndIndex: number,
  parentRowIndex?: number
): VisibleTreeRow {
  return {
    nodeId,
    index,
    depth,
    subtreeEndIndex,
    childCount: 0,
    visibleChildCount: 0,
    expanded: false,
    searchRevealsCollapsedChildren: false,
    isSearchMatch: false,
    isSearchPath: false,
    insideActiveWindow: true,
    ...(typeof parentRowIndex === "number" ? { parentRowIndex } : {})
  };
}
