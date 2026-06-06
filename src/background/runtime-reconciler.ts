import type {
  RuntimeFactLedger,
  RuntimeEchoDecision,
  RuntimeSnapshotConfidence,
  RuntimeTabEvidence,
  RuntimeTabEvidenceField,
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
  eventTabs: Array<RuntimeTabEvidence | RuntimeTab>;
  state: OutlineState;
  index: RuntimeStateIndexForReconciliation;
  ledger: RuntimeFactLedger;
};

export type RuntimeTabEchoDecisionInput = {
  evidence: RuntimeTabEvidence;
  state: OutlineState;
  index: RuntimeStateIndexForReconciliation;
  ledger: RuntimeFactLedger;
};

export type MissingLiveTabRemovalDecision = "close-outliner-tab" | "delete-tab";
export type MissingLiveWindowRemovalDecision = "close-window" | "delete-tabs";

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
      input.activationByWindowId
    );
  }

  consumeCommandRestoredTabEvent(
    state: OutlineState,
    index: RuntimeStateIndexForReconciliation,
    ledger: RuntimeFactLedger,
    tab: RuntimeTab
  ): boolean {
    return this.decideCommandRestoredTabEcho({
      evidence: runtimeTabEvidenceFromInput(tab, ledger),
      state,
      index,
      ledger
    }).action === "absorb";
  }

  isCommandRestoredAbsorbableTabEvent(
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
      return false;
    }

    return isTransientRestoredTabEcho(tab) || !liveTabNodeWouldChange(node, tab);
  }

  consumeCommandRelocatedStaleTabEvent(
    state: OutlineState,
    index: RuntimeStateIndexForReconciliation,
    ledger: RuntimeFactLedger,
    tab: RuntimeTab
  ): boolean {
    return this.decideCommandRelocatedTabEcho({
      evidence: runtimeTabEvidenceFromInput(tab, ledger),
      state,
      index,
      ledger
    }).action === "absorb";
  }

  isCommandRelocatedStaleTabEvent(
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
    return Boolean(node && node.live.windowId === echo.toWindowId && echo.fromWindowIds.has(tab.windowId));
  }

  decideRuntimeTabEcho(input: RuntimeTabEchoDecisionInput): RuntimeEchoDecision {
    const restoredDecision = this.decideCommandRestoredTabEcho(input);
    if (restoredDecision.action !== "accept") {
      return restoredDecision;
    }

    const relocatedDecision = this.decideCommandRelocatedTabEcho(input);
    if (relocatedDecision.action !== "accept") {
      return relocatedDecision;
    }

    return { action: "accept" };
  }

  private decideCommandRestoredTabEcho(input: RuntimeTabEchoDecisionInput): RuntimeEchoDecision {
    const tab = input.evidence.tab;
    if (!input.ledger.hasCommandRestoredTab(tab.id)) {
      return { action: "accept" };
    }

    if (!this.isCommandRestoredAbsorbableTabEvent(input.state, input.index, input.ledger, tab)) {
      const node = indexedLiveTabNodeByRuntimeId(input.state, input.index, tab.id);
      if (!node || node.live.windowId !== tab.windowId) {
        input.ledger.deleteCommandRestoredTab(tab.id);
      }
      return { action: "accept" };
    }

    return { action: "absorb", effect: "tabRestore" };
  }

  private decideCommandRelocatedTabEcho(input: RuntimeTabEchoDecisionInput): RuntimeEchoDecision {
    const remappedEvidence = commandRelocatedMetadataEvidenceForCurrentScope(
      input.state,
      input.index,
      input.ledger,
      input.evidence
    );
    if (remappedEvidence) {
      return {
        action: "remapToCurrentScope",
        effect: "tabRelocation",
        evidence: remappedEvidence
      };
    }

    const tab = input.evidence.tab;
    const echo = input.ledger.commandRelocatedTabEcho(tab.id);
    if (!echo) {
      return { action: "accept" };
    }

    const node = indexedLiveTabNodeByRuntimeId(input.state, input.index, tab.id);
    if (!node) {
      input.ledger.deleteCommandRelocatedTabEcho(tab.id);
      return { action: "accept" };
    }

    if (node.live.windowId !== echo.toWindowId) {
      input.ledger.deleteCommandRelocatedTabEcho(tab.id);
      return { action: "accept" };
    }

    return echo.fromWindowIds.has(tab.windowId)
      ? { action: "absorb", effect: "tabRelocation" }
      : { action: "accept" };
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
      return true;
    }

    return liveTabNodeWouldChange(node, tab);
  }

  filterEventTabsForReconciliation(input: RuntimeEventTabFilterInput): RuntimeTabEvidence[] {
    return input.eventTabs
      .map((eventTab) => runtimeTabEvidenceFromInput(eventTab, input.ledger))
      .filter((evidence) => !input.ledger.isTabIgnoredForRefresh(evidence.tab.id))
      .filter((evidence) => !input.ledger.isWindowIgnoredForRefresh(evidence.tab.windowId))
      .flatMap((evidence) => {
        const decision = this.decideRuntimeTabEcho({
          evidence,
          state: input.state,
          index: input.index,
          ledger: input.ledger
        });
        if (decision.action === "absorb") {
          return [];
        }
        return [decision.action === "remapToCurrentScope" ? decision.evidence : evidence];
      })
      .filter((evidence) => this.tabEventMayChangeState(input.state, input.index, evidence.tab));
  }

  eventTabsNeedShapeCorroboration(input: RuntimeEventTabFilterInput): boolean {
    return input.eventTabs.map((eventTab) => runtimeTabEvidenceFromInput(eventTab, input.ledger)).some((evidence) => {
      const tab = evidence.tab;
      const node = indexedLiveTabNodeByRuntimeId(input.state, input.index, tab.id);
      return Boolean(node && (
        tabEvidenceConflictsWithCurrentShape(input.state, input.index, input.ledger, evidence, node) ||
        node.restoredFromClosed === true ||
        input.ledger.hasCommandRestoredTab(tab.id) ||
        input.ledger.isRestoredRuntimeScopeForTab(tab.id)
      ));
    });
  }

  classifyMissingLiveTabRemoval(
    state: OutlineState,
    ledger: RuntimeFactLedger,
    tabId: number
  ): MissingLiveTabRemovalDecision {
    if (ledger.consumeOutlinerClosingTab(tabId)) {
      return "close-outliner-tab";
    }

    return "delete-tab";
  }

  classifyMissingLiveWindowRemoval(
    state: OutlineState,
    ledger: RuntimeFactLedger,
    input: {
      windowId: number;
      hasRecentClosedWindowSession: boolean;
    }
  ): MissingLiveWindowRemovalDecision {
    const node = liveWindowNodes(state).find((candidate) => candidate.live.windowId === input.windowId);
    const scope = ledger.windowScope(input.windowId);
    if (node?.runtimeProvenance === "commandCreated" || scope?.provenance === "commandCreated") {
      return "delete-tabs";
    }

    if (input.hasRecentClosedWindowSession) {
      return "close-window";
    }

    if (
      scope?.provenance === "browserCreated" ||
      scope?.provenance === "restored" ||
      scope?.provenance === "saved"
    ) {
      return "close-window";
    }

    if (!node) {
      return "delete-tabs";
    }

    if (!node.runtimeProvenance || node.restoredFromClosed || node.runtimeProvenance === "browserCreated") {
      return "close-window";
    }

    return "delete-tabs";
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

  missingBrowserCreatedWindowIds(input: MissingLiveTabsInput): number[] {
    const openWindowIds = new Set(input.windows.map((windowInfo) => windowInfo.id));
    return liveWindowNodes(input.state)
      .filter((node) =>
        !openWindowIds.has(node.live.windowId) &&
        !input.ledger.isWindowIgnoredForRefresh(node.live.windowId) &&
        input.ledger.isBrowserCreatedRuntimeWindow(node.live.windowId)
      )
      .map((node) => node.live.windowId);
  }

  missingLiveWindowIds(input: MissingLiveTabsInput): number[] {
    const openWindowIds = new Set(input.windows.map((windowInfo) => windowInfo.id));
    const openTabIds = new Set(
      input.windows.flatMap((windowInfo) => windowInfo.tabs ?? []).map((tab) => tab.id)
    );
    const liveTabsByWindowId = new Map<number, LiveTabNode[]>();
    for (const tabNode of liveTabNodes(input.state)) {
      const tabs = liveTabsByWindowId.get(tabNode.live.windowId) ?? [];
      tabs.push(tabNode);
      liveTabsByWindowId.set(tabNode.live.windowId, tabs);
    }

    return liveWindowNodes(input.state)
      .filter((node) => {
        if (openWindowIds.has(node.live.windowId) || input.ledger.isWindowIgnoredForRefresh(node.live.windowId)) {
          return false;
        }
        const tabNodes = liveTabsByWindowId.get(node.live.windowId) ?? [];
        return tabNodes.every((tabNode) =>
          !openTabIds.has(tabNode.live.tabId) &&
          !input.ledger.isTabIgnoredForRefresh(tabNode.live.tabId)
        );
      })
      .map((node) => node.live.windowId);
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

  suspiciousShapeTabIdsInWindows(input: SnapshotSuspicionInput): number[] {
    const suspiciousTabIds = new Set<number>();

    for (const windowInfo of input.windows) {
      if (input.ledger.isWindowIgnoredForRefresh(windowInfo.id)) {
        continue;
      }
      for (const tab of windowInfo.tabs ?? []) {
        if (input.ledger.isTabIgnoredForRefresh(tab.id)) {
          continue;
        }

        const node = indexedLiveTabNodeByRuntimeId(input.state, input.index, tab.id);
        if (
          node &&
          node.live.windowId === tab.windowId &&
          liveTabNodeWouldChange(node, tab)
        ) {
          suspiciousTabIds.add(tab.id);
        }
      }
    }

    return [...suspiciousTabIds];
  }

  orderMismatchedWindowIdsInWindows(input: SnapshotSuspicionInput): number[] {
    const mismatchedWindowIds = new Set<number>();

    for (const windowInfo of input.windows) {
      if (input.ledger.isWindowIgnoredForRefresh(windowInfo.id)) {
        continue;
      }
      const windowNode = indexedLiveWindowNodeByRuntimeId(input.state, input.index, windowInfo.id);
      if (!windowNode) {
        continue;
      }

      const runtimeTabIds = [...(windowInfo.tabs ?? [])]
        .filter((tab) => !tab.incognito && !input.ledger.isTabIgnoredForRefresh(tab.id))
        .sort((left, right) => left.index - right.index)
        .map((tab) => tab.id);
      const outlineTabIds = liveTabIdsInWindowPreorder(input.state, windowNode.id, windowInfo.id, input.ledger);
      if (!sameNumberList(runtimeTabIds, outlineTabIds)) {
        mismatchedWindowIds.add(windowInfo.id);
      }
    }

    return [...mismatchedWindowIds];
  }
}

function sameNumberList(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => right[index] === value);
}

