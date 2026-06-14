import type { NodeId, OutlineNode, OutlineState, RuntimeWindow } from "../model/types.js";

// Structural equality / comparison helpers extracted from controller.ts (no behavior change).
// Pure functions over outline state and runtime-window shape; no closure or controller state.

export function sameNodeIdList(previous: NodeId[], next: NodeId[]): boolean {
  return previous.length === next.length && previous.every((nodeId, index) => nodeId === next[index]);
}

// Node ids added, removed, or materially changed between two states. Used to scope an incremental
// v4 save's dirty shards to what actually changed since the loaded baseline. Material (not identity)
// comparison so a startup reconciliation that rebuilds node objects wholesale -- but leaves most of
// them equal -- still produces a tight dirty set; clean shards keep their stored value, which is the
// same contract the save decision already relies on (it is gated on statesMateriallyEqual, and every
// post-startup incremental save likewise rewrites only candidate shards). Only pure updatedAt drift
// is excluded, exactly as elsewhere. Cheap: O(node count), run once at startup.
export function changedNodeIdsSinceBaseline(baseline: OutlineState, next: OutlineState): NodeId[] {
  const ids: NodeId[] = [];
  for (const id of Object.keys(next.nodes)) {
    const before = baseline.nodes[id];
    if (!before || !nodesMateriallyEqual(before, next.nodes[id]!)) {
      ids.push(id);
    }
  }
  for (const id of Object.keys(baseline.nodes)) {
    if (!next.nodes[id]) {
      ids.push(id);
    }
  }
  return ids;
}

export function sameNumberList(previous: readonly number[], next: readonly number[]): boolean {
  return previous.length === next.length && previous.every((value, index) => next[index] === value);
}

export function sameNumberSet(previous: readonly number[], next: readonly number[]): boolean {
  if (previous.length !== next.length) {
    return false;
  }
  const values = new Set(previous);
  return next.every((value) => values.has(value));
}

export function runtimeWindowOrdersMatch(
  previous: readonly RuntimeWindow[],
  next: readonly RuntimeWindow[],
  windowIds: readonly number[]
): boolean {
  const previousById = new Map(previous.map((windowInfo) => [windowInfo.id, windowInfo]));
  const nextById = new Map(next.map((windowInfo) => [windowInfo.id, windowInfo]));
  return windowIds.every((windowId) => {
    const previousWindow = previousById.get(windowId);
    const nextWindow = nextById.get(windowId);
    return previousWindow &&
      nextWindow &&
      sameNumberList(runtimeWindowTabOrder(previousWindow), runtimeWindowTabOrder(nextWindow));
  });
}

export function runtimeWindowTabOrder(windowInfo: RuntimeWindow): number[] {
  return [...(windowInfo.tabs ?? [])]
    .filter((tab) => !tab.incognito)
    .sort((left, right) => left.index - right.index)
    .map((tab) => tab.id);
}

export function statesMateriallyEqual(previous: OutlineState, next: OutlineState): boolean {
  if (!sameNodeIdList(previous.rootIds, next.rootIds)) {
    return false;
  }

  const previousNodeIds = Object.keys(previous.nodes);
  if (previousNodeIds.length !== Object.keys(next.nodes).length) {
    return false;
  }

  return previousNodeIds.every((nodeId) => {
    const previousNode = previous.nodes[nodeId];
    const nextNode = next.nodes[nodeId];
    return Boolean(previousNode && nextNode && nodesMateriallyEqual(previousNode, nextNode));
  });
}

export function statesEqualIgnoringUpdatedAt(previous: OutlineState, next: OutlineState): boolean {
  if (!sameNodeIdList(previous.rootIds, next.rootIds)) {
    return false;
  }

  const previousNodeIds = Object.keys(previous.nodes);
  if (previousNodeIds.length !== Object.keys(next.nodes).length) {
    return false;
  }

  return previousNodeIds.every((nodeId) => {
    const previousNode = previous.nodes[nodeId];
    const nextNode = next.nodes[nodeId];
    return Boolean(previousNode && nextNode && nodesEqualIgnoringUpdatedAt(previousNode, nextNode));
  });
}

export function nodesMateriallyEqual(previous: OutlineNode, next: OutlineNode): boolean {
  return previous.id === next.id &&
    previous.kind === next.kind &&
    previous.status === next.status &&
    previous.parentId === next.parentId &&
    sameNodeIdList(previous.childIds, next.childIds) &&
    previous.title === next.title &&
    previous.customTitle === next.customTitle &&
    previous.url === next.url &&
    previous.favIconUrl === next.favIconUrl &&
    previous.active === next.active &&
    previous.collapsed === next.collapsed &&
    previous.createdAt === next.createdAt &&
    previous.closedAt === next.closedAt &&
    previous.restoredFromClosed === next.restoredFromClosed &&
    liveRefsEqual(previous.live, next.live) &&
    restoreRefsEqual(previous.restore, next.restore);
}

export function nodesEqualIgnoringUpdatedAt(previous: OutlineNode, next: OutlineNode): boolean {
  return previous.id === next.id &&
    previous.kind === next.kind &&
    previous.status === next.status &&
    previous.parentId === next.parentId &&
    sameNodeIdList(previous.childIds, next.childIds) &&
    previous.title === next.title &&
    previous.customTitle === next.customTitle &&
    previous.url === next.url &&
    previous.favIconUrl === next.favIconUrl &&
    previous.active === next.active &&
    previous.collapsed === next.collapsed &&
    previous.createdAt === next.createdAt &&
    previous.closedAt === next.closedAt &&
    previous.restoredFromClosed === next.restoredFromClosed &&
    liveRefsEqual(previous.live, next.live) &&
    restoreRefsEqual(previous.restore, next.restore);
}

export function liveRefsEqual(previous: OutlineNode["live"], next: OutlineNode["live"]): boolean {
  return previous?.tabId === next?.tabId && previous?.windowId === next?.windowId;
}

export function restoreRefsEqual(previous: OutlineNode["restore"], next: OutlineNode["restore"]): boolean {
  return previous?.sessionId === next?.sessionId &&
    previous?.url === next?.url &&
    previous?.title === next?.title &&
    previous?.favIconUrl === next?.favIconUrl;
}
