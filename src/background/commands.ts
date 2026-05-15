import type { BrowserAdapter, RestoredSession } from "./adapter.js";
import {
  moveNode,
  planRestore,
  projectLiveTabs,
  restoreNodes
} from "../model/outline.js";
import type { NodeId, OutlineNode, OutlineState, RestoredNode, RestorePlan } from "../model/types.js";

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
      const { deleteNode } = await import("../model/outline.js");
      return { state: deleteNode(state, command.nodeId) };
    }
  }
}

async function restoreNode(
  state: OutlineState,
  adapter: BrowserAdapter,
  nodeId: NodeId
): Promise<OutlineState> {
  let next = state;
  const plans = planRestore(state, nodeId);

  for (const plan of plans) {
    const restored = await runRestorePlan(next, adapter, plan);
    if (restored) {
      next = restoreNodes(next, [restored]);
    }
  }

  return next;
}

async function runRestorePlan(
  state: OutlineState,
  adapter: BrowserAdapter,
  plan: RestorePlan
): Promise<RestoredNode | undefined> {
  if (plan.kind === "session") {
    try {
      const restoredSession = await adapter.restoreSession(plan.sessionId);
      const restored = restoredFromSession(plan.nodeId, restoredSession);
      if (restored) {
        return restored;
      }
    } catch {
      // Fall through to URL fallback below.
    }

    if (plan.fallbackUrl) {
      return createFallbackTab(state, adapter, plan.nodeId, plan.fallbackUrl);
    }
    return undefined;
  }

  return createFallbackTab(state, adapter, plan.nodeId, plan.url);
}

async function createFallbackTab(
  state: OutlineState,
  adapter: BrowserAdapter,
  nodeId: NodeId,
  url: string
): Promise<RestoredNode> {
  const parentWindow = nearestLiveWindow(state, nodeId);
  const created = await adapter.createTab({
    url,
    ...(parentWindow ? { windowId: parentWindow.live.windowId } : {}),
    active: false
  });

  return {
    nodeId,
    tabId: created.id,
    windowId: created.windowId,
    ...(created.url ? { url: created.url } : {}),
    ...(created.title ? { title: created.title } : {}),
    ...(created.favIconUrl ? { favIconUrl: created.favIconUrl } : {})
  };
}

function restoredFromSession(nodeId: NodeId, session: RestoredSession): RestoredNode | undefined {
  if (session.tab) {
    return {
      nodeId,
      tabId: session.tab.id,
      windowId: session.tab.windowId,
      ...(session.tab.url ? { url: session.tab.url } : {}),
      ...(session.tab.title ? { title: session.tab.title } : {}),
      ...(session.tab.favIconUrl ? { favIconUrl: session.tab.favIconUrl } : {})
    };
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
