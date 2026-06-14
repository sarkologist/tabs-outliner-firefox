import type { BrowserAdapter } from "./adapter.js";
import {
  AUTOMATIC_BACKUP_ALARM_NAME,
  AUTOMATIC_BACKUP_INTERVAL_MINUTES,
  automaticBackupDue,
  downloadAutomaticBackup,
  errorText as backupErrorText,
  loadAutomaticBackupStatus,
  nextAutomaticBackupTime,
  saveAutomaticBackupStatus,
  type AutomaticBackupStatus
} from "./backups.js";
import { createBrowserAdapter } from "./browser-adapter.js";
import { createSidebarBroadcaster } from "./sidebar-broadcaster.js";
import { createMutationScheduler } from "./mutation-scheduler.js";
import {
  outlineStateCountDetail,
  emptyOutlineStateCountDetail,
  outlineStateCountDeltaDetail
} from "./outline-state-metrics.js";
import { createPersistenceCoordinator, type SaveSchedule } from "./persistence-coordinator.js";
import { normalizeBrowserCreateUrl } from "./browser-create-url.js";
import {
  preserveClosedSubtreesAcrossNonDestructiveTransition,
  type ClosedSubtreeGuardResult
} from "./closed-subtree-guard.js";
import { computeDiagnostics, type OutlineDiagnostics } from "./diagnostics.js";
import { appendIncidentLogEntry, loadIncidentLog, type IncidentLogDetail } from "./incident-log.js";
import { isBackgroundCommand, planCloseNodeRuntimeClose, planLiveSubtreeClose, runCommand, syncBrowserOrder } from "./commands.js";
import type { BackgroundCommand, CommandAck, RestoreCreateAttempt, RuntimeClosePlan } from "./commands.js";
import {
  RuntimeFactLedger,
  runtimeCommandRelocatesLiveTabs,
  type RuntimeAcceptedTabScopeUpdate,
  type RuntimeFactLedgerDebugSnapshot,
  type RuntimeTabEvidence,
  type RuntimeTabEvidenceField
} from "./runtime-facts.js";
import {
  appendRuntimeLifecycleJournalEntry,
  clearRuntimeLifecycleJournalEntries,
  loadRuntimeLifecycleJournal,
  replaceRuntimeLifecycleJournalEntry,
  type RuntimeLifecycleJournal,
  type RuntimeLifecycleJournalEntry
} from "./runtime-lifecycle-journal.js";
import { RuntimeReconciler } from "./runtime-reconciler.js";
import { getNormalWindow, getNormalWindows, getNormalWindowsIncludingTabs } from "./runtime-snapshot.js";
import { createStateCache } from "./state-cache.js";
import {
  changedNodeIdsSinceBaseline,
  nodesMateriallyEqual,
  runtimeWindowOrdersMatch,
  runtimeWindowTabOrder,
  sameNumberList,
  sameNumberSet,
  statesEqualIgnoringUpdatedAt,
  statesMateriallyEqual
} from "./state-equality.js";
import {
  addSubtreeNodeIds,
  liveStructureChanged,
  liveTabIdsInWindow,
  liveTabNodeByRuntimeId,
  liveTabNodesInSubtree,
  liveWindowNodeByRuntimeId,
  nodeIsReachableFromRoot,
  uniqueDefinedNodeIds
} from "./live-node-queries.js";
import {
  cloneNodeForHistoryMutation,
  deleteHistoryReplayContainerNode,
  deleteHistoryReplaySubtree,
  deleteHistoryReplayTabNode,
  historyNodeUrl,
  moveHistoryReplayNodeToParent,
  nearestLiveWindowId,
  replaceLiveWindowIdInSubtree,
  updateLiveTabRef
} from "./history-replay.js";
import {
  type RuntimeStateIndex,
  addRuntimeIndexNode,
  buildRuntimeStateIndex,
  buildRuntimeStateIndexFromLookup,
  canonicalWindowIdFromNodeId,
  collectRuntimeIndexCandidateNodeIds,
  indexedLiveTabNodeByRuntimeId,
  nearestWindowNodeId,
  pruneRuntimeIndexClosedRestoreCandidates,
  pruneRuntimeIndexWindowTabSets,
  removeRuntimeIndexNode,
  runtimeIndexCandidateNodeIdsForCommand,
  runtimeIndexCandidateNodeIdsForTabRemoval,
  runtimeIndexCandidateNodeIdsForWindowRemoval,
  runtimeIndexForStateTransition,
  runtimeStateIndexMismatchReason,
  runtimeTabNodeForFastPath,
  tabNodeIdForRuntime,
  updateRuntimeIndexClosedRestoreCandidateCount,
  updateRuntimeTabNodeForFastPath,
  windowNodeIdForRuntime
} from "./runtime-state-index.js";
import {
  type InitialTreeSnapshotWindowMessage,
  type PerformanceTraceMessage,
  type SidebarPerformanceTraceCollectedMessage,
  hasOutlineRelevantTabUpdate,
  isDiagnosticsRequest,
  isExportTreeMessage,
  isIncidentLogRequest,
  isInitialTreeSnapshotMessage,
  isInitialTreeSnapshotWindowMessage,
  isOpenSidebarWindowMessage,
  isPerformanceTraceMessage,
  isSidebarNonEditInteractionMessage,
  isSidebarPerformanceTraceCollectedMessage,
  messageType
} from "./message-guards.js";
import {
  type NodeStateUpdate,
  type RuntimeSnapshotMatch,
  type SameParentReorderUpdate,
  type StateDiffMode,
  type TreeStructureUpdate,
  deleteTreeStructureCandidateNodeIds,
  isUsefulTreeStructureUpdate,
  liveTabNodeWouldChange,
  nodeChangedForPatch,
  nodeStateUpdateFromStateChange,
  nodeStateUpdateForNodeIds,
  runtimeSnapshotMateriallyMatchesState,
  sameParentReorderUpdateForMoveCommand,
  treeStructureUpdateFromCandidateNodeIds,
  treeStructureUpdateFromStateChange
} from "./patch-updates.js";
import {
  INITIAL_TREE_SNAPSHOT_ROW_LIMIT,
  createInitialTreeSnapshotProjector,
  initialTreeSnapshotForState
} from "./initial-tree-snapshot.js";
import {
  loadHistory,
  loadInitialTreeSnapshot,
  loadStateWithMetadata,
  STATE_KEY,
  STATE_V2_MANIFEST_KEY,
  STATE_V3_MANIFEST_KEY,
  type LoadedOutlineState
} from "./storage.js";
import {
  STATE_V4_MIGRATION_BACKUP_KEY,
  STATE_V4_MIGRATION_BACKUP_META_KEY,
  loadStateV4,
  sweepOrphanedV4Shards
} from "./storage-v4.js";
import { measureStorageCensus, storageCensusIncidentDetail } from "./storage-census.js";
import {
  JOURNAL_META_KEY,
  journalEntryAffectsHistory,
  replayJournal,
  replayJournalWithHistory,
  type OutlineJournalEntry
} from "./outline-journal.js";
import type { InitialTreeSnapshot } from "./initial-tree-snapshot.js";
import type {
  LoadStateOptions,
  StateLoadPhase,
  StateStructureRepair
} from "./storage.js";
import {
  applyOutlineDelta,
  createHistoryEntry,
  historyStatus,
  normalizeHistoryState,
  popRedoEntry,
  popUndoEntry,
  pushRedoEntry,
  pushUndoEntry,
  pushUndoEntryPreservingRedo,
  type HistoryState,
  type HistoryEntry,
  type HistoryStatus,
  type OutlineDelta,
  type TrackableHistoryCommandType
} from "./history.js";
import {
  APP_PREFERENCES_STORAGE_KEY,
  DEFAULT_APP_PREFERENCES,
  loadAppPreferences,
  normalizeAppPreferences,
  type AppPreferences
} from "../preferences.js";
import {
  bootstrapFromWindows,
  analyzeRestoreScope,
  cloneOutlineNode,
  cloneOutlineState,
  closeTab,
  closeWindow,
  deleteNode as deleteOutlineNode,
  deleteLiveTabNodeByTabId,
  moveSubtreeToBottomTopLevel,
  moveSubtreeToTopLevel,
  moveTabToNewLiveWindow,
  planRestore,
  projectLiveTabs,
  reconcileWithWindows,
  repairState,
  restoreNodes,
  runtimeTitleForOutlineTab,
  shouldUseRuntimeOpenerParent,
  wrapNodeInGroup
} from "../model/outline.js";
import { buildOutlineLookup, type OutlineLookup } from "../model/outline-lookup.js";
import { isLiveTabNode, isLiveWindowNode, liveTabNodes, liveWindowNodes } from "../model/live-nodes.js";
import { exportPortableTree, portableTreeFilename, serializePortableTreeFile } from "../model/portable-tree.js";
import type { NodeId, OutlineNode, OutlineState, ReconcileOptions, RestoredNode, RuntimeTab, RuntimeWindow, RuntimeWindowProvenance } from "../model/types.js";
import { createPerformanceTracer, type TraceDetail, type TraceSnapshot } from "../perf/trace.js";
import {
  PROFILE_STORAGE_KEY,
  isLabeledTraceSnapshot,
  type LabeledTraceSnapshot,
  type PerformanceProfileSnapshot
} from "../perf/profile.js";

export type BackgroundController = {
  ensureState(): Promise<OutlineState>;
  handleMessage(message: unknown): Promise<unknown>;
  refreshFromRuntime(eventTabs?: RuntimeTab[], options?: RefreshOptions): Promise<boolean>;
  flushPendingSaves(): Promise<void>;
  __debugRuntimeIndexStatus(): { warm: boolean; matchesState: boolean; reason: string };
  __debugRuntimeCacheSnapshot(): RuntimeCacheDebugSnapshot;
};

export type RuntimeCacheDebugSnapshot = {
  runtimeIndex: { warm: boolean; matchesState: boolean; reason: string };
  ledger: RuntimeFactLedgerDebugSnapshot;
};

type RefreshOptions = {
  closeMissing?: boolean;
  activationByWindowId?: ReadonlyMap<number, number>;
  focusWindowId?: number;
  forceSnapshot?: boolean;
};

type RuntimeRefreshCaller = {
  resolve: (changed: boolean) => void;
  reject: (error: unknown) => void;
};

type PendingRuntimeRefresh = {
  eventTabsById: Map<number, RuntimeTabEvidence>;
  activationByWindowId: Map<number, number>;
  focusWindowIds: Set<number>;
  closeMissing: boolean;
  forceSnapshot: boolean;
  callers: RuntimeRefreshCaller[];
  scheduled: boolean;
};

type RuntimeResourceIds = {
  tabIds: Set<number>;
  windowIds: Set<number>;
};

type RestoreCreateRecoveryContext = {
  attempts: RestoreCreateAttempt[];
  before: RuntimeResourceIds | undefined;
};

type RuntimeLifecycleJournalRecovery = {
  state: OutlineState;
  history?: HistoryState;
  changed: boolean;
  changedHistory: boolean;
  consumedEntryIds: string[];
  completedOutlinerClosePlans: RuntimeClosePlan[];
  completedDeleteClosePlans: RuntimeClosePlan[];
};

type RuntimeLifecycleJournalEntryRecovery = {
  state: OutlineState;
  history?: HistoryState;
  completedOutlinerClosePlan?: RuntimeClosePlan;
  completedDeleteClosePlan?: RuntimeClosePlan;
};

type NativeTabCloseJournalEntry = Extract<RuntimeLifecycleJournalEntry, { kind: "nativeTabClose" }>;
type NativeWindowCloseJournalEntry = Extract<RuntimeLifecycleJournalEntry, { kind: "nativeWindowClose" }>;

type ReconciledStateChange = {
  previous: OutlineState;
  next: OutlineState;
  runtimeLifecycleJournalEntries?: RuntimeLifecycleJournalEntry[];
};

type ActiveStateUpdate = {
  nodeId: NodeId;
  active: boolean;
};










type ExportTreeResponse = {
  type: "exportTree";
  filename: string;
  contentType: "application/json";
  content: string;
};


type PendingSidebarProfileCollection = {
  sidebars: LabeledTraceSnapshot[];
  seenSidebarIds: Set<string>;
};


type BestEffortPatchOptions = {
  diffMode?: StateDiffMode;
  skipNodeState?: boolean;
  saveSchedule?: SaveSchedule;
};

type BestEffortPatchResult = {
  candidateNodeIds?: NodeId[];
  usedFullState: boolean;
};

type RuntimeEventTabsFastPathResult =
  | {
      handled: false;
    }
  | {
      handled: true;
      changed: false;
    }
  | {
      handled: true;
      changed: true;
      state: OutlineState;
      index: RuntimeStateIndex;
      update: TreeStructureUpdate | NodeStateUpdate;
      structuralChanged: boolean;
      runtimeScopeChanged: boolean;
      runtimeScopeUpdates: RuntimeAcceptedTabScopeUpdate[];
    };

export type BackgroundControllerOptions = {
  api: WebExtensionBrowser;
  adapter?: BrowserAdapter;
  now?: () => number;
};

const RUNTIME_REFRESH_BATCH_DELAY_MS = 0;
// The migration's portable-tree backup is a one-time safety copy; reclaim its quota after
// the soak window (01-TARGET-ARCHITECTURE.md section 6).
const MIGRATION_BACKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SIDEBAR_PROFILE_COLLECTION_DELAY_MS = 50;
// Defer the one-time orphaned-shard sweep past startup so first paint, hydration, and early
// interaction land first; its whole-store read is the same shape as the storage census.
const ORPHAN_SHARD_SWEEP_DELAY_MS = 8000;
// Diagnostics are an advisory footer readout (a Firefox-vs-outline tab count), so a brief
// staleness window is acceptable. Reusing the last result within this window collapses the
// per-sidebar poll fan-out (3 sidebars re-arm after every command) into at most one
// scheduler-idle wait + browser-window query per window, keeping diagnostics off the
// single background thread's critical path while a command is in flight.
const DIAGNOSTICS_RESULT_TTL_MS = 1000;
const TOGGLE_SIDEBAR_COMMAND = "toggle-sidebar";
const SIDEBAR_WINDOW_PATH = "sidebar/sidebar.html";

