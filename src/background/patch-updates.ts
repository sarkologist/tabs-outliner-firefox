import { isLiveTabNode } from "../model/live-nodes.js";
import { projectLiveTabs, runtimeTitleForOutlineTab } from "../model/outline.js";
import { buildOutlineLookup, type OutlineLookup } from "../model/outline-lookup.js";
import type {
  NodeId,
  OutlineNode,
  OutlineState,
  RuntimeTab,
  RuntimeWindow
} from "../model/types.js";
import type { BackgroundCommand } from "./commands.js";
import { addSubtreeNodeIds, uniqueDefinedNodeIds } from "./live-node-queries.js";
import { nodesMateriallyEqual, sameNodeIdList } from "./state-equality.js";

// Sidebar patch-update builders (tree-structure / node-state diffs) + snapshot-match check,
// extracted from controller.ts (no behavior change). Pure functions over OutlineState.

export type TreeStructureUpdate = {
  type: "treeStructureUpdated";
  deletedNodeIds: NodeId[];
  updatedNodes: OutlineNode[];
  rootIds: NodeId[];
  deletedClosedCount: number;
};

export type SameParentReorderUpdate = {
  type: "sameParentReorderUpdated";
  parentId: NodeId;
  movedNodeId: NodeId;
  fromIndex: number;
  toIndex: number;
  rootIds: NodeId[];
};

export type NodeStateUpdate = {
  type: "nodeStateUpdated";
  updatedNodes: OutlineNode[];
  closedCountDelta: number;
};

export type StateDiffMode = "identity" | "material";

export type RuntimeSnapshotMatch = {
  matches: boolean;
  lookup: OutlineLookup;
};

export function treeStructureUpdateFromStateChange(
  previous: OutlineState,
  next: OutlineState,
  options: { diffMode?: StateDiffMode } = {}
): TreeStructureUpdate {
  const diffMode = options.diffMode ?? "identity";
  const deletedNodeIds = Object.keys(previous.nodes).filter((nodeId) => !next.nodes[nodeId]);
  const updatedNodes: OutlineNode[] = [];
  for (const nodeId of Object.keys(next.nodes)) {
    const node = next.nodes[nodeId]!;
    const previousNode = previous.nodes[nodeId];
    if (!previousNode || nodeChangedForPatch(previousNode, node, diffMode)) {
      updatedNodes.push(node);
    }
  }
  const deletedClosedCount = deletedNodeIds.filter(
    (nodeId) => previous.nodes[nodeId]?.status === "closed"
  ).length;

  return {
    type: "treeStructureUpdated",
    deletedNodeIds,
    updatedNodes,
    rootIds: next.rootIds,
    deletedClosedCount
  };
}

export function sameParentReorderUpdateForMoveCommand(
  previous: OutlineState,
  next: OutlineState,
  command: Extract<BackgroundCommand, { type: "moveNode" }>
): SameParentReorderUpdate | undefined {
  if (!command.parentId || !sameNodeIdList(previous.rootIds, next.rootIds)) {
    return undefined;
  }

  const previousNode = previous.nodes[command.nodeId];
  const nextNode = next.nodes[command.nodeId];
  const previousParent = previous.nodes[command.parentId];
  const nextParent = next.nodes[command.parentId];
  if (
    !previousNode ||
    !nextNode ||
    !previousParent ||
    !nextParent ||
    previousNode.parentId !== command.parentId ||
    nextNode.parentId !== command.parentId ||
    previousParent.childIds.length !== nextParent.childIds.length ||
    !nodesMateriallyEqual(previousNode, nextNode)
  ) {
    return undefined;
  }

  const fromIndex = previousParent.childIds.indexOf(command.nodeId);
  const toIndex = nextParent.childIds.indexOf(command.nodeId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return undefined;
  }

  const expectedChildIds = [...previousParent.childIds];
  expectedChildIds.splice(fromIndex, 1);
  expectedChildIds.splice(toIndex, 0, command.nodeId);
  if (!sameNodeIdList(expectedChildIds, nextParent.childIds)) {
    return undefined;
  }

  return {
    type: "sameParentReorderUpdated",
    parentId: command.parentId,
    movedNodeId: command.nodeId,
    fromIndex,
    toIndex,
    rootIds: next.rootIds
  };
}

