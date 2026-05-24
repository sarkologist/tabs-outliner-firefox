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
import { computeDiagnostics, type OutlineDiagnostics } from "./diagnostics.js";
import { isBackgroundCommand, planLiveSubtreeClose, runCommand, syncBrowserOrder } from "./commands.js";
import type { BackgroundCommand, CommandAck, RestoreCreateAttempt, RuntimeClosePlan } from "./commands.js";
import { RuntimeFactLedger, runtimeCommandRelocatesLiveTabs } from "./runtime-facts.js";
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
  INITIAL_TREE_SNAPSHOT_ROW_LIMIT,
  initialTreeSnapshotForState,
  loadHistory,
  loadInitialTreeSnapshot,
  loadStateWithMetadata,
  saveStateAndHistory
} from "./storage.js";
import type { InitialTreeSnapshot, LoadStateOptions, StateLoadPhase } from "./storage.js";
import {
  applyOutlineDelta,
  cloneOutlineNode,
  cloneOutlineState,
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
  closeTab,
  closeWindow,
  deleteNode as deleteOutlineNode,
  deleteLiveTabNodeByTabId,
  moveSubtreeToTopLevel,
  moveTabToNewLiveWindow,
  planRestore,
  projectLiveTabs,
  reconcileWithWindows,
  repairState,
  restoreNodes,
  runtimeTitleForOutlineTab,
  wrapNodeInGroup
} from "../model/outline.js";
import { buildOutlineLookup, type OutlineLookup } from "../model/outline-lookup.js";
import type { NodeId, OutlineNode, OutlineState, RestoredNode, RuntimeTab, RuntimeWindow } from "../model/types.js";
import { createPerformanceTracer, type TraceDetail, type TraceSnapshot } from "../perf/trace.js";
import {
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
  eventTabsById: Map<number, RuntimeTab>;
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

type MutationPriority = "high" | "low";

type ScheduledMutation<T = unknown> = {
  operation: () => Promise<T>;
  detail: TraceDetail | undefined;
  priority: MutationPriority;
  queuedAt: number;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type ReconciledStateChange = {
  previous: OutlineState;
  next: OutlineState;
};

type ActiveStateUpdate = {
  nodeId: NodeId;
  active: boolean;
};

type TreeStructureUpdate = {
  type: "treeStructureUpdated";
  deletedNodeIds: NodeId[];
  updatedNodes: OutlineNode[];
  rootIds: NodeId[];
  deletedClosedCount: number;
};

type NodeStateUpdate = {
  type: "nodeStateUpdated";
  updatedNodes: OutlineNode[];
  closedCountDelta: number;
};

type PerformanceTraceMessage =
  | {
      type: "setPerformanceTraceEnabled";
      enabled: boolean;
    }
  | {
      type: "clearPerformanceTrace";
    }
  | {
      type: "getPerformanceTrace";
    }
  | {
      type: "getPerformanceProfile";
    };

type SidebarPerformanceTraceCollectedMessage = {
  type: "sidebarPerformanceTraceCollected";
  requestId: string;
  sidebar: LabeledTraceSnapshot;
};

type InitialTreeSnapshotMessage = {
  type: "getInitialTreeSnapshot";
};

type InitialTreeSnapshotWindowMessage = {
  type: "getInitialTreeSnapshotWindow" | "getTreeProjectionSlice";
  centerRowIndex: number;
  rowLimit?: number;
};

type OpenSidebarWindowMessage = {
  type: "openSidebarWindow";
};

type SidebarNonEditInteractionMessage = {
  type: "sidebarNonEditInteraction";
};

type PendingSidebarProfileCollection = {
  sidebars: LabeledTraceSnapshot[];
  seenSidebarIds: Set<string>;
};

type StateDiffMode = "identity" | "material";

type BestEffortPatchOptions = {
  diffMode?: StateDiffMode;
  skipNodeState?: boolean;
  saveSchedule?: SaveSchedule;
};

type SaveSchedule = "normal" | "interaction";

type RuntimeStateIndex = {
  state: OutlineState;
  liveTabNodeIdsByRuntimeId: Map<number, NodeId>;
  liveWindowNodeIdsByRuntimeId: Map<number, NodeId>;
  liveTabNodeIdsByWindowId: Map<number, Set<NodeId>>;
  activeTabNodeIdsByWindowId: Map<number, NodeId>;
  closedRestoreCandidateCountsByWindowNodeId: Map<NodeId, number>;
  windowNodeIdsWithClosedRestoreCandidates: Set<NodeId>;
  activeWindowNodeId?: NodeId;
};

type RuntimeSnapshotMatch = {
  matches: boolean;
  lookup: OutlineLookup;
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
    };

export type BackgroundControllerOptions = {
  api: WebExtensionBrowser;
  adapter?: BrowserAdapter;
  now?: () => number;
};

const RUNTIME_REFRESH_BATCH_DELAY_MS = 0;
const STATE_SAVE_QUIET_DELAY_MS = 1000;
const STATE_SAVE_MAX_DELAY_MS = 5000;
const INTERACTION_STATE_SAVE_QUIET_DELAY_MS = 5000;
const INTERACTION_STATE_SAVE_MAX_DELAY_MS = 30000;
const SIDEBAR_PROFILE_COLLECTION_DELAY_MS = 50;
const TOGGLE_SIDEBAR_COMMAND = "toggle-sidebar";
const SIDEBAR_WINDOW_PATH = "sidebar/sidebar.html";
const SIDEBAR_PORT_NAME = "tabs-outliner-sidebar";

export function createBackgroundController(options: BackgroundControllerOptions): BackgroundController {
  const { api, now = Date.now } = options;
  const adapter = options.adapter ?? createBrowserAdapter(api);
  const perfTrace = createPerformanceTracer("background");
  const runtimeFacts = new RuntimeFactLedger();
  const runtimeReconciler = new RuntimeReconciler();

  let state: OutlineState | undefined;
  let lastPersistedState: OutlineState | undefined;
  let deferredPersistedStateCloneTimer: ReturnType<typeof setTimeout> | undefined;
  let historyState: HistoryState | undefined;
  let historyLoadInFlight: Promise<HistoryState> | undefined;
  let historyWarmupTimer: number | undefined;
  let preferences: AppPreferences | undefined;
  let runtimeIndex: RuntimeStateIndex | undefined;
  const highPriorityMutations: ScheduledMutation[] = [];
  const lowPriorityMutations: ScheduledMutation[] = [];
  const schedulerIdleResolvers: Array<() => void> = [];
  let schedulerRunning = false;
  let schedulerDrainQueued = false;
  const stateCache = createStateCache(initializeState);
  let sessionChangedQueued = false;
  let pendingRuntimeRefresh: PendingRuntimeRefresh | undefined;
  let pendingSaveState: OutlineState | undefined;
  let pendingSaveHistory: HistoryState | undefined;
  let pendingSaveCandidateNodeIds: Set<NodeId> | undefined;
  let pendingSaveRequiresFullDiff = false;
  let saveTimer: number | undefined;
  let saveMaxTimer: number | undefined;
  let saveInFlight: Promise<void> | undefined;
  let saveAfterInFlight = false;
  let saveAfterInFlightSchedule: SaveSchedule = "normal";
  let explicitSaveFlushInProgress = false;
  let pendingSaveBatchStartedAt: number | undefined;
  let pendingSaveMaxDelayMs: number | undefined;
  let pendingSaveSchedule: SaveSchedule | undefined;
  let nextRuntimeLifecycleJournalSequence = 1;
  const runtimeLifecycleJournalEntryIdsToClearAfterSave = new Set<string>();
  const pendingOutlinerCloseJournalEntries = new Map<string, {
    plan: RuntimeClosePlan;
    completedTabIds: Set<number>;
    completedWindowIds: Set<number>;
  }>();
  let diagnosticsInFlight: Promise<OutlineDiagnostics> | undefined;
  let automaticBackupInFlight: Promise<AutomaticBackupStatus> | undefined;
  let sidebarProfileRequestSequence = 0;
  let sidebarWindowCreationInFlight = 0;
  const fullSizeOutlinerWindowIds = new Set<number>();
  const pendingSidebarProfileCollections = new Map<string, PendingSidebarProfileCollection>();
  const sidebarPorts = new Set<WebExtensionPort>();

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
    handleSidebarPortConnected(port);
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
      runtimeFacts.recordNativeTabCreated(tab);
      return queueRuntimeRefresh([tab]);
    });
  });

  api.tabs.onDetached?.addListener(async (tabId, detachInfo) => {
    await perfTrace.measureAsync("background.event.tabs.onDetached", { tabId, windowId: detachInfo.oldWindowId }, () => {
      runtimeFacts.recordNativeTabDetached(tabId, detachInfo.oldWindowId);
      return queueRuntimeRefresh([], { closeMissing: false, forceSnapshot: true });
    });
  });

  api.tabs.onAttached?.addListener(async (tabId, attachInfo) => {
    await perfTrace.measureAsync("background.event.tabs.onAttached", { tabId, windowId: attachInfo.newWindowId }, () => {
      runtimeFacts.recordNativeTabAttached(tabId, attachInfo.newWindowId);
      return queueRuntimeRefresh([], { closeMissing: false, forceSnapshot: true });
    });
  });

  api.tabs.onMoved?.addListener(async (tabId, moveInfo) => {
    await perfTrace.measureAsync("background.event.tabs.onMoved", { tabId, windowId: moveInfo.windowId }, () => {
      runtimeFacts.recordNativeTabMoved(tabId, moveInfo.windowId);
      return queueRuntimeRefresh([], { closeMissing: false, forceSnapshot: true });
    });
  });

  api.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
    await perfTrace.measureAsync("background.event.tabs.onUpdated", { tabId: tab.id }, async () => {
      if (!hasOutlineRelevantTabUpdate(changeInfo)) {
        return;
      }
      if (runtimeFacts.recordNativeTabUpdated(tab, changeInfo) === "command-focus-active") {
        await handleCommandTabActivated({ tabId: tab.id, windowId: tab.windowId }, { consumeTabEcho: false });
        return;
      }
      await queueRuntimeRefresh([tab]);
    });
  });

  api.tabs.onActivated.addListener(async (activeInfo) => {
    await perfTrace.measureAsync("background.event.tabs.onActivated", { tabId: activeInfo.tabId }, async () => {
      if (runtimeFacts.recordNativeTabActivated(activeInfo.tabId, activeInfo.windowId) === "command-focus") {
        await handleCommandTabActivated(activeInfo);
        return;
      }
      await queueRuntimeActivation(activeInfo);
    });
  });

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

          runtimeFacts.recordClosedRuntimeWindow(removeInfo.windowId, liveTabIds);
          const recent = await mostRecentClosedSession();
          const next = closeWindow(current, removeInfo.windowId, {
            now: now(),
            ...(recent?.window?.sessionId ? { sessionId: recent.window.sessionId } : {})
          });
          if (next === current) {
            return;
          }
          const runtimeLifecycleJournalEntry = runtimeLifecycleJournalEntryForNativeWindowClose(
            current,
            removeInfo.windowId,
            liveTabIds,
            recent?.window?.sessionId
          );
          if (runtimeLifecycleJournalEntry) {
            await ensureDurableRuntimeLifecycleBase();
            await appendRuntimeLifecycleJournalEntry(api, runtimeLifecycleJournalEntry);
          }
          installStateTransition(current, next, {
            candidateNodeIds: runtimeIndexCandidateNodeIdsForWindowRemoval(current, next, runtimeIndexForState(current), removeInfo.windowId)
          });
          markCompletedOutlinerCloseJournalEntriesForClearAfterSave({
            tabIds: liveTabIds,
            windowIds: [removeInfo.windowId]
          });
          markRuntimeLifecycleJournalEntryForClearAfterSave(runtimeLifecycleJournalEntry);
          await persistWithNodeStateUpdate(current, next);
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
            ...(recent?.tab?.sessionId ? { sessionId: recent.tab.sessionId } : {})
          });
          if (removal === "close-outliner-tab") {
            runtimeFacts.recordOutlinerClosedTabRemovalApplied();
          }
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
          await ensureDurableRuntimeLifecycleBase();
          await appendRuntimeLifecycleJournalEntry(api, runtimeLifecycleJournalEntry);
        }
        installStateTransition(current, next, {
          candidateNodeIds: runtimeIndexCandidateNodeIdsForTabRemoval(current, next, runtimeIndexForState(current), tabId)
        });
        markCompletedOutlinerCloseJournalEntriesForClearAfterSave({
          tabIds: [tabId],
          windowIds: []
        });
        markRuntimeLifecycleJournalEntryForClearAfterSave(runtimeLifecycleJournalEntry);
        await persistWithNodeStateUpdate(current, next);
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
        runtimeFacts.recordClosedRuntimeWindow(windowId, liveTabIds);
        const recent = await mostRecentClosedSession();
        const next = closeWindow(current, windowId, {
          now: now(),
          ...(recent?.window?.sessionId ? { sessionId: recent.window.sessionId } : {})
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
        await persistWithNodeStateUpdate(current, next);
      }, { reason: "windows.onRemoved" });
    });
  });

  api.windows.onFocusChanged.addListener(async (windowId) => {
    await perfTrace.measureAsync("background.event.windows.onFocusChanged", { windowId }, async () => {
      if (await shouldIgnoreSidebarWindowFocus(windowId)) {
        return;
      }
      if (runtimeFacts.recordNativeWindowFocused(windowId) === "command-focus") {
        await handleCommandWindowFocusChanged(windowId);
        return;
      }
      await queueRuntimeRefresh([], { closeMissing: false, focusWindowId: windowId });
    });
  });

  api.sessions.onChanged.addListener(async () => {
    await perfTrace.measureAsync("background.event.sessions.onChanged", async () => {
      runtimeFacts.recordNativeSessionChanged();
      if (sessionChangedQueued) {
        return;
      }
      sessionChangedQueued = true;
      await enqueueMutation(async () => {
        try {
          if (runtimeFacts.consumeOutlinerCloseSessionEcho()) {
            return;
          }
          const reconciled = await reconcileMissingLiveTabsInOpenWindows();
          if (reconciled) {
            await persistWithNodeStateUpdate(reconciled.previous, reconciled.next);
          }
        } finally {
          sessionChangedQueued = false;
        }
      }, { reason: "sessions.onChanged" });
    });
  });

  async function handleMessage(message: unknown): Promise<unknown> {
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

  function handleSidebarPortConnected(port: WebExtensionPort): void {
    if (port.name !== SIDEBAR_PORT_NAME) {
      return;
    }

    sidebarPorts.add(port);
    port.onDisconnect.addListener(() => {
      sidebarPorts.delete(port);
    });
  }

  async function handleNonTraceMessage(message: unknown): Promise<unknown> {
    if (isSidebarNonEditInteractionMessage(message)) {
      postSidebarMessage({ type: "sidebarNonEditInteraction" });
      return { ok: true };
    }

    if (isDiagnosticsRequest(message)) {
      return getDiagnosticsCoalesced();
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
      await waitForSchedulerIdle();
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
        ? closePlanForCloseNodeCommand(current, message.nodeId)
        : undefined;
      const focusTarget = message.type === "focusNode"
        ? focusTargetForNode(current, message.nodeId)
        : undefined;
      const deleteClosePlan = message.type === "deleteNode"
        ? planLiveSubtreeClose(current, message.nodeId)
        : undefined;
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
          restoreCreateRecovery
        }
      );
      if (runtimeLifecycleJournalEntry) {
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
      if (outlinerClosePlan) {
        runtimeFacts.markOutlinerClosePlan(outlinerClosePlan);
      }
      if (focusTarget) {
        runtimeFacts.markCommandFocusTarget(focusTarget.tabId, focusTarget.windowId, focusTarget.tabActive);
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
              if (historyPrevious && isTrackableHistoryCommandType(message.type)) {
                await recordHistoryEntry(message.type, historyPrevious, recovered, {
                  candidateNodeIds: deletePatchNodeIds,
                  saveSchedule
                });
              }
              const update = perfTrace.measure("background.patch.build.treeStructure", { command: message.type }, () =>
                treeStructureUpdateFromCandidateNodeIds(current, recovered, deletePatchNodeIds)
              );
              await broadcastTreeStructureUpdate(update);
              scheduleStateSave(recovered, saveSchedule, deletePatchNodeIds);
              if (commandTransaction) {
                runtimeFacts.commitCommand(commandTransaction.id);
              }
              markRuntimeLifecycleJournalEntryForClearAfterSave(runtimeLifecycleJournalEntry);
              return commandAck(true);
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
      runtimeFacts.clearRemovalTombstonesForLiveState(result.state, runtimeIndexCandidateNodeIds);
      if (runtimeCommandRelocatesLiveTabs(message.type)) {
        runtimeFacts.recordCommandRelocatedTabs(current, result.state, runtimeIndexCandidateNodeIds);
      }
      if (message.type === "restoreNode") {
        runtimeFacts.recordCommandRestoredTabs(current, result.state, runtimeIndexCandidateNodeIds);
      }
      installStateTransition(current, result.state, { candidateNodeIds: runtimeIndexCandidateNodeIds });
      if (runtimeCommandRelocatesLiveTabs(message.type)) {
        absorbCommandOwnedFocusRefresh(current, result.state, runtimeIndexCandidateNodeIds);
      }
      const saveSchedule = saveScheduleForCommand(message.type);
      const deletePatchNodeIds = message.type === "deleteNode"
        ? deleteTreeStructureCandidateNodeIds(current, result.state, message.nodeId)
        : undefined;
      if (historyPrevious && isTrackableHistoryCommandType(message.type)) {
        const candidateNodeIds = message.type === "expandAncestors"
          ? expandAncestorNodeIds
          : message.type === "deleteNode"
            ? deletePatchNodeIds
            : historyCandidateNodeIds(message, historyPrevious, result.state) ?? runtimeIndexCandidateNodeIds;
        await recordHistoryEntry(message.type, historyPrevious, result.state, {
          ...(candidateNodeIds ? { candidateNodeIds } : {}),
          saveSchedule
        });
      }
      if (message.type === "restoreNode") {
        await persistWithNodeStateUpdate(current, result.state, restorePatchNodeIds, { saveSchedule });
        if (commandTransaction) {
          runtimeFacts.commitCommand(commandTransaction.id);
        }
        markRuntimeLifecycleJournalEntryForClearAfterSave(runtimeLifecycleJournalEntry);
        return commandAck(true);
      }
      if (message.type === "deleteNode") {
        const update = perfTrace.measure("background.patch.build.treeStructure", { command: message.type }, () =>
          treeStructureUpdateFromCandidateNodeIds(current, result.state, deletePatchNodeIds ?? [message.nodeId])
        );
        await broadcastTreeStructureUpdate(update);
        scheduleStateSave(result.state, saveSchedule, deletePatchNodeIds ?? [message.nodeId]);
        if (commandTransaction) {
          runtimeFacts.commitCommand(commandTransaction.id);
        }
        markRuntimeLifecycleJournalEntryForClearAfterSave(runtimeLifecycleJournalEntry);
        return commandAck(true);
      }
      if (
        message.type === "wrapNodeInGroup" ||
        message.type === "moveSubtreeToTopLevel" ||
        message.type === "promoteChildren"
      ) {
        const update = perfTrace.measure("background.patch.build.treeStructure", { command: message.type }, () =>
          runtimeIndexCandidateNodeIds
            ? treeStructureUpdateFromCandidateNodeIds(current, result.state, runtimeIndexCandidateNodeIds)
            : treeStructureUpdateFromStateChange(current, result.state)
        );
        await broadcastTreeStructureUpdate(update);
        scheduleStateSave(result.state, saveSchedule, runtimeIndexCandidateNodeIds);
        if (commandTransaction) {
          runtimeFacts.commitCommand(commandTransaction.id);
        }
        markRuntimeLifecycleJournalEntryForClearAfterSave(runtimeLifecycleJournalEntry);
        return commandAck(true);
      }
      if (message.type === "renameGroup") {
        await persistKnownNodeStateUpdate(current, result.state, message.nodeId);
        if (commandTransaction) {
          runtimeFacts.commitCommand(commandTransaction.id);
        }
        return commandAck(true);
      }
      if (message.type === "toggleCollapsed") {
        await persistKnownNodeStateUpdate(current, result.state, message.nodeId);
        if (commandTransaction) {
          runtimeFacts.commitCommand(commandTransaction.id);
        }
        return commandAck(true);
      }
      if (message.type === "expandAncestors") {
        await persistKnownNodeStateUpdates(current, result.state, expandAncestorNodeIds ?? []);
        if (commandTransaction) {
          runtimeFacts.commitCommand(commandTransaction.id);
        }
        return commandAck(true);
      }
      await persistWithBestEffortPatch(current, result.state, { saveSchedule });
      if (commandTransaction) {
        runtimeFacts.commitCommand(commandTransaction.id);
      }
      markRuntimeLifecycleJournalEntryForClearAfterSave(runtimeLifecycleJournalEntry);
      return commandAck(true);
    }, { reason: "command", command: message.type });
  }

  async function runtimeClosePlanCompleted(plan: RuntimeClosePlan): Promise<boolean> {
    if (plan.windowIds.length === 0 && plan.tabIds.length === 0) {
      return true;
    }

    const windows = await getNormalWindows(api).catch(() => undefined);
    if (!windows) {
      return false;
    }

    const openWindowIds = new Set(windows.map((windowInfo) => windowInfo.id));
    if (plan.windowIds.some((windowId) => openWindowIds.has(windowId))) {
      return false;
    }

    const openTabIds = new Set(windows.flatMap((windowInfo) => windowInfo.tabs ?? []).map((tab) => tab.id));
    return plan.tabIds.every((tabId) => !openTabIds.has(tabId));
  }

  function runtimeLifecycleJournalEntryForCommand(
    command: BackgroundCommand,
    current: OutlineState,
    input: {
      outlinerClosePlan?: RuntimeClosePlan | undefined;
      deleteClosePlan?: RuntimeClosePlan | undefined;
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

    if (command.type === "deleteNode" && input.deleteClosePlan && !runtimeClosePlanIsEmpty(input.deleteClosePlan)) {
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
  ): RuntimeLifecycleJournalEntry | undefined {
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
  ): RuntimeLifecycleJournalEntry | undefined {
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
    if (!pendingSaveState && !pendingSaveHistory && !saveInFlight) {
      return;
    }
    await flushPendingSaves();
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
        ...(recent?.window?.sessionId ? { sessionId: recent.window.sessionId } : {})
      });
    }
    for (const tabId of plan.tabIds) {
      next = closeTab(next, tabId, {
        now: now(),
        ...(recent?.tab?.sessionId ? { sessionId: recent.tab.sessionId } : {})
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
  ): { kind: "newWindow" | "wrap" | "topLevel"; nodeId: NodeId; tabId: number; sourceWindowId: number; rootIndex?: number } | undefined {
    if (command.type === "moveNode" && command.parentId) {
      return undefined;
    }
    if (
      command.type !== "moveNode" &&
      command.type !== "moveNodeToNewWindow" &&
      command.type !== "wrapNodeInGroup" &&
      command.type !== "moveSubtreeToTopLevel"
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
        return nextStatus;
      } catch (error) {
        const nextStatus: AutomaticBackupStatus = {
          ...previousStatus,
          lastAttemptedBackupAt: attemptedAt,
          lastError: backupErrorText(error)
        };
        await saveAutomaticBackupStatus(nextStatus, api);
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

    const snapshot = await perfTrace.measureAsync("background.state.initialSnapshot.load", () =>
      loadInitialTreeSnapshot(api)
    );
    if (snapshot) {
      return snapshot;
    }

    return undefined;
  }

  function initialTreeSnapshotFromFullState(source: OutlineState, hydrating: boolean): InitialTreeSnapshot {
    const snapshot = initialTreeSnapshotForState(source, { hydrating });
    snapshot.hydrating = snapshot.projection.totalRowCount > snapshot.projection.rows.length;
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
    const snapshot = initialTreeSnapshotForState(source, {
      rowLimit,
      centerRowIndex: message.centerRowIndex,
      hydrating: true
    });
    snapshot.hydrating = snapshot.projection.totalRowCount > snapshot.projection.rows.length;
    return snapshot;
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
    const [windows, loaded, lifecycleJournal] = await Promise.all([
      perfTrace.measureAsync("background.runtime.getWindows", () => getNormalWindows(api)),
      perfTrace.measureAsync("background.state.load", () => loadStateWithMetadata(api, stateLoadTraceOptions())),
      loadRuntimeLifecycleJournal(api)
    ]);
    const stored = loaded?.state;
    let storedRuntimeMatch: RuntimeSnapshotMatch | undefined;
    let consumedRuntimeLifecycleJournalEntryIds: string[] = [];
    let runtimeLifecycleJournalChangedState = false;
    let runtimeLifecycleJournalChangedHistory = false;
    let completedOutlinerClosePlans: RuntimeClosePlan[] = [];
    let completedDeleteClosePlans: RuntimeClosePlan[] = [];
    if (stored) {
      const lifecycleRecoveryHistory = lifecycleJournal.entries.some((entry) => entry.kind === "history")
        ? await loadHistory(api)
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
      if (lifecycleRecovery.history) {
        historyState = lifecycleRecovery.history;
      }
      const startupBase = lifecycleRecovery.state;
      storedRuntimeMatch = runtimeSnapshotMateriallyMatchesState(startupBase, windows);
      if (storedRuntimeMatch.matches) {
        if (loaded.format === "v3" && !runtimeLifecycleJournalChangedState) {
          deferPersistedStateBaselineClone(startupBase);
        } else {
          lastPersistedState = undefined;
        }
        state = startupBase;
        if (runtimeLifecycleJournalChangedState || !statesMateriallyEqual(stored, state)) {
          scheduleStateSave(state);
        }
      } else {
        lastPersistedState = loaded.format === "v3" ? cloneOutlineState(stored) : undefined;
        const reconciled = reconcileWithWindows(startupBase, windows, { now: now() }, { respectRuntimeTabOrder: true });
        state = statesEqualIgnoringUpdatedAt(startupBase, reconciled) ? startupBase : reconciled;
        if (!statesMateriallyEqual(stored, state)) {
          scheduleStateSave(state);
        }
      }
    } else {
      state = bootstrapFromWindows(windows, { now: now() });
      scheduleStateSave(state);
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
      next = closeWindow(next, windowId, { now: now() });
    }
    for (const tabId of plan.tabIds) {
      next = closeTab(next, tabId, { now: now() });
    }
    return next;
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
    const replayed = preserveClosedNodesDuringHistoryReplay(current, applyOutlineDelta(current, entry.delta));
    const reconciled = reconcileWithWindows(replayed, windows, { now: now() }, { closeMissing: true });
    if (statesMateriallyEqual(current, reconciled)) {
      return { state: current };
    }
    return {
      state: reconciled,
      history: historyAfterJournalReplay(history, entry)
    };
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

  function stateLoadTraceOptions(): LoadStateOptions | undefined {
    if (!perfTrace.isEnabled()) {
      return undefined;
    }

    return {
      onPhase: (phase) => {
        perfTrace.mark(`background.state.load.${phase.name}`, stateLoadTraceDetail(phase));
      }
    };
  }

  function stateLoadTraceDetail(phase: StateLoadPhase): TraceDetail {
    return {
      durationMs: phase.durationMs,
      ...(phase.detail ?? {})
    };
  }

  async function recordHistoryEntry(
    commandType: TrackableHistoryCommandType,
    previous: OutlineState,
    next: OutlineState,
    options: { candidateNodeIds?: readonly NodeId[]; saveSchedule?: SaveSchedule } = {}
  ): Promise<void> {
    const entry = createHistoryEntry(commandType, previous, next, options);
    if (!entry) {
      return;
    }

    const activePreferences = await ensurePreferences();
    historyState = pushUndoEntry(await ensureHistory(), entry, activePreferences.undoHistoryLimit);
    scheduleHistorySave(historyState, options.saveSchedule);
    broadcastHistoryStatusSoon(historyState);
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
    let next: OutlineState;
    try {
      next = await applyHistoryDeltaWithRuntime(
        current,
        delta,
        popped.entry.commandType
      );
      runtimeFacts.recordCommandObserved(transaction.id);
    } catch (error) {
      runtimeFacts.rejectCommand(transaction.id);
      await clearRuntimeLifecycleJournalEntryNow(runtimeLifecycleJournalEntry);
      throw error;
    }
    runtimeFacts.clearRemovalTombstonesForLiveState(next);
    if (statesMateriallyEqual(current, next)) {
      historyState = popped.history;
      scheduleHistorySave(historyState, saveSchedule);
      broadcastHistoryStatusSoon(historyState);
      runtimeFacts.commitCommand(transaction.id);
      markRuntimeLifecycleJournalEntryForClearAfterSave(runtimeLifecycleJournalEntry);
      return commandAck(false);
    }

    runtimeFacts.recordCommandRelocatedTabs(current, next);
    installStateTransition(current, next, { rebuildRuntimeIndex: true });
    const activePreferences = await ensurePreferences();
    historyState = direction === "undo"
      ? pushRedoEntry(popped.history, popped.entry, activePreferences.undoHistoryLimit)
      : pushUndoEntryPreservingRedo(popped.history, popped.entry, activePreferences.undoHistoryLimit);
    await persistWithBestEffortPatch(current, next, { diffMode: "material", saveSchedule });
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

  async function applyHistoryDeltaWithRuntime(
    current: OutlineState,
    delta: OutlineDelta,
    commandType: TrackableHistoryCommandType
  ): Promise<OutlineState> {
    let next = preserveClosedNodesDuringHistoryReplay(current, applyOutlineDelta(current, delta));
    if (historyReplayMayDropCurrentLiveRuntimeResources(current, next, delta)) {
      const windowsBeforeReplay = await getNormalWindows(api);
      next = preserveCurrentLiveRuntimeResourcesDuringHistoryReplay(current, next, delta, windowsBeforeReplay);
    }
    next = guardHistoryReplayRuntimeLifecycle(
      current,
      next,
      commandType
    );
    const closedRuntimeResources = await closeDeletedLiveRuntimeResources(current, next);
    const materializedRuntimeResources = await materializeHistoryLiveResources(current, next);
    if (closedRuntimeResources || materializedRuntimeResources || liveStructureChanged(current, next)) {
      await syncBrowserOrder(next, adapter);
    }
    return reconcileHistoryReplayResultWithRuntime(next);
  }

  async function reconcileHistoryReplayResultWithRuntime(next: OutlineState): Promise<OutlineState> {
    const index = buildRuntimeStateIndex(next);
    const windowsSnapshot = await getNormalWindows(api);
    const windows = runtimeReconciler.normalizeSnapshot({
      windows: windowsSnapshot,
      state: next,
      index,
      ledger: runtimeFacts,
      confidence: "complete"
    });
    const reconciled = reconcileWithWindows(next, windows, { now: now() }, { closeMissing: true });
    return statesMateriallyEqual(next, reconciled) ? next : reconciled;
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

  async function materializeHistoryLiveResources(current: OutlineState, next: OutlineState): Promise<boolean> {
    let changed = false;
    const tabNodesCreatedWithWindow = new Set<NodeId>();

    for (const windowNode of liveWindowNodes(next)) {
      const currentWindow = current.nodes[windowNode.id];
      if (currentWindow && isLiveWindowNode(currentWindow)) {
        if (windowNode.live.windowId !== currentWindow.live.windowId) {
          replaceLiveWindowIdInSubtree(next, windowNode.id, currentWindow.live.windowId);
          changed = true;
        }
        continue;
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
      replaceLiveWindowIdInSubtree(next, windowNode.id, createdWindow.id);
      const createdTab = createdWindow.tabs?.[0];
      if (firstMissingTab && createdTab) {
        updateLiveTabRef(next, firstMissingTab.id, createdTab.id, createdWindow.id);
        const restoredNode = cloneNodeForHistoryMutation(next, firstMissingTab.id);
        if (restoredNode) {
          restoredNode.restoredFromClosed = true;
        }
        runtimeFacts.recordCommandRestoredTab(createdTab.id);
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
      runtimeFacts.recordCommandRestoredTab(created.id);
      changed = true;
    }

    return changed;
  }

  async function refreshFromRuntime(eventTabs: RuntimeTab[] = [], options: RefreshOptions = {}): Promise<boolean> {
    return enqueueMutation(async () => refreshFromRuntimeNow(eventTabs, options), { reason: "refreshFromRuntime" });
  }

  function queueRuntimeRefresh(eventTabs: RuntimeTab[] = [], options: RefreshOptions = {}): Promise<boolean> {
    const requestedCloseMissing = options.closeMissing ?? eventTabs.length === 0;
    const pending = pendingRuntimeRefresh ?? createPendingRuntimeRefresh();
    pendingRuntimeRefresh = pending;
    pending.closeMissing ||= requestedCloseMissing;
    pending.forceSnapshot ||= options.forceSnapshot === true;
    if (typeof options.focusWindowId === "number") {
      pending.focusWindowIds.add(options.focusWindowId);
    }

    for (const tab of eventTabs) {
      pending.eventTabsById.set(tab.id, tab);
    }

    const promise = addRuntimeRefreshCaller(pending);
    schedulePendingRuntimeRefresh(pending);
    return promise;
  }

  function queueRuntimeActivation(activeInfo: { tabId: number; windowId: number }): Promise<boolean> {
    const pendingTab = pendingRuntimeRefresh?.eventTabsById.get(activeInfo.tabId);
    if (pendingRuntimeRefresh && pendingTab) {
      pendingRuntimeRefresh.activationByWindowId.set(activeInfo.windowId, activeInfo.tabId);
      pendingRuntimeRefresh.eventTabsById.set(activeInfo.tabId, {
        ...pendingTab,
        active: true
      });
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
      const eventTabs = [...pending.eventTabsById.values()].map((tab) => {
        const activatedTabId = pending.activationByWindowId.get(tab.windowId);
        return typeof activatedTabId === "number"
          ? {
              ...tab,
              active: tab.id === activatedTabId
            }
          : tab;
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

  async function refreshFromRuntimeNow(eventTabs: RuntimeTab[] = [], options: RefreshOptions = {}): Promise<boolean> {
    const current = await ensureState();
    const closeMissing = options.closeMissing ?? eventTabs.length === 0;
    const index = runtimeIndexForState(current);
    const currentEventTabs = runtimeReconciler.filterEventTabsForReconciliation({
      eventTabs,
      state: current,
      index,
      ledger: runtimeFacts
    });
    const allEventTabsWereRelocatedStaleEchoes = eventTabs.length > 0 && eventTabs.every((tab) =>
      runtimeReconciler.isCommandRelocatedStaleTabEvent(current, index, runtimeFacts, tab)
    );
    const allEventTabsWereCommandRestoredAbsorbableEchoes = eventTabs.length > 0 && eventTabs.every((tab) =>
      runtimeReconciler.isCommandRestoredAbsorbableTabEvent(current, index, runtimeFacts, tab)
    );
    const inactiveEventInWindowWithoutKnownActiveTab = eventTabs.some((tab) =>
      !tab.active &&
      !index.activeTabNodeIdsByWindowId.has(tab.windowId) &&
      !runtimeFacts.isTabIgnoredForRefresh(tab.id) &&
      !runtimeFacts.isWindowIgnoredForRefresh(tab.windowId) &&
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
    const restoredEventNeedsShapeCorroboration = runtimeReconciler.eventTabsNeedShapeCorroboration({
      eventTabs: currentEventTabs,
      state: current,
      index,
      ledger: runtimeFacts
    });
    if (
      !closeMissing &&
      currentEventTabs.length > 0 &&
      options.forceSnapshot !== true &&
      !restoredEventNeedsShapeCorroboration
    ) {
      const fastPath = await applyRuntimeEventTabsFastPath(current, currentEventTabs, index);
      if (fastPath.handled) {
        if (!fastPath.changed) {
          return false;
        }
        state = fastPath.state;
        stateCache.replace(state);
        runtimeIndex = fastPath.index;
        await persistKnownRuntimeFastPathUpdate(fastPath.update, state);
        return true;
      }
    }
    const windowsSnapshot = await perfTrace.measureAsync("background.runtime.getWindows", {
      eventTabCount: currentEventTabs.length
    }, () => currentEventTabs.length > 0
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
    if (currentEventTabs.length > 0 || (closeMissing && currentEventTabs.length === 0)) {
      windows = await corroborateMissingOrMismatchedLiveTabs(current, index, windows);
    }
    if (runtimeSnapshotMateriallyMatchesState(current, windows).matches) {
      return false;
    }
    const next = reconcileWithWindows(current, windows, { now: now() }, {
      closeMissing,
      respectRuntimeTabOrder: true
    });
    if (statesMateriallyEqual(current, next)) {
      return false;
    }
    installStateTransition(current, next, { rebuildRuntimeIndex: true });
    await persistWithBestEffortPatch(current, next, { diffMode: "material" });
    return state !== current;
  }

  async function corroborateMissingOrMismatchedLiveTabs(
    current: OutlineState,
    index: RuntimeStateIndex,
    windows: RuntimeWindow[]
  ): Promise<RuntimeWindow[]> {
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
    const orderMismatchedWindowIds = runtimeReconciler.orderMismatchedWindowIdsInWindows({
      windows,
      state: current,
      index,
      ledger: runtimeFacts
    });
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
    const corroboratedOrderMismatchedWindowIds = new Set(runtimeReconciler.orderMismatchedWindowIdsInWindows({
      windows: corroboratingWindows,
      state: current,
      index,
      ledger: runtimeFacts
    }));
    const contradicted = missingTabIds.some((tabId) => !corroboratedMissingTabIds.has(tabId)) ||
      mismatchedTabIds.some((tabId) => !corroboratedMismatchedTabIds.has(tabId)) ||
      suspiciousShapeTabIds.some((tabId) => !corroboratedSuspiciousShapeTabIds.has(tabId)) ||
      orderMismatchedWindowIds.some((windowId) => !corroboratedOrderMismatchedWindowIds.has(windowId));

    return contradicted ? corroboratingWindows : windows;
  }

  async function applyRuntimeEventTabsFastPath(
    current: OutlineState,
    eventTabs: RuntimeTab[],
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
      if (typeof tab.openerTabId !== "number") {
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
        live: { windowId: windowInfo.id }
      });
      changedNodeIds.add(windowNodeId);
      structuralChanged = true;
      rootIdsForPlan().push(windowNodeId);
      liveWindowNodeIdAdditions.set(windowInfo.id, windowNodeId);
      liveTabNodeIdsByWindowAdditions.set(windowInfo.id, new Set());
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

    const activateTabForRuntimeFastPath = (windowId: number, activeTabNodeId: NodeId): void => {
      const previousActiveTabNodeId = plannedActiveTabNodeId(windowId);
      if (previousActiveTabNodeId && previousActiveTabNodeId !== activeTabNodeId) {
        const previousActiveTab = nodeForPlan(previousActiveTabNodeId);
        if (previousActiveTab?.active !== false) {
          const mutablePreviousActiveTab = mutableNodeForPlan(previousActiveTabNodeId);
          if (mutablePreviousActiveTab) {
            mutablePreviousActiveTab.active = false;
          }
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

    for (const tab of eventTabs) {
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
          activateTabForRuntimeFastPath(tab.windowId, existingTabNodeId);
        } else if (wasActive) {
          return { handled: false };
        }
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
      parentNode.childIds.push(tabNodeId);
      plannedNodes.set(tabNodeId, runtimeTabNodeForFastPath(tab, tabNodeId, parentId, now()));
      changedNodeIds.add(tabNodeId);
      structuralChanged = true;
      liveTabNodeIdAdditions.set(tab.id, tabNodeId);
      addPlannedWindowTabNodeId(tab.windowId, tabNodeId);
      if (tab.active) {
        activateTabForRuntimeFastPath(tab.windowId, tabNodeId);
      }
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
      update
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
    options: { candidateNodeIds?: readonly NodeId[] | undefined; rebuildRuntimeIndex?: boolean } = {}
  ): void {
    state = next;
    stateCache.replace(next);
    if (options.rebuildRuntimeIndex) {
      runtimeIndex = buildRuntimeStateIndex(next);
      return;
    }
    runtimeIndex = runtimeIndexForStateTransition(previous, next, runtimeIndex, options.candidateNodeIds);
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
      stateCache.replace(current);
      runtimeIndex = index;
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
      stateCache.replace(current);
      runtimeIndex = index;
      await broadcastActiveStateUpdate(focus.updates);
      return true;
    }, { reason: "commandWindowFocus" });
  }

  function enqueueMutation<T>(
    operation: () => Promise<T>,
    detail?: TraceDetail,
    options: { priority?: MutationPriority } = {}
  ): Promise<T> {
    const priority = options.priority ?? "high";
    const queuedAt = performance.now();
    const mutationDetail = detail ? { ...detail } : undefined;
    const promise = new Promise<T>((resolve, reject) => {
      const mutation: ScheduledMutation<T> = {
        operation,
        detail: mutationDetail,
        priority,
        queuedAt,
        resolve,
        reject
      };
      if (priority === "high") {
        highPriorityMutations.push(mutation as ScheduledMutation);
      } else {
        lowPriorityMutations.push(mutation as ScheduledMutation);
      }
      scheduleMutationDrain();
    });
    return promise;
  }

  function scheduleMutationDrain(): void {
    if (schedulerRunning || schedulerDrainQueued) {
      return;
    }
    schedulerDrainQueued = true;
    void Promise.resolve().then(runScheduledMutations);
  }

  async function runScheduledMutations(): Promise<void> {
    if (schedulerRunning) {
      schedulerDrainQueued = false;
      return;
    }

    schedulerDrainQueued = false;
    schedulerRunning = true;
    try {
      for (;;) {
        const mutation = highPriorityMutations.shift() ?? lowPriorityMutations.shift();
        if (!mutation) {
          return;
        }
        await runScheduledMutation(mutation);
      }
    } finally {
      schedulerRunning = false;
      if (highPriorityMutations.length > 0 || lowPriorityMutations.length > 0) {
        scheduleMutationDrain();
      } else {
        notifySchedulerIdleIfNeeded();
      }
    }
  }

  async function runScheduledMutation(mutation: ScheduledMutation): Promise<void> {
    const mutationDetail = {
      ...mutation.detail,
      priority: mutation.priority
    };
    perfTrace.mark("background.mutation.start", {
      ...mutationDetail,
      waitMs: Math.round(performance.now() - mutation.queuedAt)
    });
    try {
      const result = await perfTrace.measureAsync("background.mutation.run", mutationDetail, mutation.operation);
      mutation.resolve(result);
    } catch (error) {
      mutation.reject(error);
    }
  }

  function waitForSchedulerIdle(): Promise<void> {
    if (isSchedulerIdle()) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      schedulerIdleResolvers.push(resolve);
    });
  }

  function isSchedulerIdle(): boolean {
    return !schedulerRunning &&
      !schedulerDrainQueued &&
      highPriorityMutations.length === 0 &&
      lowPriorityMutations.length === 0 &&
      !pendingRuntimeRefresh;
  }

  function notifySchedulerIdleIfNeeded(): void {
    if (!isSchedulerIdle() || schedulerIdleResolvers.length === 0) {
      return;
    }

    const resolvers = schedulerIdleResolvers.splice(0);
    for (const resolve of resolvers) {
      resolve();
    }
  }

  async function persistAndBroadcast(saveSchedule: SaveSchedule = "normal"): Promise<void> {
    if (!state) {
      return;
    }
    await broadcastWithTrace({ type: "stateUpdated", state });
    scheduleStateSave(state, saveSchedule);
  }

  async function persistWithNodeStateUpdate(
    previous: OutlineState,
    next: OutlineState,
    candidateNodeIds?: readonly NodeId[],
    options: { saveSchedule?: SaveSchedule } = {}
  ): Promise<void> {
    const update = perfTrace.measure("background.patch.build.nodeState", {
      candidateNodeCount: candidateNodeIds?.length ?? 0
    }, () => candidateNodeIds
      ? nodeStateUpdateForNodeIds(previous, next, candidateNodeIds)
      : nodeStateUpdateFromStateChange(previous, next));
    if (isUsefulNodeStateUpdate(update, next)) {
      await broadcastNodeStateUpdate(update);
      scheduleStateSave(next, options.saveSchedule, candidateNodeIds);
      return;
    }

    await persistWithBestEffortPatch(previous, next, {
      diffMode: "material",
      skipNodeState: true,
      ...(options.saveSchedule ? { saveSchedule: options.saveSchedule } : {})
    });
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
  ): Promise<void> {
    const diffMode = options.diffMode ?? "identity";
    if (!options.skipNodeState) {
      const nodeUpdate = perfTrace.measure("background.patch.build.nodeState", {
        candidateNodeCount: 0,
        diffMode
      }, () => nodeStateUpdateFromStateChange(previous, next, { diffMode }));
      if (isUsefulNodeStateUpdate(nodeUpdate, next)) {
        await broadcastNodeStateUpdate(nodeUpdate);
        scheduleStateSave(next, options.saveSchedule);
        return;
      }
    }

    const treeUpdate = perfTrace.measure("background.patch.build.treeStructure", { diffMode }, () =>
      treeStructureUpdateFromStateChange(previous, next, { diffMode })
    );
    if (isUsefulTreeStructureUpdate(treeUpdate, next)) {
      await broadcastTreeStructureUpdate(treeUpdate);
      scheduleStateSave(next, options.saveSchedule);
      return;
    }

    if (!options.skipNodeState && diffMode !== "material") {
      const nodeUpdate = perfTrace.measure("background.patch.build.nodeState", {
        candidateNodeCount: 0,
        diffMode: "material"
      }, () => nodeStateUpdateFromStateChange(previous, next, { diffMode: "material" }));
      if (isUsefulNodeStateUpdate(nodeUpdate, next)) {
        await broadcastNodeStateUpdate(nodeUpdate);
        scheduleStateSave(next, options.saveSchedule);
        return;
      }
    }

    const semanticTreeUpdate = diffMode === "material"
      ? treeUpdate
      : perfTrace.measure("background.patch.build.treeStructure", { diffMode: "material" }, () =>
        treeStructureUpdateFromStateChange(previous, next, { diffMode: "material" })
      );
    if (diffMode !== "material" && isUsefulTreeStructureUpdate(semanticTreeUpdate, next)) {
      await broadcastTreeStructureUpdate(semanticTreeUpdate);
      scheduleStateSave(next, options.saveSchedule);
      return;
    }

    await persistAndBroadcast(options.saveSchedule);
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
    await broadcastWithTrace({ type: "activeStateUpdated", updates });
  }

  async function broadcastTreeStructureUpdate(update: TreeStructureUpdate): Promise<void> {
    await broadcastWithTrace(update);
  }

  async function broadcastNodeStateUpdate(update: NodeStateUpdate): Promise<void> {
    if (update.updatedNodes.length === 0) {
      return;
    }
    await broadcastWithTrace(update);
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
    await broadcastWithTrace(historyStatusMessage(history));
  }

  function broadcastHistoryStatusSoon(history: HistoryState): void {
    void broadcastHistoryStatus(history).catch((error) => {
      perfTrace.mark("background.runtime.broadcast.historyStatus.error", { message: errorText(error) });
    });
  }

  function scheduleStateSave(
    next: OutlineState,
    schedule: SaveSchedule = "normal",
    candidateNodeIds?: readonly NodeId[]
  ): void {
    pendingSaveState = next;
    if (candidateNodeIds) {
      if (!pendingSaveRequiresFullDiff) {
        pendingSaveCandidateNodeIds ??= new Set<NodeId>();
        for (const nodeId of candidateNodeIds) {
          pendingSaveCandidateNodeIds.add(nodeId);
        }
      }
    } else {
      pendingSaveCandidateNodeIds = undefined;
      pendingSaveRequiresFullDiff = true;
    }
    schedulePendingSave(schedule);
  }

  function scheduleHistorySave(next: HistoryState, schedule: SaveSchedule = "normal"): void {
    pendingSaveHistory = next;
    schedulePendingSave(schedule);
  }

  function schedulePendingSave(schedule: SaveSchedule = "normal"): void {
    if (saveInFlight) {
      saveAfterInFlight = true;
      saveAfterInFlightSchedule = moreDeferredSaveSchedule(saveAfterInFlightSchedule, schedule);
      return;
    }

    pendingSaveSchedule = moreDeferredSaveSchedule(pendingSaveSchedule ?? "normal", schedule);
    const timing = saveScheduleTiming(pendingSaveSchedule);
    const scheduledAt = performance.now();
    pendingSaveBatchStartedAt ??= scheduledAt;
    pendingSaveMaxDelayMs = Math.max(pendingSaveMaxDelayMs ?? 0, timing.maxDelayMs);

    if (saveTimer !== undefined) {
      globalThis.clearTimeout(saveTimer);
    }
    saveTimer = globalThis.setTimeout(() => {
      void flushScheduledSave();
    }, timing.quietDelayMs);

    if (saveMaxTimer !== undefined) {
      globalThis.clearTimeout(saveMaxTimer);
    }
    saveMaxTimer = globalThis.setTimeout(() => {
      void flushScheduledSave();
    }, Math.max(0, pendingSaveBatchStartedAt + pendingSaveMaxDelayMs - scheduledAt));
  }

  async function flushPendingSaves(): Promise<void> {
    clearSaveTimers();

    const previousExplicitSaveFlushInProgress = explicitSaveFlushInProgress;
    explicitSaveFlushInProgress = true;
    try {
      while (pendingSaveState || pendingSaveHistory || saveInFlight) {
        if (saveInFlight) {
          await saveInFlight;
          continue;
        }

        const nextState = pendingSaveState;
        const nextHistory = pendingSaveHistory;
        const nextCandidateNodeIds = pendingSaveRequiresFullDiff
          ? undefined
          : [...(pendingSaveCandidateNodeIds ?? [])];
        if (!nextState && !nextHistory) {
          return;
        }
        pendingSaveState = undefined;
        pendingSaveHistory = undefined;
        pendingSaveCandidateNodeIds = undefined;
        pendingSaveRequiresFullDiff = false;
        saveAfterInFlight = false;
        await startSaveStateAndHistory(nextState, nextHistory, nextCandidateNodeIds);
      }
    } finally {
      explicitSaveFlushInProgress = previousExplicitSaveFlushInProgress;
      if (saveAfterInFlight) {
        const schedule = saveAfterInFlightSchedule;
        saveAfterInFlight = false;
        saveAfterInFlightSchedule = "normal";
        if (!explicitSaveFlushInProgress && (pendingSaveState || pendingSaveHistory)) {
          schedulePendingSave(schedule);
        }
      }
    }
  }

  async function flushScheduledSave(): Promise<void> {
    try {
      clearSaveTimers();
      if (saveInFlight) {
        saveAfterInFlight = true;
        return;
      }

      const nextState = pendingSaveState;
      const nextHistory = pendingSaveHistory;
      const nextCandidateNodeIds = pendingSaveRequiresFullDiff
        ? undefined
        : [...(pendingSaveCandidateNodeIds ?? [])];
      if (!nextState && !nextHistory) {
        return;
      }

      pendingSaveState = undefined;
      pendingSaveHistory = undefined;
      pendingSaveCandidateNodeIds = undefined;
      pendingSaveRequiresFullDiff = false;
      await startSaveStateAndHistory(nextState, nextHistory, nextCandidateNodeIds);
    } catch (error) {
      perfTrace.mark("background.state.save.error", { message: errorText(error) });
    }
  }

  function clearSaveTimers(): void {
    if (saveTimer !== undefined) {
      globalThis.clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    if (saveMaxTimer !== undefined) {
      globalThis.clearTimeout(saveMaxTimer);
      saveMaxTimer = undefined;
    }
    pendingSaveBatchStartedAt = undefined;
    pendingSaveMaxDelayMs = undefined;
    pendingSaveSchedule = undefined;
  }

  function saveScheduleTiming(schedule: SaveSchedule): { quietDelayMs: number; maxDelayMs: number } {
    return schedule === "interaction"
      ? {
          quietDelayMs: INTERACTION_STATE_SAVE_QUIET_DELAY_MS,
          maxDelayMs: INTERACTION_STATE_SAVE_MAX_DELAY_MS
        }
      : {
          quietDelayMs: STATE_SAVE_QUIET_DELAY_MS,
          maxDelayMs: STATE_SAVE_MAX_DELAY_MS
        };
  }

  function moreDeferredSaveSchedule(left: SaveSchedule, right: SaveSchedule): SaveSchedule {
    return left === "interaction" || right === "interaction" ? "interaction" : "normal";
  }

  async function saveStateAndHistoryNowWithTrace(
    nextState: OutlineState | undefined,
    nextHistory: HistoryState | undefined,
    candidateNodeIds?: readonly NodeId[]
  ): Promise<void> {
    await perfTrace.measureAsync("background.state.save", () =>
      saveStateAndHistory(nextState, nextHistory, api, {
        ...(nextState && lastPersistedState ? { previousState: lastPersistedState } : {}),
        ...(nextState && candidateNodeIds ? { candidateNodeIds } : {})
      })
    );
    if (nextState) {
      deferPersistedStateBaselineClone(nextState);
    }
    if (nextState || nextHistory) {
      await clearCompletedRuntimeLifecycleJournalEntriesAfterSave();
    }
  }

  async function clearCompletedRuntimeLifecycleJournalEntriesAfterSave(): Promise<void> {
    if (runtimeLifecycleJournalEntryIdsToClearAfterSave.size === 0) {
      return;
    }
    const entryIds = [...runtimeLifecycleJournalEntryIdsToClearAfterSave];
    await clearRuntimeLifecycleJournalEntries(api, entryIds);
    for (const entryId of entryIds) {
      runtimeLifecycleJournalEntryIdsToClearAfterSave.delete(entryId);
    }
  }

  function startSaveStateAndHistory(
    nextState: OutlineState | undefined,
    nextHistory: HistoryState | undefined,
    candidateNodeIds?: readonly NodeId[]
  ): Promise<void> {
    saveInFlight = saveStateAndHistoryNowWithTrace(nextState, nextHistory, candidateNodeIds).finally(() => {
      saveInFlight = undefined;
      if (saveAfterInFlight) {
        const schedule = saveAfterInFlightSchedule;
        saveAfterInFlight = false;
        saveAfterInFlightSchedule = "normal";
        if (!explicitSaveFlushInProgress && (pendingSaveState || pendingSaveHistory)) {
          schedulePendingSave(schedule);
        }
      }
    });
    return saveInFlight;
  }

  function broadcastWithTrace(message: { type: string } & Record<string, unknown>): void {
    perfTrace.measure("background.runtime.broadcast", { type: message.type }, () => {
      postSidebarMessage(message);
    });
  }

  function postSidebarMessage(message: { type: string } & Record<string, unknown>): void {
    if (sidebarPorts.size > 0) {
      postMessageToSidebarPorts(message);
      return;
    }

    postFallbackRuntimeMessage(message);
  }

  function postMessageToSidebarPorts(message: { type: string } & Record<string, unknown>): void {
    for (const port of [...sidebarPorts]) {
      try {
        port.postMessage(message);
      } catch (error) {
        sidebarPorts.delete(port);
        perfTrace.mark("background.runtime.port.post.error", {
          type: message.type,
          message: errorText(error)
        });
      }
    }
  }

  function postFallbackRuntimeMessage(message: { type: string } & Record<string, unknown>): void {
    try {
      void api.runtime.sendMessage(message).catch((error) => {
        perfTrace.mark("background.runtime.broadcast.error", {
          type: message.type,
          message: errorText(error)
        });
      });
    } catch (error) {
      perfTrace.mark("background.runtime.broadcast.error", {
        type: message.type,
        message: errorText(error)
      });
    }
  }

  function getDiagnosticsCoalesced(): Promise<OutlineDiagnostics> {
    diagnosticsInFlight ??= perfTrace.measureAsync("background.diagnostics", async () => {
      await waitForSchedulerIdle();
      return computeDiagnostics(await ensureState(), await getNormalWindows(api));
    }).finally(() => {
      diagnosticsInFlight = undefined;
    });
    return diagnosticsInFlight;
  }

  async function handlePerformanceTraceMessage(
    message: PerformanceTraceMessage
  ): Promise<TraceSnapshot | PerformanceProfileSnapshot | { ok: true }> {
    if (message.type === "setPerformanceTraceEnabled") {
      if (message.enabled) {
        perfTrace.setEnabled(true);
        perfTrace.mark("background.profile.enabled");
      } else {
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
    return {
      background,
      sidebars: await collectSidebarPerformanceTraces()
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
      postSidebarMessage({ type: "collectSidebarPerformanceTrace", requestId });
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
    postSidebarMessage({ type: "setSidebarPerformanceTraceEnabled", enabled });
  }

  function clearSidebarPerformanceTrace(): void {
    postSidebarMessage({ type: "clearSidebarPerformanceTrace" });
  }

  async function reconcileMissingLiveTabsInOpenWindows(): Promise<ReconciledStateChange | undefined> {
    const current = await ensureState();
    const index = runtimeIndexForState(current);
    const windows = runtimeReconciler.normalizeSnapshot({
      windows: await getNormalWindows(api),
      state: current,
      index,
      ledger: runtimeFacts,
      confidence: "partial"
    });
    const missingLiveTabIds = runtimeReconciler.missingLiveTabIdsInOpenWindows({
      windows,
      state: current,
      ledger: runtimeFacts
    });
    if (missingLiveTabIds.length === 0) {
      return undefined;
    }

    let next = current;
    for (const tabId of missingLiveTabIds) {
      runtimeFacts.recordMissingLiveTab(tabId);
      const removal = runtimeReconciler.classifyMissingLiveTabRemoval(next, runtimeFacts, tabId);
      if (removal === "close-outliner-tab") {
        const recent = await mostRecentClosedSession();
        next = closeTab(next, tabId, {
          now: now(),
          ...(recent?.tab?.sessionId ? { sessionId: recent.tab.sessionId } : {})
        });
      } else {
        next = deleteLiveTabNodeByTabId(next, tabId);
      }
    }

    installStateTransition(current, next, { rebuildRuntimeIndex: true });
    return next !== current ? { previous: current, next } : undefined;
  }

  async function mostRecentClosedSession(): Promise<{ tab?: { sessionId?: string }; window?: { sessionId?: string } } | undefined> {
    const sessions = await api.sessions.getRecentlyClosed({ maxResults: 1 }).catch(() => []);
    return sessions[0];
  }

  return {
    ensureState,
    handleMessage,
    refreshFromRuntime,
    flushPendingSaves,
    __debugRuntimeIndexStatus(): { warm: boolean; matchesState: boolean; reason: string } {
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
  };
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

function buildRuntimeStateIndex(state: OutlineState): RuntimeStateIndex {
  const index: RuntimeStateIndex = {
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

  const visited = new Set<NodeId>();
  const stack: Array<{ nodeId: NodeId; ownerWindowNodeId?: NodeId }> = state.rootIds.map((nodeId) => ({ nodeId }));
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (visited.has(entry.nodeId)) {
      continue;
    }
    visited.add(entry.nodeId);

    const node = state.nodes[entry.nodeId];
    if (!node) {
      continue;
    }

    const ownerWindowNodeId = node.kind === "window" ? node.id : entry.ownerWindowNodeId;
    if (ownerWindowNodeId && node.id !== ownerWindowNodeId && node.kind === "tab" && node.status === "closed") {
      const count = index.closedRestoreCandidateCountsByWindowNodeId.get(ownerWindowNodeId) ?? 0;
      index.closedRestoreCandidateCountsByWindowNodeId.set(ownerWindowNodeId, count + 1);
      index.windowNodeIdsWithClosedRestoreCandidates.add(ownerWindowNodeId);
    }

    for (const childId of node.childIds) {
      stack.push({
        nodeId: childId,
        ...(ownerWindowNodeId ? { ownerWindowNodeId } : {})
      });
    }
  }

  return index;
}

function buildRuntimeStateIndexFromLookup(state: OutlineState, lookup: OutlineLookup): RuntimeStateIndex {
  const index: RuntimeStateIndex = {
    state,
    liveTabNodeIdsByRuntimeId: new Map(),
    liveWindowNodeIdsByRuntimeId: new Map(),
    liveTabNodeIdsByWindowId: new Map(),
    activeTabNodeIdsByWindowId: new Map(),
    closedRestoreCandidateCountsByWindowNodeId: new Map(),
    windowNodeIdsWithClosedRestoreCandidates: new Set()
  };

  for (const [runtimeWindowId, nodeId] of lookup.liveWindowNodeIdsByRuntimeId) {
    const node = state.nodes[nodeId];
    if (!isLiveWindowNode(node)) {
      continue;
    }
    index.liveWindowNodeIdsByRuntimeId.set(runtimeWindowId, nodeId);
    if (node.active) {
      index.activeWindowNodeId = nodeId;
    }
  }

  for (const [runtimeTabId, nodeId] of lookup.liveTabNodeIdsByRuntimeId) {
    const node = state.nodes[nodeId];
    if (!isLiveTabNode(node)) {
      continue;
    }
    index.liveTabNodeIdsByRuntimeId.set(runtimeTabId, nodeId);
    const windowTabNodeIds = index.liveTabNodeIdsByWindowId.get(node.live.windowId) ?? new Set<NodeId>();
    windowTabNodeIds.add(nodeId);
    index.liveTabNodeIdsByWindowId.set(node.live.windowId, windowTabNodeIds);
    if (node.active) {
      index.activeTabNodeIdsByWindowId.set(node.live.windowId, nodeId);
    }
  }

  index.closedRestoreCandidateCountsByWindowNodeId = new Map(lookup.closedRestoreCandidateCountsByWindowNodeId);
  index.windowNodeIdsWithClosedRestoreCandidates = new Set(lookup.windowNodeIdsWithClosedRestoreCandidates);

  return index;
}

function runtimeIndexForStateTransition(
  previous: OutlineState,
  next: OutlineState,
  index: RuntimeStateIndex | undefined,
  candidateNodeIds?: readonly NodeId[]
): RuntimeStateIndex {
  if (!index || index.state !== previous || !candidateNodeIds) {
    return buildRuntimeStateIndex(next);
  }

  const candidates = new Set(candidateNodeIds);
  if (index.activeWindowNodeId) {
    candidates.add(index.activeWindowNodeId);
  }
  for (const activeTabNodeId of index.activeTabNodeIdsByWindowId.values()) {
    candidates.add(activeTabNodeId);
  }

  for (const nodeId of candidates) {
    const previousNode = previous.nodes[nodeId];
    if (previousNode) {
      updateRuntimeIndexClosedRestoreCandidateCount(index, previous, previousNode, -1);
      removeRuntimeIndexNode(index, previousNode);
    }
  }
  for (const nodeId of candidates) {
    const nextNode = next.nodes[nodeId];
    if (nextNode) {
      updateRuntimeIndexClosedRestoreCandidateCount(index, next, nextNode, 1);
      addRuntimeIndexNode(index, nextNode);
    }
  }
  pruneRuntimeIndexWindowTabSets(index, next);
  pruneRuntimeIndexClosedRestoreCandidates(index, next);
  index.state = next;
  return index;
}

function pruneRuntimeIndexWindowTabSets(index: RuntimeStateIndex, state: OutlineState): void {
  for (const [windowId, nodeIds] of index.liveTabNodeIdsByWindowId) {
    const windowNodeId = index.liveWindowNodeIdsByRuntimeId.get(windowId);
    const windowNode = windowNodeId ? state.nodes[windowNodeId] : undefined;
    if (nodeIds.size === 0 || !isLiveWindowNode(windowNode)) {
      index.liveTabNodeIdsByWindowId.delete(windowId);
    }
  }
}

function runtimeStateIndexMismatchReason(actual: RuntimeStateIndex, expected: RuntimeStateIndex): string | undefined {
  return mapMismatchReason(
    actual.liveTabNodeIdsByRuntimeId,
    expected.liveTabNodeIdsByRuntimeId,
    "liveTabNodeIdsByRuntimeId"
  ) ??
    mapMismatchReason(
      actual.liveWindowNodeIdsByRuntimeId,
      expected.liveWindowNodeIdsByRuntimeId,
      "liveWindowNodeIdsByRuntimeId"
    ) ??
    setMapMismatchReason(
      actual.liveTabNodeIdsByWindowId,
      expected.liveTabNodeIdsByWindowId,
      "liveTabNodeIdsByWindowId"
    ) ??
    mapMismatchReason(
      actual.activeTabNodeIdsByWindowId,
      expected.activeTabNodeIdsByWindowId,
      "activeTabNodeIdsByWindowId"
    ) ??
    mapMismatchReason(
      actual.closedRestoreCandidateCountsByWindowNodeId,
      expected.closedRestoreCandidateCountsByWindowNodeId,
      "closedRestoreCandidateCountsByWindowNodeId"
    ) ??
    setMismatchReason(
      actual.windowNodeIdsWithClosedRestoreCandidates,
      expected.windowNodeIdsWithClosedRestoreCandidates,
      "windowNodeIdsWithClosedRestoreCandidates"
    ) ??
    (actual.activeWindowNodeId === expected.activeWindowNodeId
      ? undefined
      : `activeWindowNodeId expected ${expected.activeWindowNodeId ?? "none"} got ${actual.activeWindowNodeId ?? "none"}`);
}

function mapMismatchReason<K, V>(actual: Map<K, V>, expected: Map<K, V>, label: string): string | undefined {
  if (actual.size !== expected.size) {
    return `${label} size expected ${expected.size} got ${actual.size}`;
  }
  for (const [key, expectedValue] of expected) {
    if (actual.get(key) !== expectedValue) {
      return `${label} mismatch for ${String(key)}`;
    }
  }
  return undefined;
}

function setMapMismatchReason<K, V>(
  actual: Map<K, Set<V>>,
  expected: Map<K, Set<V>>,
  label: string
): string | undefined {
  if (actual.size !== expected.size) {
    return `${label} size expected ${expected.size} got ${actual.size}`;
  }
  for (const [key, expectedSet] of expected) {
    const actualSet = actual.get(key);
    if (!actualSet) {
      return `${label} missing ${String(key)}`;
    }
    const reason = setMismatchReason(actualSet, expectedSet, `${label}.${String(key)}`);
    if (reason) {
      return reason;
    }
  }
  return undefined;
}

function setMismatchReason<V>(actual: Set<V>, expected: Set<V>, label: string): string | undefined {
  if (actual.size !== expected.size) {
    return `${label} size expected ${expected.size} got ${actual.size}`;
  }
  for (const value of expected) {
    if (!actual.has(value)) {
      return `${label} missing ${String(value)}`;
    }
  }
  return undefined;
}

function removeRuntimeIndexNode(index: RuntimeStateIndex, node: OutlineNode): void {
  if (isLiveWindowNode(node)) {
    if (index.liveWindowNodeIdsByRuntimeId.get(node.live.windowId) === node.id) {
      index.liveWindowNodeIdsByRuntimeId.delete(node.live.windowId);
    }
    if (index.activeWindowNodeId === node.id) {
      delete index.activeWindowNodeId;
    }
    return;
  }

  if (!isLiveTabNode(node)) {
    return;
  }

  if (index.liveTabNodeIdsByRuntimeId.get(node.live.tabId) === node.id) {
    index.liveTabNodeIdsByRuntimeId.delete(node.live.tabId);
  }
  const windowTabNodeIds = index.liveTabNodeIdsByWindowId.get(node.live.windowId);
  windowTabNodeIds?.delete(node.id);
  if (windowTabNodeIds?.size === 0) {
    index.liveTabNodeIdsByWindowId.delete(node.live.windowId);
  }
  if (index.activeTabNodeIdsByWindowId.get(node.live.windowId) === node.id) {
    index.activeTabNodeIdsByWindowId.delete(node.live.windowId);
  }
}

function addRuntimeIndexNode(index: RuntimeStateIndex, node: OutlineNode): void {
  if (isLiveWindowNode(node)) {
    index.liveWindowNodeIdsByRuntimeId.set(node.live.windowId, node.id);
    index.liveTabNodeIdsByWindowId.set(
      node.live.windowId,
      index.liveTabNodeIdsByWindowId.get(node.live.windowId) ?? new Set()
    );
    if (node.active) {
      index.activeWindowNodeId = node.id;
    }
    return;
  }

  if (!isLiveTabNode(node)) {
    return;
  }

  index.liveTabNodeIdsByRuntimeId.set(node.live.tabId, node.id);
  const windowTabNodeIds = index.liveTabNodeIdsByWindowId.get(node.live.windowId) ?? new Set<NodeId>();
  windowTabNodeIds.add(node.id);
  index.liveTabNodeIdsByWindowId.set(node.live.windowId, windowTabNodeIds);
  if (node.active) {
    index.activeTabNodeIdsByWindowId.set(node.live.windowId, node.id);
  }
}

function updateRuntimeIndexClosedRestoreCandidateCount(
  index: RuntimeStateIndex,
  state: OutlineState,
  node: OutlineNode,
  delta: 1 | -1
): void {
  if (node.kind !== "tab" || node.status !== "closed") {
    return;
  }

  const windowNodeId = nearestWindowNodeId(state, node.id);
  if (!windowNodeId) {
    return;
  }

  const count = (index.closedRestoreCandidateCountsByWindowNodeId.get(windowNodeId) ?? 0) + delta;
  if (count > 0) {
    index.closedRestoreCandidateCountsByWindowNodeId.set(windowNodeId, count);
    index.windowNodeIdsWithClosedRestoreCandidates.add(windowNodeId);
    return;
  }

  index.closedRestoreCandidateCountsByWindowNodeId.delete(windowNodeId);
  index.windowNodeIdsWithClosedRestoreCandidates.delete(windowNodeId);
}

function pruneRuntimeIndexClosedRestoreCandidates(index: RuntimeStateIndex, state: OutlineState): void {
  for (const windowNodeId of index.windowNodeIdsWithClosedRestoreCandidates) {
    const windowNode = state.nodes[windowNodeId];
    if (!windowNode || windowNode.kind !== "window") {
      index.closedRestoreCandidateCountsByWindowNodeId.delete(windowNodeId);
      index.windowNodeIdsWithClosedRestoreCandidates.delete(windowNodeId);
    }
  }
}

function nearestWindowNodeId(state: OutlineState, nodeId: NodeId): NodeId | undefined {
  const visited = new Set<NodeId>();
  let current = state.nodes[nodeId];
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.kind === "window") {
      return current.id;
    }
    current = current.parentId ? state.nodes[current.parentId] : undefined;
  }
  return undefined;
}

function runtimeIndexCandidateNodeIdsForCommand(
  command: BackgroundCommand,
  previous: OutlineState,
  next: OutlineState,
  options: {
    expandAncestorNodeIds?: readonly NodeId[];
    restorePatchNodeIds?: readonly NodeId[];
  } = {}
): NodeId[] | undefined {
  switch (command.type) {
    case "restoreNode":
      return collectRuntimeIndexCandidateNodeIds(previous, next, options.restorePatchNodeIds ?? [command.nodeId], {
        includeSeedSubtrees: false
      });

    case "moveNode":
    case "moveNodeToNewWindow":
    case "wrapNodeInGroup":
    case "moveSubtreeToTopLevel":
    case "flattenSubtree":
    case "promoteChildren":
    case "closeNode":
    case "deleteNode":
      return collectRuntimeIndexCandidateNodeIds(previous, next, [command.nodeId]);

    case "toggleCollapsed":
    case "renameGroup":
      return collectRuntimeIndexCandidateNodeIds(previous, next, [command.nodeId], { includeSeedSubtrees: false });

    case "expandAncestors":
      return collectRuntimeIndexCandidateNodeIds(previous, next, options.expandAncestorNodeIds ?? [], {
        includeSeedSubtrees: false
      });

    case "importTree":
      return undefined;

    default:
      return [];
  }
}

function runtimeIndexCandidateNodeIdsForTabRemoval(
  previous: OutlineState,
  next: OutlineState,
  index: RuntimeStateIndex,
  tabId: number
): NodeId[] {
  const nodeId = index.liveTabNodeIdsByRuntimeId.get(tabId) ?? tabNodeIdForRuntime(tabId);
  return collectRuntimeIndexCandidateNodeIds(previous, next, [nodeId]);
}

function runtimeIndexCandidateNodeIdsForWindowRemoval(
  previous: OutlineState,
  next: OutlineState,
  index: RuntimeStateIndex,
  windowId: number
): NodeId[] {
  const nodeId = index.liveWindowNodeIdsByRuntimeId.get(windowId) ?? windowNodeIdForRuntime(windowId);
  return collectRuntimeIndexCandidateNodeIds(previous, next, [nodeId]);
}

function collectRuntimeIndexCandidateNodeIds(
  previous: OutlineState,
  next: OutlineState,
  seedNodeIds: readonly NodeId[],
  options: { includeSeedSubtrees?: boolean } = {}
): NodeId[] {
  const includeSeedSubtrees = options.includeSeedSubtrees ?? true;
  const candidateNodeIds = new Set<NodeId>();
  const relatedNodeIds = new Set<NodeId>();
  const addNode = (nodeId: NodeId | undefined): void => {
    if (nodeId) {
      candidateNodeIds.add(nodeId);
    }
  };
  const addRelatedNode = (nodeId: NodeId | undefined): void => {
    if (nodeId) {
      relatedNodeIds.add(nodeId);
    }
  };

  for (const seedNodeId of seedNodeIds) {
    if (includeSeedSubtrees) {
      addSubtreeNodeIds(previous, seedNodeId, candidateNodeIds);
      addSubtreeNodeIds(next, seedNodeId, candidateNodeIds);
    } else {
      addNode(seedNodeId);
    }
  }

  for (const nodeId of [...candidateNodeIds]) {
    const previousNode = previous.nodes[nodeId];
    const nextNode = next.nodes[nodeId];
    addRelatedNode(previousNode?.parentId);
    addRelatedNode(nextNode?.parentId);
  }

  for (const nodeId of relatedNodeIds) {
    addNode(nodeId);
    addNode(previous.nodes[nodeId]?.parentId);
    addNode(next.nodes[nodeId]?.parentId);
  }

  return [...candidateNodeIds];
}

function addSubtreeNodeIds(state: OutlineState, nodeId: NodeId, result: Set<NodeId>): void {
  const visited = new Set<NodeId>();
  const stack = [nodeId];
  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);
    result.add(currentId);

    const node = state.nodes[currentId];
    if (!node) {
      continue;
    }
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push(node.childIds[index]!);
    }
  }
}

function indexedLiveTabNodeByRuntimeId(
  state: OutlineState,
  index: RuntimeStateIndex,
  tabId: number
): (OutlineNode & { live: { tabId: number; windowId: number } }) | undefined {
  const nodeId = index.liveTabNodeIdsByRuntimeId.get(tabId);
  const node = nodeId ? state.nodes[nodeId] : undefined;
  return isLiveTabNode(node) && node.live.tabId === tabId ? node : undefined;
}

function indexedLiveWindowNodeByRuntimeId(
  state: OutlineState,
  index: RuntimeStateIndex,
  windowId: number
): (OutlineNode & { live: { windowId: number } }) | undefined {
  const nodeId = index.liveWindowNodeIdsByRuntimeId.get(windowId);
  const node = nodeId ? state.nodes[nodeId] : undefined;
  return isLiveWindowNode(node) && node.live.windowId === windowId ? node : undefined;
}

function runtimeTabNodeForFastPath(tab: RuntimeTab, nodeId: NodeId, parentId: NodeId, now: number): OutlineNode {
  const node: OutlineNode = {
    id: nodeId,
    kind: "tab",
    status: "live",
    parentId,
    childIds: [],
    title: tab.title || tab.url || "Untitled tab",
    active: tab.active,
    collapsed: false,
    createdAt: now,
    updatedAt: now,
    live: { tabId: tab.id, windowId: tab.windowId }
  };

  if (tab.url) {
    node.url = tab.url;
  }
  if (tab.favIconUrl) {
    node.favIconUrl = tab.favIconUrl;
  }

  return node;
}

function updateRuntimeTabNodeForFastPath(node: OutlineNode, tab: RuntimeTab, now: number): void {
  node.status = "live";
  node.title = runtimeTitleForOutlineTab(node, tab);
  node.active = tab.active;
  node.updatedAt = now;
  node.live = { tabId: tab.id, windowId: tab.windowId };
  if (tab.url !== undefined) {
    node.url = tab.url;
  }
  if (tab.favIconUrl !== undefined) {
    node.favIconUrl = tab.favIconUrl;
  }
  delete node.closedAt;
  delete node.restore;
}

function tabNodeIdForRuntime(tabId: number): NodeId {
  return `tab:${tabId}`;
}

function windowNodeIdForRuntime(windowId: number): NodeId {
  return `window:${windowId}`;
}

function isTrackableHistoryCommandType(value: string): value is TrackableHistoryCommandType {
  return value === "moveNode" ||
    value === "moveNodeToNewWindow" ||
    value === "wrapNodeInGroup" ||
    value === "moveSubtreeToTopLevel" ||
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

function uniqueDefinedNodeIds(nodeIds: Array<NodeId | undefined>): NodeId[] {
  return [...new Set(nodeIds.filter((nodeId): nodeId is NodeId => Boolean(nodeId)))];
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

function treeStructureUpdateFromStateChange(
  previous: OutlineState,
  next: OutlineState,
  options: { diffMode?: StateDiffMode } = {}
): TreeStructureUpdate {
  const diffMode = options.diffMode ?? "identity";
  const deletedNodeIds = Object.keys(previous.nodes).filter((nodeId) => !next.nodes[nodeId]);
  const updatedNodes: OutlineNode[] = [];
  for (const nodeId of Object.keys(next.nodes)) {
    const node = next.nodes[nodeId]!;
    const previousNode = previous.nodes[nodeId];
    if (!previousNode || nodeChangedForPatch(previousNode, node, diffMode)) {
      updatedNodes.push(node);
    }
  }
  const deletedClosedCount = deletedNodeIds.filter((nodeId) => previous.nodes[nodeId]?.status === "closed").length;

  return {
    type: "treeStructureUpdated",
    deletedNodeIds,
    updatedNodes,
    rootIds: next.rootIds,
    deletedClosedCount
  };
}

function treeStructureUpdateFromCandidateNodeIds(
  previous: OutlineState,
  next: OutlineState,
  candidateNodeIds: readonly NodeId[],
  options: { diffMode?: StateDiffMode } = {}
): TreeStructureUpdate {
  const diffMode = options.diffMode ?? "identity";
  const uniqueCandidateNodeIds = uniqueDefinedNodeIds([...candidateNodeIds]);
  const deletedNodeIds = uniqueCandidateNodeIds.filter((nodeId) => previous.nodes[nodeId] && !next.nodes[nodeId]);
  const updatedNodes: OutlineNode[] = [];
  for (const nodeId of uniqueCandidateNodeIds) {
    const node = next.nodes[nodeId];
    if (!node) {
      continue;
    }
    const previousNode = previous.nodes[nodeId];
    if (!previousNode || nodeChangedForPatch(previousNode, node, diffMode)) {
      updatedNodes.push(node);
    }
  }
  const deletedClosedCount = deletedNodeIds.filter((nodeId) => previous.nodes[nodeId]?.status === "closed").length;

  return {
    type: "treeStructureUpdated",
    deletedNodeIds,
    updatedNodes,
    rootIds: next.rootIds,
    deletedClosedCount
  };
}

function deleteTreeStructureCandidateNodeIds(
  previous: OutlineState,
  next: OutlineState,
  nodeId: NodeId
): NodeId[] {
  const candidateNodeIds = new Set<NodeId>();
  addSubtreeNodeIds(previous, nodeId, candidateNodeIds);

  let parentId = previous.nodes[nodeId]?.parentId;
  while (parentId) {
    candidateNodeIds.add(parentId);
    const previousParent = previous.nodes[parentId];
    const nextParent = next.nodes[parentId];
    if (!previousParent && !nextParent) {
      break;
    }
    parentId = previousParent?.parentId ?? nextParent?.parentId;
  }

  return [...candidateNodeIds];
}

function isUsefulTreeStructureUpdate(update: TreeStructureUpdate, next: OutlineState): boolean {
  const changedNodeCount = update.deletedNodeIds.length + update.updatedNodes.length;
  if (changedNodeCount === 0) {
    return false;
  }

  return changedNodeCount < Object.keys(next.nodes).length;
}

function runtimeSnapshotMateriallyMatchesState(state: OutlineState, windows: RuntimeWindow[]): RuntimeSnapshotMatch {
  const lookup = buildOutlineLookup(state);
  const normalWindows = windows.filter((windowInfo) => !windowInfo.incognito);
  if (lookup.liveWindowNodeIdsByRuntimeId.size !== normalWindows.length) {
    return { matches: false, lookup };
  }

  let runtimeTabCount = 0;
  for (const windowInfo of normalWindows) {
    const windowNodeId = lookup.liveWindowNodeIdsByRuntimeId.get(windowInfo.id);
    const windowNode = windowNodeId ? state.nodes[windowNodeId] : undefined;
    if (!windowNodeId || !windowNode || windowNode.active !== windowInfo.focused) {
      return { matches: false, lookup };
    }

    const tabs = [...(windowInfo.tabs ?? [])]
      .filter((tab) => !tab.incognito)
      .sort((left, right) => left.index - right.index);
    runtimeTabCount += tabs.length;

    const projectedTabs = projectLiveTabs(state, windowNodeId, lookup).filter((tab) => tab.windowId === windowInfo.id);
    if (projectedTabs.length !== tabs.length) {
      return { matches: false, lookup };
    }

    for (let index = 0; index < tabs.length; index += 1) {
      const tab = tabs[index]!;
      const nodeId = lookup.liveTabNodeIdsByRuntimeId.get(tab.id);
      const node = nodeId ? state.nodes[nodeId] : undefined;
      if (
        !node ||
        !isLiveTabNode(node) ||
        node.live.windowId !== tab.windowId ||
        projectedTabs[index]?.tabId !== tab.id ||
        liveTabNodeWouldChange(node, tab)
      ) {
        return { matches: false, lookup };
      }
    }
  }

  return {
    matches: lookup.liveTabNodeIdsByRuntimeId.size === runtimeTabCount,
    lookup
  };
}

function liveTabNodeWouldChange(node: OutlineNode & { live: { tabId: number; windowId: number } }, tab: RuntimeTab): boolean {
  const nextTitle = runtimeTitleForOutlineTab(node, tab);
  return node.active !== tab.active ||
    (tab.url !== undefined && node.url !== tab.url) ||
    node.title !== nextTitle ||
    (tab.favIconUrl !== undefined && node.favIconUrl !== tab.favIconUrl);
}

function nodeStateUpdateFromStateChange(
  previous: OutlineState,
  next: OutlineState,
  options: { diffMode?: StateDiffMode } = {}
): NodeStateUpdate | undefined {
  const diffMode = options.diffMode ?? "identity";
  const nextNodeIds = Object.keys(next.nodes);
  if (!sameNodeIdList(previous.rootIds, next.rootIds) || Object.keys(previous.nodes).length !== nextNodeIds.length) {
    return undefined;
  }

  const updatedNodes: OutlineNode[] = [];
  let closedCountDelta = 0;
  for (const nodeId of nextNodeIds) {
    const previousNode = previous.nodes[nodeId];
    const node = next.nodes[nodeId]!;
    if (!previousNode) {
      return undefined;
    }
    if (!nodeChangedForPatch(previousNode, node, diffMode)) {
      continue;
    }
    if (previousNode.parentId !== node.parentId || !sameNodeIdList(previousNode.childIds, node.childIds)) {
      return undefined;
    }
    updatedNodes.push(node);
    const wasClosed = previousNode.status === "closed" ? 1 : 0;
    const isClosed = node.status === "closed" ? 1 : 0;
    closedCountDelta += isClosed - wasClosed;
  }

  return {
    type: "nodeStateUpdated",
    updatedNodes,
    closedCountDelta
  };
}

function nodeStateUpdateForNodeIds(
  previous: OutlineState,
  next: OutlineState,
  nodeIds: readonly NodeId[],
  options: { diffMode?: StateDiffMode } = {}
): NodeStateUpdate | undefined {
  const diffMode = options.diffMode ?? "identity";
  if (!sameNodeIdList(previous.rootIds, next.rootIds)) {
    return undefined;
  }

  const updatedNodes: OutlineNode[] = [];
  let closedCountDelta = 0;
  for (const nodeId of nodeIds) {
    const previousNode = previous.nodes[nodeId];
    const node = next.nodes[nodeId];
    if (!previousNode || !node) {
      return undefined;
    }
    if (!nodeChangedForPatch(previousNode, node, diffMode)) {
      continue;
    }
    if (previousNode.parentId !== node.parentId || !sameNodeIdList(previousNode.childIds, node.childIds)) {
      return undefined;
    }
    updatedNodes.push(node);
    const wasClosed = previousNode.status === "closed" ? 1 : 0;
    const isClosed = node.status === "closed" ? 1 : 0;
    closedCountDelta += isClosed - wasClosed;
  }

  return {
    type: "nodeStateUpdated",
    updatedNodes,
    closedCountDelta
  };
}

function nodeChangedForPatch(previous: OutlineNode, next: OutlineNode, diffMode: StateDiffMode): boolean {
  return diffMode === "material" ? !nodesMateriallyEqual(previous, next) : previous !== next;
}

function sameNodeIdList(previous: NodeId[], next: NodeId[]): boolean {
  return previous.length === next.length && previous.every((nodeId, index) => nodeId === next[index]);
}

function statesMateriallyEqual(previous: OutlineState, next: OutlineState): boolean {
  if (!sameNodeIdList(previous.rootIds, next.rootIds)) {
    return false;
  }

  const previousNodeIds = Object.keys(previous.nodes);
  if (previousNodeIds.length !== Object.keys(next.nodes).length) {
    return false;
  }

  return previousNodeIds.every((nodeId) => {
    const previousNode = previous.nodes[nodeId];
    const nextNode = next.nodes[nodeId];
    return Boolean(previousNode && nextNode && nodesMateriallyEqual(previousNode, nextNode));
  });
}

function statesEqualIgnoringUpdatedAt(previous: OutlineState, next: OutlineState): boolean {
  if (!sameNodeIdList(previous.rootIds, next.rootIds)) {
    return false;
  }

  const previousNodeIds = Object.keys(previous.nodes);
  if (previousNodeIds.length !== Object.keys(next.nodes).length) {
    return false;
  }

  return previousNodeIds.every((nodeId) => {
    const previousNode = previous.nodes[nodeId];
    const nextNode = next.nodes[nodeId];
    return Boolean(previousNode && nextNode && nodesEqualIgnoringUpdatedAt(previousNode, nextNode));
  });
}

function nodesMateriallyEqual(previous: OutlineNode, next: OutlineNode): boolean {
  return previous.id === next.id &&
    previous.kind === next.kind &&
    previous.status === next.status &&
    previous.parentId === next.parentId &&
    sameNodeIdList(previous.childIds, next.childIds) &&
    previous.title === next.title &&
    previous.customTitle === next.customTitle &&
    previous.url === next.url &&
    previous.favIconUrl === next.favIconUrl &&
    previous.active === next.active &&
    previous.collapsed === next.collapsed &&
    previous.createdAt === next.createdAt &&
    previous.closedAt === next.closedAt &&
    previous.restoredFromClosed === next.restoredFromClosed &&
    liveRefsEqual(previous.live, next.live) &&
    restoreRefsEqual(previous.restore, next.restore);
}

function nodesEqualIgnoringUpdatedAt(previous: OutlineNode, next: OutlineNode): boolean {
  return previous.id === next.id &&
    previous.kind === next.kind &&
    previous.status === next.status &&
    previous.parentId === next.parentId &&
    sameNodeIdList(previous.childIds, next.childIds) &&
    previous.title === next.title &&
    previous.customTitle === next.customTitle &&
    previous.url === next.url &&
    previous.favIconUrl === next.favIconUrl &&
    previous.active === next.active &&
    previous.collapsed === next.collapsed &&
    previous.createdAt === next.createdAt &&
    previous.closedAt === next.closedAt &&
    previous.restoredFromClosed === next.restoredFromClosed &&
    liveRefsEqual(previous.live, next.live) &&
    restoreRefsEqual(previous.restore, next.restore);
}

function liveRefsEqual(previous: OutlineNode["live"], next: OutlineNode["live"]): boolean {
  return previous?.tabId === next?.tabId && previous?.windowId === next?.windowId;
}

function restoreRefsEqual(previous: OutlineNode["restore"], next: OutlineNode["restore"]): boolean {
  return previous?.sessionId === next?.sessionId &&
    previous?.url === next?.url &&
    previous?.title === next?.title &&
    previous?.favIconUrl === next?.favIconUrl;
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

function saveScheduleForCommand(type: BackgroundCommand["type"]): SaveSchedule {
  return isStructuralCommand(type) ? "interaction" : "normal";
}

function isStructuralCommand(type: BackgroundCommand["type"]): boolean {
  return type === "moveNode" ||
    type === "moveNodeToNewWindow" ||
    type === "restoreNode" ||
    type === "wrapNodeInGroup" ||
    type === "moveSubtreeToTopLevel" ||
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

function closePlanForCloseNodeCommand(state: OutlineState, nodeId: NodeId): RuntimeClosePlan {
  const tabId = liveTabIdForNode(state, nodeId);
  if (typeof tabId === "number") {
    return { windowIds: [], tabIds: [tabId] };
  }

  const windowId = liveWindowIdForNode(state, nodeId);
  if (typeof windowId === "number") {
    return { windowIds: [windowId], tabIds: [] };
  }

  return planLiveSubtreeClose(state, nodeId);
}

function liveTabIdForNode(state: OutlineState, nodeId: NodeId): number | undefined {
  const node = state.nodes[nodeId];
  return node?.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live
    ? node.live.tabId
    : undefined;
}

function liveWindowIdForNode(state: OutlineState, nodeId: NodeId): number | undefined {
  const node = state.nodes[nodeId];
  return node?.kind === "window" && node.status === "live" && node.live && "windowId" in node.live
    ? node.live.windowId
    : undefined;
}

function liveWindowNodeByRuntimeId(
  state: OutlineState,
  windowId: number
): (OutlineNode & { live: { windowId: number } }) | undefined {
  return Object.values(state.nodes).find((node): node is OutlineNode & { live: { windowId: number } } => {
    return Boolean(
      node.kind === "window" &&
        node.status === "live" &&
        node.live &&
        "windowId" in node.live &&
        node.live.windowId === windowId
    );
  });
}

function liveTabIdsInWindow(state: OutlineState, windowId: number): number[] {
  return Object.values(state.nodes).flatMap((node) => {
    if (!isLiveTabNode(node) || node.live.windowId !== windowId) {
      return [];
    }
    return [node.live.tabId];
  });
}

function liveStructureChanged(previous: OutlineState, next: OutlineState): boolean {
  return liveStructureSignature(previous) !== liveStructureSignature(next);
}

function liveStructureSignature(state: OutlineState): string {
  return [
    ...liveWindowNodes(state).map((node) =>
      `window:${node.id}:${node.live.windowId}:${node.parentId ?? ""}:${node.childIds.join(",")}`
    ),
    ...liveTabNodes(state).map((node) =>
      `tab:${node.id}:${node.live.tabId}:${node.live.windowId}:${node.parentId ?? ""}`
    )
  ].sort().join("|");
}

function liveWindowNodes(state: OutlineState): Array<OutlineNode & { live: { windowId: number } }> {
  return Object.values(state.nodes).filter(isLiveWindowNode);
}

function liveTabNodes(state: OutlineState): Array<OutlineNode & { live: { tabId: number; windowId: number } }> {
  return Object.values(state.nodes).filter(isLiveTabNode);
}

function liveTabNodesInSubtree(
  state: OutlineState,
  nodeId: NodeId
): Array<OutlineNode & { live: { tabId: number; windowId: number } }> {
  const nodes: Array<OutlineNode & { live: { tabId: number; windowId: number } }> = [];
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
    if (isLiveTabNode(node)) {
      nodes.push(node);
    }
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push(node.childIds[index]!);
    }
  }

  return nodes;
}

function nodeIsReachableFromRoot(state: OutlineState, nodeId: NodeId): boolean {
  const visited = new Set<NodeId>();
  const stack = [...state.rootIds];
  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (currentId === nodeId) {
      return true;
    }
    if (visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);

    const node = state.nodes[currentId];
    if (!node) {
      continue;
    }
    for (const childId of node.childIds) {
      stack.push(childId);
    }
  }
  return false;
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

function deleteHistoryReplayTabNode(state: OutlineState, nodeId: NodeId): void {
  const node = state.nodes[nodeId];
  if (!node) {
    return;
  }

  const promotedChildIds = [...node.childIds];
  const siblings = node.parentId ? state.nodes[node.parentId]?.childIds : state.rootIds;
  if (siblings) {
    const index = siblings.indexOf(nodeId);
    if (index >= 0) {
      siblings.splice(index, 1, ...promotedChildIds);
    }
  }

  for (const childId of promotedChildIds) {
    const child = state.nodes[childId];
    if (!child) {
      continue;
    }
    if (node.parentId) {
      child.parentId = node.parentId;
    } else {
      delete child.parentId;
    }
  }

  delete state.nodes[nodeId];
}

function replaceLiveWindowIdInSubtree(state: OutlineState, windowNodeId: NodeId, windowId: number): void {
  const windowNode = cloneNodeForHistoryMutation(state, windowNodeId);
  if (isLiveWindowNode(windowNode)) {
    windowNode.live = { windowId };
  }

  for (const tabNode of liveTabNodesInSubtree(state, windowNodeId)) {
    updateLiveTabRef(state, tabNode.id, tabNode.live.tabId, windowId);
  }
}

function updateLiveTabRef(state: OutlineState, nodeId: NodeId, tabId: number, windowId: number): void {
  const node = cloneNodeForHistoryMutation(state, nodeId);
  if (!node || node.kind !== "tab") {
    return;
  }
  node.status = "live";
  node.live = { tabId, windowId };
  node.updatedAt = Date.now();
  delete node.closedAt;
  delete node.restore;
}

function cloneNodeForHistoryMutation(state: OutlineState, nodeId: NodeId): OutlineNode | undefined {
  const node = state.nodes[nodeId];
  if (!node) {
    return undefined;
  }
  const cloned = cloneOutlineNode(node);
  state.nodes[nodeId] = cloned;
  return cloned;
}

function nearestLiveWindowId(state: OutlineState, nodeId: NodeId): number | undefined {
  const seen = new Set<NodeId>();
  let current = state.nodes[nodeId];

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (isLiveWindowNode(current)) {
      return current.live.windowId;
    }
    current = current.parentId ? state.nodes[current.parentId] : undefined;
  }

  return liveWindowNodes(state)[0]?.live.windowId;
}

function historyNodeUrl(node: OutlineNode): string {
  return node.url ?? node.restore?.url ?? "about:blank";
}

function isLiveWindowNode(node: OutlineNode | undefined): node is OutlineNode & { live: { windowId: number } } {
  return Boolean(node?.kind === "window" && node.status === "live" && node.live && "windowId" in node.live);
}

function isLiveTabNode(node: OutlineNode | undefined): node is OutlineNode & { live: { tabId: number; windowId: number } } {
  return Boolean(node?.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live);
}

function isLiveRuntimeNode(node: OutlineNode | undefined): boolean {
  return Boolean(node?.status === "live" && node.live);
}

function isDiagnosticsRequest(message: unknown): message is { type: "getDiagnostics" } {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "getDiagnostics"
  );
}

function isInitialTreeSnapshotMessage(message: unknown): message is InitialTreeSnapshotMessage {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "getInitialTreeSnapshot"
  );
}

function isInitialTreeSnapshotWindowMessage(message: unknown): message is InitialTreeSnapshotWindowMessage {
  return Boolean(
    message &&
      typeof message === "object" &&
      (
        (message as { type?: unknown }).type === "getInitialTreeSnapshotWindow" ||
        (message as { type?: unknown }).type === "getTreeProjectionSlice"
      ) &&
      typeof (message as { centerRowIndex?: unknown }).centerRowIndex === "number" &&
      Number.isFinite((message as { centerRowIndex?: number }).centerRowIndex)
  );
}

function isOpenSidebarWindowMessage(message: unknown): message is OpenSidebarWindowMessage {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "openSidebarWindow"
  );
}

function isSidebarNonEditInteractionMessage(message: unknown): message is SidebarNonEditInteractionMessage {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "sidebarNonEditInteraction"
  );
}

function isPerformanceTraceMessage(message: unknown): message is PerformanceTraceMessage {
  if (!message || typeof message !== "object") {
    return false;
  }

  const type = (message as { type?: unknown }).type;
  return type === "getPerformanceTrace" ||
    type === "getPerformanceProfile" ||
    type === "clearPerformanceTrace" ||
    (type === "setPerformanceTraceEnabled" && typeof (message as { enabled?: unknown }).enabled === "boolean");
}

function isSidebarPerformanceTraceCollectedMessage(
  message: unknown
): message is SidebarPerformanceTraceCollectedMessage {
  if (!message || typeof message !== "object") {
    return false;
  }
  const candidate = message as { type?: unknown; requestId?: unknown; sidebar?: unknown };
  return candidate.type === "sidebarPerformanceTraceCollected" &&
    typeof candidate.requestId === "string" &&
    isLabeledTraceSnapshot(candidate.sidebar);
}

function messageType(message: unknown): string {
  return message && typeof message === "object" && typeof (message as { type?: unknown }).type === "string"
    ? (message as { type: string }).type
    : "unknown";
}

function hasOutlineRelevantTabUpdate(changeInfo: Partial<RuntimeTab>): boolean {
  return Boolean(
    "active" in changeInfo ||
      "favIconUrl" in changeInfo ||
      "title" in changeInfo ||
      "url" in changeInfo
  );
}