export function createBackgroundController(options: BackgroundControllerOptions): BackgroundController {
  const { api, now = Date.now } = options;
  const adapter = options.adapter ?? createBrowserAdapter(api);
  const perfTrace = createPerformanceTracer("background");
  const sidebarBroadcaster = createSidebarBroadcaster({
    perfTrace,
    sendRuntimeMessage: (message) => api.runtime.sendMessage(message)
  });
  const initialTreeSnapshotProjector = createInitialTreeSnapshotProjector({
    onProjectionBuilt: (detail) => {
      perfTrace.mark("background.projection.build", {
        search: Boolean(detail.query),
        rows: detail.rowCount,
        nodes: detail.nodeCount,
        matches: detail.matchCount
      });
    }
  });
  let performanceTracePreferenceLoaded = false;
  const performanceTracePreferenceReady = applyStoredPerformanceTracePreference().finally(() => {
    performanceTracePreferenceLoaded = true;
  });
  const runtimeFacts = new RuntimeFactLedger();
  const runtimeReconciler = new RuntimeReconciler();

  let state: OutlineState | undefined;
  let lastPersistedState: OutlineState | undefined;
  let deferredPersistedStateCloneTimer: ReturnType<typeof setTimeout> | undefined;
  let historyState: HistoryState | undefined;
  let historyLoadInFlight: Promise<HistoryState> | undefined;
  let historyWarmupTimer: ReturnType<typeof setTimeout> | undefined;
  // Before the full state is in memory, every booting sidebar asks for the sparse boot snapshot.
  // With many windows open they arrive together and would each read the same persisted snapshot
  // key off the single background thread; share one in-flight read instead (see initialTreeSnapshot).
  let initialTreeSnapshotLoadInFlight: Promise<InitialTreeSnapshot | undefined> | undefined;
  let preferences: AppPreferences | undefined;
  let runtimeIndex: RuntimeStateIndex | undefined;
  const stateCache = createStateCache(initializeState);
  let sessionChangedQueued = false;
  let pendingSessionChangedCount = 0;
  let pendingRuntimeRefresh: PendingRuntimeRefresh | undefined;
  let nextRuntimeLifecycleJournalSequence = 1;
  const runtimeLifecycleJournalEntryIdsToClearAfterSave = new Set<string>();
  const pendingOutlinerCloseJournalEntries = new Map<string, {
    plan: RuntimeClosePlan;
    completedTabIds: Set<number>;
    completedWindowIds: Set<number>;
  }>();
  let diagnosticsInFlight: Promise<OutlineDiagnostics> | undefined;
  let lastDiagnostics: { value: OutlineDiagnostics; atMs: number } | undefined;
  let storageCensusInFlight = false;
  let orphanShardSweepScheduled = false;
  // Runtime-window snapshot reused by diagnostics so getNormalWindows (a browser
  // windows.getAll + tabs.query that cost up to ~2.5s on a large session, and contend with
  // the storage writes a delete triggers) runs only after a real tab/window event changes
  // browser state, not on every poll. Both this and lastDiagnostics are cleared in
  // queueRuntimeRefresh/queueRuntimeActivation when any runtime event is observed.
  let diagnosticsRuntimeWindows: RuntimeWindow[] | undefined;
  let automaticBackupInFlight: Promise<AutomaticBackupStatus> | undefined;
  let sidebarProfileRequestSequence = 0;
  let sidebarWindowCreationInFlight = 0;
  const fullSizeOutlinerWindowIds = new Set<number>();
  const pendingSidebarProfileCollections = new Map<string, PendingSidebarProfileCollection>();

  const mutationScheduler = createMutationScheduler({
    perfTrace,
    hasPendingRuntimeRefresh: () => pendingRuntimeRefresh !== undefined
  });
  const {
    enqueueMutation,
    waitForSchedulerIdle,
    waitForHighPrioritySchedulerIdle,
    isHighPrioritySchedulerIdle
  } = mutationScheduler;

  const persistence = createPersistenceCoordinator({
    api,
    perfTrace,
    now,
    getState: () => state,
    getLastPersistedState: () => lastPersistedState,
    setLastPersistedState: (next) => {
      lastPersistedState = next;
    },
    deferPersistedStateBaselineClone,
    recordIncidentLog,
    clearCompletedRuntimeLifecycleJournalEntriesAfterSave
  });
  const {
    scheduleStateSave,
    scheduleHistorySave,
    flushPendingSaves,
    hasPendingOrInFlightSave,
    pausePendingSaveTimers,
    resumePendingSaveTimers,
    appendCommandJournal,
    appendCommandJournalForKnownNodeIds,
    queueRuntimeEventJournal,
    queueRuntimeEventJournalFromUpdate,
    flushEventJournalQueue,
    compactOutlineJournal,
    migrateLegacyStateToV4,
    deleteLegacyStateKeys,
    createAndInitJournal,
    adoptLoadedV4Snapshot
  } = persistence;

  api.runtime.onInstalled.addListener(() => {
    return initializeExtensionLifecycle().catch((error) => {
      perfTrace.mark("background.lifecycle.installed.error", { message: errorText(error) });
    });
  });

  api.runtime.onStartup.addListener(() => {
    return initializeExtensionLifecycle().catch((error) => {
      perfTrace.mark("background.lifecycle.startup.error", { message: errorText(error) });
    });
  });

  api.action.onClicked.addListener(async () => {
    await perfTrace.measureAsync("background.action.openSidebar", () => api.sidebarAction.open());
  });

  api.commands.onCommand.addListener((command) => {
    if (command !== TOGGLE_SIDEBAR_COMMAND) {
      return;
    }
    void perfTrace.measureAsync("background.command.toggleSidebar", () => api.sidebarAction.toggle()).catch((error) => {
      perfTrace.mark("background.command.toggleSidebar.error", { message: errorText(error) });
    });
  });

  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== AUTOMATIC_BACKUP_ALARM_NAME) {
      return;
    }
    return handleAutomaticBackupAlarm().catch((error) => {
      perfTrace.mark("background.backup.alarm.error", { message: errorText(error) });
    });
  });

  api.runtime.onMessage.addListener((message) => handleMessage(message));
  api.runtime.onConnect?.addListener((port) => {
    sidebarBroadcaster.registerPort(port);
  });

  api.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[APP_PREFERENCES_STORAGE_KEY]) {
      return;
    }
    return handlePreferencesChanged(changes[APP_PREFERENCES_STORAGE_KEY].newValue).catch((error) => {
      perfTrace.mark("background.preferences.changed.error", { message: errorText(error) });
    });
  });

  api.tabs.onCreated.addListener(async (tab) => {
    await perfTrace.measureAsync("background.event.tabs.onCreated", { tabId: tab.id }, () => {
      seedRuntimeWindowProvenanceFromCurrentState(tab.windowId);
      const evidence = runtimeFacts.recordNativeTabCreated(tab);
      return queueRuntimeRefresh([evidence]);
    });
  });

  api.tabs.onDetached?.addListener(async (tabId, detachInfo) => {
    await perfTrace.measureAsync("background.event.tabs.onDetached", { tabId, windowId: detachInfo.oldWindowId }, async () => {
      runtimeFacts.recordNativeTabDetached(tabId, detachInfo.oldWindowId);
      if (await absorbCommandRelocationNativeEcho("detached", tabId, detachInfo.oldWindowId)) {
        return;
      }
      return queueRuntimeRefresh([], { closeMissing: false, forceSnapshot: true });
    });
  });

  api.tabs.onAttached?.addListener(async (tabId, attachInfo) => {
    await perfTrace.measureAsync("background.event.tabs.onAttached", { tabId, windowId: attachInfo.newWindowId }, async () => {
      seedRuntimeWindowProvenanceFromCurrentState(attachInfo.newWindowId);
      runtimeFacts.recordNativeTabAttached(tabId, attachInfo.newWindowId);
      if (await absorbCommandRelocationNativeEcho("attached", tabId, attachInfo.newWindowId)) {
        return;
      }
      return queueRuntimeRefresh([], { closeMissing: false, forceSnapshot: true });
    });
  });

  api.tabs.onMoved?.addListener(async (tabId, moveInfo) => {
    await perfTrace.measureAsync("background.event.tabs.onMoved", { tabId, windowId: moveInfo.windowId }, async () => {
      runtimeFacts.recordNativeTabMoved(tabId, moveInfo.windowId);
      if (await absorbCommandRelocationNativeEcho("moved", tabId, moveInfo.windowId)) {
        return;
      }
      return queueRuntimeRefresh([], { closeMissing: false, forceSnapshot: true });
    });
  });

  api.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
    await perfTrace.measureAsync("background.event.tabs.onUpdated", { tabId: tab.id }, async () => {
      if (!hasOutlineRelevantTabUpdate(changeInfo)) {
        return;
      }
      seedRuntimeWindowProvenanceFromCurrentState(tab.windowId);
      const record = runtimeFacts.recordNativeTabUpdated(tab, changeInfo);
      if (record.echoDecision.action === "applyFastPath") {
        await handleCommandTabActivated({ tabId: tab.id, windowId: tab.windowId }, { consumeTabEcho: false });
        return;
      }
      await queueRuntimeRefresh([record.evidence]);
    });
  });

  api.tabs.onActivated.addListener(async (activeInfo) => {
    await perfTrace.measureAsync("background.event.tabs.onActivated", { tabId: activeInfo.tabId }, async () => {
      if (runtimeFacts.recordNativeTabActivated(activeInfo.tabId, activeInfo.windowId).action === "applyFastPath") {
        await handleCommandTabActivated(activeInfo);
        return;
      }
      await queueRuntimeActivation(activeInfo);
    });
  });

  // Shared mutation tail for both native window-close signals: a windows.onRemoved
  // event and a tabs.onRemoved with isWindowClosing that the reconciler classified
  // as a whole-window close.
  async function applyNativeWindowClose(
    current: OutlineState,
    windowId: number,
    liveTabIds: number[],
    options: { closedByOutliner: boolean; eventName: string }
  ): Promise<void> {
    runtimeFacts.recordClosedRuntimeWindow(windowId, liveTabIds);
    const recent = await mostRecentClosedSession();
    const next = closeWindow(current, windowId, {
      now: now(),
      ...(recent?.window?.sessionId ? { sessionId: recent.window.sessionId } : {}),
      ...(options.closedByOutliner ? { closedBy: "outliner" as const } : {})
    });
    if (next === current) {
      return;
    }
    const runtimeLifecycleJournalEntry = runtimeLifecycleJournalEntryForNativeWindowClose(
      current,
      windowId,
      liveTabIds,
      recent?.window?.sessionId
    );
    if (runtimeLifecycleJournalEntry) {
      await ensureDurableRuntimeLifecycleBase();
      await appendRuntimeLifecycleJournalEntry(api, runtimeLifecycleJournalEntry);
    }
    installStateTransition(current, next, {
      candidateNodeIds: runtimeIndexCandidateNodeIdsForWindowRemoval(current, next, runtimeIndexForState(current), windowId)
    });
    markCompletedOutlinerCloseJournalEntriesForClearAfterSave({
      tabIds: liveTabIds,
      windowIds: [windowId]
    });
    markRuntimeLifecycleJournalEntryForClearAfterSave(runtimeLifecycleJournalEntry);
    const persistedCandidates = await persistWithNodeStateUpdate(current, next);
    queueRuntimeEventJournal(current, next, persistedCandidates, options.eventName);
  }

  api.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    await perfTrace.measureAsync("background.event.tabs.onRemoved", { tabId }, async () => {
      if (runtimeFacts.recordNativeTabRemoved(tabId, removeInfo.windowId) === "ignore-delete-owned") {
        return;
      }
      if (removeInfo.isWindowClosing) {
        if (runtimeFacts.isCommandOwnedWindowClose(removeInfo.windowId)) {
          return;
        }

        await enqueueMutation(async () => {
          const runtimeWindow = await getNormalWindow(api, removeInfo.windowId);
          const current = await ensureState();
          const liveTabIds = liveTabIdsInWindow(current, removeInfo.windowId);
          const decision = runtimeReconciler.classifyWindowClosingTabRemoval(
            runtimeFacts,
            {
              windowId: removeInfo.windowId,
              liveTabIds,
              runtimeWindowOpen: Boolean(runtimeWindow)
            }
          );
          if (decision !== "close-window") {
            return;
          }

          await applyNativeWindowClose(current, removeInfo.windowId, liveTabIds, {
            closedByOutliner: false,
            eventName: "tabs.onRemoved.windowClosing"
          });
        }, { reason: "tabs.onRemoved.windowClosing" });
        return;
      }

      await enqueueMutation(async () => {
        const current = await ensureState();
        let next: OutlineState;
        const removal = runtimeReconciler.classifyMissingLiveTabRemoval(current, runtimeFacts, tabId);
        if (removal === "close-outliner-tab") {
          const recent = await mostRecentClosedSession();
          next = closeTab(current, tabId, {
            now: now(),
            ...(recent?.tab?.sessionId ? { sessionId: recent.tab.sessionId } : {}),
            closedBy: "outliner"
          });
          runtimeFacts.recordOutlinerClosedTabRemovalApplied(tabId);
        } else {
          next = deleteLiveTabNodeByTabId(current, tabId);
        }
        if (next === current) {
          return;
        }
        const runtimeLifecycleJournalEntry = removal === "delete-tab"
          ? runtimeLifecycleJournalEntryForNativeTabClose(current, tabId, removeInfo.windowId)
          : undefined;
        if (runtimeLifecycleJournalEntry) {
          await appendObservedNativeTabCloseJournalEntry(runtimeLifecycleJournalEntry);
        }
        const runtimeWindowsAfterRemoval = removal === "delete-tab"
          ? await getNormalWindows(api).catch(() => undefined)
          : undefined;
        installStateTransition(current, next, {
          candidateNodeIds: runtimeIndexCandidateNodeIdsForTabRemoval(current, next, runtimeIndexForState(current), tabId),
          ...(runtimeWindowsAfterRemoval ? { runtimeWindows: runtimeWindowsAfterRemoval } : {})
        });
        markCompletedOutlinerCloseJournalEntriesForClearAfterSave({
          tabIds: [tabId],
          windowIds: []
        });
        markRuntimeLifecycleJournalEntryForClearAfterSave(runtimeLifecycleJournalEntry);
        const persistedCandidates = await persistWithNodeStateUpdate(current, next);
        queueRuntimeEventJournal(current, next, persistedCandidates, "tabs.onRemoved");
      }, { reason: "tabs.onRemoved" });
    });
  });

  api.windows.onRemoved.addListener(async (windowId) => {
    await perfTrace.measureAsync("background.event.windows.onRemoved", { windowId }, async () => {
      if (fullSizeOutlinerWindowIds.delete(windowId)) {
        return;
      }
      if (runtimeFacts.recordNativeWindowRemoved(windowId) !== "close-window") {
        return;
      }

      await enqueueMutation(async () => {
        const current = await ensureState();
        const liveTabIds = liveTabIdsInWindow(current, windowId);
        const closedByOutliner = runtimeFacts.isOutlinerClosingWindow(windowId) ||
          runtimeFacts.isOutlinerClosedWindow(windowId);
        await applyNativeWindowClose(current, windowId, liveTabIds, {
          closedByOutliner,
          eventName: "windows.onRemoved"
        });
      }, { reason: "windows.onRemoved" });
    });
  });

  api.windows.onFocusChanged.addListener(async (windowId) => {
    await perfTrace.measureAsync("background.event.windows.onFocusChanged", { windowId }, async () => {
      if (await shouldIgnoreSidebarWindowFocus(windowId)) {
        return;
      }
      if (runtimeFacts.recordNativeWindowFocused(windowId).action === "applyFastPath") {
        await handleCommandWindowFocusChanged(windowId);
        return;
      }
      await queueRuntimeRefresh([], { closeMissing: false, focusWindowId: windowId });
    });
  });

  api.windows.onBoundsChanged?.addListener(async (windowInfo) => {
    await perfTrace.measureAsync("background.event.windows.onBoundsChanged", { windowId: windowInfo.id }, async () => {
      if (fullSizeOutlinerWindowIds.has(windowInfo.id)) {
        return;
      }
      seedRuntimeWindowProvenanceFromCurrentState(windowInfo.id);
      runtimeFacts.recordNativeWindowBoundsChanged(windowInfo);
    });
  });

  api.sessions.onChanged.addListener(async () => {
    await perfTrace.measureAsync("background.event.sessions.onChanged", async () => {
      runtimeFacts.recordNativeSessionChanged();
      pendingSessionChangedCount += 1;
      if (sessionChangedQueued) {
        return;
      }
      sessionChangedQueued = true;
      await enqueueMutation(async () => {
        const pausedSaveSchedule = pausePendingSaveTimers();
        try {
          while (pendingSessionChangedCount > 0) {
            const observedSessionChangedCount = pendingSessionChangedCount;
            pendingSessionChangedCount = 0;
            if (runtimeFacts.consumeOutlinerCloseSessionEcho().action === "applyFastPath") {
              pendingSessionChangedCount += Math.max(0, observedSessionChangedCount - 1);
              continue;
            }
            const reconciled = await reconcileMissingLiveTabsInOpenWindows();
            if (reconciled) {
              for (const entry of reconciled.runtimeLifecycleJournalEntries ?? []) {
                markRuntimeLifecycleJournalEntryForClearAfterSave(entry);
              }
              const persistedCandidates = await persistWithNodeStateUpdate(reconciled.previous, reconciled.next);
              queueRuntimeEventJournal(reconciled.previous, reconciled.next, persistedCandidates, "sessions.onChanged");
            }
          }
        } finally {
          sessionChangedQueued = false;
          resumePendingSaveTimers(pausedSaveSchedule);
        }
      }, { reason: "sessions.onChanged" });
    });
  });

  async function handleMessage(message: unknown): Promise<unknown> {
    if (!performanceTracePreferenceLoaded) {
      await performanceTracePreferenceReady;
    }

    if (isSidebarPerformanceTraceCollectedMessage(message)) {
      return handleSidebarPerformanceTraceCollected(message);
    }

    if (isPerformanceTraceMessage(message)) {
      return handlePerformanceTraceMessage(message);
    }

    return perfTrace.measureAsync("background.runtime.message", { type: messageType(message) }, () =>
      handleNonTraceMessage(message)
    );
  }

  type CommandFinalizeContext = {
    message: BackgroundCommand;
    current: OutlineState;
    next: OutlineState;
    saveSchedule: SaveSchedule;
    runtimeIndexCandidateNodeIds: NodeId[] | undefined;
    deletePatchNodeIds: NodeId[] | undefined;
    expandAncestorNodeIds: NodeId[] | undefined;
    restorePatchNodeIds: NodeId[] | undefined;
    recordedHistoryEntryId: string | undefined;
  };

  type CommandFinalizer = (ctx: CommandFinalizeContext) => Promise<void>;

  // Command durability that the user must not wait on. By the time a finalizer reaches the
  // journal append, the in-memory mutation is done and the tree patch is already broadcast, so
  // every sidebar reflects the change. The only thing left is the outline-journal append -- a
  // single storage.local.set whose cost scales with TOTAL stored data on Firefox (~0.7s on a
  // 25k-node store), plus any spill-fallback save. Running those off the ack path drops that
  // ~0.7s from the command's user-visible latency.
  //
  // Ordering and atomicity are preserved, NOT weakened: appendCommandJournal/...ForKnownNodeIds
  // build their delta (cloning the affected nodes) and drain the queued event-journal items
  // synchronously, and the journal's own opQueue (outline-journal.ts) serializes the actual
  // storage write in call order. So `run` MUST be invoked synchronously -- that initiates the
  // append (enqueues it on opQueue with a snapshot-correct delta) before the ack; only its await
  // is deferred. The in-flight promise is tracked so flushPendingSaves() and idle waits drain it
  // deterministically and a crash/suspend cannot silently drop a write that was never started.
  //
  // Crash safety (no worse than today): the tree patch is broadcast before the write today too,
  // so the "UI shows it, disk does not yet" window already exists -- this only lets the ack land
  // inside that same window. scheduleStateSave runs before each append, so the snapshot save is
  // the durability backstop (I-1 Class B) if the deferred append is interrupted or re-spills.
  const inFlightCommandDurability = new Set<Promise<void>>();
  function deferCommandDurability(run: () => Promise<void>): void {
    const settled = run()
      .catch((error) => {
        // The ack has already resolved, so this can no longer reject the command. The state
        // save scheduled before the append is the backstop, so just record the failure.
        perfTrace.mark("background.command.durability.error", { message: errorText(error) });
      })
      .finally(() => {
        inFlightCommandDurability.delete(settled);
      });
    inFlightCommandDurability.add(settled);
  }
  async function waitForCommandDurabilityIdle(): Promise<void> {
    while (inFlightCommandDurability.size > 0) {
      await Promise.all([...inFlightCommandDurability]);
    }
  }
  // Public flush also drains deferred command durability so callers that flush before reading
  // storage see a fully settled journal + snapshot. The scheduled snapshot save is flushed FIRST
  // (its storage.set is issued synchronously, preserving the "ack does not wait on persistence"
  // timing that callers observe), then the deferred journal appends -- plus any spill-fallback
  // save they trigger -- are drained, re-flushing once if a spill rescheduled a save. Internal
  // callers keep using flushPendingSaves directly to avoid awaiting their own deferred work.
  async function flushPendingSavesIncludingCommandDurability(): Promise<void> {
    await flushPendingSaves();
    await waitForCommandDurabilityIdle();
    if (hasPendingOrInFlightSave()) {
      await flushPendingSaves();
    }
  }

  // Per-command post-processing for the mutating-command hub. After runCommand succeeds and the
  // state transition is installed, each command type chooses how to broadcast, persist, journal,
  // and (on a journal skip) flush. These finalizers hold that per-command knowledge so the hub
  // body stays uniform; the hub still calls commitCommandAck() once after the finalizer returns.
  // They are behaviour-preserving extractions of the former per-message.type dispatch branches.
  const finalizeKnownNodeStateJournal = async (
    ctx: CommandFinalizeContext,
    nodeIds: readonly NodeId[]
  ): Promise<void> => {
    await persistKnownNodeStateUpdates(ctx.current, ctx.next, nodeIds);
    deferCommandDurability(async () => {
      await appendCommandJournalForKnownNodeIds(ctx.next, nodeIds, ctx.message.type, ctx.recordedHistoryEntryId);
    });
  };

  const finalizeBestEffort: CommandFinalizer = async ({
    message,
    current,
    next,
    saveSchedule,
    runtimeIndexCandidateNodeIds,
    recordedHistoryEntryId
  }) => {
    await persistWithBestEffortPatch(current, next, { saveSchedule });
    // A bounded structural relocation/flatten (moveNodeToNewWindow, flattenSubtree) reaches
    // this fallback but still creates command-window runtime provenance that must survive a
    // restart before the deferred snapshot lands (I-1) -- journal it before the ack like the
    // other structural blocks. Broad commands without candidate ids (importTree) have no
    // cheap bounded delta here and stay deferred to slice 2's coalescer.
    deferCommandDurability(async () => {
      if (!(runtimeIndexCandidateNodeIds && await appendCommandJournal(current, next, runtimeIndexCandidateNodeIds, message.type, "command", recordedHistoryEntryId))) {
        await flushRuntimeProvenanceSaveIfChanged(current, next, runtimeIndexCandidateNodeIds, {
          allowDeferredPlacementCheckpoint: isStructuralCommand(message.type),
          reason: message.type
        });
      }
    });
  };

  const finalizeStructuralTreePatch: CommandFinalizer = async ({
    message,
    current,
    next,
    saveSchedule,
    runtimeIndexCandidateNodeIds,
    recordedHistoryEntryId
  }) => {
    const update = perfTrace.measure("background.patch.build.treeStructure", { command: message.type }, () =>
      runtimeIndexCandidateNodeIds
        ? treeStructureUpdateFromCandidateNodeIds(current, next, runtimeIndexCandidateNodeIds)
        : treeStructureUpdateFromStateChange(current, next)
    );
    await broadcastTreeStructureUpdate(update);
    scheduleStateSave(next, saveSchedule, runtimeIndexCandidateNodeIds);
    deferCommandDurability(async () => {
      if (!(await appendCommandJournal(current, next, runtimeIndexCandidateNodeIds, message.type, "command", recordedHistoryEntryId))) {
        await flushRuntimeProvenanceSaveIfChanged(current, next, runtimeIndexCandidateNodeIds, {
          allowDeferredPlacementCheckpoint: true,
          reason: message.type
        });
      }
    });
  };

  const finalizeRestoreNode: CommandFinalizer = async ({
    message,
    current,
    next,
    saveSchedule,
    restorePatchNodeIds
  }) => {
    if (message.type !== "restoreNode") {
      return;
    }
    const restoreTreePatchNodeIds = restoreTreeStructureCandidateNodeIdsForClosedParentSubgroupRestore(
      current,
      next,
      restorePatchNodeIds ?? [message.nodeId]
    );
    if (restoreTreePatchNodeIds) {
      const update = perfTrace.measure("background.patch.build.treeStructure", { command: message.type }, () =>
        treeStructureUpdateFromCandidateNodeIds(current, next, restoreTreePatchNodeIds, {
          includeUnchanged: true
        })
      );
      await broadcastTreeStructureUpdate(update);
      scheduleStateSave(next, saveSchedule, candidateNodeIdsForPatch(update));
    } else {
      await persistWithNodeStateUpdate(current, next, restorePatchNodeIds, { saveSchedule });
    }
    deferCommandDurability(async () => {
      if (!(await appendCommandJournal(current, next, restoreTreePatchNodeIds ?? restorePatchNodeIds, message.type))) {
        await flushRuntimeProvenanceSaveIfChanged(current, next, restoreTreePatchNodeIds);
      }
    });
  };

  const finalizeDeleteNode: CommandFinalizer = async ({
    message,
    current,
    next,
    saveSchedule,
    deletePatchNodeIds,
    recordedHistoryEntryId
  }) => {
    if (message.type !== "deleteNode") {
      return;
    }
    const update = perfTrace.measure("background.patch.build.treeStructure", { command: message.type }, () =>
      treeStructureUpdateFromCandidateNodeIds(current, next, deletePatchNodeIds ?? [message.nodeId])
    );
    await broadcastTreeStructureUpdate(update);
    scheduleStateSave(next, saveSchedule, deletePatchNodeIds ?? [message.nodeId]);
    deferCommandDurability(async () => {
      if (!(await appendCommandJournal(current, next, deletePatchNodeIds ?? [message.nodeId], message.type, "command", recordedHistoryEntryId))) {
        await flushRuntimeTruthSaveIfNeeded(current, next, deletePatchNodeIds ?? [message.nodeId]);
      }
    });
  };

  const finalizeRenameGroup: CommandFinalizer = async ({
    message,
    current,
    next,
    recordedHistoryEntryId
  }) => {
    if (message.type !== "renameGroup") {
      return;
    }
    await persistKnownNodeStateUpdate(current, next, message.nodeId);
    deferCommandDurability(async () => {
      await appendCommandJournal(current, next, [message.nodeId], message.type, "command", recordedHistoryEntryId);
    });
  };

  const finalizeToggleCollapsed: CommandFinalizer = async (ctx) => {
    if (ctx.message.type !== "toggleCollapsed") {
      return;
    }
    await finalizeKnownNodeStateJournal(ctx, [ctx.message.nodeId]);
  };

  const finalizeExpandAncestors: CommandFinalizer = async (ctx) => {
    await finalizeKnownNodeStateJournal(ctx, ctx.expandAncestorNodeIds ?? []);
  };

  const finalizeMoveNode: CommandFinalizer = async (ctx) => {
    const { message, current, next, saveSchedule, runtimeIndexCandidateNodeIds, recordedHistoryEntryId } = ctx;
    if (message.type !== "moveNode") {
      await finalizeBestEffort(ctx);
      return;
    }
    const sameParentReorder = sameParentReorderUpdateForMoveCommand(current, next, message);
    if (sameParentReorder) {
      await broadcastSameParentReorderUpdate(sameParentReorder);
      scheduleStateSave(next, saveSchedule, [sameParentReorder.parentId, sameParentReorder.movedNodeId]);
      deferCommandDurability(async () => {
        if (!(await appendCommandJournal(current, next, [sameParentReorder.parentId, sameParentReorder.movedNodeId], message.type, "command", recordedHistoryEntryId))) {
          await flushRuntimeProvenanceSaveIfChanged(current, next, [sameParentReorder.parentId, sameParentReorder.movedNodeId], {
            allowDeferredPlacementCheckpoint: true,
            reason: message.type
          });
        }
      });
      return;
    }
    if (runtimeIndexCandidateNodeIds) {
      await finalizeStructuralTreePatch(ctx);
      return;
    }
    await finalizeBestEffort(ctx);
  };

  const commandFinalizers: Partial<Record<BackgroundCommand["type"], CommandFinalizer>> = {
    restoreNode: finalizeRestoreNode,
    deleteNode: finalizeDeleteNode,
    wrapNodeInGroup: finalizeStructuralTreePatch,
    moveSubtreeToTopLevel: finalizeStructuralTreePatch,
    moveSubtreeToBottomTopLevel: finalizeStructuralTreePatch,
    promoteChildren: finalizeStructuralTreePatch,
    renameGroup: finalizeRenameGroup,
    toggleCollapsed: finalizeToggleCollapsed,
    expandAncestors: finalizeExpandAncestors,
    moveNode: finalizeMoveNode
  };

  async function handleNonTraceMessage(message: unknown): Promise<unknown> {
    if (isSidebarNonEditInteractionMessage(message)) {
      sidebarBroadcaster.post({ type: "sidebarNonEditInteraction" });
      return { ok: true };
    }

    if (isDiagnosticsRequest(message)) {
      return getDiagnosticsCoalesced();
    }

    if (isIncidentLogRequest(message)) {
      return loadIncidentLog(api);
    }

    if (isInitialTreeSnapshotMessage(message)) {
      const snapshot = await initialTreeSnapshot();
      scheduleHistoryWarmup();
      return snapshot;
    }

    if (isInitialTreeSnapshotWindowMessage(message)) {
      const snapshot = await initialTreeSnapshotWindow(message);
      scheduleHistoryWarmup();
      return snapshot;
    }

    if (isOpenSidebarWindowMessage(message)) {
      return openSidebarWindow();
    }

    if (isExportTreeMessage(message)) {
      return exportPortableTreeFromBackground();
    }

    if (!isBackgroundCommand(message)) {
      return undefined;
    }

    if (message.type === "getHistoryStatus") {
      return historyStatusMessage(await ensureHistory());
    }

    if (message.type === "analyzeRestoreScope") {
      return analyzeRestoreScope(await ensureState(), message.nodeId);
    }

    if (message.type === "undo" || message.type === "redo") {
      return enqueueMutation(() => applyHistoryCommand(message.type), { reason: "history", command: message.type });
    }

    if (message.type === "refresh") {
      return commandAck(await refreshFromRuntime());
    }

    if (message.type === "getState") {
      await waitForHighPrioritySchedulerIdle();
      return ensureState();
    }

    return enqueueMutation(async () => {
      const current = await ensureState();
      const expandAncestorNodeIds = message.type === "expandAncestors"
        ? collapsedAncestorNodeIds(current, message.nodeId)
        : undefined;
      const historyPrevious = isTrackableHistoryCommandType(message.type)
        ? message.type === "toggleCollapsed"
          ? stateWithClonedNode(current, message.nodeId)
          : message.type === "expandAncestors"
            ? stateWithClonedNodes(current, expandAncestorNodeIds ?? [])
          : current
        : undefined;
      const outlinerClosePlan = message.type === "closeNode"
        ? planCloseNodeRuntimeClose(current, message.nodeId)
        : undefined;
      const focusTarget = message.type === "focusNode"
        ? focusTargetForNode(current, message.nodeId)
        : undefined;
      const deleteClosePlan = message.type === "deleteNode"
        ? planLiveSubtreeClose(current, message.nodeId)
        : undefined;
      const deleteTouchesRemovedRuntimeScope = message.type === "deleteNode"
        ? runtimeFacts.nodeTouchesRemovedRuntimeScope(current, message.nodeId)
        : false;
      const restorePatchNodeIds = message.type === "restoreNode"
        ? restorePatchCandidateNodeIds(current, message.nodeId, runtimeIndexForState(current))
        : undefined;
      const restoreCreateRecovery = message.type === "restoreNode"
        ? await createRestoreCreateRecoveryContext()
        : undefined;
      let runtimeLifecycleJournalEntry = runtimeLifecycleJournalEntryForCommand(
        message,
        current,
        {
          outlinerClosePlan,
          deleteClosePlan,
          journalEmptyDelete: deleteTouchesRemovedRuntimeScope,
          restoreCreateRecovery
        }
      );
      if (runtimeLifecycleJournalEntry && runtimeLifecycleJournalEntryNeedsDurableBase(runtimeLifecycleJournalEntry)) {
        await ensureDurableRuntimeLifecycleBase();
      }
      if (runtimeLifecycleJournalEntry && runtimeLifecycleJournalEntry.kind !== "restoreNode") {
        await appendRuntimeLifecycleJournalEntry(api, runtimeLifecycleJournalEntry);
        if (runtimeLifecycleJournalEntry.kind === "closeNode") {
          pendingOutlinerCloseJournalEntries.set(runtimeLifecycleJournalEntry.id, {
            plan: runtimeLifecycleJournalEntry.plan,
            completedTabIds: new Set(),
            completedWindowIds: new Set()
          });
        }
      }
      const commandTransaction = runtimeFacts.beginCommandTransactionForCommand(message.type, {
        outlinerClosePlan,
        deleteClosePlan,
        focusTarget
      });
      // Shared success tail for every mutating-command branch: commit the ledger
      // transaction, mark the lifecycle journal entry (no-op when undefined) for
      // clearing after the next save, and ack. Reads runtimeLifecycleJournalEntry
      // at call time because the restore observer can replace it mid-command.
      const commitCommandAck = (): ReturnType<typeof commandAck> => {
        if (commandTransaction) {
          runtimeFacts.commitCommand(commandTransaction.id);
        }
        markRuntimeLifecycleJournalEntryForClearAfterSave(runtimeLifecycleJournalEntry);
        return commandAck(true);
      };
      if (outlinerClosePlan) {
        runtimeFacts.markOutlinerClosePlan(outlinerClosePlan);
      }
      if (focusTarget) {
        runtimeFacts.markCommandFocusTarget(
          focusTarget.tabId,
          focusTarget.windowId,
          focusTarget.tabActive,
          focusTarget.windowActive
        );
      }
      if (deleteClosePlan) {
        runtimeFacts.markDeleteClosePlan(deleteClosePlan);
      }

      let result: Awaited<ReturnType<typeof runCommand>>;
      try {
        if (message.type === "toggleCollapsed" || message.type === "expandAncestors") {
          detachPersistedStateBaselineForMutation();
        }
        result = await perfTrace.measureAsync("background.command.run", { command: message.type }, () =>
          runCommand(current, adapter, message, restoreCreateRecovery
            ? {
                restoreObserver: {
                  recordCreateAttempt: async (attempt) => {
                    restoreCreateRecovery.attempts.push(attempt);
                    if (runtimeLifecycleJournalEntry?.kind === "restoreNode") {
                      runtimeLifecycleJournalEntry = {
                        ...runtimeLifecycleJournalEntry,
                        attempts: [...restoreCreateRecovery.attempts]
                      };
                      await replaceRuntimeLifecycleJournalEntry(api, runtimeLifecycleJournalEntry);
                    }
                  }
                }
              }
            : {})
        );
        if (commandTransaction) {
          runtimeFacts.recordCommandObserved(commandTransaction.id);
        }
      } catch (error) {
        const recoveredRestore = message.type === "restoreNode" && restoreCreateRecovery
          ? await recoverRestoreCreateSideEffect(current, restoreCreateRecovery)
          : undefined;
        const recoveredRelocation = !recoveredRestore && runtimeCommandRelocatesLiveTabs(message.type)
          ? await recoverCommandRelocationCreateSideEffect(current, message)
          : undefined;
        const recoveredOutlinerClose = !recoveredRestore &&
          !recoveredRelocation &&
          message.type === "closeNode" &&
          outlinerClosePlan
          ? await recoverOutlinerCloseSideEffect(current, outlinerClosePlan)
          : undefined;
        const recovered = recoveredRestore ?? recoveredRelocation ?? recoveredOutlinerClose;
        if (recovered && recovered !== current) {
          if (commandTransaction) {
            runtimeFacts.recordCommandObserved(commandTransaction.id);
          }
          result = {
            state: recovered,
            changed: true
          };
        } else {
          if (
            message.type === "deleteNode" &&
            deleteClosePlan &&
            await runtimeClosePlanCompleted(deleteClosePlan)
          ) {
            runtimeFacts.recordCompletedClosePlanTombstones(deleteClosePlan);
            const recovered = deleteOutlineNode(current, message.nodeId, { allowLive: true });
            if (recovered !== current) {
              const runtimeIndexCandidateNodeIds = runtimeIndexCandidateNodeIdsForCommand(message, current, recovered);
              const deletePatchNodeIds = deleteTreeStructureCandidateNodeIds(current, recovered, message.nodeId);
              const saveSchedule = saveScheduleForCommand(message.type);
              installStateTransition(current, recovered, { candidateNodeIds: runtimeIndexCandidateNodeIds });
              let recoveredDeleteHistoryEntryId: string | undefined;
              if (historyPrevious && isTrackableHistoryCommandType(message.type)) {
                recoveredDeleteHistoryEntryId = await recordHistoryEntry(message.type, historyPrevious, recovered, {
                  candidateNodeIds: deletePatchNodeIds,
                  saveSchedule
                });
              }
              const update = perfTrace.measure("background.patch.build.treeStructure", { command: message.type }, () =>
                treeStructureUpdateFromCandidateNodeIds(current, recovered, deletePatchNodeIds)
              );
              await broadcastTreeStructureUpdate(update);
              scheduleStateSave(recovered, saveSchedule, deletePatchNodeIds);
              // The lifecycle deleteNode entry replays this state change after a crash, but
              // the history entry above is only durable via the journal record (I-1 parity
              // with the non-recovered delete path). Deferred off the ack like the other
              // delete path; scheduleStateSave above is the backstop.
              deferCommandDurability(async () => {
                await appendCommandJournal(current, recovered, deletePatchNodeIds, message.type, "command", recoveredDeleteHistoryEntryId);
              });
              return commitCommandAck();
            }
          }
          if (outlinerClosePlan) {
            runtimeFacts.clearOutlinerClosePlan(outlinerClosePlan);
          }
          if (deleteClosePlan) {
            runtimeFacts.clearDeleteClosePlan(deleteClosePlan);
          }
          if (focusTarget) {
            runtimeFacts.clearCommandFocusTarget(focusTarget.tabId, focusTarget.windowId);
          }
          if (commandTransaction) {
            runtimeFacts.rejectCommand(commandTransaction.id);
          }
          await clearRuntimeLifecycleJournalEntryNow(runtimeLifecycleJournalEntry);
          throw error;
        }
      }
      if (!result.changed) {
        if (commandTransaction) {
          runtimeFacts.commitCommand(commandTransaction.id);
        }
        return commandAck(false);
      }

      const runtimeIndexCandidateNodeIds = runtimeIndexCandidateNodeIdsForCommand(
        message,
        current,
        result.state,
        {
          ...(expandAncestorNodeIds ? { expandAncestorNodeIds } : {}),
          ...(restorePatchNodeIds ? { restorePatchNodeIds } : {})
        }
      );
      const runtimeWindowsForCommandInstall = message.type === "restoreNode"
        ? await getNormalWindows(api).catch(() => undefined)
        : undefined;
      const outlineSyncedRuntimeWindowIds = commandRunsFullBrowserOrderSync(message, current)
        ? liveWindowNodes(result.state).map((node) => node.live.windowId)
        : undefined;
      if (
        message.type === "closeNode" &&
        outlinerClosePlan &&
        await runtimeClosePlanCompleted(outlinerClosePlan)
      ) {
        runtimeFacts.recordCompletedOutlinerClosePlan(outlinerClosePlan);
      }
      runtimeFacts.clearRemovalTombstonesForLiveState(result.state, runtimeIndexCandidateNodeIds);
      if (runtimeCommandRelocatesLiveTabs(message.type)) {
        runtimeFacts.recordCommandRelocatedTabs(current, result.state, runtimeIndexCandidateNodeIds);
      }
      if (message.type === "restoreNode") {
        runtimeFacts.recordCommandRestoredTabs(current, result.state, runtimeIndexCandidateNodeIds);
      }
      installStateTransition(current, result.state, {
        candidateNodeIds: runtimeIndexCandidateNodeIds,
        ...(runtimeWindowsForCommandInstall ? { runtimeWindows: runtimeWindowsForCommandInstall } : {}),
        ...(outlineSyncedRuntimeWindowIds ? { outlineSyncedRuntimeWindowIds } : {})
      });
      if (runtimeCommandRelocatesLiveTabs(message.type)) {
        absorbCommandOwnedFocusRefresh(current, result.state, runtimeIndexCandidateNodeIds);
      }
      const saveSchedule = saveScheduleForCommand(message.type);
      const deletePatchNodeIds = message.type === "deleteNode"
        ? deleteTreeStructureCandidateNodeIds(current, result.state, message.nodeId)
        : undefined;
      let recordedHistoryEntryId: string | undefined;
      if (historyPrevious && isTrackableHistoryCommandType(message.type)) {
        const candidateNodeIds = message.type === "expandAncestors"
          ? expandAncestorNodeIds
          : message.type === "deleteNode"
            ? deletePatchNodeIds
            : historyCandidateNodeIds(message, historyPrevious, result.state) ?? runtimeIndexCandidateNodeIds;
        recordedHistoryEntryId = await recordHistoryEntry(message.type, historyPrevious, result.state, {
          ...(candidateNodeIds ? { candidateNodeIds } : {}),
          saveSchedule
        });
      }
      const finalize = commandFinalizers[message.type] ?? finalizeBestEffort;
      await finalize({
        message,
        current,
        next: result.state,
        saveSchedule,
        runtimeIndexCandidateNodeIds,
        deletePatchNodeIds,
        expandAncestorNodeIds,
        restorePatchNodeIds,
        recordedHistoryEntryId
      });
      return commitCommandAck();
    }, { reason: "command", command: message.type });
  }

  async function runtimeClosePlanCompleted(plan: RuntimeClosePlan): Promise<boolean> {
    if (plan.windowIds.length === 0 && plan.tabIds.length === 0) {
      return true;
    }

    const windows = await getNormalWindows(api).catch(() => undefined);
    return windows ? runtimeClosePlanCompletedInWindows(plan, windows) : false;
  }

  function runtimeLifecycleJournalEntryForCommand(
    command: BackgroundCommand,
    current: OutlineState,
    input: {
      outlinerClosePlan?: RuntimeClosePlan | undefined;
      deleteClosePlan?: RuntimeClosePlan | undefined;
      journalEmptyDelete?: boolean | undefined;
      restoreCreateRecovery?: RestoreCreateRecoveryContext | undefined;
    }
  ): RuntimeLifecycleJournalEntry | undefined {
    if (command.type === "closeNode" && input.outlinerClosePlan && !runtimeClosePlanIsEmpty(input.outlinerClosePlan)) {
      return {
        ...runtimeLifecycleJournalEntryBase("closeNode"),
        nodeId: command.nodeId,
        plan: input.outlinerClosePlan
      };
    }

    if (
      command.type === "deleteNode" &&
      input.deleteClosePlan &&
      (!runtimeClosePlanIsEmpty(input.deleteClosePlan) || input.journalEmptyDelete === true)
    ) {
      return {
        ...runtimeLifecycleJournalEntryBase("deleteNode"),
        nodeId: command.nodeId,
        plan: input.deleteClosePlan
      };
    }

    if (command.type === "restoreNode" && input.restoreCreateRecovery?.before) {
      return {
        ...runtimeLifecycleJournalEntryBase("restoreNode"),
        nodeId: command.nodeId,
        before: {
          tabIds: [...input.restoreCreateRecovery.before.tabIds],
          windowIds: [...input.restoreCreateRecovery.before.windowIds]
        },
        attempts: []
      };
    }

    const relocation = relocationCreateRecoveryDetails(current, command);
    if (relocation) {
      return {
        ...runtimeLifecycleJournalEntryBase("relocation"),
        commandType: command.type as Extract<RuntimeLifecycleJournalEntry, { kind: "relocation" }>["commandType"],
        nodeId: relocation.nodeId,
        tabId: relocation.tabId,
        sourceWindowId: relocation.sourceWindowId,
        ...(typeof relocation.rootIndex === "number" ? { rootIndex: relocation.rootIndex } : {})
      };
    }

    return undefined;
  }

  function runtimeLifecycleJournalEntryForHistory(
    direction: "undo" | "redo",
    entry: HistoryEntry,
    poppedHistory: HistoryState,
    delta: OutlineDelta
  ): RuntimeLifecycleJournalEntry {
    return {
      ...runtimeLifecycleJournalEntryBase("history"),
      direction,
      entry,
      poppedHistory,
      delta
    };
  }

  function runtimeLifecycleJournalEntryForNativeWindowClose(
    current: OutlineState,
    windowId: number,
    liveTabIds: readonly number[],
    sessionId?: string
  ): NativeWindowCloseJournalEntry | undefined {
    if (!liveWindowNodeByRuntimeId(current, windowId)) {
      return undefined;
    }

    return {
      ...runtimeLifecycleJournalEntryBase("nativeWindowClose"),
      windowId,
      plan: {
        windowIds: [windowId],
        tabIds: [...liveTabIds]
      },
      ...(sessionId ? { sessionId } : {})
    };
  }

  function runtimeLifecycleJournalEntryForNativeTabClose(
    current: OutlineState,
    tabId: number,
    windowId?: number
  ): NativeTabCloseJournalEntry | undefined {
    const liveTab = Object.values(current.nodes).find(
      (node) => isLiveTabNode(node) && node.live.tabId === tabId
    );
    if (!liveTab) {
      return undefined;
    }

    return {
      ...runtimeLifecycleJournalEntryBase("nativeTabClose"),
      tabId,
      ...(typeof windowId === "number" ? { windowId } : {}),
      plan: {
        tabIds: [tabId],
        windowIds: []
      }
    };
  }

  function historyDeltaMayHaveRuntimeLifecycleEffects(current: OutlineState, delta: OutlineDelta): boolean {
    for (const nodeId of delta.deletedNodeIds) {
      if (isLiveRuntimeNode(current.nodes[nodeId])) {
        return true;
      }
    }
    for (const node of delta.updatedNodes) {
      const previous = current.nodes[node.id];
      if (!previous && isLiveRuntimeNode(node)) {
        return true;
      }
      if (previous && previous.status !== "live" && isLiveRuntimeNode(node)) {
        return true;
      }
      if (runtimeLiveBindingChanged(previous, node)) {
        return true;
      }
    }
    return false;
  }

  function runtimeLiveBindingChanged(previous: OutlineNode | undefined, next: OutlineNode): boolean {
    if (isLiveTabNode(previous) && isLiveTabNode(next)) {
      return previous.live.tabId !== next.live.tabId || previous.live.windowId !== next.live.windowId;
    }
    if (isLiveWindowNode(previous) && isLiveWindowNode(next)) {
      return previous.live.windowId !== next.live.windowId;
    }
    return false;
  }

  function runtimeLifecycleJournalEntryBase<TKind extends RuntimeLifecycleJournalEntry["kind"]>(
    kind: TKind
  ): Pick<Extract<RuntimeLifecycleJournalEntry, { kind: TKind }>, "version" | "id" | "createdAt" | "kind"> {
    return {
      version: 1,
      id: `runtime-lifecycle:${now()}:${nextRuntimeLifecycleJournalSequence++}`,
      createdAt: now(),
      kind
    } as Pick<Extract<RuntimeLifecycleJournalEntry, { kind: TKind }>, "version" | "id" | "createdAt" | "kind">;
  }

  function runtimeClosePlanIsEmpty(plan: RuntimeClosePlan): boolean {
    return plan.tabIds.length === 0 && plan.windowIds.length === 0;
  }

  async function ensureDurableRuntimeLifecycleBase(): Promise<void> {
    if (!hasPendingOrInFlightSave()) {
      return;
    }
    await flushPendingSaves();
  }

  function runtimeLifecycleJournalEntryNeedsDurableBase(entry: RuntimeLifecycleJournalEntry): boolean {
    return entry.kind !== "relocation";
  }

  async function appendObservedNativeTabCloseJournalEntry(entry: NativeTabCloseJournalEntry): Promise<void> {
    // Native tab-close side effects already happened; replay by runtime id is enough to recover against the
    // last persisted state when that tab is already live there, so avoid flushing unrelated pending saves.
    if (!lastPersistedState || !liveTabNodeByRuntimeId(lastPersistedState, entry.tabId)) {
      await ensureDurableRuntimeLifecycleBase();
    }
    await appendRuntimeLifecycleJournalEntry(api, entry);
  }

  function markRuntimeLifecycleJournalEntryForClearAfterSave(entry: RuntimeLifecycleJournalEntry | undefined): void {
    if (!entry) {
      return;
    }
    pendingOutlinerCloseJournalEntries.delete(entry.id);
    runtimeLifecycleJournalEntryIdsToClearAfterSave.add(entry.id);
  }

  async function clearRuntimeLifecycleJournalEntryNow(entry: RuntimeLifecycleJournalEntry | undefined): Promise<void> {
    if (!entry) {
      return;
    }
    pendingOutlinerCloseJournalEntries.delete(entry.id);
    runtimeLifecycleJournalEntryIdsToClearAfterSave.delete(entry.id);
    await clearRuntimeLifecycleJournalEntries(api, [entry.id]);
  }

  function markCompletedOutlinerCloseJournalEntriesForClearAfterSave(completed: RuntimeClosePlan): void {
    if (pendingOutlinerCloseJournalEntries.size === 0) {
      return;
    }
    for (const [entryId, pending] of [...pendingOutlinerCloseJournalEntries.entries()]) {
      for (const tabId of completed.tabIds) {
        pending.completedTabIds.add(tabId);
      }
      for (const windowId of completed.windowIds) {
        pending.completedWindowIds.add(windowId);
      }
      if (
        pending.plan.tabIds.every((tabId) => pending.completedTabIds.has(tabId)) &&
        pending.plan.windowIds.every((windowId) => pending.completedWindowIds.has(windowId))
      ) {
        pendingOutlinerCloseJournalEntries.delete(entryId);
        runtimeLifecycleJournalEntryIdsToClearAfterSave.add(entryId);
      }
    }
  }

  async function recoverOutlinerCloseSideEffect(
    current: OutlineState,
    plan: RuntimeClosePlan
  ): Promise<OutlineState | undefined> {
    if (!(await runtimeClosePlanCompleted(plan))) {
      return undefined;
    }

    runtimeFacts.recordCompletedOutlinerClosePlan(plan);
    const recent = await mostRecentClosedSession();
    let next = current;
    for (const windowId of plan.windowIds) {
      next = closeWindow(next, windowId, {
        now: now(),
        ...(recent?.window?.sessionId ? { sessionId: recent.window.sessionId } : {}),
        closedBy: "outliner"
      });
    }
    for (const tabId of plan.tabIds) {
      next = closeTab(next, tabId, {
        now: now(),
        ...(recent?.tab?.sessionId ? { sessionId: recent.tab.sessionId } : {}),
        closedBy: "outliner"
      });
    }

    return next === current ? undefined : next;
  }

  async function createRestoreCreateRecoveryContext(): Promise<RestoreCreateRecoveryContext> {
    const windows = await getNormalWindowsIncludingTabs(api, []).catch(() => undefined);
    return {
      attempts: [],
      before: windows ? runtimeResourceIdsForWindows(windows) : undefined
    };
  }

  async function recoverRestoreCreateSideEffect(
    current: OutlineState,
    recovery: RestoreCreateRecoveryContext
  ): Promise<OutlineState | undefined> {
    if (!recovery.before || recovery.attempts.length === 0) {
      return undefined;
    }

    const windows = await getNormalWindowsIncludingTabs(api, []).catch(() => undefined);
    if (!windows) {
      return undefined;
    }

    const restoredNodes = restoredNodesFromRestoreCreateSideEffects(current, recovery.attempts, recovery.before, windows);
    if (restoredNodes.length === 0) {
      return undefined;
    }

    const next = restoreNodes(current, restoredNodes);
    return next === current ? undefined : next;
  }

  function runtimeResourceIdsForWindows(windows: RuntimeWindow[]): RuntimeResourceIds {
    return {
      windowIds: new Set(windows.map((windowInfo) => windowInfo.id)),
      tabIds: new Set(windows.flatMap((windowInfo) => windowInfo.tabs ?? []).map((tab) => tab.id))
    };
  }

  function restoredNodesFromRestoreCreateSideEffects(
    state: OutlineState,
    attempts: readonly RestoreCreateAttempt[],
    before: RuntimeResourceIds,
    windows: RuntimeWindow[]
  ): RestoredNode[] {
    const restoredNodes: RestoredNode[] = [];
    const restoredNodeIds = new Set<NodeId>();
    const usedTabIds = new Set<number>();
    const usedWindowIds = new Set<number>();

    for (const attempt of attempts) {
      if (attempt.kind === "tab") {
        const tab = recoverCreatedTabForAttempt(attempt, before, windows, usedTabIds);
        if (!tab || state.nodes[attempt.nodeId]?.status !== "closed" || restoredNodeIds.has(attempt.nodeId)) {
          continue;
        }
        usedTabIds.add(tab.id);
        restoredNodeIds.add(attempt.nodeId);
        restoredNodes.push(restoredNodeFromRuntimeTab(attempt.nodeId, tab));
        continue;
      }

      const windowInfo = recoverCreatedWindowForAttempt(attempt, before, windows, usedWindowIds);
      if (!windowInfo) {
        continue;
      }
      usedWindowIds.add(windowInfo.id);
      if (state.nodes[attempt.windowNodeId]?.status === "closed" && !restoredNodeIds.has(attempt.windowNodeId)) {
        restoredNodeIds.add(attempt.windowNodeId);
        restoredNodes.push({
          nodeId: attempt.windowNodeId,
          windowId: windowInfo.id,
          active: windowInfo.focused
        });
      }

      const availableTabs = [...(windowInfo.tabs ?? [])];
      for (const [index, tabNodeId] of attempt.tabNodeIds.entries()) {
        if (state.nodes[tabNodeId]?.status !== "closed" || restoredNodeIds.has(tabNodeId)) {
          continue;
        }
        const tab = takeMatchingRestoredWindowTab(availableTabs, {
          ...(typeof attempt.createData.tabId === "number" ? { tabId: attempt.createData.tabId } : {}),
          ...(attempt.urls?.[index] ? { url: attempt.urls[index] } : {}),
          usedTabIds
        });
        if (!tab) {
          continue;
        }
        usedTabIds.add(tab.id);
        restoredNodeIds.add(tabNodeId);
        restoredNodes.push(restoredNodeFromRuntimeTab(tabNodeId, tab));
      }
    }

    return restoredNodes;
  }

  function recoverCreatedTabForAttempt(
    attempt: Extract<RestoreCreateAttempt, { kind: "tab" }>,
    before: RuntimeResourceIds,
    windows: RuntimeWindow[],
    usedTabIds: ReadonlySet<number>
  ): RuntimeTab | undefined {
    const tabs = windows
      .flatMap((windowInfo) => windowInfo.tabs ?? [])
      .filter((tab) => !before.tabIds.has(tab.id) && !usedTabIds.has(tab.id));
    const expectedWindowId = attempt.createProperties.windowId;
    const expectedUrl = attempt.createProperties.url;
    return tabs.find((tab) =>
      (typeof expectedWindowId !== "number" || tab.windowId === expectedWindowId) &&
      (!expectedUrl || tab.url === expectedUrl)
    ) ?? tabs.find((tab) => !expectedUrl || tab.url === expectedUrl);
  }

  function recoverCreatedWindowForAttempt(
    attempt: Extract<RestoreCreateAttempt, { kind: "window" }>,
    before: RuntimeResourceIds,
    windows: RuntimeWindow[],
    usedWindowIds: ReadonlySet<number>
  ): RuntimeWindow | undefined {
    const candidates = windows.filter((windowInfo) => !before.windowIds.has(windowInfo.id) && !usedWindowIds.has(windowInfo.id));
    if (typeof attempt.createData.tabId === "number") {
      return candidates.find((windowInfo) => (windowInfo.tabs ?? []).some((tab) => tab.id === attempt.createData.tabId));
    }
    if (attempt.urls && attempt.urls.length > 0) {
      return candidates.find((windowInfo) => runtimeWindowHasUrls(windowInfo, attempt.urls ?? [])) ?? candidates[0];
    }
    return candidates[0];
  }

  function runtimeWindowHasUrls(windowInfo: RuntimeWindow, urls: readonly string[]): boolean {
    const remainingTabs = [...(windowInfo.tabs ?? [])];
    for (const url of urls) {
      const index = remainingTabs.findIndex((tab) => tab.url === url);
      if (index < 0) {
        return false;
      }
      remainingTabs.splice(index, 1);
    }
    return true;
  }

  function takeMatchingRestoredWindowTab(
    tabs: RuntimeTab[],
    input: { tabId?: number; url?: string; usedTabIds: ReadonlySet<number> }
  ): RuntimeTab | undefined {
    const index = tabs.findIndex((tab) =>
      !input.usedTabIds.has(tab.id) &&
      (typeof input.tabId !== "number" || tab.id === input.tabId) &&
      (!input.url || tab.url === input.url)
    );
    const fallbackIndex = index >= 0
      ? index
      : tabs.findIndex((tab) => !input.usedTabIds.has(tab.id) && (!input.url || tab.url === input.url));
    if (fallbackIndex < 0) {
      return undefined;
    }
    const [tab] = tabs.splice(fallbackIndex, 1);
    return tab;
  }

  function restoredNodeFromRuntimeTab(nodeId: NodeId, tab: RuntimeTab): RestoredNode {
    return {
      nodeId,
      windowId: tab.windowId,
      tabId: tab.id,
      active: tab.active,
      ...(tab.url ? { url: tab.url } : {}),
      ...(tab.title ? { title: tab.title } : {}),
      ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {})
    };
  }

  async function recoverCommandRelocationCreateSideEffect(
    current: OutlineState,
    command: BackgroundCommand
  ): Promise<OutlineState | undefined> {
    const details = relocationCreateRecoveryDetails(current, command);
    if (!details) {
      return undefined;
    }

    let windows = await getNormalWindows(api).catch(() => undefined);
    let createdWindow = windows?.find((windowInfo) =>
      windowInfo.id !== details.sourceWindowId &&
      windowInfo.tabs?.some((tab) => tab.id === details.tabId)
    );
    if (!createdWindow) {
      return undefined;
    }

    const remainingTabIds = liveTabNodesInSubtree(current, details.nodeId)
      .map((node) => node.live.tabId)
      .filter((tabId) => tabId !== details.tabId);
    if (remainingTabIds.length > 0) {
      await adapter.moveTabs(remainingTabIds, { windowId: createdWindow.id, index: 1 });
      windows = await getNormalWindows(api).catch(() => windows);
      createdWindow = windows?.find((windowInfo) =>
        windowInfo.id === createdWindow?.id &&
        windowInfo.tabs?.some((tab) => tab.id === details.tabId)
      ) ?? createdWindow;
    }

    const nowValue = now();
    const next = details.kind === "wrap"
      ? wrapNodeInGroup(current, details.nodeId, { now: nowValue, liveWindow: createdWindow })
      : details.kind === "topLevel"
        ? moveSubtreeToTopLevel(current, details.nodeId, { now: nowValue, liveWindow: createdWindow })
        : details.kind === "bottomTopLevel"
          ? moveSubtreeToBottomTopLevel(current, details.nodeId, { now: nowValue, liveWindow: createdWindow })
        : moveTabToNewLiveWindow(current, details.nodeId, createdWindow, {
            now: nowValue,
            ...(typeof details.rootIndex === "number" ? { rootIndex: details.rootIndex } : {})
          });
    if (next !== current) {
      await syncBrowserOrder(next, adapter);
    }
    return next;
  }

  function relocationCreateRecoveryDetails(
    current: OutlineState,
    command: BackgroundCommand
  ): { kind: "newWindow" | "wrap" | "topLevel" | "bottomTopLevel"; nodeId: NodeId; tabId: number; sourceWindowId: number; rootIndex?: number } | undefined {
    if (command.type === "moveNode" && command.parentId) {
      return undefined;
    }
    if (
      command.type !== "moveNode" &&
      command.type !== "moveNodeToNewWindow" &&
      command.type !== "wrapNodeInGroup" &&
      command.type !== "moveSubtreeToTopLevel" &&
      command.type !== "moveSubtreeToBottomTopLevel"
    ) {
      return undefined;
    }

    const node = current.nodes[command.nodeId];
    if (!node || !isLiveTabNode(node)) {
      return undefined;
    }

    return {
      kind: command.type === "wrapNodeInGroup"
        ? "wrap"
        : command.type === "moveSubtreeToTopLevel"
          ? "topLevel"
          : command.type === "moveSubtreeToBottomTopLevel"
            ? "bottomTopLevel"
          : "newWindow",
      nodeId: command.nodeId,
      tabId: node.live.tabId,
      sourceWindowId: node.live.windowId,
      ...((command.type === "moveNode" || command.type === "moveNodeToNewWindow") && typeof command.index === "number"
        ? { rootIndex: command.index }
        : {})
    };
  }

  async function ensureState(): Promise<OutlineState> {
    return stateCache.get();
  }

  async function initializeExtensionLifecycle(): Promise<void> {
    await ensureState();
    scheduleHistoryWarmup();
    await configureAutomaticBackups({ runIfDue: true });
  }

  async function configureAutomaticBackups(options: { runIfDue?: boolean; runImmediately?: boolean } = {}): Promise<void> {
    const activePreferences = await ensurePreferences();
    if (!activePreferences.automaticBackups.enabled) {
      await api.alarms.clear(AUTOMATIC_BACKUP_ALARM_NAME).catch(() => false);
      return;
    }

    let status = await loadAutomaticBackupStatus(api).catch(() => ({}));
    if (options.runImmediately || (options.runIfDue && automaticBackupDue(status, now()))) {
      status = await runAutomaticBackup();
    }
    scheduleAutomaticBackupAlarm(status);
  }

  function scheduleAutomaticBackupAlarm(status: AutomaticBackupStatus): void {
    api.alarms.create(AUTOMATIC_BACKUP_ALARM_NAME, {
      when: nextAutomaticBackupTime(status, now()),
      periodInMinutes: AUTOMATIC_BACKUP_INTERVAL_MINUTES
    });
  }

  async function handleAutomaticBackupAlarm(): Promise<void> {
    const activePreferences = await ensurePreferences();
    if (!activePreferences.automaticBackups.enabled) {
      await api.alarms.clear(AUTOMATIC_BACKUP_ALARM_NAME).catch(() => false);
      return;
    }

    const status = await runAutomaticBackup();
    scheduleAutomaticBackupAlarm(status);
  }

  async function runAutomaticBackup(): Promise<AutomaticBackupStatus> {
    automaticBackupInFlight ??= perfTrace.measureAsync("background.backup.export", async () => {
      const attemptedAtMs = now();
      const attemptedAt = new Date(attemptedAtMs).toISOString();
      const previousStatus = await loadAutomaticBackupStatus(api).catch(() => ({}));
      await recordIncidentLog("automaticBackupStart", { attemptedAt });
      try {
        await waitForSchedulerIdle();
        await downloadAutomaticBackup(await ensureState(), api, attemptedAtMs);
        const nextStatus: AutomaticBackupStatus = {
          ...previousStatus,
          lastAttemptedBackupAt: attemptedAt,
          lastSuccessfulBackupAt: attemptedAt
        };
        delete nextStatus.lastError;
        await saveAutomaticBackupStatus(nextStatus, api);
        await recordIncidentLog("automaticBackupSuccess", { attemptedAt });
        return nextStatus;
      } catch (error) {
        const nextStatus: AutomaticBackupStatus = {
          ...previousStatus,
          lastAttemptedBackupAt: attemptedAt,
          lastError: backupErrorText(error)
        };
        await saveAutomaticBackupStatus(nextStatus, api);
        await recordIncidentLog("automaticBackupFailure", {
          attemptedAt,
          error: backupErrorText(error)
        });
        return nextStatus;
      }
    }).finally(() => {
      automaticBackupInFlight = undefined;
    });
    return automaticBackupInFlight;
  }

  async function openSidebarWindow(): Promise<{ ok: true }> {
    sidebarWindowCreationInFlight += 1;
    try {
      const windowInfo = await perfTrace.measureAsync("background.sidebarWindow.open", () =>
        api.windows.create({
          url: api.runtime.getURL(SIDEBAR_WINDOW_PATH),
          type: "popup",
          state: "maximized",
          focused: true
        })
      );
      fullSizeOutlinerWindowIds.add(windowInfo.id);
      return { ok: true };
    } finally {
      sidebarWindowCreationInFlight = Math.max(0, sidebarWindowCreationInFlight - 1);
    }
  }

  async function exportPortableTreeFromBackground(): Promise<ExportTreeResponse> {
    await waitForHighPrioritySchedulerIdle();
    const exportedAtMs = now();
    const payload = exportPortableTree(await ensureState(), { now: exportedAtMs });
    return {
      type: "exportTree",
      filename: portableTreeFilename(new Date(exportedAtMs)),
      contentType: "application/json",
      content: serializePortableTreeFile(payload)
    };
  }

  async function shouldIgnoreSidebarWindowFocus(windowId: number): Promise<boolean> {
    if (fullSizeOutlinerWindowIds.has(windowId)) {
      return true;
    }
    if (sidebarWindowCreationInFlight === 0 || windowId === api.windows.WINDOW_ID_NONE) {
      return false;
    }
    return !(await getNormalWindow(api, windowId));
  }

  async function initialTreeSnapshot(): Promise<InitialTreeSnapshot | undefined> {
    if (state) {
      return initialTreeSnapshotFromFullState(state, false);
    }

    // Coalesce concurrent boot-snapshot reads: many sidebars boot at once (one per open window)
    // and all hit this branch while the full state is still loading, so without sharing they each
    // read the same ~MB snapshot key, serialized on the single background thread. The read is a
    // pure storage.local.get + clone and its result is structure-cloned again per sendMessage
    // recipient, so handing the same in-flight result to every caller is safe.
    initialTreeSnapshotLoadInFlight ??= perfTrace.measureAsync("background.state.initialSnapshot.load", () =>
      loadInitialTreeSnapshot(api)
    ).finally(() => {
      initialTreeSnapshotLoadInFlight = undefined;
    });
    const snapshot = await initialTreeSnapshotLoadInFlight;
    if (snapshot) {
      return snapshot;
    }

    return undefined;
  }

  function initialTreeSnapshotFromFullState(source: OutlineState, hydrating: boolean): InitialTreeSnapshot {
    const snapshot = initialTreeSnapshotForState(source, { hydrating });
    snapshot.hydrating = initialTreeSnapshotNeedsFullHydration(snapshot);
    return snapshot;
  }

  async function initialTreeSnapshotWindow(
    message: InitialTreeSnapshotWindowMessage
  ): Promise<InitialTreeSnapshot> {
    const source = state ?? await ensureState();
    const requestedRowLimit = typeof message.rowLimit === "number" && Number.isFinite(message.rowLimit)
      ? Math.floor(message.rowLimit)
      : INITIAL_TREE_SNAPSHOT_ROW_LIMIT;
    const rowLimit = Math.max(1, Math.min(INITIAL_TREE_SNAPSHOT_ROW_LIMIT, requestedRowLimit));
    const snapshot = perfTrace.measure("background.projection.slice", {
      search: typeof message.query === "string" && message.query.trim().length > 0,
      rowLimit,
      centerRowIndex: Math.floor(message.centerRowIndex),
      targetNode: Boolean(message.targetNodeId)
    }, () =>
      initialTreeSnapshotProjector.snapshotForState(source, {
        rowLimit,
        centerRowIndex: message.centerRowIndex,
        ...(message.targetNodeId !== undefined ? { targetNodeId: message.targetNodeId } : {}),
        ...(message.query !== undefined ? { query: message.query } : {}),
        hydrating: true
      })
    );
    snapshot.hydrating = initialTreeSnapshotNeedsFullHydration(snapshot);
    return snapshot;
  }

  function initialTreeSnapshotNeedsFullHydration(snapshot: InitialTreeSnapshot): boolean {
    return snapshot.projection.totalRowCount > snapshot.projection.rows.length ||
      Object.keys(snapshot.state.nodes).length < snapshot.projection.nodeCount;
  }

  async function ensureHistory(): Promise<HistoryState> {
    const activePreferences = await ensurePreferences();
    if (historyState) {
      return historyState;
    }

    historyLoadInFlight ??= loadHistory(api, activePreferences.undoHistoryLimit)
      .then((loaded) => normalizeHistoryState(loaded, activePreferences.undoHistoryLimit))
      .finally(() => {
        historyLoadInFlight = undefined;
      });
    historyState = await historyLoadInFlight;
    return historyState;
  }

  function warmHistoryCache(): void {
    if (historyState || historyLoadInFlight) {
      return;
    }
    void ensureHistory().catch((error) => {
      perfTrace.mark("background.history.warm.error", { message: errorText(error) });
    });
  }

  function scheduleHistoryWarmup(): void {
    if (historyState || historyLoadInFlight || typeof historyWarmupTimer === "number") {
      return;
    }

    historyWarmupTimer = globalThis.setTimeout(() => {
      historyWarmupTimer = undefined;
      warmHistoryCache();
    }, 0);
  }

  async function ensurePreferences(): Promise<AppPreferences> {
    preferences ??= await loadAppPreferences(api);
    return preferences;
  }

  async function initializeState(): Promise<OutlineState> {
    const [windows, v4Loaded, lifecycleJournal, startupKeys] = await Promise.all([
      perfTrace.measureAsync("background.runtime.getWindows", () => getNormalWindows(api)),
      perfTrace.measureAsync("background.state.load", () => loadStateV4(api)),
      loadRuntimeLifecycleJournal(api),
      api.storage.local.get([
        JOURNAL_META_KEY,
        STATE_V3_MANIFEST_KEY,
        STATE_V2_MANIFEST_KEY,
        STATE_KEY,
        STATE_V4_MIGRATION_BACKUP_META_KEY
      ])
    ]);
    const legacyKeysPresent = Boolean(
      startupKeys[STATE_V3_MANIFEST_KEY] || startupKeys[STATE_V2_MANIFEST_KEY] || startupKeys[STATE_KEY]
    );
    const migrationBackupExportedAt = readMigrationBackupExportedAt(startupKeys[STATE_V4_MIGRATION_BACKUP_META_KEY]);
    let loaded: LoadedOutlineState | undefined;
    if (v4Loaded) {
      adoptLoadedV4Snapshot(
        v4Loaded.manifest,
        v4Loaded.slot,
        v4Loaded.fallbackManifest && v4Loaded.fallbackSlot
          ? { manifest: v4Loaded.fallbackManifest, slot: v4Loaded.fallbackSlot }
          : undefined
      );
      scheduleOrphanShardSweep();
      loaded = {
        state: v4Loaded.state,
        format: "v4",
        journalSeqIncluded: v4Loaded.journalSeqIncluded,
        // Anything below a clean R0 load must be folded into a fresh snapshot generation.
        ...(v4Loaded.recovery !== "r0" || v4Loaded.repair ? { requiresFullSave: true } : {})
      };
      if (v4Loaded.recovery !== "r0" || v4Loaded.repair) {
        await recordIncidentLog("v4LoadRecovery", {
          recovery: v4Loaded.recovery,
          ...(v4Loaded.repair ?? {})
        });
      }
      if (legacyKeysPresent) {
        if (migrationBackupExportedAt !== undefined) {
          // A completed migration (evidenced by the backup meta) died before deleting the
          // legacy keys; finish the cleanup off-path.
          void deleteLegacyStateKeys().catch((error) => {
            perfTrace.mark("background.state.migration.cleanup.error", { message: errorText(error) });
          });
        } else {
          // A v4 store exists without migration evidence: it was written by saves during a
          // degraded-load session whose migration was deferred. Keep the legacy keys as the
          // recovery resource they are and surface the stuck state.
          await recordIncidentLog("legacyKeysRetainedWithoutMigrationEvidence", {
            ...outlineStateCountDetail(v4Loaded.state)
          });
        }
      }
      if (
        migrationBackupExportedAt !== undefined &&
        now() - migrationBackupExportedAt > MIGRATION_BACKUP_TTL_MS &&
        !legacyKeysPresent
      ) {
        // The post-migration safety copy has served its soak window; reclaim the quota.
        void api.storage.local.remove([STATE_V4_MIGRATION_BACKUP_KEY, STATE_V4_MIGRATION_BACKUP_META_KEY])
          .catch((error) => {
            perfTrace.mark("background.state.migration.backup.expire.error", { message: errorText(error) });
          });
      }
    } else {
      loaded = await perfTrace.measureAsync("background.state.load.legacy", () =>
        loadStateWithMetadata(api, stateLoadTraceOptions())
      );
    }
    // Construct the journal with a fresh epoch (prior + 1) and replay any acked deltas that
    // the loaded snapshot does not yet reflect (crash between journal append and compaction).
    const priorEpoch = readJournalEpoch(startupKeys[JOURNAL_META_KEY]);
    const journalInit = await createAndInitJournal(priorEpoch + 1);
    const loadedState = loaded?.state;
    const journalReplayEntries = loadedState
      ? journalInit.entries.filter((entry) => entry.seq > (loaded?.journalSeqIncluded ?? 0))
      : [];
    const journalReplayed = journalReplayEntries.length > 0;
    // A load below clean R0 (recovery/repair) or one needing journal replay must fold into a fresh
    // full snapshot so the next startup does not re-replay (and journalSeqIncluded advances past the
    // replayed entries). A clean r0 v4 load can persist the startup reconciliation incrementally.
    const loadedRequiresFullSave = loaded?.requiresFullSave === true || journalReplayed;
    // Shards materially changed by startup reconciliation vs the loaded v4 baseline. The first save
    // writes only these instead of a full O(total-store) rewrite (~32s on a 25k-node store): a clean
    // v4 load already seeds currentV4Snapshot, so an incremental compaction is valid, and clean
    // shards keep their stored value (same contract every post-startup save uses). Undefined keeps
    // the full path for non-v4 or recovery/replay loads (their baseline diverges from on-disk).
    const startupSaveCandidateNodeIds = (current: OutlineState): readonly NodeId[] | undefined =>
      loaded?.format === "v4" && !loadedRequiresFullSave && loadedState
        ? changedNodeIdsSinceBaseline(loadedState, current)
        : undefined;
    let stored = loadedState;
    if (journalReplayed && journalReplayEntries.some(journalEntryAffectsHistory)) {
      // Replayed entries include history-tracked commands (or undo/redo moves) whose
      // history save may not have landed before the crash: rebuild the undo entries from
      // the journal fold so an acked command stays undoable across the restart.
      const activePreferences = await ensurePreferences();
      const historyReplayResult = replayJournalWithHistory(loadedState!, journalReplayEntries, {
        history: await ensureHistory(),
        limit: activePreferences.undoHistoryLimit
      });
      stored = historyReplayResult.state;
      if (historyReplayResult.historyChanged) {
        historyState = historyReplayResult.history;
        scheduleHistorySave(historyState);
      }
    } else if (journalReplayed) {
      stored = replayJournal(loadedState!, journalReplayEntries);
    }
    if (journalReplayed) {
      await recordIncidentLog("journalReplay", {
        entryCount: journalReplayEntries.length,
        throughSeq: journalInit.headSeq,
        ...(journalInit.truncatedAtSeq !== undefined ? { truncatedAtSeq: journalInit.truncatedAtSeq } : {})
      });
      // A spill marker past the snapshot's journalSeqIncluded means a broad change was too
      // heavy to journal and its compaction never landed: the loaded state may be missing
      // it (bounded by the tightened post-spill save schedule). Surface that honestly.
      const spillGaps = journalReplayEntries.filter((entry) => entry.spill);
      if (spillGaps.length > 0) {
        await recordIncidentLog("journalSpillGap", {
          markerCount: spillGaps.length,
          labels: spillGaps.map((entry) => entry.label ?? "unknown").join(",")
        });
      }
    }
    if (loaded?.salvaged) {
      await recordIncidentLog("v3LoadSalvaged", { ...(loaded.repair ?? {}) });
    }
    if (!v4Loaded && stored) {
      if (loaded?.salvaged) {
        // Never migrate (and never delete legacy keys) off a degraded read: a transient
        // storage fault that produced an empty or partial salvage must stay recoverable on
        // a later startup with the legacy store intact. The session runs on the salvaged
        // state; migration retries on the next clean load.
        await recordIncidentLog("v4MigrationDeferredDegradedLoad", {
          salvaged: true,
          ...outlineStateCountDetail(stored)
        });
      } else {
        // First startup on the v4 store: migrate the legacy (journal-replayed) state.
        // Failure keeps the legacy keys authoritative and retries next startup.
        await migrateLegacyStateToV4(stored);
      }
    }
    let storedRuntimeMatch: RuntimeSnapshotMatch | undefined;
    let consumedRuntimeLifecycleJournalEntryIds: string[] = [];
    let runtimeLifecycleJournalChangedState = false;
    let runtimeLifecycleJournalChangedHistory = false;
    let completedOutlinerClosePlans: RuntimeClosePlan[] = [];
    let completedDeleteClosePlans: RuntimeClosePlan[] = [];
    if (stored) {
      const lifecycleRecoveryHistory = lifecycleJournal.entries.some((entry) => entry.kind === "history")
        ? historyState ?? await loadHistory(api)
        : undefined;
      const lifecycleRecovery = lifecycleJournal.entries.length > 0
        ? recoverRuntimeLifecycleJournal(repairState(stored), windows, lifecycleJournal, lifecycleRecoveryHistory)
        : {
            state: stored,
            changed: false,
            changedHistory: false,
            consumedEntryIds: [],
            completedOutlinerClosePlans: [],
            completedDeleteClosePlans: []
          };
      consumedRuntimeLifecycleJournalEntryIds = lifecycleRecovery.consumedEntryIds;
      runtimeLifecycleJournalChangedState = lifecycleRecovery.changed;
      runtimeLifecycleJournalChangedHistory = lifecycleRecovery.changedHistory;
      completedOutlinerClosePlans = lifecycleRecovery.completedOutlinerClosePlans;
      completedDeleteClosePlans = lifecycleRecovery.completedDeleteClosePlans;
      if (lifecycleJournal.entries.length > 0) {
        await recordIncidentLog("lifecycleJournalRecovery", {
          entryCount: lifecycleJournal.entries.length,
          entryKinds: lifecycleJournal.entries.map((entry) => entry.kind).join(","),
          consumedCount: lifecycleRecovery.consumedEntryIds.length,
          changedState: lifecycleRecovery.changed,
          changedHistory: lifecycleRecovery.changedHistory
        });
      }
      if (lifecycleRecovery.history) {
        historyState = lifecycleRecovery.history;
      }
      const startupBase = lifecycleRecovery.state;
      storedRuntimeMatch = runtimeSnapshotMateriallyMatchesState(startupBase, windows);
      if (storedRuntimeMatch.matches) {
        if (!runtimeLifecycleJournalChangedState && !loadedRequiresFullSave) {
          deferPersistedStateBaselineClone(startupBase);
        } else {
          lastPersistedState = undefined;
        }
        state = startupBase;
        if (runtimeLifecycleJournalChangedState || !statesMateriallyEqual(stored, state) || loadedRequiresFullSave) {
          scheduleStateSave(state, "normal", startupSaveCandidateNodeIds(state));
        }
      } else {
        lastPersistedState = !loadedRequiresFullSave
          ? cloneOutlineState(stored)
          : undefined;
        runtimeFacts.reconstructFromState(startupBase, windows);
        alignKnownRuntimeWindowProvenance(startupBase);
        const reconciled = reconcileRuntimeTruth(startupBase, windows, { respectRuntimeTabOrder: true });
        alignKnownRuntimeWindowProvenance(reconciled);
        const guarded = preserveClosedSubtreesForRuntimeTransition(startupBase, reconciled, { source: "startup" });
        state = statesEqualIgnoringUpdatedAt(startupBase, guarded.state) ? startupBase : guarded.state;
        if (!statesMateriallyEqual(stored, state) || loadedRequiresFullSave) {
          scheduleStateSave(state, "normal", startupSaveCandidateNodeIds(state));
        }
      }
    } else {
      // Nothing loadable. Bootstrapping from windows is only safe on a genuinely fresh
      // profile; if any stored outline keys exist, the bootstrap would overwrite them, so
      // record an incident rather than letting that happen silently.
      const storedKeys = await api.storage.local.get([STATE_V3_MANIFEST_KEY, STATE_V2_MANIFEST_KEY, STATE_KEY]);
      if (storedKeys[STATE_V3_MANIFEST_KEY] || storedKeys[STATE_V2_MANIFEST_KEY] || storedKeys[STATE_KEY]) {
        await recordIncidentLog("bootstrapSkippedStoredDataPresent", {
          hasV3Manifest: Boolean(storedKeys[STATE_V3_MANIFEST_KEY]),
          hasV2Manifest: Boolean(storedKeys[STATE_V2_MANIFEST_KEY]),
          hasV1State: Boolean(storedKeys[STATE_KEY])
        });
      }
      state = bootstrapFromWindows(windows, { now: now() });
      // A journal with no loadable snapshot is a crash before the first save, not a fresh
      // profile: the bootstrap reconstructs structure from the runtime snapshot but cannot
      // tell a command-created, restored, or browser-created window from a saved one. The
      // outline journal durably recorded those creations, so replay its provenance onto the
      // bootstrap rather than silently downgrading every window to "saved" (RT-252).
      const bootstrapProvenance = recoverWindowProvenanceFromJournal(state, windows, journalInit.entries);
      if (bootstrapProvenance.changed) {
        state = bootstrapProvenance.state;
        await recordIncidentLog("bootstrapProvenanceRecovered", {
          journalEntryCount: journalInit.entries.length,
          ...outlineStateCountDetail(state)
        });
      }
      scheduleStateSave(state);
    }
    const prunedStartupState = pruneMissingEmptyCommandRuntimeWindows(state, windows);
    if (prunedStartupState !== state) {
      state = prunedStartupState;
      runtimeLifecycleJournalChangedState = true;
      lastPersistedState = undefined;
      scheduleStateSave(state, "normal", startupSaveCandidateNodeIds(state));
    }
    if (consumedRuntimeLifecycleJournalEntryIds.length > 0) {
      if (
        runtimeLifecycleJournalChangedState ||
        runtimeLifecycleJournalChangedHistory ||
        (stored && !statesMateriallyEqual(stored, state))
      ) {
        for (const entryId of consumedRuntimeLifecycleJournalEntryIds) {
          runtimeLifecycleJournalEntryIdsToClearAfterSave.add(entryId);
        }
      } else {
        void clearRuntimeLifecycleJournalEntries(api, consumedRuntimeLifecycleJournalEntryIds).catch((error) => {
          perfTrace.mark("background.lifecycleJournal.clear.error", { message: errorText(error) });
        });
      }
    }
    if (runtimeLifecycleJournalChangedHistory && historyState) {
      scheduleHistorySave(historyState);
    }
    await recordIncidentLog("startupStateLoaded", {
      stored: Boolean(stored),
      format: loaded?.format ?? "none",
      requiresFullSave: loaded?.requiresFullSave === true,
      runtimeWindowCount: windows.length,
      journalEntryCount: lifecycleJournal.entries.length,
      ...outlineStateCountDetail(state)
    });
    runtimeIndex = storedRuntimeMatch?.matches && state === stored
      ? buildRuntimeStateIndexFromLookup(state, storedRuntimeMatch.lookup)
      : buildRuntimeStateIndex(state);
    runtimeFacts.reconstructFromState(
      state,
      windows,
      storedRuntimeMatch?.matches && state === stored ? storedRuntimeMatch.lookup.nodes : undefined
    );
    for (const plan of completedOutlinerClosePlans) {
      runtimeFacts.recordCompletedOutlinerClosePlan(plan);
    }
    for (const plan of completedDeleteClosePlans) {
      runtimeFacts.recordCompletedClosePlanTombstones(plan);
    }
    // Seed the diagnostics window snapshot from the startup query (which already ran here, fast, as
    // part of the load). Otherwise the first getDiagnostics poll issues its OWN browser
    // windows.getAll on the startup-critical path -- a call that costs several seconds under the load
    // of the startup request burst (profiled at ~6s, vs ~70ms for the same call run calm) and blocks
    // getState/hydration behind it. With the snapshot seeded, the first poll recomputes without a
    // fetch; runtime events clear+refresh it as before. (We deliberately do NOT also precompute
    // lastDiagnostics here -- that would add a second startup node-table traversal.)
    diagnosticsRuntimeWindows = windows;
    return state;
  }

  function recoverRuntimeLifecycleJournal(
    initialState: OutlineState,
    windows: RuntimeWindow[],
    journal: RuntimeLifecycleJournal,
    initialHistory?: HistoryState
  ): RuntimeLifecycleJournalRecovery {
    let recovered = initialState;
    let recoveredHistory = initialHistory;
    let changed = false;
    let changedHistory = false;
    const consumedEntryIds: string[] = [];
    const completedOutlinerClosePlans: RuntimeClosePlan[] = [];
    const completedDeleteClosePlans: RuntimeClosePlan[] = [];

    for (const entry of journal.entries) {
      const result = recoverRuntimeLifecycleJournalEntry(recovered, windows, entry, recoveredHistory);
      const next = result.state;
      consumedEntryIds.push(entry.id);
      if (result.completedOutlinerClosePlan) {
        completedOutlinerClosePlans.push(result.completedOutlinerClosePlan);
      }
      if (result.completedDeleteClosePlan) {
        completedDeleteClosePlans.push(result.completedDeleteClosePlan);
      }
      if (next !== recovered && !statesMateriallyEqual(recovered, next)) {
        recovered = next;
        changed = true;
      } else {
        recovered = next;
      }
      if (result.history && result.history !== recoveredHistory) {
        recoveredHistory = result.history;
        changedHistory = true;
      }
    }

    return {
      state: recovered,
      ...(recoveredHistory && changedHistory ? { history: recoveredHistory } : {}),
      changed,
      changedHistory,
      consumedEntryIds,
      completedOutlinerClosePlans,
      completedDeleteClosePlans
    };
  }

  function recoverRuntimeLifecycleJournalEntry(
    current: OutlineState,
    windows: RuntimeWindow[],
    entry: RuntimeLifecycleJournalEntry,
    history?: HistoryState
  ): RuntimeLifecycleJournalEntryRecovery {
    if (entry.kind === "closeNode") {
      if (!current.nodes[entry.nodeId] || current.nodes[entry.nodeId]?.status === "closed") {
        return {
          state: current,
          ...(runtimeClosePlanCompletedInWindows(entry.plan, windows) ? { completedOutlinerClosePlan: entry.plan } : {})
        };
      }
      const completed = runtimeClosePlanCompletedInWindows(entry.plan, windows);
      return {
        state: completed
          ? applyClosedRuntimeClosePlan(current, entry.plan)
          : current,
        ...(completed ? { completedOutlinerClosePlan: entry.plan } : {})
      };
    }

    if (entry.kind === "deleteNode") {
      if (!current.nodes[entry.nodeId]) {
        return {
          state: current,
          ...(runtimeClosePlanCompletedInWindows(entry.plan, windows) ? { completedDeleteClosePlan: entry.plan } : {})
        };
      }
      const completed = runtimeClosePlanCompletedInWindows(entry.plan, windows);
      return {
        state: completed
          ? deleteOutlineNode(current, entry.nodeId, { allowLive: true })
          : current,
        ...(completed ? { completedDeleteClosePlan: entry.plan } : {})
      };
    }

    if (entry.kind === "restoreNode") {
      if (current.nodes[entry.nodeId]?.status === "live") {
        return { state: current };
      }
      const before: RuntimeResourceIds = {
        tabIds: new Set(entry.before.tabIds),
        windowIds: new Set(entry.before.windowIds)
      };
      const restoredNodes = restoredNodesFromRestoreCreateSideEffects(current, entry.attempts, before, windows);
      return {
        state: restoredNodes.length > 0 ? restoreNodes(current, restoredNodes) : current
      };
    }

    if (entry.kind === "relocation") {
      return { state: recoverRelocationJournalEntry(current, windows, entry) };
    }

    if (entry.kind === "history") {
      return recoverHistoryJournalEntry(current, windows, entry, history);
    }

    if (entry.kind === "nativeTabClose") {
      const completed = runtimeClosePlanCompletedInWindows(entry.plan, windows);
      return {
        state: completed ? deleteLiveTabNodeByTabId(current, entry.tabId) : current,
        ...(completed ? { completedDeleteClosePlan: entry.plan } : {})
      };
    }

    if (entry.kind === "nativeWindowClose") {
      const completed = runtimeClosePlanCompletedInWindows(entry.plan, windows);
      return {
        state: completed
          ? closeWindow(current, entry.windowId, {
              now: now(),
              ...(entry.sessionId ? { sessionId: entry.sessionId } : {})
            })
          : current,
        ...(completed ? { completedOutlinerClosePlan: entry.plan } : {})
      };
    }

    return { state: current };
  }

  function runtimeClosePlanCompletedInWindows(plan: RuntimeClosePlan, windows: RuntimeWindow[]): boolean {
    const openWindowIds = new Set(windows.map((windowInfo) => windowInfo.id));
    if (plan.windowIds.some((windowId) => openWindowIds.has(windowId))) {
      return false;
    }

    const openTabIds = new Set(windows.flatMap((windowInfo) => windowInfo.tabs ?? []).map((tab) => tab.id));
    return plan.tabIds.every((tabId) => !openTabIds.has(tabId));
  }

  function applyClosedRuntimeClosePlan(current: OutlineState, plan: RuntimeClosePlan): OutlineState {
    let next = current;
    for (const windowId of plan.windowIds) {
      next = closeWindow(next, windowId, { now: now(), closedBy: "outliner" });
    }
    for (const tabId of plan.tabIds) {
      next = closeTab(next, tabId, { now: now(), closedBy: "outliner" });
    }
    return next;
  }

  // Re-establish live-window runtime provenance after a bootstrap that had no loadable
  // snapshot (a crash before the first save). The bootstrap reconstructs structure from the
  // runtime snapshot but cannot tell a command-created, restored, or browser-created window
  // from a plain saved one. The outline journal is the durable record of those creations, so
  // replay the latest provenance it holds for each still-live runtime window onto the
  // bootstrap. Provenance is sticky (set at creation, never cleared) and is not part of
  // `nodesMateriallyEqual`, so the change is reported explicitly here rather than via a diff.
  function recoverWindowProvenanceFromJournal(
    state: OutlineState,
    windows: RuntimeWindow[],
    journalEntries: readonly OutlineJournalEntry[]
  ): { state: OutlineState; changed: boolean } {
    const liveRuntimeWindowIds = new Set(windows.map((windowInfo) => windowInfo.id));
    const provenanceByRuntimeWindowId = new Map<number, RuntimeWindowProvenance>();
    const restoredByRuntimeWindowId = new Set<number>();
    for (const entry of journalEntries) {
      for (const node of entry.delta?.updatedNodes ?? []) {
        if (!isLiveWindowNode(node) || !liveRuntimeWindowIds.has(node.live.windowId)) {
          continue;
        }
        if (node.runtimeProvenance) {
          provenanceByRuntimeWindowId.set(node.live.windowId, node.runtimeProvenance);
        }
        if (node.restoredFromClosed === true) {
          restoredByRuntimeWindowId.add(node.live.windowId);
        }
      }
    }
    let next = state;
    let changed = false;
    for (const windowNode of liveWindowNodes(state)) {
      const provenance = provenanceByRuntimeWindowId.get(windowNode.live.windowId);
      const restored = restoredByRuntimeWindowId.has(windowNode.live.windowId);
      const needsProvenance = provenance && !windowNode.runtimeProvenance;
      const needsRestored = restored && windowNode.restoredFromClosed !== true;
      if (!needsProvenance && !needsRestored) {
        continue;
      }
      next = next === state ? cloneOutlineState(state) : next;
      next.nodes[windowNode.id] = {
        ...next.nodes[windowNode.id]!,
        ...(needsProvenance ? { runtimeProvenance: provenance } : {}),
        ...(needsRestored ? { restoredFromClosed: true } : {})
      };
      changed = true;
    }
    return { state: next, changed };
  }

  function recoverRelocationJournalEntry(
    current: OutlineState,
    windows: RuntimeWindow[],
    entry: Extract<RuntimeLifecycleJournalEntry, { kind: "relocation" }>
  ): OutlineState {
    const runtimeWindow = windows.find((windowInfo) =>
      windowInfo.id !== entry.sourceWindowId &&
      windowInfo.tabs?.some((tab) => tab.id === entry.tabId)
    );
    if (!runtimeWindow) {
      return current;
    }

    const node = current.nodes[entry.nodeId];
    if (!isLiveTabNode(node) || node.live.tabId !== entry.tabId || node.live.windowId === runtimeWindow.id) {
      return current;
    }

    if (entry.commandType === "wrapNodeInGroup") {
      return wrapNodeInGroup(current, entry.nodeId, { now: now(), liveWindow: runtimeWindow });
    }
    if (entry.commandType === "moveSubtreeToTopLevel") {
      return moveSubtreeToTopLevel(current, entry.nodeId, { now: now(), liveWindow: runtimeWindow });
    }
    if (entry.commandType === "moveSubtreeToBottomTopLevel") {
      return moveSubtreeToBottomTopLevel(current, entry.nodeId, { now: now(), liveWindow: runtimeWindow });
    }
    return moveTabToNewLiveWindow(current, entry.nodeId, runtimeWindow, {
      now: now(),
      ...(typeof entry.rootIndex === "number" ? { rootIndex: entry.rootIndex } : {})
    });
  }

  function recoverHistoryJournalEntry(
    current: OutlineState,
    windows: RuntimeWindow[],
    entry: Extract<RuntimeLifecycleJournalEntry, { kind: "history" }>,
    history: HistoryState | undefined
  ): { state: OutlineState; history?: HistoryState } {
    if (!history || !historyTopMatchesJournalEntry(history, entry)) {
      return { state: current };
    }
    let replayed = repairState(preserveClosedNodesDuringHistoryReplay(current, applyOutlineDelta(current, entry.delta)));
    replayed = remapHistoryReplayMaterializedWindowsFromSnapshot(replayed, windows);
    replayed = collapseSupersededHistoryReplayWindows(replayed, entry.delta, windows);
    if (historyReplayMayDropCurrentLiveRuntimeResources(current, replayed, entry.delta)) {
      replayed = preserveCurrentLiveRuntimeResourcesDuringHistoryReplay(current, replayed, entry.delta, windows);
      replayed = remapHistoryReplayMaterializedWindowsFromSnapshot(replayed, windows);
      replayed = collapseSupersededHistoryReplayWindows(replayed, entry.delta, windows);
    }
    if (entry.entry.commandType !== "deleteNode" && historyReplayNeedsCurrentRuntimeShapeOverlay(current, replayed, entry.delta)) {
      replayed = reconcileHistoryReplayResultWithRuntimeSnapshot(replayed, windows, {
        closeMissing: true,
        respectRuntimeTabOrder: false
      });
      if (historyReplayMayDropCurrentLiveRuntimeResources(current, replayed, entry.delta)) {
        replayed = preserveCurrentLiveRuntimeResourcesDuringHistoryReplay(current, replayed, entry.delta, windows);
      }
    }
    replayed = guardHistoryReplayRuntimeLifecycle(current, replayed, entry.entry.commandType);
    let reconciled = reconcileHistoryReplayResultWithRuntimeSnapshot(replayed, windows, {
      closeMissing: true,
      respectRuntimeTabOrder: false
    });
    if (entry.entry.commandType !== "deleteNode" && historyReplayMayDropCurrentLiveRuntimeResources(current, reconciled, entry.delta)) {
      const preserved = preserveCurrentLiveRuntimeResourcesDuringHistoryReplay(current, reconciled, entry.delta, windows);
      reconciled = reconcileHistoryReplayResultWithRuntimeSnapshot(preserved, windows, {
        closeMissing: true,
        respectRuntimeTabOrder: false
      });
    }
    reconciled = deleteSupersededHistoryReplayWindows(current, reconciled, entry.delta, windows);
    if (statesMateriallyEqual(current, reconciled)) {
      return { state: current };
    }
    return {
      state: reconciled,
      history: historyAfterJournalReplay(history, entry)
    };
  }

  function remapHistoryReplayMaterializedWindowsFromSnapshot(
    next: OutlineState,
    windows: RuntimeWindow[]
  ): OutlineState {
    const runtimeWindowIds = new Set(windows.map((windowInfo) => windowInfo.id));
    const runtimeWindowIdByTabId = new Map<number, number>();
    for (const windowInfo of windows) {
      for (const tab of windowInfo.tabs ?? []) {
        runtimeWindowIdByTabId.set(tab.id, windowInfo.id);
      }
    }

    let remapped: OutlineState | undefined;
    const mutable = (): OutlineState => {
      remapped ??= cloneOutlineState(next);
      return remapped;
    };

    for (const windowNode of liveWindowNodes(next)) {
      if (runtimeWindowIds.has(windowNode.live.windowId)) {
        continue;
      }
      const tabNodes = liveTabNodesInSubtree(next, windowNode.id);
      if (tabNodes.length === 0) {
        continue;
      }
      const runtimeWindowIdsForTabs = new Set<number>();
      let allTabsPresent = true;
      for (const tabNode of tabNodes) {
        const runtimeWindowId = runtimeWindowIdByTabId.get(tabNode.live.tabId);
        if (typeof runtimeWindowId !== "number") {
          allTabsPresent = false;
          break;
        }
        runtimeWindowIdsForTabs.add(runtimeWindowId);
      }
      if (!allTabsPresent || runtimeWindowIdsForTabs.size !== 1) {
        continue;
      }
      const [runtimeWindowId] = [...runtimeWindowIdsForTabs];
      if (typeof runtimeWindowId !== "number") {
        continue;
      }
      const existingTargetWindow = liveWindowNodes(next)
        .find((candidate) => candidate.id !== windowNode.id && candidate.live.windowId === runtimeWindowId);
      if (existingTargetWindow) {
        const state = mutable();
        const staleWindow = state.nodes[windowNode.id];
        const childIds = staleWindow ? [...staleWindow.childIds] : [];
        for (const childId of childIds) {
          moveHistoryReplayNodeToParent(state, childId, existingTargetWindow.id);
          for (const tabNode of liveTabNodesInSubtree(state, childId)) {
            updateLiveTabRef(state, tabNode.id, tabNode.live.tabId, runtimeWindowId);
          }
        }
        deleteHistoryReplayContainerNode(state, windowNode.id);
        continue;
      }
      replaceLiveWindowIdInSubtree(mutable(), windowNode.id, runtimeWindowId);
    }

    return remapped ? repairState(remapped) : next;
  }

  function collapseSupersededHistoryReplayWindows(
    state: OutlineState,
    delta: OutlineDelta,
    windows: RuntimeWindow[]
  ): OutlineState {
    const runtimeWindowsById = new Map(windows.map((windowInfo) => [windowInfo.id, windowInfo]));
    let collapsed: OutlineState | undefined;
    const mutable = (): OutlineState => {
      collapsed ??= cloneOutlineState(state);
      return collapsed;
    };

    for (const deltaNode of delta.updatedNodes) {
      if (!isLiveWindowNode(deltaNode) || runtimeWindowsById.has(deltaNode.live.windowId)) {
        continue;
      }
      const node = state.nodes[deltaNode.id];
      if (!isLiveWindowNode(node) || !runtimeWindowsById.has(node.live.windowId) || !node.parentId) {
        continue;
      }
      const parent = state.nodes[node.parentId];
      if (!isLiveWindowNode(parent) || runtimeWindowsById.has(parent.live.windowId)) {
        continue;
      }
      const runtimeWindow = runtimeWindowsById.get(node.live.windowId);
      const runtimeTabIds = new Set((runtimeWindow?.tabs ?? []).map((tab) => tab.id));
      const tabNodes = liveTabNodesInSubtree(state, node.id);
      if (tabNodes.length === 0 || tabNodes.some((tabNode) => !runtimeTabIds.has(tabNode.live.tabId))) {
        continue;
      }

      const next = mutable();
      const nextNode = next.nodes[node.id];
      const nextParent = cloneNodeForHistoryMutation(next, parent.id);
      if (!isLiveWindowNode(nextNode) || !isLiveWindowNode(nextParent)) {
        continue;
      }
      nextParent.live = { windowId: nextNode.live.windowId };
      if (nextNode.runtimeProvenance === "commandCreated") {
        nextParent.runtimeProvenance = "commandCreated";
        runtimeFacts.recordCommandCreatedRuntimeWindow(nextNode.live.windowId);
      }
      for (const tabNode of liveTabNodesInSubtree(next, nextNode.id)) {
        updateLiveTabRef(next, tabNode.id, tabNode.live.tabId, nextNode.live.windowId);
      }
      deleteHistoryReplayTabNode(next, nextNode.id);
    }

    return collapsed ? repairState(collapsed) : state;
  }

  function deleteSupersededHistoryReplayWindows(
    current: OutlineState,
    state: OutlineState,
    delta: OutlineDelta,
    windows: RuntimeWindow[]
  ): OutlineState {
    const runtimeWindowIds = new Set(windows.map((windowInfo) => windowInfo.id));
    let cleaned: OutlineState | undefined;
    const mutable = (): OutlineState => {
      cleaned ??= cloneOutlineState(state);
      return cleaned;
    };

    for (const deltaNode of delta.updatedNodes) {
      if (!isLiveWindowNode(deltaNode) || runtimeWindowIds.has(deltaNode.live.windowId)) {
        continue;
      }
      if (current.nodes[deltaNode.id]?.status === "closed") {
        continue;
      }
      const node = state.nodes[deltaNode.id];
      if (!node || node.kind !== "window" || liveTabNodesInSubtree(state, node.id).length > 0) {
        continue;
      }
      deleteHistoryReplaySubtree(mutable(), node.id);
    }

    return cleaned ? repairState(cleaned) : state;
  }

  function historyTopMatchesJournalEntry(
    history: HistoryState,
    entry: Extract<RuntimeLifecycleJournalEntry, { kind: "history" }>
  ): boolean {
    const top = entry.direction === "undo" ? history.undoStack.at(-1) : history.redoStack.at(-1);
    return Boolean(top && JSON.stringify(top) === JSON.stringify(entry.entry));
  }

  function historyAfterJournalReplay(
    history: HistoryState,
    entry: Extract<RuntimeLifecycleJournalEntry, { kind: "history" }>
  ): HistoryState {
    if (entry.direction === "undo") {
      return {
        version: 1,
        undoStack: history.undoStack.slice(0, -1),
        redoStack: [...history.redoStack, entry.entry]
      };
    }
    return {
      version: 1,
      undoStack: [...history.undoStack, entry.entry],
      redoStack: history.redoStack.slice(0, -1)
    };
  }

  function pruneMissingEmptyCommandRuntimeWindows(
    current: OutlineState,
    windows: RuntimeWindow[]
  ): OutlineState {
    const runtimeWindowIds = new Set(windows.map((windowInfo) => windowInfo.id));
    let pruned: OutlineState | undefined;
    const mutable = (): OutlineState => {
      pruned ??= cloneOutlineState(current);
      return pruned;
    };

    for (const nodeId in current.nodes) {
      const node = current.nodes[nodeId as NodeId];
      if (!node) {
        continue;
      }
      if (
        node.kind !== "window" ||
        node.childIds.length > 0 ||
        node.runtimeProvenance !== "commandCreated"
      ) {
        continue;
      }
      const runtimeWindowId = isLiveWindowNode(node)
        ? node.live.windowId
        : canonicalWindowIdFromNodeId(node.id);
      if (typeof runtimeWindowId !== "number" || runtimeWindowIds.has(runtimeWindowId)) {
        continue;
      }
      deleteHistoryReplayContainerNode(mutable(), node.id);
    }

    return pruned ? repairState(pruned) : current;
  }

  function stateLoadTraceOptions(): LoadStateOptions {
    const options: LoadStateOptions = {
      onStructureRepair: (repair) => {
        recordStorageLoadStructureRepair(repair);
      }
    };
    if (perfTrace.isEnabled()) {
      options.onPhase = (phase) => {
        perfTrace.mark(`background.state.load.${phase.name}`, stateLoadTraceDetail(phase));
      };
    }
    return options;
  }

  function recordStorageLoadStructureRepair(repair: StateStructureRepair): Promise<void> {
    return recordIncidentLog("storageLoadStructureRepair", { ...repair });
  }

  function stateLoadTraceDetail(phase: StateLoadPhase): TraceDetail {
    return {
      durationMs: phase.durationMs,
      ...(phase.detail ?? {})
    };
  }

  // Returns the pushed entry's id so the caller can stamp it onto the command's outline
  // journal record: the journal is durable at ack, the history save is not, and startup
  // replay rebuilds the entry from the journal when the persisted history lacks the id.
  async function recordHistoryEntry(
    commandType: TrackableHistoryCommandType,
    previous: OutlineState,
    next: OutlineState,
    options: { candidateNodeIds?: readonly NodeId[]; saveSchedule?: SaveSchedule } = {}
  ): Promise<string | undefined> {
    const entry = createHistoryEntry(commandType, previous, next, options);
    if (!entry) {
      return undefined;
    }

    const activePreferences = await ensurePreferences();
    historyState = pushUndoEntry(await ensureHistory(), entry, activePreferences.undoHistoryLimit);
    scheduleHistorySave(historyState, options.saveSchedule);
    broadcastHistoryStatusSoon(historyState);
    return entry.id;
  }

  async function applyHistoryCommand(direction: "undo" | "redo"): Promise<CommandAck> {
    const history = await ensureHistory();
    const popped = direction === "undo" ? popUndoEntry(history) : popRedoEntry(history);
    if (!popped.entry) {
      return commandAck(false);
    }

    const current = await ensureState();
    const saveSchedule = saveScheduleForCommand(popped.entry.commandType);
    const delta = direction === "undo" ? popped.entry.undo : popped.entry.redo;
    const runtimeLifecycleJournalEntry = historyDeltaMayHaveRuntimeLifecycleEffects(current, delta)
      ? runtimeLifecycleJournalEntryForHistory(direction, popped.entry, popped.history, delta)
      : undefined;
    if (runtimeLifecycleJournalEntry) {
      await ensureDurableRuntimeLifecycleBase();
      await appendRuntimeLifecycleJournalEntry(api, runtimeLifecycleJournalEntry);
    }
    const transaction = runtimeFacts.beginCommandTransactionForCommand(direction);
    if (!transaction) {
      return commandAck(false);
    }
    let applied: HistoryRuntimeApplication;
    let next: OutlineState;
    try {
      applied = await applyHistoryDeltaWithRuntime(
        current,
        delta,
        popped.entry.commandType
      );
      next = applied.state;
      runtimeFacts.recordCommandObserved(transaction.id);
    } catch (error) {
      runtimeFacts.rejectCommand(transaction.id);
      await clearRuntimeLifecycleJournalEntryNow(runtimeLifecycleJournalEntry);
      throw error;
    }
    runtimeFacts.clearRemovalTombstonesForLiveState(next);
    if (statesMateriallyEqual(current, next)) {
      if (applied.runtimeWindows) {
        runtimeFacts.rebuildWindowScopes(next, applied.runtimeWindows);
      }
      historyState = popped.history;
      scheduleHistorySave(historyState, saveSchedule);
      broadcastHistoryStatusSoon(historyState);
      runtimeFacts.commitCommand(transaction.id);
      markRuntimeLifecycleJournalEntryForClearAfterSave(runtimeLifecycleJournalEntry);
      return commandAck(false);
    }

    runtimeFacts.recordCommandRelocatedTabs(current, next);
    installStateTransition(current, next, {
      rebuildRuntimeIndex: true,
      ...(applied.runtimeWindows ? { runtimeWindows: applied.runtimeWindows } : {})
    });
    const activePreferences = await ensurePreferences();
    historyState = direction === "undo"
      ? pushRedoEntry(popped.history, popped.entry, activePreferences.undoHistoryLimit)
      : pushUndoEntryPreservingRedo(popped.history, popped.entry, activePreferences.undoHistoryLimit);
    const persistResult = await persistWithBestEffortPatch(current, next, { diffMode: "material", saveSchedule });
    // History replay must be durable before its ack like any other mutating command: the
    // command it reverts is already in the outline journal, and a restart that replays that
    // entry with no counter-entry would resurrect the change the user saw undone. Undos that
    // touch live runtime state already wrote a lifecycle "history" intent above, and startup
    // recovery replays that with runtime reconciliation -- journaling those too would apply
    // the delta twice with conflicting merge semantics. Only the closed-only undos (no
    // lifecycle entry, the previously uncovered case) go through the outline journal.
    if (!runtimeLifecycleJournalEntry) {
      const historyEntryId = popped.entry.id;
      deferCommandDurability(async () => {
        await appendCommandJournal(current, next, persistResult.candidateNodeIds, direction, "historyReplay", historyEntryId);
      });
    }
    scheduleHistorySave(historyState, saveSchedule);
    broadcastHistoryStatusSoon(historyState);
    runtimeFacts.commitCommand(transaction.id);
    markRuntimeLifecycleJournalEntryForClearAfterSave(runtimeLifecycleJournalEntry);
    return commandAck(true);
  }

  async function handlePreferencesChanged(value: unknown): Promise<void> {
    const nextPreferences = normalizeAppPreferences(value);
    const previousPreferences = preferences ?? DEFAULT_APP_PREFERENCES;
    const previousLimit = previousPreferences.undoHistoryLimit;
    const previousAutomaticBackupsEnabled = previousPreferences.automaticBackups.enabled;
    preferences = nextPreferences;
    if (nextPreferences.automaticBackups.enabled) {
      await configureAutomaticBackups({ runImmediately: !previousAutomaticBackupsEnabled });
    } else if (previousAutomaticBackupsEnabled) {
      await api.alarms.clear(AUTOMATIC_BACKUP_ALARM_NAME).catch(() => false);
    }

    if (!historyState || previousLimit === nextPreferences.undoHistoryLimit) {
      return;
    }

    const trimmed = normalizeHistoryState(historyState, nextPreferences.undoHistoryLimit);
    if (
      trimmed.undoStack.length === historyState.undoStack.length &&
      trimmed.redoStack.length === historyState.redoStack.length
    ) {
      return;
    }

    historyState = trimmed;
    scheduleHistorySave(historyState);
    broadcastHistoryStatusSoon(historyState);
  }

  type HistoryRuntimeApplication = {
    state: OutlineState;
    runtimeWindows?: RuntimeWindow[];
  };

  async function applyHistoryDeltaWithRuntime(
    current: OutlineState,
    delta: OutlineDelta,
    commandType: TrackableHistoryCommandType
  ): Promise<HistoryRuntimeApplication> {
    const windowsBeforeReplay = await getNormalWindows(api);
    let next = repairState(preserveClosedNodesDuringHistoryReplay(current, applyOutlineDelta(current, delta)));
    if (historyReplayMayDropCurrentLiveRuntimeResources(current, next, delta)) {
      next = preserveCurrentLiveRuntimeResourcesDuringHistoryReplay(current, next, delta, windowsBeforeReplay);
    }
    if (commandType !== "deleteNode" && historyReplayNeedsCurrentRuntimeShapeOverlay(current, next, delta)) {
      next = reconcileHistoryReplayResultWithRuntimeSnapshot(next, windowsBeforeReplay, {
        closeMissing: true,
        respectRuntimeTabOrder: false
      });
    }
    if (historyCommandPreservesRuntimePlacement(commandType)) {
      next = reconcileHistoryReplayResultWithRuntimeSnapshot(next, windowsBeforeReplay, {
        closeMissing: true,
        respectRuntimeTabOrder: true
      });
    }
    next = guardHistoryReplayRuntimeLifecycle(
      current,
      next,
      commandType
    );
    const closedRuntimeResources = await closeDeletedLiveRuntimeResources(current, next);
    const materializedRuntimeResources = await materializeHistoryLiveResources(
      current,
      next,
      new Set(windowsBeforeReplay.map((windowInfo) => windowInfo.id))
    );
    if (closedRuntimeResources || materializedRuntimeResources) {
      next = (await reconcileHistoryReplayResultWithRuntime(next)).state;
    }
    if (closedRuntimeResources || materializedRuntimeResources || liveStructureChanged(current, next)) {
      await syncBrowserOrder(next, adapter);
    }
    return reconcileHistoryReplayResultWithRuntime(next);
  }

  async function reconcileHistoryReplayResultWithRuntime(next: OutlineState): Promise<HistoryRuntimeApplication> {
    const windowsSnapshot = await getNormalWindows(api);
    return {
      state: reconcileHistoryReplayResultWithRuntimeSnapshot(next, windowsSnapshot, {
        closeMissing: true,
        respectRuntimeTabOrder: false
      }),
      runtimeWindows: windowsSnapshot
    };
  }

  function reconcileHistoryReplayResultWithRuntimeSnapshot(
    next: OutlineState,
    windowsSnapshot: RuntimeWindow[],
    options: { closeMissing: boolean; respectRuntimeTabOrder: boolean }
  ): OutlineState {
    const index = buildRuntimeStateIndex(next);
    const windows = runtimeReconciler.normalizeSnapshot({
      windows: windowsSnapshot,
      state: next,
      index,
      ledger: runtimeFacts,
      confidence: "complete"
    });
    const reconciled = reconcileRuntimeTruth(next, windows, {
      closeMissing: options.closeMissing,
      respectRuntimeTabOrder: options.respectRuntimeTabOrder
    });
    alignKnownRuntimeWindowProvenance(reconciled);
    return statesMateriallyEqual(next, reconciled) ? next : reconciled;
  }

  function reconcileRuntimeTruth(
    current: OutlineState,
    windows: RuntimeWindow[],
    options: ReconcileOptions = {}
  ): OutlineState {
    const excludedClosedRestoreNodeIds = new Set(options.excludedClosedRestoreNodeIds ?? []);
    for (const nodeId of runtimeFacts.closedRestoreNodeIdsExcludedFromRuntimeAttach(current)) {
      excludedClosedRestoreNodeIds.add(nodeId);
    }
    return reconcileWithWindows(
      current,
      windows,
      { now: now() },
      excludedClosedRestoreNodeIds.size > 0
        ? { ...options, excludedClosedRestoreNodeIds }
        : options
    );
  }

  function alignKnownRuntimeWindowProvenance(next: OutlineState): void {
    // This mutates node.runtimeProvenance in place. If the persisted-state baseline still
    // aliases the live state (the 0ms clone has not run yet), detach it first so the change
    // is visible to the next save diff (V5 / RC-8).
    detachPersistedStateBaselineForMutation();
    for (const node of liveWindowNodes(next)) {
      const provenance = runtimeFacts.runtimeWindowProvenanceMarker(node.live.windowId) ??
        (node.runtimeProvenance ? undefined : runtimeFacts.runtimeProvenanceForRecoveredWindow(node.live.windowId));
      if (provenance) {
        node.runtimeProvenance = provenance;
      }
    }
  }

  function historyReplayNeedsCurrentRuntimeShapeOverlay(
    current: OutlineState,
    next: OutlineState,
    delta: OutlineDelta
  ): boolean {
    const deletedNodeIds = new Set(delta.deletedNodeIds);
    for (const currentNode of liveTabNodes(current)) {
      if (deletedNodeIds.has(currentNode.id)) {
        continue;
      }

      const nextNode = next.nodes[currentNode.id];
      if (!isLiveTabNode(nextNode) || nextNode.live.tabId !== currentNode.live.tabId) {
        continue;
      }

      if (nextNode.live.windowId !== currentNode.live.windowId) {
        const currentWindowId = nearestLiveWindowId(current, currentNode.id) ?? currentNode.live.windowId;
        const currentWindowNode = liveWindowNodes(current).find((node) => node.live.windowId === currentWindowId);
        const nextWindowId = nearestLiveWindowId(next, nextNode.id) ?? nextNode.live.windowId;
        const nextWindowNode = liveWindowNodes(next).find((node) => node.live.windowId === nextWindowId);
        if (
          currentWindowNode?.runtimeProvenance !== "commandCreated" &&
          nextWindowNode?.runtimeProvenance !== "commandCreated"
        ) {
          return true;
        }
      }

      if (
        nextNode.active !== currentNode.active ||
        nextNode.title !== currentNode.title ||
        nextNode.url !== currentNode.url ||
        nextNode.favIconUrl !== currentNode.favIconUrl
      ) {
        return true;
      }
    }

    return false;
  }

  function historyCommandPreservesRuntimePlacement(commandType: TrackableHistoryCommandType): boolean {
    return commandType === "toggleCollapsed" ||
      commandType === "expandAncestors" ||
      commandType === "renameGroup";
  }

  function preserveClosedNodesDuringHistoryReplay(current: OutlineState, next: OutlineState): OutlineState {
    let changed = false;
    const nodes = { ...next.nodes };
    for (const [nodeId, currentNode] of Object.entries(current.nodes)) {
      const nextNode = nodes[nodeId];
      if (currentNode.status !== "closed" || nextNode?.status !== "live") {
        continue;
      }

      const preservedNode = {
        ...currentNode,
        childIds: [...nextNode.childIds],
        collapsed: nextNode.collapsed
      };
      if (nextNode.parentId) {
        preservedNode.parentId = nextNode.parentId;
      } else {
        delete preservedNode.parentId;
      }
      nodes[nodeId] = preservedNode;
      changed = true;
    }

    const stateView = { ...next, nodes };
    for (const [nodeId, nextNode] of Object.entries(nodes)) {
      if (
        !isLiveWindowNode(nextNode) ||
        isLiveWindowNode(current.nodes[nodeId]) ||
        liveTabNodesInSubtree(stateView, nodeId).length > 0
      ) {
        continue;
      }

      const closedAt = now();
      const preservedWindow: OutlineNode = {
        ...nextNode,
        status: "closed" as const,
        updatedAt: closedAt,
        closedAt,
        restore: {
          ...(nextNode.title ? { title: nextNode.title } : {})
        }
      };
      delete preservedWindow.live;
      delete preservedWindow.active;
      delete preservedWindow.restoredFromClosed;
      nodes[nodeId] = preservedWindow;
      changed = true;
    }

    return changed
      ? {
          ...next,
          nodes
        }
      : next;
  }

  function historyReplayMayDropCurrentLiveRuntimeResources(
    current: OutlineState,
    next: OutlineState,
    delta: OutlineDelta
  ): boolean {
    const deletedNodeIds = new Set(delta.deletedNodeIds);
    for (const windowNode of liveWindowNodes(current)) {
      if (deletedNodeIds.has(windowNode.id)) {
        continue;
      }
      if (!isLiveWindowNode(next.nodes[windowNode.id]) || !nodeIsReachableFromRoot(next, windowNode.id)) {
        return true;
      }
    }

    for (const tabNode of liveTabNodes(current)) {
      if (deletedNodeIds.has(tabNode.id)) {
        continue;
      }
      const nextNode = next.nodes[tabNode.id];
      if (!isLiveTabNode(nextNode) || nextNode.live.tabId !== tabNode.live.tabId || !nodeIsReachableFromRoot(next, tabNode.id)) {
        return true;
      }
    }

    return false;
  }

  function preserveCurrentLiveRuntimeResourcesDuringHistoryReplay(
    current: OutlineState,
    next: OutlineState,
    delta: OutlineDelta,
    windows: RuntimeWindow[]
  ): OutlineState {
    const runtimeWindowIds = new Set(windows.map((windowInfo) => windowInfo.id));
    const runtimeTabIds = new Set(windows.flatMap((windowInfo) => windowInfo.tabs ?? []).map((tab) => tab.id));
    const deletedNodeIds = new Set(delta.deletedNodeIds);
    let preserved: OutlineState | undefined;
    const mutable = (): OutlineState => {
      preserved ??= cloneOutlineState(next);
      return preserved;
    };

    for (const windowNode of liveWindowNodes(current)) {
      if (deletedNodeIds.has(windowNode.id) || !runtimeWindowIds.has(windowNode.live.windowId)) {
        continue;
      }
      const nextNode = next.nodes[windowNode.id];
      if (isLiveWindowNode(nextNode) && nodeIsReachableFromRoot(next, windowNode.id)) {
        continue;
      }
      mergeCurrentLiveWindowSubtree(mutable(), current, windowNode.live.windowId);
    }

    for (const tabNode of liveTabNodes(current)) {
      if (deletedNodeIds.has(tabNode.id) || !runtimeTabIds.has(tabNode.live.tabId)) {
        continue;
      }
      const nextNode = next.nodes[tabNode.id];
      if (
        isLiveTabNode(nextNode) &&
        nextNode.live.tabId === tabNode.live.tabId &&
        nodeIsReachableFromRoot(next, tabNode.id)
      ) {
        continue;
      }
      mergeCurrentLiveWindowSubtree(mutable(), current, tabNode.live.windowId);
    }

    return preserved ? repairState(preserved) : next;
  }

  function guardHistoryReplayRuntimeLifecycle(
    current: OutlineState,
    next: OutlineState,
    commandType: TrackableHistoryCommandType
  ): OutlineState {
    if (commandType === "deleteNode") {
      return next;
    }

    let guarded: OutlineState | undefined;
    const mutable = (): OutlineState => {
      guarded ??= cloneOutlineState(next);
      return guarded;
    };

    for (const node of liveTabNodes(next)) {
      const currentNode = current.nodes[node.id];
      const targetWindowId = nearestLiveWindowId(next, node.id) ?? node.live.windowId;
      const targetWindowRemoved = runtimeFacts.isWindowIgnoredForRefresh(targetWindowId);
      const tabRemoved = runtimeFacts.isTabIgnoredForRefresh(node.live.tabId);

      if (isLiveTabNode(currentNode) && currentNode.live.tabId === node.live.tabId && targetWindowRemoved) {
        mergeCurrentLiveWindowSubtree(mutable(), current, currentNode.live.windowId);
        continue;
      }

      if ((!isLiveTabNode(currentNode) || currentNode.live.tabId !== node.live.tabId) && tabRemoved) {
        deleteHistoryReplayTabNode(mutable(), node.id);
      }
    }

    for (const node of Object.values(next.nodes)) {
      if (node.kind !== "tab" || current.nodes[node.id]) {
        continue;
      }
      if (runtimeFacts.nodeTouchesRemovedRuntimeScope(next, node.id)) {
        deleteHistoryReplayTabNode(mutable(), node.id);
      }
    }

    for (const node of Object.values(next.nodes)) {
      if (node.kind !== "window" || current.nodes[node.id]) {
        continue;
      }
      if (runtimeFacts.nodeTouchesRemovedRuntimeScope(next, node.id)) {
        deleteHistoryReplayContainerNode(mutable(), node.id);
      }
    }

    if (!guarded) {
      return next;
    }

    return repairState(guarded);
  }

  async function closeDeletedLiveRuntimeResources(current: OutlineState, next: OutlineState): Promise<boolean> {
    const nextLiveTabIds = new Set(liveTabNodes(next).map((node) => node.live.tabId));
    const deletedNodeIds = Object.keys(current.nodes).filter((nodeId) => !next.nodes[nodeId]);
    const closedWindowIds = new Set<number>();
    const tabIdsToClose: number[] = [];

    for (const nodeId of deletedNodeIds) {
      const node = current.nodes[nodeId];
      if (!node || !isLiveWindowNode(node)) {
        continue;
      }

      const windowLiveTabs = projectLiveTabs(current, node.id);
      if (windowLiveTabs.length > 0 && windowLiveTabs.some((tab) => nextLiveTabIds.has(tab.tabId))) {
        continue;
      }

      await adapter.closeWindow(node.live.windowId);
      closedWindowIds.add(node.live.windowId);
    }

    for (const nodeId of deletedNodeIds) {
      const node = current.nodes[nodeId];
      if (!node || !isLiveTabNode(node) || nextLiveTabIds.has(node.live.tabId) || closedWindowIds.has(node.live.windowId)) {
        continue;
      }
      tabIdsToClose.push(node.live.tabId);
    }

    if (tabIdsToClose.length > 0) {
      await adapter.closeTabs(tabIdsToClose);
    }

    return closedWindowIds.size > 0 || tabIdsToClose.length > 0;
  }

  async function materializeHistoryLiveResources(
    current: OutlineState,
    next: OutlineState,
    currentRuntimeWindowIds: ReadonlySet<number>
  ): Promise<boolean> {
    let changed = false;
    const tabNodesCreatedWithWindow = new Set<NodeId>();

    for (const windowNode of liveWindowNodes(next)) {
      const currentWindow = current.nodes[windowNode.id];
      if (currentWindow && isLiveWindowNode(currentWindow)) {
        if (currentRuntimeWindowIds.has(currentWindow.live.windowId)) {
          if (windowNode.live.windowId !== currentWindow.live.windowId) {
            replaceLiveWindowIdInSubtree(next, windowNode.id, currentWindow.live.windowId);
            changed = true;
          }
          continue;
        }

        if (currentRuntimeWindowIds.has(windowNode.live.windowId)) {
          continue;
        }
      }

      const existingTabNode = liveTabNodesInSubtree(next, windowNode.id)
        .find((node) => {
          const currentNode = current.nodes[node.id];
          return Boolean(currentNode && isLiveTabNode(currentNode));
        });
      if (existingTabNode) {
        const currentTab = current.nodes[existingTabNode.id];
        if (!currentTab || !isLiveTabNode(currentTab)) {
          continue;
        }
        const createdWindow = await adapter.createWindow({ tabId: currentTab.live.tabId });
        runtimeFacts.recordCommandCreatedRuntimeWindow(createdWindow.id);
        replaceLiveWindowIdInSubtree(next, windowNode.id, createdWindow.id);
        changed = true;
        continue;
      }

      const missingTabNodes = liveTabNodesInSubtree(next, windowNode.id)
        .filter((node) => !isLiveTabNode(current.nodes[node.id]));
      const firstMissingTab = missingTabNodes[0];
      const createdWindow = await adapter.createWindow({
        url: firstMissingTab ? historyNodeUrl(firstMissingTab) : "about:blank"
      });
      runtimeFacts.recordCommandCreatedRuntimeWindow(createdWindow.id);
      replaceLiveWindowIdInSubtree(next, windowNode.id, createdWindow.id);
      const createdTab = createdWindow.tabs?.[0];
      if (firstMissingTab && createdTab) {
        updateLiveTabRef(next, firstMissingTab.id, createdTab.id, createdWindow.id);
        const restoredNode = cloneNodeForHistoryMutation(next, firstMissingTab.id);
        if (restoredNode) {
          restoredNode.restoredFromClosed = true;
        }
        runtimeFacts.recordCommandRestoredTab(createdTab.id, createdWindow.id);
        tabNodesCreatedWithWindow.add(firstMissingTab.id);
      }
      changed = true;
    }

    for (const node of liveTabNodes(next)) {
      const currentNode = current.nodes[node.id];
      const targetWindowId = nearestLiveWindowId(next, node.id) ?? node.live.windowId;
      if (currentNode && isLiveTabNode(currentNode)) {
        if (node.live.tabId !== currentNode.live.tabId || node.live.windowId !== targetWindowId) {
          updateLiveTabRef(next, node.id, currentNode.live.tabId, targetWindowId);
          changed = true;
        }
        continue;
      }

      if (tabNodesCreatedWithWindow.has(node.id)) {
        continue;
      }

      const created = await adapter.createTab({
        url: historyNodeUrl(node),
        windowId: targetWindowId,
        active: node.active === true
      });
      updateLiveTabRef(next, node.id, created.id, created.windowId);
      const restoredNode = cloneNodeForHistoryMutation(next, node.id);
      if (restoredNode) {
        restoredNode.restoredFromClosed = true;
      }
      runtimeFacts.recordCommandRestoredTab(created.id, created.windowId);
      changed = true;
    }

    return changed;
  }

  async function refreshFromRuntime(eventTabs: RuntimeTab[] = [], options: RefreshOptions = {}): Promise<boolean> {
    return enqueueMutation(async () =>
      refreshFromRuntimeNow(eventTabs.map(runtimeTabEvidenceForExternalRefresh), options), { reason: "refreshFromRuntime" });
  }

  async function absorbCommandRelocationNativeEcho(
    event: "attached" | "detached" | "moved",
    tabId: number,
    windowId: number | undefined
  ): Promise<boolean> {
    const current = await ensureState();
    const node = indexedLiveTabNodeByRuntimeId(current, runtimeIndexForState(current), tabId);
    const decision = runtimeFacts.decideCommandRelocationNativeEcho({
      event,
      tabId,
      windowId,
      currentWindowId: node?.live.windowId
    });
    if (decision.action !== "absorb") {
      return false;
    }

    perfTrace.mark("background.runtime.commandRelocationEcho.absorbed", {
      event,
      tabId,
      windowId
    });
    return true;
  }

  function queueRuntimeRefresh(eventTabs: RuntimeTabEvidence[] = [], options: RefreshOptions = {}): Promise<boolean> {
    invalidateDiagnosticsRuntimeCache();
    const requestedCloseMissing = options.closeMissing ?? eventTabs.length === 0;
    const pending = pendingRuntimeRefresh ?? createPendingRuntimeRefresh();
    pendingRuntimeRefresh = pending;
    pending.closeMissing ||= requestedCloseMissing;
    pending.forceSnapshot ||= options.forceSnapshot === true;
    if (typeof options.focusWindowId === "number") {
      pending.focusWindowIds.add(options.focusWindowId);
    }

    for (const evidence of eventTabs) {
      pending.eventTabsById.set(evidence.tab.id, evidence);
    }

    const promise = addRuntimeRefreshCaller(pending);
    schedulePendingRuntimeRefresh(pending);
    return promise;
  }

  function queueRuntimeActivation(activeInfo: { tabId: number; windowId: number }): Promise<boolean> {
    invalidateDiagnosticsRuntimeCache();
    const pendingTab = pendingRuntimeRefresh?.eventTabsById.get(activeInfo.tabId);
    if (pendingRuntimeRefresh && pendingTab) {
      pendingRuntimeRefresh.activationByWindowId.set(activeInfo.windowId, activeInfo.tabId);
      pendingRuntimeRefresh.eventTabsById.set(activeInfo.tabId, runtimeTabEvidenceWithActiveOverride(pendingTab));
      const promise = addRuntimeRefreshCaller(pendingRuntimeRefresh);
      schedulePendingRuntimeRefresh(pendingRuntimeRefresh);
      return promise;
    }

    const pending = pendingRuntimeRefresh ?? createPendingRuntimeRefresh();
    pendingRuntimeRefresh = pending;
    pending.closeMissing = true;
    pending.activationByWindowId.set(activeInfo.windowId, activeInfo.tabId);
    const promise = addRuntimeRefreshCaller(pending);
    schedulePendingRuntimeRefresh(pending);
    return promise;
  }

  function createPendingRuntimeRefresh(): PendingRuntimeRefresh {
    return {
      eventTabsById: new Map(),
      activationByWindowId: new Map(),
      focusWindowIds: new Set(),
      closeMissing: false,
      forceSnapshot: false,
      callers: [],
      scheduled: false
    };
  }

  function addRuntimeRefreshCaller(pending: PendingRuntimeRefresh): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      pending.callers.push({ resolve, reject });
    });
  }

  function runtimeTabEvidenceForExternalRefresh(tab: RuntimeTab): RuntimeTabEvidence {
    return {
      kind: "updated",
      tab,
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
      scopeGeneration: runtimeFacts.currentScopeGeneration(),
      sequence: 0
    };
  }

  function runtimeTabEvidenceWithActiveOverride(evidence: RuntimeTabEvidence, active = true): RuntimeTabEvidence {
    const changedFields = new Set(evidence.changedFields);
    changedFields.add("active");
    return {
      ...evidence,
      tab: {
        ...evidence.tab,
        active
      },
      changedFields
    };
  }

  async function corroborateMetadataEventEvidence(
    current: OutlineState,
    index: RuntimeStateIndex,
    eventEvidence: RuntimeTabEvidence[]
  ): Promise<RuntimeTabEvidence[]> {
    const needsCorroboration = eventEvidence.some((evidence) =>
      metadataEvidenceWouldChangeKnownNode(current, index, evidence)
    );
    if (!needsCorroboration) {
      return eventEvidence;
    }

    // One query may be the event-local stale query result; use the next browser view as the current shape.
    await perfTrace.measureAsync("background.runtime.queryTabs.corroborateEventMetadata.first", {
      eventTabCount: eventEvidence.length
    }, () => api.tabs.query({}));
    const currentTabs = await perfTrace.measureAsync("background.runtime.queryTabs.corroborateEventMetadata.second", {
      eventTabCount: eventEvidence.length
    }, () => api.tabs.query({}));
    const currentTabsById = new Map(currentTabs.filter((tab) => !tab.incognito).map((tab) => [tab.id, tab]));
    let changed = false;
    const nextEvidence = eventEvidence.map((evidence) => {
      if (
        !metadataEvidenceWouldChangeKnownNode(current, index, evidence)
      ) {
        return evidence;
      }
      const currentTab = currentTabsById.get(evidence.tab.id);
      if (!currentTab || currentTab.windowId !== evidence.tab.windowId) {
        return evidence;
      }
      changed = true;
      return {
        ...evidence,
        tab: currentTab
      };
    });
    return changed ? nextEvidence : eventEvidence;
  }

  function metadataEvidenceWouldChangeKnownNode(
    current: OutlineState,
    index: RuntimeStateIndex,
    evidence: RuntimeTabEvidence
  ): boolean {
    if (evidence.kind !== "updated" || !runtimeTabEvidenceHasMetadataChange(evidence)) {
      return false;
    }
    const nodeId = index.liveTabNodeIdsByRuntimeId.get(evidence.tab.id);
    const node = nodeId ? current.nodes[nodeId] : undefined;
    return Boolean(isLiveTabNode(node) && liveTabNodeWouldChange(node, evidence.tab));
  }

  function runtimeTabEvidenceHasMetadataChange(evidence: RuntimeTabEvidence): boolean {
    return evidence.changedFields.has("title") ||
      evidence.changedFields.has("url") ||
      evidence.changedFields.has("favIconUrl");
  }

  function absorbCommandOwnedFocusRefresh(
    previous: OutlineState,
    next: OutlineState,
    candidateNodeIds?: readonly NodeId[]
  ): void {
    const pending = pendingRuntimeRefresh;
    if (!pending) {
      return;
    }

    const activeTabsByWindowId = commandOwnedActiveTabsByWindowId(previous, next, candidateNodeIds);
    const focusedWindowIds = commandOwnedFocusedWindowIds(previous, next, candidateNodeIds);
    let absorbed = false;

    for (const [windowId, tabId] of pending.activationByWindowId) {
      if (activeTabsByWindowId.get(windowId) === tabId) {
        pending.activationByWindowId.delete(windowId);
        absorbed = true;
      }
    }
    for (const windowId of pending.focusWindowIds) {
      if (focusedWindowIds.has(windowId)) {
        pending.focusWindowIds.delete(windowId);
        absorbed = true;
      }
    }
    if (!absorbed || pending.activationByWindowId.size > 0 || pending.focusWindowIds.size > 0) {
      return;
    }

    if (pending.eventTabsById.size > 0) {
      pending.closeMissing = false;
      return;
    }

    pendingRuntimeRefresh = undefined;
    const callers = pending.callers.splice(0);
    for (const caller of callers) {
      caller.resolve(false);
    }
  }

  function schedulePendingRuntimeRefresh(pending: PendingRuntimeRefresh): void {
    if (pending.scheduled) {
      return;
    }
    pending.scheduled = true;
    globalThis.setTimeout(() => {
      void enqueueMutation(() => runPendingRuntimeRefresh(pending), {
        reason: "refreshFromRuntime",
        source: "runtimeEvent"
      }, { priority: "low" }).catch(() => undefined);
    }, RUNTIME_REFRESH_BATCH_DELAY_MS);
  }

  async function runPendingRuntimeRefresh(pending: PendingRuntimeRefresh): Promise<boolean> {
    if (pendingRuntimeRefresh !== pending) {
      for (const caller of pending.callers) {
        caller.resolve(false);
      }
      return false;
    }

    pendingRuntimeRefresh = undefined;

    try {
      const eventTabs = [...pending.eventTabsById.values()].map((evidence) => {
        const activatedTabId = pending.activationByWindowId.get(evidence.tab.windowId);
        return typeof activatedTabId === "number"
          ? runtimeTabEvidenceWithActiveOverride(evidence, evidence.tab.id === activatedTabId)
          : evidence;
      });
      const changed = await refreshFromRuntimeNow(eventTabs, {
        closeMissing: pending.closeMissing,
        activationByWindowId: pending.activationByWindowId,
        forceSnapshot: pending.forceSnapshot
      });
      for (const caller of pending.callers) {
        caller.resolve(changed);
      }
      return changed;
    } catch (error) {
      for (const caller of pending.callers) {
        caller.reject(error);
      }
      throw error;
    }
  }

  async function refreshFromRuntimeNow(eventTabs: RuntimeTabEvidence[] = [], options: RefreshOptions = {}): Promise<boolean> {
    const current = await ensureState();
    const closeMissing = options.closeMissing ?? eventTabs.length === 0;
    const index = runtimeIndexForState(current);
    const currentEventEvidence = runtimeReconciler.filterEventTabsForReconciliation({
      eventTabs,
      state: current,
      index,
      ledger: runtimeFacts
    });
    const shapeCheckedEventEvidence = await corroborateMetadataEventEvidence(current, index, currentEventEvidence);
    const currentEventTabs = shapeCheckedEventEvidence.map((evidence) => evidence.tab);
    const allEventTabsWereRelocatedStaleEchoes = eventTabs.length > 0 && eventTabs.every((evidence) =>
      runtimeReconciler.isCommandRelocatedStaleTabEvent(current, index, runtimeFacts, evidence.tab)
    );
    const allEventTabsWereCommandRestoredAbsorbableEchoes = eventTabs.length > 0 && eventTabs.every((evidence) =>
      runtimeReconciler.isCommandRestoredAbsorbableTabEvent(current, index, runtimeFacts, evidence.tab)
    );
    const inactiveEventInWindowWithoutKnownActiveTab = eventTabs.some((evidence) =>
      !evidence.tab.active &&
      !index.activeTabNodeIdsByWindowId.has(evidence.tab.windowId) &&
      !runtimeFacts.isTabIgnoredForRefresh(evidence.tab.id) &&
      !runtimeFacts.isWindowIgnoredForRefresh(evidence.tab.windowId) &&
      !allEventTabsWereRelocatedStaleEchoes &&
      !allEventTabsWereCommandRestoredAbsorbableEchoes
    );
    if (
      eventTabs.length > 0 &&
      currentEventTabs.length === 0 &&
      !closeMissing &&
      options.forceSnapshot !== true &&
      !inactiveEventInWindowWithoutKnownActiveTab
    ) {
      return false;
    }
    const eventNeedsShapeCorroboration = runtimeReconciler.eventTabsNeedShapeCorroboration({
      eventTabs: shapeCheckedEventEvidence,
      state: current,
      index,
      ledger: runtimeFacts
    });
    if (
      !closeMissing &&
      currentEventTabs.length > 0 &&
      options.forceSnapshot !== true &&
      !eventNeedsShapeCorroboration
    ) {
      const fastPath = await applyRuntimeEventTabsFastPath(current, shapeCheckedEventEvidence, index);
      if (fastPath.handled) {
        if (!fastPath.changed) {
          return false;
        }
        const fastPathCandidateNodeIds = candidateNodeIdsForPatch(fastPath.update);
        state = fastPath.state;
        replaceCachedState(state);
        runtimeIndex = fastPath.index;
        runtimeFacts.recordAcceptedRuntimeTabScopeUpdates(fastPath.runtimeScopeUpdates);
        await persistKnownRuntimeFastPathUpdate(fastPath.update, state);
        // The fast path mutates state in place, so the journal delta comes from the update
        // payload; when queued, the coalesced append replaces the checkpoint flush.
        if (!queueRuntimeEventJournalFromUpdate(fastPath.update, "runtimeFastPath")) {
          await flushRuntimeTruthFastPathSaveIfNeeded(state, fastPath.update, fastPathCandidateNodeIds);
        }
        return true;
      }
    }
    const windowsSnapshot = await perfTrace.measureAsync("background.runtime.getWindows", {
      eventTabCount: currentEventTabs.length
    }, () => currentEventTabs.length > 0 && !eventNeedsShapeCorroboration
      ? getNormalWindowsIncludingTabs(api, currentEventTabs)
      : getNormalWindows(api));
    let windows = runtimeReconciler.normalizeSnapshot({
      windows: windowsSnapshot,
      state: current,
      index,
      ledger: runtimeFacts,
      confidence: currentEventTabs.length > 0 ? "eventLocal" : closeMissing ? "complete" : "partial",
      activationByWindowId: options.activationByWindowId
    });
    const noEventOrderConflictWindowIds = eventTabs.length === 0 &&
      currentEventTabs.length === 0 &&
      closeMissing &&
      options.forceSnapshot !== true
      ? noEventSnapshotOrderConflictWindowIds(current, index, windows)
      : [];
    let noEventOrderCorroborated = false;
    if (noEventOrderConflictWindowIds.length > 0) {
      windows = await corroborateNoEventSnapshotOrder(current, index, windows, noEventOrderConflictWindowIds);
      noEventOrderCorroborated = true;
    }
    if (
      eventTabs.length === 0 &&
      currentEventTabs.length === 0 &&
      closeMissing &&
      options.forceSnapshot !== true &&
      !noEventOrderCorroborated
    ) {
      const match = runtimeSnapshotMateriallyMatchesState(current, windows);
      if (match.matches) {
        if (!runtimeFacts.windowScopesMatchRuntimeWindows(windows)) {
          runtimeFacts.rebuildWindowScopes(current, windows);
        }
        return false;
      }
    }
    if (currentEventTabs.length > 0 || (closeMissing && currentEventTabs.length === 0)) {
      windows = await corroborateMissingOrMismatchedLiveTabs(current, index, windows, {
        includeOrderMismatches: !noEventOrderCorroborated
      });
    }
    const acceptedRuntimeWindowsForRefresh =
      currentEventTabs.length > 0 || options.forceSnapshot === true || noEventOrderCorroborated
      ? windows
      : undefined;
    if (runtimeSnapshotMateriallyMatchesState(current, windows).matches) {
      runtimeFacts.rebuildWindowScopes(current, acceptedRuntimeWindowsForRefresh);
      return false;
    }
    let next = reconcileRuntimeTruth(current, windows, {
      closeMissing,
      respectRuntimeTabOrder: true
    });
    alignKnownRuntimeWindowProvenance(next);
    const guarded = preserveClosedSubtreesForRuntimeTransition(current, next, { source: "refreshSnapshot" });
    next = guarded.state;
    if (statesMateriallyEqual(current, next)) {
      runtimeFacts.rebuildWindowScopes(next, acceptedRuntimeWindowsForRefresh);
      return false;
    }
    installStateTransition(current, next, {
      rebuildRuntimeIndex: true,
      runtimeWindows: acceptedRuntimeWindowsForRefresh ?? windows
    });
    const persistResult = await persistWithBestEffortPatch(current, next, { diffMode: "material" });
    if (!queueRuntimeEventJournal(current, next, persistResult.candidateNodeIds, "refreshSnapshot")) {
      await flushRuntimeTruthSaveIfNeeded(current, next, persistResult.candidateNodeIds);
    }
    return state !== current;
  }

  async function corroborateMissingOrMismatchedLiveTabs(
    current: OutlineState,
    index: RuntimeStateIndex,
    windows: RuntimeWindow[],
    options: { includeOrderMismatches?: boolean } = {}
  ): Promise<RuntimeWindow[]> {
    const includeOrderMismatches = options.includeOrderMismatches ?? true;
    const missingTabIds = runtimeReconciler.missingLiveTabIdsInOpenWindows({
      windows,
      state: current,
      ledger: runtimeFacts
    });
    const mismatchedTabIds = runtimeReconciler.mismatchedLiveTabIdsInWindows({
      windows,
      state: current,
      index,
      ledger: runtimeFacts
    });
    const suspiciousShapeTabIds = runtimeReconciler.suspiciousShapeTabIdsInWindows({
      windows,
      state: current,
      index,
      ledger: runtimeFacts
    });
    const orderMismatchedWindowIds = includeOrderMismatches
      ? runtimeReconciler.orderMismatchedWindowIdsInWindows({
          windows,
          state: current,
          index,
          ledger: runtimeFacts
        })
      : [];
    if (
      missingTabIds.length === 0 &&
      mismatchedTabIds.length === 0 &&
      suspiciousShapeTabIds.length === 0 &&
      orderMismatchedWindowIds.length === 0
    ) {
      return windows;
    }

    const corroboratingSnapshot = await perfTrace.measureAsync("background.runtime.getWindows.corroborate", {
      missingTabCount: missingTabIds.length,
      mismatchedTabCount: mismatchedTabIds.length,
      suspiciousShapeTabCount: suspiciousShapeTabIds.length,
      orderMismatchedWindowCount: orderMismatchedWindowIds.length
    }, () => getNormalWindows(api));
    const corroboratingWindows = runtimeReconciler.normalizeSnapshot({
      windows: corroboratingSnapshot,
      state: current,
      index,
      ledger: runtimeFacts,
      confidence: "complete"
    });
    const corroboratedMissingTabIds = new Set(runtimeReconciler.missingLiveTabIdsInOpenWindows({
      windows: corroboratingWindows,
      state: current,
      ledger: runtimeFacts
    }));
    const corroboratedMismatchedTabIds = new Set(runtimeReconciler.mismatchedLiveTabIdsInWindows({
      windows: corroboratingWindows,
      state: current,
      index,
      ledger: runtimeFacts
    }));
    const corroboratedSuspiciousShapeTabIds = new Set(runtimeReconciler.suspiciousShapeTabIdsInWindows({
      windows: corroboratingWindows,
      state: current,
      index,
      ledger: runtimeFacts
    }));
    const corroboratedOrderMismatchedWindowIds = includeOrderMismatches
      ? new Set(runtimeReconciler.orderMismatchedWindowIdsInWindows({
          windows: corroboratingWindows,
          state: current,
          index,
          ledger: runtimeFacts
        }))
      : new Set<number>();
    const contradicted = missingTabIds.some((tabId) => !corroboratedMissingTabIds.has(tabId)) ||
      mismatchedTabIds.some((tabId) => !corroboratedMismatchedTabIds.has(tabId)) ||
      suspiciousShapeTabIds.some((tabId) => !corroboratedSuspiciousShapeTabIds.has(tabId)) ||
      orderMismatchedWindowIds.some((windowId) => !corroboratedOrderMismatchedWindowIds.has(windowId));

    return contradicted ? corroboratingWindows : windows;
  }

  async function corroborateNoEventSnapshotOrder(
    current: OutlineState,
    index: RuntimeStateIndex,
    windows: RuntimeWindow[],
    conflictWindowIds: readonly number[]
  ): Promise<RuntimeWindow[]> {
    const corroboratingSnapshot = await perfTrace.measureAsync("background.runtime.getWindows.corroborateOrder", {
      orderConflictWindowCount: conflictWindowIds.length
    }, () => getNormalWindows(api));
    const corroboratingWindows = runtimeReconciler.normalizeSnapshot({
      windows: corroboratingSnapshot,
      state: current,
      index,
      ledger: runtimeFacts,
      confidence: "complete"
    });

    return runtimeWindowOrdersMatch(windows, corroboratingWindows, conflictWindowIds)
      ? windows
      : corroboratingWindows;
  }

  function noEventSnapshotOrderConflictWindowIds(
    current: OutlineState,
    index: RuntimeStateIndex,
    windows: RuntimeWindow[]
  ): number[] {
    const snapshotWindows = windows.filter((windowInfo) =>
      !windowInfo.incognito && !runtimeFacts.isWindowIgnoredForRefresh(windowInfo.id)
    );
    const snapshotWindowIds = snapshotWindows.map((windowInfo) => windowInfo.id);
    const liveWindowIds = [...index.liveWindowNodeIdsByRuntimeId.keys()]
      .filter((windowId) => !runtimeFacts.isWindowIgnoredForRefresh(windowId));
    if (!sameNumberSet(snapshotWindowIds, liveWindowIds)) {
      return [];
    }

    const windowsById = new Map(snapshotWindows.map((windowInfo) => [windowInfo.id, windowInfo]));
    const conflictWindowIds: number[] = [];
    for (const windowId of liveWindowIds) {
      const windowInfo = windowsById.get(windowId);
      if (!windowInfo) {
        return [];
      }
      const snapshotOrder = runtimeWindowTabOrder(windowInfo)
        .filter((tabId) => !runtimeFacts.isTabIgnoredForRefresh(tabId));
      const scope = runtimeFacts.windowScope(windowId);
      if (!scope || scope.lifecycle !== "live") {
        continue;
      }
      const snapshotTabIds = new Set(snapshotOrder);
      const scopeOrder = scope.tabOrder.filter((tabId) =>
        snapshotTabIds.has(tabId) && !runtimeFacts.isTabIgnoredForRefresh(tabId)
      );
      if (!sameNumberSet(scopeOrder, snapshotOrder)) {
        continue;
      }
      if (!sameNumberList(scopeOrder, snapshotOrder)) {
        conflictWindowIds.push(windowId);
      }
    }
    if (conflictWindowIds.length === 0) {
      return [];
    }

    const liveTabIdsByWindowId = new Map<number, number[]>();
    for (const tabNode of liveTabNodes(current)) {
      if (
        runtimeFacts.isWindowIgnoredForRefresh(tabNode.live.windowId) ||
        runtimeFacts.isTabIgnoredForRefresh(tabNode.live.tabId)
      ) {
        continue;
      }
      const tabIds = liveTabIdsByWindowId.get(tabNode.live.windowId) ?? [];
      tabIds.push(tabNode.live.tabId);
      liveTabIdsByWindowId.set(tabNode.live.windowId, tabIds);
    }

    for (const windowId of liveWindowIds) {
      const windowInfo = windowsById.get(windowId);
      if (!windowInfo) {
        return [];
      }
      const snapshotOrder = runtimeWindowTabOrder(windowInfo)
        .filter((tabId) => !runtimeFacts.isTabIgnoredForRefresh(tabId));
      const liveTabIds = liveTabIdsByWindowId.get(windowId) ?? [];
      if (!sameNumberSet(snapshotOrder, liveTabIds)) {
        return [];
      }
    }

    return conflictWindowIds;
  }

  async function applyRuntimeEventTabsFastPath(
    current: OutlineState,
    eventEvidence: RuntimeTabEvidence[],
    index: RuntimeStateIndex
  ): Promise<RuntimeEventTabsFastPathResult> {
    let structuralChanged = false;
    const changedNodeIds = new Set<NodeId>();
    const plannedNodes = new Map<NodeId, OutlineNode>();
    const liveTabNodeIdAdditions = new Map<number, NodeId>();
    const liveWindowNodeIdAdditions = new Map<number, NodeId>();
    const liveTabNodeIdsByWindowAdditions = new Map<number, Set<NodeId>>();
    const activeTabNodeIdOverrides = new Map<number, NodeId | undefined>();
    const fetchedWindows = new Map<number, RuntimeWindow | undefined>();
    const runtimeScopeUpdates: RuntimeAcceptedTabScopeUpdate[] = [];
    let plannedRootIds: NodeId[] | undefined;
    let activeWindowNodeId = index.activeWindowNodeId;
    let activeWindowNodeIdChanged = false;

    const nodeForPlan = (nodeId: NodeId): OutlineNode | undefined =>
      plannedNodes.get(nodeId) ?? current.nodes[nodeId];
    const hasNodeForPlan = (nodeId: NodeId): boolean => plannedNodes.has(nodeId) || Boolean(current.nodes[nodeId]);
    const rootIdsForPlan = (): NodeId[] => {
      plannedRootIds ??= [...current.rootIds];
      return plannedRootIds;
    };
    const mutableNodeForPlan = (nodeId: NodeId): OutlineNode | undefined => {
      const planned = plannedNodes.get(nodeId);
      if (planned) {
        return planned;
      }
      const node = current.nodes[nodeId];
      if (!node) {
        return undefined;
      }
      changedNodeIds.add(nodeId);
      const cloned = cloneOutlineNode(node);
      plannedNodes.set(nodeId, cloned);
      return cloned;
    };
    const plannedLiveTabNodeId = (tabId: number): NodeId | undefined =>
      liveTabNodeIdAdditions.get(tabId) ?? index.liveTabNodeIdsByRuntimeId.get(tabId);
    const plannedLiveWindowNodeId = (windowId: number): NodeId | undefined =>
      liveWindowNodeIdAdditions.get(windowId) ?? index.liveWindowNodeIdsByRuntimeId.get(windowId);
    const plannedActiveTabNodeId = (windowId: number): NodeId | undefined =>
      activeTabNodeIdOverrides.has(windowId)
        ? activeTabNodeIdOverrides.get(windowId)
        : index.activeTabNodeIdsByWindowId.get(windowId);
    const addPlannedWindowTabNodeId = (windowId: number, nodeId: NodeId): void => {
      const nodeIds = liveTabNodeIdsByWindowAdditions.get(windowId) ?? new Set<NodeId>();
      nodeIds.add(nodeId);
      liveTabNodeIdsByWindowAdditions.set(windowId, nodeIds);
    };
    const uniqueRuntimeNodeIdForPlan = (preferredId: NodeId): NodeId => {
      if (!hasNodeForPlan(preferredId)) {
        return preferredId;
      }

      const timestamp = now();
      let index = 1;
      let candidate = `${preferredId}:${timestamp}`;
      while (hasNodeForPlan(candidate)) {
        index += 1;
        candidate = `${preferredId}:${timestamp}:${index}`;
      }
      return candidate;
    };
    const isNodeUnderRuntimeWindowForPlan = (nodeId: NodeId, runtimeWindowId: number): boolean => {
      const visited = new Set<NodeId>();
      let currentNode = nodeForPlan(nodeId);

      while (currentNode && !visited.has(currentNode.id)) {
        visited.add(currentNode.id);
        if (isLiveWindowNode(currentNode)) {
          return currentNode.live.windowId === runtimeWindowId;
        }
        currentNode = currentNode.parentId ? nodeForPlan(currentNode.parentId) : undefined;
      }

      return false;
    };
    const parentNodeIdForRuntimeTabPlan = (
      tab: RuntimeTab,
      fallbackWindowNodeId: NodeId
    ): NodeId => {
      if (!shouldUseRuntimeOpenerParent(tab)) {
        return fallbackWindowNodeId;
      }

      const openerNodeId = plannedLiveTabNodeId(tab.openerTabId);
      if (!openerNodeId || !isNodeUnderRuntimeWindowForPlan(openerNodeId, tab.windowId)) {
        return fallbackWindowNodeId;
      }

      return openerNodeId;
    };

    const ensureRuntimeWindowNode = async (windowId: number): Promise<NodeId | undefined> => {
      const existingWindowNodeId = plannedLiveWindowNodeId(windowId);
      if (existingWindowNodeId && nodeForPlan(existingWindowNodeId)) {
        return existingWindowNodeId;
      }

      if (!fetchedWindows.has(windowId)) {
        fetchedWindows.set(
          windowId,
          await perfTrace.measureAsync("background.runtime.getWindow", { windowId }, () => getNormalWindow(api, windowId))
        );
      }
      const windowInfo = fetchedWindows.get(windowId);
      if (!windowInfo) {
        return undefined;
      }

      const windowNodeId = uniqueRuntimeNodeIdForPlan(windowNodeIdForRuntime(windowInfo.id));
      const runtimeProvenance = runtimeFacts.runtimeProvenanceForRecoveredWindow(windowInfo.id);
      plannedNodes.set(windowNodeId, {
        id: windowNodeId,
        kind: "window",
        status: "live",
        childIds: [],
        title: "Group",
        active: windowInfo.focused,
        collapsed: false,
        createdAt: now(),
        updatedAt: now(),
        ...(runtimeProvenance ? { runtimeProvenance } : {}),
        live: { windowId: windowInfo.id }
      });
      changedNodeIds.add(windowNodeId);
      structuralChanged = true;
      rootIdsForPlan().push(windowNodeId);
      liveWindowNodeIdAdditions.set(windowInfo.id, windowNodeId);
      liveTabNodeIdsByWindowAdditions.set(windowInfo.id, new Set());
      if (runtimeProvenance === "browserCreated") {
        runtimeFacts.recordBrowserCreatedRuntimeWindow(windowInfo.id);
      }
      if (windowInfo.focused) {
        clearActiveWindowForRuntimeFastPath(windowNodeId);
      }
      return windowNodeId;
    };

    const clearActiveWindowForRuntimeFastPath = (nextActiveWindowNodeId: NodeId): void => {
      const previousActiveWindowNodeId = activeWindowNodeId;
      if (previousActiveWindowNodeId && previousActiveWindowNodeId !== nextActiveWindowNodeId) {
        const previousActiveWindow = nodeForPlan(previousActiveWindowNodeId);
        if (previousActiveWindow?.active !== false) {
          const mutablePreviousActiveWindow = mutableNodeForPlan(previousActiveWindowNodeId);
          if (mutablePreviousActiveWindow) {
            mutablePreviousActiveWindow.active = false;
          }
        }
      }
      const activeWindow = nodeForPlan(nextActiveWindowNodeId);
      if (activeWindow?.active !== true) {
        const mutableActiveWindow = mutableNodeForPlan(nextActiveWindowNodeId);
        if (mutableActiveWindow) {
          mutableActiveWindow.active = true;
        }
      }
      activeWindowNodeIdChanged = true;
      activeWindowNodeId = nextActiveWindowNodeId;
    };

    const activateTabForRuntimeFastPath = (windowId: number, activeTabNodeId: NodeId, eventSequence: number): void => {
      clearCommandRelocatedActiveTabsFromSourceWindow(windowId, eventSequence);
      const previousActiveTabNodeId = plannedActiveTabNodeId(windowId);
      if (previousActiveTabNodeId && previousActiveTabNodeId !== activeTabNodeId) {
        const previousActiveTab = nodeForPlan(previousActiveTabNodeId);
        if (previousActiveTab?.active !== false) {
          const mutablePreviousActiveTab = mutableNodeForPlan(previousActiveTabNodeId);
          if (mutablePreviousActiveTab) {
            mutablePreviousActiveTab.active = false;
          }
        }
        if (isLiveTabNode(previousActiveTab)) {
          const previousFact = runtimeFacts.acceptedTabShapeFact(previousActiveTab.live.tabId);
          const previousWindowNodeId = plannedLiveWindowNodeId(windowId);
          runtimeScopeUpdates.push({
            tab: {
              id: previousActiveTab.live.tabId,
              windowId: previousActiveTab.live.windowId,
              index: previousFact?.index ?? 0,
              active: false,
              title: previousActiveTab.title,
              ...(previousActiveTab.url !== undefined ? { url: previousActiveTab.url } : {}),
              ...(previousActiveTab.favIconUrl !== undefined ? { favIconUrl: previousActiveTab.favIconUrl } : {})
            },
            tabNodeId: previousActiveTabNodeId,
            ...(previousWindowNodeId ? { windowNodeId: previousWindowNodeId } : {}),
            sequence: eventSequence,
            preserveOrder: true
          });
        }
      }
      const activeTab = nodeForPlan(activeTabNodeId);
      if (activeTab?.active !== true) {
        const mutableActiveTab = mutableNodeForPlan(activeTabNodeId);
        if (mutableActiveTab) {
          mutableActiveTab.active = true;
        }
      }
      activeTabNodeIdOverrides.set(windowId, activeTabNodeId);
    };

    const clearCommandRelocatedActiveTabsFromSourceWindow = (sourceWindowId: number, eventSequence: number): void => {
      for (const [tabId, echo] of runtimeFacts.commandRelocatedTabEchoEntries()) {
        if (echo.sourceWindowId !== sourceWindowId || eventSequence <= 0 || eventSequence >= echo.sequence) {
          continue;
        }
        const nodeId = plannedLiveTabNodeId(tabId);
        if (!nodeId) {
          continue;
        }
        const node = nodeForPlan(nodeId);
        if (!isLiveTabNode(node) || node.active !== true) {
          continue;
        }
        const mutableNode = mutableNodeForPlan(nodeId);
        if (!mutableNode) {
          continue;
        }
        mutableNode.active = false;
        if (plannedActiveTabNodeId(node.live.windowId) === nodeId) {
          activeTabNodeIdOverrides.set(node.live.windowId, undefined);
        }
      }
    };

    const plannedRuntimeOrderByWindowId = new Map<number, number[]>();
    const runtimeTabIdsInPlannedSubtree = (nodeId: NodeId, runtimeWindowId: number): number[] => {
      const visited = new Set<NodeId>();
      const stack = [nodeId];
      const tabIds: number[] = [];
      while (stack.length > 0) {
        const currentNodeId = stack.pop()!;
        if (visited.has(currentNodeId)) {
          continue;
        }
        visited.add(currentNodeId);
        const node = nodeForPlan(currentNodeId);
        if (!node) {
          continue;
        }
        if (node.id !== nodeId && isLiveWindowNode(node) && node.live.windowId !== runtimeWindowId) {
          continue;
        }
        if (isLiveTabNode(node) && node.live.windowId === runtimeWindowId) {
          tabIds.push(node.live.tabId);
        }
        for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
          stack.push(node.childIds[index]!);
        }
      }
      return tabIds;
    };

    const commandRelocationAnchorIndexesInPlannedSubtree = (
      nodeId: NodeId,
      sourceWindowId: number,
      eventSequence: number
    ): number[] => {
      if (eventSequence <= 0 || runtimeFacts.commandRelocatedTabEchoCount() === 0) {
        return [];
      }
      const visited = new Set<NodeId>();
      const stack = [nodeId];
      const indexes: number[] = [];
      while (stack.length > 0) {
        const currentNodeId = stack.pop()!;
        if (visited.has(currentNodeId)) {
          continue;
        }
        visited.add(currentNodeId);
        const node = nodeForPlan(currentNodeId);
        if (!node) {
          continue;
        }
        if (isLiveTabNode(node)) {
          const echo = runtimeFacts.commandRelocatedTabEcho(node.live.tabId);
          if (
            echo &&
            echo.sourceWindowId === sourceWindowId &&
            echo.toWindowId === node.live.windowId &&
            eventSequence < echo.sequence &&
            typeof echo.sourceIndex === "number"
          ) {
            indexes.push(echo.sourceIndex);
          }
        }
        for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
          stack.push(node.childIds[index]!);
        }
      }
      return indexes;
    };

    const outlineRuntimeTabOrderForPlan = (runtimeWindowId: number): number[] => {
      const windowNodeId = plannedLiveWindowNodeId(runtimeWindowId);
      return windowNodeId ? runtimeTabIdsInPlannedSubtree(windowNodeId, runtimeWindowId) : [];
    };

    const plannedRuntimeOrderForWindow = (runtimeWindowId: number): number[] => {
      const cached = plannedRuntimeOrderByWindowId.get(runtimeWindowId);
      if (cached) {
        return cached;
      }

      const outlineOrder = outlineRuntimeTabOrderForPlan(runtimeWindowId);
      const outlineTabIds = new Set(outlineOrder);
      const factOrder = runtimeFacts.windowScope(runtimeWindowId)?.tabOrder ??
        runtimeFacts.acceptedWindowShapeFact(runtimeWindowId)?.tabOrder ??
        [];
      const orderedKnownTabs = factOrder.filter((tabId) => outlineTabIds.has(tabId));
      const orderedKnownTabIds = new Set(orderedKnownTabs);
      const order = [
        ...orderedKnownTabs,
        ...outlineOrder.filter((tabId) => !orderedKnownTabIds.has(tabId))
      ];
      plannedRuntimeOrderByWindowId.set(runtimeWindowId, order);
      return order;
    };

    const plannedRuntimeOrderWithTabAtIndex = (
      tabOrder: readonly number[],
      tabId: number,
      index: number | undefined
    ): number[] => {
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
    };

    const insertRuntimeTabChildForFastPath = (
      parentNode: OutlineNode,
      tabNodeId: NodeId,
      tab: RuntimeTab,
      eventSequence: number
    ): void => {
      const runtimeOrder = plannedRuntimeOrderWithTabAtIndex(
        plannedRuntimeOrderForWindow(tab.windowId),
        tab.id,
        tab.index
      );
      plannedRuntimeOrderByWindowId.set(tab.windowId, runtimeOrder);
      const runtimeOrderIndexByTabId = new Map(runtimeOrder.map((tabId, index) => [tabId, index]));
      const tabOrderIndex = runtimeOrderIndexByTabId.get(tab.id) ?? runtimeOrder.length;
      const insertAt = parentNode.childIds.findIndex((childId) => {
        const childIndex = [
          ...runtimeTabIdsInPlannedSubtree(childId, tab.windowId)
            .map((childTabId) => runtimeOrderIndexByTabId.get(childTabId))
            .filter((index): index is number => typeof index === "number"),
          ...commandRelocationAnchorIndexesInPlannedSubtree(childId, tab.windowId, eventSequence)
        ]
          .sort((left, right) => left - right)[0];
        return childIndex !== undefined && childIndex >= tabOrderIndex;
      });
      if (insertAt >= 0) {
        parentNode.childIds.splice(insertAt, 0, tabNodeId);
        return;
      }
      parentNode.childIds.push(tabNodeId);
    };

    const tabWithCommandRelocationAdjustedIndex = (tab: RuntimeTab, eventSequence: number): RuntimeTab => {
      if (eventSequence <= 0) {
        return tab;
      }
      const relocatedSourceIndexes = new Set<number>();
      for (const [, echo] of runtimeFacts.commandRelocatedTabEchoEntries()) {
        if (
          echo.sourceWindowId === tab.windowId &&
          eventSequence < echo.sequence &&
          typeof echo.sourceIndex === "number" &&
          echo.sourceIndex < tab.index
        ) {
          relocatedSourceIndexes.add(echo.sourceIndex);
        }
      }
      const adjustedIndex = Math.max(0, tab.index - relocatedSourceIndexes.size);
      return adjustedIndex === tab.index ? tab : { ...tab, index: adjustedIndex };
    };

    const applyPlannedIndexUpdates = (): void => {
      for (const [windowId, nodeId] of liveWindowNodeIdAdditions) {
        index.liveWindowNodeIdsByRuntimeId.set(windowId, nodeId);
        index.liveTabNodeIdsByWindowId.set(windowId, index.liveTabNodeIdsByWindowId.get(windowId) ?? new Set());
      }
      for (const [tabId, nodeId] of liveTabNodeIdAdditions) {
        index.liveTabNodeIdsByRuntimeId.set(tabId, nodeId);
      }
      for (const [windowId, nodeIds] of liveTabNodeIdsByWindowAdditions) {
        const existingNodeIds = index.liveTabNodeIdsByWindowId.get(windowId) ?? new Set<NodeId>();
        for (const nodeId of nodeIds) {
          existingNodeIds.add(nodeId);
        }
        index.liveTabNodeIdsByWindowId.set(windowId, existingNodeIds);
      }
      for (const [windowId, nodeId] of activeTabNodeIdOverrides) {
        if (nodeId) {
          index.activeTabNodeIdsByWindowId.set(windowId, nodeId);
        } else {
          index.activeTabNodeIdsByWindowId.delete(windowId);
        }
      }
      if (activeWindowNodeIdChanged) {
        if (activeWindowNodeId) {
          index.activeWindowNodeId = activeWindowNodeId;
        } else {
          delete index.activeWindowNodeId;
        }
      }
      index.state = current;
    };

    const applyPlannedStateUpdates = (): void => {
      detachPersistedStateBaselineForMutation();
      if (plannedRootIds) {
        current.rootIds = plannedRootIds;
      }
      for (const [nodeId, node] of plannedNodes) {
        current.nodes[nodeId] = node;
      }
    };

    for (const evidence of eventEvidence) {
      const tab = evidence.tab;
      if (tab.incognito) {
        continue;
      }

      const windowNodeId = await ensureRuntimeWindowNode(tab.windowId);
      if (!windowNodeId) {
        return { handled: false };
      }

      const existingTabNodeId = plannedLiveTabNodeId(tab.id);
      if (existingTabNodeId) {
        const existingTab = nodeForPlan(existingTabNodeId);
        if (!isLiveTabNode(existingTab) || existingTab.live.windowId !== tab.windowId) {
          return { handled: false };
        }
        const wasActive = existingTab.active === true;
        if (liveTabNodeWouldChange(existingTab, tab)) {
          const tabNode = mutableNodeForPlan(existingTabNodeId);
          if (tabNode) {
            updateRuntimeTabNodeForFastPath(tabNode, tab, now());
          }
        }
        if (tab.active) {
          activateTabForRuntimeFastPath(tab.windowId, existingTabNodeId, evidence.sequence);
        } else if (wasActive) {
          return { handled: false };
        }
        runtimeScopeUpdates.push({
          tab,
          tabNodeId: existingTabNodeId,
          windowNodeId,
          sequence: evidence.sequence
        });
        continue;
      }

      if (index.windowNodeIdsWithClosedRestoreCandidates.has(windowNodeId)) {
        return { handled: false };
      }

      const parentId = parentNodeIdForRuntimeTabPlan(tab, windowNodeId);
      const parent = nodeForPlan(parentId);
      if (!parent) {
        return { handled: false };
      }

      const tabNodeId = uniqueRuntimeNodeIdForPlan(tabNodeIdForRuntime(tab.id));
      const parentNode = mutableNodeForPlan(parentId);
      if (!parentNode) {
        return { handled: false };
      }
      const scopeTab = tabWithCommandRelocationAdjustedIndex(tab, evidence.sequence);
      plannedNodes.set(tabNodeId, runtimeTabNodeForFastPath(tab, tabNodeId, parentId, now()));
      insertRuntimeTabChildForFastPath(parentNode, tabNodeId, scopeTab, evidence.sequence);
      changedNodeIds.add(tabNodeId);
      structuralChanged = true;
      liveTabNodeIdAdditions.set(tab.id, tabNodeId);
      addPlannedWindowTabNodeId(tab.windowId, tabNodeId);
      if (tab.active) {
        activateTabForRuntimeFastPath(tab.windowId, tabNodeId, evidence.sequence);
      }
      runtimeScopeUpdates.push({
        tab: scopeTab,
        tabNodeId,
        windowNodeId,
        sequence: evidence.sequence
      });
    }

    if (plannedNodes.size === 0 && !plannedRootIds) {
      return {
        handled: true,
        changed: false
      };
    }

    applyPlannedStateUpdates();
    applyPlannedIndexUpdates();
    const updatedNodes = [...changedNodeIds].flatMap((nodeId) => {
      const node = current.nodes[nodeId];
      return node ? [node] : [];
    });
    const update: TreeStructureUpdate | NodeStateUpdate = structuralChanged
      ? {
          type: "treeStructureUpdated",
          deletedNodeIds: [],
          updatedNodes,
          rootIds: current.rootIds,
          deletedClosedCount: 0
        }
      : {
          type: "nodeStateUpdated",
          updatedNodes,
          closedCountDelta: 0
        };
    return {
      handled: true,
      changed: true,
      state: current,
      index,
      update,
      structuralChanged,
      runtimeScopeChanged: structuralChanged || activeTabNodeIdOverrides.size > 0 || activeWindowNodeIdChanged,
      runtimeScopeUpdates
    };
  }

  function runtimeIndexForState(current: OutlineState): RuntimeStateIndex {
    if (runtimeIndex?.state === current) {
      return runtimeIndex;
    }

    runtimeIndex = buildRuntimeStateIndex(current);
    return runtimeIndex;
  }

  function deferPersistedStateBaselineClone(persisted: OutlineState): void {
    if (deferredPersistedStateCloneTimer !== undefined) {
      clearTimeout(deferredPersistedStateCloneTimer);
      deferredPersistedStateCloneTimer = undefined;
    }
    lastPersistedState = persisted;
    deferredPersistedStateCloneTimer = setTimeout(() => {
      deferredPersistedStateCloneTimer = undefined;
      if (lastPersistedState === persisted) {
        lastPersistedState = cloneOutlineState(persisted);
      }
    }, 0);
  }

  function detachPersistedStateBaselineForMutation(): void {
    const current = state;
    if (current && lastPersistedState === current) {
      if (deferredPersistedStateCloneTimer !== undefined) {
        clearTimeout(deferredPersistedStateCloneTimer);
        deferredPersistedStateCloneTimer = undefined;
      }
      lastPersistedState = cloneOutlineState(current);
    }
  }

  function installStateTransition(
    previous: OutlineState,
    next: OutlineState,
    options: {
      candidateNodeIds?: readonly NodeId[] | undefined;
      rebuildRuntimeIndex?: boolean;
      runtimeWindows?: readonly RuntimeWindow[];
      outlineSyncedRuntimeWindowIds?: readonly number[];
    } = {}
  ): void {
    state = next;
    replaceCachedState(next);
    if (options.rebuildRuntimeIndex) {
      runtimeIndex = buildRuntimeStateIndex(next);
      runtimeFacts.rebuildWindowScopes(next, options.runtimeWindows);
      return;
    }
    runtimeIndex = runtimeIndexForStateTransition(previous, next, runtimeIndex, options.candidateNodeIds);
    if (runtimeFacts.updateWindowScopesFromStateTransition(previous, next, options.candidateNodeIds, {
      ...(options.runtimeWindows ? { runtimeWindows: options.runtimeWindows } : {}),
      ...(options.outlineSyncedRuntimeWindowIds ? { outlineSyncedRuntimeWindowIds: options.outlineSyncedRuntimeWindowIds } : {})
    })) {
      return;
    }
    runtimeFacts.rebuildWindowScopes(next, options.runtimeWindows);
  }

  function preserveClosedSubtreesForRuntimeTransition(
    previous: OutlineState,
    next: OutlineState,
    detail: TraceDetail
  ): ClosedSubtreeGuardResult {
    const guarded = perfTrace.measure("background.closedSubtreeGuard", detail, () =>
      preserveClosedSubtreesAcrossNonDestructiveTransition(previous, next)
    );
    if (guarded.restoredNodeIds.length > 0) {
      perfTrace.mark("background.closedSubtreeGuard.restore", {
        ...detail,
        restoredNodeCount: guarded.restoredNodeIds.length
      });
      void recordIncidentLog("closedSubtreeGuardRestore", {
        source: typeof detail.source === "string" ? detail.source : "unknown",
        restoredNodeCount: guarded.restoredNodeIds.length
      });
    }
    return guarded;
  }

  function commandRunsFullBrowserOrderSync(command: BackgroundCommand, current: OutlineState): boolean {
    if (command.type === "moveNodeToNewWindow") {
      return isLiveTabNode(current.nodes[command.nodeId]);
    }
    if (command.type === "moveNode" && !command.parentId) {
      return isLiveTabNode(current.nodes[command.nodeId]);
    }
    return false;
  }

  function seedRuntimeWindowProvenanceFromCurrentState(windowId: number | undefined): void {
    if (typeof windowId !== "number") {
      return;
    }
    const current = state;
    if (!current) {
      return;
    }
    if (runtimeFacts.runtimeWindowProvenanceMarker(windowId) === undefined) {
      const scope = runtimeFacts.windowScope(windowId);
      if (scope?.provenance === "saved") {
        return;
      }
    }
    const windowNodeId = runtimeIndexForState(current).liveWindowNodeIdsByRuntimeId.get(windowId);
    const windowNode = windowNodeId ? current.nodes[windowNodeId] : undefined;
    if (isLiveWindowNode(windowNode) && windowNode.runtimeProvenance === "commandCreated") {
      runtimeFacts.recordCommandCreatedRuntimeWindow(windowId);
    } else if (isLiveWindowNode(windowNode) && windowNode.runtimeProvenance === "browserCreated") {
      runtimeFacts.recordBrowserCreatedRuntimeWindow(windowId);
    }
  }

  async function flushRuntimeProvenanceSaveIfChanged(
    previous: OutlineState,
    next: OutlineState,
    candidateNodeIds?: readonly NodeId[],
    options: {
      allowDeferredPlacementCheckpoint?: boolean;
      reason?: string;
    } = {}
  ): Promise<void> {
    if (!runtimeProvenanceChanged(previous, next, candidateNodeIds)) {
      return;
    }
    if (
      options.allowDeferredPlacementCheckpoint === true &&
      runtimeTruthCheckpointCanBeDeferred(previous, next, candidateNodeIds)
    ) {
      perfTrace.mark("background.state.save.runtimeTruthCheckpoint.deferred", {
        ...(options.reason ? { reason: options.reason } : {}),
        candidateNodeCount: candidateNodeIds?.length ?? 0
      });
      return;
    }
    await flushPendingSaves();
  }

  async function flushRuntimeTruthSaveIfNeeded(
    previous: OutlineState,
    next: OutlineState,
    candidateNodeIds?: readonly NodeId[]
  ): Promise<void> {
    if (
      !runtimeProvenanceChanged(previous, next, candidateNodeIds) &&
      !liveRuntimePlacementChanged(previous, next, candidateNodeIds) &&
      !liveRuntimeRemovalTouchedRuntimeTruth(previous, next, candidateNodeIds)
    ) {
      return;
    }
    await flushPendingSaves();
  }

  async function flushRuntimeTruthFastPathSaveIfNeeded(
    next: OutlineState,
    update: TreeStructureUpdate | NodeStateUpdate,
    candidateNodeIds: readonly NodeId[]
  ): Promise<void> {
    if (!runtimeTruthFastPathUpdateNeedsCheckpoint(next, update, candidateNodeIds)) {
      return;
    }
    await flushPendingSaves();
  }

  function runtimeTruthFastPathUpdateNeedsCheckpoint(
    next: OutlineState,
    update: TreeStructureUpdate | NodeStateUpdate,
    candidateNodeIds: readonly NodeId[]
  ): boolean {
    if (update.type === "nodeStateUpdated") {
      return update.updatedNodes.some((node) => isLiveWindowNode(node) && runtimeTruthWindowNeedsCheckpoint(node));
    }
    return candidateNodeIds.some((nodeId) => {
      const node = next.nodes[nodeId];
      if (isLiveWindowNode(node)) {
        return runtimeTruthWindowNeedsCheckpoint(node);
      }
      if (!isLiveTabNode(node)) {
        return false;
      }
      const windowNodeId = runtimeIndexForState(next).liveWindowNodeIdsByRuntimeId.get(node.live.windowId);
      const windowNode = windowNodeId ? next.nodes[windowNodeId] : undefined;
      return runtimeTruthWindowNeedsCheckpoint(windowNode);
    });
  }

  function runtimeProvenanceChanged(
    previous: OutlineState,
    next: OutlineState,
    candidateNodeIds?: readonly NodeId[]
  ): boolean {
    const nodes = candidateNodeIds
      ? candidateNodeIds.flatMap((nodeId) => {
          const node = next.nodes[nodeId];
          return node ? [node] : [];
        })
      : Object.values(next.nodes);
    return nodes.some((node) =>
      isLiveWindowNode(node) &&
      previous.nodes[node.id]?.runtimeProvenance !== node.runtimeProvenance &&
      node.runtimeProvenance !== undefined
    );
  }

  function liveRuntimePlacementChanged(
    previous: OutlineState,
    next: OutlineState,
    candidateNodeIds?: readonly NodeId[]
  ): boolean {
    const nodes = candidateNodeIds
      ? candidateNodeIds.flatMap((nodeId) => {
          const node = next.nodes[nodeId];
          return node ? [node] : [];
        })
      : Object.values(next.nodes);
    return nodes.some((node) => {
      const previousNode = previous.nodes[node.id];
      if (isLiveWindowNode(node)) {
        return (
          !isLiveWindowNode(previousNode) ||
          previousNode.live.windowId !== node.live.windowId
        ) && runtimeTruthWindowNeedsCheckpoint(node);
      }
      if (isLiveTabNode(node)) {
        const placementChanged = !isLiveTabNode(previousNode) ||
          previousNode.live.tabId !== node.live.tabId ||
          previousNode.live.windowId !== node.live.windowId;
        if (!placementChanged) {
          return false;
        }
        const windowNodeId = runtimeIndexForState(next).liveWindowNodeIdsByRuntimeId.get(node.live.windowId);
        const windowNode = windowNodeId ? next.nodes[windowNodeId] : undefined;
        return runtimeTruthWindowNeedsCheckpoint(windowNode);
      }
      return false;
    });
  }

  function liveRuntimeRemovalTouchedRuntimeTruth(
    previous: OutlineState,
    next: OutlineState,
    candidateNodeIds?: readonly NodeId[]
  ): boolean {
    const nodeIds = candidateNodeIds ?? Object.keys(previous.nodes);
    return nodeIds.some((nodeId) => {
      if (next.nodes[nodeId]) {
        return false;
      }

      const previousNode = previous.nodes[nodeId];
      if (isLiveWindowNode(previousNode)) {
        return runtimeTruthWindowNeedsCheckpoint(previousNode);
      }
      if (!isLiveTabNode(previousNode)) {
        return false;
      }

      const windowNodeId = runtimeIndexForState(previous).liveWindowNodeIdsByRuntimeId.get(previousNode.live.windowId);
      const windowNode = windowNodeId ? previous.nodes[windowNodeId] : undefined;
      return runtimeTruthWindowNeedsCheckpoint(windowNode);
    });
  }

  function runtimeTruthWindowNeedsCheckpoint(node: OutlineNode | undefined): boolean {
    return isLiveWindowNode(node) && (node.runtimeProvenance !== undefined || node.restoredFromClosed === true);
  }

  function runtimeTruthCheckpointCanBeDeferred(
    previous: OutlineState,
    next: OutlineState,
    candidateNodeIds?: readonly NodeId[]
  ): boolean {
    if (liveRuntimeRemovalTouchedRuntimeTruth(previous, next, candidateNodeIds)) {
      return false;
    }

    const nodeIds = candidateNodeIds ?? Object.keys(previous.nodes);
    return nodeIds.every((nodeId) => {
      const previousNode = previous.nodes[nodeId];
      if (isLiveWindowNode(previousNode)) {
        const nextNode = next.nodes[nodeId];
        return isLiveWindowNode(nextNode) && nextNode.live.windowId === previousNode.live.windowId;
      }
      if (isLiveTabNode(previousNode)) {
        const nextNode = next.nodes[nodeId];
        return isLiveTabNode(nextNode) && nextNode.live.tabId === previousNode.live.tabId;
      }
      return true;
    });
  }

  function replaceCachedState(next: OutlineState): void {
    initialTreeSnapshotProjector.clear();
    stateCache.replace(next);
  }

  async function handleCommandTabActivated(
    activeInfo: { tabId: number; windowId: number; previousTabId?: number },
    options: { consumeTabEcho?: boolean } = {}
  ): Promise<boolean> {
    if (options.consumeTabEcho !== false) {
      runtimeFacts.consumeCommandFocusedTab(activeInfo.tabId);
    }
    runtimeFacts.consumeCommandFocusedActivationWindow(activeInfo.windowId);
    return enqueueMutation(async () => {
      const current = await ensureState();
      const index = runtimeIndexForState(current);
      detachPersistedStateBaselineForMutation();
      const activation = activateRuntimeTabInPlace(current, index, activeInfo.tabId, activeInfo.windowId);
      if (!activation.found) {
        return refreshFromRuntimeNow([], { closeMissing: true });
      }
      if (!activation.changed) {
        return false;
      }

      state = current;
      replaceCachedState(current);
      runtimeIndex = index;
      runtimeFacts.recordInstalledActiveTab(activeInfo.tabId, activeInfo.windowId, activeInfo.previousTabId);
      await broadcastActiveStateUpdate(activation.updates);
      return true;
    }, { reason: "commandFocusActivation" });
  }

  async function handleCommandWindowFocusChanged(windowId: number): Promise<boolean> {
    runtimeFacts.consumeCommandFocusedWindow(windowId);
    return enqueueMutation(async () => {
      const current = await ensureState();
      if (windowId === api.windows.WINDOW_ID_NONE) {
        return refreshFromRuntimeNow([], { closeMissing: false });
      }

      const index = runtimeIndexForState(current);
      detachPersistedStateBaselineForMutation();
      const focus = focusRuntimeWindowInPlace(current, index, windowId);
      if (!focus.found) {
        return refreshFromRuntimeNow([], { closeMissing: false });
      }
      if (!focus.changed) {
        return false;
      }

      state = current;
      replaceCachedState(current);
      runtimeIndex = index;
      await broadcastActiveStateUpdate(focus.updates);
      return true;
    }, { reason: "commandWindowFocus" });
  }

  async function persistAndBroadcast(saveSchedule: SaveSchedule = "normal"): Promise<void> {
    if (!state) {
      return;
    }
    await sidebarBroadcaster.broadcast({ type: "stateUpdated", state });
    scheduleStateSave(state, saveSchedule);
  }

  async function persistWithNodeStateUpdate(
    previous: OutlineState,
    next: OutlineState,
    candidateNodeIds?: readonly NodeId[],
    options: { saveSchedule?: SaveSchedule } = {}
  ): Promise<readonly NodeId[] | undefined> {
    const update = perfTrace.measure("background.patch.build.nodeState", {
      candidateNodeCount: candidateNodeIds?.length ?? 0
    }, () => candidateNodeIds
      ? nodeStateUpdateForNodeIds(previous, next, candidateNodeIds)
      : nodeStateUpdateFromStateChange(previous, next));
    if (isUsefulNodeStateUpdate(update, next)) {
      await broadcastNodeStateUpdate(update);
      // The patch enumerates exactly the changed nodes, so it is a complete candidate set
      // for the compactor's dirty shards even when the caller had none to thread.
      const persistedCandidateNodeIds = candidateNodeIds ?? candidateNodeIdsForPatch(update);
      scheduleStateSave(next, options.saveSchedule, persistedCandidateNodeIds);
      return persistedCandidateNodeIds;
    }

    const fallback = await persistWithBestEffortPatch(previous, next, {
      diffMode: "material",
      skipNodeState: true,
      ...(options.saveSchedule ? { saveSchedule: options.saveSchedule } : {})
    });
    return fallback.candidateNodeIds;
  }

  async function persistKnownNodeStateUpdate(previous: OutlineState, next: OutlineState, nodeId: NodeId): Promise<void> {
    await persistKnownNodeStateUpdates(previous, next, [nodeId]);
  }

  async function persistKnownNodeStateUpdates(
    previous: OutlineState,
    next: OutlineState,
    nodeIds: readonly NodeId[]
  ): Promise<void> {
    const uniqueIds = uniqueDefinedNodeIds([...nodeIds]);
    const updatedNodes = uniqueIds.flatMap((nodeId) => {
      const node = next.nodes[nodeId];
      return node ? [node] : [];
    });
    if (updatedNodes.length === 0 || updatedNodes.length !== uniqueIds.length) {
      await persistWithBestEffortPatch(previous, next, { diffMode: "material", skipNodeState: true });
      return;
    }

    await broadcastNodeStateUpdate({
      type: "nodeStateUpdated",
      updatedNodes,
      closedCountDelta: 0
    });
    scheduleStateSave(next, "normal", uniqueIds);
  }

  async function persistKnownRuntimeFastPathUpdate(
    update: TreeStructureUpdate | NodeStateUpdate,
    next: OutlineState
  ): Promise<void> {
    if (update.type === "treeStructureUpdated") {
      await broadcastTreeStructureUpdate(update);
    } else {
      await broadcastNodeStateUpdate(update);
    }
    scheduleStateSave(next, "normal", candidateNodeIdsForPatch(update));
  }

  async function persistWithBestEffortPatch(
    previous: OutlineState,
    next: OutlineState,
    options: BestEffortPatchOptions = {}
  ): Promise<BestEffortPatchResult> {
    const diffMode = options.diffMode ?? "identity";
    if (!options.skipNodeState) {
      const nodeUpdate = perfTrace.measure("background.patch.build.nodeState", {
        candidateNodeCount: 0,
        diffMode
      }, () => nodeStateUpdateFromStateChange(previous, next, { diffMode }));
      if (isUsefulNodeStateUpdate(nodeUpdate, next)) {
        const candidateNodeIds = candidateNodeIdsForPatch(nodeUpdate);
        await broadcastNodeStateUpdate(nodeUpdate);
        scheduleStateSave(next, options.saveSchedule, candidateNodeIds);
        return { candidateNodeIds, usedFullState: false };
      }
    }

    const treeUpdate = perfTrace.measure("background.patch.build.treeStructure", { diffMode }, () =>
      treeStructureUpdateFromStateChange(previous, next, { diffMode })
    );
    if (isUsefulTreeStructureUpdate(treeUpdate, next)) {
      const candidateNodeIds = candidateNodeIdsForPatch(treeUpdate);
      await broadcastTreeStructureUpdate(treeUpdate);
      scheduleStateSave(next, options.saveSchedule, candidateNodeIds);
      return { candidateNodeIds, usedFullState: false };
    }

    if (!options.skipNodeState && diffMode !== "material") {
      const nodeUpdate = perfTrace.measure("background.patch.build.nodeState", {
        candidateNodeCount: 0,
        diffMode: "material"
      }, () => nodeStateUpdateFromStateChange(previous, next, { diffMode: "material" }));
      if (isUsefulNodeStateUpdate(nodeUpdate, next)) {
        const candidateNodeIds = candidateNodeIdsForPatch(nodeUpdate);
        await broadcastNodeStateUpdate(nodeUpdate);
        scheduleStateSave(next, options.saveSchedule, candidateNodeIds);
        return { candidateNodeIds, usedFullState: false };
      }
    }

    const semanticTreeUpdate = diffMode === "material"
      ? treeUpdate
      : perfTrace.measure("background.patch.build.treeStructure", { diffMode: "material" }, () =>
        treeStructureUpdateFromStateChange(previous, next, { diffMode: "material" })
      );
    if (diffMode !== "material" && isUsefulTreeStructureUpdate(semanticTreeUpdate, next)) {
      const candidateNodeIds = candidateNodeIdsForPatch(semanticTreeUpdate);
      await broadcastTreeStructureUpdate(semanticTreeUpdate);
      scheduleStateSave(next, options.saveSchedule, candidateNodeIds);
      return { candidateNodeIds, usedFullState: false };
    }

    await persistAndBroadcast(options.saveSchedule);
    return { usedFullState: true };
  }

  function isUsefulNodeStateUpdate(update: NodeStateUpdate | undefined, next: OutlineState): update is NodeStateUpdate {
    if (!update || update.updatedNodes.length === 0) {
      return false;
    }

    return update.updatedNodes.length < Object.keys(next.nodes).length;
  }

  async function broadcastActiveStateUpdate(updates: ActiveStateUpdate[]): Promise<void> {
    if (updates.length === 0) {
      return;
    }
    await sidebarBroadcaster.broadcast({ type: "activeStateUpdated", updates });
  }

  async function broadcastTreeStructureUpdate(update: TreeStructureUpdate): Promise<void> {
    await sidebarBroadcaster.broadcast(update);
  }

  async function broadcastSameParentReorderUpdate(update: SameParentReorderUpdate): Promise<void> {
    await sidebarBroadcaster.broadcast(update);
  }

  async function broadcastNodeStateUpdate(update: NodeStateUpdate): Promise<void> {
    if (update.updatedNodes.length === 0) {
      return;
    }
    await sidebarBroadcaster.broadcast(update);
  }

  function candidateNodeIdsForPatch(update: TreeStructureUpdate | NodeStateUpdate): NodeId[] {
    if (update.type === "treeStructureUpdated") {
      return uniqueDefinedNodeIds([
        ...update.deletedNodeIds,
        ...update.updatedNodes.map((node) => node.id)
      ]);
    }
    return uniqueDefinedNodeIds(update.updatedNodes.map((node) => node.id));
  }

  async function broadcastHistoryStatus(history: HistoryState): Promise<void> {
    await sidebarBroadcaster.broadcast(historyStatusMessage(history));
  }

  function broadcastHistoryStatusSoon(history: HistoryState): void {
    void broadcastHistoryStatus(history).catch((error) => {
      perfTrace.mark("background.runtime.broadcast.historyStatus.error", { message: errorText(error) });
    });
  }

  // Pure parsers for stored journal/migration metadata, read only by the boot path. (The
  // save engine and journal moved to the persistence coordinator; these stayed behind because
  // initializeState is their sole consumer.)
  function readJournalEpoch(value: unknown): number {
    if (value && typeof value === "object" && typeof (value as { epoch?: unknown }).epoch === "number") {
      return (value as { epoch: number }).epoch;
    }
    return 0;
  }

  function readMigrationBackupExportedAt(value: unknown): number | undefined {
    if (value && typeof value === "object" && typeof (value as { exportedAt?: unknown }).exportedAt === "number") {
      return (value as { exportedAt: number }).exportedAt;
    }
    return undefined;
  }

  async function clearCompletedRuntimeLifecycleJournalEntriesAfterSave(): Promise<void> {
    if (runtimeLifecycleJournalEntryIdsToClearAfterSave.size === 0) {
      return;
    }
    const entryIds = [...runtimeLifecycleJournalEntryIdsToClearAfterSave];
    await perfTrace.measureAsync("background.state.save.runtimeLifecycleJournal.clear", { entries: entryIds.length }, () =>
      clearRuntimeLifecycleJournalEntries(api, entryIds)
    );
    for (const entryId of entryIds) {
      runtimeLifecycleJournalEntryIdsToClearAfterSave.delete(entryId);
    }
  }

  async function recordIncidentLog(event: string, detail: IncidentLogDetail = {}): Promise<void> {
    try {
      await appendIncidentLogEntry(api, event, detail, { now });
    } catch (error) {
      perfTrace.mark("background.incidentLog.error", {
        event,
        message: errorText(error)
      });
    }
  }

  // A runtime tab/window event can change the live tab set the diagnostics readout counts,
  // so drop both the cached result and the cached window snapshot; the next poll recomputes
  // from a fresh browser query. Between events the snapshot is reused (no getNormalWindows).
  function invalidateDiagnosticsRuntimeCache(): void {
    lastDiagnostics = undefined;
    diagnosticsRuntimeWindows = undefined;
  }

  function getDiagnosticsCoalesced(): Promise<OutlineDiagnostics> {
    // Serve the cached readout when it is still fresh, OR whenever a command (high-priority
    // mutation) is queued or running: diagnostics await scheduler idle and then query the
    // browser for live windows, so recomputing here would pile a scheduler-idle wait plus a
    // browser-window query onto the single background thread right when the user is mid-edit.
    // The readout is advisory; the next poll after the command settles refreshes it.
    const cached = lastDiagnostics;
    if (cached && (now() - cached.atMs < DIAGNOSTICS_RESULT_TTL_MS || !isHighPrioritySchedulerIdle())) {
      return Promise.resolve(cached.value);
    }
    diagnosticsInFlight ??= perfTrace.measureAsync("background.diagnostics", async () => {
      await perfTrace.measureAsync("background.diagnostics.waitForIdle", () => waitForSchedulerIdle());
      const state = await ensureState();
      const windows = await perfTrace.measureAsync("background.diagnostics.getWindows", async () => {
        diagnosticsRuntimeWindows ??= await getNormalWindows(api);
        return diagnosticsRuntimeWindows;
      });
      const value = computeDiagnostics(state, windows);
      lastDiagnostics = { value, atMs: now() };
      return value;
    }).finally(() => {
      diagnosticsInFlight = undefined;
    });
    return diagnosticsInFlight;
  }

  async function applyStoredPerformanceTracePreference(): Promise<void> {
    try {
      const stored = await api.storage.local.get(PROFILE_STORAGE_KEY);
      if (stored[PROFILE_STORAGE_KEY] === true) {
        perfTrace.setEnabled(true);
        perfTrace.mark("background.profile.enabled.stored");
      }
    } catch {
      // Profile tracing should never block background startup.
    }
  }

  async function storePerformanceTracePreference(enabled: boolean): Promise<void> {
    try {
      if (enabled) {
        await api.storage.local.set({ [PROFILE_STORAGE_KEY]: true });
      } else {
        await api.storage.local.remove(PROFILE_STORAGE_KEY);
      }
    } catch (error) {
      perfTrace.mark("background.profile.preference.error", { message: errorText(error) });
    }
  }

  // One-shot, opt-in storage census run when the user turns profiling on: it measures the
  // live storage.local area (a ~1 KB probe `set` to fingerprint the backend, per-prefix byte
  // breakdown, and the node-shard generation count as a leak signal) and records it to the
  // incident log, which the options page shows and which exported profiles bundle in
  // `snapshot.incidentLog`. This is the field measurement of the per-write cost ceiling that
  // cannot be read from the repo -- see docs/storage-rearchitecture/04-STORAGE-WRITE-COST.md.
  // It deliberately writes nothing to the perf trace (so it does not perturb a cleared trace);
  // it is fire-and-forget so the slow get(null)/probe on a large store never blocks the toggle.
  async function recordStorageCensus(): Promise<void> {
    if (storageCensusInFlight) {
      return;
    }
    storageCensusInFlight = true;
    try {
      const census = await measureStorageCensus(api, { now });
      await recordIncidentLog("storageCensus", storageCensusIncidentDetail(census));
    } catch (error) {
      await recordIncidentLog("storageCensusError", { message: errorText(error) });
    } finally {
      storageCensusInFlight = false;
    }
  }

  // Reclaim leaked v4 node-shard generations (superseded copies of the tree that the shard GC never
  // collected -- historically hundreds, growing the store into the GB range and making every
  // whole-store read, including cold loads and the census, take tens of seconds). Off the startup
  // critical path: deferred so first paint/hydration land first, then fire-and-forget. Runs once
  // per session; with the GC baseline now seeded at startup the backlog does not re-accumulate.
  function scheduleOrphanShardSweep(): void {
    if (orphanShardSweepScheduled) {
      return;
    }
    orphanShardSweepScheduled = true;
    globalThis.setTimeout(() => {
      void runOrphanShardSweep();
    }, ORPHAN_SHARD_SWEEP_DELAY_MS);
  }

  async function runOrphanShardSweep(): Promise<void> {
    try {
      const result = await sweepOrphanedV4Shards(api);
      if (result.removed > 0) {
        await recordIncidentLog("orphanShardSweep", result);
      }
    } catch (error) {
      await recordIncidentLog("orphanShardSweepError", { message: errorText(error) });
    }
  }

  async function handlePerformanceTraceMessage(
    message: PerformanceTraceMessage
  ): Promise<TraceSnapshot | PerformanceProfileSnapshot | { ok: true }> {
    if (message.type === "setPerformanceTraceEnabled") {
      if (message.enabled) {
        perfTrace.setEnabled(true);
        perfTrace.mark("background.profile.enabled");
        await storePerformanceTracePreference(true);
        void recordStorageCensus();
      } else {
        await storePerformanceTracePreference(false);
        perfTrace.mark("background.profile.disabled");
        perfTrace.setEnabled(false);
      }
      sendSidebarPerformanceTraceEnabled(message.enabled);
      return { ok: true };
    }
    if (message.type === "clearPerformanceTrace") {
      perfTrace.clear();
      clearSidebarPerformanceTrace();
      return { ok: true };
    }
    if (message.type === "getPerformanceProfile") {
      return performanceProfileSnapshot();
    }
    return perfTrace.snapshot();
  }

  async function performanceProfileSnapshot(): Promise<PerformanceProfileSnapshot> {
    const background = perfTrace.snapshot();
    const [currentState, incidentLog, sidebars] = await Promise.all([
      ensureState(),
      loadIncidentLog(api),
      collectSidebarPerformanceTraces()
    ]);
    return {
      background,
      incidentLog,
      portableTree: exportPortableTree(currentState, { now: now() }),
      sidebars
    };
  }

  async function collectSidebarPerformanceTraces(): Promise<LabeledTraceSnapshot[]> {
    const requestId = `sidebar-profile:${now()}:${sidebarProfileRequestSequence += 1}`;
    const sidebars = await new Promise<LabeledTraceSnapshot[]>((resolve) => {
      const collectedSidebars: LabeledTraceSnapshot[] = [];
      globalThis.setTimeout(() => {
        pendingSidebarProfileCollections.delete(requestId);
        resolve([...collectedSidebars]);
      }, SIDEBAR_PROFILE_COLLECTION_DELAY_MS);
      const collection: PendingSidebarProfileCollection = {
        sidebars: collectedSidebars,
        seenSidebarIds: new Set()
      };
      pendingSidebarProfileCollections.set(requestId, collection);
      sidebarBroadcaster.post({ type: "collectSidebarPerformanceTrace", requestId });
    });
    return sidebars;
  }

  function handleSidebarPerformanceTraceCollected(
    message: SidebarPerformanceTraceCollectedMessage
  ): { ok: true } {
    const collection = pendingSidebarProfileCollections.get(message.requestId);
    if (!collection || collection.seenSidebarIds.has(message.sidebar.id)) {
      return { ok: true };
    }

    collection.seenSidebarIds.add(message.sidebar.id);
    collection.sidebars.push(message.sidebar);
    return { ok: true };
  }

  function sendSidebarPerformanceTraceEnabled(enabled: boolean): void {
    sidebarBroadcaster.post({ type: "setSidebarPerformanceTraceEnabled", enabled });
  }

  function clearSidebarPerformanceTrace(): void {
    sidebarBroadcaster.post({ type: "clearSidebarPerformanceTrace" });
  }

  async function reconcileMissingLiveTabsInOpenWindows(): Promise<ReconciledStateChange | undefined> {
    const current = await ensureState();
    const index = runtimeIndexForState(current);
    const windowSnapshot = await getNormalWindows(api);
    const windows = runtimeReconciler.normalizeSnapshot({
      windows: windowSnapshot,
      state: current,
      index,
      ledger: runtimeFacts,
      confidence: "partial"
    });
    const missingWindowIds = await corroboratedMissingSessionWindowIds(current, windows);
    const missingLiveTabIds = runtimeReconciler.missingLiveTabIdsInOpenWindows({
      windows: windowSnapshot,
      state: current,
      ledger: runtimeFacts
    });
    if (missingWindowIds.length === 0 && missingLiveTabIds.length === 0) {
      return undefined;
    }

    let next = current;
    const runtimeLifecycleJournalEntries: RuntimeLifecycleJournalEntry[] = [];
    for (const windowId of missingWindowIds) {
      const liveTabIds = liveTabIdsInWindow(next, windowId);
      const recent = await mostRecentClosedSession();
      const removal = runtimeReconciler.classifyMissingLiveWindowRemoval(next, runtimeFacts, {
        windowId,
        hasRecentClosedWindowSession: Boolean(recent?.window?.sessionId)
      });
      if (removal === "delete-tabs") {
        for (const tabId of liveTabIds) {
          const runtimeLifecycleJournalEntry = runtimeLifecycleJournalEntryForNativeTabClose(next, tabId, windowId);
          if (runtimeLifecycleJournalEntry) {
            await appendObservedNativeTabCloseJournalEntry(runtimeLifecycleJournalEntry);
            runtimeLifecycleJournalEntries.push(runtimeLifecycleJournalEntry);
          }
        }
        runtimeFacts.recordClosedRuntimeWindow(windowId, liveTabIds);
        for (const tabId of liveTabIds) {
          next = deleteLiveTabNodeByTabId(next, tabId);
        }
        continue;
      }

      const closedByOutliner = runtimeFacts.isOutlinerClosingWindow(windowId) ||
        runtimeFacts.isOutlinerClosedWindow(windowId);
      const runtimeLifecycleJournalEntry = runtimeLifecycleJournalEntryForNativeWindowClose(
        next,
        windowId,
        liveTabIds,
        recent?.window?.sessionId
      );
      if (runtimeLifecycleJournalEntry) {
        await ensureDurableRuntimeLifecycleBase();
        await appendRuntimeLifecycleJournalEntry(api, runtimeLifecycleJournalEntry);
        runtimeLifecycleJournalEntries.push(runtimeLifecycleJournalEntry);
      }
      runtimeFacts.recordClosedRuntimeWindow(windowId, liveTabIds);
      next = closeWindow(next, windowId, {
        now: now(),
        ...(recent?.window?.sessionId ? { sessionId: recent.window.sessionId } : {}),
        ...(closedByOutliner ? { closedBy: "outliner" } : {})
      });
      markCompletedOutlinerCloseJournalEntriesForClearAfterSave({
        tabIds: liveTabIds,
        windowIds: [windowId]
      });
    }

    for (const tabId of missingLiveTabIds) {
      runtimeFacts.recordMissingLiveTab(tabId);
      const removal = runtimeReconciler.classifyMissingLiveTabRemoval(next, runtimeFacts, tabId);
      if (removal === "close-outliner-tab") {
        const recent = await mostRecentClosedSession();
        next = closeTab(next, tabId, {
          now: now(),
          ...(recent?.tab?.sessionId ? { sessionId: recent.tab.sessionId } : {}),
          closedBy: "outliner"
        });
      } else {
        const runtimeLifecycleJournalEntry = runtimeLifecycleJournalEntryForNativeTabClose(
          next,
          tabId,
          liveTabNodeByRuntimeId(next, tabId)?.live.windowId
        );
        if (runtimeLifecycleJournalEntry) {
          await appendObservedNativeTabCloseJournalEntry(runtimeLifecycleJournalEntry);
          runtimeLifecycleJournalEntries.push(runtimeLifecycleJournalEntry);
        }
        next = deleteLiveTabNodeByTabId(next, tabId);
      }
    }

    installStateTransition(current, next, { rebuildRuntimeIndex: true, runtimeWindows: windows });
    return next !== current
      ? {
          previous: current,
          next,
          ...(runtimeLifecycleJournalEntries.length > 0 ? { runtimeLifecycleJournalEntries } : {})
        }
      : undefined;
  }

  async function corroboratedMissingSessionWindowIds(
    current: OutlineState,
    windows: RuntimeWindow[]
  ): Promise<number[]> {
    const missingWindowIds = runtimeReconciler.missingLiveWindowIds({
      windows,
      state: current,
      ledger: runtimeFacts
    });
    if (missingWindowIds.length === 0) {
      return [];
    }

    const corroboratingWindows = runtimeReconciler.normalizeSnapshot({
      windows: await perfTrace.measureAsync("background.runtime.getWindows.corroborateWindowClose", {
        missingWindowCount: missingWindowIds.length
      }, () => getNormalWindows(api)),
      state: current,
      index: runtimeIndexForState(current),
      ledger: runtimeFacts,
      confidence: "complete"
    });
    const corroboratedMissingWindowIds = new Set(runtimeReconciler.missingLiveWindowIds({
      windows: corroboratingWindows,
      state: current,
      ledger: runtimeFacts
    }));
    return missingWindowIds.filter((windowId) => corroboratedMissingWindowIds.has(windowId));
  }

  async function mostRecentClosedSession(): Promise<{ tab?: { sessionId?: string }; window?: { sessionId?: string } } | undefined> {
    const sessions = await api.sessions.getRecentlyClosed({ maxResults: 1 }).catch(() => []);
    return sessions[0];
  }

  return {
    ensureState,
    handleMessage,
    refreshFromRuntime,
    flushPendingSaves: flushPendingSavesIncludingCommandDurability,
    __debugRuntimeIndexStatus(): { warm: boolean; matchesState: boolean; reason: string } {
      return debugRuntimeIndexStatus();
    },
    __debugRuntimeCacheSnapshot(): RuntimeCacheDebugSnapshot {
      return {
        runtimeIndex: debugRuntimeIndexStatus(),
        ledger: runtimeFacts.debugSnapshot()
      };
    }
  };

  function debugRuntimeIndexStatus(): { warm: boolean; matchesState: boolean; reason: string } {
      if (!state || !runtimeIndex) {
        return { warm: false, matchesState: false, reason: "missing state or index" };
      }
      if (runtimeIndex.state !== state) {
        return { warm: false, matchesState: false, reason: "index points at a previous state object" };
      }
      const expected = buildRuntimeStateIndex(state);
      const reason = runtimeStateIndexMismatchReason(runtimeIndex, expected);
      return { warm: true, matchesState: !reason, reason: reason ?? "" };
  }
}

