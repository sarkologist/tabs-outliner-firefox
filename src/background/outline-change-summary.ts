import type { NodeId, OutlineNode, OutlineNodeKind, OutlineState } from "../model/types.js";

// Turns a persistence delta into a short, user-facing, domain-level description of what changed --
// the subtree that was deleted (root + descendant count), what moved where, what was renamed,
// created, or closed/restored -- with node NAMES, not just counts. Surfaced on the write-activity
// log's journal-append rows so an unexpected change (e.g. a whole window deleted when only one tab
// was meant to go) is immediately obvious. Pure; works off the already-computed delta plus the
// before/after states, so it adds no extra tree walk.

const DEFAULT_MAX_NAMES = 3;
// Above this many touched nodes (a bulk import/flatten, often spill-sized) we skip the per-node
// classification on the ack path and report coarse counts instead.
const CHANGE_SUMMARY_DETAIL_LIMIT = 200;

// Structurally compatible with OutlineJournalDelta; kept local so this module stays independent.
export type OutlineChangeDelta = {
  updatedNodes?: readonly OutlineNode[];
  deletedNodeIds?: readonly NodeId[];
  rootIds?: readonly NodeId[];
};

export type OutlineChangeNodeRef = {
  id: NodeId;
  title: string;
  kind: OutlineNodeKind;
};

export type OutlineChangeMove = {
  ref: OutlineChangeNodeRef;
  to: string;
  from: string;
  // True for a same-parent reorder (drag within a window): `from` === `to` === the parent.
  within: boolean;
};

export type OutlineChangeRename = {
  ref: OutlineChangeNodeRef;
  from: string;
  to: string;
};

export type OutlineChangeStatus = {
  ref: OutlineChangeNodeRef;
  to: "closed" | "restored";
};

export type OutlineChangeSummary = {
  deleted: { roots: OutlineChangeNodeRef[]; total: number };
  created: { roots: OutlineChangeNodeRef[]; total: number };
  moved: OutlineChangeMove[];
  renamed: OutlineChangeRename[];
  statusChanged: OutlineChangeStatus[];
  // Updated nodes we could not classify (no previous state); shown as a plain "Updated" list.
  updated: OutlineChangeNodeRef[];
  // Count of touched nodes left unclassified because the delta exceeded the detail limit.
  otherChanges: number;
  reorderedTopLevel: boolean;
};

