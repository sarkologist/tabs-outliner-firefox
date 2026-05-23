import type {
  RuntimeFactLedger,
  RuntimeSnapshotConfidence,
  WindowClosingTabRemovalDecision
} from "./runtime-facts.js";
import { projectLiveTabs, runtimeTitleForOutlineTab } from "../model/outline.js";
import type { NodeId, OutlineNode, OutlineState, RuntimeTab, RuntimeWindow } from "../model/types.js";

export type RuntimeStateIndexForReconciliation = {
  state: OutlineState;
  liveTabNodeIdsByRuntimeId: Map<number, NodeId>;
  liveWindowNodeIdsByRuntimeId: Map<number, NodeId>;
  liveTabNodeIdsByWindowId: Map<number, Set<NodeId>>;
  activeTabNodeIdsByWindowId: Map<number, NodeId>;
  closedRestoreCandidateCountsByWindowNodeId: Map<NodeId, number>;
  windowNodeIdsWithClosedRestoreCandidates: Set<NodeId>;
  activeWindowNodeId?: NodeId;
};

type LiveTabNode = OutlineNode & { live: { tabId: number; windowId: number } };
type LiveWindowNode = OutlineNode & { live: { windowId: number } };

export type RuntimeSnapshotNormalizationInput = {
  windows: RuntimeWindow[];
  state: OutlineState;
  index: RuntimeStateIndexForReconciliation;
  ledger: RuntimeFactLedger;
  confidence: RuntimeSnapshotConfidence;
  activationByWindowId?: ReadonlyMap<number, number> | undefined;
};

export type MissingLiveTabsInput = {
  windows: RuntimeWindow[];
  state: OutlineState;
  ledger: RuntimeFactLedger;
};

export type SnapshotSuspicionInput = {
  windows: RuntimeWindow[];
  state: OutlineState;
  index: RuntimeStateIndexForReconciliation;
  ledger: RuntimeFactLedger;
};

export type RuntimeEventTabFilterInput = {
  eventTabs: RuntimeTab[];
  state: OutlineState;
  index: RuntimeStateIndexForReconciliation;
  ledger: RuntimeFactLedger;
};

export type MissingLiveTabRemovalDecision = "close-outliner-tab" | "close-restored-tab" | "delete-tab";

export class RuntimeReconciler {
  classifyWindowClosingTabRemoval(
    ledger: RuntimeFactLedger,
    input: {
      windowId: number;
      liveTabIds: readonly number[];
      runtimeWindowOpen: boolean;
    }
  ): WindowClosingTabRemovalDecision {
    return ledger.classifyWindowClosingTabRemoval(input);
  }

  normalizeSnapshot(input: RuntimeSnapshotNormalizationInput): RuntimeWindow[] {
    input.ledger.recordObservation({
      source: "snapshot",
      confidence: input.confidence,
      windows: input.windows
    });

    const ignoredTabIds = input.ledger.ignoredTabIdsForRefresh();
    const ignoredWindowIds = input.ledger.ignoredWindowIdsForRefresh();

    return applyActivationOverridesToWindows(
      addMissingCommandRelocatedTabsFromCurrentState(
        filterCommandRelocatedStaleTabsFromWindows(
          addMissingTabsForEmptyOpenWindowSnapshots(
            filterIgnoredWindowsFromWindows(
              filterIgnoredTabsFromWindows(input.windows, input.ledger),
              input.ledger
            ),
            input.state,
            input.index,
            ignoredTabIds,
            ignoredWindowIds
          ),
          input.state,
          input.index,
          input.ledger,
          ignoredTabIds,
          ignoredWindowIds
        ),
        input.state,
        input.index,
        input.ledger,
        ignoredTabIds,
        ignoredWindowIds
      ),
      input.state,
      input.index,
      input.activationByWindowId
    );
  }

  consumeCommandRestoredTabEvent(
    state: OutlineState,
    index: RuntimeStateIndexForReconciliation,
    ledger: RuntimeFactLedger,
    tab: RuntimeTab
  ): boolean {
    if (!ledger.hasCommandRestoredTab(tab.id)) {
      return false;
    }

    const node = indexedLiveTabNodeByRuntimeId(state, index, tab.id);
    if (!node || node.live.windowId !== tab.windowId) {
      ledger.deleteCommandRestoredTab(tab.id);
      return false;
    }

    ledger.deleteCommandRestoredTab(tab.id);
    return true;
  }

