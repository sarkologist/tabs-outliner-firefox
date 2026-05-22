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
import type { BackgroundCommand, CommandAck, RuntimeClosePlan } from "./commands.js";
import { getNormalWindow, getNormalWindows, getNormalWindowsIncludingTabs } from "./runtime-snapshot.js";
import { createStateCache } from "./state-cache.js";
import {
  initialTreeSnapshotForState,
  loadHistory,
  loadInitialTreeSnapshot,
  loadStateWithMetadata,
  saveStateAndHistory
} from "./storage.js";
import type { InitialTreeSnapshot } from "./storage.js";
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
  closeTab,
  closeWindow,
  deleteNode as deleteOutlineNode,
  deleteLiveTabNodeByTabId,
  planRestore,
  projectLiveTabs,
  reconcileWithWindows,
  repairState,
  runtimeTitleForOutlineTab
} from "../model/outline.js";
import { buildOutlineLookup, type OutlineLookup } from "../model/outline-lookup.js";
import type { NodeId, OutlineNode, OutlineState, RuntimeTab, RuntimeWindow } from "../model/types.js";
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
  callers: RuntimeRefreshCaller[];
  scheduled: boolean;
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

type OpenSidebarWindowMessage = {
  type: "openSidebarWindow";
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

type CommandRelocatedTabEcho = {
  fromWindowIds: Set<number>;
  toWindowId: number;
};

export function createBackgroundController(options: BackgroundControllerOptions): BackgroundController {
  const { api, now = Date.now } = options;
  const adapter = options.adapter ?? createBrowserAdapter(api);
  const perfTrace = createPerformanceTracer("background");

  let state: OutlineState | undefined;
  let lastPersistedState: OutlineState | undefined;
  let deferredPersistedStateCloneTimer: ReturnType<typeof setTimeout> | undefined;
  let historyState: HistoryState | undefined;
  let preferences: AppPreferences | undefined;
  let runtimeIndex: RuntimeStateIndex | undefined;
  const highPriorityMutations: ScheduledMutation[] = [];
  const lowPriorityMutations: ScheduledMutation[] = [];
  const schedulerIdleResolvers: Array<() => void> = [];
  let schedulerRunning = false;
  let schedulerDrainQueued = false;
  const outlinerClosingTabIds = new Set<number>();
  const outlinerClosingWindowIds = new Set<number>();
  const deleteOwnedClosingTabIds = new Set<number>();
  const deleteOwnedClosingWindowIds = new Set<number>();
  const removedTabIds = new Set<number>();
  const removedWindowIds = new Set<number>();
  const outlineGroupedTabIdsByWindowId = new Map<number, Set<number>>();
  const commandRestoredTabIds = new Set<number>();
  const commandRelocatedTabEchoes = new Map<number, CommandRelocatedTabEcho>();
  const commandFocusedTabIds = new Set<number>();
  const commandFocusedActivationWindowIds = new Set<number>();
  const commandFocusedWindowIds = new Set<number>();
  const stateCache = createStateCache(initializeState);
  let sessionChangedQueued = false;
  let commandCloseSessionEchoesToSkip = 0;
  let commandCloseSessionEchoesSkippedBeforeRemoval = 0;
  let pendingRuntimeRefresh: PendingRuntimeRefresh | undefined;
  let pendingSaveState: OutlineState | undefined;
  let pendingSaveHistory: HistoryState | undefined;
  let saveTimer: number | undefined;
  let saveMaxTimer: number | undefined;
  let saveInFlight: Promise<void> | undefined;
  let saveAfterInFlight = false;
  let saveAfterInFlightSchedule: SaveSchedule = "normal";
  let explicitSaveFlushInProgress = false;
  let pendingSaveBatchStartedAt: number | undefined;
  let pendingSaveMaxDelayMs: number | undefined;
  let pendingSaveSchedule: SaveSchedule | undefined;
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
    await perfTrace.measureAsync("background.event.tabs.onCreated", { tabId: tab.id }, () => queueRuntimeRefresh([tab]));
  });

  api.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
    await perfTrace.measureAsync("background.event.tabs.onUpdated", { tabId: tab.id }, async () => {
      if (!hasOutlineRelevantTabUpdate(changeInfo)) {
        return;
      }
      if (isCommandFocusActiveUpdateEcho(commandFocusedActivationWindowIds, changeInfo, tab)) {
        return;
      }
      await queueRuntimeRefresh([tab]);
    });
  });

  api.tabs.onActivated.addListener(async (activeInfo) => {
    await perfTrace.measureAsync("background.event.tabs.onActivated", { tabId: activeInfo.tabId }, async () => {
      if (commandFocusedTabIds.has(activeInfo.tabId)) {
        await handleCommandTabActivated(activeInfo);
        return;
      }
      await queueRuntimeActivation(activeInfo);
    });
  });

  api.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    await perfTrace.measureAsync("background.event.tabs.onRemoved", { tabId }, async () => {
      removedTabIds.add(tabId);
      commandRelocatedTabEchoes.delete(tabId);
      if (deleteOwnedClosingTabIds.delete(tabId)) {
        return;
      }
      if (removeInfo.isWindowClosing) {
        return;
      }

      await enqueueMutation(async () => {
        const current = await ensureState();
        let next: OutlineState;
        if (outlinerClosingTabIds.delete(tabId)) {
          const recent = await mostRecentClosedSession();
          next = closeTab(current, tabId, {
            now: now(),
            ...(recent?.tab?.sessionId ? { sessionId: recent.tab.sessionId } : {})
          });
          if (commandCloseSessionEchoesSkippedBeforeRemoval > 0) {
            commandCloseSessionEchoesSkippedBeforeRemoval -= 1;
          } else {
            commandCloseSessionEchoesToSkip += 1;
          }
        } else if (isRestoredLiveTabId(current, tabId)) {
          const recent = await mostRecentClosedSession();
          next = closeTab(current, tabId, {
            now: now(),
            ...(recent?.tab?.sessionId ? { sessionId: recent.tab.sessionId } : {})
          });
        } else {
          next = deleteLiveTabNodeByTabId(current, tabId);
        }
        if (next === current) {
          return;
        }
        installStateTransition(current, next, {
          candidateNodeIds: runtimeIndexCandidateNodeIdsForTabRemoval(current, next, runtimeIndexForState(current), tabId)
        });
        await persistWithNodeStateUpdate(current, next);
      }, { reason: "tabs.onRemoved" });
    });
  });

  api.windows.onRemoved.addListener(async (windowId) => {
    await perfTrace.measureAsync("background.event.windows.onRemoved", { windowId }, async () => {
      if (fullSizeOutlinerWindowIds.delete(windowId)) {
        return;
      }
      removedWindowIds.add(windowId);
      if (deleteOwnedClosingWindowIds.delete(windowId)) {
        return;
      }

      await enqueueMutation(async () => {
        const current = await ensureState();
        const liveTabIds = liveTabIdsInWindow(current, windowId);
        const outlinerClosingWindow = outlinerClosingWindowIds.delete(windowId);
        const outlineGroupedTabIds = outlineGroupedTabIdsByWindowId.get(windowId);
        outlineGroupedTabIdsByWindowId.delete(windowId);
        const singleNativeRemovedTabId = !outlinerClosingWindow &&
          liveTabIds.length === 1 &&
          removedTabIds.has(liveTabIds[0]!) &&
          !outlinerClosingTabIds.has(liveTabIds[0]!)
          ? liveTabIds[0]
          : undefined;

        if (typeof singleNativeRemovedTabId === "number") {
          let next: OutlineState;
          if (
            outlineGroupedTabIds?.has(singleNativeRemovedTabId) ||
            shouldPreserveRestoredSingleTabWindowClose(current, windowId, singleNativeRemovedTabId)
          ) {
            const recent = await mostRecentClosedSession();
            next = closeWindow(current, windowId, {
              now: now(),
              ...(recent?.window?.sessionId ? { sessionId: recent.window.sessionId } : {})
            });
          } else {
            next = closeWindow(deleteLiveTabNodeByTabId(current, singleNativeRemovedTabId), windowId, { now: now() });
          }
          installStateTransition(current, next, {
            candidateNodeIds: runtimeIndexCandidateNodeIdsForWindowRemoval(current, next, runtimeIndexForState(current), windowId)
          });
          await persistWithNodeStateUpdate(current, next);
          return;
        }

        for (const tabId of liveTabIds) {
          outlinerClosingTabIds.delete(tabId);
        }
        const recent = await mostRecentClosedSession();
        const next = closeWindow(current, windowId, {
          now: now(),
          ...(recent?.window?.sessionId ? { sessionId: recent.window.sessionId } : {})
        });
        installStateTransition(current, next, {
          candidateNodeIds: runtimeIndexCandidateNodeIdsForWindowRemoval(current, next, runtimeIndexForState(current), windowId)
        });
        await persistWithNodeStateUpdate(current, next);
      }, { reason: "windows.onRemoved" });
    });
  });

  api.windows.onFocusChanged.addListener(async (windowId) => {
    await perfTrace.measureAsync("background.event.windows.onFocusChanged", { windowId }, async () => {
      if (await shouldIgnoreSidebarWindowFocus(windowId)) {
        return;
      }
      if (commandFocusedWindowIds.has(windowId)) {
        await handleCommandWindowFocusChanged(windowId);
        return;
      }
      await queueRuntimeRefresh([], { closeMissing: false, focusWindowId: windowId });
    });
  });

  api.sessions.onChanged.addListener(async () => {
    await perfTrace.measureAsync("background.event.sessions.onChanged", async () => {
      if (sessionChangedQueued) {
        return;
      }
      sessionChangedQueued = true;
      await enqueueMutation(async () => {
        try {
          if (commandCloseSessionEchoesToSkip > 0) {
            commandCloseSessionEchoesToSkip -= 1;
            return;
          }
          if (outlinerClosingTabIds.size > 0) {
            commandCloseSessionEchoesSkippedBeforeRemoval += 1;
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
    if (isDiagnosticsRequest(message)) {
      return getDiagnosticsCoalesced();
    }

    if (isInitialTreeSnapshotMessage(message)) {
      return initialTreeSnapshot();
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
      for (const tabId of outlinerClosePlan?.tabIds ?? []) {
        outlinerClosingTabIds.add(tabId);
      }
      for (const windowId of outlinerClosePlan?.windowIds ?? []) {
        outlinerClosingWindowIds.add(windowId);
      }
      if (focusTarget && !focusTarget.tabActive) {
        commandFocusedTabIds.add(focusTarget.tabId);
        commandFocusedActivationWindowIds.add(focusTarget.windowId);
      }
      if (focusTarget) {
        commandFocusedWindowIds.add(focusTarget.windowId);
      }
      for (const tabId of deleteClosePlan?.tabIds ?? []) {
        deleteOwnedClosingTabIds.add(tabId);
      }
      for (const windowId of deleteClosePlan?.windowIds ?? []) {
        deleteOwnedClosingWindowIds.add(windowId);
      }

      let result: Awaited<ReturnType<typeof runCommand>>;
      try {
        if (message.type === "toggleCollapsed" || message.type === "expandAncestors") {
          detachPersistedStateBaselineForMutation();
        }
        result = await perfTrace.measureAsync("background.command.run", { command: message.type }, () =>
          runCommand(current, adapter, message)
        );
      } catch (error) {
        if (
          message.type === "deleteNode" &&
          deleteClosePlan &&
          await runtimeClosePlanCompleted(deleteClosePlan)
        ) {
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
            scheduleStateSave(recovered, saveSchedule);
            return commandAck(true);
          }
        }
        for (const tabId of outlinerClosePlan?.tabIds ?? []) {
          outlinerClosingTabIds.delete(tabId);
        }
        for (const windowId of outlinerClosePlan?.windowIds ?? []) {
          outlinerClosingWindowIds.delete(windowId);
        }
        for (const tabId of deleteClosePlan?.tabIds ?? []) {
          deleteOwnedClosingTabIds.delete(tabId);
        }
        for (const windowId of deleteClosePlan?.windowIds ?? []) {
          deleteOwnedClosingWindowIds.delete(windowId);
        }
        if (focusTarget) {
          commandFocusedTabIds.delete(focusTarget.tabId);
          commandFocusedActivationWindowIds.delete(focusTarget.windowId);
          commandFocusedWindowIds.delete(focusTarget.windowId);
        }
        throw error;
      }
      if (!result.changed) {
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
      if (commandMayRelocateLiveTabs(message.type)) {
        trackCommandRelocatedTabEchoes(current, result.state, commandRelocatedTabEchoes, runtimeIndexCandidateNodeIds);
      }
      if (message.type === "wrapNodeInGroup" || message.type === "moveSubtreeToTopLevel") {
        trackOutlineGroupedTabIds(current, result.state, outlineGroupedTabIdsByWindowId, runtimeIndexCandidateNodeIds);
      }
      if (message.type === "restoreNode") {
        for (const tabId of restoredLiveTabIdsChangedByCommand(current, result.state, runtimeIndexCandidateNodeIds)) {
          commandRestoredTabIds.add(tabId);
        }
      }
      installStateTransition(current, result.state, { candidateNodeIds: runtimeIndexCandidateNodeIds });
      if (commandMayRelocateLiveTabs(message.type)) {
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
          : historyCandidateNodeIds(message, historyPrevious, result.state);
        await recordHistoryEntry(message.type, historyPrevious, result.state, {
          ...(candidateNodeIds ? { candidateNodeIds } : {}),
          saveSchedule
        });
      }
      if (message.type === "restoreNode") {
        await persistWithNodeStateUpdate(current, result.state, restorePatchNodeIds, { saveSchedule });
        return commandAck(true);
      }
      if (message.type === "deleteNode") {
        const update = perfTrace.measure("background.patch.build.treeStructure", { command: message.type }, () =>
          treeStructureUpdateFromCandidateNodeIds(current, result.state, deletePatchNodeIds ?? [message.nodeId])
        );
        await broadcastTreeStructureUpdate(update);
        scheduleStateSave(result.state, saveSchedule);
        return commandAck(true);
      }
      if (
        message.type === "wrapNodeInGroup" ||
        message.type === "moveSubtreeToTopLevel" ||
        message.type === "promoteChildren"
      ) {
        const update = perfTrace.measure("background.patch.build.treeStructure", { command: message.type }, () =>
          treeStructureUpdateFromStateChange(current, result.state)
        );
        await broadcastTreeStructureUpdate(update);
        scheduleStateSave(result.state, saveSchedule);
        return commandAck(true);
      }
      if (message.type === "renameGroup") {
        await persistKnownNodeStateUpdate(current, result.state, message.nodeId);
        return commandAck(true);
      }
      if (message.type === "toggleCollapsed") {
        await persistKnownNodeStateUpdate(current, result.state, message.nodeId);
        return commandAck(true);
      }
      if (message.type === "expandAncestors") {
        await persistKnownNodeStateUpdates(current, result.state, expandAncestorNodeIds ?? []);
        return commandAck(true);
      }
      await persistWithBestEffortPatch(current, result.state, { saveSchedule });
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

  async function ensureState(): Promise<OutlineState> {
    return stateCache.get();
  }

  async function initializeExtensionLifecycle(): Promise<void> {
    await ensureState();
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

  async function ensureHistory(): Promise<HistoryState> {
    const activePreferences = await ensurePreferences();
    historyState ??= normalizeHistoryState(await loadHistory(api, activePreferences.undoHistoryLimit), activePreferences.undoHistoryLimit);
    return historyState;
  }

  async function ensurePreferences(): Promise<AppPreferences> {
    preferences ??= await loadAppPreferences(api);
    return preferences;
  }

  async function initializeState(): Promise<OutlineState> {
    const [windows, loaded] = await Promise.all([
      perfTrace.measureAsync("background.runtime.getWindows", () => getNormalWindows(api)),
      perfTrace.measureAsync("background.state.load", () => loadStateWithMetadata(api))
    ]);
    const stored = loaded?.state;
    let storedRuntimeMatch: RuntimeSnapshotMatch | undefined;
    if (stored) {
      storedRuntimeMatch = runtimeSnapshotMateriallyMatchesState(stored, windows);
      if (storedRuntimeMatch.matches) {
        if (loaded.format === "v3") {
          deferPersistedStateBaselineClone(stored);
        } else {
          lastPersistedState = undefined;
        }
        state = stored;
      } else {
        lastPersistedState = loaded.format === "v3" ? cloneOutlineState(stored) : undefined;
        const repaired = repairState(stored);
        const reconciled = reconcileWithWindows(repaired, windows, { now: now() });
        state = statesEqualIgnoringUpdatedAt(repaired, reconciled) ? repaired : reconciled;
        if (!statesMateriallyEqual(stored, state)) {
          scheduleStateSave(state);
        }
      }
    } else {
      state = bootstrapFromWindows(windows, { now: now() });
      scheduleStateSave(state);
    }
    runtimeIndex = storedRuntimeMatch?.matches && state === stored
      ? buildRuntimeStateIndexFromLookup(state, storedRuntimeMatch.lookup)
      : buildRuntimeStateIndex(state);
    return state;
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
    const next = await applyHistoryDeltaWithRuntime(current, direction === "undo" ? popped.entry.undo : popped.entry.redo);
    if (statesMateriallyEqual(current, next)) {
      historyState = popped.history;
      scheduleHistorySave(historyState, saveSchedule);
      broadcastHistoryStatusSoon(historyState);
      return commandAck(false);
    }

    installStateTransition(current, next, { rebuildRuntimeIndex: true });
    const activePreferences = await ensurePreferences();
    historyState = direction === "undo"
      ? pushRedoEntry(popped.history, popped.entry, activePreferences.undoHistoryLimit)
      : pushUndoEntryPreservingRedo(popped.history, popped.entry, activePreferences.undoHistoryLimit);
    await persistWithBestEffortPatch(current, next, { diffMode: "material", saveSchedule });
    scheduleHistorySave(historyState, saveSchedule);
    broadcastHistoryStatusSoon(historyState);
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

  async function applyHistoryDeltaWithRuntime(current: OutlineState, delta: OutlineDelta): Promise<OutlineState> {
    const next = applyOutlineDelta(current, delta);
    const closedRuntimeResources = await closeDeletedLiveRuntimeResources(current, next);
    const materializedRuntimeResources = await materializeHistoryLiveResources(current, next);
    if (closedRuntimeResources || materializedRuntimeResources || liveStructureChanged(current, next)) {
      await syncBrowserOrder(next, adapter);
    }
    return next;
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
        activationByWindowId: pending.activationByWindowId
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
    const ignoredTabIds = ignoredRuntimeTabIdsForRefresh(removedTabIds, deleteOwnedClosingTabIds);
    const ignoredWindowIds = ignoredRuntimeWindowIdsForRefresh(removedWindowIds, deleteOwnedClosingWindowIds);
    const currentEventTabs = eventTabs
      .filter((tab) => !ignoredTabIds.has(tab.id))
      .filter((tab) => !ignoredWindowIds.has(tab.windowId))
      .filter((tab) => !consumeCommandRestoredTabEvent(current, index, commandRestoredTabIds, tab))
      .filter((tab) => !consumeCommandRelocatedStaleTabEvent(current, index, commandRelocatedTabEchoes, tab))
      .filter((tab) => tabEventMayChangeState(current, tab, index));
    if (eventTabs.length > 0 && currentEventTabs.length === 0 && !closeMissing) {
      return false;
    }
    if (!closeMissing && currentEventTabs.length > 0) {
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
    const windows = applyActivationOverridesToWindows(
      filterCommandRelocatedStaleTabsFromWindows(
        filterRemovedWindowsFromWindows(
          filterRemovedTabsFromWindows(windowsSnapshot, ignoredTabIds),
          ignoredWindowIds
        ),
        current,
        index,
        commandRelocatedTabEchoes
      ),
      current,
      index,
      options.activationByWindowId
    );
    if (runtimeSnapshotMateriallyMatchesState(current, windows).matches) {
      return false;
    }
    const next = reconcileWithWindows(current, windows, { now: now() }, {
      closeMissing
    });
    if (statesMateriallyEqual(current, next)) {
      return false;
    }
    installStateTransition(current, next, { rebuildRuntimeIndex: true });
    await persistWithBestEffortPatch(current, next, { diffMode: "material" });
    return state !== current;
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

    const deactivateTabForRuntimeFastPath = (windowId: number, tabNodeId: NodeId): void => {
      const tabNode = nodeForPlan(tabNodeId);
      if (tabNode?.active !== false) {
        const mutableTabNode = mutableNodeForPlan(tabNodeId);
        if (mutableTabNode) {
          mutableTabNode.active = false;
        }
      }
      if (plannedActiveTabNodeId(windowId) === tabNodeId) {
        activeTabNodeIdOverrides.set(windowId, undefined);
      }
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
          deactivateTabForRuntimeFastPath(tab.windowId, existingTabNodeId);
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

  async function handleCommandTabActivated(activeInfo: { tabId: number; windowId: number; previousTabId?: number }): Promise<boolean> {
    commandFocusedTabIds.delete(activeInfo.tabId);
    commandFocusedActivationWindowIds.delete(activeInfo.windowId);
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
    commandFocusedWindowIds.delete(windowId);
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
      scheduleStateSave(next, options.saveSchedule);
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
    scheduleStateSave(next);
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
    scheduleStateSave(next);
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

  async function broadcastHistoryStatus(history: HistoryState): Promise<void> {
    await broadcastWithTrace(historyStatusMessage(history));
  }

  function broadcastHistoryStatusSoon(history: HistoryState): void {
    void broadcastHistoryStatus(history).catch((error) => {
      perfTrace.mark("background.runtime.broadcast.historyStatus.error", { message: errorText(error) });
    });
  }

  function scheduleStateSave(next: OutlineState, schedule: SaveSchedule = "normal"): void {
    pendingSaveState = next;
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
        if (!nextState && !nextHistory) {
          return;
        }
        pendingSaveState = undefined;
        pendingSaveHistory = undefined;
        saveAfterInFlight = false;
        await startSaveStateAndHistory(nextState, nextHistory);
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
      if (!nextState && !nextHistory) {
        return;
      }

      pendingSaveState = undefined;
      pendingSaveHistory = undefined;
      await startSaveStateAndHistory(nextState, nextHistory);
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
    nextHistory: HistoryState | undefined
  ): Promise<void> {
    await perfTrace.measureAsync("background.state.save", () =>
      saveStateAndHistory(nextState, nextHistory, api, {
        ...(nextState && lastPersistedState ? { previousState: lastPersistedState } : {})
      })
    );
    if (nextState) {
      lastPersistedState = cloneOutlineState(nextState);
    }
  }

  function startSaveStateAndHistory(
    nextState: OutlineState | undefined,
    nextHistory: HistoryState | undefined
  ): Promise<void> {
    saveInFlight = saveStateAndHistoryNowWithTrace(nextState, nextHistory).finally(() => {
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
    const windows = filterRemovedWindowsFromWindows(
      filterRemovedTabsFromWindows(
        await getNormalWindows(api),
        ignoredRuntimeTabIdsForRefresh(removedTabIds, deleteOwnedClosingTabIds)
      ),
      ignoredRuntimeWindowIdsForRefresh(removedWindowIds, deleteOwnedClosingWindowIds)
    );
    const openWindowIds = new Set(windows.map((windowInfo) => windowInfo.id));
    const openTabIds = new Set(
      windows.flatMap((windowInfo) => windowInfo.tabs ?? []).map((tab) => tab.id)
    );
    const missingLiveTabIds = Object.values(current.nodes)
      .filter(isLiveTabInOpenWindow(openWindowIds, openTabIds))
      .map((node) => node.live.tabId);
    if (missingLiveTabIds.length === 0) {
      return undefined;
    }

    let next = current;
    for (const tabId of missingLiveTabIds) {
      removedTabIds.add(tabId);
      if (outlinerClosingTabIds.delete(tabId)) {
        const recent = await mostRecentClosedSession();
        next = closeTab(next, tabId, {
          now: now(),
          ...(recent?.tab?.sessionId ? { sessionId: recent.tab.sessionId } : {})
        });
      } else if (isRestoredLiveTabId(next, tabId)) {
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

  for (const node of lookup.nodes) {
    if (node.kind !== "tab" || node.status !== "closed") {
      continue;
    }
    const ownerWindowNodeId = lookup.ownerWindowNodeIdsByNodeId.get(node.id);
    if (!ownerWindowNodeId || node.id === ownerWindowNodeId) {
      continue;
    }
    const count = index.closedRestoreCandidateCountsByWindowNodeId.get(ownerWindowNodeId) ?? 0;
    index.closedRestoreCandidateCountsByWindowNodeId.set(ownerWindowNodeId, count + 1);
    index.windowNodeIdsWithClosedRestoreCandidates.add(ownerWindowNodeId);
  }

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

function restoredLiveTabIdsChangedByCommand(
  previous: OutlineState,
  next: OutlineState,
  candidateNodeIds?: readonly NodeId[]
): number[] {
  const nodes = candidateNodeIds
    ? candidateNodeIds.flatMap((nodeId) => {
        const node = next.nodes[nodeId];
        return node ? [node] : [];
      })
    : Object.values(next.nodes);

  return nodes.flatMap((node) => {
    if (!isLiveTabNode(node) || !node.restoredFromClosed || previous.nodes[node.id]?.status !== "closed") {
      return [];
    }
    return [node.live.tabId];
  });
}

function commandMayRelocateLiveTabs(type: BackgroundCommand["type"]): boolean {
  return type === "moveNode" ||
    type === "moveNodeToNewWindow" ||
    type === "wrapNodeInGroup" ||
    type === "moveSubtreeToTopLevel";
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

function trackCommandRelocatedTabEchoes(
  previous: OutlineState,
  next: OutlineState,
  commandRelocatedTabEchoes: Map<number, CommandRelocatedTabEcho>,
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

    const existingEcho = commandRelocatedTabEchoes.get(previousNode.live.tabId);
    const fromWindowIds = new Set(existingEcho?.fromWindowIds ?? []);
    fromWindowIds.add(previousNode.live.windowId);
    commandRelocatedTabEchoes.set(previousNode.live.tabId, {
      fromWindowIds,
      toWindowId: nextNode.live.windowId
    });
  }
}

function trackOutlineGroupedTabIds(
  previous: OutlineState,
  next: OutlineState,
  outlineGroupedTabIdsByWindowId: Map<number, Set<number>>,
  candidateNodeIds?: readonly NodeId[]
): void {
  const nextNodes = candidateNodeIds
    ? candidateNodeIds.flatMap((nodeId) => {
        const node = next.nodes[nodeId];
        return node ? [node] : [];
      })
    : Object.values(next.nodes);

  for (const node of nextNodes) {
    if (!isLiveWindowNode(node) || isLiveWindowNode(previous.nodes[node.id])) {
      continue;
    }

    const tabIds = projectLiveTabs(next, node.id)
      .filter((tab) => tab.windowId === node.live.windowId)
      .map((tab) => tab.tabId);
    if (tabIds.length > 0) {
      outlineGroupedTabIdsByWindowId.set(node.live.windowId, new Set(tabIds));
    }
  }
}

function consumeCommandRestoredTabEvent(
  state: OutlineState,
  index: RuntimeStateIndex,
  commandRestoredTabIds: Set<number>,
  tab: RuntimeTab
): boolean {
  if (!commandRestoredTabIds.has(tab.id)) {
    return false;
  }

  const node = indexedLiveTabNodeByRuntimeId(state, index, tab.id);
  if (!node?.restoredFromClosed || node.live.windowId !== tab.windowId) {
    commandRestoredTabIds.delete(tab.id);
    return false;
  }

  commandRestoredTabIds.delete(tab.id);
  return true;
}

function consumeCommandRelocatedStaleTabEvent(
  state: OutlineState,
  index: RuntimeStateIndex,
  commandRelocatedTabEchoes: Map<number, CommandRelocatedTabEcho>,
  tab: RuntimeTab
): boolean {
  const echo = commandRelocatedTabEchoes.get(tab.id);
  if (!echo) {
    return false;
  }

  const node = indexedLiveTabNodeByRuntimeId(state, index, tab.id);
  if (!node) {
    commandRelocatedTabEchoes.delete(tab.id);
    return false;
  }

  if (tab.windowId === node.live.windowId || tab.windowId === echo.toWindowId) {
    commandRelocatedTabEchoes.delete(tab.id);
    return false;
  }

  if (echo.fromWindowIds.has(tab.windowId) && node.live.windowId === echo.toWindowId) {
    return true;
  }

  commandRelocatedTabEchoes.delete(tab.id);
  return false;
}

function tabEventMayChangeState(state: OutlineState, tab: RuntimeTab, index: RuntimeStateIndex): boolean {
  const node = indexedLiveTabNodeByRuntimeId(state, index, tab.id);
  if (!isLiveTabNode(node) || node.live.windowId !== tab.windowId) {
    return true;
  }

  return liveTabNodeWouldChange(node, tab);
}

function isCommandFocusActiveUpdateEcho(
  commandFocusedActivationWindowIds: Set<number>,
  changeInfo: Partial<RuntimeTab>,
  tab: RuntimeTab
): boolean {
  return tab.active === true &&
    commandFocusedActivationWindowIds.has(tab.windowId) &&
    Object.keys(changeInfo).every((key) => key === "active");
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

function isRestoredLiveTabId(state: OutlineState, tabId: number): boolean {
  return Boolean(liveTabNodeByRuntimeId(state, tabId)?.restoredFromClosed);
}

function shouldPreserveRestoredSingleTabWindowClose(
  state: OutlineState,
  windowId: number,
  tabId: number
): boolean {
  return Boolean(
    liveWindowNodeByRuntimeId(state, windowId)?.restoredFromClosed ||
      liveTabNodeByRuntimeId(state, tabId)?.restoredFromClosed
  );
}

function liveTabNodeByRuntimeId(
  state: OutlineState,
  tabId: number
): (OutlineNode & { live: { tabId: number; windowId: number } }) | undefined {
  return Object.values(state.nodes).find((node): node is OutlineNode & { live: { tabId: number; windowId: number } } => {
    return isLiveTabNode(node) && node.live.tabId === tabId;
  });
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

function isLiveTabInOpenWindow(
  openWindowIds: Set<number>,
  openTabIds: Set<number>
): (node: OutlineNode) => node is OutlineNode & { live: { tabId: number; windowId: number } } {
  return (node): node is OutlineNode & { live: { tabId: number; windowId: number } } => {
    return Boolean(
      isLiveTabNode(node) &&
        openWindowIds.has(node.live.windowId) &&
        !openTabIds.has(node.live.tabId)
    );
  };
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

function filterRemovedTabsFromWindows(windows: RuntimeWindow[], removedTabIds: Set<number>): RuntimeWindow[] {
  if (removedTabIds.size === 0) {
    return windows;
  }

  return windows.map((windowInfo) => ({
    ...windowInfo,
    tabs: (windowInfo.tabs ?? []).filter((tab) => !removedTabIds.has(tab.id))
  }));
}

function filterRemovedWindowsFromWindows(windows: RuntimeWindow[], removedWindowIds: Set<number>): RuntimeWindow[] {
  if (removedWindowIds.size === 0) {
    return windows;
  }

  return windows.filter((windowInfo) => !removedWindowIds.has(windowInfo.id));
}

function ignoredRuntimeTabIdsForRefresh(
  removedTabIds: Set<number>,
  deleteOwnedClosingTabIds: Set<number>
): Set<number> {
  if (deleteOwnedClosingTabIds.size === 0) {
    return removedTabIds;
  }

  return new Set([...removedTabIds, ...deleteOwnedClosingTabIds]);
}

function ignoredRuntimeWindowIdsForRefresh(
  removedWindowIds: Set<number>,
  deleteOwnedClosingWindowIds: Set<number>
): Set<number> {
  if (deleteOwnedClosingWindowIds.size === 0) {
    return removedWindowIds;
  }

  return new Set([...removedWindowIds, ...deleteOwnedClosingWindowIds]);
}

function filterCommandRelocatedStaleTabsFromWindows(
  windows: RuntimeWindow[],
  state: OutlineState,
  index: RuntimeStateIndex,
  commandRelocatedTabEchoes: Map<number, CommandRelocatedTabEcho>
): RuntimeWindow[] {
  if (commandRelocatedTabEchoes.size === 0) {
    return windows;
  }

  const freshEchoTabIds = new Set<number>();
  for (const windowInfo of windows) {
    for (const tab of windowInfo.tabs ?? []) {
      const echo = commandRelocatedTabEchoes.get(tab.id);
      if (!echo) {
        continue;
      }
      const node = indexedLiveTabNodeByRuntimeId(state, index, tab.id);
      if (!node) {
        commandRelocatedTabEchoes.delete(tab.id);
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
      const echo = commandRelocatedTabEchoes.get(tab.id);
      if (!echo) {
        return true;
      }

      const node = indexedLiveTabNodeByRuntimeId(state, index, tab.id);
      if (!node) {
        commandRelocatedTabEchoes.delete(tab.id);
        return true;
      }

      const staleOldWindowEcho = echo.fromWindowIds.has(tab.windowId) && node.live.windowId === echo.toWindowId;
      if (staleOldWindowEcho) {
        changed = true;
        if (!freshEchoTabIds.has(tab.id)) {
          const fallbackTab = commandRelocatedTabFromCurrentState(state, index, tab);
          if (fallbackTab) {
            fallbackTabs.push(fallbackTab);
          }
        }
        return false;
      }

      if (tab.windowId === node.live.windowId || tab.windowId === echo.toWindowId) {
        return true;
      }

      commandRelocatedTabEchoes.delete(tab.id);
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

  const withFallbackTabs = filtered.map((windowInfo) => {
    const additions = missingFallbackTabs.filter((tab) => tab.windowId === windowInfo.id);
    if (additions.length === 0) {
      return windowInfo;
    }

    return {
      ...windowInfo,
      tabs: [...(windowInfo.tabs ?? []), ...additions].sort((left, right) => left.index - right.index)
    };
  });

  return withFallbackTabs;
}

function applyActivationOverridesToWindows(
  windows: RuntimeWindow[],
  state: OutlineState,
  index: RuntimeStateIndex,
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
  index: RuntimeStateIndex,
  staleTab: RuntimeTab
): RuntimeTab | undefined {
  const node = indexedLiveTabNodeByRuntimeId(state, index, staleTab.id);
  if (!node) {
    return undefined;
  }

  const windowNode = indexedLiveWindowNodeByRuntimeId(state, index, node.live.windowId);
  const projectedIndex = windowNode
    ? projectLiveTabs(state, windowNode.id).findIndex((tab) => tab.tabId === staleTab.id)
    : -1;
  return {
    ...staleTab,
    windowId: node.live.windowId,
    index: projectedIndex >= 0 ? projectedIndex : staleTab.index,
    active: node.active === true,
    ...(node.url ? { url: node.url } : {}),
    ...(node.title ? { title: node.title } : {}),
    ...(node.favIconUrl ? { favIconUrl: node.favIconUrl } : {})
  };
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

function isOpenSidebarWindowMessage(message: unknown): message is OpenSidebarWindowMessage {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "openSidebarWindow"
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
