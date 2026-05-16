import type { NodeId, OutlineNode, OutlineState } from "./types.js";

export type OutlineLookup = {
  nodes: OutlineNode[];
  nodeCount: number;
  closedCount: number;
  liveTabNodeIdsByRuntimeId: Map<number, NodeId>;
  liveWindowNodeIdsByRuntimeId: Map<number, NodeId>;
  closedTabNodeIdsByUrl: Map<string, NodeId[]>;
  ownerWindowNodeIdsByNodeId: Map<NodeId, NodeId>;
};

export function buildOutlineLookup(state: OutlineState): OutlineLookup {
  const nodes = Object.values(state.nodes);
  const liveTabNodeIdsByRuntimeId = new Map<number, NodeId>();
  const liveWindowNodeIdsByRuntimeId = new Map<number, NodeId>();
  const closedTabNodeIdsByUrl = new Map<string, NodeId[]>();
  const ownerWindowNodeIdsByNodeId = collectOwnerWindowNodeIds(state);
  let closedCount = 0;

  for (const node of nodes) {
    if (node.status === "closed") {
      closedCount += 1;
    }

    if (isLiveTabNode(node)) {
      liveTabNodeIdsByRuntimeId.set(node.live.tabId, node.id);
      continue;
    }

    if (isLiveWindowNode(node)) {
      liveWindowNodeIdsByRuntimeId.set(node.live.windowId, node.id);
      continue;
    }

    const url = node.kind === "tab" && node.status === "closed" ? node.restore?.url : undefined;
    if (url) {
      const bucket = closedTabNodeIdsByUrl.get(url) ?? [];
      bucket.push(node.id);
      closedTabNodeIdsByUrl.set(url, bucket);
    }
  }

  for (const bucket of closedTabNodeIdsByUrl.values()) {
    bucket.sort((leftId, rightId) => {
      const left = state.nodes[leftId];
      const right = state.nodes[rightId];
      return (right?.closedAt ?? 0) - (left?.closedAt ?? 0);
    });
  }

  return {
    nodes,
    nodeCount: nodes.length,
    closedCount,
    liveTabNodeIdsByRuntimeId,
    liveWindowNodeIdsByRuntimeId,
    closedTabNodeIdsByUrl,
    ownerWindowNodeIdsByNodeId
  };
}

function collectOwnerWindowNodeIds(state: OutlineState): Map<NodeId, NodeId> {
  const owners = new Map<NodeId, NodeId>();
  const visited = new Set<NodeId>();
  const stack: Array<{ nodeId: NodeId; ownerWindowNodeId?: NodeId }> = [];

  for (let index = state.rootIds.length - 1; index >= 0; index -= 1) {
    stack.push({ nodeId: state.rootIds[index]! });
  }

  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (visited.has(entry.nodeId)) {
      continue;
    }
    visited.add(entry.nodeId);

    const node = state.nodes[entry.nodeId];
    if (!node) {
      continue;
    }

    const ownerWindowNodeId = node.kind === "window" ? node.id : entry.ownerWindowNodeId;
    if (ownerWindowNodeId) {
      owners.set(node.id, ownerWindowNodeId);
    }

    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push({
        nodeId: node.childIds[index]!,
        ...(ownerWindowNodeId ? { ownerWindowNodeId } : {})
      });
    }
  }

  return owners;
}

function isLiveTabNode(node: OutlineNode): node is OutlineNode & { live: { tabId: number; windowId: number } } {
  return Boolean(node.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live);
}

function isLiveWindowNode(node: OutlineNode): node is OutlineNode & { live: { windowId: number } } {
  return Boolean(node.kind === "window" && node.status === "live" && node.live && "windowId" in node.live);
}
