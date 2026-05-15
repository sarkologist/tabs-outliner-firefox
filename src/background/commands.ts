import type { BrowserAdapter, RestoredSession } from "./adapter.js";
import {
  deleteNode,
  moveNode,
  moveTabToNewClosedWindow,
  moveTabToNewLiveWindow,
  planRestore,
  projectLiveTabs,
  restoreNodes
} from "../model/outline.js";
import type { NodeId, OutlineNode, OutlineState, RestoredNode, RestorePlan, RuntimeTab } from "../model/types.js";

export type BackgroundCommand =
  | {
      type: "getState";
    }
  | {
      type: "focusNode";
      nodeId: NodeId;
    }
  | {
      type: "closeNode";
      nodeId: NodeId;
    }
  | {
      type: "restoreNode";
      nodeId: NodeId;
    }
  | {
      type: "deleteNode";
      nodeId: NodeId;
    }
  | {
      type: "moveNode";
      nodeId: NodeId;
      parentId?: NodeId;
      index: number;
    }
  | {
      type: "moveNodeToNewWindow";
      nodeId: NodeId;
    }
  | {
      type: "toggleCollapsed";
      nodeId: NodeId;
    }
  | {
      type: "refresh";
    };

export type CommandResult = {
  state: OutlineState;
};

export async function runCommand(
  state: OutlineState,
  adapter: BrowserAdapter,
  command: BackgroundCommand
): Promise<CommandResult> {
  switch (command.type) {
    case "getState":
      return { state };

    case "refresh":
      return { state };

    case "focusNode": {
      const node = state.nodes[command.nodeId];
      if (isLiveTab(node)) {
        await adapter.focusTab(node.live.tabId, node.live.windowId);
      }
      return { state };
    }

    case "closeNode": {
      const node = state.nodes[command.nodeId];
      if (isLiveTab(node)) {
        await adapter.closeTab(node.live.tabId);
      } else if (isLiveWindow(node)) {
        await adapter.closeWindow(node.live.windowId);
      }
      return { state };
    }

    case "restoreNode":
      return { state: await restoreNode(state, adapter, command.nodeId) };

    case "moveNode": {
      const next = moveNode(state, command.nodeId, {
        ...(command.parentId ? { parentId: command.parentId } : {}),
        index: command.index
      });
      await syncBrowserOrder(next, adapter);
      return { state: next };
    }

    case "moveNodeToNewWindow":
      return { state: await moveNodeToNewWindow(state, adapter, command.nodeId) };

    case "toggleCollapsed":
      return { state: toggleCollapsed(state, command.nodeId) };

    case "deleteNode": {
      if (!state.nodes[command.nodeId]) {
        return { state };
      }

      await closeLiveSubtree(state, adapter, command.nodeId);
      return { state: deleteNode(state, command.nodeId, { allowLive: true }) };
    }
  }
}

async function closeLiveSubtree(
  state: OutlineState,
  adapter: BrowserAdapter,
  nodeId: NodeId
): Promise<void> {
  const entries = collectSubtreeEntries(state, nodeId);
  const liveWindowNodeIds = new Set(
    entries
      .filter((entry) => isLiveWindow(entry.node))
      .map((entry) => entry.node.id)
  );

  for (const { node } of entries) {
    if (isLiveWindow(node)) {
      await adapter.closeWindow(node.live.windowId);
    }
  }

  const liveTabs = entries
    .filter(({ node }) => isLiveTab(node) && !hasLiveWindowAncestor(state, node.id, liveWindowNodeIds))
    .sort((left, right) => right.depth - left.depth);

  for (const { node } of liveTabs) {
    if (isLiveTab(node)) {
      await adapter.closeTab(node.live.tabId);
    }
  }
}

type SubtreeEntry = {
  node: OutlineNode;
  depth: number;
};

function collectSubtreeEntries(
  state: OutlineState,
  nodeId: NodeId,
  depth = 0,
  visited = new Set<NodeId>()
): SubtreeEntry[] {
  if (visited.has(nodeId)) {
    return [];
  }
  visited.add(nodeId);

  const node = state.nodes[nodeId];
  if (!node) {
    return [];
  }

  return [
    { node, depth },
    ...node.childIds.flatMap((childId) => collectSubtreeEntries(state, childId, depth + 1, visited))
  ];
}

