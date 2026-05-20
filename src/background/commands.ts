import type { BrowserAdapter, RestoredSession } from "./adapter.js";
import {
  analyzeRestoreScope,
  deleteNode,
  flattenSubtreeOneLevel,
  moveNode,
  moveTabToNewClosedWindow,
  moveTabToNewLiveWindow,
  planRestore,
  promoteChildrenOneLevel,
  projectLiveTabs,
  renameGroup,
  restoreNodes,
  wrapNodeInGroup
} from "../model/outline.js";
import { appendPortableTree } from "../model/portable-tree.js";
import type { RestoreScope } from "../model/outline.js";
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
      confirmedLargeRestore?: boolean;
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
      index?: number;
    }
  | {
      type: "wrapNodeInGroup";
      nodeId: NodeId;
    }
  | {
      type: "flattenSubtree";
      nodeId: NodeId;
    }
  | {
      type: "promoteChildren";
      nodeId: NodeId;
    }
  | {
      type: "toggleCollapsed";
      nodeId: NodeId;
    }
  | {
      type: "expandAncestors";
      nodeId: NodeId;
    }
  | {
      type: "renameGroup";
      nodeId: NodeId;
      title: string;
    }
  | {
      type: "importTree";
      tree: unknown;
    }
  | {
      type: "undo";
    }
  | {
      type: "redo";
    }
  | {
      type: "getHistoryStatus";
    }
  | {
      type: "refresh";
    };

export const BACKGROUND_COMMAND_TYPES = [
  "getState",
  "focusNode",
  "closeNode",
  "restoreNode",
  "deleteNode",
  "moveNode",
  "moveNodeToNewWindow",
  "wrapNodeInGroup",
  "flattenSubtree",
  "promoteChildren",
  "toggleCollapsed",
  "expandAncestors",
  "renameGroup",
  "importTree",
  "undo",
  "redo",
  "getHistoryStatus",
  "refresh"
] as const satisfies readonly BackgroundCommand["type"][];

type MissingBackgroundCommandTypes = Exclude<BackgroundCommand["type"], (typeof BACKGROUND_COMMAND_TYPES)[number]>;
const backgroundCommandTypesAreExhaustive: Record<MissingBackgroundCommandTypes, never> = {};
void backgroundCommandTypesAreExhaustive;

const BACKGROUND_COMMAND_TYPE_SET: ReadonlySet<string> = new Set(BACKGROUND_COMMAND_TYPES);

export type CommandResult = {
  state: OutlineState;
  changed: boolean;
};

export type CommandAck = {
  type: "commandAck";
  stateChanged: boolean;
};

export type RuntimeClosePlan = {
  windowIds: number[];
  tabIds: number[];
};

// Runtime boundary for extension messages. It intentionally validates command type only,
// preserving the existing sidebar payload contract.
export function isBackgroundCommand(message: unknown): message is BackgroundCommand {
  if (!message || typeof message !== "object" || !("type" in message)) {
    return false;
  }

  const type = (message as { type: unknown }).type;
  return typeof type === "string" && BACKGROUND_COMMAND_TYPE_SET.has(type);
}

