import {
  isLiveTabNode,
  isLiveWindowNode,
  type LiveTabNode,
  type LiveWindowNode
} from "../model/live-nodes.js";
import type { NodeId, OutlineNode, OutlineState, RuntimeWindow } from "../model/types.js";

export type RuntimeWindowScopeProvenance = "saved" | "restored" | "browserCreated" | "commandCreated";
export type RuntimeWindowScopeLifecycle = "live" | "closing" | "removed";

export type RuntimeWindowScope = {
  runtimeWindowId: number;
  outlineWindowNodeId?: NodeId;
  tabNodeIdsByRuntimeId: Map<number, NodeId>;
  tabOrder: number[];
  activeTabId?: number;
  state?: RuntimeWindow["state"];
  provenance: RuntimeWindowScopeProvenance;
  lifecycle: RuntimeWindowScopeLifecycle;
};

export type RuntimeWindowScopeSnapshot = Omit<RuntimeWindowScope, "tabNodeIdsByRuntimeId"> & {
  tabNodeIdsByRuntimeId: Array<[number, NodeId]>;
};

export type RuntimeWindowScopeProvenanceResolverInput = {
  runtimeWindowId: number;
  outlineWindowNode?: OutlineNode;
  hasRuntimeWindow: boolean;
  runtimeOnly: boolean;
};

export type RuntimeWindowScopeProvenanceResolver = (
  input: RuntimeWindowScopeProvenanceResolverInput
) => RuntimeWindowScopeProvenance;

export class RuntimeWindowScopeIndex {
  private readonly scopes = new Map<number, RuntimeWindowScope>();
  private readonly tabWindowIds = new Map<number, number>();
  private readonly removedTabNodeIdsByRuntimeId = new Map<number, NodeId>();

  upsertLiveWindow(input: {
    runtimeWindowId: number;
    outlineWindowNodeId?: NodeId;
    state?: RuntimeWindow["state"];
    provenance: RuntimeWindowScopeProvenance;
  }): void {
    const previous = this.scopes.get(input.runtimeWindowId);
    const outlineWindowNodeId = input.outlineWindowNodeId ?? previous?.outlineWindowNodeId;
    const state = input.state ?? previous?.state;
    this.scopes.set(input.runtimeWindowId, {
      runtimeWindowId: input.runtimeWindowId,
      ...(outlineWindowNodeId ? { outlineWindowNodeId } : {}),
      tabNodeIdsByRuntimeId: previous?.tabNodeIdsByRuntimeId ?? new Map<number, NodeId>(),
      tabOrder: previous ? [...previous.tabOrder] : [],
      ...(typeof previous?.activeTabId === "number" ? { activeTabId: previous.activeTabId } : {}),
      ...(state ? { state } : {}),
      provenance: input.provenance,
      lifecycle: "live"
    });
  }

  upsertLiveTab(input: {
    runtimeWindowId: number;
    tabId: number;
    tabNodeId: NodeId;
    index?: number;
    active?: boolean;
  }): void {
    const previousWindowId = this.tabWindowIds.get(input.tabId);
    if (typeof previousWindowId === "number" && previousWindowId !== input.runtimeWindowId) {
      const previousScope = this.scopes.get(previousWindowId);
      if (previousScope) {
        previousScope.tabNodeIdsByRuntimeId.delete(input.tabId);
        previousScope.tabOrder = previousScope.tabOrder.filter((tabId) => tabId !== input.tabId);
        if (previousScope.activeTabId === input.tabId) {
          delete previousScope.activeTabId;
        }
      }
    }

    const scope = this.scopes.get(input.runtimeWindowId);
    if (!scope) {
      return;
    }

    scope.tabNodeIdsByRuntimeId.set(input.tabId, input.tabNodeId);
    scope.tabOrder = runtimeOrderWithTabAtIndex(scope.tabOrder, input.tabId, input.index);
    this.tabWindowIds.set(input.tabId, input.runtimeWindowId);
    this.removedTabNodeIdsByRuntimeId.delete(input.tabId);
    if (input.active === true) {
      scope.activeTabId = input.tabId;
    } else if (input.active === false && scope.activeTabId === input.tabId) {
      delete scope.activeTabId;
    }
  }

