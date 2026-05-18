import type { DropPlacement } from "./drop-target.js";
import type { VisibleTreeRow } from "./visible-tree.js";

export type DropPreviewConnector = {
  depth: number;
  startRowIndex: number;
  endRowIndex: number;
};

export type DropPreview = {
  markerDepth: number;
  markerRowIndex: number;
  connector?: DropPreviewConnector;
};

export function dropPreviewForPlacement(
  placement: DropPlacement,
  rows: readonly VisibleTreeRow[]
): DropPreview | undefined {
  const rowsByNodeId = new Map(rows.map((row) => [row.nodeId, row]));

  if (placement.kind === "root") {
    if (placement.targetId && placement.mode) {
      const targetRow = rowsByNodeId.get(placement.targetId);
      if (!targetRow) {
        return undefined;
      }

      return {
        markerDepth: 0,
        markerRowIndex: targetRow.index + (placement.mode === "after" ? 1 : 0)
      };
    }

    return {
      markerDepth: 0,
      markerRowIndex: rows.length
    };
  }

  const targetRow = rowsByNodeId.get(placement.targetId);
  if (!targetRow) {
    return undefined;
  }

  if (placement.mode === "inside") {
    const markerDepth = targetRow.depth + 1;
    return {
      markerDepth,
      markerRowIndex: targetRow.subtreeEndIndex,
      connector: {
        depth: markerDepth,
        startRowIndex: targetRow.index,
        endRowIndex: targetRow.subtreeEndIndex
      }
    };
  }

  const markerDepth = targetRow.depth;
  const markerRowIndex = placement.mode === "before" ? targetRow.index : targetRow.subtreeEndIndex;
  const connector =
    typeof targetRow.parentRowIndex === "number"
      ? {
          depth: markerDepth,
          startRowIndex: targetRow.parentRowIndex,
          endRowIndex: markerRowIndex
        }
      : undefined;

  return {
    markerDepth,
    markerRowIndex,
    ...(connector ? { connector } : {})
  };
}
