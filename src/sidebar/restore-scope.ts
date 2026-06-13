import type { RestoreScope } from "../model/outline.js";
import type { NodeId, OutlineState } from "../model/types.js";

export function isRestoreScope(value: unknown): value is RestoreScope {
  return Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray((value as { nodeIds?: unknown }).nodeIds) &&
      typeof (value as { totalCount?: unknown }).totalCount === "number" &&
      typeof (value as { tabCount?: unknown }).tabCount === "number" &&
      typeof (value as { windowCount?: unknown }).windowCount === "number" &&
      typeof (value as { threshold?: unknown }).threshold === "number" &&
      typeof (value as { requiresConfirmation?: unknown }).requiresConfirmation === "boolean"
  );
}

export function restoreScopeTargetsNodeOrDescendants(
  state: OutlineState,
  nodeId: NodeId,
  scope: RestoreScope,
  locallyKnownScopeNodeIds: ReadonlySet<NodeId>
): boolean {
  if (scope.nodeIds.includes(nodeId)) {
    return true;
  }
  if (scope.totalCount <= 0 || scope.nodeIds.length === 0) {
    return false;
  }

  for (const scopeNodeId of scope.nodeIds) {
    const node = state.nodes[scopeNodeId];
    if (!node) {
      if (locallyKnownScopeNodeIds.has(scopeNodeId)) {
        return false;
      }
      continue;
    }
    if (!isDescendantOfNode(state, scopeNodeId, nodeId)) {
      return false;
    }
  }
  return true;
}

function isDescendantOfNode(state: OutlineState, nodeId: NodeId, ancestorId: NodeId): boolean {
  const seen = new Set<NodeId>();
  let current = state.nodes[nodeId];

  while (current?.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.parentId === ancestorId) {
      return true;
    }
    current = state.nodes[current.parentId];
  }
  return false;
}

export function largeRestoreConfirmationPrompt(scope: RestoreScope): string {
  return `Restore ${restoreScopeSummary(scope)}?\n\nThis may open many tabs or windows at once.`;
}

function restoreScopeSummary(scope: RestoreScope): string {
  const parts = [
    scope.tabCount > 0 ? `${scope.tabCount} ${pluralize(scope.tabCount, "tab")}` : undefined,
    scope.windowCount > 0 ? `${scope.windowCount} ${pluralize(scope.windowCount, "window")}` : undefined
  ].filter((part): part is string => Boolean(part));

  return `${scope.totalCount} ${pluralize(scope.totalCount, "restorable closed node")}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function pluralize(count: number, noun: string): string {
  if (noun.endsWith("ch") || noun.endsWith("sh")) {
    return count === 1 ? noun : `${noun}es`;
  }
  return count === 1 ? noun : `${noun}s`;
}
