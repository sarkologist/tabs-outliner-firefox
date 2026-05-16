import type { NodeId, OutlineState } from "../model/types.js";
import { buildVisibleTreeProjection, normalizeSearchQuery } from "./visible-tree.js";

export type OutlineSearchResult = {
  isActive: boolean;
  query: string;
  visibleNodeIds: NodeId[];
  matchingNodeIds: Set<NodeId>;
  matchCount: number;
};

export function computeOutlineSearch(state: OutlineState, rawQuery: string): OutlineSearchResult {
  const projection = buildVisibleTreeProjection(state, rawQuery);

  return {
    isActive: projection.isSearchActive,
    query: projection.query,
    visibleNodeIds: projection.visibleNodeIds,
    matchingNodeIds: projection.matchingNodeIds,
    matchCount: projection.matchCount
  };
}

export { normalizeSearchQuery };