export function summarizeOutlineDelta(
  delta: OutlineChangeDelta,
  options: { previous?: OutlineState; next: OutlineState }
): OutlineChangeSummary {
  const { previous, next } = options;
  const deletedIds = delta.deletedNodeIds ?? [];
  const updatedNodes = delta.updatedNodes ?? [];

  // Bound the ack-path cost: a bulk delta (import/flatten, often spill-sized) gets coarse counts
  // instead of an O(delta) per-node classification.
  if (deletedIds.length + updatedNodes.length > CHANGE_SUMMARY_DETAIL_LIMIT) {
    return {
      ...emptySummary(),
      deleted: { roots: [], total: deletedIds.length },
      otherChanges: updatedNodes.length
    };
  }

  const deletedSet = new Set(deletedIds);

  // Name the deleted subtree roots only when we have the before-image to read their titles from;
  // without it (the in-place runtime fast path) report a bare count rather than "(unknown)" names.
  const deletedRoots: OutlineChangeNodeRef[] = [];
  if (previous) {
    for (const id of deletedIds) {
      const parentId = previous.nodes[id]?.parentId;
      // A subtree root is a deleted node whose parent is not itself deleted.
      if (parentId === undefined || !deletedSet.has(parentId)) {
        deletedRoots.push(refFor(id, previous, next));
      }
    }
  }

  const created: NodeId[] = [];
  const createdSet = new Set<NodeId>();
  const moved: OutlineChangeMove[] = [];
  const renamed: OutlineChangeRename[] = [];
  const statusChanged: OutlineChangeStatus[] = [];
  const updated: OutlineChangeNodeRef[] = [];

  for (const node of updatedNodes) {
    const prev = previous?.nodes[node.id];
    if (!previous) {
      // No before-image: we can still name the node, just not classify the change.
      updated.push(refForNode(node));
      continue;
    }
    if (!prev) {
      created.push(node.id);
      createdSet.add(node.id);
      continue;
    }
    // Classify each aspect independently: a node can be moved AND renamed AND closed in one delta
    // (e.g. restore re-parents and reopens), and the user should see every part.
    if (prev.parentId !== node.parentId) {
      moved.push({
        ref: refForNode(node),
        to: parentTitle(node.parentId, next, previous),
        from: parentTitle(prev.parentId, previous, next),
        within: false
      });
    } else if (isReordered(node.id, node.parentId, previous, next)) {
      const where = parentTitle(node.parentId, next, previous);
      moved.push({ ref: refForNode(node), to: where, from: where, within: true });
    }
    if (displayTitle(prev) !== displayTitle(node)) {
      renamed.push({ ref: refForNode(node), from: displayTitle(prev), to: displayTitle(node) });
    }
    if (prev.status !== node.status) {
      statusChanged.push({
        ref: refForNode(node),
        to: node.status === "closed" ? "closed" : "restored"
      });
    }
    // Otherwise a metadata-only change (favicon/url/active) -- not worth a domain description.
  }

  const createdRoots = created
    .filter((id) => {
      const parentId = next.nodes[id]?.parentId;
      return parentId === undefined || !createdSet.has(parentId);
    })
    .map((id) => refFor(id, next, previous));

  const structural = deletedIds.length > 0 || created.length > 0 || moved.length > 0;
  const reorderedTopLevel = Boolean(delta.rootIds) && !structural;

  return {
    deleted: { roots: deletedRoots, total: deletedIds.length },
    created: { roots: createdRoots, total: created.length },
    moved,
    renamed,
    statusChanged,
    updated,
    otherChanges: 0,
    reorderedTopLevel
  };
}

function emptySummary(): OutlineChangeSummary {
  return {
    deleted: { roots: [], total: 0 },
    created: { roots: [], total: 0 },
    moved: [],
    renamed: [],
    statusChanged: [],
    updated: [],
    otherChanges: 0,
    reorderedTopLevel: false
  };
}

// A node is reordered when its index within its sibling list (its parent's childIds, or the root
// list) changed. moveNode's same-parent path journals the moved node, so only it is inspected here.
function isReordered(
  id: NodeId,
  parentId: NodeId | undefined,
  previous: OutlineState,
  next: OutlineState
): boolean {
  const prevSiblings =
    parentId !== undefined ? previous.nodes[parentId]?.childIds : previous.rootIds;
  const nextSiblings = parentId !== undefined ? next.nodes[parentId]?.childIds : next.rootIds;
  if (!prevSiblings || !nextSiblings) {
    return false;
  }
  const prevIndex = prevSiblings.indexOf(id);
  const nextIndex = nextSiblings.indexOf(id);
  return prevIndex !== -1 && nextIndex !== -1 && prevIndex !== nextIndex;
}

export function renderOutlineChangeSummary(
  summary: OutlineChangeSummary,
  options: { maxNames?: number } = {}
): string {
  const maxNames = options.maxNames ?? DEFAULT_MAX_NAMES;
  const parts: string[] = [];

  if (summary.deleted.total > 0) {
    parts.push(renderDeletedOrCreated("Deleted", summary.deleted, maxNames));
  }
  if (summary.moved.length > 0) {
    const shown = summary.moved.slice(0, maxNames).map(renderMove).join(", ");
    parts.push(`Moved ${shown}${overflow(summary.moved.length, maxNames)}`);
  }
  if (summary.created.total > 0) {
    parts.push(renderDeletedOrCreated("Added", summary.created, maxNames));
  }
  if (summary.renamed.length > 0) {
    const shown = summary.renamed
      .slice(0, maxNames)
      .map((rename) => `${quote(rename.from)} → ${quote(rename.to)}`)
      .join(", ");
    parts.push(`Renamed ${shown}${overflow(summary.renamed.length, maxNames)}`);
  }
  for (const verb of ["closed", "restored"] as const) {
    const group = summary.statusChanged.filter((entry) => entry.to === verb);
    if (group.length > 0) {
      const shown = group
        .slice(0, maxNames)
        .map((entry) => quote(entry.ref.title))
        .join(", ");
      parts.push(`${capitalize(verb)} ${shown}${overflow(group.length, maxNames)}`);
    }
  }
  if (summary.updated.length > 0) {
    const shown = summary.updated
      .slice(0, maxNames)
      .map((ref) => quote(ref.title))
      .join(", ");
    parts.push(`Updated ${shown}${overflow(summary.updated.length, maxNames)}`);
  }
  if (summary.otherChanges > 0) {
    parts.push(`${summary.otherChanges} node ${summary.otherChanges === 1 ? "change" : "changes"}`);
  }
  if (parts.length === 0 && summary.reorderedTopLevel) {
    parts.push("Reordered top level");
  }

  return parts.join(" · ");
}

