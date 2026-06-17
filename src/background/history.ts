import { cloneOutlineNode } from "../model/outline.js";
import type { BackgroundCommand } from "./commands.js";
import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import { DEFAULT_UNDO_HISTORY_LIMIT, normalizeUndoHistoryLimit } from "../preferences.js";

export const DEFAULT_HISTORY_LIMIT = DEFAULT_UNDO_HISTORY_LIMIT;

// Single source of truth for which command types produce an undo/redo history entry.
// `as const satisfies Record<BackgroundCommand["type"], boolean>` makes adding a command a
// COMPILE error here until it is classified, and the union type, the runtime guard, and the
// `historyLabel` switch are all derived from this one table — so they can no longer drift
// apart silently (previously a hand-kept union plus two duplicated OR-chain predicates).
const TRACKABLE_HISTORY_COMMAND_TYPES = {
  getState: false,
  focusNode: false,
  closeNode: false,
  restoreNode: false,
  analyzeRestoreScope: false,
  deleteNode: true,
  moveNode: true,
  moveNodeToNewWindow: true,
  wrapNodeInGroup: true,
  moveSubtreeToTopLevel: true,
  moveSubtreeToBottomTopLevel: true,
  flattenSubtree: true,
  promoteChildren: true,
  toggleCollapsed: true,
  expandAncestors: true,
  renameGroup: true,
  importTree: true,
  undo: false,
  redo: false,
  getHistoryStatus: false,
  refresh: false
} as const satisfies Record<BackgroundCommand["type"], boolean>;

export type TrackableHistoryCommandType = {
  [K in keyof typeof TRACKABLE_HISTORY_COMMAND_TYPES]: (typeof TRACKABLE_HISTORY_COMMAND_TYPES)[K] extends true
    ? K
    : never;
}[keyof typeof TRACKABLE_HISTORY_COMMAND_TYPES];

const TRACKABLE_HISTORY_COMMAND_TYPE_SET: ReadonlySet<string> = new Set(
  Object.entries(TRACKABLE_HISTORY_COMMAND_TYPES)
    .filter(([, tracked]) => tracked)
    .map(([type]) => type)
);

export type OutlineDelta = {
  rootIds: NodeId[];
  updatedNodes: OutlineNode[];
  deletedNodeIds: NodeId[];
};

export type HistoryEntry = {
  version: 1;
  // Ties the entry to the outline-journal record of its command (historyEntryId), letting
  // startup replay rebuild missing entries idempotently. Absent on entries persisted
  // before the id existed; those simply never match a journal record.
  id?: string;
  commandType: TrackableHistoryCommandType;
  label: string;
  undo: OutlineDelta;
  redo: OutlineDelta;
};

export type HistoryState = {
  version: 1;
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
};

export type HistoryStatus = {
  canUndo: boolean;
  canRedo: boolean;
  undoDepth: number;
  redoDepth: number;
  undoLabel?: string;
  redoLabel?: string;
};

type HistoryDiffMode = "identity" | "material";

export function createEmptyHistoryState(): HistoryState {
  return {
    version: 1,
    undoStack: [],
    redoStack: []
  };
}

export function createHistoryEntry(
  commandType: TrackableHistoryCommandType,
  previous: OutlineState,
  next: OutlineState,
  options: { candidateNodeIds?: readonly NodeId[]; diffMode?: HistoryDiffMode; id?: string } = {}
): HistoryEntry | undefined {
  const diffMode = options.diffMode ?? "identity";
  const redo = deltaBetween(previous, next, diffMode, options.candidateNodeIds);
  if (!deltaHasChanges(redo, previous)) {
    return undefined;
  }

  return {
    version: 1,
    id: options.id ?? newHistoryEntryId(),
    commandType,
    label: historyLabel(commandType),
    undo: deltaBetween(next, previous, diffMode, options.candidateNodeIds),
    redo
  };
}

export function newHistoryEntryId(): string {
  return globalThis.crypto.randomUUID();
}

export function historyContainsEntryId(history: HistoryState, id: string): boolean {
  return history.undoStack.some((entry) => entry.id === id) ||
    history.redoStack.some((entry) => entry.id === id);
}

export function pushUndoEntry(
  history: HistoryState,
  entry: HistoryEntry,
  limit = DEFAULT_HISTORY_LIMIT
): HistoryState {
  const historyLimit = normalizeUndoHistoryLimit(limit);
  return {
    version: 1,
    undoStack: [...history.undoStack, entry].slice(-historyLimit),
    redoStack: []
  };
}

