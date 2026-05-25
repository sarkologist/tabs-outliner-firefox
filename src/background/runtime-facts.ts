import type { BackgroundCommand, RuntimeClosePlan } from "./commands.js";
import {
  RuntimeWindowScopeIndex,
  type RuntimeWindowScope,
  type RuntimeWindowScopeSnapshot
} from "./runtime-window-scope.js";
import type { NodeId, OutlineNode, OutlineState, RuntimeTab, RuntimeWindow } from "../model/types.js";

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
  source: "command" | "windowEvent" | "snapshot" | "installedState";
  confidence: RuntimeShapeFactConfidence;
  scopeGeneration: number;
  sequence: number;
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
  toWindowId: number;
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

  private recordInstalledStateShape(state: OutlineState, nodes?: readonly OutlineNode[]): void {
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
      for (let index = 0; index < scope.tabOrder.length; index += 1) {
        const tabId = scope.tabOrder[index]!;
        tabIndexByRuntimeId.set(tabId, index);
      }
      if (scope.lifecycle === "live") {
        this.windowShapeFacts.set(scope.runtimeWindowId, {
          windowId: scope.runtimeWindowId,
          tabOrder: [...scope.tabOrder],
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
    this.windowScopes.rebuild({
      state,
      ...(nodes ? { nodes } : {}),
      ...(windows ? { windows } : {}),
      browserCreatedWindowIds: this.browserCreatedWindowIds,
      commandCreatedWindowIds: this.commandCreatedWindowIds
    });
    this.recordInstalledStateShape(state, nodes);
  }

  windowScope(windowId: number): RuntimeWindowScope | undefined {
    return this.windowScopes.scopeForWindow(windowId);
  }

  windowScopeForTab(tabId: number): RuntimeWindowScope | undefined {
    return this.windowScopes.scopeForTab(tabId);
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
    if (!this.reconstructedLiveWindowIds.has(tab.windowId) && !this.isWindowIgnoredForRefresh(tab.windowId)) {
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

  isBrowserCreatedRuntimeWindow(windowId: number): boolean {
    return this.browserCreatedWindowIds.has(windowId) ||
      this.windowScopes.scopeForWindow(windowId)?.provenance === "browserCreated";
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
    if (!this.reconstructedLiveWindowIds.has(windowInfo.id) && !this.isWindowIgnoredForRefresh(windowInfo.id)) {
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
      this.outlinerClosingTabIds.delete(tabId);
    }
    for (const windowId of plan.windowIds) {
      this.markWindowRemoved(windowId);
      this.outlinerClosingWindowIds.delete(windowId);
    }
  }

  private markTabRemoved(tabId: number): void {
    this.removedTabIds.add(tabId);
    this.commandRestoredTabIds.delete(tabId);
    this.commandRelocatedTabEchoes.delete(tabId);
    this.structurallyFreshTabIds.delete(tabId);
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
        this.removedWindowIds.delete(node.live.windowId);
        this.deleteOwnedClosingWindowIds.delete(node.live.windowId);
        this.outlinerClosingWindowIds.delete(node.live.windowId);
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

  consumeOutlinerClosingTab(tabId: number): boolean {
    return this.outlinerClosingTabIds.delete(tabId);
  }

  private hasOutlinerClosingWindow(windowId: number): boolean {
    return this.outlinerClosingWindowIds.has(windowId);
  }

  private hasOutlinerClosingTabs(): boolean {
    return this.outlinerClosingTabIds.size > 0;
  }

  recordOutlinerClosedTabRemovalApplied(): void {
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
      }
      this.commandRelocatedTabEchoes.set(previousNode.live.tabId, {
        fromWindowIds,
        toWindowId: nextNode.live.windowId
      });
    }
  }

  recordCommandRelocatedTab(tabId: number, fromWindowId: number, toWindowId: number): void {
    const existingEcho = this.commandRelocatedTabEchoes.get(tabId);
    const fromWindowIds = new Set(existingEcho?.fromWindowIds ?? []);
    fromWindowIds.add(fromWindowId);
    this.commandCreatedWindowIds.add(toWindowId);
    this.commandRelocatedTabEchoes.set(tabId, { fromWindowIds, toWindowId });
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
