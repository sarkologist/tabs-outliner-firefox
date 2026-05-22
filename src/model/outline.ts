import type {
  Clock,
  CloseContext,
  LiveTabProjection,
  MoveTarget,
  NodeId,
  OutlineNode,
  OutlineState,
  RestorePlan,
  RestoredNode,
  ReconcileOptions,
  RuntimeTab,
  RuntimeWindow
} from "./types.js";
import { buildOutlineLookup, type OutlineLookup } from "./outline-lookup.js";

export const LARGE_RESTORE_NODE_THRESHOLD = 25;

export type RestoreScope = {
  nodeIds: NodeId[];
  totalCount: number;
  tabCount: number;
  windowCount: number;
  threshold: number;
  requiresConfirmation: boolean;
};

export type WrapNodeInGroupContext = Clock & {
  liveWindow?: RuntimeWindow;
};

export type MoveSubtreeToTopLevelContext = WrapNodeInGroupContext;

export function tabNodeId(tabId: number): NodeId {
  return `tab:${tabId}`;
}

export function windowNodeId(windowId: number): NodeId {
  return `window:${windowId}`;
}

export function groupNodeId(now: number): NodeId {
  return `group:${now}`;
}

export function runtimeTitleForOutlineTab(
  node: Pick<OutlineNode, "title" | "restoredFromClosed">,
  tab: Pick<RuntimeTab, "title" | "url">,
  options: { restoredFromClosed?: boolean } = {}
): string {
  const fallbackTitle = node.title || "Untitled tab";
  const runtimeTitle = tab.title || tab.url;
  if (!runtimeTitle) {
    return fallbackTitle;
  }

  const restoredFromClosed = options.restoredFromClosed ?? node.restoredFromClosed === true;
  if (restoredFromClosed && isTransientRestoredRuntimeTitle(runtimeTitle, tab.url)) {
    return fallbackTitle;
  }

  return runtimeTitle;
}

function windowTitle(customTitle?: string): string {
  return normalizeCustomGroupTitle(customTitle) ?? "Group";
}

function normalizeCustomGroupTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeGroupTitle(node: OutlineNode): void {
  const customTitle = normalizeCustomGroupTitle(node.customTitle);
  if (customTitle) {
    node.customTitle = customTitle;
    node.title = customTitle;
    return;
  }

  delete node.customTitle;
  node.title = windowTitle();
}

function isTransientRestoredRuntimeTitle(title: string, url: string | undefined): boolean {
  const trimmedTitle = title.trim();
  if (trimmedTitle.toLocaleLowerCase() === "new tab") {
    return true;
  }
  if (normalizedUrlString(trimmedTitle)) {
    return true;
  }
  if (isSchemelessUrlTitle(trimmedTitle)) {
    return true;
  }

  return Boolean(url && urlsMatch(trimmedTitle, url.trim()));
}