  consumeCommandRelocatedStaleTabEvent(
    state: OutlineState,
    index: RuntimeStateIndexForReconciliation,
    ledger: RuntimeFactLedger,
    tab: RuntimeTab
  ): boolean {
    const echo = ledger.commandRelocatedTabEcho(tab.id);
    if (!echo) {
      return false;
    }

    const node = indexedLiveTabNodeByRuntimeId(state, index, tab.id);
    if (!node) {
      ledger.deleteCommandRelocatedTabEcho(tab.id);
      return false;
    }

    if (node.live.windowId !== echo.toWindowId) {
      ledger.deleteCommandRelocatedTabEcho(tab.id);
      return false;
    }

    return echo.fromWindowIds.has(tab.windowId);
  }

  tabEventMayChangeState(
    state: OutlineState,
    index: RuntimeStateIndexForReconciliation,
    tab: RuntimeTab
  ): boolean {
    const node = indexedLiveTabNodeByRuntimeId(state, index, tab.id);
    if (!isLiveTabNode(node)) {
      return true;
    }
    if (node.live.windowId !== tab.windowId) {
      return false;
    }

    return liveTabNodeWouldChange(node, tab);
  }

  filterEventTabsForReconciliation(input: RuntimeEventTabFilterInput): RuntimeTab[] {
    return input.eventTabs
      .filter((tab) => !input.ledger.isTabIgnoredForRefresh(tab.id))
      .filter((tab) => !input.ledger.isWindowIgnoredForRefresh(tab.windowId))
      .filter((tab) => !this.consumeCommandRestoredTabEvent(input.state, input.index, input.ledger, tab))
      .filter((tab) => !this.consumeCommandRelocatedStaleTabEvent(input.state, input.index, input.ledger, tab))
      .filter((tab) => this.tabEventMayChangeState(input.state, input.index, tab));
  }

  classifyMissingLiveTabRemoval(
    state: OutlineState,
    ledger: RuntimeFactLedger,
    tabId: number
  ): MissingLiveTabRemovalDecision {
    if (ledger.consumeOutlinerClosingTab(tabId)) {
      return "close-outliner-tab";
    }

    const node = liveTabNodes(state).find((candidate) => candidate.live.tabId === tabId);
    return node?.restoredFromClosed ? "close-restored-tab" : "delete-tab";
  }

  missingLiveTabIdsInOpenWindows(input: MissingLiveTabsInput): number[] {
    const ignoredTabIds = input.ledger.ignoredTabIdsForRefresh();
    const ignoredWindowIds = input.ledger.ignoredWindowIdsForRefresh();
    const openWindowIds = new Set(input.windows.map((windowInfo) => windowInfo.id));
    const openTabIds = new Set(
      input.windows.flatMap((windowInfo) => windowInfo.tabs ?? []).map((tab) => tab.id)
    );

    return liveTabNodes(input.state)
      .filter((node) => {
        if (openTabIds.has(node.live.tabId) || input.ledger.isTabIgnoredForRefresh(node.live.tabId)) {
          return false;
        }
        if (openWindowIds.has(node.live.windowId)) {
          return true;
        }
        const relocationEcho = input.ledger.commandRelocatedTabEcho(node.live.tabId);
        return relocationEcho?.toWindowId === node.live.windowId && !input.ledger.isWindowIgnoredForRefresh(node.live.windowId);
      })
      .map((node) => node.live.tabId);
  }

  mismatchedLiveTabIdsInWindows(input: SnapshotSuspicionInput): number[] {
    const mismatchedTabIds = new Set<number>();

    for (const windowInfo of input.windows) {
      if (input.ledger.isWindowIgnoredForRefresh(windowInfo.id)) {
        continue;
      }
      for (const tab of windowInfo.tabs ?? []) {
        if (input.ledger.isTabIgnoredForRefresh(tab.id)) {
          continue;
        }
        const node = indexedLiveTabNodeByRuntimeId(input.state, input.index, tab.id);
        if (node && node.live.windowId !== tab.windowId) {
          mismatchedTabIds.add(tab.id);
        }
      }
    }

    return [...mismatchedTabIds];
  }
}