function hasLiveWindowAncestor(
  state: OutlineState,
  nodeId: NodeId,
  liveWindowNodeIds: Set<NodeId>
): boolean {
  let current = state.nodes[nodeId];
  const visited = new Set<NodeId>();

  while (current?.parentId) {
    if (visited.has(current.id)) {
      return false;
    }
    visited.add(current.id);

    if (liveWindowNodeIds.has(current.parentId)) {
      return true;
    }
    current = state.nodes[current.parentId];
  }

  return false;
}

async function restoreNode(
  state: OutlineState,
  adapter: BrowserAdapter,
  nodeId: NodeId
): Promise<OutlineState> {
  let next = state;
  const plans = planRestore(state, nodeId);
  const restoredWindowNodeIds = new Set<NodeId>();

  for (const plan of plans) {
    if (next.nodes[plan.nodeId]?.status !== "closed") {
      continue;
    }
    if (hasAncestor(plan.nodeId, restoredWindowNodeIds, next)) {
      continue;
    }

    const planNodeIsWindow = next.nodes[plan.nodeId]?.kind === "window";
    const restoredNodes = await runRestorePlan(next, adapter, plan);
    if (restoredNodes.length > 0) {
      next = restoreNodes(next, restoredNodes);
      for (const restored of restoredNodes) {
        if (planNodeIsWindow && next.nodes[restored.nodeId]?.kind === "window") {
          restoredWindowNodeIds.add(restored.nodeId);
        }
      }
    }
  }

  return next;
}

async function runRestorePlan(
  state: OutlineState,
  adapter: BrowserAdapter,
  plan: RestorePlan
): Promise<RestoredNode[]> {
  if (plan.kind === "session") {
    if (shouldCreateClosedWindowDestination(state, plan)) {
      const restoredInWindow = await restoreSessionIntoClosedWindowDestination(state, adapter, plan);
      if (restoredInWindow.length > 0) {
        return restoredInWindow;
      }
    }

    try {
      const restoredSession = await adapter.restoreSession(plan.sessionId);
      const restored = restoredFromSession(state, plan, restoredSession);
      if (restored.length > 0) {
        return restored;
      }
    } catch {
      // Fall through to URL fallback below.
    }

    if (plan.fallbackUrl) {
      return createFallbackTab(state, adapter, plan.nodeId, plan.fallbackUrl, plan.windowNodeId);
    }
    return [];
  }

  return createFallbackTab(state, adapter, plan.nodeId, plan.url, plan.windowNodeId);
}

async function restoreSessionIntoClosedWindowDestination(
  state: OutlineState,
  adapter: BrowserAdapter,
  plan: Extract<RestorePlan, { kind: "session" }>
): Promise<RestoredNode[]> {
  try {
    const restoredSession = await adapter.restoreSession(plan.sessionId);
    if (restoredSession.tab && plan.windowNodeId) {
      const createdWindow = await adapter.createWindow({ tabId: restoredSession.tab.id });
      const movedTab =
        createdWindow.tabs?.find((tab) => tab.id === restoredSession.tab?.id) ??
        {
          ...restoredSession.tab,
          windowId: createdWindow.id,
          index: 0
        };

      return [
        {
          nodeId: plan.windowNodeId,
          windowId: createdWindow.id
        },
        restoredTabFromRuntime(plan.nodeId, movedTab)
      ];
    }

    const restored = restoredFromSession(state, plan, restoredSession);
    if (restored.length > 0) {
      return restored;
    }
  } catch {
    // Fall through to URL fallback below.
  }

  return plan.fallbackUrl ? createFallbackTab(state, adapter, plan.nodeId, plan.fallbackUrl, plan.windowNodeId) : [];
}

function shouldCreateClosedWindowDestination(state: OutlineState, plan: RestorePlan): boolean {
  if (!plan.windowNodeId) {
    return false;
  }

  const plannedWindow = state.nodes[plan.windowNodeId];
  const plannedNode = state.nodes[plan.nodeId];
  return Boolean(
    plannedNode?.kind === "tab" &&
      plannedWindow?.kind === "window" &&
      plannedWindow.status === "closed" &&
      !plannedWindow.restore?.sessionId
  );
}