function isSchemelessUrlTitle(title: string): boolean {
  if (/\s/.test(title)) {
    return false;
  }

  const withoutTrailingPath = title.split(/[/?#]/, 1)[0] ?? "";
  const withoutCredentials = withoutTrailingPath.split("@").at(-1) ?? "";
  const host = withoutCredentials.replace(/:\d+$/, "");
  if (!host) {
    return false;
  }

  return host === "localhost" ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
    host.includes(".");
}

function urlsMatch(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  const normalizedLeft = normalizedUrlString(left);
  const normalizedRight = normalizedUrlString(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function normalizedUrlString(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return isDisplayUrlProtocol(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function isDisplayUrlProtocol(protocol: string): boolean {
  return protocol === "http:" ||
    protocol === "https:" ||
    protocol === "file:" ||
    protocol === "about:" ||
    protocol === "chrome:" ||
    protocol === "moz-extension:";
}

export function bootstrapFromWindows(windows: RuntimeWindow[], clock: Clock): OutlineState {
  const state: OutlineState = {
    version: 1,
    rootIds: [],
    nodes: {}
  };

  for (const win of windows.filter((windowInfo) => !windowInfo.incognito)) {
    const winId = windowNodeId(win.id);
    state.rootIds.push(winId);
    state.nodes[winId] = {
      id: winId,
      kind: "window",
      status: "live",
      childIds: [],
      title: windowTitle(),
      active: win.focused,
      collapsed: false,
      createdAt: clock.now,
      updatedAt: clock.now,
      live: { windowId: win.id }
    };

    const tabs = [...(win.tabs ?? [])]
      .filter((tab) => !tab.incognito)
      .sort((a, b) => a.index - b.index);
    const tabIdsInWindow = new Set(tabs.map((tab) => tab.id));

    for (const tab of tabs) {
      const id = tabNodeId(tab.id);
      state.nodes[id] = tabToNode(tab, id, winId, clock.now);
    }

    for (const tab of tabs) {
      const id = tabNodeId(tab.id);
      const openerId =
        typeof tab.openerTabId === "number" && tabIdsInWindow.has(tab.openerTabId)
          ? tabNodeId(tab.openerTabId)
          : undefined;
      const parentId = openerId && state.nodes[openerId] ? openerId : winId;
      const node = state.nodes[id];
      const parent = state.nodes[parentId];

      if (!node || !parent) {
        continue;
      }

      node.parentId = parentId;
      parent.childIds.push(id);
    }
  }

  return removeEmptyWindowNodes(state);
}

export function reconcileWithWindows(
  state: OutlineState,
  windows: RuntimeWindow[],
  clock: Clock,
  options: ReconcileOptions = {}
): OutlineState {
  let next = cloneState(state);
  let lookup = buildOutlineLookup(next);
  const closeMissing = options.closeMissing ?? true;
  const openWindowIds = new Set<number>();
  const openTabIds = new Set<number>();

  for (const win of windows.filter((windowInfo) => !windowInfo.incognito)) {
    openWindowIds.add(win.id);
    const winId = lookup.liveWindowNodeIdsByRuntimeId.get(win.id) ?? windowNodeId(win.id);
    const existingWindow = next.nodes[winId];

    if (existingWindow) {
      existingWindow.status = "live";
      normalizeGroupTitle(existingWindow);
      existingWindow.active = win.focused;
      existingWindow.live = { windowId: win.id };
      existingWindow.updatedAt = clock.now;
      delete existingWindow.closedAt;
      delete existingWindow.restore;
    } else {
      next.nodes[winId] = {
        id: winId,
        kind: "window",
        status: "live",
        childIds: [],
        title: windowTitle(),
        active: win.focused,
        collapsed: false,
        createdAt: clock.now,
        updatedAt: clock.now,
        live: { windowId: win.id }
      };
      next.rootIds.push(winId);
      lookup.liveWindowNodeIdsByRuntimeId.set(win.id, winId);
      lookup.nodes.push(next.nodes[winId]!);
    }

    const tabs = [...(win.tabs ?? [])]
      .filter((tab) => !tab.incognito)
      .sort((a, b) => a.index - b.index);

    const runtimeToNode = new Map<number, NodeId>();
    const reattachedNodeIds = new Set<NodeId>();
    const newlyPlacedNodeIds = new Set<NodeId>();
    for (const tab of tabs) {
      openTabIds.add(tab.id);
      const existingTabId = lookup.liveTabNodeIdsByRuntimeId.get(tab.id);
      if (existingTabId) {
        const node = requireNode(next, existingTabId);
        const reattachedNodeId = findRestorableClosedTabNode(next, lookup, tab, winId, reattachedNodeIds);
        if (reattachedNodeId && isProvisionalLiveTabNode(node)) {
          replaceProvisionalNode(next, node.id, reattachedNodeId);
          updateLiveTabNode(requireNode(next, reattachedNodeId), tab, clock.now);
          requireNode(next, reattachedNodeId).restoredFromClosed = true;
          reattachedNodeIds.add(reattachedNodeId);
          lookup.liveTabNodeIdsByRuntimeId.delete(tab.id);
          lookup.liveTabNodeIdsByRuntimeId.set(tab.id, reattachedNodeId);
          runtimeToNode.set(tab.id, reattachedNodeId);
          continue;
        }

        updateLiveTabNode(node, tab, clock.now);
        runtimeToNode.set(tab.id, existingTabId);
        continue;
      }

      const reattachedNodeId = findRestorableClosedTabNode(next, lookup, tab, winId, reattachedNodeIds);
      const nodeId = reattachedNodeId ?? uniqueNodeId(next, tabNodeId(tab.id), clock.now);
      if (reattachedNodeId) {
        updateLiveTabNode(requireNode(next, reattachedNodeId), tab, clock.now);
        requireNode(next, reattachedNodeId).restoredFromClosed = true;
        reattachedNodeIds.add(reattachedNodeId);
      } else {
        next.nodes[nodeId] = tabToNode(tab, nodeId, winId, clock.now);
        newlyPlacedNodeIds.add(nodeId);
        lookup.nodes.push(next.nodes[nodeId]!);
      }
      lookup.liveTabNodeIdsByRuntimeId.set(tab.id, nodeId);
      runtimeToNode.set(tab.id, nodeId);
    }

    for (const tab of tabs) {
      const nodeId = runtimeToNode.get(tab.id);
      if (!nodeId) {
        continue;
      }
      if (reattachedNodeIds.has(nodeId)) {
        continue;
      }
      if (newlyPlacedNodeIds.has(nodeId)) {
        ensureParent(next, nodeId, parentForNewRuntimeTab(next, lookup, tab, winId));
        continue;
      }
      if (!isUnderRuntimeWindow(next, nodeId, tab.windowId)) {
        ensureParent(next, nodeId, winId);
      }
    }

    const activeTab = tabs.find((tab) => tab.active);
    const activeNodeId = activeTab ? runtimeToNode.get(activeTab.id) : undefined;
    if (activeNodeId) {
      setActiveTabInRuntimeWindow(next, win.id, activeNodeId);
    }
  }

  if (closeMissing) {
    lookup = buildOutlineLookup(next);
    const missingWindowNodeIds = lookup.nodes
      .filter((node) => isNodeLiveWindow(node) && !openWindowIds.has(node.live.windowId))
      .map((node) => node.id);
    for (const nodeId of missingWindowNodeIds) {
      if (next.nodes[nodeId]) {
        markClosedSubtree(next, nodeId, { now: clock.now });
      }
    }

    const missingTabNodeIdsInOpenWindows = lookup.nodes.flatMap((node) => {
      if (!isNodeLiveTab(node) || openTabIds.has(node.live.tabId) || !openWindowIds.has(node.live.windowId)) {
        return [];
      }
      return [node.id];
    });
    for (const nodeId of missingTabNodeIdsInOpenWindows) {
      deleteLiveTabNodeByNodeIdInPlace(next, nodeId);
    }

    for (const node of Object.values(next.nodes)) {
      if (isNodeLiveTab(node) && !openTabIds.has(node.live.tabId)) {
        markClosedSubtree(next, node.id, { now: clock.now });
      }
    }
  }

  return repairState(next);
}

export function repairState(state: OutlineState): OutlineState {
  const next = cloneState(state);
  const originalRootIds = uniqueIds(next.rootIds).filter((id) => Boolean(next.nodes[id]));
  const originalChildIds = new Map(
    Object.entries(next.nodes).map(([nodeId, node]) => [
      nodeId,
      uniqueIds(node.childIds).filter((childId) => childId !== nodeId && Boolean(next.nodes[childId]))
    ])
  );

  for (const [nodeId, node] of Object.entries(next.nodes)) {
    if (isGroupLikeNode(node)) {
      normalizeGroupTitle(node);
    }
    node.childIds = [];
    if (
      node.parentId &&
      (!next.nodes[node.parentId] ||
        node.parentId === nodeId ||
        createsParentCycle(next, nodeId, node.parentId))
    ) {
      delete node.parentId;
    }
  }

  const childrenByParent = new Map<NodeId, NodeId[]>();
  for (const [nodeId, node] of Object.entries(next.nodes)) {
    if (!node.parentId) {
      continue;
    }
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(nodeId);
    childrenByParent.set(node.parentId, siblings);
  }

  for (const [parentId, childIds] of childrenByParent) {
    const parent = next.nodes[parentId];
    if (!parent) {
      continue;
    }
    const remaining = new Set(childIds);
    const ordered = (originalChildIds.get(parentId) ?? []).filter((childId) => {
      if (!remaining.has(childId)) {
        return false;
      }
      remaining.delete(childId);
      return true;
    });
    parent.childIds = [...ordered, ...remaining];
  }

  reattachLiveTabsToOwningWindows(next);
  promoteClosedTabChildrenInLiveWindows(next);

  next.rootIds = uniqueIds([
    ...originalRootIds.filter((id) => !next.nodes[id]?.parentId),
    ...Object.entries(next.nodes)
      .filter(([, node]) => !node.parentId)
      .map(([nodeId]) => nodeId)
  ]).filter((id) => Boolean(next.nodes[id]));
  return removeEmptyWindowNodes(next);
}

export function renameGroup(state: OutlineState, nodeId: NodeId, title: string, clock: Clock): OutlineState {
  const node = state.nodes[nodeId];
  if (!node || !isGroupLikeNode(node)) {
    return state;
  }

  const customTitle = normalizeCustomGroupTitle(title);
  const nextTitle = customTitle ?? windowTitle();
  if (node.customTitle === customTitle && node.title === nextTitle) {
    return state;
  }

  const next = copyStateForNodeTableMutation(state);
  const group = cloneNodeForMutation(next, nodeId);
  if (customTitle) {
    group.customTitle = customTitle;
  } else {
    delete group.customTitle;
  }
  normalizeGroupTitle(group);
  group.updatedAt = clock.now;
  return next;
}

export function closeTab(state: OutlineState, tabId: number, context: CloseContext): OutlineState {
  const nodeId = findLiveTabNode(state, tabId);
  if (!nodeId) {
    return state;
  }

  const originalNode = requireNode(state, nodeId);
  const next: OutlineState = {
    version: state.version,
    rootIds: state.rootIds,
    nodes: { ...state.nodes }
  };
  cloneNodeForMutation(next, nodeId);
  markClosedNode(next, nodeId, context);
  if (originalNode.childIds.length > 0) {
    if (originalNode.parentId) {
      cloneNodeForMutation(next, originalNode.parentId);
    } else {
      next.rootIds = [...state.rootIds];
    }
    for (const childId of originalNode.childIds) {
      cloneNodeForMutation(next, childId);
    }
    promoteChildrenAfterNode(next, nodeId);
  }
  return next;
}

export function closeWindow(state: OutlineState, windowId: number, context: CloseContext): OutlineState {
  const nodeId = findLiveWindowNode(state, windowId);
  if (!nodeId) {
    return state;
  }

  const next: OutlineState = {
    version: state.version,
    rootIds: state.rootIds,
    nodes: { ...state.nodes }
  };
  promoteForeignLiveWindowsAfterClosingWindow(next, state, nodeId, windowId);
  const subtreeIds = collectSubtreeIds(next, nodeId);
  for (const id of subtreeIds) {
    cloneNodeForMutation(next, id);
  }
  for (const id of subtreeIds) {
    markClosedNode(next, id, {
      now: context.now,
      ...(id === nodeId && context.sessionId ? { sessionId: context.sessionId } : {})
    });
  }
  return next;
}

function promoteForeignLiveWindowsAfterClosingWindow(
  state: OutlineState,
  original: OutlineState,
  closingWindowNodeId: NodeId,
  closingRuntimeWindowId: number
): void {
  const promotedWindowIds = foreignLiveWindowRootsInSubtree(original, closingWindowNodeId, closingRuntimeWindowId);
  if (promotedWindowIds.length === 0) {
    return;
  }

  const closingWindow = requireNode(state, closingWindowNodeId);
  const targetParentId = closingWindow.parentId;
  const targetSiblings = targetParentId
    ? cloneNodeForMutation(state, targetParentId).childIds
    : mutableRootIds(state, original);
  const anchorIndex = targetSiblings.indexOf(closingWindowNodeId);
  let insertionIndex = anchorIndex >= 0 ? anchorIndex + 1 : targetSiblings.length;

  for (const promotedWindowId of promotedWindowIds) {
    const promotedWindow = cloneNodeForMutation(state, promotedWindowId);
    const oldParentId = promotedWindow.parentId;
    const oldSiblings = oldParentId
      ? cloneNodeForMutation(state, oldParentId).childIds
      : mutableRootIds(state, original);
    removeId(oldSiblings, promotedWindowId);

    if (targetParentId) {
      promotedWindow.parentId = targetParentId;
    } else {
      delete promotedWindow.parentId;
    }
    targetSiblings.splice(insertionIndex, 0, promotedWindowId);
    insertionIndex += 1;
  }
}

function foreignLiveWindowRootsInSubtree(
  state: OutlineState,
  nodeId: NodeId,
  closingRuntimeWindowId: number
): NodeId[] {
  const windowIds: NodeId[] = [];
  const visited = new Set<NodeId>();
  const stack = [...(state.nodes[nodeId]?.childIds ?? [])].reverse();

  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);

    const node = state.nodes[currentId];
    if (!node) {
      continue;
    }
    if (isNodeLiveWindow(node) && node.live.windowId !== closingRuntimeWindowId) {
      windowIds.push(node.id);
      continue;
    }

    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push(node.childIds[index]!);
    }
  }

  return windowIds;
}

export function deleteLiveTabNodeByTabId(state: OutlineState, tabId: number): OutlineState {
  const nodeId = findLiveTabNode(state, tabId);
  if (!nodeId) {
    return state;
  }

  const next = cloneState(state);
  deleteLiveTabNodeByNodeIdInPlace(next, nodeId);
  return removeEmptyWindowNodes(next);
}

function deleteLiveTabNodeByNodeIdInPlace(state: OutlineState, nodeId: NodeId): void {
  const deleting = state.nodes[nodeId];
  if (!deleting) {
    return;
  }

  const promotedChildIds = [...deleting.childIds];
  const siblings = deleting.parentId ? requireNode(state, deleting.parentId).childIds : state.rootIds;
  const index = siblings.indexOf(nodeId);

  if (index >= 0) {
    siblings.splice(index, 1, ...promotedChildIds);
  }

  for (const childId of promotedChildIds) {
    const child = state.nodes[childId];
    if (!child) {
      continue;
    }
    if (deleting.parentId) {
      child.parentId = deleting.parentId;
    } else {
      delete child.parentId;
    }
  }

  delete state.nodes[nodeId];
}

export function moveNode(state: OutlineState, nodeId: NodeId, target: MoveTarget): OutlineState {
  const node = state.nodes[nodeId];
  if (!node) {
    throw new Error(`Cannot move missing node: ${nodeId}`);
  }

  if (target.parentId && (target.parentId === nodeId || isDescendant(state, target.parentId, nodeId))) {
    throw new Error("Cannot move a node into its own descendant");
  }

  const currentSiblings = node.parentId ? requireNode(state, node.parentId).childIds : state.rootIds;
  const currentIndex = currentSiblings.indexOf(nodeId);
  const sameParent = node.parentId === target.parentId;
  const sameParentBoundedIndex = Math.max(0, Math.min(target.index, sameParent ? currentSiblings.length - 1 : 0));
  if (sameParent && currentIndex === sameParentBoundedIndex && typeof target.now !== "number") {
    return state;
  }

  const next = copyStateForNodeTableMutation(state);
  const moving = cloneNodeForMutation(next, nodeId);
  const oldParentId = moving.parentId;
  const oldSiblings = oldParentId
    ? cloneNodeForMutation(next, oldParentId).childIds
    : mutableRootIds(next, state);
  removeId(oldSiblings, nodeId);

  const newSiblings = target.parentId
    ? cloneNodeForMutation(next, target.parentId).childIds
    : mutableRootIds(next, state);
  const boundedIndex = Math.max(0, Math.min(target.index, newSiblings.length));
  newSiblings.splice(boundedIndex, 0, nodeId);

  if (target.parentId) {
    moving.parentId = target.parentId;
  } else {
    delete moving.parentId;
  }
  if (typeof target.now === "number") {
    moving.updatedAt = target.now;
  }

  if (oldParentId) {
    mutableRootIds(next, state);
  }
  return removeEmptyWindowNodesFrom(next, oldParentId);
}

export function flattenSubtreeOneLevel(state: OutlineState, nodeId: NodeId): OutlineState {
  const node = state.nodes[nodeId];
  if (!node) {
    return state;
  }

  if (!node.childIds.some((childId) => (state.nodes[childId]?.childIds.length ?? 0) > 0)) {
    return state;
  }

  const next = copyStateForNodeTableMutation(state);
  const flattening = cloneNodeForMutation(next, nodeId);
  const flattenedChildIds: NodeId[] = [];
  const emptiedWindowIds: NodeId[] = [];

  for (const childId of node.childIds) {
    const originalChild = state.nodes[childId];
    const child = originalChild ? cloneNodeForMutation(next, childId) : undefined;
    if (!child) {
      flattenedChildIds.push(childId);
      continue;
    }

    const promotedChildIds = [...originalChild!.childIds];
    flattenedChildIds.push(childId, ...promotedChildIds);
    child.childIds = [];
    if (isContainerNode(child) && promotedChildIds.length > 0) {
      emptiedWindowIds.push(child.id);
    }

    for (const promotedChildId of promotedChildIds) {
      const promotedChild = next.nodes[promotedChildId] ? cloneNodeForMutation(next, promotedChildId) : undefined;
      if (promotedChild) {
        promotedChild.parentId = nodeId;
      }
    }
  }

  flattening.childIds = flattenedChildIds;
  for (const emptiedWindowId of emptiedWindowIds) {
    removeEmptyWindowNodesFrom(next, emptiedWindowId);
  }
  return next;
}

export function promoteChildrenOneLevel(state: OutlineState, nodeId: NodeId): OutlineState {
  const node = state.nodes[nodeId];
  if (!node || !node.parentId || node.childIds.length === 0 || isNodeLiveWindow(node)) {
    return state;
  }

  const parent = state.nodes[node.parentId];
  if (!parent) {
    return state;
  }

  const next = copyStateForNodeTableMutation(state);
  const promoting = cloneNodeForMutation(next, nodeId);
  const parentForMutation = cloneNodeForMutation(next, node.parentId);
  const promotedChildIds = [...node.childIds];
  const index = parentForMutation.childIds.indexOf(nodeId);
  const insertionIndex = index >= 0 ? index + 1 : parentForMutation.childIds.length;

  parentForMutation.childIds.splice(insertionIndex, 0, ...promotedChildIds);
  promoting.childIds = [];

  for (const promotedChildId of promotedChildIds) {
    const promotedChild = next.nodes[promotedChildId] ? cloneNodeForMutation(next, promotedChildId) : undefined;
    if (promotedChild) {
      promotedChild.parentId = node.parentId;
    }
  }

  return next;
}

export function moveTabToNewLiveWindow(
  state: OutlineState,
  nodeId: NodeId,
  windowInfo: RuntimeWindow,
  clock: Clock & { rootIndex?: number }
): OutlineState {
  const node = state.nodes[nodeId];
  if (!node) {
    throw new Error(`Cannot move missing node: ${nodeId}`);
  }
  if (node.kind !== "tab") {
    throw new Error("Only tab nodes can be moved into a new window");
  }
  if (node.status !== "live") {
    throw new Error("Only live tab nodes can be moved into a live window");
  }

  const next = cloneState(state);
  const newWindowNodeId = uniqueNodeId(next, windowNodeId(windowInfo.id), clock.now);
  next.nodes[newWindowNodeId] = {
    id: newWindowNodeId,
    kind: "window",
    status: "live",
    childIds: [],
    title: windowTitle(),
    active: windowInfo.focused,
    collapsed: false,
    createdAt: clock.now,
    updatedAt: clock.now,
    live: { windowId: windowInfo.id }
  };

  if (windowInfo.focused) {
    for (const existing of Object.values(next.nodes)) {
      if (existing.id !== newWindowNodeId && isNodeLiveWindow(existing)) {
        existing.active = false;
        normalizeGroupTitle(existing);
      }
    }
  }

  moveExistingNodeUnderNewWindow(next, nodeId, newWindowNodeId, clock.now, clock.rootIndex);
  updateLiveTabWindowRefs(next, nodeId, windowInfo.id, clock.now);
  return repairState(next);
}

export function moveTabToNewClosedWindow(
  state: OutlineState,
  nodeId: NodeId,
  clock: Clock & { rootIndex?: number }
): OutlineState {
  const node = state.nodes[nodeId];
  if (!node) {
    throw new Error(`Cannot move missing node: ${nodeId}`);
  }
  if (node.kind !== "tab") {
    throw new Error("Only tab nodes can be moved into a new window");
  }
  if (node.status !== "closed") {
    throw new Error("Only closed tab nodes can be moved into a closed window placeholder");
  }

  const next = cloneState(state);
  const newWindowNodeId = uniqueNodeId(next, `window:placeholder:${clock.now}`, clock.now);
  const sourceWindow = closedSingleTabSourceWindow(next, nodeId);
  next.nodes[newWindowNodeId] = {
    id: newWindowNodeId,
    kind: "window",
    status: "closed",
    childIds: [],
    title: windowTitle(),
    collapsed: false,
    createdAt: clock.now,
    updatedAt: clock.now,
    closedAt: clock.now,
    ...(sourceWindow?.restore ? { restore: { ...sourceWindow.restore } } : {})
  };

  moveExistingNodeUnderNewWindow(next, nodeId, newWindowNodeId, clock.now, clock.rootIndex);
  return repairState(next);
}

export function wrapNodeInGroup(
  state: OutlineState,
  nodeId: NodeId,
  context: WrapNodeInGroupContext
): OutlineState {
  const node = state.nodes[nodeId];
  if (!node) {
    return state;
  }

  if (isNodeLiveTab(node)) {
    if (!context.liveWindow) {
      throw new Error("Wrapping a live tab requires a live window destination");
    }
    const wrapperId = uniqueNodeId(state, windowNodeId(context.liveWindow.id), context.now);
    const next = wrapExistingNodeWithContainer(state, nodeId, {
      id: wrapperId,
      kind: "window",
      status: "live",
      ...(node.parentId ? { parentId: node.parentId } : {}),
      childIds: [nodeId],
      title: windowTitle(),
      active: context.liveWindow.focused,
      collapsed: false,
      createdAt: context.now,
      updatedAt: context.now,
      live: { windowId: context.liveWindow.id }
    }, context.now);

    if (next === state) {
      return state;
    }
    if (context.liveWindow.focused) {
      for (const existing of Object.values(state.nodes)) {
        if (existing.id !== wrapperId && isNodeLiveWindow(existing)) {
          const liveWindow = cloneNodeForMutation(next, existing.id);
          liveWindow.active = false;
          normalizeGroupTitle(liveWindow);
        }
      }
    }
    updateLiveTabWindowRefsForSubtree(next, state, nodeId, context.liveWindow.id, context.now);
    return next;
  }

  if (node.kind === "tab" && node.status === "closed") {
    return wrapExistingNodeWithContainer(state, nodeId, {
      id: uniqueNodeId(state, `window:placeholder:${context.now}`, context.now),
      kind: "window",
      status: "closed",
      ...(node.parentId ? { parentId: node.parentId } : {}),
      childIds: [nodeId],
      title: windowTitle(),
      collapsed: false,
      createdAt: context.now,
      updatedAt: context.now,
      closedAt: context.now
    }, context.now);
  }

  return wrapExistingNodeWithContainer(state, nodeId, {
    id: uniqueNodeId(state, groupNodeId(context.now), context.now),
    kind: "group",
    status: "neutral",
    ...(node.parentId ? { parentId: node.parentId } : {}),
    childIds: [nodeId],
    title: windowTitle(),
    collapsed: false,
    createdAt: context.now,
    updatedAt: context.now
  }, context.now);
}

export function moveSubtreeToTopLevel(
  state: OutlineState,
  nodeId: NodeId,
  context: MoveSubtreeToTopLevelContext
): OutlineState {
  const node = state.nodes[nodeId];
  if (!node?.parentId) {
    return state;
  }

  const rootAncestorId = rootAncestorIdFor(state, nodeId);
  if (!rootAncestorId) {
    return state;
  }

  const rootIndex = state.rootIds.indexOf(rootAncestorId);
  if (rootIndex < 0) {
    return state;
  }

  let next = state;
  let movingNodeId = nodeId;

  if (!isGroupLikeNode(node)) {
    next = wrapNodeInGroup(state, nodeId, context);
    if (next === state) {
      return state;
    }
    const wrapperId = next.nodes[nodeId]?.parentId;
    if (!wrapperId) {
      return state;
    }
    movingNodeId = wrapperId;
  }

  const moving = next.nodes[movingNodeId];
  if (!moving?.parentId) {
    return next;
  }

  return moveNode(next, movingNodeId, {
    index: rootIndex + 1,
    now: context.now
  });
}

export function projectLiveTabs(
  state: OutlineState,
  windowIdOrNodeId: number | NodeId,
  lookup = buildOutlineLookup(state)
): LiveTabProjection[] {
  const windowId = typeof windowIdOrNodeId === "number" ? windowNodeId(windowIdOrNodeId) : windowIdOrNodeId;
  const root = state.nodes[windowId];
  if (!root) {
    return [];
  }

  const projection: LiveTabProjection[] = [];
  walk(state, root.id, (node) => {
    if (node.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live) {
      const owningWindowId = lookup.ownerWindowNodeIdsByNodeId.get(node.id);
      const owningWindow = owningWindowId ? state.nodes[owningWindowId] : undefined;
      const targetWindowId =
        owningWindow?.live && "windowId" in owningWindow.live ? owningWindow.live.windowId : node.live.windowId;
      projection.push({ tabId: node.live.tabId, windowId: targetWindowId });
    }
  });

  return projection;
}

export function planRestore(state: OutlineState, nodeId: NodeId): RestorePlan[] {
  const node = state.nodes[nodeId];
  if (!node) {
    return [];
  }

  const plans: RestorePlan[] = [];
  walk(state, nodeId, (current) => {
    if (current.status !== "closed") {
      return;
    }

    const parentWindow = nearestWindow(state, current.id);
    if (current.restore?.sessionId) {
      plans.push({
        kind: "session",
        nodeId: current.id,
        sessionId: current.restore.sessionId,
        ...(current.restore.url ? { fallbackUrl: current.restore.url } : {}),
        ...(parentWindow ? { windowNodeId: parentWindow.id } : {})
      });
      return;
    }

    if (current.kind === "tab" && current.restore?.url) {
      plans.push({
        kind: "url",
        nodeId: current.id,
        url: current.restore.url,
        ...(parentWindow ? { windowNodeId: parentWindow.id } : {})
      });
    }
  });

  return plans;
}

export function analyzeRestoreScope(
  state: OutlineState,
  nodeId: NodeId,
  threshold = LARGE_RESTORE_NODE_THRESHOLD
): RestoreScope {
  const seenNodeIds = new Set<NodeId>();
  const nodeIds: NodeId[] = [];
  let tabCount = 0;
  let windowCount = 0;

  for (const plan of planRestore(state, nodeId)) {
    if (seenNodeIds.has(plan.nodeId)) {
      continue;
    }

    const plannedNode = state.nodes[plan.nodeId];
    if (!plannedNode || plannedNode.status !== "closed") {
      continue;
    }

    seenNodeIds.add(plan.nodeId);
    nodeIds.push(plan.nodeId);
    if (plannedNode.kind === "tab") {
      tabCount += 1;
    } else {
      windowCount += 1;
    }
  }

  const totalCount = nodeIds.length;
  return {
    nodeIds,
    totalCount,
    tabCount,
    windowCount,
    threshold,
    requiresConfirmation: totalCount > threshold
  };
}

export function restoreNodes(state: OutlineState, restoredNodes: RestoredNode[]): OutlineState {
  if (restoredNodes.length === 0) {
    return state;
  }

  const next: OutlineState = {
    version: state.version,
    rootIds: state.rootIds,
    nodes: { ...state.nodes }
  };

  for (const restored of restoredNodes) {
    const existing = next.nodes[restored.nodeId];
    if (!existing) {
      continue;
    }

    const node = cloneNodeForMutation(next, restored.nodeId);
    const wasClosed = node.status === "closed";
    node.status = "live";
    node.updatedAt = Date.now();
    delete node.closedAt;
    delete node.restore;
    if (wasClosed) {
      node.restoredFromClosed = true;
    }

    if (node.kind === "window") {
      node.live = { windowId: restored.windowId };
      if (typeof restored.active === "boolean") {
        node.active = restored.active;
        if (restored.active) {
          clearOtherActiveLiveWindows(next, node.id);
        }
      }
      normalizeGroupTitle(node);
      continue;
    }

    if (typeof restored.tabId !== "number") {
      throw new Error(`Restored tab node ${node.id} is missing a tabId`);
    }

    node.live = { tabId: restored.tabId, windowId: restored.windowId };
    if (typeof restored.active === "boolean") {
      node.active = restored.active;
    }
    if (restored.url) {
      node.url = restored.url;
    }
    if (restored.title) {
      node.title = runtimeTitleForOutlineTab(node, restored, {
        restoredFromClosed: wasClosed || node.restoredFromClosed === true
      });
    }
    if (restored.favIconUrl) {
      node.favIconUrl = restored.favIconUrl;
    }
  }

  return next;
}

function clearOtherActiveLiveWindows(state: OutlineState, activeWindowNodeId: NodeId): void {
  for (const existing of Object.values(state.nodes)) {
    if (existing.id === activeWindowNodeId || !isNodeLiveWindow(existing) || existing.active !== true) {
      continue;
    }

    const liveWindow = cloneNodeForMutation(state, existing.id);
    liveWindow.active = false;
    normalizeGroupTitle(liveWindow);
  }
}

export function deleteNode(
  state: OutlineState,
  nodeId: NodeId,
  options: { allowLive?: boolean } = {}
): OutlineState {
  const node = state.nodes[nodeId];
  if (!node) {
    return state;
  }

  const subtreeIds = collectSubtreeIds(state, nodeId);

  if (!options.allowLive) {
    const liveNode = subtreeIds
      .map((id) => state.nodes[id])
      .find((candidate): candidate is OutlineNode => Boolean(candidate && candidate.status === "live"));

    if (liveNode) {
      throw new Error(`Cannot delete live node ${liveNode.id}`);
    }
  }

  const next: OutlineState = {
    version: state.version,
    rootIds: [...state.rootIds],
    nodes: { ...state.nodes }
  };
  const parentSiblings = node.parentId ? cloneNodeForMutation(next, node.parentId).childIds : next.rootIds;
  removeId(parentSiblings, nodeId);
  for (const id of subtreeIds) {
    delete next.nodes[id];
  }

  return removeEmptyWindowNodesFrom(next, node.parentId);
}

function tabToNode(tab: RuntimeTab, nodeId: NodeId, parentId: NodeId, now: number): OutlineNode {
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

function updateLiveTabNode(node: OutlineNode, tab: RuntimeTab, now: number): void {
  const restoredFromClosed = node.status === "closed" || node.restoredFromClosed === true;
  node.status = "live";
  node.title = runtimeTitleForOutlineTab(node, tab, { restoredFromClosed });
  node.active = tab.active;
  node.updatedAt = now;
  node.live = { tabId: tab.id, windowId: tab.windowId };
  if (tab.url) {
    node.url = tab.url;
  }
  if (tab.favIconUrl) {
    node.favIconUrl = tab.favIconUrl;
  }
  delete node.closedAt;
  delete node.restore;
}

function setActiveTabInRuntimeWindow(
  state: OutlineState,
  runtimeWindowId: number,
  activeNodeId: NodeId
): void {
  for (const node of Object.values(state.nodes)) {
    if (isNodeLiveTab(node) && node.live.windowId === runtimeWindowId) {
      node.active = node.id === activeNodeId;
    }
  }
}

function findRestorableClosedTabNode(
  state: OutlineState,
  lookup: OutlineLookup,
  tab: RuntimeTab,
  windowNodeIdForTab: NodeId,
  alreadyMatched: Set<NodeId>
): NodeId | undefined {
  if (!tab.url || isBlankUrl(tab.url)) {
    return undefined;
  }

  if (isLikelyDuplicateOfLiveTab(state, lookup, tab)) {
    return undefined;
  }

  const candidates = lookup.closedTabNodeIdsByUrl.get(tab.url) ?? [];
  for (const nodeId of candidates) {
    const node = state.nodes[nodeId];
    if (
      node &&
      node.kind === "tab" &&
      node.status === "closed" &&
      node.restore?.url === tab.url &&
      !alreadyMatched.has(node.id) &&
      isInCompatibleWindow(state, lookup, node, tab.windowId, windowNodeIdForTab)
    ) {
      return node.id;
    }
  }

  return undefined;
}

function isInCompatibleWindow(
  state: OutlineState,
  lookup: OutlineLookup,
  node: OutlineNode,
  runtimeWindowId: number,
  windowNodeIdForTab: NodeId
): boolean {
  const ownerId = lookup.ownerWindowNodeIdsByNodeId.get(node.id);
  const owner = ownerId ? state.nodes[ownerId] : undefined;
  if (!owner) {
    return true;
  }
  if (owner.id === windowNodeIdForTab) {
    return true;
  }
  return Boolean(owner.live && "windowId" in owner.live && owner.live.windowId === runtimeWindowId);
}

function isLikelyDuplicateOfLiveTab(state: OutlineState, lookup: OutlineLookup, tab: RuntimeTab): boolean {
  if (typeof tab.openerTabId !== "number" || !tab.url) {
    return false;
  }

  const openerNodeId = lookup.liveTabNodeIdsByRuntimeId.get(tab.openerTabId);
  const opener = openerNodeId ? state.nodes[openerNodeId] : undefined;
  return Boolean(opener?.kind === "tab" && opener.status === "live" && opener.url === tab.url);
}

function isBlankUrl(url: string): boolean {
  return url === "about:blank" || url === "about:newtab";
}

function isProvisionalLiveTabNode(node: OutlineNode): boolean {
  return node.kind === "tab" && node.status === "live" && Boolean(node.url && isBlankUrl(node.url));
}

function replaceProvisionalNode(state: OutlineState, provisionalNodeId: NodeId, replacementNodeId: NodeId): void {
  const provisional = requireNode(state, provisionalNodeId);
  const replacement = requireNode(state, replacementNodeId);
  const siblings = provisional.parentId ? requireNode(state, provisional.parentId).childIds : state.rootIds;
  removeId(siblings, provisionalNodeId);

  for (const childId of provisional.childIds) {
    const child = state.nodes[childId];
    if (child) {
      child.parentId = replacementNodeId;
    }
    if (!replacement.childIds.includes(childId)) {
      replacement.childIds.push(childId);
    }
  }

  delete state.nodes[provisionalNodeId];
}

function ensureParent(state: OutlineState, nodeId: NodeId, parentId: NodeId): void {
  const node = requireNode(state, nodeId);
  if (node.parentId === parentId) {
    const siblings = requireNode(state, parentId).childIds;
    if (!siblings.includes(nodeId)) {
      siblings.push(nodeId);
    }
    return;
  }

  if (node.parentId) {
    removeId(requireNode(state, node.parentId).childIds, nodeId);
  } else {
    removeId(state.rootIds, nodeId);
  }

  node.parentId = parentId;
  const siblings = requireNode(state, parentId).childIds;
  if (!siblings.includes(nodeId)) {
    siblings.push(nodeId);
  }
}

function parentForNewRuntimeTab(
  state: OutlineState,
  lookup: OutlineLookup,
  tab: RuntimeTab,
  fallbackWindowNodeId: NodeId
): NodeId {
  if (typeof tab.openerTabId !== "number") {
    return fallbackWindowNodeId;
  }

  const openerNodeId = lookup.liveTabNodeIdsByRuntimeId.get(tab.openerTabId);
  if (!openerNodeId) {
    return fallbackWindowNodeId;
  }

  return isUnderRuntimeWindow(state, openerNodeId, tab.windowId) ? openerNodeId : fallbackWindowNodeId;
}

function isUnderRuntimeWindow(state: OutlineState, nodeId: NodeId, runtimeWindowId: number): boolean {
  const owner = nearestWindow(state, nodeId);
  return Boolean(owner?.live && "windowId" in owner.live && owner.live.windowId === runtimeWindowId);
}

function reattachLiveTabsToOwningWindows(state: OutlineState): void {
  const liveWindowNodeIdsByRuntimeId = new Map<number, NodeId>();
  for (const node of Object.values(state.nodes)) {
    if (isNodeLiveWindow(node)) {
      liveWindowNodeIdsByRuntimeId.set(node.live.windowId, node.id);
    }
  }

  for (const node of Object.values(state.nodes)) {
    if (!isNodeLiveTab(node)) {
      continue;
    }

    const owner = nearestWindow(state, node.id);
    if (owner && isNodeLiveWindow(owner) && owner.live.windowId === node.live.windowId) {
      continue;
    }

    const owningWindowNodeId = liveWindowNodeIdsByRuntimeId.get(node.live.windowId);
    if (!owningWindowNodeId || createsParentCycle(state, node.id, owningWindowNodeId)) {
      continue;
    }

    ensureParent(state, node.id, owningWindowNodeId);
  }
}

function promoteClosedTabChildrenInLiveWindows(state: OutlineState): void {
  let promoted = true;
  while (promoted) {
    promoted = false;
    for (const node of Object.values(state.nodes)) {
      if (node.kind !== "tab" || node.status !== "closed" || node.childIds.length === 0) {
        continue;
      }

      const owner = nearestWindow(state, node.id);
      if (!owner || !isNodeLiveWindow(owner)) {
        continue;
      }

      promoteChildrenAfterNode(state, node.id);
      promoted = true;
    }
  }
}

function markClosedSubtree(state: OutlineState, nodeId: NodeId, context: CloseContext): void {
  for (const id of collectSubtreeIds(state, nodeId)) {
    markClosedNode(state, id, {
      now: context.now,
      ...(id === nodeId && context.sessionId ? { sessionId: context.sessionId } : {})
    });
  }
}

function markClosedNode(state: OutlineState, nodeId: NodeId, context: CloseContext): void {
  const node = requireNode(state, nodeId);
  const restore = {
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(node.url ? { url: node.url } : {}),
    ...(node.title ? { title: node.title } : {}),
    ...(node.favIconUrl ? { favIconUrl: node.favIconUrl } : {})
  };

  node.status = "closed";
  node.updatedAt = context.now;
  node.closedAt = context.now;
  node.restore = restore;
  delete node.live;
  delete node.active;
  delete node.restoredFromClosed;
}

function promoteChildrenAfterNode(state: OutlineState, nodeId: NodeId): void {
  const node = requireNode(state, nodeId);
  const promotedChildIds = [...node.childIds];
  if (promotedChildIds.length === 0) {
    return;
  }

  const siblings = node.parentId ? requireNode(state, node.parentId).childIds : state.rootIds;
  const index = siblings.indexOf(nodeId);
  const insertionIndex = index >= 0 ? index + 1 : siblings.length;
  siblings.splice(insertionIndex, 0, ...promotedChildIds);
  node.childIds = [];

  for (const childId of promotedChildIds) {
    const child = state.nodes[childId];
    if (!child) {
      continue;
    }
    if (node.parentId) {
      child.parentId = node.parentId;
    } else {
      delete child.parentId;
    }
  }
}

function moveExistingNodeUnderNewWindow(
  state: OutlineState,
  nodeId: NodeId,
  windowNodeId: NodeId,
  now: number,
  rootIndex?: number
): void {
  const moving = requireNode(state, nodeId);
  const oldSiblings = moving.parentId ? requireNode(state, moving.parentId).childIds : state.rootIds;
  removeId(oldSiblings, nodeId);

  const boundedIndex = typeof rootIndex === "number"
    ? Math.max(0, Math.min(rootIndex, state.rootIds.length))
    : state.rootIds.length;
  state.rootIds.splice(boundedIndex, 0, windowNodeId);
  moving.parentId = windowNodeId;
  moving.updatedAt = now;
  requireNode(state, windowNodeId).childIds.push(nodeId);
}

function wrapExistingNodeWithContainer(
  state: OutlineState,
  nodeId: NodeId,
  container: OutlineNode,
  now: number
): OutlineState {
  const node = state.nodes[nodeId];
  if (!node || state.nodes[container.id]) {
    return state;
  }

  const next = copyStateForNodeTableMutation(state);
  const siblings = node.parentId
    ? cloneNodeForMutation(next, node.parentId).childIds
    : mutableRootIds(next, state);
  const index = siblings.indexOf(nodeId);
  if (index < 0) {
    return state;
  }

  next.nodes[container.id] = {
    ...container,
    childIds: [...container.childIds],
    ...(container.live ? { live: { ...container.live } } : {}),
    ...(container.restore ? { restore: { ...container.restore } } : {})
  };
  siblings.splice(index, 1, container.id);

  const moving = cloneNodeForMutation(next, nodeId);
  moving.parentId = container.id;
  moving.updatedAt = now;
  return next;
}

function updateLiveTabWindowRefs(
  state: OutlineState,
  nodeId: NodeId,
  windowId: number,
  now: number
): void {
  for (const id of collectSubtreeIdsExcludingNestedLiveWindows(state, nodeId)) {
    const candidate = state.nodes[id];
    if (!candidate || !isNodeLiveTab(candidate)) {
      continue;
    }

    const tabId = candidate.live.tabId;
    const liveTab = cloneNodeForMutation(state, id);
    liveTab.live = {
      tabId,
      windowId
    };
    liveTab.updatedAt = now;
  }
}

function updateLiveTabWindowRefsForSubtree(
  state: OutlineState,
  original: OutlineState,
  nodeId: NodeId,
  windowId: number,
  now: number
): void {
  for (const id of collectSubtreeIdsExcludingNestedLiveWindows(original, nodeId)) {
    const candidate = state.nodes[id];
    if (!candidate || !isNodeLiveTab(candidate)) {
      continue;
    }

    const tabId = candidate.live.tabId;
    const liveTab = cloneNodeForMutation(state, id);
    liveTab.live = {
      tabId,
      windowId
    };
    liveTab.updatedAt = now;
  }
}

function collectSubtreeIdsExcludingNestedLiveWindows(state: OutlineState, nodeId: NodeId): NodeId[] {
  const ids: NodeId[] = [];
  const visited = new Set<NodeId>();
  const stack = [nodeId];

  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);

    const node = state.nodes[currentId];
    if (!node) {
      continue;
    }
    if (currentId !== nodeId && isNodeLiveWindow(node)) {
      continue;
    }

    ids.push(currentId);
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push(node.childIds[index]!);
    }
  }

  return ids;
}

function closedSingleTabSourceWindow(state: OutlineState, nodeId: NodeId): OutlineNode | undefined {
  const sourceWindow = nearestWindow(state, nodeId);
  if (
    !sourceWindow ||
    sourceWindow.id === nodeId ||
    sourceWindow.status !== "closed" ||
    !sourceWindow.restore?.sessionId
  ) {
    return undefined;
  }

  const closedTabIds = collectSubtreeIds(state, sourceWindow.id).filter((id) => {
    const candidate = state.nodes[id];
    return candidate?.kind === "tab" && candidate.status === "closed";
  });
  return closedTabIds.length === 1 && closedTabIds[0] === nodeId ? sourceWindow : undefined;
}

function collectSubtreeIds(state: OutlineState, nodeId: NodeId): NodeId[] {
  const ids: NodeId[] = [];
  walk(state, nodeId, (node) => {
    ids.push(node.id);
  });
  return ids;
}

function removeEmptyWindowNodes(state: OutlineState): OutlineState {
  const queued = new Set<NodeId>();
  const queue: NodeId[] = [];

  for (const node of Object.values(state.nodes)) {
    if (isContainerNode(node) && node.childIds.length === 0) {
      queued.add(node.id);
      queue.push(node.id);
    }
  }

  while (queue.length > 0) {
    const nodeId = queue.pop()!;
    const node = state.nodes[nodeId];
    if (!node || !isContainerNode(node) || node.childIds.length > 0) {
      continue;
    }

    const parentId = node.parentId;
    if (parentId) {
      const parent = state.nodes[parentId];
      if (parent) {
        removeId(parent.childIds, nodeId);
        if (isContainerNode(parent) && parent.childIds.length === 0 && !queued.has(parent.id)) {
          queued.add(parent.id);
          queue.push(parent.id);
        }
      }
    } else {
      removeId(state.rootIds, nodeId);
    }

    delete state.nodes[nodeId];
  }

  return state;
}

function removeEmptyWindowNodesFrom(state: OutlineState, startNodeId: NodeId | undefined): OutlineState {
  let currentId = startNodeId;

  while (currentId) {
    const current = state.nodes[currentId];
    if (!current || !isContainerNode(current) || current.childIds.length > 0) {
      break;
    }

    const parentId = current.parentId;
    delete state.nodes[currentId];

    if (parentId) {
      const parent = state.nodes[parentId];
      if (!parent) {
        break;
      }
      removeId(cloneNodeForMutation(state, parentId).childIds, currentId);
      currentId = parentId;
    } else {
      removeId(state.rootIds, currentId);
      break;
    }
  }

  return state;
}

function cloneNodeForMutation(state: OutlineState, nodeId: NodeId): OutlineNode {
  const node = requireNode(state, nodeId);
  const cloned: OutlineNode = {
    ...node,
    childIds: [...node.childIds]
  };
  if (node.live) {
    cloned.live = { ...node.live };
  } else {
    delete cloned.live;
  }
  if (node.restore) {
    cloned.restore = { ...node.restore };
  } else {
    delete cloned.restore;
  }
  state.nodes[nodeId] = cloned;
  return cloned;
}

function mutableRootIds(state: OutlineState, original: OutlineState): NodeId[] {
  if (state.rootIds === original.rootIds) {
    state.rootIds = [...original.rootIds];
  }
  return state.rootIds;
}

function copyStateForNodeTableMutation(state: OutlineState): OutlineState {
  return {
    version: state.version,
    rootIds: state.rootIds,
    nodes: { ...state.nodes }
  };
}

function walk(
  state: OutlineState,
  nodeId: NodeId,
  visitor: (node: OutlineNode) => void
): void {
  const visited = new Set<NodeId>();
  const stack = [nodeId];

  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);

    const node = state.nodes[currentId];
    if (!node) {
      continue;
    }

    visitor(node);
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push(node.childIds[index]!);
    }
  }
}

