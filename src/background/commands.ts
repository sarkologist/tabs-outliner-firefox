import type { BrowserAdapter, RestoredSession } from "./adapter.js";
import {
  analyzeRestoreScope,
  deleteNode,
  flattenSubtreeOneLevel,
  moveNode,
  moveSubtreeToBottomTopLevel,
  moveSubtreeToTopLevel,
  moveTabToNewClosedWindow,
  moveTabToNewLiveWindow,
  planRestore,
  promoteChildrenOneLevel,
  projectLiveTabs,
  renameGroup,
  restoreNodes,
  updateMovedLiveSubtreeRuntimeWindow,
  wrapNodeInGroup
} from "../model/outline.js";
import { appendPortableTree } from "../model/portable-tree.js";
import type { RestoreScope } from "../model/outline.js";
import type { NodeId, OutlineNode, OutlineState, RestoreCreateTarget, RestoredNode, RestorePlan, RuntimeTab } from "../model/types.js";

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
      type: "analyzeRestoreScope";
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
      index?: number;
    }
  | {
      type: "wrapNodeInGroup";
      nodeId: NodeId;
    }
  | {
      type: "moveSubtreeToTopLevel";
      nodeId: NodeId;
    }
  | {
      type: "moveSubtreeToBottomTopLevel";
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
  "analyzeRestoreScope",
  "deleteNode",
  "moveNode",
  "moveNodeToNewWindow",
  "wrapNodeInGroup",
  "moveSubtreeToTopLevel",
  "moveSubtreeToBottomTopLevel",
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

const BLANK_RESTORE_CREATE_URL = "about:blank";

type WindowCreateBatchPlan = {
  nodeId: NodeId;
  url: string;
  windowNodeId: NodeId;
};

export type RestoreCreateAttempt =
  | {
      kind: "tab";
      nodeId: NodeId;
      windowNodeId?: NodeId;
      createProperties: { url: string; windowId?: number; active?: boolean };
    }
  | {
      kind: "window";
      windowNodeId: NodeId;
      tabNodeIds: NodeId[];
      urls?: string[];
      createData: { url?: string | string[]; tabId?: number };
    };

export type RestoreObserver = {
  recordCreateAttempt(attempt: RestoreCreateAttempt): void | Promise<void>;
};

export type CommandRunContext = {
  restoreObserver?: RestoreObserver;
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
  command: BackgroundCommand,
  context: CommandRunContext = {}
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
      return commandResultFromNextState(state, await restoreNode(state, adapter, command.nodeId, context.restoreObserver));
    }

    case "analyzeRestoreScope":
      return unchangedCommandResult(state);

    case "moveNode": {
      const node = state.nodes[command.nodeId];
      if (node?.kind === "tab" && !command.parentId) {
        return commandResultFromNextState(state, await moveNodeToNewWindow(state, adapter, command.nodeId, command.index));
      }

      let next = moveNode(state, command.nodeId, {
        ...(command.parentId ? { parentId: command.parentId } : {}),
        index: command.index
      });
      if (next !== state) {
        if (await syncMovedSubtreeBrowserOrder(next, command.nodeId, adapter)) {
          const targetWindow = nearestLiveWindow(next, command.nodeId);
          if (targetWindow) {
            next = updateMovedLiveSubtreeRuntimeWindow(
              next,
              state,
              command.nodeId,
              targetWindow.live.windowId,
              Date.now()
            );
          }
        } else {
          await syncBrowserOrder(next, adapter);
        }
      }
      return commandResultFromNextState(state, next);
    }

    case "moveNodeToNewWindow":
      return commandResultFromNextState(state, await moveNodeToNewWindow(state, adapter, command.nodeId, command.index));

    case "wrapNodeInGroup":
      return commandResultFromNextState(state, await wrapNodeInGroupCommand(state, adapter, command.nodeId));

    case "moveSubtreeToTopLevel":
      return commandResultFromNextState(state, await moveSubtreeToTopLevelCommand(state, adapter, command.nodeId));

    case "moveSubtreeToBottomTopLevel":
      return commandResultFromNextState(state, await moveSubtreeToBottomTopLevelCommand(state, adapter, command.nodeId));

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
  const errors: unknown[] = [];

  for (const windowId of plan.windowIds) {
    try {
      await adapter.closeWindow(windowId);
    } catch (error) {
      errors.push(error);
    }
  }

  if (plan.tabIds.length > 0) {
    try {
      await adapter.closeTabs(plan.tabIds);
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw errors[0];
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
  nodeId: NodeId,
  restoreObserver?: RestoreObserver
): Promise<OutlineState> {
  let next = state;
  const plans = planRestore(state, nodeId);
  const restoredWindowNodeIds = new Set<NodeId>();
  const coveredNodeIds = new Set<NodeId>();
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
    if (
      pendingNodeIds.has(plan.nodeId) ||
      coveredNodeIds.has(plan.nodeId) ||
      next.nodes[plan.nodeId]?.status !== "closed"
    ) {
      continue;
    }
    if (hasAncestor(plan.nodeId, restoredWindowNodeIds, next)) {
      continue;
    }

    const createBatch = closedWindowCreateBatchPlans(next, plans, index, pendingNodeIds, coveredNodeIds, restoredWindowNodeIds);
    if (createBatch.length > 1 && plan.windowNodeId) {
      const restoredNodes = await restoreClosedWindowCreateBatch(adapter, plan.windowNodeId, createBatch, restoreObserver);
      if (restoredNodes.length > 0) {
        appendRestoredNodes(restoredNodes);
        const coverage = restoredWindowDescendantCoverage(next, plan.windowNodeId, plans, restoredNodes);
        if (coverage.coveredWindowDescendants) {
          restoredWindowNodeIds.add(plan.windowNodeId);
        } else {
          for (const coveredNodeId of coverage.coveredNodeIds) {
            coveredNodeIds.add(coveredNodeId);
          }
          flushRestoredNodes();
        }
        continue;
      }
    }

    const restoredNodes = await runRestorePlan(next, adapter, plan, restoreObserver);
    if (restoredNodes.length > 0) {
      appendRestoredNodes(restoredNodes);
      const restoredWindowNodeId = restoredNodes.find((restored) => next.nodes[restored.nodeId]?.kind === "window")?.nodeId;
      const restoredTabSubgroupNodeId = restoredNodes.find((restored) => {
        const restoredNode = next.nodes[restored.nodeId];
        return restoredNode?.kind === "tab" && restoredNode.childIds.length > 0;
      })?.nodeId;
      if (restoredWindowNodeId) {
        const coverage = restoredWindowDescendantCoverage(next, restoredWindowNodeId, plans, restoredNodes);
        if (coverage.coveredWindowDescendants) {
          restoredWindowNodeIds.add(restoredWindowNodeId);
        } else {
          for (const coveredNodeId of coverage.coveredNodeIds) {
            coveredNodeIds.add(coveredNodeId);
          }
          flushRestoredNodes();
        }
      } else if (restoredTabSubgroupNodeId) {
        flushRestoredNodes();
      }
    }
  }

  flushRestoredNodes();
  return next;
}

function restoredWindowDescendantCoverage(
  state: OutlineState,
  windowNodeId: NodeId,
  plans: RestorePlan[],
  restoredNodes: RestoredNode[]
): { coveredWindowDescendants: boolean; coveredNodeIds: NodeId[] } {
  if (restoredWindowCoversPlannedScope(state, windowNodeId, plans, restoredNodes)) {
    return { coveredWindowDescendants: true, coveredNodeIds: [] };
  }
  if (restoredWindowRestoredAnyPlannedDescendant(state, windowNodeId, restoredNodes)) {
    return { coveredWindowDescendants: false, coveredNodeIds: [] };
  }

  return {
    coveredWindowDescendants: false,
    coveredNodeIds: restoredWindowShellCoveredDescendantNodeIds(state, windowNodeId, plans)
  };
}

function restoredWindowCoversPlannedScope(
  state: OutlineState,
  windowNodeId: NodeId,
  plans: RestorePlan[],
  restoredNodes: RestoredNode[]
): boolean {
  const restoredNodeIds = new Set(restoredNodes.map((restored) => restored.nodeId));
  if (!restoredNodeIds.has(windowNodeId)) {
    return false;
  }

  for (const plan of plans) {
    if (plan.nodeId === windowNodeId || !isDescendantOfNode(state, plan.nodeId, windowNodeId)) {
      continue;
    }
    if (state.nodes[plan.nodeId]?.status !== "closed") {
      continue;
    }
    if (!restoredNodeIds.has(plan.nodeId)) {
      return false;
    }
  }
  return true;
}

function restoredWindowRestoredAnyPlannedDescendant(
  state: OutlineState,
  windowNodeId: NodeId,
  restoredNodes: RestoredNode[]
): boolean {
  return restoredNodes.some((restored) =>
    restored.nodeId !== windowNodeId && isDescendantOfNode(state, restored.nodeId, windowNodeId)
  );
}

function restoredWindowShellCoveredDescendantNodeIds(
  state: OutlineState,
  windowNodeId: NodeId,
  plans: RestorePlan[]
): NodeId[] {
  const windowNode = state.nodes[windowNodeId];
  if (windowNode?.kind !== "window" || windowNode.status !== "closed" || typeof windowNode.closedAt !== "number") {
    return [];
  }

  const coveredNodeIds: NodeId[] = [];
  for (const plan of plans) {
    if (plan.nodeId === windowNodeId || !isDescendantOfNode(state, plan.nodeId, windowNodeId)) {
      continue;
    }

    const node = state.nodes[plan.nodeId];
    if (node?.status === "closed" && node.closedAt === windowNode.closedAt && !isImportedNodeId(node.id)) {
      coveredNodeIds.push(plan.nodeId);
    }
  }
  return coveredNodeIds;
}

function isImportedNodeId(nodeId: NodeId): boolean {
  return nodeId.startsWith("imported:");
}

function closedWindowCreateBatchPlans(
  state: OutlineState,
  plans: RestorePlan[],
  startIndex: number,
  pendingNodeIds: Set<NodeId>,
  coveredNodeIds: Set<NodeId>,
  restoredWindowNodeIds: Set<NodeId>
): WindowCreateBatchPlan[] {
  const firstPlan = tabCreateBatchPlanFromRestorePlan(state, plans[startIndex]);
  if (!firstPlan) {
    return [];
  }

  const plannedWindow = state.nodes[firstPlan.windowNodeId];
  if (
    plannedWindow?.kind !== "window" ||
    plannedWindow.status !== "closed"
  ) {
    return [];
  }

  const batch: WindowCreateBatchPlan[] = [];
  for (let index = startIndex; index < plans.length; index += 1) {
    const candidate = tabCreateBatchPlanFromRestorePlan(state, plans[index]);
    if (
      !candidate ||
      candidate.windowNodeId !== firstPlan.windowNodeId ||
      pendingNodeIds.has(candidate.nodeId) ||
      coveredNodeIds.has(candidate.nodeId) ||
      state.nodes[candidate.nodeId]?.status !== "closed" ||
      hasAncestor(candidate.nodeId, restoredWindowNodeIds, state)
    ) {
      continue;
    }
    batch.push(candidate);
  }

  return batch;
}

function tabCreateBatchPlanFromRestorePlan(
  state: OutlineState,
  plan: RestorePlan | undefined
): WindowCreateBatchPlan | undefined {
  const node = plan ? state.nodes[plan.nodeId] : undefined;
  if (!plan?.windowNodeId || node?.kind !== "tab" || node.childIds.length > 0) {
    return undefined;
  }

  const target = plan.kind === "create" ? plan.target : plan.fallbackTarget;
  return target
    ? { nodeId: plan.nodeId, url: createUrlForRestoreTarget(target), windowNodeId: plan.windowNodeId }
    : undefined;
}

async function restoreClosedWindowCreateBatch(
  adapter: BrowserAdapter,
  windowNodeId: NodeId,
  plans: WindowCreateBatchPlan[],
  restoreObserver?: RestoreObserver
): Promise<RestoredNode[]> {
  try {
    const urls = plans.map((plan) => plan.url);
    const createData = { url: urls };
    await restoreObserver?.recordCreateAttempt({
      kind: "window",
      windowNodeId,
      tabNodeIds: plans.map((plan) => plan.nodeId),
      urls,
      createData
    });
    const createdWindow = await adapter.createWindow(createData);
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
  } catch (error) {
    if (restoreObserver) {
      throw error;
    }
    return [];
  }
}

async function runRestorePlan(
  state: OutlineState,
  adapter: BrowserAdapter,
  plan: RestorePlan,
  restoreObserver?: RestoreObserver
): Promise<RestoredNode[]> {
  if (plan.kind === "session") {
    if (shouldCreateClosedWindowDestination(state, plan)) {
      const restoredInWindow = await restoreSessionIntoClosedWindowDestination(state, adapter, plan, restoreObserver);
      if (restoredInWindow.length > 0) {
        return restoredInWindow;
      }
    }

    try {
      const restoredSession = await adapter.restoreSession(plan.sessionId);
      const restored = restoredFromSession(state, plan, restoredSession);
      if (restored.length > 0) {
        return moveRestoredTabsIntoPlannedLiveWindow(state, adapter, plan, restored);
      }
    } catch {
      // Fall through to URL fallback below.
    }

    if (plan.fallbackTarget) {
      return tryCreateFallbackTab(state, adapter, plan.nodeId, plan.fallbackTarget, plan.windowNodeId, restoreObserver);
    }
    return [];
  }

  return tryCreateFallbackTab(state, adapter, plan.nodeId, plan.target, plan.windowNodeId, restoreObserver);
}

async function moveRestoredTabsIntoPlannedLiveWindow(
  state: OutlineState,
  adapter: BrowserAdapter,
  plan: RestorePlan,
  restoredNodes: RestoredNode[]
): Promise<RestoredNode[]> {
  if (!plan.windowNodeId) {
    return restoredNodes;
  }

  const plannedWindow = state.nodes[plan.windowNodeId];
  if (!isLiveWindow(plannedWindow)) {
    return restoredNodes;
  }

  const movedNodes: RestoredNode[] = [];
  for (const restored of restoredNodes) {
    if (typeof restored.tabId !== "number") {
      if (restored.nodeId !== plan.windowNodeId) {
        movedNodes.push(restored);
      }
      continue;
    }

    if (restored.windowId === plannedWindow.live.windowId) {
      movedNodes.push(restored);
      continue;
    }

    await adapter.moveTabs([restored.tabId], {
      windowId: plannedWindow.live.windowId,
      index: restoredTabTargetIndex(state, plannedWindow.id, restored.nodeId)
    });
    movedNodes.push({
      ...restored,
      windowId: plannedWindow.live.windowId
    });
  }

  return movedNodes;
}

function restoredTabTargetIndex(state: OutlineState, windowNodeId: NodeId, nodeId: NodeId): number {
  const tabNodeIds = collectSubtreeEntries(state, windowNodeId)
    .map((entry) => entry.node)
    .filter((node) => node.kind === "tab")
    .map((node) => node.id);
  const index = tabNodeIds.indexOf(nodeId);
  return index >= 0 ? index : tabNodeIds.length;
}

async function restoreSessionIntoClosedWindowDestination(
  state: OutlineState,
  adapter: BrowserAdapter,
  plan: Extract<RestorePlan, { kind: "session" }>,
  restoreObserver?: RestoreObserver
): Promise<RestoredNode[]> {
  let restoredSession: Awaited<ReturnType<BrowserAdapter["restoreSession"]>> | undefined;
  try {
    restoredSession = await adapter.restoreSession(plan.sessionId);
  } catch {
    // Fall through to URL fallback below.
  }

  if (restoredSession?.tab && plan.windowNodeId) {
    const createData = { tabId: restoredSession.tab.id };
    await restoreObserver?.recordCreateAttempt({
      kind: "window",
      windowNodeId: plan.windowNodeId,
      tabNodeIds: [plan.nodeId],
      createData
    });
    const createdWindow = await adapter.createWindow(createData);
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

  if (restoredSession) {
    const restored = restoredFromSession(state, plan, restoredSession);
    if (restored.length > 0) {
      return restored;
    }
  }

  return plan.fallbackTarget
    ? tryCreateFallbackTab(state, adapter, plan.nodeId, plan.fallbackTarget, plan.windowNodeId, restoreObserver)
    : [];
}

function shouldCreateClosedWindowDestination(state: OutlineState, plan: RestorePlan): boolean {
  if (!plan.windowNodeId) {
    return false;
  }

  const plannedWindow = state.nodes[plan.windowNodeId];
  const plannedNode = state.nodes[plan.nodeId];
  return Boolean(
    plannedNode?.kind === "tab" &&
      plannedNode.childIds.length === 0 &&
      plannedWindow?.kind === "window" &&
      plannedWindow.status === "closed" &&
      !plannedWindow.restore?.sessionId
  );
}

async function createFallbackTab(
  state: OutlineState,
  adapter: BrowserAdapter,
  nodeId: NodeId,
  target: RestoreCreateTarget,
  windowNodeId?: NodeId,
  restoreObserver?: RestoreObserver
): Promise<RestoredNode[]> {
  const plannedWindow = windowNodeId ? state.nodes[windowNodeId] : undefined;
  const liveTabAncestor = nearestLiveTabAncestor(state, nodeId);
  if (isLiveWindow(plannedWindow)) {
    const createUrl = createUrlForRestoreTarget(target);
    const createProperties = {
      url: createUrl,
      windowId: plannedWindow.live.windowId,
      active: false
    };
    await restoreObserver?.recordCreateAttempt({
      kind: "tab",
      nodeId,
      ...(windowNodeId ? { windowNodeId } : {}),
      createProperties
    });
    const created = await adapter.createTab(createProperties);
    return [restoredTabFromRuntime(nodeId, created)];
  }

  if (liveTabAncestor?.live && "tabId" in liveTabAncestor.live) {
    const createUrl = createUrlForRestoreTarget(target);
    const createProperties = {
      url: createUrl,
      windowId: liveTabAncestor.live.windowId,
      active: false
    };
    await restoreObserver?.recordCreateAttempt({
      kind: "tab",
      nodeId,
      createProperties
    });
    const created = await adapter.createTab(createProperties);
    return [restoredTabFromRuntime(nodeId, created)];
  }

  const plannedNode = state.nodes[nodeId];
  if (
    plannedWindow?.kind === "window" &&
    plannedWindow.status === "closed" &&
    windowNodeId &&
    plannedNode?.kind === "tab" &&
    plannedNode.childIds.length === 0
  ) {
    const sessionRestored = closedWindowHasOnlyTab(state, windowNodeId, nodeId)
      ? await restoreClosedWindowSessionForTab(state, adapter, nodeId, plannedWindow)
      : [];
    if (sessionRestored.length > 0) {
      return sessionRestored;
    }

    const createUrl = createUrlForRestoreTarget(target);
    const createData = { url: createUrl };
    await restoreObserver?.recordCreateAttempt({
      kind: "window",
      windowNodeId,
      tabNodeIds: [nodeId],
      urls: [createUrl],
      createData
    });
    const createdWindow = await adapter.createWindow(createData);
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
  const createUrl = createUrlForRestoreTarget(target);
  const createProperties = {
    url: createUrl,
    ...(parentWindow ? { windowId: parentWindow.live.windowId } : {}),
    active: false
  };
  await restoreObserver?.recordCreateAttempt({
    kind: "tab",
    nodeId,
    ...(parentWindow ? { windowNodeId: parentWindow.id } : {}),
    createProperties
  });
  const created = await adapter.createTab(createProperties);

  return [restoredTabFromRuntime(nodeId, created)];
}

function nearestLiveTabAncestor(state: OutlineState, nodeId: NodeId): OutlineState["nodes"][string] | undefined {
  const visited = new Set<NodeId>([nodeId]);
  let currentId = state.nodes[nodeId]?.parentId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const current = state.nodes[currentId];
    if (!current) {
      return undefined;
    }
    if (current.kind === "tab" && current.status === "live" && current.live && "tabId" in current.live) {
      return current;
    }
    currentId = current.parentId;
  }
  return undefined;
}

async function tryCreateFallbackTab(
  state: OutlineState,
  adapter: BrowserAdapter,
  nodeId: NodeId,
  target: RestoreCreateTarget,
  windowNodeId?: NodeId,
  restoreObserver?: RestoreObserver
): Promise<RestoredNode[]> {
  return createFallbackTab(state, adapter, nodeId, target, windowNodeId, restoreObserver);
}

function createUrlForRestoreTarget(target: RestoreCreateTarget): string {
  return target.kind === "blank" ? BLANK_RESTORE_CREATE_URL : target.url;
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
    await moveRemainingLiveSubtreeTabsIntoCreatedWindow(
      state,
      adapter,
      nodeId,
      node.live.tabId,
      createdWindow.id
    );
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
    await moveRemainingLiveSubtreeTabsIntoCreatedWindow(
      state,
      adapter,
      nodeId,
      node.live.tabId,
      createdWindow.id
    );
    const next = wrapNodeInGroup(state, nodeId, {
      now: Date.now(),
      liveWindow: createdWindow
    });
    return next;
  }

  return wrapNodeInGroup(state, nodeId, { now: Date.now() });
}

async function moveSubtreeToTopLevelCommand(
  state: OutlineState,
  adapter: BrowserAdapter,
  nodeId: NodeId
): Promise<OutlineState> {
  const node = state.nodes[nodeId];
  if (!node) {
    return state;
  }

  if (isLiveTab(node) && node.parentId) {
    const createdWindow = await adapter.createWindow({ tabId: node.live.tabId });
    await moveRemainingLiveSubtreeTabsIntoCreatedWindow(
      state,
      adapter,
      nodeId,
      node.live.tabId,
      createdWindow.id
    );
    return moveSubtreeToTopLevel(state, nodeId, {
      now: Date.now(),
      liveWindow: createdWindow
    });
  }

  return moveSubtreeToTopLevel(state, nodeId, { now: Date.now() });
}

async function moveSubtreeToBottomTopLevelCommand(
  state: OutlineState,
  adapter: BrowserAdapter,
  nodeId: NodeId
): Promise<OutlineState> {
  const node = state.nodes[nodeId];
  if (!node) {
    return state;
  }

  if (isLiveTab(node) && node.parentId) {
    const createdWindow = await adapter.createWindow({ tabId: node.live.tabId });
    await moveRemainingLiveSubtreeTabsIntoCreatedWindow(
      state,
      adapter,
      nodeId,
      node.live.tabId,
      createdWindow.id
    );
    return moveSubtreeToBottomTopLevel(state, nodeId, {
      now: Date.now(),
      liveWindow: createdWindow
    });
  }

  return moveSubtreeToBottomTopLevel(state, nodeId, { now: Date.now() });
}

async function moveRemainingLiveSubtreeTabsIntoCreatedWindow(
  state: OutlineState,
  adapter: BrowserAdapter,
  nodeId: NodeId,
  createdFromTabId: number,
  windowId: number
): Promise<void> {
  const remainingTabIds = liveTabIdsInSubtreeExcludingNestedLiveWindows(state, nodeId)
    .filter((tabId) => tabId !== createdFromTabId);

  if (remainingTabIds.length > 0) {
    await adapter.moveTabs(remainingTabIds, { windowId, index: 1 });
  }
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
    const plannedNode = state.nodes[plan.nodeId];
    if (plannedNode?.kind === "window") {
      return [
        {
          nodeId: plannedNode.id,
          windowId: session.tab.windowId
        },
        ...restoredTabsFromWindowSession(state, plan, plannedNode.id, [session.tab])
      ];
    }
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
  const unmatchedNodes: OutlineNode[] = [];

  for (const node of tabNodes) {
    const matchIndex = matchingRestoredTabIndex(node, availableTabs);
    if (matchIndex < 0) {
      unmatchedNodes.push(node);
      continue;
    }

    const [tab] = availableTabs.splice(matchIndex, 1);
    if (tab) {
      restored.push(restoredTabFromRuntime(node.id, tab));
    }
  }

  // Restored session tabs may report a post-login/final URL; keep the closed window's original order as fallback.
  for (const node of unmatchedNodes) {
    const tab = availableTabs.shift();
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

function isDescendantOfNode(state: OutlineState, nodeId: NodeId, ancestorId: NodeId): boolean {
  let current = state.nodes[nodeId];
  const seen = new Set<NodeId>();

  while (current?.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.parentId === ancestorId) {
      return true;
    }
    current = state.nodes[current.parentId];
  }

  return false;
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

    const tabIds = liveTabIdsAlreadyInRuntimeWindow(state, root.id, root.live.windowId);

    if (tabIds.length > 0) {
      await adapter.moveTabs(tabIds, { windowId: root.live.windowId, index: 0 });
    }
  }
}

function liveTabIdsAlreadyInRuntimeWindow(
  state: OutlineState,
  windowNodeId: NodeId,
  runtimeWindowId: number
): number[] {
  const tabIds: number[] = [];
  const visited = new Set<NodeId>();
  const stack = [...(state.nodes[windowNodeId]?.childIds ?? [])].reverse();

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
      continue;
    }
    if (isLiveTab(node) && node.live.windowId === runtimeWindowId) {
      tabIds.push(node.live.tabId);
    }
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push(node.childIds[index]!);
    }
  }

  return tabIds;
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

function liveTabIdsInSubtreeExcludingNestedLiveWindows(state: OutlineState, nodeId: NodeId): number[] {
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
    if (currentId !== nodeId && isLiveWindow(node)) {
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