export function buildRuntimeStateIndexForReconciliation(state: OutlineState): RuntimeStateIndexForReconciliation {
  const index: RuntimeStateIndexForReconciliation = {
    state,
    liveTabNodeIdsByRuntimeId: new Map(),
    liveWindowNodeIdsByRuntimeId: new Map(),
    liveTabNodeIdsByWindowId: new Map(),
    activeTabNodeIdsByWindowId: new Map(),
    closedRestoreCandidateCountsByWindowNodeId: new Map(),
    windowNodeIdsWithClosedRestoreCandidates: new Set()
  };

  for (const node of Object.values(state.nodes)) {
    if (isLiveWindowNode(node)) {
      index.liveWindowNodeIdsByRuntimeId.set(node.live.windowId, node.id);
      if (node.active) {
        index.activeWindowNodeId = node.id;
      }
      continue;
    }

    if (isLiveTabNode(node)) {
      index.liveTabNodeIdsByRuntimeId.set(node.live.tabId, node.id);
      const windowTabNodeIds = index.liveTabNodeIdsByWindowId.get(node.live.windowId) ?? new Set<NodeId>();
      windowTabNodeIds.add(node.id);
      index.liveTabNodeIdsByWindowId.set(node.live.windowId, windowTabNodeIds);
      if (node.active) {
        index.activeTabNodeIdsByWindowId.set(node.live.windowId, node.id);
      }
    }
  }

  return index;
}

function filterIgnoredTabsFromWindows(windows: RuntimeWindow[], ledger: RuntimeFactLedger): RuntimeWindow[] {
  let changed = false;
  const next = windows.map((windowInfo) => {
    const tabs = windowInfo.tabs ?? [];
    const nextTabs = tabs.filter((tab) => !ledger.isTabIgnoredForRefresh(tab.id));
    if (nextTabs.length === tabs.length) {
      return windowInfo;
    }
    changed = true;
    return {
      ...windowInfo,
      tabs: nextTabs
    };
  });

  return changed ? next : windows;
}

function filterIgnoredWindowsFromWindows(windows: RuntimeWindow[], ledger: RuntimeFactLedger): RuntimeWindow[] {
  const next = windows.filter((windowInfo) => !ledger.isWindowIgnoredForRefresh(windowInfo.id));
  return next.length === windows.length ? windows : next;
}

function addMissingTabsForEmptyOpenWindowSnapshots(
  windows: RuntimeWindow[],
  state: OutlineState,
  index: RuntimeStateIndexForReconciliation,
  ignoredTabIds: Set<number>,
  ignoredWindowIds: Set<number>
): RuntimeWindow[] {
  const additionsByWindowId = new Map<number, RuntimeTab[]>();

  for (const windowInfo of windows) {
    if (ignoredWindowIds.has(windowInfo.id) || (windowInfo.tabs?.length ?? 0) > 0) {
      continue;
    }

    const additions = liveTabNodes(state)
      .filter((node) =>
        node.live.windowId === windowInfo.id &&
        !ignoredTabIds.has(node.live.tabId)
      )
      .flatMap((node) => {
        const tab = commandRelocatedTabFromCurrentState(state, index, node.live.tabId, ignoredTabIds, ignoredWindowIds);
        return tab ? [tab] : [];
      });

    if (additions.length > 0) {
      additionsByWindowId.set(windowInfo.id, additions);
    }
  }

  if (additionsByWindowId.size === 0) {
    return windows;
  }

  return windows.map((windowInfo) => {
    const additions = additionsByWindowId.get(windowInfo.id);
    if (!additions || additions.length === 0) {
      return windowInfo;
    }

    return {
      ...windowInfo,
      tabs: [...additions].sort((left, right) => left.index - right.index)
    };
  });
}

