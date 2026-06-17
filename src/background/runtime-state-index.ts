import { isLiveTabNode, isLiveWindowNode } from "../model/live-nodes.js";
import { runtimeTitleForOutlineTab } from "../model/outline.js";
import type { OutlineLookup } from "../model/outline-lookup.js";
import type { NodeId, OutlineNode, OutlineState, RuntimeTab } from "../model/types.js";
import type { BackgroundCommand } from "./commands.js";
import { addSubtreeNodeIds } from "./live-node-queries.js";

// Runtime state index — a derived runtime-id -> outline-node lookup cache plus command
// candidate-node computation. Extracted from controller.ts (no behavior change): pure
// functions over OutlineState and this index structure; no closure or controller state.

export type RuntimeStateIndex = {
  state: OutlineState;
  liveTabNodeIdsByRuntimeId: Map<number, NodeId>;
  liveWindowNodeIdsByRuntimeId: Map<number, NodeId>;
  liveTabNodeIdsByWindowId: Map<number, Set<NodeId>>;
  activeTabNodeIdsByWindowId: Map<number, NodeId>;
  closedRestoreCandidateCountsByWindowNodeId: Map<NodeId, number>;
  windowNodeIdsWithClosedRestoreCandidates: Set<NodeId>;
  activeWindowNodeId?: NodeId;
};

export function buildRuntimeStateIndex(state: OutlineState): RuntimeStateIndex {
  const index: RuntimeStateIndex = {
    state,
    liveTabNodeIdsByRuntimeId: new Map(),
    liveWindowNodeIdsByRuntimeId: new Map(),
    liveTabNodeIdsByWindowId: new Map(),
    activeTabNodeIdsByWindowId: new Map(),
    closedRestoreCandidateCountsByWindowNodeId: new Map(),
    windowNodeIdsWithClosedRestoreCandidates: new Set()
  };

  for (const node of Object.values(state.nodes)) {
    if (isLiveWindowNode(node)) {
      index.liveWindowNodeIdsByRuntimeId.set(node.live.windowId, node.id);
      if (node.active) {
        index.activeWindowNodeId = node.id;
      }
      continue;
    }

    if (isLiveTabNode(node)) {
      index.liveTabNodeIdsByRuntimeId.set(node.live.tabId, node.id);
      const windowTabNodeIds = index.liveTabNodeIdsByWindowId.get(node.live.windowId) ?? new Set<NodeId>();
      windowTabNodeIds.add(node.id);
      index.liveTabNodeIdsByWindowId.set(node.live.windowId, windowTabNodeIds);
      if (node.active) {
        index.activeTabNodeIdsByWindowId.set(node.live.windowId, node.id);
      }
    }
  }

  const visited = new Set<NodeId>();
  const stack: Array<{ nodeId: NodeId; ownerWindowNodeId?: NodeId }> = state.rootIds.map((nodeId) => ({ nodeId }));
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
    if (ownerWindowNodeId && node.id !== ownerWindowNodeId && node.kind === "tab" && node.status === "closed") {
      const count = index.closedRestoreCandidateCountsByWindowNodeId.get(ownerWindowNodeId) ?? 0;
      index.closedRestoreCandidateCountsByWindowNodeId.set(ownerWindowNodeId, count + 1);
      index.windowNodeIdsWithClosedRestoreCandidates.add(ownerWindowNodeId);
    }

    for (const childId of node.childIds) {
      stack.push({
        nodeId: childId,
        ...(ownerWindowNodeId ? { ownerWindowNodeId } : {})
      });
    }
  }

  return index;
}

