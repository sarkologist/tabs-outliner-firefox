import type { BackgroundCommand } from "../background/commands.js";
import type { NodeId, OutlineState } from "../model/types.js";
import { DEFAULT_APP_PREFERENCES, shortcutMatchesEvent, type SidebarShortcutAction, type ShortcutPreference } from "../preferences.js";
import { commandForDropPlacement, dropPlacementForNode } from "./drop-target.js";

export type CutPasteShortcutAction = "cut" | "paste";

export type CutPasteShortcutTarget = {
  nodeId?: NodeId;
  tagName?: string;
  isContentEditable?: boolean;
};

export type CutPasteKeyboardEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

export type CutSubtreeRow = {
  nodeId: NodeId;
  index: number;
  subtreeEndIndex: number;
};

export type CutSubtreeRowRange = {
  startIndex: number;
  endIndex: number;
};

export function keyboardCutPasteAction(
  event: CutPasteKeyboardEvent,
  target: CutPasteShortcutTarget,
  shortcuts: Pick<Record<SidebarShortcutAction, ShortcutPreference>, "cut" | "paste"> = DEFAULT_APP_PREFERENCES.shortcuts
): CutPasteShortcutAction | undefined {
  if (!isCutPasteShortcutEligibleTarget(target)) {
    return undefined;
  }

  if (shortcutMatchesEvent(shortcuts.cut, event)) {
    return "cut";
  }
  if (shortcutMatchesEvent(shortcuts.paste, event)) {
    return "paste";
  }
  return undefined;
}

export function isCutPasteShortcutEligibleTarget(target: CutPasteShortcutTarget): boolean {
  if (target.isContentEditable) {
    return false;
  }

  const tagName = target.tagName?.toLocaleUpperCase();
  return tagName !== "INPUT" && tagName !== "TEXTAREA";
}

export function nodeIdForCutPasteTarget(target: CutPasteShortcutTarget): NodeId | undefined {
  return target.nodeId;
}

export function pasteAfterCommand(
  state: OutlineState,
  pendingCutNodeId: NodeId | undefined,
  targetNodeId: NodeId
): BackgroundCommand | undefined {
  if (!pendingCutNodeId) {
    return undefined;
  }

  const placement = dropPlacementForNode(state, pendingCutNodeId, targetNodeId, "after");
  return placement ? commandForDropPlacement(placement) : undefined;
}

export function nextPendingCutNodeId(
  state: OutlineState,
  pendingCutNodeId: NodeId | undefined
): NodeId | undefined {
  return pendingCutNodeId && state.nodes[pendingCutNodeId] ? pendingCutNodeId : undefined;
}

export function cutSubtreeRowRange(
  rows: readonly CutSubtreeRow[],
  pendingCutNodeId: NodeId | undefined
): CutSubtreeRowRange | undefined {
  if (!pendingCutNodeId) {
    return undefined;
  }

  const row = rows.find((candidate) => candidate.nodeId === pendingCutNodeId);
  return row ? { startIndex: row.index, endIndex: row.subtreeEndIndex } : undefined;
}

export function isRowInCutSubtree(
  row: CutSubtreeRow,
  range: CutSubtreeRowRange | undefined
): boolean {
  return Boolean(range && row.index >= range.startIndex && row.index < range.endIndex);
}
