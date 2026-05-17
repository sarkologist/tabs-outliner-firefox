import type { NodeId, OutlineState } from "../model/types.js";
import { buildVisibleTreeProjection, normalizeSearchQuery } from "./visible-tree.js";

export type OutlineSearchResult = {
  isActive: boolean;
  query: string;
  visibleNodeIds: NodeId[];
  matchingNodeIds: Set<NodeId>;
  matchCount: number;
};

export type SearchTextSegment = {
  text: string;
  isMatch: boolean;
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

export function segmentSearchText(text: string, rawQuery: string): SearchTextSegment[] {
  const query = normalizeSearchQuery(rawQuery);
  if (!query) {
    return text ? [{ text, isMatch: false }] : [];
  }

  const normalizedText = text.toLocaleLowerCase();
  const segments: SearchTextSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const matchIndex = normalizedText.indexOf(query, cursor);
    if (matchIndex === -1) {
      segments.push({ text: text.slice(cursor), isMatch: false });
      break;
    }

    if (matchIndex > cursor) {
      segments.push({ text: text.slice(cursor, matchIndex), isMatch: false });
    }

    const matchEnd = matchIndex + query.length;
    segments.push({ text: text.slice(matchIndex, matchEnd), isMatch: true });
    cursor = matchEnd;
  }

  return segments.length > 0 ? segments : text ? [{ text, isMatch: false }] : [];
}

export { normalizeSearchQuery };
