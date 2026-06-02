import type { LiveTabProjection, NodeId, OutlineNode, OutlineState } from "./types.js";

export type OutlineLookup = {
  nodes: OutlineNode[];
  nodeCount: number;
  closedCount: number;
  liveTabNodeIdsByRuntimeId: Map<number, NodeId>;
  liveWindowNodeIdsByRuntimeId: Map<number, NodeId>;
  liveTabProjectionsByWindowNodeId: Map<NodeId, LiveTabProjection[]>;
  closedTabNodeIdsByUrl: Map<string, NodeId[]>;
  closedRestoreCandidateCountsByWindowNodeId: Map<NodeId, number>;
  windowNodeIdsWithClosedRestoreCandidates: Set<NodeId>;
  ownerWindowNodeIdsByNodeId: Map<NodeId, NodeId>;
};

type OwnerWindowScan = {
  ownerWindowNodeIdsByNodeId: Map<NodeId, NodeId>;
  liveTabProjectionsByWindowNodeId: Map<NodeId, LiveTabProjection[]>;
  closedRestoreCandidateCountsByWindowNodeId: Map<NodeId, number>;
  windowNodeIdsWithClosedRestoreCandidates: Set<NodeId>;
};

export function buildOutlineLookup(state: OutlineState): OutlineLookup {
  const nodes = Object.values(state.nodes);
  const liveTabNodeIdsByRuntimeId = new Map<number, NodeId>();
  const liveWindowNodeIdsByRuntimeId = new Map<number, NodeId>();
  const closedTabNodeIdsByUrl = new Map<string, NodeId[]>();
  const ownerWindowScan = collectOwnerWindowScan(state);
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
    liveTabProjectionsByWindowNodeId: ownerWindowScan.liveTabProjectionsByWindowNodeId,
    closedTabNodeIdsByUrl,
    closedRestoreCandidateCountsByWindowNodeId: ownerWindowScan.closedRestoreCandidateCountsByWindowNodeId,
    windowNodeIdsWithClosedRestoreCandidates: ownerWindowScan.windowNodeIdsWithClosedRestoreCandidates,
    ownerWindowNodeIdsByNodeId: ownerWindowScan.ownerWindowNodeIdsByNodeId
  };
}

function collectOwnerWindowScan(state: OutlineState): OwnerWindowScan {
  const ownerWindowNodeIdsByNodeId = new Map<NodeId, NodeId>();
  const liveTabProjectionsByWindowNodeId = new Map<NodeId, LiveTabProjection[]>();
  const closedRestoreCandidateCountsByWindowNodeId = new Map<NodeId, number>();
  const windowNodeIdsWithClosedRestoreCandidates = new Set<NodeId>();
  const visited = new Set<NodeId>();
  const stack: Array<{ nodeId: NodeId; ownerWindowNodeId?: NodeId }> = [];

  for (let index = state.rootIds.length - 1; index >= 0; index -= 1) {
    stack.push({ nodeId: state.rootIds[index]! });
  }
  drainOwnerWindowScanStack(state, stack, visited, {
    ownerWindowNodeIdsByNodeId,
    liveTabProjectionsByWindowNodeId,
    closedRestoreCandidateCountsByWindowNodeId,
    windowNodeIdsWithClosedRestoreCandidates
  });

  for (const nodeId of Object.keys(state.nodes)) {
    if (visited.has(nodeId)) {
      continue;
    }
    stack.push({ nodeId: unvisitedComponentRootId(state, nodeId, visited) });
    drainOwnerWindowScanStack(state, stack, visited, {
      ownerWindowNodeIdsByNodeId,
      liveTabProjectionsByWindowNodeId,
      closedRestoreCandidateCountsByWindowNodeId,
      windowNodeIdsWithClosedRestoreCandidates
    });
  }

  return {
    ownerWindowNodeIdsByNodeId,
    liveTabProjectionsByWindowNodeId,
    closedRestoreCandidateCountsByWindowNodeId,
    windowNodeIdsWithClosedRestoreCandidates
  };
}

function drainOwnerWindowScanStack(
  state: OutlineState,
  stack: Array<{ nodeId: NodeId; ownerWindowNodeId?: NodeId }>,
  visited: Set<NodeId>,
  scan: OwnerWindowScan
): void {
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
      scan.ownerWindowNodeIdsByNodeId.set(node.id, ownerWindowNodeId);
      if (node.kind === "window" && !scan.liveTabProjectionsByWindowNodeId.has(node.id)) {
        scan.liveTabProjectionsByWindowNodeId.set(node.id, []);
      }
      if (node.id !== ownerWindowNodeId && node.kind === "tab") {
        if (node.status === "closed") {
          const count = scan.closedRestoreCandidateCountsByWindowNodeId.get(ownerWindowNodeId) ?? 0;
          scan.closedRestoreCandidateCountsByWindowNodeId.set(ownerWindowNodeId, count + 1);
          scan.windowNodeIdsWithClosedRestoreCandidates.add(ownerWindowNodeId);
        } else if (isLiveTabNode(node)) {
          const ownerWindow = state.nodes[ownerWindowNodeId];
          const targetWindowId =
            ownerWindow?.live && "windowId" in ownerWindow.live ? ownerWindow.live.windowId : node.live.windowId;
          scan.liveTabProjectionsByWindowNodeId.get(ownerWindowNodeId)?.push({
            tabId: node.live.tabId,
            windowId: targetWindowId
          });
        }
      }
    }

    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push({
        nodeId: node.childIds[index]!,
        ...(ownerWindowNodeId ? { ownerWindowNodeId } : {})
      });
    }
  }
}

function unvisitedComponentRootId(
  state: OutlineState,
  nodeId: NodeId,
  visited: ReadonlySet<NodeId>
): NodeId {
  let currentId = nodeId;
  const seen = new Set<NodeId>();

  while (true) {
    const current = state.nodes[currentId];
    const parentId = current?.parentId;
    if (!parentId || !state.nodes[parentId] || visited.has(parentId) || seen.has(parentId)) {
      return currentId;
    }
    seen.add(currentId);
    currentId = parentId;
  }
}

function isLiveTabNode(node: OutlineNode): node is OutlineNode & { live: { tabId: number; windowId: number } } {
  return Boolean(node.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live);
}

function isLiveWindowNode(node: OutlineNode): node is OutlineNode & { live: { windowId: number } } {
  return Boolean(node.kind === "window" && node.status === "live" && node.live && "windowId" in node.live);
}
