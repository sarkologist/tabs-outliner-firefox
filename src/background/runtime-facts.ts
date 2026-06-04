import type { BackgroundCommand, RuntimeClosePlan } from "./commands.js";
import {
  RuntimeWindowScopeIndex,
  type RuntimeWindowScope,
  type RuntimeWindowScopeProvenanceResolverInput,
  type RuntimeWindowScopeSnapshot
} from "./runtime-window-scope.js";
import type { NodeId, OutlineNode, OutlineState, RuntimeTab, RuntimeWindow, RuntimeWindowProvenance } from "../model/types.js";

export type RuntimeSnapshotConfidence = "complete" | "partial" | "eventLocal" | "staleSuspect";
export type RuntimeShapeFactConfidence = RuntimeSnapshotConfidence | "installedState";
export type RuntimeTabEvidenceKind = "created" | "updated";
export type RuntimeTabEvidenceField =
  | "windowId"
  | "index"
  | "active"
  | "openerTabId"
  | "url"
  | "title"
  | "favIconUrl";

export type RuntimeTabEvidence = {
  kind: RuntimeTabEvidenceKind;
  tab: RuntimeTab;
  changedFields: ReadonlySet<RuntimeTabEvidenceField>;
  confidence: "eventLocal";
  scopeGeneration: number;
  sequence: number;
};

export type RuntimeTabShapeFact = {
  tabId: number;
  windowId: number;
  index?: number;
  active?: boolean;
  title?: string;
  url?: string;
  favIconUrl?: string;
  source: "command" | "tabEvent" | "snapshot" | "installedState";
  confidence: RuntimeShapeFactConfidence;
  scopeGeneration: number;
  sequence: number;
};

export type RuntimeWindowShapeFact = {
  windowId: number;
  tabOrder: number[];
  activeTabId?: number;
  focused?: boolean;
  state?: RuntimeWindow["state"];
  source: "command" | "tabEvent" | "windowEvent" | "snapshot" | "installedState";
  confidence: RuntimeShapeFactConfidence;
  scopeGeneration: number;
  sequence: number;
};

export type RuntimeAcceptedTabScopeUpdate = {
  tab: RuntimeTab;
  tabNodeId: NodeId;
  windowNodeId?: NodeId;
  windowState?: RuntimeWindow["state"];
  sequence: number;
  preserveOrder?: boolean;
};

export type RuntimeObservation =
  | {
      source: "tabEvent";
      kind: "created" | "updated" | "activated" | "removed" | "attached" | "detached" | "moved";
      tabId: number;
      windowId?: number;
      tab?: RuntimeTab;
    }
  | {
      source: "windowEvent";
      kind: "focused" | "removed" | "boundsChanged";
      windowId: number;
      window?: RuntimeWindow;
    }
  | {
      source: "sessionEvent";
      kind: "changed";
    }
  | {
      source: "snapshot";
      confidence: RuntimeSnapshotConfidence;
      windows: RuntimeWindow[];
    }
  | {
      source: "command";
      commandId: string;
      kind: "planned" | "observed" | "committed" | "rejected";
    };

export type CommandOwnership = "outliner-close" | "delete" | "relocation" | "restore" | "focus";

export type CommandTransaction = {
  id: string;
  commandType: BackgroundCommand["type"];
  plannedTabs: number[];
  plannedWindows: number[];
  expectedEchoes: RuntimeObservation[];
  ownership: CommandOwnership;
};

export type CommandRelocatedTabEcho = {
  fromWindowIds: Set<number>;
  sequence: number;
  sourceIndex?: number | undefined;
  sourceWindowId: number;
  toWindowId: number;
};

export type RuntimeFactLedgerDebugSnapshot = {
  scopeGeneration: number;
  windowScopes: RuntimeWindowScopeSnapshot[];
  ignoredTabIds: number[];
  ignoredWindowIds: number[];
  browserCreatedWindowIds: number[];
  commandCreatedWindowIds: number[];
  commandRestoredTabIds: number[];
  commandRelocatedTabEchoes: Array<{
    tabId: number;
    fromWindowIds: number[];
    sequence: number;
    sourceIndex?: number | undefined;
    sourceWindowId: number;
    toWindowId: number;
  }>;
  acceptedTabShapeFacts: RuntimeTabShapeFact[];
  acceptedWindowShapeFacts: RuntimeWindowShapeFact[];
};

export type CommandTransactionFacts = {
  outlinerClosePlan?: RuntimeClosePlan | undefined;
  deleteClosePlan?: RuntimeClosePlan | undefined;
  focusTarget?: { tabId: number; windowId: number } | undefined;
};

type LiveTabNode = OutlineNode & { live: { tabId: number; windowId: number } };

export type WindowClosingTabRemovalDecision =
  | "ignore-command-owned"
  | "wait-for-runtime-window"
  | "wait-for-remaining-tabs"
  | "close-window";

export type NativeTabRemovedDecision = "ignore-delete-owned" | "continue";
export type NativeTabUpdatedDecision = "command-focus-active" | "refresh";
export type NativeTabUpdatedRecord = {
  decision: NativeTabUpdatedDecision;
  evidence: RuntimeTabEvidence;
};
export type NativeFocusEventDecision = "command-focus" | "runtime-refresh";
export type NativeWindowRemovedDecision = "ignore-duplicate" | "ignore-delete-owned" | "close-window";

export class RuntimeFactLedger {
  private readonly outlinerClosingTabIds = new Set<number>();
  private readonly outlinerClosingWindowIds = new Set<number>();
  private readonly outlinerClosedTabIds = new Set<number>();
  private readonly outlinerClosedWindowIds = new Set<number>();
  private readonly deleteOwnedClosingTabIds = new Set<number>();
  private readonly deleteOwnedClosingWindowIds = new Set<number>();
  private readonly removedTabIds = new Set<number>();
  private readonly removedWindowIds = new Set<number>();
  private readonly browserCreatedWindowIds = new Set<number>();
  private readonly commandCreatedWindowIds = new Set<number>();
  private readonly commandRestoredTabIds = new Set<number>();
  private readonly commandRelocatedTabEchoes = new Map<number, CommandRelocatedTabEcho>();
  private readonly commandFocusedTabIds = new Set<number>();
  private readonly commandFocusedActivationWindowIds = new Set<number>();
  private readonly commandFocusedWindowIds = new Set<number>();
  private readonly windowScopes = new RuntimeWindowScopeIndex();
  private readonly tabShapeFacts = new Map<number, RuntimeTabShapeFact>();
  private readonly windowShapeFacts = new Map<number, RuntimeWindowShapeFact>();
  private readonly structurallyFreshTabIds = new Set<number>();
  private readonly observations: RuntimeObservation[] = [];
  private readonly transactions = new Map<string, CommandTransaction>();
  private reconstructedLiveTabIds = new Set<number>();
  private reconstructedLiveWindowIds = new Set<number>();
  private reconstructedMaxTabId = 0;
  private reconstructedMaxWindowId = 0;
  private observationSequence = 0;
  private scopeGeneration = 0;
  private installedShapeSignature = "";
  private commandCloseSessionEchoesToSkip = 0;
  private commandCloseSessionEchoesSkippedBeforeRemoval = 0;
  private nextCommandSequence = 1;

  constructor(private readonly maxObservations = 500) {}

  private nextObservationSequence(): number {
    this.observationSequence += 1;
    return this.observationSequence;
  }

  private runtimeTabEvidence(
    kind: RuntimeTabEvidenceKind,
    tab: RuntimeTab,
    changedFields: ReadonlySet<RuntimeTabEvidenceField>,
    sequence: number
  ): RuntimeTabEvidence {
    return {
      kind,
      tab,
      changedFields,
      confidence: "eventLocal",
      scopeGeneration: this.scopeGeneration,
      sequence
    };
  }

  private recordSnapshotShapeFacts(
    windows: readonly RuntimeWindow[],
    confidence: RuntimeSnapshotConfidence,
    sequence: number
  ): void {
    for (const windowInfo of windows) {
      if (windowInfo.incognito) {
        continue;
      }
      const tabs = [...(windowInfo.tabs ?? [])]
        .filter((tab) => !tab.incognito)
        .sort((left, right) => left.index - right.index);
      const activeTabId = tabs.find((tab) => tab.active)?.id;
      this.recordWindowShapeFact({
        windowInfo,
        tabOrder: tabs.map((tab) => tab.id),
        ...(typeof activeTabId === "number" ? { activeTabId } : {}),
        activeTabIdKnown: true,
        source: "snapshot",
        confidence,
        sequence
      });
      for (const tab of tabs) {
        const previousFact = this.tabShapeFacts.get(tab.id);
        if (
          previousFact &&
          (
            previousFact.windowId !== tab.windowId ||
            (previousFact.index !== undefined && previousFact.index !== tab.index) ||
            (previousFact.active !== undefined && previousFact.active !== tab.active)
          )
        ) {
          this.structurallyFreshTabIds.add(tab.id);
        }
        this.tabShapeFacts.set(tab.id, {
          tabId: tab.id,
          windowId: tab.windowId,
          index: tab.index,
          active: tab.active,
          ...(tab.title !== undefined ? { title: tab.title } : {}),
          ...(tab.url !== undefined ? { url: tab.url } : {}),
          ...(tab.favIconUrl !== undefined ? { favIconUrl: tab.favIconUrl } : {}),
          source: "snapshot",
          confidence,
          scopeGeneration: this.scopeGeneration,
          sequence
        });
      }
    }
  }

  private recordWindowShapeFact(input: {
    windowInfo: RuntimeWindow;
    tabOrder?: number[];
    activeTabId?: number;
    activeTabIdKnown?: boolean;
    source: RuntimeWindowShapeFact["source"];
    confidence: RuntimeShapeFactConfidence;
    sequence: number;
  }): void {
    const previousFact = this.windowShapeFacts.get(input.windowInfo.id);
    this.windowShapeFacts.set(input.windowInfo.id, {
      windowId: input.windowInfo.id,
      tabOrder: input.tabOrder ?? previousFact?.tabOrder ?? [],
      ...(typeof input.activeTabId === "number"
        ? { activeTabId: input.activeTabId }
        : input.activeTabIdKnown === true
          ? {}
          : typeof previousFact?.activeTabId === "number"
            ? { activeTabId: previousFact.activeTabId }
            : {}),
      focused: input.windowInfo.focused,
      ...(input.windowInfo.state ? { state: input.windowInfo.state } : previousFact?.state ? { state: previousFact.state } : {}),
      source: input.source,
      confidence: input.confidence,
      scopeGeneration: this.scopeGeneration,
      sequence: input.sequence
    });
  }