export async function runCommand(
  state: OutlineState,
  adapter: BrowserAdapter,
  command: BackgroundCommand
): Promise<CommandResult> {
  switch (command.type) {
    case "getState":
      return unchangedCommandResult(state);

    case "refresh":
      return unchangedCommandResult(state);

    case "undo":
      return unchangedCommandResult(state);

    case "redo":
      return unchangedCommandResult(state);

    case "getHistoryStatus":
      return unchangedCommandResult(state);

    case "focusNode": {
      const node = state.nodes[command.nodeId];
      if (isLiveTab(node)) {
        await adapter.focusTab(node.live.tabId, node.live.windowId);
      }
      return unchangedCommandResult(state);
    }

    case "closeNode": {
      const node = state.nodes[command.nodeId];
      if (isLiveTab(node)) {
        await adapter.closeTabs([node.live.tabId]);
      } else if (isLiveWindow(node)) {
        await adapter.closeWindow(node.live.windowId);
      } else {
        await closeRuntimePlan(adapter, planLiveSubtreeClose(state, command.nodeId));
      }
      return unchangedCommandResult(state);
    }

    case "restoreNode": {
      const scope = analyzeRestoreScope(state, command.nodeId);
      if (scope.requiresConfirmation && !command.confirmedLargeRestore) {
        throw new Error(largeRestoreConfirmationError(scope));
      }
      return commandResultFromNextState(state, await restoreNode(state, adapter, command.nodeId));
    }

    case "moveNode": {
      const node = state.nodes[command.nodeId];
      if (node?.kind === "tab" && !command.parentId) {
        return commandResultFromNextState(state, await moveNodeToNewWindow(state, adapter, command.nodeId, command.index));
      }

      const next = moveNode(state, command.nodeId, {
        ...(command.parentId ? { parentId: command.parentId } : {}),
        index: command.index
      });
      if (next !== state && !(await syncMovedSubtreeBrowserOrder(next, command.nodeId, adapter))) {
        await syncBrowserOrder(next, adapter);
      }
      return commandResultFromNextState(state, next);
    }

    case "moveNodeToNewWindow":
      return commandResultFromNextState(state, await moveNodeToNewWindow(state, adapter, command.nodeId, command.index));

    case "wrapNodeInGroup":
      return commandResultFromNextState(state, await wrapNodeInGroupCommand(state, adapter, command.nodeId));

    case "flattenSubtree":
      return commandResultFromNextState(state, flattenSubtreeOneLevel(state, command.nodeId));

    case "promoteChildren":
      return commandResultFromNextState(state, promoteChildrenOneLevel(state, command.nodeId));

    case "toggleCollapsed":
      return toggleCollapsedInPlace(state, command.nodeId)
        ? changedCommandResult(state)
        : unchangedCommandResult(state);

    case "expandAncestors":
      return expandAncestorsInPlace(state, command.nodeId)
        ? changedCommandResult(state)
        : unchangedCommandResult(state);

    case "renameGroup":
      return commandResultFromNextState(state, renameGroup(state, command.nodeId, command.title, { now: Date.now() }));

    case "importTree":
      return commandResultFromNextState(state, appendPortableTree(state, command.tree, { now: Date.now() }));

    case "deleteNode": {
      if (!state.nodes[command.nodeId]) {
        return unchangedCommandResult(state);
      }

      await closeLiveSubtree(state, adapter, command.nodeId);
      return commandResultFromNextState(state, deleteNode(state, command.nodeId, { allowLive: true }));
    }
  }
}

function unchangedCommandResult(state: OutlineState): CommandResult {
  return {
    state,
    changed: false
  };
}

function changedCommandResult(state: OutlineState): CommandResult {
  return {
    state,
    changed: true
  };
}

function commandResultFromNextState(previous: OutlineState, next: OutlineState): CommandResult {
  return {
    state: next,
    changed: next !== previous
  };
}

function largeRestoreConfirmationError(scope: RestoreScope): string {
  return `Restoring ${scope.totalCount} restorable closed nodes requires confirmation before opening more than ${scope.threshold} nodes at once.`;
}

async function closeLiveSubtree(
  state: OutlineState,
  adapter: BrowserAdapter,
  nodeId: NodeId
): Promise<void> {
  await closeRuntimePlan(adapter, planLiveSubtreeClose(state, nodeId));
}

async function closeRuntimePlan(adapter: BrowserAdapter, plan: RuntimeClosePlan): Promise<void> {
  for (const windowId of plan.windowIds) {
    await adapter.closeWindow(windowId);
  }

  if (plan.tabIds.length > 0) {
    await adapter.closeTabs(plan.tabIds);
  }
}

export function planLiveSubtreeClose(state: OutlineState, nodeId: NodeId): RuntimeClosePlan {
  const windowIds: number[] = [];
  const tabEntries: Array<{ tabId: number; depth: number; order: number }> = [];
  const visited = new Set<NodeId>();
  const stack: Array<{ nodeId: NodeId; depth: number; coveredByLiveWindow: boolean }> = [
    { nodeId, depth: 0, coveredByLiveWindow: false }
  ];
  let order = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current.nodeId)) {
      continue;
    }
    visited.add(current.nodeId);

    const node = state.nodes[current.nodeId];
    if (!node) {
      continue;
    }

    const currentOrder = order;
    order += 1;
    const liveWindow = isLiveWindow(node);
    if (liveWindow) {
      windowIds.push(node.live.windowId);
    } else if (isLiveTab(node) && !current.coveredByLiveWindow) {
      tabEntries.push({ tabId: node.live.tabId, depth: current.depth, order: currentOrder });
    }

    const childCoveredByLiveWindow = current.coveredByLiveWindow || liveWindow;
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push({
        nodeId: node.childIds[index]!,
        depth: current.depth + 1,
        coveredByLiveWindow: childCoveredByLiveWindow
      });
    }
  }

  tabEntries.sort((left, right) => right.depth - left.depth || left.order - right.order);

  return {
    windowIds,
    tabIds: tabEntries.map((entry) => entry.tabId)
  };
}