function liveTabIdsInWindowPreorder(
  state: OutlineState,
  windowNodeId: NodeId,
  runtimeWindowId: number,
  ledger: RuntimeFactLedger
): number[] {
  const tabIds: number[] = [];
  const visited = new Set<NodeId>();
  const walk = (nodeId: NodeId): void => {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const node = state.nodes[nodeId];
    if (!node) {
      return;
    }
    if (isLiveTabNode(node) && node.live.windowId === runtimeWindowId && !ledger.isTabIgnoredForRefresh(node.live.tabId)) {
      tabIds.push(node.live.tabId);
    }
    for (const childId of node.childIds) {
      walk(childId);
    }
  };

  walk(windowNodeId);
  return tabIds;
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
  activationByWindowId?: ReadonlyMap<number, number>
): RuntimeWindow[] {
  if (!activationByWindowId || activationByWindowId.size === 0) {
    return windows;
  }

  let changed = false;
  const nextWindows = windows.map((windowInfo) => {
    const activeTabId = activationByWindowId.get(windowInfo.id);
    if (typeof activeTabId !== "number") {
      return windowInfo;
    }

    const tabs = windowInfo.tabs ?? [];
    let windowChanged = false;
    const nextTabs = tabs.map((tab) => {
      const active = tab.id === activeTabId;
      if (tab.active === active) {
        return tab;
      }
      windowChanged = true;
      changed = true;
      return {
        ...tab,
        active
      };
    });

    return windowChanged
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

function runtimeTabEvidenceFromInput(
  eventTab: RuntimeTabEvidence | RuntimeTab,
  ledger: RuntimeFactLedger
): RuntimeTabEvidence {
  if ("tab" in eventTab) {
    return eventTab;
  }
  return {
    kind: "updated",
    tab: eventTab,
    changedFields: new Set<RuntimeTabEvidenceField>([
      "windowId",
      "index",
      "active",
      "openerTabId",
      "url",
      "title",
      "favIconUrl"
    ]),
    confidence: "eventLocal",
    scopeGeneration: ledger.currentScopeGeneration(),
    sequence: 0
  };
}

function commandRelocatedMetadataEvidenceForCurrentScope(
  state: OutlineState,
  index: RuntimeStateIndexForReconciliation,
  ledger: RuntimeFactLedger,
  evidence: RuntimeTabEvidence
): RuntimeTabEvidence | undefined {
  if (!tabMetadataEvidenceChanged(evidence)) {
    return undefined;
  }

  const echo = ledger.commandRelocatedTabEcho(evidence.tab.id);
  if (!echo || !echo.fromWindowIds.has(evidence.tab.windowId)) {
    return undefined;
  }
  if (evidence.sequence <= 0 || evidence.sequence >= echo.sequence) {
    return undefined;
  }

  const node = indexedLiveTabNodeByRuntimeId(state, index, evidence.tab.id);
  if (!node || node.live.windowId !== echo.toWindowId) {
    return undefined;
  }

  return {
    ...evidence,
    tab: {
      ...evidence.tab,
      windowId: node.live.windowId,
      index: projectedRuntimeTabIndex(state, index, evidence.tab.id, node.live.windowId) ?? evidence.tab.index,
      active: node.active === true
    }
  };
}

function tabEvidenceConflictsWithCurrentShape(
  state: OutlineState,
  index: RuntimeStateIndexForReconciliation,
  ledger: RuntimeFactLedger,
  evidence: RuntimeTabEvidence,
  node: LiveTabNode
): boolean {
  const acceptedFact = ledger.acceptedTabShapeFact(evidence.tab.id);
  if (acceptedFact && acceptedFact.scopeGeneration > evidence.scopeGeneration) {
    return true;
  }

  if (evidence.kind === "created") {
    return true;
  }

  if (node.live.windowId !== evidence.tab.windowId) {
    return true;
  }

  if (
    ledger.tabNeedsShapeCorroboration(evidence.tab.id) &&
    tabMetadataEvidenceChanged(evidence) &&
    liveTabNodeWouldChange(node, evidence.tab)
  ) {
    return true;
  }

  if (
    acceptedFact &&
    tabMetadataEvidenceChanged(evidence) &&
    liveTabNodeWouldChange(node, evidence.tab) &&
    (
      acceptedFact.windowId !== evidence.tab.windowId ||
      (acceptedFact.index !== undefined && acceptedFact.index !== evidence.tab.index) ||
      (acceptedFact.active !== undefined && acceptedFact.active !== evidence.tab.active)
    )
  ) {
    return true;
  }

  const projectedIndex = projectedRuntimeTabIndex(state, index, evidence.tab.id, evidence.tab.windowId);
  if (
    projectedIndex !== undefined &&
    !evidence.changedFields.has("index") &&
    evidence.tab.index !== projectedIndex
  ) {
    return true;
  }

  if (!evidence.changedFields.has("active") && evidence.tab.active !== (node.active === true)) {
    return true;
  }

  if (!evidence.changedFields.has("title") && evidence.tab.title !== undefined && evidence.tab.title !== node.title) {
    return true;
  }

  if (!evidence.changedFields.has("url") && evidence.tab.url !== undefined && evidence.tab.url !== node.url) {
    return true;
  }

  if (
    !evidence.changedFields.has("favIconUrl") &&
    evidence.tab.favIconUrl !== undefined &&
    evidence.tab.favIconUrl !== node.favIconUrl
  ) {
    return true;
  }

  return false;
}

function tabMetadataEvidenceChanged(evidence: RuntimeTabEvidence): boolean {
  return evidence.changedFields.has("title") ||
    evidence.changedFields.has("url") ||
    evidence.changedFields.has("favIconUrl");
}

function projectedRuntimeTabIndex(
  state: OutlineState,
  index: RuntimeStateIndexForReconciliation,
  tabId: number,
  windowId: number
): number | undefined {
  const windowNode = indexedLiveWindowNodeByRuntimeId(state, index, windowId);
  if (!windowNode) {
    return undefined;
  }
  const projectedIndex = projectLiveTabs(state, windowNode.id).findIndex((tab) =>
    tab.windowId === windowId &&
    tab.tabId === tabId
  );
  return projectedIndex >= 0 ? projectedIndex : undefined;
}

function liveTabNodeWouldChange(node: LiveTabNode, tab: RuntimeTab): boolean {
  const nextTitle = runtimeTitleForOutlineTab(node, tab);
  return node.active !== tab.active ||
    (tab.url !== undefined && node.url !== tab.url) ||
    node.title !== nextTitle ||
    (tab.favIconUrl !== undefined && node.favIconUrl !== tab.favIconUrl);
}

function isTransientRestoredTabEcho(tab: RuntimeTab): boolean {
  return tab.url === "about:blank" ||
    tab.url === "about:newtab" ||
    tab.title === "New Tab";
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

function liveWindowNodes(state: OutlineState): LiveWindowNode[] {
  return Object.values(state.nodes).filter(isLiveWindowNode);
}