  private recordInstalledStateShape(
    state: OutlineState,
    nodes?: readonly OutlineNode[],
    options: { preserveInstalledOrder?: boolean } = {}
  ): void {
    const scopeSnapshots = this.windowScopes.snapshots();
    const signature = scopeSnapshots
      .filter((scope) => scope.lifecycle === "live")
      .sort((left, right) => left.runtimeWindowId - right.runtimeWindowId)
      .map((scope) => [
        scope.runtimeWindowId,
        scope.provenance,
        scope.lifecycle,
        scope.tabOrder.join(","),
        scope.activeTabId ?? ""
      ].join(":"))
      .join("|");
    if (signature !== this.installedShapeSignature) {
      this.installedShapeSignature = signature;
      this.scopeGeneration += 1;
    }

    const nodeList = nodes ?? Object.values(state.nodes);
    const tabIndexByRuntimeId = new Map<number, number>();
    for (const scope of scopeSnapshots) {
      const previousWindowFact = this.windowShapeFacts.get(scope.runtimeWindowId);
      const currentTabOrder = scope.tabOrder.filter((tabId) => !this.isTabIgnoredForRefresh(tabId));
      const tabOrder = previousWindowFact &&
        runtimeWindowShapeFactCanOrderInstalledState(previousWindowFact, options)
        ? runtimeOrderPreservingKnownTabs(previousWindowFact.tabOrder, currentTabOrder)
        : currentTabOrder;
      if (scope.lifecycle === "live") {
        this.reconstructedLiveWindowIds.add(scope.runtimeWindowId);
        this.windowScopes.syncLiveWindowOrder(scope.runtimeWindowId, tabOrder, { pruneMissing: true });
        for (const tabId of tabOrder) {
          this.reconstructedLiveTabIds.add(tabId);
        }
      }
      for (let index = 0; index < tabOrder.length; index += 1) {
        const tabId = tabOrder[index]!;
        tabIndexByRuntimeId.set(tabId, index);
      }
      if (scope.lifecycle === "live") {
        this.windowShapeFacts.set(scope.runtimeWindowId, {
          windowId: scope.runtimeWindowId,
          tabOrder,
          ...(typeof scope.activeTabId === "number" ? { activeTabId: scope.activeTabId } : {}),
          ...(scope.state ? { state: scope.state } : {}),
          source: "installedState",
          confidence: "installedState",
          scopeGeneration: this.scopeGeneration,
          sequence: this.observationSequence
        });
      }
    }

    for (const node of nodeList) {
      if (!isLiveTabNode(node)) {
        continue;
      }
      if (this.isTabIgnoredForRefresh(node.live.tabId)) {
        this.tabShapeFacts.delete(node.live.tabId);
        continue;
      }
      this.tabShapeFacts.set(node.live.tabId, {
        tabId: node.live.tabId,
        windowId: node.live.windowId,
        ...(tabIndexByRuntimeId.has(node.live.tabId) ? { index: tabIndexByRuntimeId.get(node.live.tabId)! } : {}),
        active: node.active === true,
        title: node.title,
        ...(node.url !== undefined ? { url: node.url } : {}),
        ...(node.favIconUrl !== undefined ? { favIconUrl: node.favIconUrl } : {}),
        source: "installedState",
        confidence: "installedState",
        scopeGeneration: this.scopeGeneration,
        sequence: this.observationSequence
      });
    }
  }

  recordObservation(observation: RuntimeObservation): number {
    const sequence = this.nextObservationSequence();
    this.observations.push(observation);
    if (this.observations.length > this.maxObservations) {
      this.observations.splice(0, this.observations.length - this.maxObservations);
    }
    if (observation.source === "snapshot" && observation.confidence === "complete") {
      for (const windowInfo of observation.windows) {
        this.observeLiveWindowIfAccepted(windowInfo.id);
        for (const tab of windowInfo.tabs ?? []) {
          this.observeLiveTabIfAccepted(tab);
        }
      }
    }
    if (observation.source === "snapshot") {
      this.recordSnapshotShapeFacts(observation.windows, observation.confidence, sequence);
      this.syncWindowScopeActiveTabsFromShapeFacts();
    }
    return sequence;
  }

  observationsSnapshot(): RuntimeObservation[] {
    return [...this.observations];
  }

  reconstructFromState(
    state: OutlineState,
    windows: readonly RuntimeWindow[],
    nodes: readonly OutlineNode[] = Object.values(state.nodes)
  ): void {
    const liveStateTabIds = new Set<number>();
    const liveStateWindowIds = new Set<number>();
    const canonicalTabIds: number[] = [];
    const canonicalWindowIds: number[] = [];
    for (const node of nodes) {
      if (isLiveTabNode(node)) {
        liveStateTabIds.add(node.live.tabId);
      } else if (isLiveWindowNode(node)) {
        liveStateWindowIds.add(node.live.windowId);
        if (node.runtimeProvenance === "browserCreated") {
          this.browserCreatedWindowIds.add(node.live.windowId);
          this.commandCreatedWindowIds.delete(node.live.windowId);
        } else if (node.runtimeProvenance === "commandCreated") {
          this.commandCreatedWindowIds.add(node.live.windowId);
          this.browserCreatedWindowIds.delete(node.live.windowId);
        }
      }

      const canonicalTabId = canonicalRuntimeIdFromNodeId(node.id, "tab");
      if (canonicalTabId !== undefined) {
        canonicalTabIds.push(canonicalTabId);
      }
      const canonicalWindowId = canonicalRuntimeIdFromNodeId(node.id, "window");
      if (canonicalWindowId !== undefined) {
        canonicalWindowIds.push(canonicalWindowId);
      }
    }

    const runtimeTabIds = new Set(windows.flatMap((windowInfo) => windowInfo.tabs ?? []).map((tab) => tab.id));
    const runtimeWindowIds = new Set(windows.map((windowInfo) => windowInfo.id));
    this.reconstructedLiveTabIds = new Set([...liveStateTabIds, ...runtimeTabIds]);
    this.reconstructedLiveWindowIds = new Set([...liveStateWindowIds, ...runtimeWindowIds]);
    this.reconstructedMaxTabId = maxNumericId(this.reconstructedLiveTabIds);
    this.reconstructedMaxWindowId = maxNumericId(this.reconstructedLiveWindowIds);

    for (const canonicalTabId of canonicalTabIds) {
      if (
        !liveStateTabIds.has(canonicalTabId) &&
        !runtimeTabIds.has(canonicalTabId)
      ) {
        this.markTabRemoved(canonicalTabId);
      }
    }

    for (const canonicalWindowId of canonicalWindowIds) {
      if (
        !liveStateWindowIds.has(canonicalWindowId) &&
        !runtimeWindowIds.has(canonicalWindowId)
      ) {
        this.markWindowRemoved(canonicalWindowId);
      }
    }

    for (const tabId of runtimeTabIds) {
      this.removedTabIds.delete(tabId);
    }
    for (const windowId of runtimeWindowIds) {
      this.removedWindowIds.delete(windowId);
    }
    this.rebuildWindowScopes(state, windows, nodes);
  }

  rebuildWindowScopes(
    state: OutlineState,
    windows?: readonly RuntimeWindow[],
    nodes?: readonly OutlineNode[]
  ): void {
    const hasExplicitRuntimeWindows = windows !== undefined;
    const scopeWindows = windows ?? this.windowsFromAcceptedShapeFacts(state);
    this.windowScopes.rebuild({
      state,
      ...(nodes ? { nodes } : {}),
      windows: scopeWindows,
      browserCreatedWindowIds: this.browserCreatedWindowIds,
      commandCreatedWindowIds: this.commandCreatedWindowIds,
      ignoredTabIds: this.ignoredTabIdsForRefresh(),
      ignoredWindowIds: this.ignoredWindowIdsForRefresh(),
      resolveProvenance: (input) => this.resolveRuntimeWindowScopeProvenance(input)
    });
    this.reconcileWindowScopeActiveTabs(state, nodes);
    this.recordInstalledStateShape(state, nodes, { preserveInstalledOrder: !hasExplicitRuntimeWindows });
    this.syncWindowScopeActiveTabsFromShapeFacts();
  }

  windowScopesMatchRuntimeWindows(windows: readonly RuntimeWindow[]): boolean {
    return this.windowScopes.matchesLiveRuntimeWindows(windows, {
      ignoredTabIds: this.ignoredTabIdsForRefresh(),
      ignoredWindowIds: this.ignoredWindowIdsForRefresh()
    });
  }

  updateWindowScopesFromStateTransition(
    previous: OutlineState,
    next: OutlineState,
    candidateNodeIds?: readonly NodeId[],
    options: {
      runtimeWindows?: readonly RuntimeWindow[];
      outlineSyncedRuntimeWindowIds?: readonly number[];
    } = {}
  ): boolean {
    if (!candidateNodeIds) {
      return false;
    }

    const affectedWindowIds = affectedRuntimeWindowIdsForStateTransition(previous, next, candidateNodeIds);
    for (const windowId of options.outlineSyncedRuntimeWindowIds ?? []) {
      affectedWindowIds.add(windowId);
    }
    if (affectedWindowIds.size === 0) {
      return true;
    }
    const closedRuntimeTabIds = closedRuntimeTabIdsForStateTransition(previous, next, candidateNodeIds);
    if (
      closedRuntimeTabIds.size > 0 &&
      !candidateTransitionHasLiveTabInsertOrMove(previous, next, candidateNodeIds) &&
      [...closedRuntimeTabIds].every((tabId) => !this.windowScopes.scopeForTab(tabId))
    ) {
      for (const windowId of affectedWindowIds) {
        const previousScope = this.windowScopes.scopeForWindow(windowId);
        if (
          previousScope?.lifecycle === "live" &&
          !liveWindowNodeForRuntimeId(next, windowId, candidateNodeIds, previousScope.outlineWindowNodeId)
        ) {
          this.windowScopes.markWindowRemoved(windowId);
        }
      }
      this.removeInstalledShapeFactsForClosedCandidateTabs(previous, next, candidateNodeIds);
      return true;
    }

    const candidateRuntimeTabIds = runtimeTabIdsForCandidateNodes(previous, next, candidateNodeIds);
    const runtimeWindowsById = new Map((options.runtimeWindows ?? []).map((windowInfo) => [windowInfo.id, windowInfo]));
    const outlineSyncedWindowIds = new Set(options.outlineSyncedRuntimeWindowIds ?? []);
    let advancedGeneration = false;
    const advanceGeneration = (): void => {
      if (advancedGeneration) {
        return;
      }
      this.scopeGeneration += 1;
      this.installedShapeSignature = "";
      advancedGeneration = true;
    };

    for (const windowId of affectedWindowIds) {
      const previousScope = this.windowScopes.scopeForWindow(windowId);
      const windowNode = liveWindowNodeForRuntimeId(next, windowId, candidateNodeIds, previousScope?.outlineWindowNodeId);
      if (!windowNode) {
        if (previousScope?.lifecycle === "live") {
          advanceGeneration();
          this.windowScopes.markWindowRemoved(windowId);
        }
        continue;
      }

      const runtimeWindow = runtimeWindowsById.get(windowId);
      const orderCandidateTabNodes = candidateLiveTabNodesAffectingRuntimeOrder(previous, next, windowNode, candidateNodeIds);
      let tabNodes: LiveTabNode[];
      if (runtimeWindow) {
        tabNodes = liveTabNodesFromRuntimeWindowOrder(next, runtimeWindow, candidateNodeIds, previousScope);
      } else if (outlineSyncedWindowIds.has(windowId)) {
        tabNodes = outlineOrderedLiveTabNodesForRuntimeWindow(next, windowNode);
      } else if (previousScope && closedRuntimeTabIds.size > 0) {
        tabNodes = liveTabNodesFromExistingScopeOrder(next, windowId, previousScope);
      } else if ((previousScope?.tabOrder.length ?? 0) === 0 && orderCandidateTabNodes.length > 0) {
        tabNodes = orderCandidateTabNodes;
      } else if (previousScope && orderCandidateTabNodes.length === 0) {
        tabNodes = liveTabNodesFromExistingScopeOrder(next, windowId, previousScope);
      } else {
        tabNodes = outlineOrderedLiveTabNodesForRuntimeWindow(next, windowNode);
      }
      const tabOrder = tabNodes.map((tabNode) => tabNode.live.tabId);
      const activeTabId = tabNodes.find((tabNode) => tabNode.active === true)?.live.tabId;
      const previousWindowFact = this.windowShapeFacts.get(windowId);
      const state = runtimeWindow?.state ?? previousWindowFact?.state ?? previousScope?.state;
      const provenance = this.resolveRuntimeWindowScopeProvenance({
        runtimeWindowId: windowId,
        outlineWindowNode: windowNode,
        hasRuntimeWindow: true,
        runtimeOnly: false
      });
      if (
        !previousScope ||
        previousScope.lifecycle !== "live" ||
        previousScope.outlineWindowNodeId !== windowNode.id ||
        previousScope.provenance !== provenance ||
        previousScope.activeTabId !== activeTabId ||
        !sameNumberList(previousScope.tabOrder, tabOrder) ||
        previousScope.state !== state
      ) {
        advanceGeneration();
      }

      this.windowScopes.upsertLiveWindow({
        runtimeWindowId: windowId,
        outlineWindowNodeId: windowNode.id,
        ...(state ? { state } : {}),
        provenance
      });
      this.windowScopes.replaceLiveWindowTabs({
        runtimeWindowId: windowId,
        tabNodeIdsByRuntimeId: new Map(tabNodes.map((tabNode) => [tabNode.live.tabId, tabNode.id])),
        tabOrder,
        ...(typeof activeTabId === "number" ? { activeTabId } : {})
      });
      this.recordInstalledStateShapeForWindow(windowNode, tabNodes, candidateRuntimeTabIds);
    }

    this.removeInstalledShapeFactsForClosedCandidateTabs(previous, next, candidateNodeIds);
    return true;
  }