function filterCommandRelocatedStaleTabsFromWindows(
  windows: RuntimeWindow[],
  state: OutlineState,
  index: RuntimeStateIndexForReconciliation,
  ledger: RuntimeFactLedger,
  ignoredTabIds: Set<number>,
  ignoredWindowIds: Set<number>
): RuntimeWindow[] {
  if (ledger.commandRelocatedTabEchoCount() === 0) {
    return windows;
  }

  const freshEchoTabIds = new Set<number>();
  for (const windowInfo of windows) {
    for (const tab of windowInfo.tabs ?? []) {
      const echo = ledger.commandRelocatedTabEcho(tab.id);
      if (!echo) {
        continue;
      }
      const node = indexedLiveTabNodeByRuntimeId(state, index, tab.id);
      if (!node) {
        ledger.deleteCommandRelocatedTabEcho(tab.id);
        continue;
      }
      if (tab.windowId === node.live.windowId || tab.windowId === echo.toWindowId) {
        freshEchoTabIds.add(tab.id);
      }
    }
  }

  let changed = false;
  const fallbackTabs: RuntimeTab[] = [];
  const filtered = windows.map((windowInfo) => {
    const tabs = windowInfo.tabs ?? [];
    const nextTabs = tabs.filter((tab) => {
      const echo = ledger.commandRelocatedTabEcho(tab.id);
      if (!echo) {
        return true;
      }

      const node = indexedLiveTabNodeByRuntimeId(state, index, tab.id);
      if (!node) {
        ledger.deleteCommandRelocatedTabEcho(tab.id);
        return true;
      }

      if (node.live.windowId !== echo.toWindowId) {
        ledger.deleteCommandRelocatedTabEcho(tab.id);
        return true;
      }

      if (echo.fromWindowIds.has(tab.windowId)) {
        changed = true;
        if (!freshEchoTabIds.has(tab.id)) {
          const fallbackTab = commandRelocatedTabFromCurrentState(state, index, tab, ignoredTabIds, ignoredWindowIds);
          if (fallbackTab) {
            fallbackTabs.push(fallbackTab);
          }
        }
        return false;
      }

      return true;
    });

    return nextTabs.length === tabs.length
      ? windowInfo
      : {
          ...windowInfo,
          tabs: nextTabs
        };
  });

  if (fallbackTabs.length === 0) {
    return changed ? filtered : windows;
  }

  const missingFallbackTabs = fallbackTabs.filter((tab) =>
    !filtered.some((windowInfo) => windowInfo.tabs?.some((candidate) => candidate.id === tab.id))
  );
  if (missingFallbackTabs.length === 0) {
    return changed ? filtered : windows;
  }

  return filtered.map((windowInfo) => {
    const additions = missingFallbackTabs.filter((tab) => tab.windowId === windowInfo.id);
    if (additions.length === 0) {
      return windowInfo;
    }

    return {
      ...windowInfo,
      tabs: [...(windowInfo.tabs ?? []), ...additions].sort((left, right) => left.index - right.index)
    };
  });
}

function addMissingCommandRelocatedTabsFromCurrentState(
  windows: RuntimeWindow[],
  state: OutlineState,
  index: RuntimeStateIndexForReconciliation,
  ledger: RuntimeFactLedger,
  ignoredTabIds: Set<number>,
  ignoredWindowIds: Set<number>
): RuntimeWindow[] {
  if (ledger.commandRelocatedTabEchoCount() === 0) {
    return windows;
  }

  const presentTabIds = new Set(windows.flatMap((windowInfo) => windowInfo.tabs ?? []).map((tab) => tab.id));
  const windowIds = new Set(windows.map((windowInfo) => windowInfo.id));
  const additionsByWindowId = new Map<number, RuntimeTab[]>();

  for (const [tabId, echo] of ledger.commandRelocatedTabEchoEntries()) {
    if (presentTabIds.has(tabId) || ignoredTabIds.has(tabId)) {
      continue;
    }

    const node = indexedLiveTabNodeByRuntimeId(state, index, tabId);
    if (!node) {
      ledger.deleteCommandRelocatedTabEcho(tabId);
      continue;
    }
    if (node.live.windowId !== echo.toWindowId) {
      ledger.deleteCommandRelocatedTabEcho(tabId);
      continue;
    }
    if (ignoredWindowIds.has(node.live.windowId) || !windowIds.has(node.live.windowId)) {
      continue;
    }

    const fallbackTab = commandRelocatedTabFromCurrentState(state, index, tabId, ignoredTabIds, ignoredWindowIds);
    if (!fallbackTab) {
      continue;
    }
    const additions = additionsByWindowId.get(fallbackTab.windowId) ?? [];
    additions.push(fallbackTab);
    additionsByWindowId.set(fallbackTab.windowId, additions);
  }

  if (additionsByWindowId.size === 0) {
    return windows;
  }

  return windows.map((windowInfo) => {
    const additions = additionsByWindowId.get(windowInfo.id);
    if (!additions || additions.length === 0) {
      return windowInfo;
    }

    return {
      ...windowInfo,
      tabs: [...(windowInfo.tabs ?? []), ...additions].sort((left, right) => left.index - right.index)
    };
  });
}