  syncLiveWindowOrder(
    runtimeWindowId: number,
    tabOrder: readonly number[],
    options: { pruneMissing?: boolean } = {}
  ): void {
    const scope = this.scopes.get(runtimeWindowId);
    if (!scope || scope.lifecycle !== "live") {
      return;
    }
    const knownTabIds = new Set(scope.tabNodeIdsByRuntimeId.keys());
    const orderedKnownTabs = tabOrder.filter((tabId) => knownTabIds.has(tabId));
    const orderedSet = new Set(orderedKnownTabs);
    if (options.pruneMissing === true) {
      scope.tabOrder = orderedKnownTabs;
      for (const tabId of [...scope.tabNodeIdsByRuntimeId.keys()]) {
        if (!orderedSet.has(tabId)) {
          scope.tabNodeIdsByRuntimeId.delete(tabId);
          this.tabWindowIds.delete(tabId);
        }
      }
      return;
    }
    scope.tabOrder = [
      ...orderedKnownTabs,
      ...scope.tabOrder.filter((tabId) => knownTabIds.has(tabId) && !orderedSet.has(tabId))
    ];
  }

  replaceLiveWindowTabs(input: {
    runtimeWindowId: number;
    tabNodeIdsByRuntimeId: Map<number, NodeId>;
    tabOrder: readonly number[];
    activeTabId?: number;
  }): void {
    const scope = this.scopes.get(input.runtimeWindowId);
    if (!scope || scope.lifecycle !== "live") {
      return;
    }

    for (const tabId of scope.tabNodeIdsByRuntimeId.keys()) {
      if (this.tabWindowIds.get(tabId) === input.runtimeWindowId) {
        this.tabWindowIds.delete(tabId);
      }
    }

    scope.tabNodeIdsByRuntimeId = new Map(input.tabNodeIdsByRuntimeId);
    scope.tabOrder = [...input.tabOrder];
    if (typeof input.activeTabId === "number") {
      scope.activeTabId = input.activeTabId;
    } else {
      delete scope.activeTabId;
    }

    for (const tabId of scope.tabNodeIdsByRuntimeId.keys()) {
      this.tabWindowIds.set(tabId, input.runtimeWindowId);
      this.removedTabNodeIdsByRuntimeId.delete(tabId);
    }
  }

  matchesLiveRuntimeWindows(
    windows: readonly RuntimeWindow[],
    options: {
      ignoredTabIds?: ReadonlySet<number>;
      ignoredWindowIds?: ReadonlySet<number>;
    } = {}
  ): boolean {
    const ignoredTabIds = options.ignoredTabIds ?? new Set<number>();
    const ignoredWindowIds = options.ignoredWindowIds ?? new Set<number>();
    const expectedWindowIds = new Set<number>();

    for (const windowInfo of windows) {
      if (windowInfo.incognito || ignoredWindowIds.has(windowInfo.id)) {
        continue;
      }
      expectedWindowIds.add(windowInfo.id);
      const scope = this.scopes.get(windowInfo.id);
      if (!scope || scope.lifecycle !== "live") {
        return false;
      }
      if (windowInfo.state !== undefined && scope.state !== windowInfo.state) {
        return false;
      }

      const tabs = [...(windowInfo.tabs ?? [])]
        .filter((tab) => !tab.incognito && !ignoredTabIds.has(tab.id))
        .sort((left, right) => left.index - right.index);
      if (scope.tabOrder.length !== tabs.length) {
        return false;
      }
      for (let index = 0; index < tabs.length; index += 1) {
        if (scope.tabOrder[index] !== tabs[index]?.id) {
          return false;
        }
      }

      const activeTabId = tabs.find((tab) => tab.active)?.id;
      if (activeTabId !== undefined ? scope.activeTabId !== activeTabId : scope.activeTabId !== undefined) {
        return false;
      }
    }

    for (const scope of this.scopes.values()) {
      if (
        scope.lifecycle === "live" &&
        !ignoredWindowIds.has(scope.runtimeWindowId) &&
        !expectedWindowIds.has(scope.runtimeWindowId)
      ) {
        return false;
      }
    }

    return true;
  }

  markTabRemoved(tabId: number): void {
    const windowId = this.tabWindowIds.get(tabId);
    if (typeof windowId !== "number") {
      return;
    }
    const scope = this.scopes.get(windowId);
    const nodeId = scope?.tabNodeIdsByRuntimeId.get(tabId);
    if (scope) {
      scope.tabNodeIdsByRuntimeId.delete(tabId);
      scope.tabOrder = scope.tabOrder.filter((candidate) => candidate !== tabId);
      if (scope.activeTabId === tabId) {
        delete scope.activeTabId;
      }
    }
    this.tabWindowIds.delete(tabId);
    if (nodeId) {
      this.removedTabNodeIdsByRuntimeId.set(tabId, nodeId);
    }
  }