  private recordInstalledStateShapeForWindow(
    windowNode: OutlineNode & { live: { windowId: number } },
    tabNodes: readonly LiveTabNode[],
    candidateRuntimeTabIds: ReadonlySet<number>
  ): void {
    const windowId = windowNode.live.windowId;
    const scope = this.windowScopes.scopeForWindow(windowId);
    if (!scope || scope.lifecycle !== "live") {
      return;
    }

    const tabOrder = scope.tabOrder.filter((tabId) => !this.isTabIgnoredForRefresh(tabId));
    const previousWindowFact = this.windowShapeFacts.get(windowId);
    this.reconstructedLiveWindowIds.add(windowId);
    for (const tabId of tabOrder) {
      this.reconstructedLiveTabIds.add(tabId);
    }
    this.windowShapeFacts.set(windowId, {
      windowId,
      tabOrder,
      ...(typeof scope.activeTabId === "number" ? { activeTabId: scope.activeTabId } : {}),
      focused: windowNode.active === true,
      ...(scope.state ? { state: scope.state } : previousWindowFact?.state ? { state: previousWindowFact.state } : {}),
      source: "installedState",
      confidence: "installedState",
      scopeGeneration: this.scopeGeneration,
      sequence: this.observationSequence
    });

    const indexByRuntimeId = new Map(tabOrder.map((tabId, index) => [tabId, index]));
    for (const tabNode of tabNodes) {
      if (
        !candidateRuntimeTabIds.has(tabNode.live.tabId) &&
        this.tabShapeFacts.has(tabNode.live.tabId)
      ) {
        continue;
      }
      if (this.isTabIgnoredForRefresh(tabNode.live.tabId)) {
        this.tabShapeFacts.delete(tabNode.live.tabId);
        continue;
      }
      this.tabShapeFacts.set(tabNode.live.tabId, {
        tabId: tabNode.live.tabId,
        windowId,
        ...(indexByRuntimeId.has(tabNode.live.tabId) ? { index: indexByRuntimeId.get(tabNode.live.tabId)! } : {}),
        active: tabNode.active === true,
        title: tabNode.title,
        ...(tabNode.url !== undefined ? { url: tabNode.url } : {}),
        ...(tabNode.favIconUrl !== undefined ? { favIconUrl: tabNode.favIconUrl } : {}),
        source: "installedState",
        confidence: "installedState",
        scopeGeneration: this.scopeGeneration,
        sequence: this.observationSequence
      });
    }
  }

  private removeInstalledShapeFactsForClosedCandidateTabs(
    previous: OutlineState,
    next: OutlineState,
    candidateNodeIds: readonly NodeId[]
  ): void {
    for (const nodeId of candidateNodeIds) {
      const previousNode = previous.nodes[nodeId];
      const nextNode = next.nodes[nodeId];
      if (!isLiveTabNode(previousNode) || isLiveTabNode(nextNode)) {
        continue;
      }
      this.tabShapeFacts.delete(previousNode.live.tabId);
      this.removeTabFromWindowShapeFact(previousNode.live.windowId, previousNode.live.tabId);
    }
  }

  private reconcileWindowScopeActiveTabs(state: OutlineState, nodes?: readonly OutlineNode[]): void {
    const tabsByWindowId = new Map<number, LiveTabNode[]>();
    for (const node of nodes ?? Object.values(state.nodes)) {
      if (!isLiveTabNode(node)) {
        continue;
      }
      const tabs = tabsByWindowId.get(node.live.windowId) ?? [];
      tabs.push(node);
      tabsByWindowId.set(node.live.windowId, tabs);
    }

    for (const [windowId, tabNodes] of tabsByWindowId) {
      const scope = this.windowScopes.scopeForWindow(windowId);
      if (!scope) {
        continue;
      }
      const factActiveTab = tabNodes.find((tabNode) => {
        const fact = this.tabShapeFacts.get(tabNode.live.tabId);
        return fact?.windowId === tabNode.live.windowId && fact.source !== "installedState" && fact.active === true;
      });
      if (factActiveTab) {
        scope.activeTabId = factActiveTab.live.tabId;
        continue;
      }

      const allKnownInactive = tabNodes.length > 0 && tabNodes.every((tabNode) => {
        const fact = this.tabShapeFacts.get(tabNode.live.tabId);
        return (fact?.windowId === tabNode.live.windowId && fact.active === false) || tabNode.active === false;
      });
      if (allKnownInactive) {
        delete scope.activeTabId;
        continue;
      }

      const nodeActiveTab = tabNodes.find((tabNode) => tabNode.active === true);
      if (nodeActiveTab) {
        scope.activeTabId = nodeActiveTab.live.tabId;
      } else {
        delete scope.activeTabId;
      }
    }
  }

  private windowsFromAcceptedShapeFacts(state: OutlineState): RuntimeWindow[] {
    const liveTabs = liveTabNodes(state).filter((tabNode) => !this.isTabIgnoredForRefresh(tabNode.live.tabId));
    return liveWindowNodes(state).filter((windowNode) => !this.isWindowIgnoredForRefresh(windowNode.live.windowId)).map((windowNode): RuntimeWindow => {
      const windowId = windowNode.live.windowId;
      const windowFact = this.windowShapeFacts.get(windowId);
      const currentScopeOrder = this.windowScopes.scopeForWindow(windowId)?.tabOrder;
      const tabs = currentOrOutlineOrderedLiveTabsForRuntimeWindow(state, windowNode, liveTabs, currentScopeOrder)
        .map((tabNode, index): RuntimeTab => {
          const tabFact = this.tabShapeFacts.get(tabNode.live.tabId);
          const scopedTabFact = tabFact?.windowId === windowId ? tabFact : undefined;
          return {
            id: tabNode.live.tabId,
            windowId,
            index,
            active: typeof scopedTabFact?.active === "boolean" && scopedTabFact.source !== "installedState"
              ? scopedTabFact.active
              : tabNode.active === true,
            ...(tabNode.url !== undefined ? { url: tabNode.url } : {}),
            title: tabNode.title,
            ...(tabNode.favIconUrl !== undefined ? { favIconUrl: tabNode.favIconUrl } : {})
          };
        });
      return {
        id: windowId,
        focused: windowNode.active === true,
        incognito: false,
        ...(windowFact?.state ? { state: windowFact.state } : {}),
        tabs
      };
    });
  }

  private syncWindowScopeActiveTabsFromShapeFacts(): void {
    for (const snapshot of this.windowScopes.snapshots()) {
      if (snapshot.lifecycle !== "live") {
        continue;
      }
      const scope = this.windowScopes.scopeForWindow(snapshot.runtimeWindowId);
      if (!scope) {
        continue;
      }

      const windowFact = this.windowShapeFacts.get(snapshot.runtimeWindowId);
      const scopedTabOrder = windowFact &&
        runtimeWindowShapeFactCanOrderInstalledState(windowFact, { preserveInstalledOrder: true })
        ? runtimeOrderPreservingKnownTabs(windowFact.tabOrder, snapshot.tabOrder)
        : snapshot.tabOrder;
      const acceptedTabOrder = scopedTabOrder.filter((tabId) => !this.isTabIgnoredForRefresh(tabId));
      this.windowScopes.syncLiveWindowOrder(snapshot.runtimeWindowId, acceptedTabOrder, { pruneMissing: true });

      const activeTabId = acceptedTabOrder.find((tabId) => {
        const fact = this.tabShapeFacts.get(tabId);
        return fact?.windowId === snapshot.runtimeWindowId && fact.active === true;
      });
      if (typeof activeTabId === "number") {
        scope.activeTabId = activeTabId;
        continue;
      }

      const allKnownInactive = acceptedTabOrder.length > 0 &&
        acceptedTabOrder.every((tabId) => {
          const fact = this.tabShapeFacts.get(tabId);
          return fact?.windowId === snapshot.runtimeWindowId && fact.active === false;
        });
      if (allKnownInactive) {
        delete scope.activeTabId;
        continue;
      }

      if (
        typeof windowFact?.activeTabId === "number" &&
        (
          this.tabShapeFacts.get(windowFact.activeTabId)?.windowId !== snapshot.runtimeWindowId ||
          this.tabShapeFacts.get(windowFact.activeTabId)?.active !== false
        )
      ) {
        scope.activeTabId = windowFact.activeTabId;
      } else {
        delete scope.activeTabId;
      }
    }
  }

