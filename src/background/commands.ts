import type { BrowserAdapter, RestoredSession } from "./adapter.js";
import {
  deleteNode,
  moveNode,
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

  for (const plan of plans) {
    const restoredNodes = await runRestorePlan(next, adapter, plan);
    if (restoredNodes.length > 0) {
      next = restoreNodes(next, restoredNodes);
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
    try {
      const restoredSession = await adapter.restoreSession(plan.sessionId);
      const restored = restoredFromSession(plan.nodeId, restoredSession);
      if (restored) {
        return [restored];
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
    const createdWindow = await adapter.createWindow({ url });
    const createdTab = createdWindow.tabs?.[0];
    if (!createdTab) {
      throw new Error("Created restore window did not include tabs");
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

function restoredFromSession(nodeId: NodeId, session: RestoredSession): RestoredNode | undefined {
  if (session.tab) {
    return restoredTabFromRuntime(nodeId, session.tab);
  }

  if (session.window) {
    return {
      nodeId,
      windowId: session.window.id
    };
  }

  return undefined;
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