  markWindowRemoved(windowId: number): void {
    const scope = this.scopes.get(windowId);
    if (!scope) {
      return;
    }
    scope.lifecycle = "removed";
    for (const tabId of scope.tabOrder) {
      if (this.tabWindowIds.get(tabId) === windowId) {
        this.tabWindowIds.delete(tabId);
      }
      const nodeId = scope.tabNodeIdsByRuntimeId.get(tabId);
      if (nodeId) {
        this.removedTabNodeIdsByRuntimeId.set(tabId, nodeId);
      }
    }
    scope.tabNodeIdsByRuntimeId.clear();
    scope.tabOrder = [];
    delete scope.activeTabId;
  }

  rebuild(input: {
    state: OutlineState;
    nodes?: readonly OutlineNode[];
    windows?: readonly RuntimeWindow[];
    browserCreatedWindowIds?: ReadonlySet<number>;
    commandCreatedWindowIds?: ReadonlySet<number>;
    ignoredTabIds?: ReadonlySet<number>;
    ignoredWindowIds?: ReadonlySet<number>;
    resolveProvenance?: RuntimeWindowScopeProvenanceResolver;
  }): void {
    this.scopes.clear();
    this.tabWindowIds.clear();
    this.removedTabNodeIdsByRuntimeId.clear();

    const resolveProvenance = input.resolveProvenance ?? ((context: RuntimeWindowScopeProvenanceResolverInput) =>
      scopeProvenance(context, input.browserCreatedWindowIds, input.commandCreatedWindowIds));
    const ignoredTabIds = input.ignoredTabIds ?? new Set<number>();
    const ignoredWindowIds = input.ignoredWindowIds ?? new Set<number>();
    const windowsById = new Map((input.windows ?? []).map((windowInfo) => [windowInfo.id, windowInfo]));
    const hasSnapshot = Boolean(input.windows);
    const nodes = input.nodes ?? Object.values(input.state.nodes);
    const liveTabsByWindowId = liveTabNodesByWindowId(nodes);

    for (const windowNode of liveWindowNodes(nodes)) {
      const runtimeWindowId = windowNode.live.windowId;
      const windowInfo = windowsById.get(runtimeWindowId);
      const ignoredWindow = ignoredWindowIds.has(runtimeWindowId);
      const allTabNodes = liveTabsByWindowId.get(runtimeWindowId) ?? [];
      for (const tabNode of allTabNodes) {
        if (ignoredWindow || ignoredTabIds.has(tabNode.live.tabId)) {
          this.removedTabNodeIdsByRuntimeId.set(tabNode.live.tabId, tabNode.id);
        }
      }
      const tabNodes = ignoredWindow
        ? []
        : allTabNodes.filter((node) => !ignoredTabIds.has(node.live.tabId));
      const runtimeTabs = ignoredWindow
        ? []
        : (windowInfo?.tabs ?? []).filter((tab) => !ignoredTabIds.has(tab.id));
      const runtimeTabNodeIds = new Map(tabNodes.map((node) => [node.live.tabId, node.id]));
      const tabOrder = runtimeTabs.length > 0
        ? runtimeTabs
            .filter((tab) => runtimeTabNodeIds.has(tab.id))
            .sort((left, right) => left.index - right.index)
            .map((tab) => tab.id)
        : tabNodes.map((node) => node.live.tabId);
      for (const tabNode of tabNodes) {
        this.tabWindowIds.set(tabNode.live.tabId, runtimeWindowId);
      }

      const activeTabId = runtimeTabs.find((tab) => tab.active)?.id ?? tabNodes.find((node) => node.active)?.live.tabId;
      this.scopes.set(runtimeWindowId, {
        runtimeWindowId,
        outlineWindowNodeId: windowNode.id,
        tabNodeIdsByRuntimeId: runtimeTabNodeIds,
        tabOrder,
        ...(activeTabId !== undefined ? { activeTabId } : {}),
        ...(windowInfo?.state ? { state: windowInfo.state } : {}),
        provenance: resolveProvenance({
          runtimeWindowId,
          outlineWindowNode: windowNode,
          hasRuntimeWindow: Boolean(windowInfo) && !ignoredWindow,
          runtimeOnly: false
        }),
        lifecycle: ignoredWindow || (hasSnapshot && !windowsById.has(runtimeWindowId)) ? "removed" : "live"
      });
    }

    for (const windowInfo of input.windows ?? []) {
      if (this.scopes.has(windowInfo.id) || ignoredWindowIds.has(windowInfo.id)) {
        continue;
      }
      const tabNodeIdsByRuntimeId = new Map<number, NodeId>();
      for (const tab of (windowInfo.tabs ?? []).filter((candidate) => !ignoredTabIds.has(candidate.id))) {
        this.tabWindowIds.set(tab.id, windowInfo.id);
      }
      const runtimeTabs = (windowInfo.tabs ?? []).filter((tab) => !ignoredTabIds.has(tab.id));
      const activeTabId = runtimeTabs.find((tab) => tab.active)?.id;
      this.scopes.set(windowInfo.id, {
        runtimeWindowId: windowInfo.id,
        tabNodeIdsByRuntimeId,
        tabOrder: [...runtimeTabs].sort((left, right) => left.index - right.index).map((tab) => tab.id),
        ...(activeTabId !== undefined ? { activeTabId } : {}),
        ...(windowInfo.state ? { state: windowInfo.state } : {}),
        provenance: resolveProvenance({
          runtimeWindowId: windowInfo.id,
          hasRuntimeWindow: true,
          runtimeOnly: true
        }),
        lifecycle: "live"
      });
    }

    for (const windowNode of windowNodes(nodes)) {
      if (windowNode.status !== "closed") {
        continue;
      }
      const runtimeWindowId = canonicalRuntimeIdFromNodeId(windowNode.id, "window");
      if (runtimeWindowId === undefined || windowsById.has(runtimeWindowId)) {
        continue;
      }
      const tabNodeIdsByRuntimeId = new Map<number, NodeId>();
      for (const tabNode of descendantTabNodes(input.state, windowNode.id)) {
        const runtimeTabId = canonicalRuntimeIdFromNodeId(tabNode.id, "tab");
        if (runtimeTabId !== undefined) {
          tabNodeIdsByRuntimeId.set(runtimeTabId, tabNode.id);
          this.removedTabNodeIdsByRuntimeId.set(runtimeTabId, tabNode.id);
        }
      }
      this.scopes.set(runtimeWindowId, {
        runtimeWindowId,
        outlineWindowNodeId: windowNode.id,
        tabNodeIdsByRuntimeId,
        tabOrder: [...tabNodeIdsByRuntimeId.keys()],
        provenance: windowNode.restoredFromClosed ? "restored" : "saved",
        lifecycle: "removed"
      });
    }

    for (const tabNode of tabNodes(nodes)) {
      if (tabNode.status !== "closed") {
        continue;
      }
      const runtimeTabId = canonicalRuntimeIdFromNodeId(tabNode.id, "tab");
      if (runtimeTabId !== undefined) {
        this.removedTabNodeIdsByRuntimeId.set(runtimeTabId, tabNode.id);
      }
    }
  }