  closedRestoreNodeIdsExcludedFromRuntimeAttach(state: OutlineState): Set<NodeId> {
    const excluded = new Set<NodeId>();

    for (const [tabId, nodeId] of this.windowScopes.removedTabNodeIdEntries()) {
      const node = state.nodes[nodeId];
      if (this.outlinerClosedTabIds.has(tabId) && node?.kind === "tab" && node.status === "closed") {
        excluded.add(nodeId);
      }
    }

    for (const node of Object.values(state.nodes)) {
      if (node.kind !== "tab" || node.status !== "closed") {
        continue;
      }
      if (node.restore?.closedBy === "outliner") {
        excluded.add(node.id);
      }
      const tabId = canonicalRuntimeIdFromNodeId(node.id, "tab");
      if (tabId !== undefined && this.outlinerClosedTabIds.has(tabId)) {
        excluded.add(node.id);
      }
    }

    return excluded;
  }

  windowScope(windowId: number): RuntimeWindowScope | undefined {
    return this.windowScopes.scopeForWindow(windowId);
  }

  windowScopeForTab(tabId: number): RuntimeWindowScope | undefined {
    return this.windowScopes.scopeForTab(tabId);
  }

  resolveRuntimeWindowScopeProvenance(
    input: RuntimeWindowScopeProvenanceResolverInput
  ): RuntimeWindowScope["provenance"] {
    if (this.commandCreatedWindowIds.has(input.runtimeWindowId)) {
      return "commandCreated";
    }
    if (this.browserCreatedWindowIds.has(input.runtimeWindowId)) {
      return "browserCreated";
    }

    const node = input.outlineWindowNode;
    if (isLiveWindowNode(node)) {
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

    return input.runtimeOnly || input.hasRuntimeWindow ? "browserCreated" : "commandCreated";
  }

  windowScopeSnapshots(): RuntimeWindowScopeSnapshot[] {
    return this.windowScopes.snapshots();
  }

  nodeTouchesRemovedRuntimeScope(state: OutlineState, nodeId: NodeId): boolean {
    if (this.windowScopes.nodeTouchesRemovedRuntimeScope(state, nodeId)) {
      return true;
    }

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
      if (node.status === "closed" && node.kind === "window") {
        const runtimeWindowId = canonicalRuntimeIdFromNodeId(node.id, "window");
        if (runtimeWindowId !== undefined && this.removedWindowIds.has(runtimeWindowId)) {
          return true;
        }
      }
      if (node.status === "closed" && node.kind === "tab") {
        const runtimeTabId = canonicalRuntimeIdFromNodeId(node.id, "tab");
        if (runtimeTabId !== undefined && this.removedTabIds.has(runtimeTabId)) {
          return true;
        }
      }
      stack.push(...node.childIds);
    }
    return false;
  }

  beginCommandTransaction(input: {
    commandType: BackgroundCommand["type"];
    plannedTabs?: readonly number[];
    plannedWindows?: readonly number[];
    expectedEchoes?: readonly RuntimeObservation[];
    ownership: CommandOwnership;
  }): CommandTransaction {
    const transaction: CommandTransaction = {
      id: `cmd:${this.nextCommandSequence++}`,
      commandType: input.commandType,
      plannedTabs: [...(input.plannedTabs ?? [])],
      plannedWindows: [...(input.plannedWindows ?? [])],
      expectedEchoes: [...(input.expectedEchoes ?? [])],
      ownership: input.ownership
    };
    this.transactions.set(transaction.id, transaction);
    this.recordObservation({
      source: "command",
      commandId: transaction.id,
      kind: "planned"
    });
    return transaction;
  }

  beginCommandTransactionForCommand(
    commandType: BackgroundCommand["type"],
    facts: CommandTransactionFacts = {}
  ): CommandTransaction | undefined {
    const ownership = commandOwnershipForType(commandType);
    if (!ownership) {
      return undefined;
    }

    const plannedTabs = new Set<number>();
    const plannedWindows = new Set<number>();
    for (const tabId of facts.outlinerClosePlan?.tabIds ?? []) {
      plannedTabs.add(tabId);
    }
    for (const windowId of facts.outlinerClosePlan?.windowIds ?? []) {
      plannedWindows.add(windowId);
    }
    for (const tabId of facts.deleteClosePlan?.tabIds ?? []) {
      plannedTabs.add(tabId);
    }
    for (const windowId of facts.deleteClosePlan?.windowIds ?? []) {
      plannedWindows.add(windowId);
    }
    if (facts.focusTarget) {
      plannedTabs.add(facts.focusTarget.tabId);
      plannedWindows.add(facts.focusTarget.windowId);
    }

    return this.beginCommandTransaction({
      commandType,
      plannedTabs: [...plannedTabs],
      plannedWindows: [...plannedWindows],
      ownership
    });
  }

  recordCommandObserved(commandId: string): void {
    if (!this.transactions.has(commandId)) {
      return;
    }
    this.recordObservation({ source: "command", commandId, kind: "observed" });
  }

  commitCommand(commandId: string): void {
    if (!this.transactions.delete(commandId)) {
      return;
    }
    this.recordObservation({ source: "command", commandId, kind: "committed" });
  }

  rejectCommand(commandId: string): void {
    if (!this.transactions.delete(commandId)) {
      return;
    }
    this.recordObservation({ source: "command", commandId, kind: "rejected" });
  }

  recordNativeTabCreated(tab: RuntimeTab): RuntimeTabEvidence {
    if (
      !this.commandCreatedWindowIds.has(tab.windowId) &&
      !this.reconstructedLiveWindowIds.has(tab.windowId) &&
      !this.isWindowIgnoredForRefresh(tab.windowId)
    ) {
      this.browserCreatedWindowIds.add(tab.windowId);
    }
    this.observeLiveTabIfAccepted(tab);
    const sequence = this.recordObservation({ source: "tabEvent", kind: "created", tabId: tab.id, windowId: tab.windowId, tab });
    return this.runtimeTabEvidence("created", tab, allRuntimeTabEvidenceFields(), sequence);
  }

  recordBrowserCreatedRuntimeWindow(windowId: number): void {
    if (this.isWindowIgnoredForRefresh(windowId)) {
      return;
    }
    this.browserCreatedWindowIds.add(windowId);
    this.commandCreatedWindowIds.delete(windowId);
    this.observeLiveWindowIfAccepted(windowId);
  }

  recordCommandCreatedRuntimeWindow(windowId: number): void {
    this.commandCreatedWindowIds.add(windowId);
    this.browserCreatedWindowIds.delete(windowId);
    this.removedWindowIds.delete(windowId);
    this.reconstructedLiveWindowIds.add(windowId);
    this.reconstructedMaxWindowId = Math.max(this.reconstructedMaxWindowId, windowId);
  }

  isBrowserCreatedRuntimeWindow(windowId: number): boolean {
    if (this.commandCreatedWindowIds.has(windowId)) {
      return false;
    }
    return this.browserCreatedWindowIds.has(windowId) ||
      this.windowScopes.scopeForWindow(windowId)?.provenance === "browserCreated";
  }

  runtimeWindowProvenanceMarker(windowId: number): RuntimeWindowProvenance | undefined {
    if (this.commandCreatedWindowIds.has(windowId)) {
      return "commandCreated";
    }
    if (this.browserCreatedWindowIds.has(windowId)) {
      return "browserCreated";
    }
    return undefined;
  }

  runtimeProvenanceForRecoveredWindow(windowId: number): RuntimeWindowProvenance | undefined {
    const scope = this.windowScopes.scopeForWindow(windowId);
    if (this.commandCreatedWindowIds.has(windowId) || scope?.provenance === "commandCreated" || scope?.provenance === "restored") {
      return "commandCreated";
    }
    if (this.isBrowserCreatedRuntimeWindow(windowId)) {
      return "browserCreated";
    }
    return this.reconstructedLiveWindowIds.has(windowId) ? undefined : "browserCreated";
  }

  isRestoredRuntimeScopeForTab(tabId: number): boolean {
    return this.windowScopes.scopeForTab(tabId)?.provenance === "restored";
  }

  isRestoredRuntimeScopeForWindow(windowId: number): boolean {
    return this.windowScopes.scopeForWindow(windowId)?.provenance === "restored";
  }

  recordNativeTabUpdated(tab: RuntimeTab, changeInfo: Partial<RuntimeTab>): NativeTabUpdatedRecord {
    this.observeLiveTabIfAccepted(tab);
    this.markStructurallyFreshIfShapeChanged(tab);
    const sequence = this.recordObservation({ source: "tabEvent", kind: "updated", tabId: tab.id, windowId: tab.windowId, tab });
    return {
      decision: this.isCommandFocusActiveUpdateEcho(changeInfo, tab) ? "command-focus-active" : "refresh",
      evidence: this.runtimeTabEvidence("updated", tab, runtimeTabEvidenceFieldsFromUpdate(changeInfo), sequence)
    };
  }

  acceptedTabShapeFact(tabId: number): RuntimeTabShapeFact | undefined {
    return this.tabShapeFacts.get(tabId);
  }

  acceptedWindowShapeFact(windowId: number): RuntimeWindowShapeFact | undefined {
    return this.windowShapeFacts.get(windowId);
  }

  currentScopeGeneration(): number {
    return this.scopeGeneration;
  }

  recordInstalledActiveTab(tabId: number, windowId: number, previousTabId?: number): void {
    const scope = this.windowScopes.scopeForWindow(windowId);
    if (scope) {
      scope.activeTabId = tabId;
    }
    const windowFact = this.windowShapeFacts.get(windowId);
    if (windowFact) {
      this.windowShapeFacts.set(windowId, {
        ...windowFact,
        activeTabId: tabId
      });
    }
    const tabFact = this.tabShapeFacts.get(tabId);
    if (tabFact) {
      this.tabShapeFacts.set(tabId, {
        ...tabFact,
        active: true
      });
    }
    if (typeof previousTabId === "number") {
      const previousFact = this.tabShapeFacts.get(previousTabId);
      if (previousFact) {
        this.tabShapeFacts.set(previousTabId, {
          ...previousFact,
          active: false
        });
      }
    }
  }

