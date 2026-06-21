import type { NodeId, OutlineNode, OutlineNodeKind, OutlineState } from "../model/types.js";

// Turns a persistence delta into a user-facing, domain-level description of what changed -- the
// subtree that was deleted, what moved where, what was renamed/created/closed -- with the NAME of
// every affected node, not just a count. Surfaced on the write-activity log's "Changes" list so an
// unexpected change (a whole window deleted when only one tab was meant to go) is obvious. Pure;
// works off the already-computed delta plus the before/after states, so it adds no extra tree walk.

const DEFAULT_MAX_NAMES = 3; // headline name cap (the one-line summary)
// Above this many touched nodes (a bulk import/flatten, often spill-sized) we skip the per-node
// classification on the ack path and report coarse counts instead. The full name list is bounded by
// the same limit, so a normal window delete lists every tab while a 10k import does not.
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
  // For a reorder, the title of the sibling it now follows; undefined means it moved to the top.
  after?: string;
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

export type OutlineChangeGroup = {
  // The subtree roots (a deleted/created node whose parent is not itself deleted/created).
  roots: OutlineChangeNodeRef[];
  // Every affected node (roots + descendants), capped at the detail limit; used for the full list.
  all: OutlineChangeNodeRef[];
  total: number;
};

export type OutlineChangeSummary = {
  deleted: OutlineChangeGroup;
  created: OutlineChangeGroup;
  moved: OutlineChangeMove[];
  renamed: OutlineChangeRename[];
  statusChanged: OutlineChangeStatus[];
  // Updated nodes we could not classify (no previous state); shown as a plain "Updated" list.
  updated: OutlineChangeNodeRef[];
  // Count of touched nodes left unclassified because the delta exceeded the detail limit.
  otherChanges: number;
  reorderedTopLevel: boolean;
};