function commandAck(stateChanged: boolean): CommandAck {
  return {
    type: "commandAck",
    stateChanged
  };
}

function historyStatusMessage(history: HistoryState): { type: "historyStatus" } & HistoryStatus {
  return {
    type: "historyStatus",
    ...historyStatus(history)
  };
}

function isTrackableHistoryCommandType(value: string): value is TrackableHistoryCommandType {
  return value === "moveNode" ||
    value === "moveNodeToNewWindow" ||
    value === "wrapNodeInGroup" ||
    value === "moveSubtreeToTopLevel" ||
    value === "moveSubtreeToBottomTopLevel" ||
    value === "flattenSubtree" ||
    value === "promoteChildren" ||
    value === "toggleCollapsed" ||
    value === "expandAncestors" ||
    value === "renameGroup" ||
    value === "importTree" ||
    value === "deleteNode";
}

function stateWithClonedNode(state: OutlineState, nodeId: NodeId): OutlineState {
  return stateWithClonedNodes(state, [nodeId]);
}

function stateWithClonedNodes(state: OutlineState, nodeIds: readonly NodeId[]): OutlineState {
  const clonedNodeIds = uniqueDefinedNodeIds([...nodeIds]);
  if (clonedNodeIds.length === 0) {
    return state;
  }

  const nodes = { ...state.nodes };
  let cloned = false;
  for (const nodeId of clonedNodeIds) {
    const node = state.nodes[nodeId];
    if (!node) {
      continue;
    }

    nodes[nodeId] = cloneOutlineNode(node);
    cloned = true;
  }

  if (!cloned) {
    return state;
  }

  return {
    version: state.version,
    rootIds: state.rootIds,
    nodes
  };
}