  recordAcceptedRuntimeTabScopeUpdates(updates: readonly RuntimeAcceptedTabScopeUpdate[]): void {
    for (const update of updates) {
      const tab = update.tab;
      if (tab.incognito) {
        continue;
      }

      this.reconstructedLiveWindowIds.add(tab.windowId);
      this.reconstructedLiveTabIds.add(tab.id);
      const previousTabFact = this.tabShapeFacts.get(tab.id);
      if (previousTabFact && previousTabFact.windowId !== tab.windowId) {
        this.removeTabFromWindowShapeFact(previousTabFact.windowId, tab.id);
      }

      const previousWindowFact = this.windowShapeFacts.get(tab.windowId);
      const previousScope = this.windowScopes.scopeForWindow(tab.windowId);
      const previousOrder = (previousScope?.tabOrder ?? previousWindowFact?.tabOrder ?? [])
        .filter((tabId) => tabId === tab.id || !this.isTabIgnoredForRefresh(tabId));
      const activeTabId = tab.active
        ? tab.id
        : previousWindowFact?.activeTabId === tab.id
          ? undefined
          : previousWindowFact?.activeTabId;

      if (tab.active && typeof previousWindowFact?.activeTabId === "number" && previousWindowFact.activeTabId !== tab.id) {
        const previousActiveFact = this.tabShapeFacts.get(previousWindowFact.activeTabId);
        if (previousActiveFact?.windowId === tab.windowId) {
          this.tabShapeFacts.set(previousWindowFact.activeTabId, {
            ...previousActiveFact,
            active: false,
            source: "tabEvent",
            confidence: "eventLocal",
            scopeGeneration: this.scopeGeneration,
            sequence: update.sequence
          });
        }
      }

      this.tabShapeFacts.set(tab.id, {
        tabId: tab.id,
        windowId: tab.windowId,
        index: tab.index,
        active: tab.active,
        ...(tab.title !== undefined ? { title: tab.title } : {}),
        ...(tab.url !== undefined ? { url: tab.url } : {}),
        ...(tab.favIconUrl !== undefined ? { favIconUrl: tab.favIconUrl } : {}),
        source: "tabEvent",
        confidence: "eventLocal",
        scopeGeneration: this.scopeGeneration,
        sequence: update.sequence
      });

      this.windowShapeFacts.set(tab.windowId, {
        windowId: tab.windowId,
        tabOrder: update.preserveOrder
          ? runtimeOrderPreservingExistingTab(previousOrder, tab.id)
          : runtimeOrderWithTabAtIndex(previousOrder, tab.id, tab.index),
        ...(typeof activeTabId === "number" ? { activeTabId } : {}),
        ...(previousWindowFact?.focused !== undefined ? { focused: previousWindowFact.focused } : {}),
        ...(update.windowState ? { state: update.windowState } : previousWindowFact?.state ? { state: previousWindowFact.state } : {}),
        source: "tabEvent",
        confidence: "eventLocal",
        scopeGeneration: this.scopeGeneration,
        sequence: update.sequence
      });

      this.windowScopes.upsertLiveWindow({
        runtimeWindowId: tab.windowId,
        ...(update.windowNodeId ? { outlineWindowNodeId: update.windowNodeId } : {}),
        ...(update.windowState ? { state: update.windowState } : previousWindowFact?.state ? { state: previousWindowFact.state } : {}),
        provenance: this.acceptedWindowScopeProvenance(tab.windowId, update.windowNodeId)
      });
      this.windowScopes.upsertLiveTab({
        runtimeWindowId: tab.windowId,
        tabId: tab.id,
        tabNodeId: update.tabNodeId,
        ...(update.preserveOrder ? {} : { index: tab.index }),
        active: tab.active
      });
    }
    this.syncWindowScopeActiveTabsFromShapeFacts();
  }

  private removeTabFromWindowShapeFact(windowId: number, tabId: number): void {
    const fact = this.windowShapeFacts.get(windowId);
    if (!fact) {
      return;
    }
    if (fact.activeTabId === tabId) {
      const nextFact: RuntimeWindowShapeFact = {
        ...fact,
        tabOrder: fact.tabOrder.filter((candidate) => candidate !== tabId)
      };
      delete nextFact.activeTabId;
      this.windowShapeFacts.set(windowId, nextFact);
      return;
    }
    this.windowShapeFacts.set(windowId, {
      ...fact,
      tabOrder: fact.tabOrder.filter((candidate) => candidate !== tabId)
    });
  }

  private acceptedWindowScopeProvenance(
    runtimeWindowId: number,
    outlineWindowNodeId: NodeId | undefined
  ): RuntimeWindowScope["provenance"] {
    const existing = this.windowScopes.scopeForWindow(runtimeWindowId);
    if (existing) {
      return existing.provenance;
    }
    return this.resolveRuntimeWindowScopeProvenance({
      runtimeWindowId,
      hasRuntimeWindow: true,
      runtimeOnly: false,
      ...(outlineWindowNodeId ? {
        outlineWindowNode: {
          id: outlineWindowNodeId,
          kind: "window",
          status: "live",
          childIds: [],
          title: "Group",
          collapsed: false,
          createdAt: 0,
          updatedAt: 0,
          live: { windowId: runtimeWindowId }
        }
      } : {})
    });
  }

  debugSnapshot(): RuntimeFactLedgerDebugSnapshot {
    return {
      scopeGeneration: this.scopeGeneration,
      windowScopes: this.windowScopeSnapshots()
        .map((scope) => ({
          ...scope,
          tabNodeIdsByRuntimeId: [...scope.tabNodeIdsByRuntimeId].sort((left, right) => left[0] - right[0]),
          tabOrder: [...scope.tabOrder]
        }))
        .sort((left, right) => left.runtimeWindowId - right.runtimeWindowId),
      ignoredTabIds: [...this.ignoredTabIdsForRefresh()].sort((left, right) => left - right),
      ignoredWindowIds: [...this.ignoredWindowIdsForRefresh()].sort((left, right) => left - right),
      browserCreatedWindowIds: [...this.browserCreatedWindowIds].sort((left, right) => left - right),
      commandCreatedWindowIds: [...this.commandCreatedWindowIds].sort((left, right) => left - right),
      commandRestoredTabIds: [...this.commandRestoredTabIds].sort((left, right) => left - right),
      commandRelocatedTabEchoes: [...this.commandRelocatedTabEchoes.entries()]
        .map(([tabId, echo]) => ({
          tabId,
          fromWindowIds: [...echo.fromWindowIds].sort((left, right) => left - right),
          sequence: echo.sequence,
          sourceWindowId: echo.sourceWindowId,
          toWindowId: echo.toWindowId
        }))
        .sort((left, right) => left.tabId - right.tabId),
      acceptedTabShapeFacts: [...this.tabShapeFacts.values()]
        .map((fact) => ({ ...fact }))
        .sort((left, right) => left.tabId - right.tabId),
      acceptedWindowShapeFacts: [...this.windowShapeFacts.values()]
        .map((fact) => ({
          ...fact,
          tabOrder: [...fact.tabOrder]
        }))
        .sort((left, right) => left.windowId - right.windowId)
    };
  }

  tabNeedsShapeCorroboration(tabId: number): boolean {
    return this.structurallyFreshTabIds.has(tabId);
  }

  recordNativeTabActivated(tabId: number, windowId: number | undefined): NativeFocusEventDecision {
    this.observeLiveTabIdIfAccepted(tabId, windowId);
    this.structurallyFreshTabIds.add(tabId);
    this.recordObservation({
      source: "tabEvent",
      kind: "activated",
      tabId,
      ...(typeof windowId === "number" ? { windowId } : {})
    });
    return this.hasCommandFocusedTab(tabId) ? "command-focus" : "runtime-refresh";
  }

  recordNativeTabDetached(tabId: number, oldWindowId: number | undefined): void {
    this.structurallyFreshTabIds.add(tabId);
    this.recordObservation({
      source: "tabEvent",
      kind: "detached",
      tabId,
      ...(typeof oldWindowId === "number" ? { windowId: oldWindowId } : {})
    });
  }

  recordNativeTabAttached(tabId: number, newWindowId: number | undefined): void {
    if (
      typeof newWindowId === "number" &&
      !this.commandCreatedWindowIds.has(newWindowId) &&
      !this.reconstructedLiveWindowIds.has(newWindowId) &&
      !this.isWindowIgnoredForRefresh(newWindowId)
    ) {
      this.browserCreatedWindowIds.add(newWindowId);
      this.observeLiveWindowIfAccepted(newWindowId);
    }
    if (typeof newWindowId === "number" && this.browserCreatedWindowIds.has(newWindowId)) {
      this.commandCreatedWindowIds.delete(newWindowId);
    }
    this.observeLiveTabIdIfAccepted(tabId, newWindowId);
    this.structurallyFreshTabIds.add(tabId);
    this.clearCommandRelocationEchoIfBrowserMoved(tabId, newWindowId);
    this.recordObservation({
      source: "tabEvent",
      kind: "attached",
      tabId,
      ...(typeof newWindowId === "number" ? { windowId: newWindowId } : {})
    });
  }

  recordNativeTabMoved(tabId: number, windowId: number | undefined): void {
    this.observeLiveTabIdIfAccepted(tabId, windowId);
    this.structurallyFreshTabIds.add(tabId);
    this.clearCommandRelocationEchoIfBrowserMoved(tabId, windowId);
    this.recordObservation({
      source: "tabEvent",
      kind: "moved",
      tabId,
      ...(typeof windowId === "number" ? { windowId } : {})
    });
  }

  private markStructurallyFreshIfShapeChanged(tab: RuntimeTab): void {
    const previousFact = this.tabShapeFacts.get(tab.id);
    if (
      previousFact &&
      (
        previousFact.windowId !== tab.windowId ||
        (previousFact.index !== undefined && previousFact.index !== tab.index) ||
        (previousFact.active !== undefined && previousFact.active !== tab.active)
      )
    ) {
      this.structurallyFreshTabIds.add(tab.id);
    }
  }

  recordNativeTabRemoved(tabId: number, windowId: number | undefined): NativeTabRemovedDecision {
    this.recordObservation({
      source: "tabEvent",
      kind: "removed",
      tabId,
      ...(typeof windowId === "number" ? { windowId } : {})
    });
    this.markTabRemoved(tabId);
    return this.consumeDeleteOwnedClosingTab(tabId) ? "ignore-delete-owned" : "continue";
  }

  recordNativeWindowFocused(windowId: number): NativeFocusEventDecision {
    this.observeLiveWindowIfAccepted(windowId);
    this.recordObservation({ source: "windowEvent", kind: "focused", windowId });
    return this.hasCommandFocusedWindow(windowId) ? "command-focus" : "runtime-refresh";
  }

  recordNativeWindowBoundsChanged(windowInfo: RuntimeWindow): void {
    if (
      !this.commandCreatedWindowIds.has(windowInfo.id) &&
      !this.reconstructedLiveWindowIds.has(windowInfo.id) &&
      !this.isWindowIgnoredForRefresh(windowInfo.id)
    ) {
      this.browserCreatedWindowIds.add(windowInfo.id);
    }
    this.observeLiveWindowIfAccepted(windowInfo.id);
    const sequence = this.recordObservation({
      source: "windowEvent",
      kind: "boundsChanged",
      windowId: windowInfo.id,
      window: windowInfo
    });
    const tabs = windowInfo.tabs
      ? [...windowInfo.tabs]
          .filter((tab) => !tab.incognito)
          .sort((left, right) => left.index - right.index)
      : undefined;
    const activeTabId = tabs?.find((tab) => tab.active)?.id;
    this.recordWindowShapeFact({
      windowInfo,
      ...(tabs ? { tabOrder: tabs.map((tab) => tab.id), activeTabIdKnown: true } : {}),
      ...(typeof activeTabId === "number" ? { activeTabId } : {}),
      source: "windowEvent",
      confidence: "eventLocal",
      sequence
    });
    const scope = this.windowScopes.scopeForWindow(windowInfo.id);
    if (scope) {
      if (windowInfo.state) {
        scope.state = windowInfo.state;
      } else {
        delete scope.state;
      }
    }
  }