type SubtreeEntry = {
  node: OutlineNode;
  depth: number;
};

function collectSubtreeEntries(
  state: OutlineState,
  nodeId: NodeId
): SubtreeEntry[] {
  const entries: SubtreeEntry[] = [];
  const visited = new Set<NodeId>();
  const stack: Array<{ nodeId: NodeId; depth: number }> = [{ nodeId, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current.nodeId)) {
      continue;
    }
    visited.add(current.nodeId);

    const node = state.nodes[current.nodeId];
    if (!node) {
      continue;
    }

    entries.push({ node, depth: current.depth });
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push({ nodeId: node.childIds[index]!, depth: current.depth + 1 });
    }
  }

  return entries;
}

async function restoreNode(
  state: OutlineState,
  adapter: BrowserAdapter,
  nodeId: NodeId
): Promise<OutlineState> {
  let next = state;
  const plans = planRestore(state, nodeId);
  const restoredWindowNodeIds = new Set<NodeId>();
  const pendingNodeIds = new Set<NodeId>();
  let pendingRestoredNodes: RestoredNode[] = [];

  const appendRestoredNodes = (restoredNodes: RestoredNode[]): void => {
    for (const restored of restoredNodes) {
      if (pendingNodeIds.has(restored.nodeId)) {
        continue;
      }
      pendingNodeIds.add(restored.nodeId);
      pendingRestoredNodes.push(restored);
    }
  };

  const flushRestoredNodes = (): void => {
    if (pendingRestoredNodes.length === 0) {
      return;
    }
    next = restoreNodes(next, pendingRestoredNodes);
    pendingRestoredNodes = [];
    pendingNodeIds.clear();
  };

  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index]!;
    if (pendingNodeIds.has(plan.nodeId) || next.nodes[plan.nodeId]?.status !== "closed") {
      continue;
    }
    if (hasAncestor(plan.nodeId, restoredWindowNodeIds, next)) {
      continue;
    }

    const urlBatch = closedWindowUrlBatchPlans(next, plans, index, pendingNodeIds, restoredWindowNodeIds);
    if (urlBatch.length > 1 && plan.windowNodeId) {
      const restoredNodes = await restoreClosedWindowUrlBatch(adapter, plan.windowNodeId, urlBatch);
      if (restoredNodes.length > 0) {
        appendRestoredNodes(restoredNodes);
        restoredWindowNodeIds.add(plan.windowNodeId);
        continue;
      }
    }

    const planNodeIsWindow = next.nodes[plan.nodeId]?.kind === "window";
    const restoredNodes = await runRestorePlan(next, adapter, plan);
    if (restoredNodes.length > 0) {
      appendRestoredNodes(restoredNodes);
      if (planNodeIsWindow && restoredNodes.some((restored) => restored.nodeId === plan.nodeId)) {
        restoredWindowNodeIds.add(plan.nodeId);
      }
    }
  }

  flushRestoredNodes();
  return next;
}

function closedWindowUrlBatchPlans(
  state: OutlineState,
  plans: RestorePlan[],
  startIndex: number,
  pendingNodeIds: Set<NodeId>,
  restoredWindowNodeIds: Set<NodeId>
): Array<Extract<RestorePlan, { kind: "url" }>> {
  const firstPlan = plans[startIndex];
  if (
    !firstPlan ||
    firstPlan.kind !== "url" ||
    !firstPlan.windowNodeId ||
    isPrivilegedAboutUrl(firstPlan.url)
  ) {
    return [];
  }

  const plannedWindow = state.nodes[firstPlan.windowNodeId];
  if (
    plannedWindow?.kind !== "window" ||
    plannedWindow.status !== "closed" ||
    plannedWindow.restore?.sessionId
  ) {
    return [];
  }

  const batch: Array<Extract<RestorePlan, { kind: "url" }>> = [];
  for (let index = startIndex; index < plans.length; index += 1) {
    const candidate = plans[index];
    if (
      candidate?.kind !== "url" ||
      candidate.windowNodeId !== firstPlan.windowNodeId ||
      isPrivilegedAboutUrl(candidate.url) ||
      pendingNodeIds.has(candidate.nodeId) ||
      state.nodes[candidate.nodeId]?.status !== "closed" ||
      hasAncestor(candidate.nodeId, restoredWindowNodeIds, state)
    ) {
      continue;
    }
    batch.push(candidate);
  }

  return batch;
}

