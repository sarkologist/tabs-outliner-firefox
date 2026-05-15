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
  RuntimeTab,
  RuntimeWindow
} from "./types.js";

export function tabNodeId(tabId: number): NodeId {
  return `tab:${tabId}`;
}

export function windowNodeId(windowId: number): NodeId {
  return `window:${windowId}`;
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
      title: win.focused ? "Current window" : `Window ${win.id}`,
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

  return state;
}

export function reconcileWithWindows(
  state: OutlineState,
  windows: RuntimeWindow[],
  clock: Clock
): OutlineState {
  const next = cloneState(state);
  const openWindowIds = new Set<number>();
  const openTabIds = new Set<number>();

  for (const win of windows.filter((windowInfo) => !windowInfo.incognito)) {
    openWindowIds.add(win.id);
    const winId = findLiveWindowNode(next, win.id) ?? windowNodeId(win.id);
    const existingWindow = next.nodes[winId];

    if (existingWindow) {
      existingWindow.status = "live";
      existingWindow.title = win.focused ? "Current window" : existingWindow.title || `Window ${win.id}`;
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
        title: win.focused ? "Current window" : `Window ${win.id}`,
        active: win.focused,
        collapsed: false,
        createdAt: clock.now,
        updatedAt: clock.now,
        live: { windowId: win.id }
      };
      next.rootIds.push(winId);
    }

    const tabs = [...(win.tabs ?? [])]
      .filter((tab) => !tab.incognito)
      .sort((a, b) => a.index - b.index);

    const runtimeToNode = new Map<number, NodeId>();
    for (const tab of tabs) {
      openTabIds.add(tab.id);
      const existingTabId = findLiveTabNode(next, tab.id);
      if (existingTabId) {
        const node = requireNode(next, existingTabId);
        updateLiveTabNode(node, tab, clock.now);
        runtimeToNode.set(tab.id, existingTabId);
        continue;
      }

      const nodeId = uniqueNodeId(next, tabNodeId(tab.id), clock.now);
      next.nodes[nodeId] = tabToNode(tab, nodeId, winId, clock.now);
      runtimeToNode.set(tab.id, nodeId);
    }

    for (const tab of tabs) {
      const nodeId = runtimeToNode.get(tab.id);
      if (!nodeId) {
        continue;
      }
      const openerId = typeof tab.openerTabId === "number" ? runtimeToNode.get(tab.openerTabId) : undefined;
      const parentId = openerId ?? winId;
      ensureParent(next, nodeId, parentId);
    }
  }

  for (const node of Object.values(next.nodes)) {
    if (isNodeLiveWindow(node) && !openWindowIds.has(node.live.windowId)) {
      markClosedSubtree(next, node.id, { now: clock.now });
    } else if (isNodeLiveTab(node) && !openTabIds.has(node.live.tabId)) {
      markClosedSubtree(next, node.id, { now: clock.now });
    }
  }

  return next;
}

export function closeTab(state: OutlineState, tabId: number, context: CloseContext): OutlineState {
  const nodeId = findLiveTabNode(state, tabId);
  if (!nodeId) {
    return state;
  }

  const next = cloneState(state);
  markClosedSubtree(next, nodeId, context);
  return next;
}

export function closeWindow(state: OutlineState, windowId: number, context: CloseContext): OutlineState {
  const nodeId = findLiveWindowNode(state, windowId);
  if (!nodeId) {
    return state;
  }

  const next = cloneState(state);
  markClosedSubtree(next, nodeId, context);
  return next;
}

export function moveNode(state: OutlineState, nodeId: NodeId, target: MoveTarget): OutlineState {
  const node = state.nodes[nodeId];
  if (!node) {
    throw new Error(`Cannot move missing node: ${nodeId}`);
  }

  if (target.parentId && isDescendant(state, target.parentId, nodeId)) {
    throw new Error("Cannot move a node into its own descendant");
  }

  const next = cloneState(state);
  const moving = requireNode(next, nodeId);
  const oldSiblings = moving.parentId
    ? requireNode(next, moving.parentId).childIds
    : next.rootIds;
  removeId(oldSiblings, nodeId);

  const newSiblings = target.parentId
    ? requireNode(next, target.parentId).childIds
    : next.rootIds;
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

  return next;
}