export function buildRuntimeStateIndexFromLookup(state: OutlineState, lookup: OutlineLookup): RuntimeStateIndex {
  const index: RuntimeStateIndex = {
    state,
    liveTabNodeIdsByRuntimeId: new Map(),
    liveWindowNodeIdsByRuntimeId: new Map(),
    liveTabNodeIdsByWindowId: new Map(),
    activeTabNodeIdsByWindowId: new Map(),
    closedRestoreCandidateCountsByWindowNodeId: new Map(),
    windowNodeIdsWithClosedRestoreCandidates: new Set()
  };

  for (const [runtimeWindowId, nodeId] of lookup.liveWindowNodeIdsByRuntimeId) {
    const node = state.nodes[nodeId];
    if (!isLiveWindowNode(node)) {
      continue;
    }
    index.liveWindowNodeIdsByRuntimeId.set(runtimeWindowId, nodeId);
    if (node.active) {
      index.activeWindowNodeId = nodeId;
    }
  }

  for (const [runtimeTabId, nodeId] of lookup.liveTabNodeIdsByRuntimeId) {
    const node = state.nodes[nodeId];
    if (!isLiveTabNode(node)) {
      continue;
    }
    index.liveTabNodeIdsByRuntimeId.set(runtimeTabId, nodeId);
    const windowTabNodeIds = index.liveTabNodeIdsByWindowId.get(node.live.windowId) ?? new Set<NodeId>();
    windowTabNodeIds.add(nodeId);
    index.liveTabNodeIdsByWindowId.set(node.live.windowId, windowTabNodeIds);
    if (node.active) {
      index.activeTabNodeIdsByWindowId.set(node.live.windowId, nodeId);
    }
  }

  index.closedRestoreCandidateCountsByWindowNodeId = new Map(lookup.closedRestoreCandidateCountsByWindowNodeId);
  index.windowNodeIdsWithClosedRestoreCandidates = new Set(lookup.windowNodeIdsWithClosedRestoreCandidates);

  return index;
}

export function runtimeIndexForStateTransition(
  previous: OutlineState,
  next: OutlineState,
  index: RuntimeStateIndex | undefined,
  candidateNodeIds?: readonly NodeId[]
): RuntimeStateIndex {
  if (!index || index.state !== previous || !candidateNodeIds) {
    return buildRuntimeStateIndex(next);
  }

  const candidates = new Set(candidateNodeIds);
  if (index.activeWindowNodeId) {
    candidates.add(index.activeWindowNodeId);
  }
  for (const activeTabNodeId of index.activeTabNodeIdsByWindowId.values()) {
    candidates.add(activeTabNodeId);
  }

  for (const nodeId of candidates) {
    const previousNode = previous.nodes[nodeId];
    if (previousNode) {
      updateRuntimeIndexClosedRestoreCandidateCount(index, previous, previousNode, -1);
      removeRuntimeIndexNode(index, previousNode);
    }
  }
  for (const nodeId of candidates) {
    const nextNode = next.nodes[nodeId];
    if (nextNode) {
      updateRuntimeIndexClosedRestoreCandidateCount(index, next, nextNode, 1);
      addRuntimeIndexNode(index, nextNode);
    }
  }
  pruneRuntimeIndexWindowTabSets(index, next);
  pruneRuntimeIndexClosedRestoreCandidates(index, next);
  index.state = next;
  return index;
}

export function pruneRuntimeIndexWindowTabSets(index: RuntimeStateIndex, state: OutlineState): void {
  for (const [windowId, nodeIds] of index.liveTabNodeIdsByWindowId) {
    const windowNodeId = index.liveWindowNodeIdsByRuntimeId.get(windowId);
    const windowNode = windowNodeId ? state.nodes[windowNodeId] : undefined;
    if (nodeIds.size === 0 || !isLiveWindowNode(windowNode)) {
      index.liveTabNodeIdsByWindowId.delete(windowId);
    }
  }
}

export function runtimeStateIndexMismatchReason(actual: RuntimeStateIndex, expected: RuntimeStateIndex): string | undefined {
  return mapMismatchReason(
    actual.liveTabNodeIdsByRuntimeId,
    expected.liveTabNodeIdsByRuntimeId,
    "liveTabNodeIdsByRuntimeId"
  ) ??
    mapMismatchReason(
      actual.liveWindowNodeIdsByRuntimeId,
      expected.liveWindowNodeIdsByRuntimeId,
      "liveWindowNodeIdsByRuntimeId"
    ) ??
    setMapMismatchReason(
      actual.liveTabNodeIdsByWindowId,
      expected.liveTabNodeIdsByWindowId,
      "liveTabNodeIdsByWindowId"
    ) ??
    mapMismatchReason(
      actual.activeTabNodeIdsByWindowId,
      expected.activeTabNodeIdsByWindowId,
      "activeTabNodeIdsByWindowId"
    ) ??
    mapMismatchReason(
      actual.closedRestoreCandidateCountsByWindowNodeId,
      expected.closedRestoreCandidateCountsByWindowNodeId,
      "closedRestoreCandidateCountsByWindowNodeId"
    ) ??
    setMismatchReason(
      actual.windowNodeIdsWithClosedRestoreCandidates,
      expected.windowNodeIdsWithClosedRestoreCandidates,
      "windowNodeIdsWithClosedRestoreCandidates"
    ) ??
    (actual.activeWindowNodeId === expected.activeWindowNodeId
      ? undefined
      : `activeWindowNodeId expected ${expected.activeWindowNodeId ?? "none"} got ${actual.activeWindowNodeId ?? "none"}`);
}