async function restoreClosedWindowUrlBatch(
  adapter: BrowserAdapter,
  windowNodeId: NodeId,
  plans: Array<Extract<RestorePlan, { kind: "url" }>>
): Promise<RestoredNode[]> {
  try {
    const createdWindow = await adapter.createWindow({ url: plans.map((plan) => plan.url) });
    const availableTabs = [...(createdWindow.tabs ?? [])];
    const restored: RestoredNode[] = [
      {
        nodeId: windowNodeId,
        windowId: createdWindow.id,
        active: createdWindow.focused
      }
    ];

    for (const plan of plans) {
      const matchingIndex = availableTabs.findIndex((tab) => tab.url === plan.url);
      const [tab] = matchingIndex >= 0
        ? availableTabs.splice(matchingIndex, 1)
        : availableTabs.splice(0, 1);
      if (tab) {
        restored.push(restoredTabFromRuntime(plan.nodeId, tab));
      }
    }

    return restored;
  } catch {
    return [];
  }
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
      return tryCreateFallbackTab(state, adapter, plan.nodeId, plan.fallbackUrl, plan.windowNodeId);
    }
    return [];
  }

  return tryCreateFallbackTab(state, adapter, plan.nodeId, plan.url, plan.windowNodeId);
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
          windowId: createdWindow.id,
          active: createdWindow.focused
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

  return plan.fallbackUrl ? tryCreateFallbackTab(state, adapter, plan.nodeId, plan.fallbackUrl, plan.windowNodeId) : [];
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
          windowId: createdWindow.id,
          active: createdWindow.focused
        }
      ];
    }

    return [
      {
        nodeId: windowNodeId,
        windowId: createdWindow.id,
        active: createdWindow.focused
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

async function tryCreateFallbackTab(
  state: OutlineState,
  adapter: BrowserAdapter,
  nodeId: NodeId,
  url: string,
  windowNodeId?: NodeId
): Promise<RestoredNode[]> {
  try {
    return await createFallbackTab(state, adapter, nodeId, url, windowNodeId);
  } catch (error) {
    if (isPrivilegedAboutUrl(url)) {
      return [];
    }
    throw error;
  }
}

function isPrivilegedAboutUrl(url: string): boolean {
  const lowerUrl = url.toLocaleLowerCase();
  return lowerUrl.startsWith("about:") && lowerUrl !== "about:blank" && lowerUrl !== "about:newtab";
}

async function moveNodeToNewWindow(
  state: OutlineState,
  adapter: BrowserAdapter,
  nodeId: NodeId,
  rootIndex?: number
): Promise<OutlineState> {
  const node = state.nodes[nodeId];
  if (!node || node.kind !== "tab") {
    return state;
  }

  if (isLiveTab(node)) {
    const createdWindow = await adapter.createWindow({ tabId: node.live.tabId });
    const next = moveTabToNewLiveWindow(state, nodeId, createdWindow, {
      now: Date.now(),
      ...(typeof rootIndex === "number" ? { rootIndex } : {})
    });
    await syncBrowserOrder(next, adapter);
    return next;
  }

  if (node.status === "closed") {
    return moveTabToNewClosedWindow(state, nodeId, {
      now: Date.now(),
      ...(typeof rootIndex === "number" ? { rootIndex } : {})
    });
  }

  return state;
}

async function wrapNodeInGroupCommand(
  state: OutlineState,
  adapter: BrowserAdapter,
  nodeId: NodeId
): Promise<OutlineState> {
  const node = state.nodes[nodeId];
  if (!node) {
    return state;
  }

  if (isLiveTab(node)) {
    const createdWindow = await adapter.createWindow({ tabId: node.live.tabId });
    const next = wrapNodeInGroup(state, nodeId, {
      now: Date.now(),
      liveWindow: createdWindow
    });
    await syncBrowserOrder(next, adapter);
    return next;
  }

  return wrapNodeInGroup(state, nodeId, { now: Date.now() });
}

function restoredTabFromRuntime(nodeId: NodeId, tab: RuntimeTab): RestoredNode {
  return {
    nodeId,
    tabId: tab.id,
    windowId: tab.windowId,
    active: tab.active,
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
        windowId: session.window.id,
        active: session.window.focused
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

export async function syncBrowserOrder(state: OutlineState, adapter: BrowserAdapter): Promise<void> {
  const liveWindows = Object.values(state.nodes)
    .filter((node): node is LiveWindowNode => isLiveWindow(node))
    .sort((left, right) => firstVisibleIndex(state, left.id) - firstVisibleIndex(state, right.id));

  for (const root of liveWindows) {
    if (!isLiveWindow(root)) {
      continue;
    }

    const projection = projectLiveTabs(state, root.id);
    const tabIds = projection
      .filter((tab) => tab.windowId === root.live.windowId)
      .map((tab) => tab.tabId);

    if (tabIds.length > 0) {
      await adapter.moveTabs(tabIds, { windowId: root.live.windowId, index: 0 });
    }
  }
}

async function syncMovedSubtreeBrowserOrder(
  state: OutlineState,
  nodeId: NodeId,
  adapter: BrowserAdapter
): Promise<boolean> {
  const node = state.nodes[nodeId];
  if (!node || subtreeContainsLiveWindow(state, nodeId)) {
    return false;
  }

  if (isLiveTab(node) && node.childIds.length === 0 && node.parentId) {
    const parent = state.nodes[node.parentId];
    if (isLiveWindow(parent)) {
      const tabIndex = parent.childIds.indexOf(node.id);
      if (tabIndex < 0) {
        return false;
      }
      await adapter.moveTabs([node.live.tabId], { windowId: parent.live.windowId, index: tabIndex });
      return true;
    }
  }

  const movedTabIds = liveTabIdsInSubtree(state, nodeId);
  if (movedTabIds.length === 0) {
    return true;
  }

  const targetWindow = nearestLiveWindow(state, nodeId);
  if (!targetWindow) {
    return false;
  }

  const movedTabIdSet = new Set(movedTabIds);
  const targetWindowTabs = projectLiveTabs(state, targetWindow.id)
    .filter((tab) => tab.windowId === targetWindow.live.windowId);
  const targetIndex = targetWindowTabs.findIndex((tab) => movedTabIdSet.has(tab.tabId));
  if (targetIndex < 0) {
    return false;
  }

  const movedTabsInTargetOrder = targetWindowTabs
    .filter((tab) => movedTabIdSet.has(tab.tabId))
    .map((tab) => tab.tabId);
  if (movedTabsInTargetOrder.length !== movedTabIds.length) {
    return false;
  }

  await adapter.moveTabs(movedTabsInTargetOrder, { windowId: targetWindow.live.windowId, index: targetIndex });
  return true;
}

function liveTabIdsInSubtree(state: OutlineState, nodeId: NodeId): number[] {
  const tabIds: number[] = [];
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
    if (isLiveTab(node)) {
      tabIds.push(node.live.tabId);
    }
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push(node.childIds[index]!);
    }
  }

  return tabIds;
}

function subtreeContainsLiveWindow(state: OutlineState, nodeId: NodeId): boolean {
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
    if (isLiveWindow(node)) {
      return true;
    }
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push(node.childIds[index]!);
    }
  }

  return false;
}

function firstVisibleIndex(state: OutlineState, nodeId: NodeId): number {
  const visited = new Set<NodeId>();
  const stack = [...state.rootIds].reverse();
  let index = 0;

  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);
    if (currentId === nodeId) {
      return index;
    }
    index += 1;

    const node = state.nodes[currentId];
    if (!node) {
      continue;
    }
    for (let childIndex = node.childIds.length - 1; childIndex >= 0; childIndex -= 1) {
      stack.push(node.childIds[childIndex]!);
    }
  }

  return Number.MAX_SAFE_INTEGER;
}

function toggleCollapsedInPlace(state: OutlineState, nodeId: NodeId): boolean {
  const node = state.nodes[nodeId];
  if (!node) {
    return false;
  }

  node.collapsed = !node.collapsed;
  return true;
}

function expandAncestorsInPlace(state: OutlineState, nodeId: NodeId): boolean {
  let changed = false;
  const visited = new Set<NodeId>();
  let parentId = state.nodes[nodeId]?.parentId;

  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = state.nodes[parentId];
    if (!parent) {
      break;
    }

    if (parent.collapsed) {
      parent.collapsed = false;
      changed = true;
    }
    parentId = parent.parentId;
  }

  return changed;
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