function renderMove(move: OutlineChangeMove): string {
  if (move.within) {
    return move.to === "top level"
      ? `${quote(move.ref.title)} within top level`
      : `${quote(move.ref.title)} within ${quote(move.to)}`;
  }
  return `${quote(move.ref.title)} from ${renderParent(move.from)} to ${renderParent(move.to)}`;
}

function renderParent(title: string): string {
  return title === "top level" ? "top level" : quote(title);
}

export function describeOutlineDelta(
  delta: OutlineChangeDelta,
  options: { previous?: OutlineState; next: OutlineState; maxNames?: number }
): string {
  return renderOutlineChangeSummary(summarizeOutlineDelta(delta, options), {
    ...(options.maxNames !== undefined ? { maxNames: options.maxNames } : {})
  });
}

function renderDeletedOrCreated(
  verb: string,
  group: { roots: OutlineChangeNodeRef[]; total: number },
  maxNames: number
): string {
  const { roots, total } = group;
  if (roots.length === 1 && total > 1) {
    const descendants = total - 1;
    return `${verb} ${nameWithKind(roots[0]!)} (+${descendants} ${
      descendants === 1 ? "descendant" : "descendants"
    })`;
  }
  if (roots.length === 0) {
    return `${verb} ${total} ${total === 1 ? "node" : "nodes"}`;
  }
  const shown = roots
    .slice(0, maxNames)
    .map((ref) => nameWithKind(ref))
    .join(", ");
  const extra = total - Math.min(roots.length, maxNames);
  return `${verb} ${shown}${extra > 0 ? ` (+${extra} more)` : ""}`;
}

function refFor(
  id: NodeId,
  primary: OutlineState | undefined,
  secondary: OutlineState | undefined
): OutlineChangeNodeRef {
  const node = primary?.nodes[id] ?? secondary?.nodes[id];
  return node ? refForNode(node) : { id, title: "(unknown)", kind: "tab" };
}

function refForNode(node: OutlineNode): OutlineChangeNodeRef {
  return { id: node.id, title: displayTitle(node), kind: node.kind };
}

function parentTitle(
  parentId: NodeId | undefined,
  primary: OutlineState | undefined,
  secondary: OutlineState | undefined
): string {
  if (parentId === undefined) {
    return "top level";
  }
  const node = primary?.nodes[parentId] ?? secondary?.nodes[parentId];
  return node ? displayTitle(node) : "(unknown)";
}

export function displayTitle(node: OutlineNode): string {
  const title = (node.customTitle ?? node.title ?? "").trim();
  if (title) {
    return title;
  }
  if (node.kind === "window") {
    return "(window)";
  }
  if (node.kind === "group") {
    return "(group)";
  }
  return "(untitled)";
}

function nameWithKind(ref: OutlineChangeNodeRef): string {
  return ref.kind === "tab" ? quote(ref.title) : `${quote(ref.title)} (${ref.kind})`;
}

function quote(title: string): string {
  return `'${title}'`;
}

function overflow(total: number, shown: number): string {
  return total > shown ? ` +${total - shown} more` : "";
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