function collapsedAncestorNodeIds(state: OutlineState, nodeId: NodeId): NodeId[] {
  const node = state.nodes[nodeId];
  const result: NodeId[] = [];
  const visited = new Set<NodeId>();
  let parentId = node?.parentId;

  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = state.nodes[parentId];
    if (!parent) {
      break;
    }

    if (parent.collapsed) {
      result.push(parent.id);
    }
    parentId = parent.parentId;
  }

  return result.reverse();
}

function historyCandidateNodeIds(
  command: BackgroundCommand,
  previous: OutlineState,
  next: OutlineState
): NodeId[] | undefined {
  if (command.type !== "moveNode" || !command.parentId) {
    return undefined;
  }

  const previousNode = previous.nodes[command.nodeId];
  const nextNode = next.nodes[command.nodeId];
  return uniqueDefinedNodeIds([
    command.nodeId,
    previousNode?.parentId,
    nextNode?.parentId,
    command.parentId
  ]);
}


function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function focusTargetForNode(
  state: OutlineState,
  nodeId: NodeId
): { tabId: number; windowId: number; tabActive: boolean; windowActive: boolean } | undefined {
  const node = state.nodes[nodeId];
  if (!node || !isLiveTabNode(node)) {
    return undefined;
  }

  return {
    tabId: node.live.tabId,
    windowId: node.live.windowId,
    tabActive: node.active === true,
    windowActive: liveWindowNodeByRuntimeId(state, node.live.windowId)?.active === true
  };
}