export function treeStructureUpdateFromCandidateNodeIds(
  previous: OutlineState,
  next: OutlineState,
  candidateNodeIds: readonly NodeId[],
  options: { diffMode?: StateDiffMode; includeUnchanged?: boolean } = {}
): TreeStructureUpdate {
  const diffMode = options.diffMode ?? "identity";
  const includeUnchanged = options.includeUnchanged ?? false;
  const uniqueCandidateNodeIds = uniqueDefinedNodeIds([...candidateNodeIds]);
  const deletedNodeIds = uniqueCandidateNodeIds.filter(
    (nodeId) => previous.nodes[nodeId] && !next.nodes[nodeId]
  );
  const updatedNodes: OutlineNode[] = [];
  for (const nodeId of uniqueCandidateNodeIds) {
    const node = next.nodes[nodeId];
    if (!node) {
      continue;
    }
    const previousNode = previous.nodes[nodeId];
    if (includeUnchanged || !previousNode || nodeChangedForPatch(previousNode, node, diffMode)) {
      updatedNodes.push(node);
    }
  }
  const deletedClosedCount = deletedNodeIds.filter(
    (nodeId) => previous.nodes[nodeId]?.status === "closed"
  ).length;

  return {
    type: "treeStructureUpdated",
    deletedNodeIds,
    updatedNodes,
    rootIds: next.rootIds,
    deletedClosedCount
  };
}

export function deleteTreeStructureCandidateNodeIds(
  previous: OutlineState,
  next: OutlineState,
  nodeId: NodeId
): NodeId[] {
  const candidateNodeIds = new Set<NodeId>();
  addSubtreeNodeIds(previous, nodeId, candidateNodeIds);

  let parentId = previous.nodes[nodeId]?.parentId;
  while (parentId) {
    candidateNodeIds.add(parentId);
    const previousParent = previous.nodes[parentId];
    const nextParent = next.nodes[parentId];
    if (!previousParent && !nextParent) {
      break;
    }
    parentId = previousParent?.parentId ?? nextParent?.parentId;
  }

  return [...candidateNodeIds];
}

export function isUsefulTreeStructureUpdate(
  update: TreeStructureUpdate,
  next: OutlineState
): boolean {
  const changedNodeCount = update.deletedNodeIds.length + update.updatedNodes.length;
  if (changedNodeCount === 0) {
    return false;
  }

  return changedNodeCount < Object.keys(next.nodes).length;
}

export function runtimeSnapshotMateriallyMatchesState(
  state: OutlineState,
  windows: RuntimeWindow[]
): RuntimeSnapshotMatch {
  const lookup = buildOutlineLookup(state);
  const normalWindows = windows.filter((windowInfo) => !windowInfo.incognito);
  if (lookup.liveWindowNodeIdsByRuntimeId.size !== normalWindows.length) {
    return { matches: false, lookup };
  }

  let runtimeTabCount = 0;
  for (const windowInfo of normalWindows) {
    const windowNodeId = lookup.liveWindowNodeIdsByRuntimeId.get(windowInfo.id);
    const windowNode = windowNodeId ? state.nodes[windowNodeId] : undefined;
    if (!windowNodeId || !windowNode || windowNode.active !== windowInfo.focused) {
      return { matches: false, lookup };
    }

    const tabs = [...(windowInfo.tabs ?? [])]
      .filter((tab) => !tab.incognito)
      .sort((left, right) => left.index - right.index);
    runtimeTabCount += tabs.length;

    const projectedTabs = projectLiveTabs(state, windowNodeId, lookup).filter(
      (tab) => tab.windowId === windowInfo.id
    );
    if (projectedTabs.length !== tabs.length) {
      return { matches: false, lookup };
    }

    for (let index = 0; index < tabs.length; index += 1) {
      const tab = tabs[index]!;
      const nodeId = lookup.liveTabNodeIdsByRuntimeId.get(tab.id);
      const node = nodeId ? state.nodes[nodeId] : undefined;
      if (
        !node ||
        !isLiveTabNode(node) ||
        node.live.windowId !== tab.windowId ||
        projectedTabs[index]?.tabId !== tab.id ||
        liveTabNodeWouldChange(node, tab)
      ) {
        return { matches: false, lookup };
      }
    }
  }

  return {
    matches: lookup.liveTabNodeIdsByRuntimeId.size === runtimeTabCount,
    lookup
  };
}