export function mapMismatchReason<K, V>(actual: Map<K, V>, expected: Map<K, V>, label: string): string | undefined {
  if (actual.size !== expected.size) {
    return `${label} size expected ${expected.size} got ${actual.size}`;
  }
  for (const [key, expectedValue] of expected) {
    if (actual.get(key) !== expectedValue) {
      return `${label} mismatch for ${String(key)}`;
    }
  }
  return undefined;
}

export function setMapMismatchReason<K, V>(
  actual: Map<K, Set<V>>,
  expected: Map<K, Set<V>>,
  label: string
): string | undefined {
  if (actual.size !== expected.size) {
    return `${label} size expected ${expected.size} got ${actual.size}`;
  }
  for (const [key, expectedSet] of expected) {
    const actualSet = actual.get(key);
    if (!actualSet) {
      return `${label} missing ${String(key)}`;
    }
    const reason = setMismatchReason(actualSet, expectedSet, `${label}.${String(key)}`);
    if (reason) {
      return reason;
    }
  }
  return undefined;
}

export function setMismatchReason<V>(actual: Set<V>, expected: Set<V>, label: string): string | undefined {
  if (actual.size !== expected.size) {
    return `${label} size expected ${expected.size} got ${actual.size}`;
  }
  for (const value of expected) {
    if (!actual.has(value)) {
      return `${label} missing ${String(value)}`;
    }
  }
  return undefined;
}

export function removeRuntimeIndexNode(index: RuntimeStateIndex, node: OutlineNode): void {
  if (isLiveWindowNode(node)) {
    if (index.liveWindowNodeIdsByRuntimeId.get(node.live.windowId) === node.id) {
      index.liveWindowNodeIdsByRuntimeId.delete(node.live.windowId);
    }
    if (index.activeWindowNodeId === node.id) {
      delete index.activeWindowNodeId;
    }
    return;
  }

  if (!isLiveTabNode(node)) {
    return;
  }

  if (index.liveTabNodeIdsByRuntimeId.get(node.live.tabId) === node.id) {
    index.liveTabNodeIdsByRuntimeId.delete(node.live.tabId);
  }
  const windowTabNodeIds = index.liveTabNodeIdsByWindowId.get(node.live.windowId);
  windowTabNodeIds?.delete(node.id);
  if (windowTabNodeIds?.size === 0) {
    index.liveTabNodeIdsByWindowId.delete(node.live.windowId);
  }
  if (index.activeTabNodeIdsByWindowId.get(node.live.windowId) === node.id) {
    index.activeTabNodeIdsByWindowId.delete(node.live.windowId);
  }
}

export function addRuntimeIndexNode(index: RuntimeStateIndex, node: OutlineNode): void {
  if (isLiveWindowNode(node)) {
    index.liveWindowNodeIdsByRuntimeId.set(node.live.windowId, node.id);
    index.liveTabNodeIdsByWindowId.set(
      node.live.windowId,
      index.liveTabNodeIdsByWindowId.get(node.live.windowId) ?? new Set()
    );
    if (node.active) {
      index.activeWindowNodeId = node.id;
    }
    return;
  }

  if (!isLiveTabNode(node)) {
    return;
  }

  index.liveTabNodeIdsByRuntimeId.set(node.live.tabId, node.id);
  const windowTabNodeIds = index.liveTabNodeIdsByWindowId.get(node.live.windowId) ?? new Set<NodeId>();
  windowTabNodeIds.add(node.id);
  index.liveTabNodeIdsByWindowId.set(node.live.windowId, windowTabNodeIds);
  if (node.active) {
    index.activeTabNodeIdsByWindowId.set(node.live.windowId, node.id);
  }
}