function restorePatchCandidateNodeIds(
  state: OutlineState,
  nodeId: NodeId,
  index?: RuntimeStateIndex
): NodeId[] {
  const nodeIds = new Set<NodeId>();
  for (const plan of planRestore(state, nodeId)) {
    nodeIds.add(plan.nodeId);
    if (plan.windowNodeId) {
      nodeIds.add(plan.windowNodeId);
    }
  }
  if (index?.activeWindowNodeId) {
    nodeIds.add(index.activeWindowNodeId);
  }
  return [...nodeIds];
}

function restoreTreeStructureCandidateNodeIdsForClosedParentSubgroupRestore(
  previous: OutlineState,
  next: OutlineState,
  restorePatchNodeIds: readonly NodeId[]
): NodeId[] | undefined {
  const candidateNodeIds = new Set<NodeId>();
  let needsTreeStructurePatch = false;

  for (const nodeId of restorePatchNodeIds) {
    const previousNode = previous.nodes[nodeId];
    const node = next.nodes[nodeId];
    if (
      previousNode?.status !== "closed" ||
      !isRestoredSubgroupRootForClosedParentPatch(node) ||
      node.status !== "live"
    ) {
      continue;
    }

    const parent = node.parentId ? next.nodes[node.parentId] : undefined;
    if (parent?.status !== "closed") {
      continue;
    }

    needsTreeStructurePatch = true;
    addSubtreeNodeIds(next, node.id, candidateNodeIds);
    addAncestorNodeIds(previous, next, node.id, candidateNodeIds);
  }

  if (!needsTreeStructurePatch) {
    return undefined;
  }

  for (const nodeId of restorePatchNodeIds) {
    candidateNodeIds.add(nodeId);
    addAncestorNodeIds(previous, next, nodeId, candidateNodeIds);
  }

  return [...candidateNodeIds];
}

