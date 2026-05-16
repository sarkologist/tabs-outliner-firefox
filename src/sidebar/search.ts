import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";

export type OutlineSearchResult = {
  isActive: boolean;
  query: string;
  visibleNodeIds: NodeId[];
  matchingNodeIds: Set<NodeId>;
  matchCount: number;
};

export function computeOutlineSearch(state: OutlineState, rawQuery: string): OutlineSearchResult {
  const query = normalizeSearchQuery(rawQuery);

  if (!query) {
    return {
      isActive: false,
      query,
      visibleNodeIds: collectOutlineOrderNodeIds(state),
      matchingNodeIds: new Set(),
      matchCount: 0
    };
  }

  const matchingNodeIds = new Set(
    collectOutlineOrderNodes(state)
      .filter((node) => nodeMatchesQuery(node, query))
      .map((node) => node.id)
  );
  const visibleNodeIds = collectVisibleSearchNodeIds(state, matchingNodeIds);

  return {
    isActive: true,
    query,
    visibleNodeIds,
    matchingNodeIds,
    matchCount: matchingNodeIds.size
  };
}

export function normalizeSearchQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

function collectVisibleSearchNodeIds(state: OutlineState, matchingNodeIds: Set<NodeId>): NodeId[] {
  const visible = new Set<NodeId>();

  for (const nodeId of matchingNodeIds) {
    let current: OutlineNode | undefined = state.nodes[nodeId];
    const visited = new Set<NodeId>();

    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      visible.add(current.id);
      current = current.parentId ? state.nodes[current.parentId] : undefined;
    }
  }

  return collectOutlineOrderNodeIds(state).filter((nodeId) => visible.has(nodeId));
}

function collectOutlineOrderNodes(state: OutlineState): OutlineNode[] {
  return collectOutlineOrderNodeIds(state).flatMap((nodeId) => {
    const node = state.nodes[nodeId];
    return node ? [node] : [];
  });
}

function collectOutlineOrderNodeIds(state: OutlineState): NodeId[] {
  const result: NodeId[] = [];
  const visited = new Set<NodeId>();

  for (const rootId of state.rootIds) {
    collectSubtreeNodeIds(state, rootId, result, visited);
  }

  return result;
}

function collectSubtreeNodeIds(
  state: OutlineState,
  nodeId: NodeId,
  result: NodeId[],
  visited: Set<NodeId>
): void {
  if (visited.has(nodeId)) {
    return;
  }
  visited.add(nodeId);

  const node = state.nodes[nodeId];
  if (!node) {
    return;
  }

  result.push(node.id);
  for (const childId of node.childIds) {
    collectSubtreeNodeIds(state, childId, result, visited);
  }
}

function nodeMatchesQuery(node: OutlineNode, query: string): boolean {
  return textMatchesQuery(node.title, query) || textMatchesQuery(node.url, query);
}

function textMatchesQuery(value: string | undefined, query: string): boolean {
  return Boolean(value?.toLocaleLowerCase().includes(query));
}
