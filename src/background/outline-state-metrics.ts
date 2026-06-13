import type { OutlineState } from "../model/types.js";
import type { IncidentLogDetail } from "./incident-log.js";

// Pure node/window/tab/closed tallies over an OutlineState, plus the before/after delta shape
// used in save and migration incident logs. Extracted from createBackgroundController so both
// the boot/init path and the persistence coordinator can share them without a closure dep.

export type OutlineStateCountDetail = {
  nodeCount: number;
  closedCount: number;
  rootCount: number;
  windowCount: number;
  tabCount: number;
};

export function outlineStateCountDetail(source: OutlineState): OutlineStateCountDetail {
  let nodeCount = 0;
  let closedCount = 0;
  let windowCount = 0;
  let tabCount = 0;
  for (const nodeId in source.nodes) {
    const node = source.nodes[nodeId];
    if (!node) {
      continue;
    }
    nodeCount += 1;
    if (node.kind === "window") {
      windowCount += 1;
    } else if (node.kind === "tab") {
      tabCount += 1;
    }
    if (node.status === "closed") {
      closedCount += 1;
    }
  }
  return {
    nodeCount,
    closedCount,
    rootCount: source.rootIds.length,
    windowCount,
    tabCount
  };
}

export function emptyOutlineStateCountDetail(): OutlineStateCountDetail {
  return {
    nodeCount: 0,
    closedCount: 0,
    rootCount: 0,
    windowCount: 0,
    tabCount: 0
  };
}

export function outlineStateCountDeltaDetail(
  previous: OutlineStateCountDetail,
  next: OutlineStateCountDetail
): IncidentLogDetail {
  return {
    previousNodeCount: previous.nodeCount,
    nodeCountDelta: next.nodeCount - previous.nodeCount,
    previousClosedCount: previous.closedCount,
    closedCountDelta: next.closedCount - previous.closedCount,
    previousRootCount: previous.rootCount,
    rootCountDelta: next.rootCount - previous.rootCount,
    previousWindowCount: previous.windowCount,
    windowCountDelta: next.windowCount - previous.windowCount,
    previousTabCount: previous.tabCount,
    tabCountDelta: next.tabCount - previous.tabCount
  };
}