export function liveTabNodeWouldChange(
  node: OutlineNode & { live: { tabId: number; windowId: number } },
  tab: RuntimeTab
): boolean {
  const nextTitle = runtimeTitleForOutlineTab(node, tab);
  return (
    node.active !== tab.active ||
    (tab.url !== undefined && node.url !== tab.url) ||
    node.title !== nextTitle ||
    (tab.favIconUrl !== undefined && node.favIconUrl !== tab.favIconUrl)
  );
}

export function nodeStateUpdateFromStateChange(
  previous: OutlineState,
  next: OutlineState,
  options: { diffMode?: StateDiffMode } = {}
): NodeStateUpdate | undefined {
  const diffMode = options.diffMode ?? "identity";
  const nextNodeIds = Object.keys(next.nodes);
  if (
    !sameNodeIdList(previous.rootIds, next.rootIds) ||
    Object.keys(previous.nodes).length !== nextNodeIds.length
  ) {
    return undefined;
  }

  const updatedNodes: OutlineNode[] = [];
  let closedCountDelta = 0;
  for (const nodeId of nextNodeIds) {
    const previousNode = previous.nodes[nodeId];
    const node = next.nodes[nodeId]!;
    if (!previousNode) {
      return undefined;
    }
    if (!nodeChangedForPatch(previousNode, node, diffMode)) {
      continue;
    }
    if (
      previousNode.parentId !== node.parentId ||
      !sameNodeIdList(previousNode.childIds, node.childIds)
    ) {
      return undefined;
    }
    updatedNodes.push(node);
    const wasClosed = previousNode.status === "closed" ? 1 : 0;
    const isClosed = node.status === "closed" ? 1 : 0;
    closedCountDelta += isClosed - wasClosed;
  }

  return {
    type: "nodeStateUpdated",
    updatedNodes,
    closedCountDelta
  };
}

export function nodeStateUpdateForNodeIds(
  previous: OutlineState,
  next: OutlineState,
  nodeIds: readonly NodeId[],
  options: { diffMode?: StateDiffMode } = {}
): NodeStateUpdate | undefined {
  const diffMode = options.diffMode ?? "identity";
  if (!sameNodeIdList(previous.rootIds, next.rootIds)) {
    return undefined;
  }

  const updatedNodes: OutlineNode[] = [];
  let closedCountDelta = 0;
  for (const nodeId of nodeIds) {
    const previousNode = previous.nodes[nodeId];
    const node = next.nodes[nodeId];
    if (!previousNode || !node) {
      return undefined;
    }
    if (!nodeChangedForPatch(previousNode, node, diffMode)) {
      continue;
    }
    if (
      previousNode.parentId !== node.parentId ||
      !sameNodeIdList(previousNode.childIds, node.childIds)
    ) {
      return undefined;
    }
    updatedNodes.push(node);
    const wasClosed = previousNode.status === "closed" ? 1 : 0;
    const isClosed = node.status === "closed" ? 1 : 0;
    closedCountDelta += isClosed - wasClosed;
  }

  return {
    type: "nodeStateUpdated",
    updatedNodes,
    closedCountDelta
  };
}

export function nodeChangedForPatch(
  previous: OutlineNode,
  next: OutlineNode,
  diffMode: StateDiffMode
): boolean {
  return diffMode === "material" ? !nodesMateriallyEqual(previous, next) : previous !== next;
}