function isRestoredSubgroupRootForClosedParentPatch(node: OutlineNode | undefined): node is OutlineNode {
  return Boolean(
    node?.kind === "window" ||
      (node?.kind === "tab" && node.childIds.length > 0)
  );
}

function addAncestorNodeIds(
  previous: OutlineState,
  next: OutlineState,
  nodeId: NodeId,
  result: Set<NodeId>
): void {
  const visited = new Set<NodeId>([nodeId]);
  let parentId = next.nodes[nodeId]?.parentId ?? previous.nodes[nodeId]?.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    result.add(parentId);
    parentId = next.nodes[parentId]?.parentId ?? previous.nodes[parentId]?.parentId;
  }
}

function saveScheduleForCommand(type: BackgroundCommand["type"]): SaveSchedule {
  return isStructuralCommand(type) ? "interaction" : "normal";
}

function isStructuralCommand(type: BackgroundCommand["type"]): boolean {
  return type === "moveNode" ||
    type === "moveNodeToNewWindow" ||
    type === "restoreNode" ||
    type === "wrapNodeInGroup" ||
    type === "moveSubtreeToTopLevel" ||
    type === "moveSubtreeToBottomTopLevel" ||
    type === "flattenSubtree" ||
    type === "promoteChildren" ||
    type === "deleteNode" ||
    type === "importTree";
}