async function createFallbackTab(
  state: OutlineState,
  adapter: BrowserAdapter,
  nodeId: NodeId,
  url: string,
  windowNodeId?: NodeId
): Promise<RestoredNode[]> {
  const plannedWindow = windowNodeId ? state.nodes[windowNodeId] : undefined;
  if (isLiveWindow(plannedWindow)) {
    const created = await adapter.createTab({
      url,
      windowId: plannedWindow.live.windowId,
      active: false
    });
    return [restoredTabFromRuntime(nodeId, created)];
  }

  if (plannedWindow?.kind === "window" && plannedWindow.status === "closed" && windowNodeId) {
    const sessionRestored = closedWindowHasOnlyTab(state, windowNodeId, nodeId)
      ? await restoreClosedWindowSessionForTab(state, adapter, nodeId, plannedWindow)
      : [];
    if (sessionRestored.length > 0) {
      return sessionRestored;
    }

    const createdWindow = await adapter.createWindow({ url });
    const createdTab = createdWindow.tabs?.[0];
    if (!createdTab) {
      return [
        {
          nodeId: windowNodeId,
          windowId: createdWindow.id
        }
      ];
    }

    return [
      {
        nodeId: windowNodeId,
        windowId: createdWindow.id
      },
      restoredTabFromRuntime(nodeId, createdTab)
    ];
  }

  const parentWindow = nearestLiveWindow(state, nodeId);
  const created = await adapter.createTab({
    url,
    ...(parentWindow ? { windowId: parentWindow.live.windowId } : {}),
    active: false
  });

  return [restoredTabFromRuntime(nodeId, created)];
}

async function moveNodeToNewWindow(
  state: OutlineState,
  adapter: BrowserAdapter,
  nodeId: NodeId
): Promise<OutlineState> {
  const node = state.nodes[nodeId];
  if (!node || node.kind !== "tab") {
    return state;
  }

  if (isLiveTab(node)) {
    const createdWindow = await adapter.createWindow({ tabId: node.live.tabId });
    const next = moveTabToNewLiveWindow(state, nodeId, createdWindow, { now: Date.now() });
    await syncBrowserOrder(next, adapter);
    return next;
  }

  if (node.status === "closed") {
    return moveTabToNewClosedWindow(state, nodeId, { now: Date.now() });
  }

  return state;
}

function restoredTabFromRuntime(nodeId: NodeId, tab: RuntimeTab): RestoredNode {
  return {
    nodeId,
    tabId: tab.id,
    windowId: tab.windowId,
    ...(tab.url ? { url: tab.url } : {}),
    ...(tab.title ? { title: tab.title } : {}),
    ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {})
  };
}

function restoredFromSession(
  state: OutlineState,
  plan: RestorePlan,
  session: RestoredSession
): RestoredNode[] {
  if (session.tab) {
    return [restoredTabFromRuntime(plan.nodeId, session.tab)];
  }

  if (session.window) {
    const windowNodeId = windowNodeIdForSessionPlan(state, plan);
    if (!windowNodeId) {
      return [];
    }

    return [
      {
        nodeId: windowNodeId,
        windowId: session.window.id
      },
      ...restoredTabsFromWindowSession(state, plan, windowNodeId, session.window.tabs ?? [])
    ];
  }

  return [];
}

async function restoreClosedWindowSessionForTab(
  state: OutlineState,
  adapter: BrowserAdapter,
  nodeId: NodeId,
  windowNode: OutlineNode
): Promise<RestoredNode[]> {
  const sessionId = windowNode.restore?.sessionId;
  if (!sessionId) {
    return [];
  }

  try {
    const restored = restoredFromSession(state, {
      kind: "session",
      nodeId,
      sessionId,
      windowNodeId: windowNode.id
    }, await adapter.restoreSession(sessionId));

    return restored.some((node) => node.nodeId === nodeId && typeof node.tabId === "number")
      ? restored
      : [];
  } catch {
    return [];
  }
}

function windowNodeIdForSessionPlan(state: OutlineState, plan: RestorePlan): NodeId | undefined {
  if (plan.windowNodeId && state.nodes[plan.windowNodeId]?.kind === "window") {
    return plan.windowNodeId;
  }

  const node = state.nodes[plan.nodeId];
  return node?.kind === "window" ? node.id : undefined;
}