export function updateRuntimeIndexClosedRestoreCandidateCount(
  index: RuntimeStateIndex,
  state: OutlineState,
  node: OutlineNode,
  delta: 1 | -1
): void {
  if (node.kind !== "tab" || node.status !== "closed") {
    return;
  }

  const windowNodeId = nearestWindowNodeId(state, node.id);
  if (!windowNodeId) {
    return;
  }

  const count = (index.closedRestoreCandidateCountsByWindowNodeId.get(windowNodeId) ?? 0) + delta;
  if (count > 0) {
    index.closedRestoreCandidateCountsByWindowNodeId.set(windowNodeId, count);
    index.windowNodeIdsWithClosedRestoreCandidates.add(windowNodeId);
    return;
  }

  index.closedRestoreCandidateCountsByWindowNodeId.delete(windowNodeId);
  index.windowNodeIdsWithClosedRestoreCandidates.delete(windowNodeId);
}

export function pruneRuntimeIndexClosedRestoreCandidates(index: RuntimeStateIndex, state: OutlineState): void {
  for (const windowNodeId of index.windowNodeIdsWithClosedRestoreCandidates) {
    const windowNode = state.nodes[windowNodeId];
    if (!windowNode || windowNode.kind !== "window") {
      index.closedRestoreCandidateCountsByWindowNodeId.delete(windowNodeId);
      index.windowNodeIdsWithClosedRestoreCandidates.delete(windowNodeId);
    }
  }
}

export function nearestWindowNodeId(state: OutlineState, nodeId: NodeId): NodeId | undefined {
  const visited = new Set<NodeId>();
  let current = state.nodes[nodeId];
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.kind === "window") {
      return current.id;
    }
    current = current.parentId ? state.nodes[current.parentId] : undefined;
  }
  return undefined;
}

export function runtimeIndexCandidateNodeIdsForCommand(
  command: BackgroundCommand,
  previous: OutlineState,
  next: OutlineState,
  options: {
    expandAncestorNodeIds?: readonly NodeId[];
    restorePatchNodeIds?: readonly NodeId[];
  } = {}
): NodeId[] | undefined {
  switch (command.type) {
    case "restoreNode":
      return collectRuntimeIndexCandidateNodeIds(previous, next, options.restorePatchNodeIds ?? [command.nodeId], {
        includeSeedSubtrees: false
      });

    case "moveNode":
    case "moveNodeToNewWindow":
    case "wrapNodeInGroup":
    case "moveSubtreeToTopLevel":
    case "moveSubtreeToBottomTopLevel":
    case "flattenSubtree":
    case "promoteChildren":
    case "closeNode":
    case "deleteNode":
      return collectRuntimeIndexCandidateNodeIds(previous, next, [command.nodeId]);

    case "toggleCollapsed":
    case "renameGroup":
      return collectRuntimeIndexCandidateNodeIds(previous, next, [command.nodeId], { includeSeedSubtrees: false });

    case "expandAncestors":
      return collectRuntimeIndexCandidateNodeIds(previous, next, options.expandAncestorNodeIds ?? [], {
        includeSeedSubtrees: false
      });

    case "importTree":
    case "importSubtreeToTopLevel":
      return undefined;

    case "getState":
    case "focusNode":
    case "analyzeRestoreScope":
    case "undo":
    case "redo":
    case "getHistoryStatus":
    case "refresh":
      // These commands seed no runtime-index candidates: they touch no structural node that
      // reconciliation must re-key (read-only state, history navigation, or a plain refresh).
      return [];

    default:
      // Exhaustiveness guard: a newly-added BackgroundCommand type that is not classified
      // above makes `command` non-`never` here and fails `satisfies never` at compile time,
      // forcing an explicit decision instead of silently falling through to the [] fallback.
      command satisfies never;
      return [];
  }
}

export function runtimeIndexCandidateNodeIdsForTabRemoval(
  previous: OutlineState,
  next: OutlineState,
  index: RuntimeStateIndex,
  tabId: number
): NodeId[] {
  const nodeId = index.liveTabNodeIdsByRuntimeId.get(tabId) ?? tabNodeIdForRuntime(tabId);
  return collectRuntimeIndexCandidateNodeIds(previous, next, [nodeId]);
}