function commandOwnedActiveTabsByWindowId(
  previous: OutlineState,
  next: OutlineState,
  candidateNodeIds?: readonly NodeId[]
): Map<number, number> {
  const activeTabsByWindowId = new Map<number, number>();
  const nodes = candidateNodeIds
    ? candidateNodeIds.flatMap((nodeId) => {
        const node = next.nodes[nodeId];
        return node ? [node] : [];
      })
    : Object.values(next.nodes);
  for (const node of nodes) {
    if (!isLiveTabNode(node) || node.active !== true) {
      continue;
    }

    const previousNode = previous.nodes[node.id];
    if (
      !isLiveTabNode(previousNode) ||
      previousNode.live.windowId !== node.live.windowId ||
      previousNode.active !== true
    ) {
      activeTabsByWindowId.set(node.live.windowId, node.live.tabId);
    }
  }
  return activeTabsByWindowId;
}

function commandOwnedFocusedWindowIds(
  previous: OutlineState,
  next: OutlineState,
  candidateNodeIds?: readonly NodeId[]
): Set<number> {
  const focusedWindowIds = new Set<number>();
  const nodes = candidateNodeIds
    ? candidateNodeIds.flatMap((nodeId) => {
        const node = next.nodes[nodeId];
        return node ? [node] : [];
      })
    : Object.values(next.nodes);
  for (const node of nodes) {
    if (!isLiveWindowNode(node) || node.active !== true) {
      continue;
    }

    const previousNode = previous.nodes[node.id];
    if (
      !isLiveWindowNode(previousNode) ||
      previousNode.live.windowId !== node.live.windowId ||
      previousNode.active !== true
    ) {
      focusedWindowIds.add(node.live.windowId);
    }
  }
  return focusedWindowIds;
}