function applyActivationOverridesToWindows(
  windows: RuntimeWindow[],
  state: OutlineState,
  index: RuntimeStateIndexForReconciliation,
  activationByWindowId?: ReadonlyMap<number, number>
): RuntimeWindow[] {
  if (!activationByWindowId || activationByWindowId.size === 0) {
    return windows;
  }

  let changed = false;
  const nextWindows = windows.map((windowInfo) => {
    const activeTabId = activationByWindowId.get(windowInfo.id);
    const tabs = windowInfo.tabs ?? [];
    const nextTabs = tabs.map((tab) => {
      const currentNode = indexedLiveTabNodeByRuntimeId(state, index, tab.id);
      const active = typeof activeTabId === "number"
        ? tab.id === activeTabId
        : currentNode?.active ?? tab.active;
      if (tab.active === active) {
        return tab;
      }
      changed = true;
      return {
        ...tab,
        active
      };
    });

    return changed
      ? {
          ...windowInfo,
          tabs: nextTabs
        }
      : windowInfo;
  });

  return changed ? nextWindows : windows;
}

function commandRelocatedTabFromCurrentState(
  state: OutlineState,
  index: RuntimeStateIndexForReconciliation,
  staleTabOrId: RuntimeTab | number,
  ignoredTabIds: Set<number>,
  ignoredWindowIds: Set<number>
): RuntimeTab | undefined {
  const tabId = typeof staleTabOrId === "number" ? staleTabOrId : staleTabOrId.id;
  if (ignoredTabIds.has(tabId)) {
    return undefined;
  }

  const node = indexedLiveTabNodeByRuntimeId(state, index, tabId);
  if (!node) {
    return undefined;
  }
  if (ignoredWindowIds.has(node.live.windowId)) {
    return undefined;
  }

  const windowNode = indexedLiveWindowNodeByRuntimeId(state, index, node.live.windowId);
  if (!windowNode) {
    return undefined;
  }

  const staleTab = typeof staleTabOrId === "number" ? undefined : staleTabOrId;
  const projectedIndex = projectLiveTabs(state, windowNode.id).findIndex((tab) => tab.tabId === tabId);
  return {
    ...(staleTab ?? {
      id: tabId,
      windowId: node.live.windowId,
      index: projectedIndex >= 0 ? projectedIndex : 0,
      active: node.active === true
    }),
    id: tabId,
    windowId: node.live.windowId,
    index: projectedIndex >= 0 ? projectedIndex : (staleTab?.index ?? 0),
    active: node.active === true,
    ...(node.url ? { url: node.url } : {}),
    ...(node.title ? { title: node.title } : {}),
    ...(node.favIconUrl ? { favIconUrl: node.favIconUrl } : {})
  };
}

function indexedLiveTabNodeByRuntimeId(
  state: OutlineState,
  index: RuntimeStateIndexForReconciliation,
  tabId: number
): LiveTabNode | undefined {
  const nodeId = index.liveTabNodeIdsByRuntimeId.get(tabId);
  const node = nodeId ? state.nodes[nodeId] : undefined;
  return isLiveTabNode(node) && node.live.tabId === tabId ? node : undefined;
}

function indexedLiveWindowNodeByRuntimeId(
  state: OutlineState,
  index: RuntimeStateIndexForReconciliation,
  windowId: number
): LiveWindowNode | undefined {
  const nodeId = index.liveWindowNodeIdsByRuntimeId.get(windowId);
  const node = nodeId ? state.nodes[nodeId] : undefined;
  return isLiveWindowNode(node) && node.live.windowId === windowId ? node : undefined;
}

function liveTabNodeWouldChange(node: LiveTabNode, tab: RuntimeTab): boolean {
  const nextTitle = runtimeTitleForOutlineTab(node, tab);
  return node.active !== tab.active ||
    (tab.url !== undefined && node.url !== tab.url) ||
    node.title !== nextTitle ||
    (tab.favIconUrl !== undefined && node.favIconUrl !== tab.favIconUrl);
}

function isLiveTabNode(node: OutlineNode | undefined): node is LiveTabNode {
  return Boolean(node?.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live);
}

function isLiveWindowNode(node: OutlineNode | undefined): node is LiveWindowNode {
  return Boolean(node?.kind === "window" && node.status === "live" && node.live && "windowId" in node.live);
}

function liveTabNodes(state: OutlineState): LiveTabNode[] {
  return Object.values(state.nodes).filter(isLiveTabNode);
}
