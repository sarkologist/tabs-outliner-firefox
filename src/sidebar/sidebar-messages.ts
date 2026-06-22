import type { CommandAck } from "../background/commands.js";
import type { HistoryStatus } from "../background/history.js";
import type { InitialTreeSnapshot } from "../background/initial-tree-snapshot.js";
import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";

export type ActiveStateUpdate = {
  nodeId: NodeId;
  active: boolean;
};

export type TreeStructureUpdate = {
  type: "treeStructureUpdated";
  deletedNodeIds: NodeId[];
  updatedNodes: OutlineNode[];
  rootIds: NodeId[];
  deletedLiveTabCount: number;
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
  liveTabCountDelta: number;
};

export type ExportTreeResponse = {
  type: "exportTree";
  filename: string;
  contentType: string;
  content: string;
};

export function messageType(message: unknown): string {
  return message &&
    typeof message === "object" &&
    typeof (message as { type?: unknown }).type === "string"
    ? (message as { type: string }).type
    : isOutlineState(message)
      ? "OutlineState"
      : "unknown";
}

export function isStateUpdated(
  message: unknown
): message is { type: "stateUpdated"; state: OutlineState } {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "stateUpdated" &&
    (message as { state?: unknown }).state
  );
}

// Sent by the background when its startup reconcile (after a cold event-page wake) materially
// changed state -- i.e. tabs/windows changed while the worker was suspended and were absorbed
// silently without a structural broadcast. Open sidebars treat it as "you may be stale, re-sync".
export function isStateMayHaveChanged(
  message: unknown
): message is { type: "stateMayHaveChanged" } {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "stateMayHaveChanged"
  );
}

export function isInitialTreeSnapshot(message: unknown): message is InitialTreeSnapshot {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "initialTreeSnapshot" &&
    (message as { version?: unknown }).version === 1 &&
    isOutlineState((message as { state?: unknown }).state) &&
    typeof (message as { revision?: unknown }).revision === "number" &&
    typeof (message as { hydrating?: unknown }).hydrating === "boolean" &&
    (message as { projection?: unknown }).projection &&
    typeof (message as { projection?: unknown }).projection === "object" &&
    Array.isArray((message as { projection: { rows?: unknown } }).projection.rows) &&
    typeof (message as { projection: { totalRowCount?: unknown } }).projection.totalRowCount ===
      "number" &&
    Array.isArray(
      (message as { projection: { visibleNodeIds?: unknown } }).projection.visibleNodeIds
    ) &&
    Array.isArray(
      (message as { projection: { matchingNodeIds?: unknown } }).projection.matchingNodeIds
    )
  );
}

export function isActiveStateUpdated(
  message: unknown
): message is { type: "activeStateUpdated"; updates: ActiveStateUpdate[] } {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "activeStateUpdated" &&
    Array.isArray((message as { updates?: unknown }).updates) &&
    (message as { updates: unknown[] }).updates.every((update) =>
      Boolean(
        update &&
        typeof update === "object" &&
        typeof (update as { nodeId?: unknown }).nodeId === "string" &&
        typeof (update as { active?: unknown }).active === "boolean"
      )
    )
  );
}

export function isNodeStateUpdated(message: unknown): message is NodeStateUpdate {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "nodeStateUpdated" &&
    Array.isArray((message as { updatedNodes?: unknown }).updatedNodes) &&
    (message as { updatedNodes: unknown[] }).updatedNodes.every((node) =>
      Boolean(
        node &&
        typeof node === "object" &&
        typeof (node as { id?: unknown }).id === "string" &&
        Array.isArray((node as { childIds?: unknown }).childIds)
      )
    ) &&
    typeof (message as { liveTabCountDelta?: unknown }).liveTabCountDelta === "number"
  );
}

export function isTreeStructureUpdated(message: unknown): message is TreeStructureUpdate {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "treeStructureUpdated" &&
    Array.isArray((message as { deletedNodeIds?: unknown }).deletedNodeIds) &&
    (message as { deletedNodeIds: unknown[] }).deletedNodeIds.every(
      (nodeId) => typeof nodeId === "string"
    ) &&
    Array.isArray((message as { updatedNodes?: unknown }).updatedNodes) &&
    (message as { updatedNodes: unknown[] }).updatedNodes.every((node) =>
      Boolean(
        node &&
        typeof node === "object" &&
        typeof (node as { id?: unknown }).id === "string" &&
        Array.isArray((node as { childIds?: unknown }).childIds)
      )
    ) &&
    Array.isArray((message as { rootIds?: unknown }).rootIds) &&
    (message as { rootIds: unknown[] }).rootIds.every((nodeId) => typeof nodeId === "string") &&
    typeof (message as { deletedLiveTabCount?: unknown }).deletedLiveTabCount === "number"
  );
}

export function isSameParentReorderUpdated(message: unknown): message is SameParentReorderUpdate {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "sameParentReorderUpdated" &&
    typeof (message as { parentId?: unknown }).parentId === "string" &&
    typeof (message as { movedNodeId?: unknown }).movedNodeId === "string" &&
    typeof (message as { fromIndex?: unknown }).fromIndex === "number" &&
    typeof (message as { toIndex?: unknown }).toIndex === "number" &&
    Array.isArray((message as { rootIds?: unknown }).rootIds) &&
    (message as { rootIds: unknown[] }).rootIds.every((nodeId) => typeof nodeId === "string")
  );
}

export function isHistoryStatus(
  message: unknown
): message is { type: "historyStatus" } & HistoryStatus {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "historyStatus" &&
    typeof (message as { canUndo?: unknown }).canUndo === "boolean" &&
    typeof (message as { canRedo?: unknown }).canRedo === "boolean" &&
    typeof (message as { undoDepth?: unknown }).undoDepth === "number" &&
    typeof (message as { redoDepth?: unknown }).redoDepth === "number"
  );
}

export function isCommandAck(message: unknown): message is CommandAck {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "commandAck" &&
    typeof (message as { stateChanged?: unknown }).stateChanged === "boolean"
  );
}

export function isExportTreeResponse(message: unknown): message is ExportTreeResponse {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "exportTree" &&
    typeof (message as { filename?: unknown }).filename === "string" &&
    typeof (message as { contentType?: unknown }).contentType === "string" &&
    typeof (message as { content?: unknown }).content === "string"
  );
}

export function isOutlineState(message: unknown): message is OutlineState {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { version?: unknown }).version === 1 &&
    Array.isArray((message as { rootIds?: unknown }).rootIds) &&
    typeof (message as { nodes?: unknown }).nodes === "object" &&
    (message as { nodes?: unknown }).nodes !== null
  );
}
