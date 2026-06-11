import { isLiveTabNode } from "../model/live-nodes.js";
import type { NodeId, OutlineState, RuntimeWindow } from "../model/types.js";

export type OutlineDiagnostics = {
  runtimeTabCount: number;
  liveTabNodeCount: number;
  visibleLiveTabNodeCount: number;
  closedTabNodeCount: number;
  hiddenLiveTabNodeCount: number;
  missingRuntimeTabIds: number[];
};

export function computeDiagnostics(state: OutlineState, runtimeWindows: RuntimeWindow[]): OutlineDiagnostics {
  const runtimeTabIds = new Set(
    runtimeWindows.flatMap((windowInfo) => windowInfo.tabs ?? []).map((tab) => tab.id)
  );
  const liveTabIds = new Set<number>();
  let liveTabNodeCount = 0;
  let closedTabNodeCount = 0;

  for (const node of Object.values(state.nodes)) {
    if (node.kind !== "tab") {
      continue;
    }

    if (isLiveTabNode(node)) {
      liveTabNodeCount += 1;
      liveTabIds.add(node.live.tabId);
    } else if (node.status === "closed") {
      closedTabNodeCount += 1;
    }
  }

  const visibleLiveTabNodeCount = countVisibleLiveTabs(state);
  const missingRuntimeTabIds = [...runtimeTabIds]
    .filter((tabId) => !liveTabIds.has(tabId))
    .sort((a, b) => a - b);

  return {
    runtimeTabCount: runtimeTabIds.size,
    liveTabNodeCount,
    visibleLiveTabNodeCount,
    closedTabNodeCount,
    hiddenLiveTabNodeCount: liveTabNodeCount - visibleLiveTabNodeCount,
    missingRuntimeTabIds
  };
}

function countVisibleLiveTabs(state: OutlineState): number {
  let count = 0;
  const visited = new Set<NodeId>();
  const stack = [...state.rootIds].reverse();

  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    if (visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);

    const node = state.nodes[nodeId];
    if (!node) {
      continue;
    }

    if (isLiveTabNode(node)) {
      count += 1;
    }
    if (node.collapsed) {
      continue;
    }

    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push(node.childIds[index]!);
    }
  }

  return count;
}