  scopeForWindow(windowId: number): RuntimeWindowScope | undefined {
    return this.scopes.get(windowId);
  }

  scopeForTab(tabId: number): RuntimeWindowScope | undefined {
    const windowId = this.tabWindowIds.get(tabId);
    return typeof windowId === "number" ? this.scopes.get(windowId) : undefined;
  }

  removedTabNodeIdEntries(): Array<[number, NodeId]> {
    return [...this.removedTabNodeIdsByRuntimeId.entries()];
  }

  snapshots(): RuntimeWindowScopeSnapshot[] {
    return [...this.scopes.values()].map((scope) => ({
      ...scope,
      tabNodeIdsByRuntimeId: [...scope.tabNodeIdsByRuntimeId.entries()]
    }));
  }

  nodeTouchesRemovedRuntimeScope(state: OutlineState, nodeId: NodeId): boolean {
    const visited = new Set<NodeId>();
    const stack = [nodeId];
    while (stack.length > 0) {
      const currentNodeId = stack.pop()!;
      if (visited.has(currentNodeId)) {
        continue;
      }
      visited.add(currentNodeId);
      const node = state.nodes[currentNodeId];
      if (!node) {
        continue;
      }
      if (node.kind === "window") {
        if (
          [...this.scopes.values()].some((scope) =>
            scope.lifecycle === "removed" && scope.outlineWindowNodeId === node.id
          )
        ) {
          return true;
        }
        const runtimeWindowId = canonicalRuntimeIdFromNodeId(node.id, "window");
        if (runtimeWindowId !== undefined && this.scopes.get(runtimeWindowId)?.lifecycle === "removed") {
          return true;
        }
      }
      if (node.kind === "tab") {
        if ([...this.removedTabNodeIdsByRuntimeId.values()].includes(node.id)) {
          return true;
        }
        const runtimeTabId = canonicalRuntimeIdFromNodeId(node.id, "tab");
        if (runtimeTabId !== undefined && this.removedTabNodeIdsByRuntimeId.has(runtimeTabId)) {
          return true;
        }
      }
      stack.push(...node.childIds);
    }
    return false;
  }
}