function restoredTabsFromWindowSession(
  state: OutlineState,
  plan: RestorePlan,
  windowNodeId: NodeId,
  tabs: RuntimeTab[]
): RestoredNode[] {
  if (tabs.length === 0) {
    return [];
  }

  const plannedNode = state.nodes[plan.nodeId];
  if (plannedNode?.kind === "tab") {
    const tab = matchingRestoredTab(plannedNode, tabs) ?? (tabs.length === 1 ? tabs[0] : undefined);
    return tab ? [restoredTabFromRuntime(plannedNode.id, tab)] : [];
  }

  const tabNodes = collectSubtreeEntries(state, windowNodeId)
    .map((entry) => entry.node)
    .filter((node) => node.kind === "tab" && node.status === "closed");
  const availableTabs = [...tabs];
  const restored: RestoredNode[] = [];

  for (const node of tabNodes) {
    const matchIndex = matchingRestoredTabIndex(node, availableTabs);
    if (matchIndex < 0) {
      continue;
    }

    const [tab] = availableTabs.splice(matchIndex, 1);
    if (tab) {
      restored.push(restoredTabFromRuntime(node.id, tab));
    }
  }

  return restored;
}

function matchingRestoredTab(node: OutlineNode, tabs: RuntimeTab[]): RuntimeTab | undefined {
  const index = matchingRestoredTabIndex(node, tabs);
  return index >= 0 ? tabs[index] : undefined;
}

function matchingRestoredTabIndex(node: OutlineNode, tabs: RuntimeTab[]): number {
  const url = node.restore?.url ?? node.url;
  if (!url) {
    return -1;
  }

  return tabs.findIndex((tab) => tab.url === url);
}

function closedWindowHasOnlyTab(state: OutlineState, windowNodeId: NodeId, tabNodeId: NodeId): boolean {
  const tabNodeIds = collectSubtreeEntries(state, windowNodeId)
    .map((entry) => entry.node)
    .filter((node) => node.kind === "tab" && node.status === "closed")
    .map((node) => node.id);
  return tabNodeIds.length === 1 && tabNodeIds[0] === tabNodeId;
}

function hasAncestor(nodeId: NodeId, ancestorIds: Set<NodeId>, state: OutlineState): boolean {
  let current = state.nodes[nodeId];
  const seen = new Set<NodeId>();

  while (current?.parentId) {
    if (seen.has(current.id)) {
      return false;
    }
    seen.add(current.id);
    if (ancestorIds.has(current.parentId)) {
      return true;
    }
    current = state.nodes[current.parentId];
  }

  return false;
}

async function syncBrowserOrder(state: OutlineState, adapter: BrowserAdapter): Promise<void> {
  for (const rootId of state.rootIds) {
    const root = state.nodes[rootId];
    if (!isLiveWindow(root)) {
      continue;
    }

    const projection = projectLiveTabs(state, rootId);
    const tabIds = projection
      .filter((tab) => tab.windowId === root.live.windowId)
      .map((tab) => tab.tabId);

    if (tabIds.length > 0) {
      await adapter.moveTabs(tabIds, { windowId: root.live.windowId, index: 0 });
    }
  }
}

function toggleCollapsed(state: OutlineState, nodeId: NodeId): OutlineState {
  const node = state.nodes[nodeId];
  if (!node) {
    return state;
  }

  return {
    ...state,
    rootIds: [...state.rootIds],
    nodes: {
      ...state.nodes,
      [nodeId]: {
        ...node,
        childIds: [...node.childIds],
        collapsed: !node.collapsed
      }
    }
  };
}

type LiveWindowNode = OutlineNode & { live: { windowId: number } };

function nearestLiveWindow(state: OutlineState, nodeId: NodeId): LiveWindowNode | undefined {
  let current = state.nodes[nodeId];
  while (current) {
    if (isLiveWindow(current)) {
      return current;
    }
    current = current.parentId ? state.nodes[current.parentId] : undefined;
  }

  const firstLiveWindow = state.rootIds
    .map((id) => state.nodes[id])
    .find((node): node is LiveWindowNode => isLiveWindow(node));
  return firstLiveWindow;
}

function isLiveTab(node: OutlineNode | undefined): node is OutlineNode & { live: { tabId: number; windowId: number } } {
  return Boolean(node?.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live);
}

function isLiveWindow(node: OutlineNode | undefined): node is OutlineNode & { live: { windowId: number } } {
  return Boolean(node?.kind === "window" && node.status === "live" && node.live && "windowId" in node.live);
}