  recordNativeWindowRemoved(windowId: number): NativeWindowRemovedDecision {
    this.recordObservation({ source: "windowEvent", kind: "removed", windowId });
    if (this.hasRemovedWindow(windowId)) {
      return "ignore-duplicate";
    }

    this.markWindowRemoved(windowId);
    return this.consumeDeleteOwnedClosingWindow(windowId) ? "ignore-delete-owned" : "close-window";
  }

  recordClosedRuntimeWindow(windowId: number, liveTabIds: readonly number[]): void {
    this.markWindowRemoved(windowId);
    this.clearWindowCloseTracking(windowId);
    for (const tabId of liveTabIds) {
      this.markTabRemoved(tabId);
      this.clearTabCloseTracking(tabId);
    }
  }

  recordMissingLiveTab(tabId: number): void {
    this.markTabRemoved(tabId);
  }

  recordNativeSessionChanged(): void {
    this.recordObservation({ source: "sessionEvent", kind: "changed" });
  }

  markOutlinerClosePlan(plan: RuntimeClosePlan): void {
    for (const tabId of plan.tabIds) {
      this.outlinerClosingTabIds.add(tabId);
    }
    for (const windowId of plan.windowIds) {
      this.outlinerClosingWindowIds.add(windowId);
    }
  }

  clearOutlinerClosePlan(plan: RuntimeClosePlan): void {
    for (const tabId of plan.tabIds) {
      this.outlinerClosingTabIds.delete(tabId);
    }
    for (const windowId of plan.windowIds) {
      this.outlinerClosingWindowIds.delete(windowId);
    }
  }

  markDeleteClosePlan(plan: RuntimeClosePlan): void {
    for (const tabId of plan.tabIds) {
      this.deleteOwnedClosingTabIds.add(tabId);
    }
    for (const windowId of plan.windowIds) {
      this.deleteOwnedClosingWindowIds.add(windowId);
    }
  }

  clearDeleteClosePlan(plan: RuntimeClosePlan): void {
    for (const tabId of plan.tabIds) {
      this.deleteOwnedClosingTabIds.delete(tabId);
    }
    for (const windowId of plan.windowIds) {
      this.deleteOwnedClosingWindowIds.delete(windowId);
    }
  }

  recordCompletedClosePlanTombstones(plan: RuntimeClosePlan): void {
    for (const tabId of plan.tabIds) {
      this.markTabRemoved(tabId);
      this.deleteOwnedClosingTabIds.delete(tabId);
    }
    for (const windowId of plan.windowIds) {
      this.markWindowRemoved(windowId);
      this.deleteOwnedClosingWindowIds.delete(windowId);
    }
  }

  recordCompletedOutlinerClosePlan(plan: RuntimeClosePlan): void {
    for (const tabId of plan.tabIds) {
      this.markTabRemoved(tabId);
      this.outlinerClosedTabIds.add(tabId);
      this.outlinerClosingTabIds.delete(tabId);
    }
    for (const windowId of plan.windowIds) {
      this.markWindowRemoved(windowId);
      this.outlinerClosedWindowIds.add(windowId);
      this.outlinerClosingWindowIds.delete(windowId);
    }
  }

  private markTabRemoved(tabId: number): void {
    this.removedTabIds.add(tabId);
    this.commandRestoredTabIds.delete(tabId);
    this.commandRelocatedTabEchoes.delete(tabId);
    this.structurallyFreshTabIds.delete(tabId);
    this.tabShapeFacts.delete(tabId);
    for (const fact of [...this.windowShapeFacts.values()]) {
      this.removeTabFromWindowShapeFact(fact.windowId, tabId);
    }
    this.windowScopes.markTabRemoved(tabId);
  }

  private markWindowRemoved(windowId: number): void {
    this.removedWindowIds.add(windowId);
  }

  private observeLiveTab(tab: RuntimeTab): void {
    this.observeLiveTabId(tab.id, tab.windowId);
  }

  private observeLiveTabIfAccepted(tab: RuntimeTab): void {
    this.observeLiveTabIdIfAccepted(tab.id, tab.windowId);
  }

  private observeLiveTabIdIfAccepted(tabId: number, windowId: number | undefined): void {
    if (this.isTabIgnoredForRefresh(tabId)) {
      return;
    }
    this.observeLiveTabId(tabId, windowId);
  }

  private observeLiveTabId(tabId: number, windowId: number | undefined): void {
    this.reconstructedLiveTabIds.add(tabId);
    this.reconstructedMaxTabId = Math.max(this.reconstructedMaxTabId, tabId);
    if (typeof windowId === "number") {
      this.observeLiveWindow(windowId);
    }
  }

  private observeLiveWindow(windowId: number): void {
    this.reconstructedLiveWindowIds.add(windowId);
    this.reconstructedMaxWindowId = Math.max(this.reconstructedMaxWindowId, windowId);
  }

  private observeLiveWindowIfAccepted(windowId: number): void {
    if (this.isWindowIgnoredForRefresh(windowId)) {
      return;
    }
    this.observeLiveWindow(windowId);
  }

  private hasRemovedWindow(windowId: number): boolean {
    return this.removedWindowIds.has(windowId);
  }

  clearRemovalTombstonesForLiveState(next: OutlineState, candidateNodeIds?: readonly NodeId[]): void {
    const nodes = candidateNodeIds ? selectedNodes(next, candidateNodeIds) : Object.values(next.nodes);
    for (const node of nodes) {
      if (isLiveTabNode(node)) {
        this.removedTabIds.delete(node.live.tabId);
        this.deleteOwnedClosingTabIds.delete(node.live.tabId);
        this.outlinerClosingTabIds.delete(node.live.tabId);
        this.reconstructedLiveTabIds.add(node.live.tabId);
        this.reconstructedMaxTabId = Math.max(this.reconstructedMaxTabId, node.live.tabId);
      }
      if (isLiveWindowNode(node)) {
        if (node.runtimeProvenance === "commandCreated") {
          this.commandCreatedWindowIds.add(node.live.windowId);
          this.browserCreatedWindowIds.delete(node.live.windowId);
        } else if (node.runtimeProvenance === "browserCreated") {
          this.browserCreatedWindowIds.add(node.live.windowId);
          this.commandCreatedWindowIds.delete(node.live.windowId);
        }
        this.removedWindowIds.delete(node.live.windowId);
        this.deleteOwnedClosingWindowIds.delete(node.live.windowId);
        this.outlinerClosingWindowIds.delete(node.live.windowId);
        this.outlinerClosedWindowIds.delete(node.live.windowId);
        this.reconstructedLiveWindowIds.add(node.live.windowId);
        this.reconstructedMaxWindowId = Math.max(this.reconstructedMaxWindowId, node.live.windowId);
      }
    }
  }

  ignoredTabIdsForRefresh(): Set<number> {
    return new Set([...this.removedTabIds, ...this.deleteOwnedClosingTabIds]);
  }

  ignoredWindowIdsForRefresh(): Set<number> {
    return new Set([...this.removedWindowIds, ...this.deleteOwnedClosingWindowIds]);
  }

  isTabIgnoredForRefresh(tabId: number): boolean {
    return this.removedTabIds.has(tabId) ||
      this.deleteOwnedClosingTabIds.has(tabId) ||
      (
        this.reconstructedMaxTabId > 0 &&
        tabId <= this.reconstructedMaxTabId &&
        !this.reconstructedLiveTabIds.has(tabId)
      );
  }

  isWindowIgnoredForRefresh(windowId: number): boolean {
    return this.removedWindowIds.has(windowId) ||
      this.deleteOwnedClosingWindowIds.has(windowId) ||
      (
        this.reconstructedMaxWindowId > 0 &&
        windowId <= this.reconstructedMaxWindowId &&
        !this.reconstructedLiveWindowIds.has(windowId)
      );
  }

  private consumeDeleteOwnedClosingTab(tabId: number): boolean {
    return this.deleteOwnedClosingTabIds.delete(tabId);
  }

  private consumeDeleteOwnedClosingWindow(windowId: number): boolean {
    return this.deleteOwnedClosingWindowIds.delete(windowId);
  }

  private hasDeleteOwnedClosingWindow(windowId: number): boolean {
    return this.deleteOwnedClosingWindowIds.has(windowId);
  }

  isCommandOwnedWindowClose(windowId: number): boolean {
    return this.hasDeleteOwnedClosingWindow(windowId) || this.hasOutlinerClosingWindow(windowId);
  }

  isOutlinerClosingWindow(windowId: number): boolean {
    return this.hasOutlinerClosingWindow(windowId);
  }

  isOutlinerClosedWindow(windowId: number): boolean {
    return this.outlinerClosedWindowIds.has(windowId);
  }

  consumeOutlinerClosingTab(tabId: number): boolean {
    return this.outlinerClosingTabIds.delete(tabId);
  }

  private hasOutlinerClosingWindow(windowId: number): boolean {
    return this.outlinerClosingWindowIds.has(windowId);
  }

  private hasOutlinerClosingTabs(): boolean {
    return this.outlinerClosingTabIds.size > 0;
  }

  recordOutlinerClosedTabRemovalApplied(tabId?: number): void {
    if (typeof tabId === "number") {
      this.outlinerClosedTabIds.add(tabId);
    }
    if (this.commandCloseSessionEchoesSkippedBeforeRemoval > 0) {
      this.commandCloseSessionEchoesSkippedBeforeRemoval -= 1;
      return;
    }

    this.commandCloseSessionEchoesToSkip += 1;
  }

  consumeOutlinerCloseSessionEcho(): boolean {
    if (this.commandCloseSessionEchoesToSkip > 0) {
      this.commandCloseSessionEchoesToSkip -= 1;
      return true;
    }

    if (this.hasOutlinerClosingTabs()) {
      this.commandCloseSessionEchoesSkippedBeforeRemoval += 1;
      return true;
    }

    return false;
  }

  private clearWindowCloseTracking(windowId: number): void {
    this.outlinerClosingWindowIds.delete(windowId);
  }

  private clearTabCloseTracking(tabId: number): void {
    this.outlinerClosingTabIds.delete(tabId);
    this.commandRelocatedTabEchoes.delete(tabId);
  }

  classifyWindowClosingTabRemoval(input: {
    windowId: number;
    liveTabIds: readonly number[];
    runtimeWindowOpen: boolean;
  }): WindowClosingTabRemovalDecision {
    if (this.deleteOwnedClosingWindowIds.has(input.windowId) || this.outlinerClosingWindowIds.has(input.windowId)) {
      return "ignore-command-owned";
    }
    if (input.runtimeWindowOpen) {
      return "wait-for-runtime-window";
    }
    if (
      input.liveTabIds.length === 0 ||
      input.liveTabIds.some((liveTabId) => !this.removedTabIds.has(liveTabId))
    ) {
      return "wait-for-remaining-tabs";
    }
    return "close-window";
  }