function scopeProvenance(
  input: RuntimeWindowScopeProvenanceResolverInput,
  browserCreatedWindowIds: ReadonlySet<number> | undefined,
  commandCreatedWindowIds: ReadonlySet<number> | undefined
): RuntimeWindowScopeProvenance {
  const node = input.outlineWindowNode;
  if (commandCreatedWindowIds?.has(input.runtimeWindowId)) {
    return "commandCreated";
  }
  if (browserCreatedWindowIds?.has(input.runtimeWindowId)) {
    return "browserCreated";
  }
  if (!node) {
    return input.runtimeOnly ? "browserCreated" : "commandCreated";
  }
  if (node.runtimeProvenance) {
    return node.runtimeProvenance;
  }
  if (node.restoredFromClosed) {
    return "restored";
  }
  if (node.parentId) {
    return "commandCreated";
  }
  return canonicalRuntimeIdFromNodeId(node.id, "window") === input.runtimeWindowId ? "saved" : "commandCreated";
}

function liveTabNodesByWindowId(nodes: readonly OutlineNode[]): Map<number, LiveTabNode[]> {
  const tabsByWindowId = new Map<number, LiveTabNode[]>();
  for (const node of tabNodes(nodes)) {
    if (!isLiveTabNode(node)) {
      continue;
    }
    const existing = tabsByWindowId.get(node.live.windowId) ?? [];
    existing.push(node);
    tabsByWindowId.set(node.live.windowId, existing);
  }
  return tabsByWindowId;
}

function runtimeOrderWithTabAtIndex(tabOrder: readonly number[], tabId: number, index: number | undefined): number[] {
  if (typeof index !== "number" && tabOrder.includes(tabId)) {
    return [...tabOrder];
  }
  const withoutTab = tabOrder.filter((candidate) => candidate !== tabId);
  if (typeof index !== "number") {
    return [...withoutTab, tabId];
  }
  const insertionIndex = Math.max(0, Math.min(index, withoutTab.length));
  return [
    ...withoutTab.slice(0, insertionIndex),
    tabId,
    ...withoutTab.slice(insertionIndex)
  ];
}

function descendantTabNodes(state: OutlineState, nodeId: NodeId): OutlineNode[] {
  const tabs: OutlineNode[] = [];
  const visited = new Set<NodeId>();
  const walk = (currentNodeId: NodeId): void => {
    if (visited.has(currentNodeId)) {
      return;
    }
    visited.add(currentNodeId);
    const node = state.nodes[currentNodeId];
    if (!node) {
      return;
    }
    if (node.kind === "tab") {
      tabs.push(node);
    }
    for (const childId of node.childIds) {
      walk(childId);
    }
  };
  walk(nodeId);
  return tabs;
}

function tabNodes(nodes: readonly OutlineNode[]): OutlineNode[] {
  return nodes.filter((node) => node.kind === "tab");
}

function windowNodes(nodes: readonly OutlineNode[]): OutlineNode[] {
  return nodes.filter((node) => node.kind === "window");
}

function liveWindowNodes(nodes: readonly OutlineNode[]): LiveWindowNode[] {
  return nodes.filter(isLiveWindowNode);
}

function canonicalRuntimeIdFromNodeId(nodeId: NodeId, kind: "tab" | "window"): number | undefined {
  const match = new RegExp(`^${kind}:(\\d+)(?::|$)`).exec(nodeId);
  if (!match?.[1]) {
    return undefined;
  }
  return Number(match[1]);
}