// What the write-activity "Changes" list stores per change: a one-line headline plus the full
// (bounded) list of affected node descriptions.
export type OutlineChangeDescription = {
  headline: string;
  lines: string[];
  overflow: number;
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
      deleted: { roots: [], all: [], total: deletedIds.length },
      otherChanges: updatedNodes.length
    };
  }

  const deletedSet = new Set(deletedIds);

  // Name the deleted nodes only when we have the before-image to read their titles from; without it
  // (the in-place runtime fast path) report a bare count rather than "(unknown)" names.
  const deletedRoots: OutlineChangeNodeRef[] = [];
  const deletedAll: OutlineChangeNodeRef[] = [];
  if (previous) {
    for (const id of deletedIds) {
      const ref = refFor(id, previous, next);
      deletedAll.push(ref);
      const parentId = previous.nodes[id]?.parentId;
      // A subtree root is a deleted node whose parent is not itself deleted.
      if (parentId === undefined || !deletedSet.has(parentId)) {
        deletedRoots.push(ref);
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
    } else if (node.parentId !== undefined && isReordered(node.id, node.parentId, previous, next)) {
      // Within-parent reorder. (Top-level reorders are handled after the loop from the rootId order,
      // since the moved root may not appear in updatedNodes.)
      const where = parentTitle(node.parentId, next, previous);
      moved.push({
        ref: refForNode(node),
        to: where,
        from: where,
        within: true,
        ...afterField(node.id, next.nodes[node.parentId]?.childIds, next, previous)
      });
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

  const createdRefs = created.map((id) => refFor(id, next, previous));
  const createdRoots = created
    .filter((id) => {
      const parentId = next.nodes[id]?.parentId;
      return parentId === undefined || !createdSet.has(parentId);
    })
    .map((id) => refFor(id, next, previous));

  // Top-level reorder: the root order changed but the moved root may carry no material change (so
  // it never reached updatedNodes). Recover the moved node + its new neighbour from the rootId
  // diff so the row names it ("Moved 'B' after 'A'") instead of a bare "Reordered top level".
  let reorderedTopLevel = false;
  if (previous && delta.rootIds) {
    const movedRootId = findReorderedNode(previous.rootIds, next.rootIds);
    if (movedRootId !== undefined) {
      moved.push({
        ref: refFor(movedRootId, next, previous),
        to: "top level",
        from: "top level",
        within: true,
        ...afterField(movedRootId, next.rootIds, next, previous)
      });
    } else if (
      previous.rootIds.length === next.rootIds.length &&
      !sameNodeIdOrder(previous.rootIds, next.rootIds)
    ) {
      // A multi-node shuffle we could not isolate to one node.
      reorderedTopLevel = true;
    }
  }

  return {
    deleted: { roots: deletedRoots, all: deletedAll, total: deletedIds.length },
    created: { roots: createdRoots, all: createdRefs, total: created.length },
    moved,
    renamed,
    statusChanged,
    updated,
    otherChanges: 0,
    reorderedTopLevel
  };
}

// The concise one-line headline (capped node names) -- the row title in the Changes list.
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

// One line per affected node (the full, un-capped-by-name list) -- the expandable detail in the
// Changes list. Order: deleted, moved, created, renamed, status, updated.
export function outlineChangeLines(summary: OutlineChangeSummary): string[] {
  const lines: string[] = [];
  for (const ref of summary.deleted.all) {
    lines.push(nameWithKind(ref));
  }
  for (const move of summary.moved) {
    lines.push(renderMove(move));
  }
  for (const ref of summary.created.all) {
    lines.push(nameWithKind(ref));
  }
  for (const rename of summary.renamed) {
    lines.push(`${quote(rename.from)} → ${quote(rename.to)}`);
  }
  for (const status of summary.statusChanged) {
    lines.push(`${nameWithKind(status.ref)} (${status.to})`);
  }
  for (const ref of summary.updated) {
    lines.push(nameWithKind(ref));
  }
  return lines;
}

// The full change description for the Changes list: headline + every affected name (bounded).
export function buildOutlineChangeDescription(
  delta: OutlineChangeDelta,
  options: { previous?: OutlineState; next: OutlineState; maxLines?: number }
): OutlineChangeDescription | undefined {
  const summary = summarizeOutlineDelta(delta, options);
  const headline = renderOutlineChangeSummary(summary);
  if (!headline) {
    return undefined;
  }
  const maxLines = options.maxLines ?? CHANGE_SUMMARY_DETAIL_LIMIT;
  const allLines = outlineChangeLines(summary);
  const lines = allLines.slice(0, maxLines);
  return { headline, lines, overflow: Math.max(0, allLines.length - lines.length) };
}

// Headline-only convenience (used in tests).
export function describeOutlineDelta(
  delta: OutlineChangeDelta,
  options: { previous?: OutlineState; next: OutlineState; maxNames?: number }
): string {
  return renderOutlineChangeSummary(summarizeOutlineDelta(delta, options), {
    ...(options.maxNames !== undefined ? { maxNames: options.maxNames } : {})
  });
}

function emptySummary(): OutlineChangeSummary {
  return {
    deleted: { roots: [], all: [], total: 0 },
    created: { roots: [], all: [], total: 0 },
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

// The single node whose removal makes `prev` and `next` identical -- i.e. the one node that was
// dragged within a same-set reorder. Undefined when the lists are not a permutation (a structural
// add/remove handles that) or when more than one node shifted (a multi-node shuffle).
function findReorderedNode(prev: readonly NodeId[], next: readonly NodeId[]): NodeId | undefined {
  if (prev.length !== next.length || sameNodeIdOrder(prev, next)) {
    return undefined;
  }
  // The isolation scan is O(n^2); bound it so a profile with a very large top level can't add cost
  // on the ack path. Beyond this the caller reports a generic "Reordered top level".
  if (prev.length > CHANGE_SUMMARY_DETAIL_LIMIT) {
    return undefined;
  }
  for (const id of next) {
    if (sameNodeIdOrder(withoutId(prev, id), withoutId(next, id))) {
      return id;
    }
  }
  return undefined;
}

function withoutId(ids: readonly NodeId[], omit: NodeId): NodeId[] {
  return ids.filter((id) => id !== omit);
}

function sameNodeIdOrder(left: readonly NodeId[], right: readonly NodeId[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

// The "after 'X'" / "to the top" position field for a reordered node, from its new sibling list.
function afterField(
  id: NodeId,
  siblings: readonly NodeId[] | undefined,
  next: OutlineState,
  previous: OutlineState | undefined
): { after?: string } {
  if (!siblings) {
    return {};
  }
  const index = siblings.indexOf(id);
  if (index <= 0) {
    return {}; // moved to the top (or not found)
  }
  return { after: refFor(siblings[index - 1]!, next, previous).title };
}

function renderDeletedOrCreated(verb: string, group: OutlineChangeGroup, maxNames: number): string {
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

function renderMove(move: OutlineChangeMove): string {
  if (move.within) {
    const position = move.after !== undefined ? `after ${quote(move.after)}` : "to the top";
    // Top-level reorders read better without the "within top level" prefix.
    return move.to === "top level"
      ? `${quote(move.ref.title)} ${position}`
      : `${quote(move.ref.title)} within ${quote(move.to)} ${position}`;
  }
  return `${quote(move.ref.title)} from ${renderParent(move.from)} to ${renderParent(move.to)}`;
}

function renderParent(title: string): string {
  return title === "top level" ? "top level" : quote(title);
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