  recordCommandRestoredTab(tabId: number): void {
    this.commandRestoredTabIds.add(tabId);
    this.removedTabIds.delete(tabId);
    this.outlinerClosedTabIds.delete(tabId);
    this.reconstructedLiveTabIds.add(tabId);
    this.reconstructedMaxTabId = Math.max(this.reconstructedMaxTabId, tabId);
  }

  recordCommandRestoredTabs(
    previous: OutlineState,
    next: OutlineState,
    candidateNodeIds?: readonly NodeId[]
  ): void {
    for (const node of selectedNodes(next, candidateNodeIds)) {
      if (isLiveWindowNode(node) && node.restoredFromClosed && previous.nodes[node.id]?.status === "closed") {
        this.removedWindowIds.delete(node.live.windowId);
        this.commandCreatedWindowIds.add(node.live.windowId);
        this.browserCreatedWindowIds.delete(node.live.windowId);
        this.reconstructedLiveWindowIds.add(node.live.windowId);
        this.reconstructedMaxWindowId = Math.max(this.reconstructedMaxWindowId, node.live.windowId);
      }
      if (!isLiveTabNode(node) || !node.restoredFromClosed || previous.nodes[node.id]?.status !== "closed") {
        continue;
      }
      this.recordCommandRestoredTab(node.live.tabId);
    }
  }

  hasCommandRestoredTab(tabId: number): boolean {
    return this.commandRestoredTabIds.has(tabId);
  }

  deleteCommandRestoredTab(tabId: number): void {
    this.commandRestoredTabIds.delete(tabId);
  }

  recordCommandRelocatedTabs(
    previous: OutlineState,
    next: OutlineState,
    candidateNodeIds?: readonly NodeId[]
  ): void {
    const previousNodes = candidateNodeIds
      ? candidateNodeIds.flatMap((nodeId) => {
          const node = previous.nodes[nodeId];
          return node ? [node] : [];
        })
      : Object.values(previous.nodes);

    for (const previousNode of previousNodes) {
      if (!isLiveTabNode(previousNode)) {
        continue;
      }

      const nextNode = next.nodes[previousNode.id];
      if (
        !isLiveTabNode(nextNode) ||
        nextNode.live.tabId !== previousNode.live.tabId ||
        nextNode.live.windowId === previousNode.live.windowId
      ) {
        continue;
      }

      const existingEcho = this.commandRelocatedTabEchoes.get(previousNode.live.tabId);
      const fromWindowIds = new Set(existingEcho?.fromWindowIds ?? []);
      fromWindowIds.add(previousNode.live.windowId);
      if (!hasLiveWindowRuntimeId(previous, nextNode.live.windowId)) {
        this.commandCreatedWindowIds.add(nextNode.live.windowId);
        this.browserCreatedWindowIds.delete(nextNode.live.windowId);
      }
      const sourceIndex = this.commandRelocationSourceIndex(previous, previousNode);
      this.commandRelocatedTabEchoes.set(previousNode.live.tabId, {
        fromWindowIds,
        sequence: this.observationSequence,
        sourceIndex,
        sourceWindowId: previousNode.live.windowId,
        toWindowId: nextNode.live.windowId
      });
    }
  }

  private commandRelocationSourceIndex(previous: OutlineState, previousNode: LiveTabNode): number | undefined {
    const scopedIndex = this.windowScopes.scopeForWindow(previousNode.live.windowId)?.tabOrder
      .indexOf(previousNode.live.tabId);
    if (scopedIndex !== undefined && scopedIndex >= 0) {
      return scopedIndex;
    }

    const outlineIndex = previousOutlineRuntimeTabIndex(previous, previousNode);
    if (outlineIndex !== undefined) {
      return outlineIndex;
    }

    const fact = this.tabShapeFacts.get(previousNode.live.tabId);
    return fact?.windowId === previousNode.live.windowId ? fact.index : undefined;
  }

  recordCommandRelocatedTab(tabId: number, fromWindowId: number, toWindowId: number): void {
    const existingEcho = this.commandRelocatedTabEchoes.get(tabId);
    const fromWindowIds = new Set(existingEcho?.fromWindowIds ?? []);
    fromWindowIds.add(fromWindowId);
    this.commandCreatedWindowIds.add(toWindowId);
    this.browserCreatedWindowIds.delete(toWindowId);
    this.commandRelocatedTabEchoes.set(tabId, {
      fromWindowIds,
      sequence: this.observationSequence,
      sourceIndex: this.tabShapeFacts.get(tabId)?.windowId === fromWindowId
        ? this.tabShapeFacts.get(tabId)?.index
        : undefined,
      sourceWindowId: fromWindowId,
      toWindowId
    });
  }

  commandRelocatedTabEchoCount(): number {
    return this.commandRelocatedTabEchoes.size;
  }

  commandRelocatedTabEcho(tabId: number): CommandRelocatedTabEcho | undefined {
    return this.commandRelocatedTabEchoes.get(tabId);
  }

  commandRelocatedTabEchoEntries(): Array<[number, CommandRelocatedTabEcho]> {
    return [...this.commandRelocatedTabEchoes.entries()];
  }

  deleteCommandRelocatedTabEcho(tabId: number): void {
    this.commandRelocatedTabEchoes.delete(tabId);
  }

  private clearCommandRelocationEchoIfBrowserMoved(tabId: number, windowId: number | undefined): void {
    if (typeof windowId !== "number") {
      return;
    }
    const echo = this.commandRelocatedTabEchoes.get(tabId);
    if (echo && windowId !== echo.toWindowId) {
      this.commandRelocatedTabEchoes.delete(tabId);
    }
  }

  markCommandFocusTarget(tabId: number, windowId: number, tabActive: boolean): void {
    if (!tabActive) {
      this.commandFocusedTabIds.add(tabId);
      this.commandFocusedActivationWindowIds.add(windowId);
    }
    this.commandFocusedWindowIds.add(windowId);
  }

  clearCommandFocusTarget(tabId: number, windowId: number): void {
    this.commandFocusedTabIds.delete(tabId);
    this.commandFocusedActivationWindowIds.delete(windowId);
    this.commandFocusedWindowIds.delete(windowId);
  }

  private hasCommandFocusedTab(tabId: number): boolean {
    return this.commandFocusedTabIds.has(tabId);
  }

  consumeCommandFocusedTab(tabId: number): void {
    this.commandFocusedTabIds.delete(tabId);
  }

  consumeCommandFocusedActivationWindow(windowId: number): void {
    this.commandFocusedActivationWindowIds.delete(windowId);
  }

  private hasCommandFocusedWindow(windowId: number): boolean {
    return this.commandFocusedWindowIds.has(windowId);
  }

  consumeCommandFocusedWindow(windowId: number): void {
    this.commandFocusedWindowIds.delete(windowId);
  }

  private isCommandFocusActiveUpdateEcho(changeInfo: Partial<RuntimeTab>, tab: RuntimeTab): boolean {
    return tab.active === true &&
      this.commandFocusedActivationWindowIds.has(tab.windowId) &&
      Object.keys(changeInfo).every((key) => key === "active");
  }
}

function isLiveTabNode(node: OutlineNode | undefined): node is LiveTabNode {
  return Boolean(node?.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live);
}

function isLiveWindowNode(node: OutlineNode | undefined): node is OutlineNode & { live: { windowId: number } } {
  return Boolean(node?.kind === "window" && node.status === "live" && node.live && "windowId" in node.live);
}

function liveTabNodes(state: OutlineState): LiveTabNode[] {
  return Object.values(state.nodes).filter(isLiveTabNode);
}

function liveWindowNodes(state: OutlineState): Array<OutlineNode & { live: { windowId: number } }> {
  return Object.values(state.nodes).filter(isLiveWindowNode);
}

function currentOrOutlineOrderedLiveTabsForRuntimeWindow(
  state: OutlineState,
  windowNode: OutlineNode & { live: { windowId: number } },
  liveTabs: readonly LiveTabNode[],
  currentTabOrder: readonly number[] | undefined
): LiveTabNode[] {
  const windowId = windowNode.live.windowId;
  const remaining = new Map(
    liveTabs
      .filter((tabNode) => tabNode.live.windowId === windowId)
      .map((tabNode) => [tabNode.live.tabId, tabNode])
  );
  if (currentTabOrder && currentTabOrder.length === remaining.size) {
    const orderedFromCurrentScope: LiveTabNode[] = [];
    const seen = new Set<number>();
    for (const tabId of currentTabOrder) {
      const tabNode = remaining.get(tabId);
      if (!tabNode || seen.has(tabId)) {
        orderedFromCurrentScope.length = 0;
        break;
      }
      orderedFromCurrentScope.push(tabNode);
      seen.add(tabId);
    }
    if (orderedFromCurrentScope.length === remaining.size) {
      return orderedFromCurrentScope;
    }
  }

  const ordered: LiveTabNode[] = [];
  const visited = new Set<NodeId>();

  const visit = (nodeId: NodeId): void => {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);
    const node = state.nodes[nodeId];
    if (!node) {
      return;
    }
    if (node.id !== windowNode.id && isLiveWindowNode(node) && node.live.windowId !== windowId) {
      return;
    }
    if (isLiveTabNode(node) && node.live.windowId === windowId && remaining.has(node.live.tabId)) {
      ordered.push(node);
      remaining.delete(node.live.tabId);
    }
    for (const childId of node.childIds) {
      visit(childId);
    }
  };

  visit(windowNode.id);
  ordered.push(...remaining.values());
  return ordered;
}

function hasLiveWindowRuntimeId(state: OutlineState, windowId: number): boolean {
  return liveWindowNodes(state).some((node) => node.live.windowId === windowId);
}

function maxNumericId(ids: ReadonlySet<number>): number {
  let maxId = 0;
  for (const id of ids) {
    if (id > maxId) {
      maxId = id;
    }
  }
  return maxId;
}