export function projectLiveTabs(state: OutlineState, windowIdOrNodeId: number | NodeId): LiveTabProjection[] {
  const windowId = typeof windowIdOrNodeId === "number" ? windowNodeId(windowIdOrNodeId) : windowIdOrNodeId;
  const root = state.nodes[windowId];
  if (!root) {
    return [];
  }

  const projection: LiveTabProjection[] = [];
  walk(state, root.id, (node) => {
    if (node.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live) {
      const owningWindow = nearestWindow(state, node.id);
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

    if (current.restore?.sessionId) {
      plans.push({
        kind: "session",
        nodeId: current.id,
        sessionId: current.restore.sessionId,
        ...(current.restore.url ? { fallbackUrl: current.restore.url } : {})
      });
      return;
    }

    if (current.kind === "tab" && current.restore?.url) {
      const parentWindow = nearestWindow(state, current.id);
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

export function restoreNodes(state: OutlineState, restoredNodes: RestoredNode[]): OutlineState {
  const next = cloneState(state);

  for (const restored of restoredNodes) {
    const node = next.nodes[restored.nodeId];
    if (!node) {
      continue;
    }

    node.status = "live";
    node.updatedAt = Date.now();
    delete node.closedAt;
    delete node.restore;

    if (node.kind === "window") {
      node.live = { windowId: restored.windowId };
      continue;
    }

    if (typeof restored.tabId !== "number") {
      throw new Error(`Restored tab node ${node.id} is missing a tabId`);
    }

    node.live = { tabId: restored.tabId, windowId: restored.windowId };
    if (restored.url) {
      node.url = restored.url;
    }
    if (restored.title) {
      node.title = restored.title;
    }
    if (restored.favIconUrl) {
      node.favIconUrl = restored.favIconUrl;
    }
  }

  return next;
}

export function deleteNode(state: OutlineState, nodeId: NodeId): OutlineState {
  const node = state.nodes[nodeId];
  if (!node) {
    return state;
  }

  const subtreeIds = collectSubtreeIds(state, nodeId);
  const liveNode = subtreeIds
    .map((id) => state.nodes[id])
    .find((candidate): candidate is OutlineNode => Boolean(candidate && candidate.status === "live"));

  if (liveNode) {
    throw new Error(`Cannot delete live node ${liveNode.id}`);
  }

  const next = cloneState(state);
  const parentSiblings = node.parentId ? requireNode(next, node.parentId).childIds : next.rootIds;
  removeId(parentSiblings, nodeId);
  for (const id of subtreeIds) {
    delete next.nodes[id];
  }

  return next;
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
  node.status = "live";
  node.title = tab.title || tab.url || node.title || "Untitled tab";
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

function ensureParent(state: OutlineState, nodeId: NodeId, parentId: NodeId): void {
  const node = requireNode(state, nodeId);
  if (node.parentId === parentId) {
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

function markClosedSubtree(state: OutlineState, nodeId: NodeId, context: CloseContext): void {
  for (const id of collectSubtreeIds(state, nodeId)) {
    const node = requireNode(state, id);
    const restore = {
      ...(id === nodeId && context.sessionId ? { sessionId: context.sessionId } : {}),
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
  }
}

function collectSubtreeIds(state: OutlineState, nodeId: NodeId): NodeId[] {
  const ids: NodeId[] = [];
  walk(state, nodeId, (node) => {
    ids.push(node.id);
  });
  return ids;
}

function walk(state: OutlineState, nodeId: NodeId, visitor: (node: OutlineNode) => void): void {
  const node = state.nodes[nodeId];
  if (!node) {
    return;
  }

  visitor(node);
  for (const childId of node.childIds) {
    walk(state, childId, visitor);
  }
}

function nearestWindow(state: OutlineState, nodeId: NodeId): OutlineNode | undefined {
  let current = state.nodes[nodeId];
  while (current) {
    if (current.kind === "window") {
      return current;
    }
    current = current.parentId ? state.nodes[current.parentId] : undefined;
  }
  return undefined;
}

function isDescendant(state: OutlineState, candidateId: NodeId, ancestorId: NodeId): boolean {
  let current = state.nodes[candidateId];
  while (current?.parentId) {
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