function activateRuntimeTabInPlace(
  state: OutlineState,
  index: RuntimeStateIndex,
  tabId: number,
  windowId: number
): { found: boolean; changed: boolean; updates: ActiveStateUpdate[] } {
  let changed = false;
  const updates: ActiveStateUpdate[] = [];
  const targetNodeId = index.liveTabNodeIdsByRuntimeId.get(tabId);
  const targetNode = targetNodeId ? state.nodes[targetNodeId] : undefined;
  if (!targetNodeId || !isLiveTabNode(targetNode) || targetNode.live.windowId !== windowId) {
    return { found: false, changed, updates };
  }

  const previousActiveNodeId = index.activeTabNodeIdsByWindowId.get(windowId);
  if (previousActiveNodeId && previousActiveNodeId !== targetNodeId) {
    const previousActiveNode = state.nodes[previousActiveNodeId];
    if (!isLiveTabNode(previousActiveNode) || previousActiveNode.live.windowId !== windowId) {
      return { found: false, changed: false, updates: [] };
    }
    if (previousActiveNode.active !== false) {
      previousActiveNode.active = false;
      changed = true;
      updates.push({ nodeId: previousActiveNode.id, active: false });
    }
  }

  if (targetNode.active !== true) {
    targetNode.active = true;
    changed = true;
    updates.push({ nodeId: targetNode.id, active: true });
  }
  index.activeTabNodeIdsByWindowId.set(windowId, targetNodeId);

  return { found: true, changed, updates };
}

function focusRuntimeWindowInPlace(
  state: OutlineState,
  index: RuntimeStateIndex,
  windowId: number
): { found: boolean; changed: boolean; updates: ActiveStateUpdate[] } {
  let changed = false;
  const updates: ActiveStateUpdate[] = [];
  const targetNodeId = index.liveWindowNodeIdsByRuntimeId.get(windowId);
  const targetNode = targetNodeId ? state.nodes[targetNodeId] : undefined;
  if (!targetNodeId || !isLiveWindowNode(targetNode)) {
    return { found: false, changed, updates };
  }

  const previousActiveNodeId = index.activeWindowNodeId;
  if (previousActiveNodeId && previousActiveNodeId !== targetNodeId) {
    const previousActiveNode = state.nodes[previousActiveNodeId];
    if (!isLiveWindowNode(previousActiveNode)) {
      return { found: false, changed: false, updates: [] };
    }
    if (previousActiveNode.active !== false) {
      previousActiveNode.active = false;
      changed = true;
      updates.push({ nodeId: previousActiveNode.id, active: false });
    }
  }

  if (targetNode.active !== true) {
    targetNode.active = true;
    changed = true;
    updates.push({ nodeId: targetNode.id, active: true });
  }
  index.activeWindowNodeId = targetNodeId;

  return { found: true, changed, updates };
}

function mergeCurrentLiveWindowSubtree(state: OutlineState, current: OutlineState, runtimeWindowId: number): void {
  const windowNode = liveWindowNodes(current).find((candidate) => candidate.live.windowId === runtimeWindowId);
  if (!windowNode) {
    return;
  }

  const copiedNodeIds = new Set<NodeId>();
  addSubtreeNodeIds(current, windowNode.id, copiedNodeIds);
  for (const nodeId of copiedNodeIds) {
    const currentNode = current.nodes[nodeId];
    if (currentNode) {
      state.nodes[nodeId] = cloneOutlineNode(currentNode);
    }
  }

  const copiedWindow = state.nodes[windowNode.id];
  if (!copiedWindow) {
    return;
  }
  if (copiedWindow.parentId && !state.nodes[copiedWindow.parentId]) {
    delete copiedWindow.parentId;
  }
  if (!copiedWindow.parentId && !state.rootIds.includes(copiedWindow.id)) {
    state.rootIds = [...state.rootIds, copiedWindow.id];
  }
}

function isLiveRuntimeNode(node: OutlineNode | undefined): boolean {
  return Boolean(node?.status === "live" && node.live);
}