function runtimeOrderWithTabAtIndex(tabOrder: readonly number[], tabId: number, index: number | undefined): number[] {
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

function runtimeOrderPreservingExistingTab(tabOrder: readonly number[], tabId: number): number[] {
  return tabOrder.includes(tabId) ? [...tabOrder] : [...tabOrder, tabId];
}

function runtimeOrderPreservingKnownTabs(
  knownOrder: readonly number[],
  currentOrder: readonly number[]
): number[] {
  const currentTabIds = new Set(currentOrder);
  const preservedKnownOrder = knownOrder.filter((tabId) => currentTabIds.has(tabId));
  const preservedTabIds = new Set(preservedKnownOrder);
  return [
    ...preservedKnownOrder,
    ...currentOrder.filter((tabId) => !preservedTabIds.has(tabId))
  ];
}

function runtimeWindowShapeFactCanOrderInstalledState(
  fact: RuntimeWindowShapeFact,
  options: { preserveInstalledOrder?: boolean } = {}
): boolean {
  if (fact.source === "snapshot") {
    return false;
  }
  return fact.source !== "installedState" || options.preserveInstalledOrder === true;
}

function canonicalRuntimeIdFromNodeId(nodeId: NodeId, kind: "tab" | "window"): number | undefined {
  const match = new RegExp(`^${kind}:(\\d+)(?::|$)`).exec(nodeId);
  if (!match?.[1]) {
    return undefined;
  }
  return Number(match[1]);
}

export function runtimeCommandRelocatesLiveTabs(type: BackgroundCommand["type"]): boolean {
  return type === "moveNode" ||
    type === "moveNodeToNewWindow" ||
    type === "wrapNodeInGroup" ||
    type === "moveSubtreeToTopLevel";
}

function commandOwnershipForType(type: BackgroundCommand["type"]): CommandOwnership | undefined {
  if (type === "closeNode") {
    return "outliner-close";
  }
  if (type === "deleteNode") {
    return "delete";
  }
  if (runtimeCommandRelocatesLiveTabs(type)) {
    return "relocation";
  }
  if (type === "restoreNode" || type === "undo" || type === "redo") {
    return "restore";
  }
  if (type === "focusNode") {
    return "focus";
  }
  return undefined;
}

function selectedNodes(state: OutlineState, candidateNodeIds?: readonly NodeId[]): OutlineNode[] {
  return candidateNodeIds
    ? candidateNodeIds.flatMap((nodeId) => {
        const node = state.nodes[nodeId];
        return node ? [node] : [];
      })
    : Object.values(state.nodes);
}

function affectedRuntimeWindowIdsForStateTransition(
  previous: OutlineState,
  next: OutlineState,
  candidateNodeIds: readonly NodeId[]
): Set<number> {
  const windowIds = new Set<number>();
  for (const nodeId of candidateNodeIds) {
    const previousNode = previous.nodes[nodeId];
    const nextNode = next.nodes[nodeId];
    if (isLiveTabNode(previousNode)) {
      windowIds.add(previousNode.live.windowId);
    }
    if (isLiveWindowNode(previousNode)) {
      windowIds.add(previousNode.live.windowId);
    }
    if (isLiveTabNode(nextNode)) {
      windowIds.add(nextNode.live.windowId);
    }
    if (isLiveWindowNode(nextNode)) {
      windowIds.add(nextNode.live.windowId);
    }
  }
  return windowIds;
}

function runtimeTabIdsForCandidateNodes(
  previous: OutlineState,
  next: OutlineState,
  candidateNodeIds: readonly NodeId[]
): Set<number> {
  const tabIds = new Set<number>();
  for (const nodeId of candidateNodeIds) {
    const previousNode = previous.nodes[nodeId];
    const nextNode = next.nodes[nodeId];
    if (isLiveTabNode(previousNode)) {
      tabIds.add(previousNode.live.tabId);
    }
    if (isLiveTabNode(nextNode)) {
      tabIds.add(nextNode.live.tabId);
    }
  }
  return tabIds;
}

function closedRuntimeTabIdsForStateTransition(
  previous: OutlineState,
  next: OutlineState,
  candidateNodeIds: readonly NodeId[]
): Set<number> {
  const tabIds = new Set<number>();
  for (const nodeId of candidateNodeIds) {
    const previousNode = previous.nodes[nodeId];
    const nextNode = next.nodes[nodeId];
    if (isLiveTabNode(previousNode) && !isLiveTabNode(nextNode)) {
      tabIds.add(previousNode.live.tabId);
    }
  }
  return tabIds;
}

function candidateTransitionHasLiveTabInsertOrMove(
  previous: OutlineState,
  next: OutlineState,
  candidateNodeIds: readonly NodeId[]
): boolean {
  for (const nodeId of candidateNodeIds) {
    const previousNode = previous.nodes[nodeId];
    const nextNode = next.nodes[nodeId];
    if (!isLiveTabNode(nextNode)) {
      continue;
    }
    if (!isLiveTabNode(previousNode)) {
      return true;
    }
    if (
      previousNode.live.tabId !== nextNode.live.tabId ||
      previousNode.live.windowId !== nextNode.live.windowId ||
      previousNode.parentId !== nextNode.parentId
    ) {
      return true;
    }
  }
  return false;
}

function liveWindowNodeForRuntimeId(
  state: OutlineState,
  runtimeWindowId: number,
  candidateNodeIds: readonly NodeId[],
  scopedNodeId?: NodeId
): (OutlineNode & { live: { windowId: number } }) | undefined {
  for (const nodeId of candidateNodeIds) {
    const node = state.nodes[nodeId];
    if (isLiveWindowNode(node) && node.live.windowId === runtimeWindowId) {
      return node;
    }
  }

  const scopedNode = scopedNodeId ? state.nodes[scopedNodeId] : undefined;
  if (isLiveWindowNode(scopedNode) && scopedNode.live.windowId === runtimeWindowId) {
    return scopedNode;
  }

  const canonicalNode = state.nodes[`window:${runtimeWindowId}`];
  return isLiveWindowNode(canonicalNode) && canonicalNode.live.windowId === runtimeWindowId
    ? canonicalNode
    : undefined;
}

function candidateLiveTabNodesAffectingRuntimeOrder(
  previous: OutlineState,
  next: OutlineState,
  windowNode: OutlineNode & { live: { windowId: number } },
  candidateNodeIds: readonly NodeId[]
): LiveTabNode[] {
  const affectedNodeIds = new Set<NodeId>();
  for (const nodeId of candidateNodeIds) {
    const previousNode = previous.nodes[nodeId];
    const nextNode = next.nodes[nodeId];
    if (
      isLiveTabNode(nextNode) &&
      nextNode.live.windowId === windowNode.live.windowId &&
      candidateLiveTabAffectsRuntimeOrder(previous, next, previousNode, nextNode)
    ) {
      affectedNodeIds.add(nextNode.id);
    }
  }
  return outlineOrderedLiveTabNodesForRuntimeWindow(next, windowNode).filter((tabNode) =>
    affectedNodeIds.has(tabNode.id)
  );
}

function candidateLiveTabAffectsRuntimeOrder(
  previous: OutlineState,
  next: OutlineState,
  previousNode: OutlineNode | undefined,
  nextNode: LiveTabNode
): boolean {
  if (!isLiveTabNode(previousNode)) {
    return true;
  }
  if (
    previousNode.live.tabId !== nextNode.live.tabId ||
    previousNode.live.windowId !== nextNode.live.windowId ||
    previousNode.parentId !== nextNode.parentId
  ) {
    return true;
  }
  return outlineSiblingIndex(previous, previousNode) !== outlineSiblingIndex(next, nextNode);
}

function liveTabNodesFromExistingScopeOrder(
  state: OutlineState,
  runtimeWindowId: number,
  scope: RuntimeWindowScope
): LiveTabNode[] {
  return scope.tabOrder.flatMap((tabId) => {
    const nodeId = scope.tabNodeIdsByRuntimeId.get(tabId);
    const node = nodeId ? state.nodes[nodeId] : undefined;
    return isLiveTabNode(node) && node.live.windowId === runtimeWindowId ? [node] : [];
  });
}

function previousOutlineRuntimeTabIndex(state: OutlineState, tabNode: LiveTabNode): number | undefined {
  const windowNode = liveWindowNodes(state).find((candidate) =>
    candidate.status === "live" &&
    candidate.live.windowId === tabNode.live.windowId
  );
  if (!windowNode) {
    return undefined;
  }
  const index = outlineOrderedLiveTabNodesForRuntimeWindow(state, windowNode).findIndex((candidate) =>
    candidate.live.tabId === tabNode.live.tabId
  );
  return index >= 0 ? index : undefined;
}

function liveTabNodesFromRuntimeWindowOrder(
  state: OutlineState,
  windowInfo: RuntimeWindow,
  candidateNodeIds: readonly NodeId[],
  scope: RuntimeWindowScope | undefined
): LiveTabNode[] {
  const candidateTabNodeIdsByRuntimeId = new Map<number, NodeId>();
  for (const nodeId of candidateNodeIds) {
    const node = state.nodes[nodeId];
    if (isLiveTabNode(node)) {
      candidateTabNodeIdsByRuntimeId.set(node.live.tabId, node.id);
    }
  }

  return [...(windowInfo.tabs ?? [])]
    .filter((tab) => !tab.incognito)
    .sort((left, right) => left.index - right.index)
    .flatMap((tab) => {
      const nodeId = candidateTabNodeIdsByRuntimeId.get(tab.id) ?? scope?.tabNodeIdsByRuntimeId.get(tab.id);
      const node = nodeId ? state.nodes[nodeId] : undefined;
      return isLiveTabNode(node) && node.live.windowId === windowInfo.id ? [node] : [];
    });
}

function outlineSiblingIndex(state: OutlineState, node: OutlineNode): number {
  const siblings = node.parentId ? state.nodes[node.parentId]?.childIds : state.rootIds;
  const index = siblings?.indexOf(node.id) ?? -1;
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function outlineOrderedLiveTabNodesForRuntimeWindow(
  state: OutlineState,
  windowNode: OutlineNode & { live: { windowId: number } }
): LiveTabNode[] {
  const ordered: LiveTabNode[] = [];
  const visited = new Set<NodeId>();
  const visit = (nodeId: NodeId): void => {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);
    const node = state.nodes[nodeId];
    if (!node) {
      return;
    }
    if (node.id !== windowNode.id && isLiveWindowNode(node) && node.live.windowId !== windowNode.live.windowId) {
      return;
    }
    if (isLiveTabNode(node) && node.live.windowId === windowNode.live.windowId) {
      ordered.push(node);
    }
    for (const childId of node.childIds) {
      visit(childId);
    }
  };
  visit(windowNode.id);
  return ordered;
}

function sameNumberList(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function allRuntimeTabEvidenceFields(): ReadonlySet<RuntimeTabEvidenceField> {
  return new Set<RuntimeTabEvidenceField>([
    "windowId",
    "index",
    "active",
    "openerTabId",
    "url",
    "title",
    "favIconUrl"
  ]);
}

function runtimeTabEvidenceFieldsFromUpdate(changeInfo: Partial<RuntimeTab>): ReadonlySet<RuntimeTabEvidenceField> {
  const fields = new Set<RuntimeTabEvidenceField>();
  if (changeInfo.windowId !== undefined) {
    fields.add("windowId");
  }
  if (changeInfo.index !== undefined) {
    fields.add("index");
  }
  if (changeInfo.active !== undefined) {
    fields.add("active");
  }
  if (changeInfo.openerTabId !== undefined) {
    fields.add("openerTabId");
  }
  if (changeInfo.url !== undefined) {
    fields.add("url");
  }
  if (changeInfo.title !== undefined) {
    fields.add("title");
  }
  if (changeInfo.favIconUrl !== undefined) {
    fields.add("favIconUrl");
  }
  return fields;
}
