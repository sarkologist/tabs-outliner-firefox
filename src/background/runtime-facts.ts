import type { BackgroundCommand, RuntimeClosePlan } from "./commands.js";
import type { NodeId, OutlineNode, OutlineState, RuntimeTab, RuntimeWindow } from "../model/types.js";

export type RuntimeSnapshotConfidence = "complete" | "partial" | "eventLocal" | "staleSuspect";

export type RuntimeObservation =
  | {
      source: "tabEvent";
      kind: "created" | "updated" | "activated" | "removed";
      tabId: number;
      windowId?: number;
      tab?: RuntimeTab;
    }
  | {
      source: "windowEvent";
      kind: "focused" | "removed";
      windowId: number;
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

type LiveTabNode = OutlineNode & { live: { tabId: number; windowId: number } };

export type WindowClosingTabRemovalDecision =
  | "ignore-command-owned"
  | "wait-for-runtime-window"
  | "wait-for-remaining-tabs"
  | "close-window";

export class RuntimeFactLedger {
  readonly pendingGroupedTabIdsByWindowId = new Map<number, Set<number>>();
  readonly movedOutGroupedTabIdsByWindowId = new Map<number, Set<number>>();

  private readonly outlinerClosingTabIds = new Set<number>();
  private readonly outlinerClosingWindowIds = new Set<number>();
  private readonly deleteOwnedClosingTabIds = new Set<number>();
  private readonly deleteOwnedClosingWindowIds = new Set<number>();
  private readonly removedTabIds = new Set<number>();
  private readonly removedWindowIds = new Set<number>();
  private readonly commandRestoredTabIds = new Set<number>();
  private readonly commandRelocatedTabEchoes = new Map<number, CommandRelocatedTabEcho>();
  private readonly commandFocusedTabIds = new Set<number>();
  private readonly commandFocusedActivationWindowIds = new Set<number>();
  private readonly commandFocusedWindowIds = new Set<number>();
  private readonly observations: RuntimeObservation[] = [];
  private readonly transactions = new Map<string, CommandTransaction>();
  private nextCommandSequence = 1;

  constructor(private readonly maxObservations = 500) {}

  recordObservation(observation: RuntimeObservation): void {
    this.observations.push(observation);
    if (this.observations.length > this.maxObservations) {
      this.observations.splice(0, this.observations.length - this.maxObservations);
    }
  }

  observationsSnapshot(): RuntimeObservation[] {
    return [...this.observations];
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

  markTabRemoved(tabId: number): void {
    this.removedTabIds.add(tabId);
    this.commandRelocatedTabEchoes.delete(tabId);
  }

  markTabsRemoved(tabIds: readonly number[]): void {
    for (const tabId of tabIds) {
      this.markTabRemoved(tabId);
    }
  }

  markWindowRemoved(windowId: number): void {
    this.removedWindowIds.add(windowId);
  }

  hasRemovedWindow(windowId: number): boolean {
    return this.removedWindowIds.has(windowId);
  }

  clearRemovalTombstonesForLiveState(next: OutlineState): void {
    for (const node of liveTabNodes(next)) {
      this.removedTabIds.delete(node.live.tabId);
    }
    for (const node of liveWindowNodes(next)) {
      this.removedWindowIds.delete(node.live.windowId);
    }
  }

  ignoredTabIdsForRefresh(): Set<number> {
    return new Set([...this.removedTabIds, ...this.deleteOwnedClosingTabIds]);
  }

  ignoredWindowIdsForRefresh(): Set<number> {
    return new Set([...this.removedWindowIds, ...this.deleteOwnedClosingWindowIds]);
  }

  consumeDeleteOwnedClosingTab(tabId: number): boolean {
    return this.deleteOwnedClosingTabIds.delete(tabId);
  }

  consumeDeleteOwnedClosingWindow(windowId: number): boolean {
    return this.deleteOwnedClosingWindowIds.delete(windowId);
  }

  hasDeleteOwnedClosingWindow(windowId: number): boolean {
    return this.deleteOwnedClosingWindowIds.has(windowId);
  }

  consumeOutlinerClosingTab(tabId: number): boolean {
    return this.outlinerClosingTabIds.delete(tabId);
  }

  hasOutlinerClosingWindow(windowId: number): boolean {
    return this.outlinerClosingWindowIds.has(windowId);
  }

  hasOutlinerClosingTabs(): boolean {
    return this.outlinerClosingTabIds.size > 0;
  }

  clearWindowCloseTracking(windowId: number): void {
    this.outlinerClosingWindowIds.delete(windowId);
    this.pendingGroupedTabIdsByWindowId.delete(windowId);
    this.movedOutGroupedTabIdsByWindowId.delete(windowId);
  }

  clearTabCloseTracking(tabId: number): void {
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

  hasCommandFocusedTab(tabId: number): boolean {
    return this.commandFocusedTabIds.has(tabId);
  }

  consumeCommandFocusedTab(tabId: number): void {
    this.commandFocusedTabIds.delete(tabId);
  }

  consumeCommandFocusedActivationWindow(windowId: number): void {
    this.commandFocusedActivationWindowIds.delete(windowId);
  }

  hasCommandFocusedWindow(windowId: number): boolean {
    return this.commandFocusedWindowIds.has(windowId);
  }

  consumeCommandFocusedWindow(windowId: number): void {
    this.commandFocusedWindowIds.delete(windowId);
  }

  isCommandFocusActiveUpdateEcho(changeInfo: Partial<RuntimeTab>, tab: RuntimeTab): boolean {
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
