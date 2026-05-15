import type { BackgroundCommand } from "../background/commands.js";
import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";

export type DropMode = "before" | "inside" | "after";

export type NodeDropPlacement = {
  kind: "node";
  mode: DropMode;
  sourceId: NodeId;
  targetId: NodeId;
  index: number;
  parentId?: NodeId;
};

export type RootDropPlacement = {
  kind: "root";
  sourceId: NodeId;
};

export type DropPlacement = NodeDropPlacement | RootDropPlacement;

export function dropModeForPointer(relativeY: number, rowHeight: number): DropMode {
  if (relativeY < rowHeight / 3) {
    return "before";
  }
  if (relativeY > (rowHeight * 2) / 3) {
    return "after";
  }
  return "inside";
}

export function dropPlacementForNode(
  state: OutlineState,
  sourceId: NodeId,
  targetId: NodeId,
  mode: DropMode
): NodeDropPlacement | undefined {
  const source = state.nodes[sourceId];
  const target = state.nodes[targetId];
  if (!source || !target || sourceId === targetId || isDescendant(state, targetId, sourceId)) {
    return undefined;
  }

  if (mode === "inside") {
    return placementForTargetParent(state, source, target.id, target.childIds.length, mode, target.id);
  }

  const siblings = siblingsForTarget(state, target);
  const targetIndex = siblings.indexOf(target.id);
  if (targetIndex < 0) {
    return undefined;
  }

  return placementForTargetParent(
    state,
    source,
    target.parentId,
    targetIndex + (mode === "after" ? 1 : 0),
    mode,
    target.id
  );
}

export function dropPlacementForRoot(state: OutlineState, sourceId: NodeId): RootDropPlacement | undefined {
  const source = state.nodes[sourceId];
  if (source?.kind !== "tab") {
    return undefined;
  }

  return {
    kind: "root",
    sourceId
  };
}

export function commandForDropPlacement(placement: DropPlacement): BackgroundCommand {
  if (placement.kind === "root") {
    return {
      type: "moveNodeToNewWindow",
      nodeId: placement.sourceId
    };
  }

  return {
    type: "moveNode",
    nodeId: placement.sourceId,
    ...(placement.parentId ? { parentId: placement.parentId } : {}),
    index: placement.index
  };
}

function placementForTargetParent(
  state: OutlineState,
  source: OutlineNode,
  parentId: NodeId | undefined,
  rawIndex: number,
  mode: DropMode,
  targetId: NodeId
): NodeDropPlacement | undefined {
  const sourceSiblings = source.parentId ? state.nodes[source.parentId]?.childIds : state.rootIds;
  if (!sourceSiblings) {
    return undefined;
  }

  const sourceIndex = sourceSiblings.indexOf(source.id);
  const adjustedIndex = source.parentId === parentId && sourceIndex >= 0 && sourceIndex < rawIndex
    ? rawIndex - 1
    : rawIndex;

  return {
    kind: "node",
    mode,
    sourceId: source.id,
    targetId,
    ...(parentId ? { parentId } : {}),
    index: Math.max(0, adjustedIndex)
  };
}

function siblingsForTarget(state: OutlineState, target: OutlineNode): NodeId[] {
  return target.parentId ? state.nodes[target.parentId]?.childIds ?? [] : state.rootIds;
}

function isDescendant(state: OutlineState, candidateId: NodeId, ancestorId: NodeId): boolean {
  let current = state.nodes[candidateId];
  const visited = new Set<NodeId>();

  while (current?.parentId) {
    if (visited.has(current.id)) {
      return false;
    }
    visited.add(current.id);
    if (current.parentId === ancestorId) {
      return true;
    }
    current = state.nodes[current.parentId];
  }

  return false;
}
