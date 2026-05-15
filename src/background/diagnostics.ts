import type { NodeId, OutlineNode, OutlineState, RuntimeWindow } from "../model/types.js";

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

    if (isLiveTab(node)) {
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
  for (const rootId of state.rootIds) {
    count += countVisibleLiveTabsFromNode(state, rootId);
  }
  return count;
}

function countVisibleLiveTabsFromNode(state: OutlineState, nodeId: NodeId): number {
  const node = state.nodes[nodeId];
  if (!node) {
    return 0;
  }

  let count = isLiveTab(node) ? 1 : 0;
  if (node.collapsed) {
    return count;
  }

  for (const childId of node.childIds) {
    count += countVisibleLiveTabsFromNode(state, childId);
  }
  return count;
}

function isLiveTab(node: OutlineNode): node is OutlineNode & { live: { tabId: number; windowId: number } } {
  return Boolean(node.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live);
}