function nearestWindow(state: OutlineState, nodeId: NodeId): OutlineNode | undefined {
  let current = state.nodes[nodeId];
  const visited = new Set<NodeId>();
  while (current) {
    if (visited.has(current.id)) {
      return undefined;
    }
    visited.add(current.id);
    if (current.kind === "window") {
      return current;
    }
    current = current.parentId ? state.nodes[current.parentId] : undefined;
  }
  return undefined;
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

function findLiveTabNode(state: OutlineState, tabId: number): NodeId | undefined {
  return Object.values(state.nodes).find((node) => node.live && "tabId" in node.live && node.live.tabId === tabId)?.id;
}

function findLiveWindowNode(state: OutlineState, windowId: number): NodeId | undefined {
  return Object.values(state.nodes).find((node) => {
    return node.kind === "window" && node.live && "windowId" in node.live && node.live.windowId === windowId;
  })?.id;
}

function cloneState(state: OutlineState): OutlineState {
  const nodes: Record<NodeId, OutlineNode> = {};
  for (const [id, node] of Object.entries(state.nodes)) {
    const cloned: OutlineNode = {
      ...node,
      childIds: [...node.childIds]
    };
    if (node.live) {
      cloned.live = { ...node.live };
    } else {
      delete cloned.live;
    }
    if (node.restore) {
      cloned.restore = { ...node.restore };
    } else {
      delete cloned.restore;
    }
    nodes[id] = cloned;
  }

  return {
    version: state.version,
    rootIds: [...state.rootIds],
    nodes
  };
}

function uniqueNodeId(state: OutlineState, preferredId: NodeId, now: number): NodeId {
  if (!state.nodes[preferredId]) {
    return preferredId;
  }

  let index = 1;
  let candidate = `${preferredId}:${now}`;
  while (state.nodes[candidate]) {
    index += 1;
    candidate = `${preferredId}:${now}:${index}`;
  }
  return candidate;
}

function isGroupLikeNode(node: OutlineNode): boolean {
  return node.kind === "window" || node.kind === "group";
}

function rootAncestorIdFor(state: OutlineState, nodeId: NodeId): NodeId | undefined {
  let current = state.nodes[nodeId];
  const visited = new Set<NodeId>();

  while (current?.parentId && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = state.nodes[current.parentId];
    if (!parent) {
      return undefined;
    }
    current = parent;
  }

  return current?.id;
}

function isContainerNode(node: OutlineNode): boolean {
  return node.kind === "window" || node.kind === "group";
}

function isNodeLiveTab(node: OutlineNode): node is OutlineNode & { live: { tabId: number; windowId: number } } {
  return Boolean(node.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live);
}

function isNodeLiveWindow(node: OutlineNode): node is OutlineNode & { live: { windowId: number } } {
  return Boolean(node.kind === "window" && node.status === "live" && node.live && "windowId" in node.live);
}

function requireNode(state: OutlineState, nodeId: NodeId): OutlineNode {
  const node = state.nodes[nodeId];
  if (!node) {
    throw new Error(`Missing outline node: ${nodeId}`);
  }
  return node;
}

function removeId(ids: NodeId[], id: NodeId): void {
  const index = ids.indexOf(id);
  if (index >= 0) {
    ids.splice(index, 1);
  }
}

function uniqueIds(ids: NodeId[]): NodeId[] {
  return [...new Set(ids)];
}

function createsParentCycle(state: OutlineState, nodeId: NodeId, parentId: NodeId): boolean {
  const seen = new Set<NodeId>();
  let currentId: NodeId | undefined = parentId;

  while (currentId) {
    if (currentId === nodeId || seen.has(currentId)) {
      return true;
    }
    seen.add(currentId);
    currentId = state.nodes[currentId]?.parentId;
  }

  return false;
}