export function pushRedoEntry(
  history: HistoryState,
  entry: HistoryEntry,
  limit = DEFAULT_HISTORY_LIMIT
): HistoryState {
  const historyLimit = normalizeUndoHistoryLimit(limit);
  return {
    version: 1,
    undoStack: history.undoStack,
    redoStack: [...history.redoStack, entry].slice(-historyLimit)
  };
}

export function pushUndoEntryPreservingRedo(
  history: HistoryState,
  entry: HistoryEntry,
  limit = DEFAULT_HISTORY_LIMIT
): HistoryState {
  const historyLimit = normalizeUndoHistoryLimit(limit);
  return {
    version: 1,
    undoStack: [...history.undoStack, entry].slice(-historyLimit),
    redoStack: history.redoStack
  };
}

export function popUndoEntry(history: HistoryState): { entry?: HistoryEntry; history: HistoryState } {
  const entry = history.undoStack.at(-1);
  return {
    ...(entry ? { entry } : {}),
    history: {
      version: 1,
      undoStack: history.undoStack.slice(0, -1),
      redoStack: history.redoStack
    }
  };
}

export function popRedoEntry(history: HistoryState): { entry?: HistoryEntry; history: HistoryState } {
  const entry = history.redoStack.at(-1);
  return {
    ...(entry ? { entry } : {}),
    history: {
      version: 1,
      undoStack: history.undoStack,
      redoStack: history.redoStack.slice(0, -1)
    }
  };
}

export function historyStatus(history: HistoryState): HistoryStatus {
  const undoEntry = history.undoStack.at(-1);
  const redoEntry = history.redoStack.at(-1);
  return {
    canUndo: Boolean(undoEntry),
    canRedo: Boolean(redoEntry),
    undoDepth: history.undoStack.length,
    redoDepth: history.redoStack.length,
    ...(undoEntry ? { undoLabel: undoEntry.label } : {}),
    ...(redoEntry ? { redoLabel: redoEntry.label } : {})
  };
}

export function normalizeHistoryState(value: unknown, limit = DEFAULT_HISTORY_LIMIT): HistoryState {
  if (!isHistoryState(value)) {
    return createEmptyHistoryState();
  }

  const historyLimit = normalizeUndoHistoryLimit(limit);
  return {
    version: 1,
    undoStack: value.undoStack.slice(-historyLimit).map(cloneHistoryEntry),
    redoStack: value.redoStack.slice(-historyLimit).map(cloneHistoryEntry)
  };
}

export function applyOutlineDelta(state: OutlineState, delta: OutlineDelta): OutlineState {
  const next: OutlineState = {
    version: state.version,
    rootIds: [...delta.rootIds],
    nodes: { ...state.nodes }
  };

  for (const nodeId of delta.deletedNodeIds) {
    delete next.nodes[nodeId];
  }
  for (const node of delta.updatedNodes) {
    next.nodes[node.id] = cloneOutlineNode(node);
  }

  return next;
}

// Material diff for callers outside history (e.g. the v4 journal). Narrowed to
// candidateNodeIds when provided (O(candidates)); a full O(n) diff otherwise.
export function outlineMaterialDelta(
  previous: OutlineState,
  next: OutlineState,
  candidateNodeIds?: readonly NodeId[]
): OutlineDelta {
  return deltaBetween(previous, next, "material", candidateNodeIds);
}

function deltaBetween(
  previous: OutlineState,
  next: OutlineState,
  diffMode: HistoryDiffMode,
  candidateNodeIds?: readonly NodeId[]
): OutlineDelta {
  const previousNodeIds = candidateNodeIds ? uniqueNodeIds(candidateNodeIds) : Object.keys(previous.nodes);
  const nextNodeIds = candidateNodeIds ? uniqueNodeIds(candidateNodeIds) : Object.keys(next.nodes);
  const deletedNodeIds = previousNodeIds.filter((nodeId) => previous.nodes[nodeId] && !next.nodes[nodeId]);
  const updatedNodes: OutlineNode[] = [];

  for (const nodeId of nextNodeIds) {
    const nextNode = next.nodes[nodeId];
    if (!nextNode) {
      continue;
    }
    const previousNode = previous.nodes[nodeId];
    if (!previousNode || nodeChanged(previousNode, nextNode, diffMode)) {
      updatedNodes.push(cloneOutlineNode(nextNode));
    }
  }

  return {
    rootIds: [...next.rootIds],
    updatedNodes,
    deletedNodeIds
  };
}

function uniqueNodeIds(nodeIds: readonly NodeId[]): NodeId[] {
  return [...new Set(nodeIds.filter((nodeId) => nodeId))];
}

function nodeChanged(previous: OutlineNode, next: OutlineNode, diffMode: HistoryDiffMode): boolean {
  return diffMode === "material" ? !nodesMateriallyEqual(previous, next) : previous !== next;
}

