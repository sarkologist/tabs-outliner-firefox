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

export class RuntimeWindowScopeIndex {
  private readonly scopes = new Map<number, RuntimeWindowScope>();
  private readonly tabWindowIds = new Map<number, number>();
  private readonly removedTabNodeIdsByRuntimeId = new Map<number, NodeId>();

  rebuild(input: {
    state: OutlineState;
    nodes?: readonly OutlineNode[];
    windows?: readonly RuntimeWindow[];
    browserCreatedWindowIds?: ReadonlySet<number>;
    commandCreatedWindowIds?: ReadonlySet<number>;
  }): void {
    this.scopes.clear();
    this.tabWindowIds.clear();
    this.removedTabNodeIdsByRuntimeId.clear();

    const windowsById = new Map((input.windows ?? []).map((windowInfo) => [windowInfo.id, windowInfo]));
    const hasSnapshot = Boolean(input.windows);
    const nodes = input.nodes ?? Object.values(input.state.nodes);
    const liveTabsByWindowId = liveTabNodesByWindowId(nodes);

    for (const windowNode of liveWindowNodes(nodes)) {
      const runtimeWindowId = windowNode.live.windowId;
      const windowInfo = windowsById.get(runtimeWindowId);
      const tabNodes = liveTabsByWindowId.get(runtimeWindowId) ?? [];
      const runtimeTabs = windowInfo?.tabs ?? [];
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
        provenance: scopeProvenance(windowNode, runtimeWindowId, input.browserCreatedWindowIds, input.commandCreatedWindowIds),
        lifecycle: hasSnapshot && !windowsById.has(runtimeWindowId) ? "removed" : "live"
      });
    }

    for (const windowInfo of input.windows ?? []) {
      if (this.scopes.has(windowInfo.id)) {
        continue;
      }
      const tabNodeIdsByRuntimeId = new Map<number, NodeId>();
      for (const tab of windowInfo.tabs ?? []) {
        this.tabWindowIds.set(tab.id, windowInfo.id);
      }
      const activeTabId = windowInfo.tabs?.find((tab) => tab.active)?.id;
      this.scopes.set(windowInfo.id, {
        runtimeWindowId: windowInfo.id,
        tabNodeIdsByRuntimeId,
        tabOrder: [...(windowInfo.tabs ?? [])].sort((left, right) => left.index - right.index).map((tab) => tab.id),
        ...(activeTabId !== undefined ? { activeTabId } : {}),
        ...(windowInfo.state ? { state: windowInfo.state } : {}),
        provenance: input.commandCreatedWindowIds?.has(windowInfo.id) ? "commandCreated" : "browserCreated",
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
        const runtimeWindowId = canonicalRuntimeIdFromNodeId(node.id, "window");
        if (runtimeWindowId !== undefined && this.scopes.get(runtimeWindowId)?.lifecycle === "removed") {
          return true;
        }
      }
      if (node.kind === "tab") {
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

type LiveTabNode = OutlineNode & { live: { tabId: number; windowId: number } };
type LiveWindowNode = OutlineNode & { live: { windowId: number } };

function scopeProvenance(
  node: LiveWindowNode,
  runtimeWindowId: number,
  browserCreatedWindowIds: ReadonlySet<number> | undefined,
  commandCreatedWindowIds: ReadonlySet<number> | undefined
): RuntimeWindowScopeProvenance {
  if (node.restoredFromClosed) {
    return "restored";
  }
  if (node.runtimeProvenance) {
    return node.runtimeProvenance;
  }
  if (browserCreatedWindowIds?.has(runtimeWindowId)) {
    return "browserCreated";
  }
  if (commandCreatedWindowIds?.has(runtimeWindowId)) {
    return "commandCreated";
  }
  return canonicalRuntimeIdFromNodeId(node.id, "window") === runtimeWindowId ? "saved" : "commandCreated";
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

function isLiveTabNode(node: OutlineNode | undefined): node is LiveTabNode {
  return Boolean(node?.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live);
}

function isLiveWindowNode(node: OutlineNode | undefined): node is LiveWindowNode {
  return Boolean(node?.kind === "window" && node.status === "live" && node.live && "windowId" in node.live);
}

function canonicalRuntimeIdFromNodeId(nodeId: NodeId, kind: "tab" | "window"): number | undefined {
  const match = new RegExp(`^${kind}:(\\d+)(?::|$)`).exec(nodeId);
  if (!match?.[1]) {
    return undefined;
  }
  return Number(match[1]);
}