export function runtimeIndexCandidateNodeIdsForWindowRemoval(
  previous: OutlineState,
  next: OutlineState,
  index: RuntimeStateIndex,
  windowId: number
): NodeId[] {
  const nodeId = index.liveWindowNodeIdsByRuntimeId.get(windowId) ?? windowNodeIdForRuntime(windowId);
  return collectRuntimeIndexCandidateNodeIds(previous, next, [nodeId]);
}

export function collectRuntimeIndexCandidateNodeIds(
  previous: OutlineState,
  next: OutlineState,
  seedNodeIds: readonly NodeId[],
  options: { includeSeedSubtrees?: boolean } = {}
): NodeId[] {
  const includeSeedSubtrees = options.includeSeedSubtrees ?? true;
  const candidateNodeIds = new Set<NodeId>();
  const relatedNodeIds = new Set<NodeId>();
  const addNode = (nodeId: NodeId | undefined): void => {
    if (nodeId) {
      candidateNodeIds.add(nodeId);
    }
  };
  const addRelatedNode = (nodeId: NodeId | undefined): void => {
    if (nodeId) {
      relatedNodeIds.add(nodeId);
    }
  };

  for (const seedNodeId of seedNodeIds) {
    if (includeSeedSubtrees) {
      addSubtreeNodeIds(previous, seedNodeId, candidateNodeIds);
      addSubtreeNodeIds(next, seedNodeId, candidateNodeIds);
    } else {
      addNode(seedNodeId);
    }
  }

  for (const nodeId of [...candidateNodeIds]) {
    const previousNode = previous.nodes[nodeId];
    const nextNode = next.nodes[nodeId];
    addRelatedNode(previousNode?.parentId);
    addRelatedNode(nextNode?.parentId);
  }

  for (const nodeId of relatedNodeIds) {
    addNode(nodeId);
    addNode(previous.nodes[nodeId]?.parentId);
    addNode(next.nodes[nodeId]?.parentId);
  }

  return [...candidateNodeIds];
}

export function indexedLiveTabNodeByRuntimeId(
  state: OutlineState,
  index: RuntimeStateIndex,
  tabId: number
): (OutlineNode & { live: { tabId: number; windowId: number } }) | undefined {
  const nodeId = index.liveTabNodeIdsByRuntimeId.get(tabId);
  const node = nodeId ? state.nodes[nodeId] : undefined;
  return isLiveTabNode(node) && node.live.tabId === tabId ? node : undefined;
}

export function runtimeTabNodeForFastPath(tab: RuntimeTab, nodeId: NodeId, parentId: NodeId, now: number): OutlineNode {
  const node: OutlineNode = {
    id: nodeId,
    kind: "tab",
    status: "live",
    parentId,
    childIds: [],
    title: tab.title || tab.url || "Untitled tab",
    active: tab.active,
    collapsed: false,
    createdAt: now,
    updatedAt: now,
    live: { tabId: tab.id, windowId: tab.windowId }
  };

  if (tab.url) {
    node.url = tab.url;
  }
  if (tab.favIconUrl) {
    node.favIconUrl = tab.favIconUrl;
  }

  return node;
}

export function updateRuntimeTabNodeForFastPath(node: OutlineNode, tab: RuntimeTab, now: number): void {
  node.status = "live";
  node.title = runtimeTitleForOutlineTab(node, tab);
  node.active = tab.active;
  node.updatedAt = now;
  node.live = { tabId: tab.id, windowId: tab.windowId };
  if (tab.url !== undefined) {
    node.url = tab.url;
  }
  if (tab.favIconUrl !== undefined) {
    node.favIconUrl = tab.favIconUrl;
  }
  delete node.closedAt;
  delete node.restore;
}

export function tabNodeIdForRuntime(tabId: number): NodeId {
  return `tab:${tabId}`;
}

export function windowNodeIdForRuntime(windowId: number): NodeId {
  return `window:${windowId}`;
}

export function canonicalWindowIdFromNodeId(nodeId: NodeId): number | undefined {
  const match = /^window:(\d+)$/.exec(nodeId);
  return match ? Number(match[1]) : undefined;
}