function deltaHasChanges(delta: OutlineDelta, previous: OutlineState): boolean {
  return delta.deletedNodeIds.length > 0 ||
    delta.updatedNodes.length > 0 ||
    !sameNodeIdList(delta.rootIds, previous.rootIds);
}

function historyLabel(commandType: TrackableHistoryCommandType): string {
  switch (commandType) {
    case "moveNode":
    case "moveNodeToNewWindow":
      return "Move";
    case "wrapNodeInGroup":
      return "Group";
    case "moveSubtreeToTopLevel":
      return "Move to top level";
    case "moveSubtreeToBottomTopLevel":
      return "Move to bottom";
    case "flattenSubtree":
      return "Flatten";
    case "promoteChildren":
      return "Promote children";
    case "toggleCollapsed":
      return "Collapse";
    case "expandAncestors":
      return "Expand";
    case "renameGroup":
      return "Rename";
    case "importTree":
      return "Import";
    case "deleteNode":
      return "Delete";
  }
}

function isHistoryState(value: unknown): value is HistoryState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<HistoryState>;
  return candidate.version === 1 &&
    Array.isArray(candidate.undoStack) &&
    Array.isArray(candidate.redoStack) &&
    candidate.undoStack.every(isHistoryEntry) &&
    candidate.redoStack.every(isHistoryEntry);
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<HistoryEntry>;
  return candidate.version === 1 &&
    (candidate.id === undefined || typeof candidate.id === "string") &&
    isTrackableHistoryCommandType(candidate.commandType) &&
    typeof candidate.label === "string" &&
    isOutlineDelta(candidate.undo) &&
    isOutlineDelta(candidate.redo);
}

export function isTrackableHistoryCommandType(value: unknown): value is TrackableHistoryCommandType {
  return typeof value === "string" && TRACKABLE_HISTORY_COMMAND_TYPE_SET.has(value);
}

function isOutlineDelta(value: unknown): value is OutlineDelta {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<OutlineDelta>;
  return Array.isArray(candidate.rootIds) &&
    candidate.rootIds.every((nodeId) => typeof nodeId === "string") &&
    Array.isArray(candidate.updatedNodes) &&
    candidate.updatedNodes.every(isOutlineNode) &&
    Array.isArray(candidate.deletedNodeIds) &&
    candidate.deletedNodeIds.every((nodeId) => typeof nodeId === "string");
}

function isOutlineNode(value: unknown): value is OutlineNode {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { id?: unknown }).id === "string" &&
      typeof (value as { kind?: unknown }).kind === "string" &&
      typeof (value as { status?: unknown }).status === "string" &&
      Array.isArray((value as { childIds?: unknown }).childIds) &&
      typeof (value as { title?: unknown }).title === "string" &&
      typeof (value as { collapsed?: unknown }).collapsed === "boolean" &&
      typeof (value as { createdAt?: unknown }).createdAt === "number" &&
      typeof (value as { updatedAt?: unknown }).updatedAt === "number"
  );
}

function cloneHistoryEntry(entry: HistoryEntry): HistoryEntry {
  return {
    version: 1,
    ...(entry.id !== undefined ? { id: entry.id } : {}),
    commandType: entry.commandType,
    label: entry.label,
    undo: cloneDelta(entry.undo),
    redo: cloneDelta(entry.redo)
  };
}

function cloneDelta(delta: OutlineDelta): OutlineDelta {
  return {
    rootIds: [...delta.rootIds],
    updatedNodes: delta.updatedNodes.map(cloneOutlineNode),
    deletedNodeIds: [...delta.deletedNodeIds]
  };
}

function nodesMateriallyEqual(previous: OutlineNode, next: OutlineNode): boolean {
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
    previous.updatedAt === next.updatedAt &&
    previous.closedAt === next.closedAt &&
    previous.restoredFromClosed === next.restoredFromClosed &&
    liveRefsEqual(previous.live, next.live) &&
    restoreRefsEqual(previous.restore, next.restore);
}

function liveRefsEqual(previous: OutlineNode["live"], next: OutlineNode["live"]): boolean {
  return previous?.tabId === next?.tabId && previous?.windowId === next?.windowId;
}

function restoreRefsEqual(previous: OutlineNode["restore"], next: OutlineNode["restore"]): boolean {
  return previous?.sessionId === next?.sessionId &&
    previous?.url === next?.url &&
    previous?.title === next?.title &&
    previous?.favIconUrl === next?.favIconUrl;
}

function sameNodeIdList(previous: readonly NodeId[], next: readonly NodeId[]): boolean {
  return previous.length === next.length && previous.every((nodeId, index) => nodeId === next[index]);
}
