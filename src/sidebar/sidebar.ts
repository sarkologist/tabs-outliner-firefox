import type { BackgroundCommand } from "../background/commands.js";
import type { OutlineDiagnostics } from "../background/diagnostics.js";
import type { HistoryStatus } from "../background/history.js";
import {
  INITIAL_TREE_SNAPSHOT_ROW_LIMIT,
  type InitialTreeSnapshot,
  type ProjectionSliceCoverage
} from "../background/initial-tree-snapshot.js";
import { analyzeRestoreScope, runtimeTitleForOutlineTab, type RestoreScope } from "../model/outline.js";
import { isOutlinerSidebarNode } from "../model/outliner-page.js";
import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import {
  createPerformanceTracer,
  type TraceDetail,
  type TraceSnapshot,
  type TraceSummaryRow
} from "../perf/trace.js";
import {
  PROFILE_STORAGE_KEY,
  isTraceSnapshot,
  summarizePerformanceProfile,
  type LabeledTraceSnapshot,
  type SidebarProfileSnapshot
} from "../perf/profile.js";
import {
  createActiveTabScrollTracker,
  findActiveTabNodeId,
  resetActiveTabScrollTracker,
  scrollActiveTabIntoView,
  type ActiveTabScrollProjection
} from "./active-scroll.js";
import { createDiagnosticsScheduler } from "./diagnostics-scheduler.js";
import {
  cutSubtreeRowRange,
  isRowInCutSubtree,
  keyboardCutPasteAction,
  nextPendingCutNodeId,
  nodeIdForCutPasteTarget,
  pasteAfterCommand,
  type CutPasteShortcutTarget,
  type CutSubtreeRowRange
} from "./cut-paste.js";
import {
  commandForDropPlacement,
  dropModeForPointer,
  dropPlacementForNode,
  dropPlacementForRoot,
  type DropPlacement
} from "./drop-target.js";
import {
  dropPreviewForPlacement,
  type DropPreview,
  type DropPreviewConnector
} from "./drop-preview.js";
import { mergePartialOutlineState } from "./partial-outline-state.js";
import {
  isRestoreScope,
  largeRestoreConfirmationPrompt,
  restoreScopeTargetsNodeOrDescendants
} from "./restore-scope.js";
import { normalizeSearchQuery, segmentSearchText } from "./search.js";
import {
  isActiveStateUpdated,
  isCommandAck,
  isExportTreeResponse,
  isHistoryStatus,
  isInitialTreeSnapshot,
  isNodeStateUpdated,
  isOutlineState,
  isSameParentReorderUpdated,
  isStateUpdated,
  isTreeStructureUpdated,
  messageType,
  type ActiveStateUpdate,
  type NodeStateUpdate,
  type SameParentReorderUpdate,
  type TreeStructureUpdate
} from "./sidebar-messages.js";
import {
  applyCrossParentLeafMoveTreeStructurePatchToProjection,
  applyInsertTreeStructurePatchToProjection,
  applyDeleteTreeStructurePatchToProjection,
  applySameParentReorderTreeStructurePatchToProjection,
  buildVisibleTreeProjection,
  calculateVirtualRange,
  sameParentReorderTreeStructurePatchInfo,
  type SameParentReorderPatchInfo,
  type VirtualRange,
  type VisibleTreeProjection,
  type VisibleTreeRow
} from "./visible-tree.js";
import {
  DEFAULT_ZOOM,
  ZOOM_STORAGE_KEY,
  clampZoom,
  normalizeStoredZoom,
  resetZoom,
  stepZoom,
  type ZoomDirection,
  zoomCssMetrics
} from "./zoom.js";
import {
  APP_PREFERENCES_STORAGE_KEY,
  DEFAULT_APP_PREFERENCES,
  loadAppPreferences,
  normalizeAppPreferences,
  shortcutMatchesEvent,
  type AppPreferences
} from "../preferences.js";

const stateCount = document.querySelector<HTMLSpanElement>("#state-count");
const diagnostics = document.querySelector<HTMLSpanElement>("#diagnostics");
const undoHistory = document.querySelector<HTMLButtonElement>("#undo-history");
const redoHistory = document.querySelector<HTMLButtonElement>("#redo-history");
const refresh = document.querySelector<HTMLButtonElement>("#refresh");
const toolbarOverflow = document.querySelector<HTMLButtonElement>("#toolbar-overflow");
const toolbarOverflowMenu = document.querySelector<HTMLElement>("#toolbar-overflow-menu");
const openOptions = document.querySelector<HTMLButtonElement>("#open-options");
const exportTree = document.querySelector<HTMLButtonElement>("#export-tree");
const importTree = document.querySelector<HTMLButtonElement>("#import-tree");
const importTreeFile = document.querySelector<HTMLInputElement>("#import-tree-file");
const openSidebarWindow = document.querySelector<HTMLButtonElement>("#open-sidebar-window");
const rootDropSurface = document.querySelector<HTMLElement>("main");
const tree = document.querySelector<HTMLElement>("#tree");
const empty = document.querySelector<HTMLElement>("#empty");
const searchInput = document.querySelector<HTMLInputElement>("#search");
const clearSearch = document.querySelector<HTMLButtonElement>("#clear-search");

let currentState: OutlineState | undefined;
let currentStateFullyLoaded = false;
let hydratingFullState = false;
let fullStateHydrationInFlight = false;
let pendingFullHydrationTimer: number | undefined;
let sidebarMutationRevision = 0;
const deletedNodeRevisionById = new Map<NodeId, number>();
let draggedNodeId: NodeId | undefined;
let activeDropPlacement: DropPlacement | undefined;
let currentZoom = DEFAULT_ZOOM;
let appPreferences: AppPreferences = DEFAULT_APP_PREFERENCES;
let wheelZoomDelta = 0;
let currentSearchQuery = "";
let diagnosticsNoticeUntil = 0;
let diagnosticsNoticeTimer: number | undefined;
let activeRename: RenameSession | undefined;
let currentProjection: VisibleTreeProjection | undefined;
let currentProjectionCoverage: SidebarProjectionCoverage | undefined;
let projectionState: OutlineState | undefined;
let projectionQuery: string | undefined;
let scheduledVirtualRender = false;
let preserveRenderedRowWindowOnce = false;
let suppressActiveScrollOnce = false;
let hoverLineScope: HoverLineScope | undefined;
let pendingHoverLineScope: HoverLineScope | undefined;
let pendingHoverGuideApply = false;
let pendingHoverGuideReason: HoverGuideApplyReason = "pointer";
let pendingHoverFeedbackTrace: HoverFeedbackTrace | undefined;
let scheduledHoverGuideFrame: number | undefined;
let lastNonEditInteractionAt = Number.NEGATIVE_INFINITY;
let lastNonEditInteractionBroadcastAt = Number.NEGATIVE_INFINITY;
let lastSparseViewportScrollIntentAt = Number.NEGATIVE_INFINITY;
let pendingCutNodeId: NodeId | undefined;
let currentCutRowRange: CutSubtreeRowRange | undefined;
let pendingShowInTreeNodeId: NodeId | undefined;
let activeRevealTargetNodeId: NodeId | undefined;
let revealHighlightNodeId: NodeId | undefined;
let revealHighlightTimer: number | undefined;
let sidebarWindowId: number | undefined;
let sidebarWindowIdLoaded = false;
let sidebarActiveTabTargetsRevision = 0;
let sidebarActiveTabTargetsCacheRevision = -1;
let sidebarActiveTabTargetsByWindow = new Map<number, NodeId>();
let sparseWindowRequestSequence = 0;
let sparseWindowStateChangeCutoff = 0;
let remoteSearchRequestSequence = 0;
let projectionOwnerRevision = 0;
let pendingRemoteSearchTimer: number | undefined;
let pendingSparseWindowRequest:
  | {
      centerRowIndex: number;
      rowLimit: number;
      query: string;
      retryAttempt: number;
      intent: ProjectionRequestIntent;
      countMode: SparseProjectionCountMode;
    }
  | undefined;
const activeTabScrollTracker = createActiveTabScrollTracker();

type SparseProjectionCountMode = "preserve" | "snapshot";

type ProjectionRequestIntent = {
  kind: "outline" | "search" | "showInTree";
  query: string;
  targetNodeId?: NodeId;
};

type ProjectionOwner = ProjectionRequestIntent & {
  revision: number;
};

type RenderedProjectionSession = {
  lastOutlineProjection?: {
    projection: VisibleTreeProjection;
    coverage?: SidebarProjectionCoverage;
    scrollTop: number;
  };
};

const renderedProjectionSession: RenderedProjectionSession = {};
let pendingRememberAcceptedRenderedProjectionTimer: number | undefined;
let currentProjectionOwner: ProjectionOwner = { kind: "outline", query: "", revision: projectionOwnerRevision };

const WHEEL_ZOOM_THRESHOLD_PX = 80;
const DIAGNOSTICS_NOTICE_MS = 4000;
const DIAGNOSTICS_REFRESH_DELAY_MS = 750;
const DIAGNOSTICS_AFTER_NON_EDIT_INPUT_DELAY_MS = 1500;
const FULL_STATE_HYDRATION_DELAY_MS = 750;
const HOVER_MISSING_COVERAGE_HYDRATION_DELAY_MS = 150;
const HYDRATION_AFTER_NON_EDIT_INPUT_DELAY_MS = 1000;
const HYDRATION_RENDER_INPUT_IDLE_MS = 120;
const HYDRATION_RENDER_INPUT_MAX_DELAY_MS = 1500;
const NON_EDIT_INTERACTION_BROADCAST_MIN_INTERVAL_MS = 500;
const REMOTE_SEARCH_DEBOUNCE_MS = 150;
const SHOW_IN_TREE_HIGHLIGHT_MS = 1200;
const VIRTUAL_OVERSCAN_ROWS = 32;
const SPARSE_SCROLL_WINDOW_OVERSCAN_ROWS = VIRTUAL_OVERSCAN_ROWS;
const HOVER_GUIDE_MAX_SUBTREE_ROWS = 1000;
const GUIDE_TOP = 1;
const GUIDE_BOTTOM = 2;
const GUIDE_FULL = GUIDE_TOP | GUIDE_BOTTOM;
const SVG_NS = "http://www.w3.org/2000/svg";
const SIDEBAR_PORT_NAME = "tabs-outliner-sidebar";
const sidebarProfileInstanceId = createSidebarProfileInstanceId();

type ProfileSnapshot = SidebarProfileSnapshot;

function setCurrentState(nextState: OutlineState): void {
  recordDeletedNodesFromStateReplacement(currentState, nextState);
  currentState = nextState;
}

function recordDeletedNodesFromStateReplacement(
  previous: OutlineState | undefined,
  next: OutlineState
): void {
  if (!previous) {
    return;
  }
  recordDeletedNodeIds(Object.keys(previous.nodes).filter((nodeId) => !next.nodes[nodeId]));
}

function recordDeletedNodeIds(nodeIds: Iterable<NodeId>): void {
  const deletedNodeIds = [...new Set(nodeIds)];
  if (deletedNodeIds.length === 0) {
    return;
  }

  sidebarMutationRevision += 1;
  for (const nodeId of deletedNodeIds) {
    deletedNodeRevisionById.set(nodeId, sidebarMutationRevision);
  }
}

function restoreScopeContainsNodeDeletedAfter(
  scope: RestoreScope,
  revision: number
): boolean {
  return scope.nodeIds.some((nodeId) => (deletedNodeRevisionById.get(nodeId) ?? 0) > revision);
}

function snapshotContainsNodeDeletedAfter(
  snapshot: InitialTreeSnapshot,
  revision: number
): boolean {
  for (const nodeId of nodeIdsInProjectionSnapshot(snapshot)) {
    if ((deletedNodeRevisionById.get(nodeId) ?? 0) > revision) {
      return true;
    }
  }
  return false;
}

function nodeIdsInProjectionSnapshot(snapshot: InitialTreeSnapshot): Set<NodeId> {
  return new Set<NodeId>([
    ...snapshot.state.rootIds,
    ...Object.keys(snapshot.state.nodes),
    ...snapshot.projection.rows.map((row) => row.nodeId),
    ...snapshot.projection.visibleNodeIds,
    ...snapshot.projection.matchingNodeIds
  ]);
}

type SidebarProfileConsole = {
  enable(): Promise<ProfileSnapshot>;
  disable(): Promise<ProfileSnapshot>;
  clear(): Promise<void>;
  snapshot(): Promise<ProfileSnapshot>;
  summary(): Promise<TraceSummaryRow[]>;
};

type InitialTreeSnapshotRequest = {
  type: "getInitialTreeSnapshot";
};

type InitialTreeSnapshotWindowRequest = {
  type: "getInitialTreeSnapshotWindow";
  centerRowIndex: number;
  rowLimit?: number;
};

type TreeProjectionSliceRequest = {
  type: "getTreeProjectionSlice";
  centerRowIndex: number;
  rowLimit?: number;
  query?: string;
  targetNodeId?: NodeId;
};

type OpenSidebarWindowRequest = {
  type: "openSidebarWindow";
};

type ExportTreeRequest = {
  type: "exportTree";
};

type SidebarNonEditInteractionMessage = {
  type: "sidebarNonEditInteraction";
};

type SidebarPerformanceTraceMessage =
  | {
      type: "setSidebarPerformanceTraceEnabled";
      enabled: boolean;
    }
  | {
      type: "clearSidebarPerformanceTrace";
    }
  | {
      type: "getSidebarPerformanceTrace";
    }
  | {
      type: "collectSidebarPerformanceTrace";
      requestId: string;
    };

declare global {
  interface Window {
    tabsOutlinerProfile?: SidebarProfileConsole;
    __tabsOutlinerBootSnapshot?: InitialTreeSnapshot;
  }
}

type RenameSession = {
  nodeId: NodeId;
  draft: string;
};

type SidebarProjectionCoverage = {
  startRowIndex: number;
  endRowIndex: number;
  editableNodeIds: Set<NodeId>;
  completeSubtreeNodeIds: Set<NodeId>;
  completeSiblingParentIds: Set<NodeId>;
};

type HoverLineScope = {
  rowIndex: number;
  parentRowIndex?: number;
  subtreeEndIndex: number;
  targetDepth: number;
};

type HoverGuideApplyReason = "pointer" | "pointer-clear" | "scroll";

type HoverFeedbackTrace = {
  eventTimeStamp: number;
  detail: TraceDetail;
};

type HoverGuideSegments = {
  horizontalDepth?: number;
  verticalSegments: Map<number, number>;
};

type IconName =
  | "chevron-right"
  | "chevron-down"
  | "scissors"
  | "clipboard"
  | "group"
  | "close-circle"
  | "flatten"
  | "outdent"
  | "root-outdent"
  | "root-down"
  | "pencil"
  | "trash"
  | "locate"
  | "refresh";

const dropMarker = document.createElement("li");
dropMarker.className = "drop-marker";
dropMarker.dataset.testid = "drop-marker";
dropMarker.setAttribute("aria-hidden", "true");

const dropGuideLayer = document.createElement("li");
dropGuideLayer.className = "drop-guide-layer";
dropGuideLayer.dataset.testid = "drop-guide-layer";
dropGuideLayer.setAttribute("aria-hidden", "true");

const diagnosticsScheduler = createDiagnosticsScheduler(loadDiagnostics, {
  clock: {
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timerId) => window.clearTimeout(timerId)
  },
  delayMs: DIAGNOSTICS_REFRESH_DELAY_MS,
  defer: diagnosticsNonEditInteractionDeferralMs
});
const perfTrace = createPerformanceTracer("sidebar", {
  enabled: storedProfileEnabled()
});

installProfileConsole();
applyZoom(currentZoom);
registerPreferenceListener();
registerZoomShortcuts();
registerSearchControls();
registerToolbarOverflowControls();
registerPortableTreeControls();
registerHistoryControls();
registerTreeControls();
registerVirtualViewport();
updateHydrationControls();
void loadZoomPreference();
void loadSidebarPreferences();
void loadState();
void loadHistoryStatus();

refresh?.addEventListener("click", () => {
  void runAndRender({ type: "refresh" });
});

openOptions?.addEventListener("click", () => {
  void browser.runtime.openOptionsPage().catch(() => {
    showDiagnosticsNotice("Options unavailable", { error: true });
  });
});

openSidebarWindow?.addEventListener("click", () => {
  void openFullSizeSidebarWindow();
});

rootDropSurface?.addEventListener("dragover", (event) => {
  if (isNodeRowEvent(event) || isNestedTreeEvent(event)) {
    if (activeDropPlacement) {
      event.preventDefault();
    }
    return;
  }

  const placement = currentState && draggedNodeId ? dropPlacementForRoot(currentState, draggedNodeId) : undefined;
  if (!placement) {
    clearDropPreview();
    return;
  }
  if (!canUseDropPlacement(placement)) {
    requestSparseDragDropCoverage();
    return;
  }

  event.preventDefault();
  showDropPlacement(placement);
});

rootDropSurface?.addEventListener("dragleave", (event) => {
  if (event.relatedTarget instanceof Node && rootDropSurface.contains(event.relatedTarget)) {
    return;
  }

  clearDropPreview();
});

rootDropSurface?.addEventListener("drop", (event) => {
  if (isNodeRowEvent(event)) {
    return;
  }

  const placement =
    activeDropPlacement ??
    (currentState && draggedNodeId ? dropPlacementForRoot(currentState, draggedNodeId) : undefined);
  if (!placement) {
    clearDragState();
    return;
  }
  if (!canUseDropPlacement(placement)) {
    requestSparseDragDropCoverage();
    clearDragState();
    return;
  }

  event.preventDefault();
  performDrop(placement);
});

const backgroundPort = connectToBackgroundPort();
backgroundPort?.onMessage.addListener((message) => {
  void Promise.resolve(handleBackgroundMessage(message)).catch((error) => {
    perfTrace.mark("sidebar.runtime.port.message.error", { message: commandErrorText(error) });
  });
});
backgroundPort?.onDisconnect.addListener(() => {
  perfTrace.mark("sidebar.runtime.port.disconnect");
});

browser.runtime.onMessage.addListener((message) => handleBackgroundMessage(message));

function connectToBackgroundPort(): WebExtensionPort | undefined {
  try {
    return browser.runtime.connect?.({ name: SIDEBAR_PORT_NAME });
  } catch {
    return undefined;
  }
}

function handleBackgroundMessage(message: unknown): unknown {
  if (isSidebarPerformanceTraceMessage(message)) {
    return handleSidebarPerformanceTraceMessage(message);
  }

  perfTrace.measure("sidebar.runtime.message", { type: messageType(message) }, () => {
    if (isSidebarNonEditInteractionMessage(message)) {
      noteRemoteNonEditInteraction();
      return;
    }
    if (isStateUpdated(message)) {
      if (pendingFullHydrationTimer !== undefined) {
        window.clearTimeout(pendingFullHydrationTimer);
        pendingFullHydrationTimer = undefined;
      }
      const preserveSparseViewport = shouldPreserveSparseViewportScrollIntent();
      preserveRenderedRowWindowOnce = preserveSparseViewport && currentSparseProjectionIntersectsViewport();
      suppressActiveScrollOnce = preserveSparseViewport;
      setCurrentState(message.state);
      currentStateFullyLoaded = true;
      currentProjectionCoverage = undefined;
      invalidateSidebarWindowActiveTabTargets();
      render();
      scheduleDiagnosticsLoad();
      return;
    }
    if (isActiveStateUpdated(message)) {
      applyActiveStateUpdate(message.updates);
      return;
    }
    if (isNodeStateUpdated(message)) {
      applyNodeStateUpdate(message);
      scheduleDiagnosticsLoad();
      return;
    }
    if (isTreeStructureUpdated(message)) {
      applyTreeStructureUpdate(message);
      scheduleDiagnosticsLoad();
      return;
    }
    if (isSameParentReorderUpdated(message)) {
      applySameParentReorderUpdate(message);
      scheduleDiagnosticsLoad();
      return;
    }
    if (isHistoryStatus(message)) {
      updateHistoryControls(message);
    }
  });
  return undefined;
}

async function loadState(): Promise<void> {
  try {
    await loadSidebarWindowId();
    const bootSnapshot = window.__tabsOutlinerBootSnapshot;
    if (isInitialTreeSnapshot(bootSnapshot)) {
      delete window.__tabsOutlinerBootSnapshot;
      if (!shouldUseInitialTreeSnapshot(bootSnapshot)) {
        await hydrateFullState();
        return;
      }
      applyInitialTreeSnapshot(bootSnapshot);
      scheduleDiagnosticsLoad();
      return;
    }

    const initial = await sendCommand({ type: "getInitialTreeSnapshot" });
    if (isInitialTreeSnapshot(initial) && shouldUseInitialTreeSnapshot(initial)) {
      applyInitialTreeSnapshot(initial);
      scheduleDiagnosticsLoad();
      return;
    }

    await hydrateFullState();
  } catch (error) {
    showLoadError(error);
  }
}

async function hydrateFullState(): Promise<void> {
  if (pendingFullHydrationTimer !== undefined) {
    window.clearTimeout(pendingFullHydrationTimer);
    pendingFullHydrationTimer = undefined;
  }
  if (fullStateHydrationInFlight) {
    return;
  }
  fullStateHydrationInFlight = true;
  try {
    await perfTrace.measureAsync("sidebar.hydration", hydrationTraceDetail(), async () => {
      hydratingFullState = true;
      performance.mark("tabs-outliner.sidebar.hydration.start");
      updateHydrationControls();
      const nextState = (await sendCommand({ type: "getState" })) as OutlineState;
      const renderDelayMs = await waitForHydrationRenderIdle();
      if (renderDelayMs > 0) {
        perfTrace.record("sidebar.hydration.renderDelay", renderDelayMs, {
          reason: "recent-input",
          rows: currentProjection?.rows.length ?? 0
        });
      }
      const wasSparseProjection = Boolean(currentProjection && isSparseInitialProjection(currentProjection));
      const sparseProjectionIntersectedViewport = currentSparseProjectionIntersectsViewport();
      const preserveSparseViewport = shouldPreserveSparseViewportScrollIntent();
      setCurrentState(nextState);
      currentStateFullyLoaded = true;
      currentProjectionCoverage = undefined;
      preserveRenderedRowWindowOnce = wasSparseProjection && preserveSparseViewport && sparseProjectionIntersectedViewport;
      suppressActiveScrollOnce = wasSparseProjection && preserveSparseViewport;
      invalidateSidebarWindowActiveTabTargets();
      hydratingFullState = false;
      updateHydrationControls();
      render();
      performance.mark("tabs-outliner.sidebar.hydration.complete");
      scheduleDiagnosticsLoad();
    });
  } catch (error) {
    hydratingFullState = false;
    updateHydrationControls();
    revealSidebar();
    showLoadError(error);
  } finally {
    fullStateHydrationInFlight = false;
  }
}

function hydrationTraceDetail(): TraceDetail {
  const rows = currentProjection?.rows.length ?? 0;
  return {
    initialSnapshotVisible: Boolean(currentProjection),
    sparseInitialSnapshot: currentProjection ? isSparseInitialProjection(currentProjection) : false,
    rows,
    totalRows: currentProjection?.totalRowCount ?? rows
  };
}

function scheduleFullStateHydration(delayMs = FULL_STATE_HYDRATION_DELAY_MS): void {
  if (!hydratingFullState || fullStateHydrationInFlight || pendingFullHydrationTimer !== undefined) {
    return;
  }
  pendingFullHydrationTimer = window.setTimeout(() => {
    pendingFullHydrationTimer = undefined;
    void hydrateFullState();
  }, delayMs);
}

async function waitForHydrationRenderIdle(): Promise<number> {
  if (!currentProjection || !isSparseInitialProjection(currentProjection)) {
    return 0;
  }
  if (!Number.isFinite(lastNonEditInteractionAt)) {
    return 0;
  }

  const startedAt = performance.now();
  while (true) {
    if (pendingHoverGuideApply || scheduledHoverGuideFrame !== undefined) {
      await nextAnimationFrame();
      await nextAnimationFrame();
    }

    const now = performance.now();
    const elapsedMs = now - startedAt;
    const idleMs = now - lastNonEditInteractionAt;
    if (idleMs >= HYDRATION_RENDER_INPUT_IDLE_MS || elapsedMs >= HYDRATION_RENDER_INPUT_MAX_DELAY_MS) {
      return elapsedMs;
    }

    await delay(Math.min(HYDRATION_RENDER_INPUT_IDLE_MS - idleMs, HYDRATION_RENDER_INPUT_MAX_DELAY_MS - elapsedMs));
  }
}

function applyInitialTreeSnapshot(snapshot: InitialTreeSnapshot): void {
  setCurrentProjectionOwner(remoteSearchRequestIntent(currentSearchQuery));
  setCurrentState(snapshot.state);
  currentStateFullyLoaded = initialTreeSnapshotHasFullState(snapshot);
  invalidateSidebarWindowActiveTabTargets();
  hydratingFullState = initialTreeSnapshotNeedsFullHydration(snapshot);
  currentProjection = projectionFromInitialTreeSnapshot(snapshot);
  currentProjectionCoverage = projectionCoverageFromSnapshot(snapshot.coverage);
  projectionState = currentState;
  projectionQuery = "";
  currentCutRowRange = undefined;
  resetHoverLineScope();
  updateHydrationControls();
  renderInitialTreeSnapshot();
  // A storage-served snapshot can predate journal-replayed changes (the background serves
  // the persisted boot snapshot while its own startup load is still running), so converge
  // on background truth without waiting -- interaction or a divergent patch may never come,
  // leaving a stale paint (e.g. a deleted node) up indefinitely. Live-served sparse
  // snapshots are fresh and keep hydrating on demand.
  if (snapshot.fromStorage) {
    scheduleFullStateHydration();
  }
  applyPendingSearchQueryAfterStateReady();
}

function renderInitialTreeSnapshot(): void {
  perfTrace.measure("sidebar.render.initialSnapshot", () => {
    if (!tree || !stateCount || !currentProjection) {
      return;
    }
    clearDropPreview();
    updateProjectionChrome(currentProjection);
    renderSnapshotRows(currentProjection);
    rememberAcceptedRenderedProjection(currentProjection);
    revealSidebar();
  });
}

function applyPendingSearchQueryAfterStateReady(): void {
  updateSearchControls();
  if (!currentSearchQuery.trim()) {
    return;
  }
  if (shouldUseRemoteProjectionSearch()) {
    scheduleRemoteSearchProjection(currentSearchQuery);
    return;
  }
  render();
}

function applySparseScrollWindowSnapshot(
  snapshot: InitialTreeSnapshot,
  options: { countMode?: SparseProjectionCountMode } = {}
): void {
  if (
    !currentProjection ||
    !canUseHydratingProjectionSlice(currentProjection) ||
    !snapshot.hydrating ||
    !sparseSnapshotMatchesCurrentProjection(snapshot)
  ) {
    return;
  }

  mergeProjectionSliceSnapshot(snapshot, { coverageMode: "merge" });
  const nextProjection = projectionFromInitialTreeSnapshot(snapshot);
  if (!nextProjection.isSearchActive && options.countMode !== "snapshot") {
    nextProjection.nodeCount = currentProjection.nodeCount;
    nextProjection.closedCount = currentProjection.closedCount;
    nextProjection.matchCount = currentProjection.matchCount;
  }
  currentProjection = nextProjection;
  projectionState = currentState;
  projectionQuery = snapshot.projection.query;
  currentCutRowRange = undefined;
  rememberAcceptedRenderedProjection(currentProjection);
  updateHydrationControls();

  perfTrace.measure("sidebar.render.sparseScrollWindow", {
    rows: currentProjection.rows.length,
    totalRows: currentProjection.totalRowCount ?? currentProjection.rows.length
  }, () => {
    if (!tree || !stateCount || !currentProjection) {
      return;
    }
    clearDropPreview();
    updateProjectionChrome(currentProjection);
    renderSnapshotRows(currentProjection, { scrollToActive: false });
    revealSidebar();
  });
}

function mergeProjectionSliceSnapshot(
  snapshot: InitialTreeSnapshot,
  options: { coverageMode?: "merge" | "replace" | "none" } = {}
): void {
  const coverage = projectionCoverageFromSnapshot(snapshot.coverage);
  currentState = mergePartialOutlineState(currentState, snapshot.state, {
    ...(coverage ? { completeSiblingParentIds: coverage.completeSiblingParentIds } : {})
  });
  currentStateFullyLoaded = !snapshot.hydrating && currentStateHasFullNodeTable(snapshot.projection.nodeCount);
  invalidateSidebarWindowActiveTabTargets();
  hydratingFullState = snapshot.hydrating || !currentStateFullyLoaded;
  if (options.coverageMode === "replace") {
    currentProjectionCoverage = coverage;
  } else if (options.coverageMode !== "none") {
    currentProjectionCoverage = mergeProjectionCoverage(currentProjectionCoverage, coverage);
  }
}

function requestSparseScrollWindowIfNeeded(options: { force?: boolean } = {}): void {
  if (!rootDropSurface || !currentProjection || !hydratingFullState) {
    return;
  }
  if (
    !isSparseInitialProjection(currentProjection) &&
    (!options.force || !projectionRequiresHydrationCoverage(currentProjection))
  ) {
    return;
  }

  const viewportRange = clampedViewportRowRangeForProjection(currentProjection);
  const viewportStartRow = viewportRange.start;
  const viewportEndRow = viewportRange.end;
  if (
    viewportEndRow <= viewportStartRow ||
    (!options.force && sparseProjectionCoversViewport(currentProjection, viewportStartRow, viewportEndRow))
  ) {
    return;
  }

  const totalRowCount = currentProjection.totalRowCount ?? currentProjection.rows.length;
  const centerRowIndex = Math.max(
    0,
    Math.min(totalRowCount - 1, Math.floor((viewportStartRow + viewportEndRow - 1) / 2))
  );
  const rowLimit = sparseScrollWindowRowLimit(viewportEndRow - viewportStartRow);
  const query = currentProjection.query;
  const intent = sparseWindowRequestIntent(query);
  if (!projectionRequestIntentMatchesCurrent(intent)) {
    return;
  }
  if (
    pendingSparseWindowRequest?.centerRowIndex === centerRowIndex &&
    pendingSparseWindowRequest.rowLimit === rowLimit &&
    pendingSparseWindowRequest.query === query &&
    projectionRequestIntentsEqual(pendingSparseWindowRequest.intent, intent)
  ) {
    return;
  }

  startSparseScrollWindowRequest(centerRowIndex, rowLimit, query, 0);
}

function startSparseScrollWindowRequest(
  centerRowIndex: number,
  rowLimit: number,
  query: string,
  retryAttempt: number,
  options: { countMode?: SparseProjectionCountMode } = {}
): void {
  const intent = sparseWindowRequestIntent(query);
  if (!projectionRequestIntentMatchesCurrent(intent)) {
    return;
  }
  const countMode = options.countMode ?? "preserve";
  pendingSparseWindowRequest = { centerRowIndex, rowLimit, query, retryAttempt, intent, countMode };
  const requestId = ++sparseWindowRequestSequence;
  const rowHeight = currentRowHeight();
  const viewportRange = currentViewportRowRange(rowHeight);
  const requestMutationRevision = sidebarMutationRevision;
  perfTrace.mark("sidebar.sparseScrollWindow.request", {
    centerRowIndex,
    rowLimit,
    search: Boolean(query),
    retryAttempt,
    viewportStartRow: viewportRange.start,
    viewportEndRow: viewportRange.end
  });
  void loadSparseScrollWindow(
    centerRowIndex,
    rowLimit,
    query,
    requestId,
    retryAttempt,
    intent,
    countMode,
    requestMutationRevision
  );
}

async function loadSparseScrollWindow(
  centerRowIndex: number,
  rowLimit: number,
  query: string,
  requestId: number,
  retryAttempt: number,
  intent: ProjectionRequestIntent,
  countMode: SparseProjectionCountMode,
  requestMutationRevision: number
): Promise<void> {
  try {
    const response = await requestProjectionSlice(centerRowIndex, rowLimit, query);
    await nextAnimationFrame();
    const responseContainsStaleDeletedNode =
      isInitialTreeSnapshot(response) &&
      snapshotContainsNodeDeletedAfter(response, requestMutationRevision);
    if (requestId <= sparseWindowStateChangeCutoff) {
      if (
        isInitialTreeSnapshot(response) &&
        !responseContainsStaleDeletedNode &&
        response.hydrating &&
        snapshotProjectionMatchesRequestIntent(response, intent)
      ) {
        mergeProjectionSliceSnapshot(response, { coverageMode: "none" });
      }
      requestSparseScrollWindowIfNeeded();
      return;
    }
    if (requestId !== sparseWindowRequestSequence) {
      if (
        isInitialTreeSnapshot(response) &&
        !responseContainsStaleDeletedNode &&
        canUseHydratingProjectionSlice(currentProjection) &&
        projectionRequestIntentMatchesCurrent(intent) &&
        snapshotProjectionMatchesRequestIntent(response, intent) &&
        sparseSnapshotMatchesCurrentProjection(response) &&
        sparseSnapshotIntersectsCurrentViewport(response)
      ) {
        applySparseScrollWindowSnapshot(response, { countMode });
      } else if (
        isInitialTreeSnapshot(response) &&
        !responseContainsStaleDeletedNode &&
        response.hydrating &&
        snapshotProjectionMatchesRequestIntent(response, intent)
      ) {
        mergeProjectionSliceSnapshot(response, { coverageMode: "none" });
      }
      requestSparseScrollWindowIfNeeded();
      return;
    }

    if (
      !isInitialTreeSnapshot(response) ||
      responseContainsStaleDeletedNode ||
      !currentProjection ||
      !canUseHydratingProjectionSlice(currentProjection) ||
      !projectionRequestIntentMatchesCurrent(intent) ||
      !snapshotProjectionMatchesRequestIntent(response, intent) ||
      !sparseSnapshotMatchesCurrentProjection(response)
    ) {
      pendingSparseWindowRequest = undefined;
      requestSparseScrollWindowIfNeeded();
      return;
    }

    if (!sparseSnapshotCoversCurrentViewport(response)) {
      if (sparseSnapshotIntersectsCurrentViewport(response)) {
        applySparseScrollWindowSnapshot(response, { countMode });
      } else {
        mergeProjectionSliceSnapshot(response, { coverageMode: "merge" });
      }
      pendingSparseWindowRequest = undefined;
      requestSparseScrollWindowIfNeeded();
      return;
    }

    applySparseScrollWindowSnapshot(response, { countMode });
    pendingSparseWindowRequest = undefined;
    requestSparseScrollWindowIfNeeded();
  } catch (error) {
    if (requestId === sparseWindowRequestSequence) {
      pendingSparseWindowRequest = undefined;
      perfTrace.mark("sidebar.sparseScrollWindow.error", { message: commandErrorText(error) });
      if (retryAttempt < 1 && !currentSparseProjectionCoversViewport()) {
        startSparseScrollWindowRequest(centerRowIndex, rowLimit, query, retryAttempt + 1, { countMode });
      }
    }
  }
}

async function requestProjectionSlice(
  centerRowIndex: number,
  rowLimit: number,
  query = "",
  options: { targetNodeId?: NodeId } = {}
): Promise<unknown> {
  return sendCommand({
    type: "getTreeProjectionSlice",
    centerRowIndex,
    rowLimit,
    ...(query ? { query } : {}),
    ...(options.targetNodeId ? { targetNodeId: options.targetNodeId } : {})
  });
}

function currentProjectionRequestIntent(): ProjectionRequestIntent {
  return projectionIntentFromOwner(currentProjectionOwner);
}

function sparseWindowRequestIntent(query: string): ProjectionRequestIntent {
  const trimmedQuery = query.trim();
  if (trimmedQuery) {
    return { kind: "search", query: trimmedQuery };
  }
  if (currentProjectionOwner.kind === "showInTree") {
    return currentProjectionRequestIntent();
  }
  return { kind: "outline", query: "" };
}

function remoteSearchRequestIntent(query: string): ProjectionRequestIntent {
  const trimmedQuery = query.trim();
  return trimmedQuery ? { kind: "search", query: trimmedQuery } : { kind: "outline", query: "" };
}

function remoteSearchProjectionRequestWindow(query: string): { centerRowIndex: number; rowLimit: number } {
  if (query.trim()) {
    return { centerRowIndex: 0, rowLimit: INITIAL_TREE_SNAPSHOT_ROW_LIMIT };
  }

  const rowHeight = currentRowHeight();
  const viewportRange = currentViewportRowRange(rowHeight);
  const viewportRows = Math.max(1, viewportRange.end - viewportRange.start);
  const rowLimit = sparseScrollWindowRowLimit(viewportRows);
  const fallbackProjection = renderedProjectionSession.lastOutlineProjection?.projection ?? currentProjection;
  const totalRowCount = fallbackProjection?.totalRowCount ?? fallbackProjection?.rows.length ?? 0;
  if (totalRowCount <= 0) {
    return { centerRowIndex: 0, rowLimit };
  }

  return {
    centerRowIndex: Math.max(
      0,
      Math.min(totalRowCount - 1, Math.floor((viewportRange.start + viewportRange.end - 1) / 2))
    ),
    rowLimit
  };
}

function remoteShowInTreeRequestIntent(nodeId: NodeId): ProjectionRequestIntent {
  return { kind: "showInTree", query: "", targetNodeId: nodeId };
}

function projectionIntentFromOwner(owner: ProjectionOwner): ProjectionRequestIntent {
  return {
    kind: owner.kind,
    query: owner.query,
    ...(owner.targetNodeId ? { targetNodeId: owner.targetNodeId } : {})
  };
}

function setCurrentProjectionOwner(intent: ProjectionRequestIntent): ProjectionOwner {
  const nextOwner = {
    ...normalizedProjectionRequestIntent(intent),
    revision: ++projectionOwnerRevision
  };
  currentProjectionOwner = nextOwner;
  if (nextOwner.kind !== "showInTree") {
    pendingShowInTreeNodeId = undefined;
    activeRevealTargetNodeId = undefined;
    clearRevealHighlightTimer();
    revealHighlightNodeId = undefined;
  } else if (activeRevealTargetNodeId && activeRevealTargetNodeId !== nextOwner.targetNodeId) {
    activeRevealTargetNodeId = undefined;
    clearRevealHighlightTimer();
    revealHighlightNodeId = undefined;
  }
  if (nextOwner.kind !== "outline") {
    lastSparseViewportScrollIntentAt = Number.NEGATIVE_INFINITY;
  }
  return nextOwner;
}

function normalizedProjectionRequestIntent(intent: ProjectionRequestIntent): ProjectionRequestIntent {
  const query = intent.query.trim();
  return {
    kind: intent.kind,
    query,
    ...(intent.targetNodeId ? { targetNodeId: intent.targetNodeId } : {})
  };
}

function projectionRequestIntentMatchesCurrent(intent: ProjectionRequestIntent): boolean {
  return projectionRequestIntentsEqual(intent, currentProjectionRequestIntent());
}

function projectionRequestIntentsEqual(left: ProjectionRequestIntent, right: ProjectionRequestIntent): boolean {
  const normalizedLeft = normalizedProjectionRequestIntent(left);
  const normalizedRight = normalizedProjectionRequestIntent(right);
  return (
    normalizedLeft.kind === normalizedRight.kind &&
    normalizeSearchQuery(normalizedLeft.query) === normalizeSearchQuery(normalizedRight.query) &&
    normalizedLeft.targetNodeId === normalizedRight.targetNodeId
  );
}

function snapshotProjectionMatchesRequestIntent(
  snapshot: InitialTreeSnapshot,
  intent: ProjectionRequestIntent
): boolean {
  return normalizeSearchQuery(snapshot.projection.query) === normalizeSearchQuery(intent.query);
}

function sparseScrollWindowRowLimit(viewportRows: number): number {
  const requestedRows = Math.ceil(viewportRows + SPARSE_SCROLL_WINDOW_OVERSCAN_ROWS * 2 + 1);
  return Math.max(1, Math.min(INITIAL_TREE_SNAPSHOT_ROW_LIMIT, requestedRows));
}

function sparseProjectionCoversViewport(
  projection: VisibleTreeProjection,
  viewportStartRow: number,
  viewportEndRow: number
): boolean {
  return sparseRowsCoverViewport(projection.rows, viewportStartRow, viewportEndRow);
}

function sparseSnapshotCoversCurrentViewport(snapshot: InitialTreeSnapshot): boolean {
  const viewportRange = clampedViewportRowRangeForProjection(snapshot.projection);
  return sparseRowsCoverViewport(snapshot.projection.rows, viewportRange.start, viewportRange.end);
}

function sparseSnapshotIntersectsCurrentViewport(snapshot: InitialTreeSnapshot): boolean {
  const viewportRange = clampedViewportRowRangeForProjection(snapshot.projection);
  if (viewportRange.end <= viewportRange.start) {
    return false;
  }
  return snapshot.projection.rows.some((row) => row.index >= viewportRange.start && row.index < viewportRange.end);
}

function sparseSnapshotMatchesCurrentProjection(snapshot: InitialTreeSnapshot): boolean {
  if (!currentProjection || pendingShowInTreeNodeId) {
    return false;
  }
  return (
    normalizeSearchQuery(snapshot.projection.query) === normalizeSearchQuery(currentProjection.query) &&
    normalizeSearchQuery(snapshot.projection.query) === normalizeSearchQuery(currentSearchQuery)
  );
}

function currentSparseProjectionCoversViewport(): boolean {
  if (!currentProjection || !isSparseInitialProjection(currentProjection)) {
    return false;
  }

  const viewportRange = clampedViewportRowRangeForProjection(currentProjection);
  return sparseRowsCoverViewport(currentProjection.rows, viewportRange.start, viewportRange.end);
}

function currentSparseProjectionIntersectsViewport(): boolean {
  if (!currentProjection || !isSparseInitialProjection(currentProjection)) {
    return false;
  }

  const viewportRange = clampedViewportRowRangeForProjection(currentProjection);
  return currentProjection.rows.some((row) => row.index >= viewportRange.start && row.index < viewportRange.end);
}

function clampedViewportRowRangeForProjection(projection: {
  rows: readonly { index: number }[];
  totalRowCount?: number;
}): { start: number; end: number } {
  const rawRange = currentViewportRowRange(currentRowHeight());
  if (rawRange.end <= rawRange.start) {
    return rawRange;
  }

  const totalRowCount = projection.totalRowCount ?? projection.rows.length;
  if (totalRowCount <= 0) {
    return { start: 0, end: 0 };
  }

  const end = Math.max(0, Math.min(rawRange.end, totalRowCount));
  const start = Math.max(0, Math.min(rawRange.start, Math.max(0, end - 1)));
  return { start, end };
}

function noteSparseViewportScrollIntent(): void {
  if (currentProjection && isSparseInitialProjection(currentProjection) && !currentSparseProjectionIntersectsViewport()) {
    if (currentProjectionOwner.kind === "showInTree") {
      setCurrentProjectionOwner(remoteSearchRequestIntent(currentSearchQuery));
    }
    lastSparseViewportScrollIntentAt = performance.now();
  }
}

function shouldPreserveSparseViewportScrollIntent(): boolean {
  return (
    currentProjection !== undefined &&
    isSparseInitialProjection(currentProjection) &&
    Number.isFinite(lastSparseViewportScrollIntentAt)
  );
}

function shouldPreserveSparseViewportForProjection(projection: VisibleTreeProjection): boolean {
  if (!shouldPreserveSparseViewportScrollIntent()) {
    return false;
  }
  return !projection.rows.some((row) => row.nodeId === projection.activeTabNodeId);
}

function currentViewportRowRange(rowHeight: number): { start: number; end: number } {
  if (!rootDropSurface) {
    return { start: 0, end: 0 };
  }

  const effectiveRowHeight = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 1;
  return {
    start: Math.floor(rootDropSurface.scrollTop / effectiveRowHeight),
    end: Math.ceil((rootDropSurface.scrollTop + rootDropSurface.clientHeight) / effectiveRowHeight)
  };
}

function sparseRowsCoverViewport(
  rows: readonly { index: number }[],
  viewportStartRow: number,
  viewportEndRow: number
): boolean {
  if (viewportEndRow <= viewportStartRow || rows.length === 0) {
    return false;
  }

  const coveredRowIndexes = new Set(rows.map((row) => row.index));
  for (let rowIndex = viewportStartRow; rowIndex < viewportEndRow; rowIndex += 1) {
    if (!coveredRowIndexes.has(rowIndex)) {
      return false;
    }
  }
  return true;
}

function shouldUseInitialTreeSnapshot(snapshot: InitialTreeSnapshot): boolean {
  return (
    !snapshot.hydrating ||
    snapshot.projection.totalRowCount <= snapshot.projection.rows.length ||
    typeof snapshot.projection.activeTabRowIndex === "number"
  );
}

function initialTreeSnapshotNeedsFullHydration(snapshot: InitialTreeSnapshot): boolean {
  return snapshot.hydrating || !initialTreeSnapshotHasFullState(snapshot);
}

function initialTreeSnapshotHasFullState(snapshot: InitialTreeSnapshot): boolean {
  return Object.keys(snapshot.state.nodes).length >= snapshot.projection.nodeCount;
}

function currentStateHasFullNodeTable(expectedNodeCount: number): boolean {
  return Boolean(currentState && Object.keys(currentState.nodes).length >= expectedNodeCount);
}

async function loadZoomPreference(): Promise<void> {
  const stored = await browser.storage.local.get(ZOOM_STORAGE_KEY).catch(() => undefined);
  if (!stored) {
    return;
  }

  setZoom(normalizeStoredZoom(stored[ZOOM_STORAGE_KEY]), { persist: false });
}

async function loadSidebarWindowId(): Promise<void> {
  if (sidebarWindowIdLoaded) {
    return;
  }

  sidebarWindowIdLoaded = true;
  sidebarWindowId = await currentSidebarWindowId();
}

async function loadSidebarPreferences(): Promise<void> {
  appPreferences = await loadAppPreferences().catch(() => DEFAULT_APP_PREFERENCES);
}

function registerPreferenceListener(): void {
  browser.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[APP_PREFERENCES_STORAGE_KEY]) {
      return;
    }
    appPreferences = normalizeAppPreferences(changes[APP_PREFERENCES_STORAGE_KEY].newValue);
  });
}

function installProfileConsole(): void {
  if (perfTrace.isEnabled()) {
    void setBackgroundTraceEnabled(true);
  }

  window.tabsOutlinerProfile = {
    enable: async () => {
      setSidebarPerformanceTraceEnabled(true);
      await setBackgroundTraceEnabled(true);
      return profileSnapshot();
    },
    disable: async () => {
      setSidebarPerformanceTraceEnabled(false);
      await setBackgroundTraceEnabled(false);
      return profileSnapshot();
    },
    clear: async () => {
      clearSidebarPerformanceTrace();
      await browser.runtime.sendMessage({ type: "clearPerformanceTrace" }).catch(() => undefined);
    },
    snapshot: profileSnapshot,
    summary: async () => {
      const snapshot = await profileSnapshot();
      return summarizePerformanceProfile(snapshot);
    }
  };
}

async function profileSnapshot(): Promise<ProfileSnapshot> {
  const background = (await browser.runtime.sendMessage({ type: "getPerformanceTrace" }).catch(() => undefined)) as
    | unknown;

  return {
    sidebar: perfTrace.snapshot(),
    ...(isTraceSnapshot(background) ? { background } : {})
  };
}

async function handleSidebarPerformanceTraceMessage(
  message: SidebarPerformanceTraceMessage
): Promise<TraceSnapshot | { ok: true }> {
  if (message.type === "setSidebarPerformanceTraceEnabled") {
    setSidebarPerformanceTraceEnabled(message.enabled);
    return { ok: true };
  }
  if (message.type === "clearSidebarPerformanceTrace") {
    clearSidebarPerformanceTrace();
    return { ok: true };
  }
  if (message.type === "collectSidebarPerformanceTrace") {
    await browser.runtime.sendMessage({
      type: "sidebarPerformanceTraceCollected",
      requestId: message.requestId,
      sidebar: await labeledSidebarPerformanceTrace()
    }).catch(() => undefined);
    return { ok: true };
  }
  return perfTrace.snapshot();
}

function isSidebarPerformanceTraceMessage(message: unknown): message is SidebarPerformanceTraceMessage {
  if (!message || typeof message !== "object") {
    return false;
  }
  const type = (message as { type?: unknown }).type;
  return type === "getSidebarPerformanceTrace" ||
    type === "clearSidebarPerformanceTrace" ||
    (type === "collectSidebarPerformanceTrace" &&
      typeof (message as { requestId?: unknown }).requestId === "string") ||
    (type === "setSidebarPerformanceTraceEnabled" &&
      typeof (message as { enabled?: unknown }).enabled === "boolean");
}

function isSidebarNonEditInteractionMessage(message: unknown): message is SidebarNonEditInteractionMessage {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "sidebarNonEditInteraction"
  );
}

async function labeledSidebarPerformanceTrace(): Promise<LabeledTraceSnapshot> {
  const windowId = await currentSidebarWindowId();
  return {
    id: windowId === undefined ? `sidebar-${sidebarProfileInstanceId}` : `sidebar-window-${windowId}`,
    label: windowId === undefined ? `Sidebar ${sidebarProfileInstanceId.slice(0, 8)}` : `Sidebar window ${windowId}`,
    ...(windowId === undefined ? {} : { windowId }),
    url: window.location.href,
    snapshot: perfTrace.snapshot()
  };
}

async function currentSidebarWindowId(): Promise<number | undefined> {
  const getCurrent = browser.windows?.getCurrent;
  if (!getCurrent) {
    return undefined;
  }
  const windowInfo = await getCurrent.call(browser.windows).catch(() => undefined);
  return typeof windowInfo?.id === "number" ? windowInfo.id : undefined;
}

function createSidebarProfileInstanceId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function setSidebarPerformanceTraceEnabled(enabled: boolean): void {
  const wasEnabled = perfTrace.isEnabled();
  storeProfileEnabled(enabled);
  if (enabled) {
    perfTrace.setEnabled(true);
    if (!wasEnabled) {
      perfTrace.mark("sidebar.profile.enabled");
    }
    return;
  }

  if (wasEnabled) {
    perfTrace.mark("sidebar.profile.disabled");
  }
  perfTrace.setEnabled(false);
}

function clearSidebarPerformanceTrace(): void {
  perfTrace.clear();
}

async function setBackgroundTraceEnabled(enabled: boolean): Promise<void> {
  await browser.runtime.sendMessage({ type: "setPerformanceTraceEnabled", enabled }).catch(() => undefined);
}

function storedProfileEnabled(): boolean {
  return window.localStorage.getItem(PROFILE_STORAGE_KEY) === "true";
}

function storeProfileEnabled(enabled: boolean): void {
  if (enabled) {
    window.localStorage.setItem(PROFILE_STORAGE_KEY, "true");
  } else {
    window.localStorage.removeItem(PROFILE_STORAGE_KEY);
  }
}

function registerZoomShortcuts(): void {
  document.addEventListener("keydown", (event) => {
    const action = zoomKeyboardAction(event);
    if (!action) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    wheelZoomDelta = 0;

    if (action === "reset") {
      setZoom(resetZoom());
      return;
    }

    setZoom(stepZoom(currentZoom, action));
  });

  document.addEventListener(
    "wheel",
    (event) => {
      if (!isZoomModifierEvent(event)) {
        return;
      }

      const deltaY = normalizedWheelDeltaY(event);
      if (deltaY === 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      wheelZoomDelta += deltaY;

      if (Math.abs(wheelZoomDelta) < WHEEL_ZOOM_THRESHOLD_PX) {
        return;
      }

      const direction: ZoomDirection = wheelZoomDelta < 0 ? "in" : "out";
      wheelZoomDelta = 0;
      setZoom(stepZoom(currentZoom, direction));
    },
    { passive: false }
  );
}

function registerSearchControls(): void {
  if (searchInput) {
    currentSearchQuery = searchInput.value;
    setCurrentProjectionOwner(remoteSearchRequestIntent(currentSearchQuery));
  }

  searchInput?.addEventListener("input", () => {
    currentSearchQuery = searchInput.value;
    setCurrentProjectionOwner(remoteSearchRequestIntent(currentSearchQuery));
    updateSearchControls();
    if (!currentState) {
      return;
    }
    if (shouldUseRemoteProjectionSearch()) {
      if (!currentSearchQuery.trim()) {
        cancelPendingRemoteSearchProjection();
        if (rootDropSurface) {
          rootDropSurface.scrollTop = 0;
        }
        const projectionLoad = loadRemoteSearchProjection(currentSearchQuery);
        restoreLastOutlineProjectionAfterRemoteFailure({
          ensureViewport: false,
          requestRefill: true,
          scrollTop: 0
        });
        void projectionLoad;
        return;
      }
      scheduleRemoteSearchProjection(currentSearchQuery);
      return;
    }
    cancelPendingRemoteSearchProjection();
    render();
  });

  clearSearch?.addEventListener("click", () => {
    if (!currentState) {
      return;
    }
    clearSearchQuery({ focus: true });
  });

  document.addEventListener("keydown", (event) => {
    if (!currentState && (isSearchFocusEvent(event) || event.key === "Escape")) {
      return;
    }
    if (isSearchFocusEvent(event)) {
      event.preventDefault();
      event.stopPropagation();
      searchInput?.focus();
      searchInput?.select();
      return;
    }

    if (event.key === "Escape" && currentSearchQuery.trim()) {
      event.preventDefault();
      event.stopPropagation();
      clearSearchQuery({ focus: event.target === searchInput });
    }
  });

  updateSearchControls();
}

function registerPortableTreeControls(): void {
  exportTree?.addEventListener("click", () => {
    if (!currentState) {
      showDiagnosticsNotice("Export unavailable until the tree loads", { error: true });
      return;
    }
    void exportCurrentTree();
  });

  importTree?.addEventListener("click", () => {
    if (!currentState) {
      showDiagnosticsNotice("Import unavailable until the tree loads", { error: true });
      return;
    }
    importTreeFile?.click();
  });

  importTreeFile?.addEventListener("change", () => {
    void importSelectedTreeFile();
  });
}

function registerToolbarOverflowControls(): void {
  toolbarOverflow?.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleToolbarOverflowMenu();
  });

  toolbarOverflowMenu?.addEventListener("click", (event) => {
    const item = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>(".overflow-menu-item")
      : null;
    if (item) {
      closeToolbarOverflowMenu();
    }
  });

  document.addEventListener("click", (event) => {
    if (!toolbarOverflowMenu || toolbarOverflowMenu.hidden) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Node)) {
      closeToolbarOverflowMenu();
      return;
    }
    if (toolbarOverflow?.contains(target) || toolbarOverflowMenu.contains(target)) {
      return;
    }
    closeToolbarOverflowMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !toolbarOverflowMenu || toolbarOverflowMenu.hidden) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    closeToolbarOverflowMenu();
    toolbarOverflow?.focus();
  });
}

function toggleToolbarOverflowMenu(): void {
  if (!toolbarOverflowMenu || !toolbarOverflow) {
    return;
  }
  if (toolbarOverflowMenu.hidden) {
    openToolbarOverflowMenu();
    return;
  }
  closeToolbarOverflowMenu();
}

function openToolbarOverflowMenu(): void {
  if (!toolbarOverflowMenu || !toolbarOverflow) {
    return;
  }
  toolbarOverflowMenu.hidden = false;
  toolbarOverflow.setAttribute("aria-expanded", "true");
}

function closeToolbarOverflowMenu(): void {
  if (!toolbarOverflowMenu || !toolbarOverflow) {
    return;
  }
  toolbarOverflowMenu.hidden = true;
  toolbarOverflow.setAttribute("aria-expanded", "false");
}

function registerHistoryControls(): void {
  undoHistory?.addEventListener("click", () => {
    void runHistoryCommand("undo");
  });

  redoHistory?.addEventListener("click", () => {
    void runHistoryCommand("redo");
  });

  document.addEventListener("keydown", (event) => {
    const action = historyKeyboardAction(event);
    if (!action || isEditableHistoryShortcutTarget(event.target)) {
      return;
    }

    if (action === "undo" && undoHistory?.disabled) {
      return;
    }
    if (action === "redo" && redoHistory?.disabled) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void runHistoryCommand(action);
  });

  updateHistoryControls({
    canUndo: false,
    canRedo: false,
    undoDepth: 0,
    redoDepth: 0
  });
}

function registerTreeControls(): void {
  tree?.setAttribute("role", "tree");
  tree?.addEventListener("click", handleTreeClick);
  tree?.addEventListener("pointerover", handleTreePointerOver);
  tree?.addEventListener("pointerleave", handleTreePointerLeave);
  tree?.addEventListener("dragstart", handleTreeDragStart);
  tree?.addEventListener("dragover", handleTreeDragOver);
  tree?.addEventListener("drop", handleTreeDrop);
  tree?.addEventListener("dragend", () => {
    clearDragState();
  });
  tree?.addEventListener("input", handleTreeInput);
  tree?.addEventListener("keydown", handleTreeKeydown);
  tree?.addEventListener("focusout", handleTreeFocusOut);
}

function registerVirtualViewport(): void {
  rootDropSurface?.addEventListener(
    "scroll",
    (event) => {
      noteNonEditInteraction();
      noteSparseViewportScrollIntent();
      recordInputDelay("sidebar.input.scrollDelay", event, {
        event: event.type,
        hydrating: hydratingFullState,
        rows: currentProjection?.rows.length ?? 0
      });
      clearHoverLineScope({ immediate: true, reason: "scroll" });
      if (!currentProjection || !isSparseInitialProjection(currentProjection)) {
        scheduleCurrentRowsRender();
      }
      requestSparseScrollWindowIfNeeded();
    },
    { passive: true }
  );
  window.addEventListener("resize", () => {
    scheduleCurrentRowsRender();
  });
}

async function loadHistoryStatus(): Promise<void> {
  const status = (await browser.runtime.sendMessage({ type: "getHistoryStatus" }).catch(() => undefined)) as
    | ({ type: "historyStatus" } & HistoryStatus)
    | undefined;
  if (status) {
    updateHistoryControls(status);
  }
}

async function runHistoryCommand(command: "undo" | "redo"): Promise<void> {
  const accepted = await runAndRender({ type: command });
  if (!accepted) {
    void loadHistoryStatus();
  }
}

function updateHistoryControls(status: HistoryStatus): void {
  if (undoHistory) {
    undoHistory.disabled = !status.canUndo;
    undoHistory.title = status.undoLabel ? `Undo ${status.undoLabel}` : "Undo";
  }
  if (redoHistory) {
    redoHistory.disabled = !status.canRedo;
    redoHistory.title = status.redoLabel ? `Redo ${status.redoLabel}` : "Redo";
  }
}

function historyKeyboardAction(event: KeyboardEvent): "undo" | "redo" | undefined {
  if (shortcutMatchesEvent(appPreferences.shortcuts.redo, event)) {
    return "redo";
  }
  if (shortcutMatchesEvent(appPreferences.shortcuts.redoAlternate, event)) {
    return "redo";
  }
  if (shortcutMatchesEvent(appPreferences.shortcuts.undo, event)) {
    return "undo";
  }
  return undefined;
}

function isEditableHistoryShortcutTarget(target: EventTarget | null): boolean {
  return target instanceof Element && isEditableElement(target);
}

async function exportCurrentTree(): Promise<void> {
  if (!currentState) {
    showDiagnosticsNotice("Export unavailable until loaded", { error: true });
    return;
  }

  try {
    const response = await sendCommand({ type: "exportTree" });
    if (!isExportTreeResponse(response)) {
      throw new Error("Export failed");
    }

    const blob = new Blob([response.content], {
      type: response.contentType || "application/json"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = response.filename;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    showDiagnosticsNotice("Exported tree");
  } catch (error) {
    showDiagnosticsNotice(commandErrorText(error), { error: true });
  }
}

async function importSelectedTreeFile(): Promise<void> {
  if (!currentState) {
    showDiagnosticsNotice("Import unavailable until loaded", { error: true });
    return;
  }

  const file = importTreeFile?.files?.[0];
  if (!file) {
    return;
  }

  try {
    const payload = JSON.parse(await file.text()) as unknown;
    await runAndRender({ type: "importTree", tree: payload });
    showDiagnosticsNotice("Imported tree; saving in background");
  } catch (error) {
    showDiagnosticsNotice(importErrorText(error), { error: true });
  } finally {
    if (importTreeFile) {
      importTreeFile.value = "";
    }
  }
}

function importErrorText(error: unknown): string {
  if (error instanceof SyntaxError) {
    return "Import failed: invalid JSON";
  }
  if (error instanceof Error) {
    return `Import failed: ${error.message}`;
  }
  return "Import failed";
}

function isSearchFocusEvent(event: KeyboardEvent): boolean {
  return shortcutMatchesEvent(appPreferences.shortcuts.search, event);
}

function clearSearchQuery(options: { focus?: boolean; targetNodeId?: NodeId } = {}): void {
  currentSearchQuery = "";
  if (searchInput) {
    searchInput.value = "";
  }
  setCurrentProjectionOwner(options.targetNodeId
    ? remoteShowInTreeRequestIntent(options.targetNodeId)
    : remoteSearchRequestIntent(currentSearchQuery));
  updateSearchControls();
  if (shouldUseRemoteProjectionSearch()) {
    if (!options.targetNodeId) {
      restoreLastOutlineProjectionAfterRemoteFailure({ requestRefill: false });
      void loadRemoteSearchProjection(currentSearchQuery);
    } else if (options.targetNodeId) {
      void loadRemoteShowInTreeProjection(options.targetNodeId);
    }
  } else {
    render();
  }
  if (options.focus) {
    searchInput?.focus();
  }
}

function updateSearchControls(): void {
  if (clearSearch) {
    clearSearch.hidden = !currentSearchQuery.trim();
  }
}

function shouldUseRemoteProjectionSearch(): boolean {
  return Boolean(currentState && !currentStateFullyLoaded);
}

function refreshSparseRemoteProjectionAfterStateChange(
  options: { allowHydratingPartialProjection?: boolean } = {}
): boolean {
  if (
    !currentState ||
    currentStateFullyLoaded ||
    !hydratingFullState
  ) {
    return false;
  }

  if (currentSearchQuery.trim()) {
    scheduleRemoteSearchProjection(currentSearchQuery);
    return true;
  }

  cancelPendingRemoteSearchProjection();
  if (currentProjectionOwner.kind === "showInTree") {
    if (pendingShowInTreeNodeId) {
      return true;
    }
    if (activeRevealTargetNodeId) {
      void loadRemoteShowInTreeProjection(activeRevealTargetNodeId);
      return true;
    }
  }

  if (
    !currentProjection ||
    (
      !isSparseInitialProjection(currentProjection) &&
      !(
        options.allowHydratingPartialProjection &&
        canUseHydratingProjectionSlice(currentProjection)
      )
    )
  ) {
    return false;
  }

  const viewportRange = clampedViewportRowRangeForProjection(currentProjection);
  const viewportRows = Math.max(1, viewportRange.end - viewportRange.start);
  const rowLimit = sparseScrollWindowRowLimit(viewportRows);
  const totalRowCount = currentProjection.totalRowCount ?? currentProjection.rows.length;
  const centerRowIndex = totalRowCount > 0
    ? Math.max(0, Math.min(totalRowCount - 1, Math.floor((viewportRange.start + viewportRange.end - 1) / 2)))
    : 0;
  startSparseScrollWindowRequest(centerRowIndex, rowLimit, "", 0, { countMode: "snapshot" });
  return true;
}

function refreshPartialSearchProjectionAfterNodeStateUpdate(update: NodeStateUpdate): boolean {
  if (
    !currentState ||
    currentStateFullyLoaded ||
    !hydratingFullState ||
    !currentProjection?.isSearchActive ||
    !currentSearchQuery.trim()
  ) {
    return false;
  }

  const previousProjection = currentProjection;
  const localProjection = buildVisibleTreeProjection(currentState, currentSearchQuery);
  const matchingNodeIds = updatedSearchMatchingNodeIds(previousProjection, update);
  localProjection.nodeCount = previousProjection.nodeCount;
  localProjection.closedCount = Math.max(0, previousProjection.closedCount + update.closedCountDelta);
  localProjection.matchingNodeIds = matchingNodeIds;
  localProjection.matchCount = matchingNodeIds.size;
  currentProjection = localProjection;
  projectionState = undefined;
  projectionQuery = undefined;
  currentCutRowRange = cutSubtreeRowRange(localProjection.rows, pendingCutNodeId);
  resetHoverLineScope();
  updateProjectionChrome(localProjection);
  renderVirtualRows();
  if (currentProjectionCoverage) {
    scheduleRemoteSearchProjection(currentSearchQuery);
  } else {
    void loadRemoteSearchProjection(currentSearchQuery);
  }
  return true;
}

function updatedSearchMatchingNodeIds(
  projection: VisibleTreeProjection,
  update: NodeStateUpdate
): Set<NodeId> {
  const query = projection.query || currentSearchQuery;
  const matchingNodeIds = new Set(projection.matchingNodeIds);
  for (const node of update.updatedNodes) {
    const isMatch = outlineNodeMatchesSearchQuery(node, query);
    if (isMatch) {
      matchingNodeIds.add(node.id);
    } else {
      matchingNodeIds.delete(node.id);
    }
  }
  return matchingNodeIds;
}

function outlineNodeMatchesSearchQuery(node: OutlineNode, rawQuery: string): boolean {
  const query = normalizeSearchQuery(rawQuery);
  if (!query) {
    return false;
  }
  return String(node.title ?? "").toLocaleLowerCase().includes(query) ||
    String(node.url ?? "").toLocaleLowerCase().includes(query);
}

function scheduleRemoteSearchProjection(query: string): void {
  cancelPendingRemoteSearchProjection();
  if (!query.trim()) {
    void loadRemoteSearchProjection(query);
    return;
  }

  const requestId = beginRemoteSearchProjectionRequest();
  pendingRemoteSearchTimer = window.setTimeout(() => {
    pendingRemoteSearchTimer = undefined;
    void loadRemoteSearchProjection(query, { requestId });
  }, REMOTE_SEARCH_DEBOUNCE_MS);
}

function cancelPendingRemoteSearchProjection(): void {
  if (pendingRemoteSearchTimer === undefined) {
    return;
  }
  window.clearTimeout(pendingRemoteSearchTimer);
  pendingRemoteSearchTimer = undefined;
}

function beginRemoteSearchProjectionRequest(): number {
  const requestId = ++remoteSearchRequestSequence;
  sparseWindowRequestSequence += 1;
  sparseWindowStateChangeCutoff = sparseWindowRequestSequence;
  pendingSparseWindowRequest = undefined;
  return requestId;
}

function invalidateSparseWindowRequestsForStateChange(): void {
  sparseWindowRequestSequence += 1;
  sparseWindowStateChangeCutoff = sparseWindowRequestSequence;
  pendingSparseWindowRequest = undefined;
}

async function loadRemoteSearchProjection(
  query: string,
  options: { requestId?: number } = {}
): Promise<void> {
  if (options.requestId === undefined) {
    cancelPendingRemoteSearchProjection();
  }
  const requestId = options.requestId ?? beginRemoteSearchProjectionRequest();
  const trimmedQuery = query.trim();
  const intent = remoteSearchRequestIntent(query);
  const requestWindow = remoteSearchProjectionRequestWindow(trimmedQuery);
  const requestMutationRevision = sidebarMutationRevision;

  try {
    const response = await requestProjectionSlice(requestWindow.centerRowIndex, requestWindow.rowLimit, trimmedQuery);
    await nextAnimationFrame();
    if (
      requestId !== remoteSearchRequestSequence ||
      query !== currentSearchQuery ||
      !projectionRequestIntentMatchesCurrent(intent) ||
      currentStateFullyLoaded ||
      !isInitialTreeSnapshot(response) ||
      snapshotContainsNodeDeletedAfter(response, requestMutationRevision) ||
      !snapshotProjectionMatchesRequestIntent(response, intent)
    ) {
      return;
    }

    applyRemoteProjectionSnapshot(response, {
      scrollToActive: !trimmedQuery && !response.hydrating,
      scrollToTop: Boolean(trimmedQuery)
    });
  } catch (error) {
    if (requestId === remoteSearchRequestSequence) {
      perfTrace.mark("sidebar.remoteSearchProjection.error", { message: commandErrorText(error) });
      if (
        projectionRequestIntentMatchesCurrent(intent) &&
        restoreLastOutlineProjectionAfterRemoteFailure()
      ) {
        return;
      }
      showDiagnosticsNotice(commandErrorText(error), { error: true });
    }
  }
}

async function loadRemoteShowInTreeProjection(nodeId: NodeId): Promise<void> {
  cancelPendingRemoteSearchProjection();
  pendingShowInTreeNodeId = nodeId;
  const requestId = beginRemoteSearchProjectionRequest();
  const intent = remoteShowInTreeRequestIntent(nodeId);
  const requestMutationRevision = sidebarMutationRevision;

  try {
    const response = await requestProjectionSlice(0, INITIAL_TREE_SNAPSHOT_ROW_LIMIT, "", { targetNodeId: nodeId });
    await nextAnimationFrame();
    if (
      requestId !== remoteSearchRequestSequence ||
      currentSearchQuery.trim() ||
      !projectionRequestIntentMatchesCurrent(intent) ||
      currentStateFullyLoaded ||
      !isInitialTreeSnapshot(response) ||
      !snapshotProjectionMatchesRequestIntent(response, intent)
    ) {
      return;
    }

    if (snapshotContainsNodeDeletedAfter(response, requestMutationRevision)) {
      if (pendingShowInTreeNodeId === nodeId) {
        pendingShowInTreeNodeId = undefined;
      }
      if (projectionRequestIntentMatchesCurrent(intent)) {
        setCurrentProjectionOwner(remoteSearchRequestIntent(""));
      }
      restoreLastOutlineProjectionAfterRemoteFailure();
      return;
    }

    if (!response.projection.rows.some((row) => row.nodeId === nodeId)) {
      if (pendingShowInTreeNodeId === nodeId) {
        pendingShowInTreeNodeId = undefined;
      }
      if (projectionRequestIntentMatchesCurrent(intent)) {
        setCurrentProjectionOwner(remoteSearchRequestIntent(""));
      }
      if (restoreLastOutlineProjectionAfterRemoteFailure()) {
        return;
      }
    }

    applyRemoteProjectionSnapshot(response, {
      scrollToActive: false,
      scrollToPendingShowInTree: true
    });
  } catch (error) {
    if (requestId === remoteSearchRequestSequence) {
      perfTrace.mark("sidebar.remoteShowInTreeProjection.error", { message: commandErrorText(error) });
      if (pendingShowInTreeNodeId === nodeId) {
        pendingShowInTreeNodeId = undefined;
      }
      if (!currentSearchQuery.trim() && projectionRequestIntentMatchesCurrent(intent)) {
        setCurrentProjectionOwner(remoteSearchRequestIntent(""));
      }
      if (!currentSearchQuery.trim() && restoreLastOutlineProjectionAfterRemoteFailure()) {
        return;
      }
      showDiagnosticsNotice(commandErrorText(error), { error: true });
    }
  }
}

function applyRemoteProjectionSnapshot(
  snapshot: InitialTreeSnapshot,
  options: { scrollToActive?: boolean; scrollToTop?: boolean; scrollToPendingShowInTree?: boolean } = {}
): void {
  mergeProjectionSliceSnapshot(snapshot, { coverageMode: "replace" });
  currentProjection = projectionFromInitialTreeSnapshot(snapshot);
  projectionState = currentState;
  projectionQuery = snapshot.projection.query;
  currentCutRowRange = undefined;
  rememberAcceptedRenderedProjection(currentProjection);
  updateHydrationControls();

  perfTrace.measure("sidebar.render.remoteProjection", {
    rows: currentProjection.rows.length,
    search: currentProjection.isSearchActive,
    totalRows: currentProjection.totalRowCount ?? currentProjection.rows.length
  }, () => {
    if (!tree || !stateCount || !currentProjection) {
      return;
    }
    clearDropPreview();
    updateProjectionChrome(currentProjection);
    if (options.scrollToTop && rootDropSurface) {
      rootDropSurface.scrollTop = 0;
    }
    const scrolledToPendingShowInTree = options.scrollToPendingShowInTree
      ? scrollToPendingShowInTreeRow(currentProjection)
      : false;
    const preserveSparseViewport = !options.scrollToTop &&
      !scrolledToPendingShowInTree &&
      shouldPreserveSparseViewportForProjection(currentProjection);
    let renderOptions: { scrollToActive?: boolean };
    if (scrolledToPendingShowInTree || preserveSparseViewport) {
      renderOptions = { scrollToActive: false };
    } else if (options.scrollToActive === undefined) {
      renderOptions = {};
    } else {
      renderOptions = { scrollToActive: options.scrollToActive };
    }
    renderSnapshotRows(
      currentProjection,
      renderOptions
    );
    if (scrolledToPendingShowInTree && activeRevealTargetNodeId) {
      const row = currentProjection.rows.find((candidate) => candidate.nodeId === activeRevealTargetNodeId);
      if (row) {
        const rowHeight = currentRowHeight();
        prepareVirtualScrollSurface(currentProjection, rowHeight);
        centerRowInViewport(row.index, rootDropSurface ?? undefined, rowHeight);
      }
    }
    if (!preserveSparseViewport) {
      ensureProjectionViewportPainted(currentProjection);
    }
    revealSidebar();
    if (!currentProjection.isSearchActive) {
      requestSparseScrollWindowIfNeeded();
    }
  });
}

function isZoomModifierEvent(event: KeyboardEvent | WheelEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey;
}

function zoomKeyboardAction(event: KeyboardEvent): ZoomDirection | "reset" | undefined {
  if (shortcutMatchesEvent(appPreferences.shortcuts.zoomIn, event)) {
    return "in";
  }

  if (shortcutMatchesEvent(appPreferences.shortcuts.zoomOut, event)) {
    return "out";
  }

  if (shortcutMatchesEvent(appPreferences.shortcuts.zoomReset, event)) {
    return "reset";
  }

  return undefined;
}

function normalizedWheelDeltaY(event: WheelEvent): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * 16;
  }

  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * window.innerHeight;
  }

  return event.deltaY;
}

function setZoom(zoom: number, options: { persist?: boolean } = {}): void {
  const nextZoom = clampZoom(zoom);
  if (nextZoom === currentZoom) {
    return;
  }

  currentZoom = nextZoom;
  applyZoom(currentZoom);
  renderVirtualRows();

  if (options.persist ?? true) {
    void saveZoomPreference(currentZoom);
  }
}

function applyZoom(zoom: number): void {
  const metrics = zoomCssMetrics(zoom);
  for (const [name, value] of Object.entries(metrics)) {
    document.documentElement.style.setProperty(name, value);
  }
}

async function saveZoomPreference(zoom: number): Promise<void> {
  await browser.storage.local.set({ [ZOOM_STORAGE_KEY]: zoom }).catch(() => undefined);
}

function render(): void {
  perfTrace.measure("sidebar.render", { search: Boolean(currentSearchQuery.trim()) }, () => {
    if (!tree || !stateCount) {
      return;
    }

    clearDropPreview();
    const state = currentState;
    if (!state) {
      currentStateFullyLoaded = false;
      currentProjection = undefined;
      currentCutRowRange = undefined;
      resetHoverLineScope();
      tree.textContent = "";
      tree.style.height = "0px";
      stateCount.textContent = "Loading";
      return;
    }
    if (activeRename) {
      const renamedNode = state.nodes[activeRename.nodeId];
      if (!renamedNode || !isRenamableGroup(renamedNode)) {
        activeRename = undefined;
      }
    }
    pendingCutNodeId = nextPendingCutNodeId(state, pendingCutNodeId);

    const projection = visibleProjectionFor(state, currentSearchQuery);
    currentProjection = projection;
    currentCutRowRange = cutSubtreeRowRange(projection.rows, pendingCutNodeId);
    resetHoverLineScope();
    updateProjectionChrome(projection);
    rememberAcceptedRenderedProjection(projection);
    const suppressActiveScroll = suppressActiveScrollOnce;
    suppressActiveScrollOnce = false;
    if (!scrollToPendingShowInTreeRow(projection) && !suppressActiveScroll) {
      scrollToObservedActiveTab(projection);
    }
    renderVirtualRows();
    revealSidebar();
  });
}

function revealSidebar(): void {
  document.body.removeAttribute("data-sidebar-booting");
}

function updateProjectionChrome(projection: VisibleTreeProjection): void {
  if (stateCount) {
    stateCount.textContent = projection.isSearchActive
      ? `${projection.matchCount} ${pluralize(projection.matchCount, "match")} / ${projection.nodeCount} items`
      : `${projection.nodeCount} items / ${projection.closedCount} saved`;
    stateCount.title = hydratingFullState ? "Using sparse background-backed tree" : "";
  }

  if (empty) {
    empty.textContent = projection.isSearchActive ? "No matching tabs." : "No tabs captured yet.";
    empty.hidden = projection.isSearchActive ? projection.rows.length > 0 : projection.nodeCount > 0;
  }
}

function projectionFromInitialTreeSnapshot(snapshot: InitialTreeSnapshot): VisibleTreeProjection {
  return {
    query: snapshot.projection.query,
    isSearchActive: snapshot.projection.isSearchActive,
    rows: snapshot.projection.rows.map((row) => ({ ...row })),
    matchingNodeIds: new Set(snapshot.projection.matchingNodeIds),
    visibleNodeIds: [...snapshot.projection.visibleNodeIds],
    visibleNodeIdSet: new Set(snapshot.projection.visibleNodeIds),
    ...(snapshot.projection.activeTabNodeId ? { activeTabNodeId: snapshot.projection.activeTabNodeId } : {}),
    ...(typeof snapshot.projection.activeTabRowIndex === "number"
      ? { activeTabRowIndex: snapshot.projection.activeTabRowIndex }
      : {}),
    totalRowCount: snapshot.projection.totalRowCount,
    nodeCount: snapshot.projection.nodeCount,
    closedCount: snapshot.projection.closedCount,
    matchCount: snapshot.projection.matchCount
  };
}

function projectionCoverageFromSnapshot(
  coverage: ProjectionSliceCoverage | undefined
): SidebarProjectionCoverage | undefined {
  if (!coverage) {
    return undefined;
  }
  return {
    startRowIndex: coverage.startRowIndex,
    endRowIndex: coverage.endRowIndex,
    editableNodeIds: new Set(coverage.editableNodeIds),
    completeSubtreeNodeIds: new Set(coverage.completeSubtreeNodeIds),
    completeSiblingParentIds: new Set(coverage.completeSiblingParentIds)
  };
}

function mergeProjectionCoverage(
  current: SidebarProjectionCoverage | undefined,
  incoming: SidebarProjectionCoverage | undefined
): SidebarProjectionCoverage | undefined {
  if (!current) {
    return incoming;
  }
  if (!incoming) {
    return current;
  }

  return {
    startRowIndex: Math.min(current.startRowIndex, incoming.startRowIndex),
    endRowIndex: Math.max(current.endRowIndex, incoming.endRowIndex),
    editableNodeIds: new Set([...current.editableNodeIds, ...incoming.editableNodeIds]),
    completeSubtreeNodeIds: new Set([...current.completeSubtreeNodeIds, ...incoming.completeSubtreeNodeIds]),
    completeSiblingParentIds: new Set([...current.completeSiblingParentIds, ...incoming.completeSiblingParentIds])
  };
}

function rememberAcceptedRenderedProjection(
  projection: VisibleTreeProjection,
  options: { forceOutline?: boolean; scrollTop?: number } = {}
): void {
  clearPendingRememberAcceptedRenderedProjection();
  if (projection.isSearchActive || (!options.forceOutline && currentProjectionOwner.kind !== "outline")) {
    return;
  }
  renderedProjectionSession.lastOutlineProjection = {
    projection: cloneVisibleTreeProjection(projection),
    ...(currentProjectionCoverage ? { coverage: cloneProjectionCoverage(currentProjectionCoverage) } : {}),
    scrollTop: options.scrollTop ?? rootDropSurface?.scrollTop ?? 0
  };
}

function rememberAcceptedRenderedProjectionSoon(
  projection: VisibleTreeProjection,
  options: { forceOutline?: boolean; scrollTop?: number } = {}
): void {
  clearPendingRememberAcceptedRenderedProjection();
  if (projection.isSearchActive || (!options.forceOutline && currentProjectionOwner.kind !== "outline")) {
    return;
  }

  const ownerRevision = currentProjectionOwner.revision;
  const scrollTop = options.scrollTop ?? rootDropSurface?.scrollTop ?? 0;
  pendingRememberAcceptedRenderedProjectionTimer = window.setTimeout(() => {
    pendingRememberAcceptedRenderedProjectionTimer = undefined;
    if (currentProjection === projection && currentProjectionOwner.revision === ownerRevision) {
      rememberAcceptedRenderedProjection(projection, { ...options, scrollTop });
    }
  }, 0);
}

function clearPendingRememberAcceptedRenderedProjection(): void {
  if (pendingRememberAcceptedRenderedProjectionTimer !== undefined) {
    window.clearTimeout(pendingRememberAcceptedRenderedProjectionTimer);
    pendingRememberAcceptedRenderedProjectionTimer = undefined;
  }
}

function cloneVisibleTreeProjection(projection: VisibleTreeProjection): VisibleTreeProjection {
  return {
    query: projection.query,
    isSearchActive: projection.isSearchActive,
    rows: projection.rows.map((row) => ({ ...row })),
    matchingNodeIds: new Set(projection.matchingNodeIds),
    visibleNodeIds: [...projection.visibleNodeIds],
    visibleNodeIdSet: new Set(projection.visibleNodeIdSet),
    ...(projection.activeTabNodeId ? { activeTabNodeId: projection.activeTabNodeId } : {}),
    ...(typeof projection.activeTabRowIndex === "number" ? { activeTabRowIndex: projection.activeTabRowIndex } : {}),
    ...(typeof projection.totalRowCount === "number" ? { totalRowCount: projection.totalRowCount } : {}),
    nodeCount: projection.nodeCount,
    closedCount: projection.closedCount,
    matchCount: projection.matchCount
  };
}

function cloneProjectionCoverage(coverage: SidebarProjectionCoverage): SidebarProjectionCoverage {
  return {
    startRowIndex: coverage.startRowIndex,
    endRowIndex: coverage.endRowIndex,
    editableNodeIds: new Set(coverage.editableNodeIds),
    completeSubtreeNodeIds: new Set(coverage.completeSubtreeNodeIds),
    completeSiblingParentIds: new Set(coverage.completeSiblingParentIds)
  };
}

function restoreLastOutlineProjectionAfterRemoteFailure(
  options: { ensureViewport?: boolean; requestRefill?: boolean; scrollTop?: number } = {}
): boolean {
  const lastOutlineProjection = renderedProjectionSession.lastOutlineProjection;
  if (!currentState || !lastOutlineProjection) {
    return false;
  }

  currentProjection = cloneVisibleTreeProjection(lastOutlineProjection.projection);
  currentProjectionCoverage = lastOutlineProjection.coverage
    ? cloneProjectionCoverage(lastOutlineProjection.coverage)
    : undefined;
  projectionState = undefined;
  projectionQuery = undefined;
  currentCutRowRange = cutSubtreeRowRange(currentProjection.rows, pendingCutNodeId);
  resetHoverLineScope();
  updateHydrationControls();

  perfTrace.measure("sidebar.render.remoteProjectionFallback", {
    rows: currentProjection.rows.length,
    totalRows: currentProjection.totalRowCount ?? currentProjection.rows.length
  }, () => {
    if (!tree || !stateCount || !currentProjection) {
      return;
    }
    clearDropPreview();
    updateProjectionChrome(currentProjection);
    if (rootDropSurface) {
      rootDropSurface.scrollTop = options.scrollTop ?? lastOutlineProjection.scrollTop;
    }
    renderSnapshotRows(currentProjection, { scrollToActive: false });
    if (options.ensureViewport ?? true) {
      ensureProjectionViewportPainted(currentProjection);
    }
    if (options.requestRefill ?? false) {
      requestSparseScrollWindowIfNeeded({ force: true });
    }
    revealSidebar();
  });
  return true;
}

function renderSnapshotRows(
  projection: VisibleTreeProjection,
  options: { scrollToActive?: boolean } = {}
): void {
  if (!tree || !currentState) {
    return;
  }

  const rowHeight = currentRowHeight();
  const totalRowCount = projection.totalRowCount ?? projection.rows.length;
  const includeActions = !projectionRequiresHydrationCoverage(projection);
  activeDropPlacement = undefined;
  removeDropPreviewElements();

  const hasLiveDescendant = includeActions ? createLiveDescendantChecker(currentState) : () => false;
  const hasRestorableDescendant = includeActions ? createRestorableDescendantChecker(currentState) : () => false;
  const items: HTMLElement[] = [];
  for (const row of projection.rows) {
    items.push(renderRow(currentState, row, rowHeight, projection.query, hasLiveDescendant, hasRestorableDescendant, {
      includeActions
    }));
  }
  reconcileTreeRows(items, totalRowCount * rowHeight);
  if (options.scrollToActive ?? true) {
    scrollToObservedActiveTab(projection);
  }
}

function reconcileTreeRows(items: HTMLElement[], totalHeight: number): void {
  if (!tree) {
    return;
  }

  tree.style.height = `${totalHeight}px`;
  const existingByNodeId = new Map<NodeId, HTMLElement>();
  for (const child of Array.from(tree.children)) {
    if (child instanceof HTMLElement && child.dataset.nodeId) {
      existingByNodeId.set(child.dataset.nodeId, child);
    }
  }

  const desiredItems: HTMLElement[] = [];
  for (const item of items) {
    const nodeId = item.dataset.nodeId;
    const existing = nodeId ? existingByNodeId.get(nodeId) : undefined;
    desiredItems.push(existing ? reconcileNodeItem(existing, item) : item);
  }
  syncChildNodes(tree, desiredItems);
}

function reconcileNodeItem(existing: HTMLElement, next: HTMLElement): HTMLElement {
  const canPreserveActions = (
    nodeStatusClass(existing) === nodeStatusClass(next) &&
    shouldPreserveExistingActionsForNextItem(existing, next)
  );
  const existingRow = rowForItem(existing);
  const nextRow = rowForItem(next);
  const activeElement = document.activeElement instanceof HTMLElement && existing.contains(document.activeElement)
    ? document.activeElement
    : undefined;
  const activeAction = activeElement?.dataset.action;

  syncElementAttributes(existing, next);
  if (existingRow && nextRow) {
    reconcileNodeRow(existingRow, nextRow, { preserveActions: canPreserveActions });
    syncChildNodes(existing, [existingRow]);
  } else {
    syncChildNodes(existing, Array.from(next.childNodes));
  }
  if (activeAction) {
    existing.querySelector<HTMLElement>(`[data-action="${cssEscape(activeAction)}"]`)?.focus({ preventScroll: true });
  }
  return existing;
}

function shouldPreserveExistingActionsForNextItem(existing: HTMLElement, next: HTMLElement): boolean {
  const existingRow = rowForItem(existing);
  const existingActions = existingRow ? directRowActions(existingRow) : undefined;
  if (!existingActions) {
    return true;
  }

  const nextRow = rowForItem(next);
  const nextActions = nextRow ? directRowActions(nextRow) : undefined;
  if (nextActions) {
    return rowActionNames(existingActions).join("\0") === rowActionNames(nextActions).join("\0");
  }

  if (!projectionRequiresHydrationCoverage(currentProjection)) {
    return true;
  }

  const nodeId = next.dataset.nodeId as NodeId | undefined;
  const node = nodeId ? currentState?.nodes[nodeId] : undefined;
  if (!node || !currentProjectionCoverage) {
    return false;
  }

  for (const action of Array.from(existingActions.querySelectorAll<HTMLElement>("[data-action]"))) {
    const actionName = action.dataset.action;
    if (!actionName) {
      continue;
    }
    if (actionName === "show-in-tree" && !next.classList.contains("is-search-match")) {
      return false;
    }
    if (!canRenderHydratingNodeAction(actionName, node)) {
      return false;
    }
  }
  return true;
}

function reconcileNodeRow(
  existingRow: HTMLElement,
  nextRow: HTMLElement,
  options: { preserveActions: boolean }
): void {
  const existingActions = options.preserveActions ? directRowActions(existingRow) : undefined;
  const nextActions = directRowActions(nextRow);

  if (existingActions && nextActions) {
    reconcileActionStrip(existingActions, nextActions);
  }

  const desiredChildren = Array.from(nextRow.childNodes).map((child) => {
    if (existingActions && child === nextActions) {
      return existingActions;
    }
    return child;
  });
  if (existingActions && !nextActions) {
    desiredChildren.push(existingActions);
  }

  syncElementAttributes(existingRow, nextRow);
  syncChildNodes(existingRow, desiredChildren);
}

function directRowActions(row: HTMLElement): HTMLElement | undefined {
  return Array.from(row.children).find(
    (child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains("node-actions")
  );
}

function rowActionNames(actions: HTMLElement): string[] {
  return Array.from(actions.querySelectorAll<HTMLElement>("[data-action]"))
    .map((action) => action.dataset.action)
    .filter((action): action is string => Boolean(action));
}

function reconcileActionStrip(existing: HTMLElement, next: HTMLElement): void {
  syncElementAttributes(existing, next);
  const existingByAction = new Map<string, HTMLElement>();
  for (const child of Array.from(existing.children)) {
    if (child instanceof HTMLElement && child.dataset.action) {
      existingByAction.set(child.dataset.action, child);
    }
  }

  const desiredChildren = Array.from(next.childNodes).map((child) => {
    if (!(child instanceof HTMLElement) || !child.dataset.action) {
      return child;
    }
    const existingAction = existingByAction.get(child.dataset.action);
    if (!existingAction) {
      return child;
    }
    syncElementAttributes(existingAction, child);
    return existingAction;
  });
  syncChildNodes(existing, desiredChildren);
}

function syncChildNodes(parent: HTMLElement, desiredChildren: Node[]): void {
  const desired = new Set(desiredChildren);
  for (const [index, child] of desiredChildren.entries()) {
    if (parent.childNodes[index] !== child) {
      const current = parent.childNodes[index];
      if (child.parentNode === parent) {
        while (parent.childNodes[index] && parent.childNodes[index] !== child) {
          const extra = parent.childNodes[index];
          if (desired.has(extra)) {
            parent.insertBefore(child, extra);
            break;
          }
          parent.removeChild(extra);
        }
      } else if (current && !desired.has(current)) {
        parent.replaceChild(child, current);
      } else {
        parent.insertBefore(child, current ?? null);
      }
    }
  }
  while (parent.childNodes.length > desiredChildren.length) {
    const extra = parent.childNodes[desiredChildren.length];
    if (!extra) {
      break;
    }
    parent.removeChild(extra);
  }
}

function nodeStatusClass(item: HTMLElement): string {
  return ["is-live", "is-closed"].find((className) => item.classList.contains(className)) ?? "";
}

function syncElementAttributes(target: HTMLElement, source: HTMLElement): void {
  for (const attribute of Array.from(target.attributes)) {
    if (!source.hasAttribute(attribute.name)) {
      target.removeAttribute(attribute.name);
    }
  }
  for (const attribute of Array.from(source.attributes)) {
    target.setAttribute(attribute.name, attribute.value);
  }
}

function updateHydrationControls(): void {
  const treeUnavailable = !currentState;
  if (searchInput) {
    searchInput.disabled = treeUnavailable;
    searchInput.title = treeUnavailable ? "Search is available after the tree loads" : "";
  }
  if (clearSearch) {
    clearSearch.disabled = treeUnavailable;
  }
  if (exportTree) {
    exportTree.disabled = treeUnavailable;
    exportTree.title = treeUnavailable ? "Export is available after the tree loads" : "Export tree";
  }
  if (importTree) {
    importTree.disabled = treeUnavailable;
    importTree.title = treeUnavailable ? "Import is available after the tree loads" : "Import tree";
  }
}

function applyActiveStateUpdate(updates: ActiveStateUpdate[]): void {
  perfTrace.measure("sidebar.patch.activeState", { updates: updates.length }, () => {
    const state = currentState;
    if (!state || updates.length === 0) {
      return;
    }

    let windowActiveChanged = false;
    const activatedNodeIds = new Set<NodeId>();
    for (const update of updates) {
      const node = state.nodes[update.nodeId];
      if (!node) {
        continue;
      }
      if (node.status !== "live") {
        delete node.active;
        continue;
      }
      node.active = update.active;
      if (update.active) {
        activatedNodeIds.add(update.nodeId);
      }
      windowActiveChanged ||= node.kind === "window";
    }
    invalidateSidebarWindowActiveTabTargets();
    const activeRevealNodeId = activeScrollNodeIdFromState(state);
    const shouldRevealActivatedNode = Boolean(activeRevealNodeId && activatedNodeIds.has(activeRevealNodeId));

    if (windowActiveChanged && currentProjection) {
      refreshProjectionActiveWindowFlags(state, currentProjection);
    }
    if (currentProjection) {
      refreshProjectionActiveTabTarget(state, currentProjection);
      scrollToObservedActiveTab(currentProjection, {
        ignoreSparseViewportIntent: shouldRevealActivatedNode
      });
    }
    scheduleCurrentRowsRender();
  });
}

function applyNodeStateUpdate(update: NodeStateUpdate): void {
  perfTrace.measure("sidebar.patch.nodeState", { updatedNodes: update.updatedNodes.length }, () => {
    const state = currentState;
    if (!state || update.updatedNodes.length === 0) {
      return;
    }

    let windowActiveChanged = false;
    let collapsedChanged = false;
    for (const node of update.updatedNodes) {
      const previous = state.nodes[node.id];
      const nextNode = nodeWithStableRestoredTitle(previous, node);
      collapsedChanged ||= Boolean(previous && previous.collapsed !== nextNode.collapsed);
      state.nodes[nextNode.id] = nextNode;
      windowActiveChanged ||= nextNode.kind === "window";
    }
    invalidateSidebarWindowActiveTabTargets();
    pendingCutNodeId = nextPendingCutNodeId(state, pendingCutNodeId);

    if (currentSearchQuery.trim() && !currentStateFullyLoaded && hydratingFullState) {
      if (currentProjection?.isSearchActive && refreshPartialSearchProjectionAfterNodeStateUpdate(update)) {
        return;
      }
      if (!currentProjection?.isSearchActive && currentProjectionOwner.kind === "search") {
        return;
      }
      void loadRemoteSearchProjection(currentSearchQuery);
      return;
    }

    if (!currentProjection || currentProjection.isSearchActive || collapsedChanged) {
      if (currentProjection?.isSearchActive && refreshPartialSearchProjectionAfterNodeStateUpdate(update)) {
        return;
      }
      if (refreshSparseRemoteProjectionAfterStateChange({
        allowHydratingPartialProjection: collapsedChanged,
      })) {
        return;
      }
      invalidateProjectionCache();
      render();
      return;
    }

    const updatedNodes = new Map(update.updatedNodes.map((node) => [node.id, node]));
    if (windowActiveChanged) {
      refreshProjectionActiveWindowFlags(state, currentProjection);
    }
    refreshProjectionActiveTabTarget(state, currentProjection);
    currentProjection.closedCount = Math.max(0, currentProjection.closedCount + update.closedCountDelta);

    for (const row of currentProjection.rows) {
      const node = updatedNodes.get(row.nodeId);
      if (!node) {
        continue;
      }
      row.childCount = node.childIds.length;
      row.visibleChildCount = node.childIds.length;
      row.expanded = !node.collapsed;
    }

    updateProjectionChrome(currentProjection);
    scrollToObservedActiveTab(currentProjection);
    scheduleCurrentRowsRender();
  });
}

function nodeWithStableRestoredTitle(previous: OutlineNode | undefined, next: OutlineNode): OutlineNode {
  if (
    !previous ||
    previous.kind !== "tab" ||
    next.kind !== "tab" ||
    (previous.status !== "closed" && previous.restoredFromClosed !== true) ||
    next.restoredFromClosed !== true
  ) {
    return next;
  }

  const title = runtimeTitleForOutlineTab(previous, {
    title: next.title,
    ...(next.url ? { url: next.url } : {})
  }, {
    restoredFromClosed: true
  });
  return title === next.title ? next : { ...next, title };
}

function applyTreeStructureUpdate(update: TreeStructureUpdate): void {
  perfTrace.measure("sidebar.patch.treeStructure", {
    deletedNodes: update.deletedNodeIds.length,
    updatedNodes: update.updatedNodes.length
  }, () => {
    const state = currentState;
    if (!state) {
      return;
    }

    const activeScrollNodeId = currentProjection ? activeScrollNodeIdForSidebarWindow(currentProjection) : undefined;
    const shouldRescrollActiveTab = activeScrollNodeId
      ? treeStructureUpdateTouchesNodeOrAncestor(state, update, activeScrollNodeId)
      : false;
    const shouldRefreshSparseProjectionAfterLocalPatch = Boolean(
      currentProjection &&
      hydratingFullState &&
      isSparseInitialProjection(currentProjection)
    );
    const deletedNodeIds = new Set(update.deletedNodeIds);
    recordDeletedNodeIds(deletedNodeIds);
    for (const nodeId of deletedNodeIds) {
      delete state.nodes[nodeId];
    }
    for (const node of update.updatedNodes) {
      state.nodes[node.id] = node;
    }
    state.rootIds = [...update.rootIds];
    invalidateSidebarWindowActiveTabTargets();
    if (activeRename && deletedNodeIds.has(activeRename.nodeId)) {
      activeRename = undefined;
    }
    pendingCutNodeId = nextPendingCutNodeId(state, pendingCutNodeId);
    if (shouldRescrollActiveTab) {
      resetActiveTabScrollTracker(activeTabScrollTracker);
    }
    if (shouldRefreshSparseProjectionAfterLocalPatch) {
      invalidateSparseWindowRequestsForStateChange();
    }
    currentProjectionCoverage = undefined;
    const sameParentReorderInfo = currentProjection && update.deletedNodeIds.length === 0
      ? sameParentReorderTreeStructurePatchInfo(state, currentProjection, update)
      : undefined;
    const shouldDeferLastOutlineProjectionRefresh = Boolean(
      sameParentReorderInfo &&
      currentProjectionOwner.kind === "outline" &&
      currentProjection &&
      !currentProjection.isSearchActive
    );
    if (shouldDeferLastOutlineProjectionRefresh) {
      delete renderedProjectionSession.lastOutlineProjection;
    } else {
      refreshLastOutlineProjectionAfterTreeStructureUpdate(state, update);
    }
    const activeRevealNodeId = activeRevealNodeIdForTreeStructureUpdate(state, update);
    if (currentProjectionOwner.kind === "showInTree" && pendingShowInTreeNodeId) {
      return;
    }

    if (!currentProjection) {
      if (refreshSparseRemoteProjectionAfterStateChange()) {
        return;
      }
      invalidateProjectionCache();
      render();
      return;
    }
    if (deletedNodeIds.size === 0) {
      if (applySameParentReorderTreeStructurePatchToProjection(state, currentProjection, update)) {
        refreshProjectionActiveTabTarget(state, currentProjection);
        currentCutRowRange = cutSubtreeRowRange(currentProjection.rows, pendingCutNodeId);
        updateProjectionChrome(currentProjection);
        rememberAcceptedRenderedProjectionSoon(currentProjection, { forceOutline: true });
        scrollToObservedActiveTab(currentProjection, {
          ignoreSparseViewportIntent: Boolean(activeRevealNodeId)
        });
        clearHoverLineScope();
        if (!renderSameParentReorderWithExistingRows(currentProjection, sameParentReorderInfo)) {
          scheduleCurrentRowsRender();
        }
        refreshSparseProjectionAfterLocalTreePatch();
        return;
      }

      if (applyCrossParentLeafMoveTreeStructurePatchToProjection(state, currentProjection, update)) {
        currentCutRowRange = cutSubtreeRowRange(currentProjection.rows, pendingCutNodeId);
        updateProjectionChrome(currentProjection);
        rememberAcceptedRenderedProjection(currentProjection, { forceOutline: true });
        scrollToObservedActiveTab(currentProjection, {
          ignoreSparseViewportIntent: Boolean(activeRevealNodeId)
        });
        clearHoverLineScope();
        scheduleCurrentRowsRender();
        refreshSparseProjectionAfterLocalTreePatch();
        return;
      }

      if (applyInsertTreeStructurePatchToProjection(state, currentProjection, update)) {
        currentCutRowRange = cutSubtreeRowRange(currentProjection.rows, pendingCutNodeId);
        updateProjectionChrome(currentProjection);
        rememberAcceptedRenderedProjection(currentProjection, { forceOutline: true });
        scrollToObservedActiveTab(currentProjection, {
          ignoreSparseViewportIntent: Boolean(activeRevealNodeId)
        });
        clearHoverLineScope();
        scheduleCurrentRowsRender();
        refreshSparseProjectionAfterLocalTreePatch();
        return;
      }

      if (removeRelocatedRowsFromSparseOutlineProjection(state, currentProjection, update)) {
        refreshProjectionActiveTabTarget(state, currentProjection);
        currentCutRowRange = cutSubtreeRowRange(currentProjection.rows, pendingCutNodeId);
        updateProjectionChrome(currentProjection);
        rememberAcceptedRenderedProjection(currentProjection, { forceOutline: true });
        if (revealSparseActiveNodeRemotelyIfNeeded(activeRevealNodeId)) {
          return;
        }
        scrollToObservedActiveTab(currentProjection, {
          ignoreSparseViewportIntent: Boolean(activeRevealNodeId)
        });
        clearHoverLineScope();
        scheduleCurrentRowsRender();
        refreshSparseProjectionAfterLocalTreePatch();
        return;
      }

      if (revealSparseActiveNodeRemotelyIfNeeded(activeRevealNodeId)) {
        return;
      }
      if (refreshSparseRemoteProjectionAfterStateChange()) {
        return;
      }
      invalidateProjectionCache();
      render();
      return;
    }

    if (!applyDeleteTreeStructurePatchToProjection(state, currentProjection, update)) {
      if (revealSparseActiveNodeRemotelyIfNeeded(activeRevealNodeId)) {
        return;
      }
      if (refreshSparseRemoteProjectionAfterStateChange()) {
        return;
      }
      invalidateProjectionCache();
      render();
      return;
    }

    refreshProjectionActiveTabTarget(state, currentProjection);
    currentCutRowRange = cutSubtreeRowRange(currentProjection.rows, pendingCutNodeId);
    updateProjectionChrome(currentProjection);
    rememberAcceptedRenderedProjection(currentProjection, { forceOutline: true });
    scrollToObservedActiveTab(currentProjection, {
      ignoreSparseViewportIntent: Boolean(activeRevealNodeId)
    });
    clearHoverLineScope();
    scheduleCurrentRowsRender();
    refreshSparseProjectionAfterLocalTreePatch();
  });
}

function applySameParentReorderUpdate(update: SameParentReorderUpdate): void {
  const state = currentState;
  const parent = state?.nodes[update.parentId];
  const movedNode = state?.nodes[update.movedNodeId];
  if (!state || !parent || !movedNode) {
    void hydrateFullState();
    return;
  }

  if (update.fromIndex < 0 || parent.childIds[update.fromIndex] !== update.movedNodeId) {
    void hydrateFullState();
    return;
  }

  const childIds = [...parent.childIds];
  const [movedNodeId] = childIds.splice(update.fromIndex, 1);
  const toIndex = Math.max(0, Math.min(update.toIndex, childIds.length));
  childIds.splice(toIndex, 0, movedNodeId!);
  applyTreeStructureUpdate({
    type: "treeStructureUpdated",
    deletedNodeIds: [],
    updatedNodes: [
      { ...parent, childIds },
      movedNode.parentId === update.parentId ? movedNode : { ...movedNode, parentId: update.parentId }
    ],
    rootIds: [...update.rootIds],
    deletedClosedCount: 0
  });
}

function activeRevealNodeIdForTreeStructureUpdate(
  state: OutlineState,
  update: TreeStructureUpdate
): NodeId | undefined {
  const updatedActiveTabs = update.updatedNodes.filter((node) =>
    node.kind === "tab" &&
    node.status === "live" &&
    node.active &&
    !isOutlinerSidebarNode(node)
  );
  if (updatedActiveTabs.length === 0) {
    return undefined;
  }
  if (typeof sidebarWindowId === "number") {
    return updatedActiveTabs.find((node) => node.live?.windowId === sidebarWindowId)?.id;
  }

  const activeNodeId = activeScrollNodeIdFromState(state);
  if (activeNodeId && updatedActiveTabs.some((node) => node.id === activeNodeId)) {
    return activeNodeId;
  }

  return updatedActiveTabs.find((node) => tabNodeIsInsideActiveWindow(state, node))?.id;
}

function tabNodeIsInsideActiveWindow(state: OutlineState, node: OutlineNode): boolean {
  const seen = new Set<NodeId>();
  let currentParentId = node.parentId;

  while (currentParentId && !seen.has(currentParentId)) {
    seen.add(currentParentId);
    const parent = state.nodes[currentParentId];
    if (!parent) {
      return false;
    }
    if (parent.kind === "window") {
      return Boolean(parent.active);
    }
    currentParentId = parent.parentId;
  }
  return false;
}

function revealSparseActiveNodeRemotelyIfNeeded(nodeId: NodeId | undefined): boolean {
  if (
    !nodeId ||
    !currentProjection ||
    currentStateFullyLoaded ||
    !hydratingFullState ||
    currentSearchQuery.trim() ||
    currentProjection.visibleNodeIdSet.has(nodeId)
  ) {
    return false;
  }

  setCurrentProjectionOwner(remoteShowInTreeRequestIntent(nodeId));
  void loadRemoteShowInTreeProjection(nodeId);
  return true;
}

function refreshSparseProjectionAfterLocalTreePatch(): void {
  if (!currentProjection || !hydratingFullState || !isSparseInitialProjection(currentProjection)) {
    return;
  }
  if (normalizeSearchQuery(currentProjection.query) !== normalizeSearchQuery(currentSearchQuery)) {
    return;
  }
  requestSparseScrollWindowIfNeeded({ force: true });
}

function refreshLastOutlineProjectionAfterTreeStructureUpdate(
  state: OutlineState,
  update: TreeStructureUpdate
): void {
  const entry = renderedProjectionSession.lastOutlineProjection;
  if (!entry) {
    return;
  }

  const projection = entry.projection;
  let applied = false;
  if (update.deletedNodeIds.length === 0) {
    applied = applySameParentReorderTreeStructurePatchToProjection(state, projection, update) ||
      applyCrossParentLeafMoveTreeStructurePatchToProjection(state, projection, update) ||
      applyInsertTreeStructurePatchToProjection(state, projection, update);
  } else {
    applied = applyDeleteTreeStructurePatchToProjection(state, projection, update);
  }

  if (!applied) {
    delete renderedProjectionSession.lastOutlineProjection;
    return;
  }

  delete entry.coverage;
}

function removeRelocatedRowsFromSparseOutlineProjection(
  state: OutlineState,
  projection: VisibleTreeProjection,
  update: TreeStructureUpdate
): boolean {
  if (
    projection.isSearchActive ||
    update.deletedNodeIds.length > 0 ||
    !hydratingFullState ||
    !isSparseInitialProjection(projection)
  ) {
    return false;
  }

  const rowIndexes = new Set(projection.rows.map((row) => row.index));
  const rowsToRemove = new Set<NodeId>();
  const rowsByNodeId = new Map(projection.rows.map((row) => [row.nodeId, row]));
  for (const node of update.updatedNodes) {
    const row = rowsByNodeId.get(node.id);
    const parent = node.parentId ? state.nodes[node.parentId] : undefined;
    if (node.childIds.length > 0) {
      for (const candidate of projection.rows) {
        const candidateNode = state.nodes[candidate.nodeId];
        if (candidateNode?.parentId !== node.id) {
          continue;
        }
        const nextRowIndex = node.childIds.indexOf(candidate.nodeId) + 1;
        if (nextRowIndex > 0 && nextRowIndex !== candidate.index && !rowIndexes.has(nextRowIndex)) {
          rowsToRemove.add(candidate.nodeId);
        }
      }
    }
    if (!row || !parent) {
      continue;
    }

    const childIndex = parent.childIds.indexOf(node.id);
    if (childIndex < 0) {
      continue;
    }
    const nextRowIndex = childIndex + 1;
    if (nextRowIndex !== row.index && !rowIndexes.has(nextRowIndex)) {
      rowsToRemove.add(node.id);
    }
    if (nextRowIndex !== row.index && node.kind !== "window") {
      rowsToRemove.add(node.id);
    }
  }

  if (rowsToRemove.size === 0) {
    return false;
  }

  projection.rows = projection.rows.filter((row) => !rowsToRemove.has(row.nodeId));
  projection.visibleNodeIds = projection.rows.map((row) => row.nodeId);
  projection.visibleNodeIdSet = new Set(projection.visibleNodeIds);
  for (const nodeId of rowsToRemove) {
    projection.matchingNodeIds.delete(nodeId);
  }
  projection.matchCount = projection.matchingNodeIds.size;
  return true;
}

function invalidateProjectionCache(): void {
  projectionState = undefined;
  projectionQuery = undefined;
  currentProjection = undefined;
}

function refreshProjectionActiveWindowFlags(state: OutlineState, projection: VisibleTreeProjection): void {
  const activeByDepth: boolean[] = [];

  for (const row of projection.rows) {
    activeByDepth.length = row.depth;
    const parentInsideActiveWindow = row.depth > 0 ? activeByDepth[row.depth - 1] === true : false;
    const node = state.nodes[row.nodeId];
    row.insideActiveWindow = parentInsideActiveWindow;
    activeByDepth[row.depth] = parentInsideActiveWindow ||
      Boolean(node?.kind === "window" && node.status === "live" && node.active);
  }
}

function refreshProjectionActiveTabTarget(state: OutlineState, projection: VisibleTreeProjection): void {
  delete projection.activeTabNodeId;
  delete projection.activeTabRowIndex;

  for (const row of projection.rows) {
    const node = state.nodes[row.nodeId];
    if (
      node?.kind === "tab" &&
      node.status === "live" &&
      node.active &&
      row.insideActiveWindow &&
      !isOutlinerSidebarNode(node)
    ) {
      projection.activeTabNodeId = node.id;
      projection.activeTabRowIndex = row.index;
      return;
    }
  }
}

function treeStructureUpdateTouchesNodeOrAncestor(
  state: OutlineState,
  update: TreeStructureUpdate,
  nodeId: NodeId
): boolean {
  const updatedNodeIds = new Set(update.updatedNodes.map((node) => node.id));
  const visited = new Set<NodeId>();
  let currentId: NodeId | undefined = nodeId;

  while (currentId && !visited.has(currentId)) {
    if (updatedNodeIds.has(currentId)) {
      return true;
    }

    visited.add(currentId);
    currentId = state.nodes[currentId]?.parentId;
  }

  return false;
}

function canFlattenSubtree(state: OutlineState, node: OutlineNode): boolean {
  return node.childIds.some((childId) => (state.nodes[childId]?.childIds.length ?? 0) > 0);
}

function canPromoteChildren(node: OutlineNode): boolean {
  return Boolean(node.parentId && node.childIds.length > 0 && !(node.kind === "window" && node.status === "live"));
}

function canMoveSubtreeToTopLevel(node: OutlineNode): boolean {
  return Boolean(node.parentId);
}

function canMoveSubtreeToBottomTopLevel(state: OutlineState, node: OutlineNode, rowInfo: VisibleTreeRow): boolean {
  if (node.parentId) {
    return true;
  }
  if (!isRenamableGroup(node)) {
    return false;
  }
  const rootIndex = state.rootIds.indexOf(node.id);
  if (rootIndex >= 0 && rootIndex < state.rootIds.length - 1) {
    return true;
  }
  return canMoveSparseHydratingRootSubtreeToBottom(rowInfo);
}

function canMoveSparseHydratingRootSubtreeToBottom(rowInfo: VisibleTreeRow): boolean {
  const projection = currentProjection;
  return Boolean(
    rowInfo.depth === 0 &&
      projection &&
      !projection.isSearchActive &&
      projectionRequiresHydrationCoverage(projection) &&
      typeof projection.totalRowCount === "number" &&
      rowInfo.subtreeEndIndex < projection.totalRowCount
  );
}

function isRenamableGroup(node: OutlineNode): boolean {
  return node.kind === "window" || node.kind === "group";
}

function pluralize(count: number, noun: string): string {
  if (noun.endsWith("ch") || noun.endsWith("sh")) {
    return count === 1 ? noun : `${noun}es`;
  }
  return count === 1 ? noun : `${noun}s`;
}

function visibleProjectionFor(state: OutlineState, query: string): VisibleTreeProjection {
  if (projectionState === state && projectionQuery === query && currentProjection) {
    perfTrace.mark("sidebar.projection.cacheHit", {
      rows: currentProjection.rows.length,
      search: Boolean(query.trim())
    });
    return currentProjection;
  }

  projectionState = state;
  projectionQuery = query;
  currentProjection = perfTrace.measure("sidebar.projection.build", { search: Boolean(query.trim()) }, () =>
    buildVisibleTreeProjection(state, query)
  );
  return currentProjection;
}

function scheduleVirtualRender(): void {
  if (currentProjection && isSparseInitialProjection(currentProjection)) {
    return;
  }
  if (scheduledVirtualRender) {
    return;
  }

  scheduledVirtualRender = true;
  const requestedAt = performance.now();
  window.requestAnimationFrame(() => {
    scheduledVirtualRender = false;
    perfTrace.mark("sidebar.raf.virtualRender", {
      waitMs: Math.round(performance.now() - requestedAt)
    });
    renderVirtualRows();
  });
}

function scheduleCurrentRowsRender(): void {
  if (currentProjection && isSparseInitialProjection(currentProjection)) {
    renderSnapshotRows(currentProjection, { scrollToActive: false });
    return;
  }
  scheduleVirtualRender();
}

function renderAfterLocalRowEdit(): void {
  if (currentProjection && isSparseInitialProjection(currentProjection)) {
    renderSnapshotRows(currentProjection, { scrollToActive: false });
    return;
  }
  render();
}

function renderVirtualRows(): void {
  perfTrace.measure("sidebar.virtualRows", {
    rows: currentProjection?.rows.length ?? 0,
    hoverGuideActive: isRenderableHoverLineScope(hoverLineScope)
  }, () => {
    if (!tree || !currentProjection || !currentState) {
      return;
    }
    if (isSparseInitialProjection(currentProjection)) {
      return;
    }

    const rowHeight = currentRowHeight();
    const calculatedRange = calculateVirtualRange(
      currentProjection.rows.length,
      rootDropSurface?.scrollTop ?? 0,
      rootDropSurface?.clientHeight ?? window.innerHeight,
      rowHeight,
      VIRTUAL_OVERSCAN_ROWS
    );
    const range = preserveRenderedRowWindowOnce
      ? currentRenderedRowWindowIntersectingViewport(currentProjection.rows.length, rowHeight) ?? calculatedRange
      : calculatedRange;
    preserveRenderedRowWindowOnce = false;

    activeDropPlacement = undefined;
    removeDropPreviewElements();

    const hasLiveDescendant = createLiveDescendantChecker(currentState);
    const hasRestorableDescendant = createRestorableDescendantChecker(currentState);
    const items: HTMLElement[] = [];
    for (let index = range.start; index < range.end; index += 1) {
      const row = currentProjection.rows[index];
      if (row) {
        items.push(renderRow(currentState, row, rowHeight, currentProjection.query, hasLiveDescendant, hasRestorableDescendant));
      }
    }
    reconcileTreeRows(items, range.totalHeight);
  });
}

function renderSameParentReorderWithExistingRows(
  projection: VisibleTreeProjection,
  reorderInfo: SameParentReorderPatchInfo | undefined
): boolean {
  if (!tree || !currentState || !reorderInfo || isSparseInitialProjection(projection)) {
    return false;
  }

  const state = currentState;
  return perfTrace.measure("sidebar.virtualRows", {
    rows: projection.rows.length,
    hoverGuideActive: isRenderableHoverLineScope(hoverLineScope),
    fastPath: "same-parent-reorder"
  }, () => {
    const rowHeight = currentRowHeight();
    const range = currentVirtualRenderRange(projection, rowHeight);
    const desiredRows = projection.rows.slice(range.start, range.end);
    if (!renderedRowsCoverSameParentReorder(desiredRows, reorderInfo)) {
      return false;
    }

    const existingByNodeId = new Map<NodeId, HTMLElement>();
    for (const child of Array.from(tree.children)) {
      if (child instanceof HTMLElement && child.dataset.nodeId) {
        existingByNodeId.set(child.dataset.nodeId, child);
      }
    }

    const desiredItems: HTMLElement[] = [];
    for (const row of desiredRows) {
      const item = existingByNodeId.get(row.nodeId);
      const node = state.nodes[row.nodeId];
      if (!item || !node) {
        return false;
      }
      updateExistingItemForProjectionRow(item, node, row, rowHeight);
      desiredItems.push(item);
    }

    activeDropPlacement = undefined;
    removeDropPreviewElements();
    tree.style.height = `${range.totalHeight}px`;
    syncChildNodes(tree, desiredItems);
    return true;
  });
}

function currentVirtualRenderRange(projection: VisibleTreeProjection, rowHeight: number): VirtualRange {
  const calculatedRange = calculateVirtualRange(
    projection.rows.length,
    rootDropSurface?.scrollTop ?? 0,
    rootDropSurface?.clientHeight ?? window.innerHeight,
    rowHeight,
    VIRTUAL_OVERSCAN_ROWS
  );
  const range = preserveRenderedRowWindowOnce
    ? currentRenderedRowWindowIntersectingViewport(projection.rows.length, rowHeight) ?? calculatedRange
    : calculatedRange;
  preserveRenderedRowWindowOnce = false;
  return range;
}

function renderedRowsCoverSameParentReorder(
  desiredRows: readonly VisibleTreeRow[],
  reorderInfo: SameParentReorderPatchInfo
): boolean {
  if (desiredRows.length === 0) {
    return false;
  }

  const start = desiredRows[0]?.index ?? 0;
  const end = (desiredRows.at(-1)?.index ?? start) + 1;
  const changedStart = Math.min(reorderInfo.movedStart, reorderInfo.insertionIndex);
  const changedEnd = Math.max(reorderInfo.movedEnd, reorderInfo.insertionIndex + reorderInfo.movedSize);
  return start <= changedStart && end >= changedEnd;
}

function updateExistingItemForProjectionRow(
  item: HTMLElement,
  node: OutlineNode,
  rowInfo: VisibleTreeRow,
  rowHeight: number
): void {
  item.className = nodeItemClassName(node, rowInfo);
  item.dataset.nodeId = node.id;
  item.dataset.rowIndex = String(rowInfo.index);
  item.setAttribute("role", "treeitem");
  item.setAttribute("aria-level", String(rowInfo.depth + 1));
  if (rowInfo.childCount > 0) {
    item.setAttribute("aria-expanded", String(rowInfo.expanded));
  } else {
    item.removeAttribute("aria-expanded");
  }
  item.style.transform = `translateY(${rowInfo.index * rowHeight}px)`;

  const row = rowForItem(item);
  if (!row) {
    return;
  }
  row.style.setProperty("--depth", String(rowInfo.depth));
  applyHoverLineClasses(row, rowInfo);
}

function currentRenderedRowWindow(rowCount: number, rowHeight: number): {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
} | undefined {
  if (!tree) {
    return undefined;
  }

  const rowIndexes = Array.from(tree.children)
    .map((child) => child instanceof HTMLElement ? Number(child.dataset.rowIndex) : Number.NaN)
    .filter((index) => Number.isInteger(index));
  if (rowIndexes.length === 0) {
    return undefined;
  }

  const start = Math.max(0, Math.min(...rowIndexes));
  const end = Math.min(Math.max(0, rowCount), Math.max(...rowIndexes) + 1);
  if (end <= start) {
    return undefined;
  }

  return {
    start,
    end,
    offsetTop: start * rowHeight,
    totalHeight: Math.max(0, rowCount) * rowHeight
  };
}

function currentRenderedRowWindowIntersectingViewport(rowCount: number, rowHeight: number): {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
} | undefined {
  const rendered = currentRenderedRowWindow(rowCount, rowHeight);
  if (!rendered) {
    return undefined;
  }

  const viewport = currentViewportRowRange(rowHeight);
  if (viewport.end <= viewport.start) {
    return rendered;
  }

  return rendered.end > viewport.start && rendered.start < viewport.end ? rendered : undefined;
}

function isSparseInitialProjection(projection: VisibleTreeProjection): boolean {
  return typeof projection.totalRowCount === "number" && projection.totalRowCount !== projection.rows.length;
}

function canUseHydratingProjectionSlice(
  projection: VisibleTreeProjection | undefined
): projection is VisibleTreeProjection {
  return Boolean(
    projection &&
    hydratingFullState &&
    (isSparseInitialProjection(projection) || !currentStateFullyLoaded)
  );
}

function projectionRequiresHydrationCoverage(projection: VisibleTreeProjection | undefined): boolean {
  return Boolean(hydratingFullState && !currentStateFullyLoaded && projection);
}

function ensureProjectionViewportPainted(projection: VisibleTreeProjection): void {
  if (!rootDropSurface || projection.rows.length === 0) {
    return;
  }
  const viewportRange = currentViewportRowRange(currentRowHeight());
  const intersectingRows = projection.rows.filter(
    (row) => row.index >= viewportRange.start && row.index < viewportRange.end
  );
  const hasMeaningfulViewportRow = intersectingRows.some((row) => row.index > 0) ||
    projection.rows.every((row) => row.index < viewportRange.end);
  if (hasMeaningfulViewportRow) {
    return;
  }

  const activeRow = projection.rows.find((row) => row.nodeId === projection.activeTabNodeId);
  const anchorRow = activeRow ??
    projection.rows.find((row) => row.index >= viewportRange.end) ??
    projection.rows.find((row) => row.index > 0) ??
    projection.rows[0];
  if (!anchorRow) {
    return;
  }
  const rowHeight = currentRowHeight();
  prepareVirtualScrollSurface(projection, rowHeight);
  centerRowInViewport(anchorRow.index, rootDropSurface, rowHeight);
}

function currentRowHeight(): number {
  const value = window.getComputedStyle(document.documentElement).getPropertyValue("--node-row-height");
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 18;
}

function renderRow(
  state: OutlineState,
  rowInfo: VisibleTreeRow,
  rowHeight: number,
  searchQuery: string,
  hasLiveDescendant: (nodeId: NodeId) => boolean,
  hasRestorableDescendant: (nodeId: NodeId) => boolean,
  options: { includeActions?: boolean } = {}
): HTMLElement {
  const node = state.nodes[rowInfo.nodeId];
  if (!node) {
    return document.createElement("li");
  }

  const isRenaming = activeRename?.nodeId === node.id && isRenamableGroup(node);
  const item = document.createElement("li");
  item.className = nodeItemClassName(node, rowInfo);
  item.dataset.nodeId = node.id;
  item.dataset.rowIndex = String(rowInfo.index);
  item.setAttribute("role", "treeitem");
  item.setAttribute("aria-level", String(rowInfo.depth + 1));
  if (rowInfo.childCount > 0) {
    item.setAttribute("aria-expanded", String(rowInfo.expanded));
  }
  item.style.transform = `translateY(${rowInfo.index * rowHeight}px)`;

  const row = document.createElement("div");
  row.className = "node-row";
  row.draggable = !isRenaming;
  row.style.setProperty("--depth", String(rowInfo.depth));
  applyHoverLineClasses(row, rowInfo);

  const twisty = document.createElement("button");
  twisty.className = "icon-button twisty";
  twisty.type = "button";
  twisty.dataset.action = "toggle";
  twisty.title = rowInfo.searchRevealsCollapsedChildren
    ? "Collapsed; search is revealing matches"
    : node.collapsed
      ? "Expand"
      : "Collapse";
  twisty.replaceChildren();
  if (rowInfo.childCount) {
    twisty.append(iconElement(node.collapsed ? "chevron-right" : "chevron-down"));
  }
  twisty.disabled = rowInfo.childCount === 0;
  row.append(twisty);

  const titleText = node.title || "Untitled";
  if (isRenaming) {
    row.append(renderRenameInput(node, titleText));
  } else {
    const label = document.createElement("button");
    label.className = "node-label";
    label.type = "button";
    const labelText = node.url ? `${titleText} - ${node.url}` : titleText;
    const labelRestores = node.status === "closed" || labelRestoresMixedDescendants(node, hasLiveDescendant, hasRestorableDescendant);
    label.title = labelRestores ? `Restore ${labelText}` : node.url ?? titleText;
    label.ariaLabel = labelRestores ? `Restore ${labelText}` : labelText;
    label.dataset.action = labelRestores ? "restore-node" : "focus-or-restore";

    const title = document.createElement("span");
    title.className = "node-title";
    appendTitleText(title, titleText, rowInfo.isSearchMatch ? searchQuery : "");
    label.append(title);

    row.append(label);
  }

  if (options.includeActions ?? true) {
    const actions = renderNodeActions(state, node, rowInfo, hasLiveDescendant, hasRestorableDescendant);
    if (actions.childElementCount > 0) {
      row.append(actions);
    }
  }

  item.append(row);

  return item;
}

function nodeItemClassName(node: OutlineNode, rowInfo: VisibleTreeRow): string {
  const isActiveWindow = node.kind === "window" && node.status === "live" && Boolean(node.active);
  const isActiveTab = node.kind === "tab" && node.status === "live" && Boolean(node.active) && rowInfo.insideActiveWindow;
  return `node node-${node.kind} is-${node.status}${isActiveWindow || isActiveTab ? " is-active" : ""}${
    rowInfo.isSearchMatch ? " is-search-match" : ""
  }${rowInfo.isSearchPath ? " is-search-path" : ""}${
    isRowInCutSubtree(rowInfo, currentCutRowRange) ? " is-cut" : ""
  }${isRevealHighlighted(node.id) ? " is-reveal-highlight" : ""
  }`;
}

function renderNodeActions(
  state: OutlineState,
  node: OutlineNode,
  rowInfo: VisibleTreeRow,
  hasLiveDescendant: (nodeId: NodeId) => boolean,
  hasRestorableDescendant: (nodeId: NodeId) => boolean
): HTMLSpanElement {
  const actions = document.createElement("span");
  actions.className = "node-actions";

  if (rowInfo.isSearchMatch && canRenderHydratingNodeAction("show-in-tree", node)) {
    actions.append(actionButton("Show in tree", "show-in-tree", "locate"));
  }
  if (canRenderHydratingNodeAction("cut", node)) {
    actions.append(actionButton("Cut", "cut", "scissors"));
  }
  if (pendingCutNodeId && canRenderHydratingNodeAction("paste", node)) {
    actions.append(actionButton("Paste", "paste", "clipboard", !pasteAfterCommand(state, pendingCutNodeId, node.id)));
  }
  if (canRenderHydratingNodeAction("group", node)) {
    actions.append(actionButton("Group", "group", "group"));
  }
  if (canMoveSubtreeToTopLevel(node) && canRenderHydratingNodeAction("move-subtree-to-top-level", node)) {
    actions.append(actionButton("Move to top level", "move-subtree-to-top-level", "root-outdent"));
  }
  if (
    canMoveSubtreeToBottomTopLevel(state, node, rowInfo) &&
    canRenderHydratingNodeAction("move-subtree-to-bottom-top-level", node)
  ) {
    actions.append(actionButton("Move to bottom", "move-subtree-to-bottom-top-level", "root-down"));
  }
  if ((node.status === "live" || hasLiveDescendant(node.id)) && canRenderHydratingNodeAction("close-node", node)) {
    actions.append(actionButton("Close", "close-node", "close-circle"));
  }

  if (
    node.status !== "closed" &&
    (node.status === "live" || hasLiveDescendant(node.id)) &&
    hasRestorableDescendant(node.id) &&
    canRenderHydratingNodeAction("restoreNode", node)
  ) {
    actions.append(actionButton("Restore", "restore-node", "refresh"));
  }

  if (canFlattenSubtree(state, node) && canRenderHydratingNodeAction("flatten", node)) {
    actions.append(actionButton("Flatten", "flatten", "flatten"));
  }

  if (canPromoteChildren(node) && canRenderHydratingNodeAction("promote-children", node)) {
    actions.append(actionButton("Promote children", "promote-children", "outdent"));
  }

  if (isRenamableGroup(node) && canRenderHydratingNodeAction("rename", node)) {
    actions.append(actionButton("Rename", "rename", "pencil"));
  }

  if (canRenderHydratingNodeAction("delete", node)) {
    actions.append(actionButton("Delete", "delete", "trash"));
  }
  return actions;
}

function labelRestoresMixedDescendants(
  node: OutlineNode,
  hasLiveDescendant: (nodeId: NodeId) => boolean,
  hasRestorableDescendant: (nodeId: NodeId) => boolean
): boolean {
  return node.kind !== "tab" &&
    node.status !== "closed" &&
    (node.status === "live" || hasLiveDescendant(node.id)) &&
    hasRestorableDescendant(node.id);
}

function canRenderHydratingNodeAction(action: string, node: OutlineNode): boolean {
  if (!projectionRequiresHydrationCoverage(currentProjection)) {
    return true;
  }

  if (action === "show-in-tree") {
    return true;
  }

  const coverage = currentProjectionCoverage;
  if (!coverage?.editableNodeIds.has(node.id)) {
    return false;
  }

  if (action === "paste") {
    return false;
  }
  if (action === "flatten" || action === "promote-children") {
    return coverage.completeSubtreeNodeIds.has(node.id);
  }
  return true;
}

function createLiveDescendantChecker(state: OutlineState): (nodeId: NodeId) => boolean {
  const memo = new Map<NodeId, boolean>();
  const visiting = new Set<NodeId>();

  const check = (nodeId: NodeId): boolean => {
    const cached = memo.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(nodeId)) {
      return false;
    }

    const node = state.nodes[nodeId];
    if (!node) {
      memo.set(nodeId, false);
      return false;
    }

    visiting.add(nodeId);
    const hasLiveChild = node.childIds.some((childId) => {
      const child = state.nodes[childId];
      return Boolean(child && (child.status === "live" || check(childId)));
    });
    visiting.delete(nodeId);
    memo.set(nodeId, hasLiveChild);
    return hasLiveChild;
  };

  return check;
}

function createRestorableDescendantChecker(state: OutlineState): (nodeId: NodeId) => boolean {
  const memo = new Map<NodeId, boolean>();
  const visiting = new Set<NodeId>();

  const isRestorable = (node: OutlineNode): boolean =>
    node.status === "closed" && Boolean(node.restore?.sessionId || (node.kind === "tab" && node.restore?.url));

  const check = (nodeId: NodeId): boolean => {
    const cached = memo.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(nodeId)) {
      return false;
    }

    const node = state.nodes[nodeId];
    if (!node) {
      memo.set(nodeId, false);
      return false;
    }

    visiting.add(nodeId);
    const hasRestorableChild = node.childIds.some((childId) => {
      const child = state.nodes[childId];
      return Boolean(child && (isRestorable(child) || check(childId)));
    });
    visiting.delete(nodeId);
    memo.set(nodeId, hasRestorableChild);
    return hasRestorableChild;
  };

  return check;
}

function appendTitleText(element: HTMLElement, titleText: string, searchQuery: string): void {
  for (const segment of segmentSearchText(titleText, searchQuery)) {
    if (!segment.isMatch) {
      element.append(document.createTextNode(segment.text));
      continue;
    }

    const highlight = document.createElement("span");
    highlight.className = "node-title-search-match";
    highlight.textContent = segment.text;
    element.append(highlight);
  }
}

function handleTreePointerOver(event: PointerEvent): void {
  if (event.relatedTarget instanceof Node && toolbarOverflowMenu?.contains(event.relatedTarget)) {
    return;
  }
  noteNonEditInteraction();
  if (draggedNodeId) {
    const detail = pointerInputDetail(event, "clear-dragging");
    recordInputDelay("sidebar.input.pointerDelay", event, detail);
    clearHoverLineScope({ feedbackTrace: hoverFeedbackTrace(event, detail) });
    return;
  }

  if (event.pointerType === "touch") {
    const detail = pointerInputDetail(event, "clear-touch");
    recordInputDelay("sidebar.input.pointerDelay", event, detail);
    clearHoverLineScope({ feedbackTrace: hoverFeedbackTrace(event, detail) });
    return;
  }

  const item = nodeItemForTarget(event.target);
  if (!item) {
    const detail = pointerInputDetail(event, "clear-no-row-target");
    recordInputDelay("sidebar.input.pointerDelay", event, detail);
    clearHoverLineScope({ feedbackTrace: hoverFeedbackTrace(event, detail) });
    return;
  }

  const rowIndex = rowIndexForItem(item);
  const rowInfo = projectionRowByIndex(currentProjection, rowIndex);
  if (!rowInfo) {
    const detail = pointerInputDetail(event, "clear-missing-row");
    recordInputDelay("sidebar.input.pointerDelay", event, detail);
    clearHoverLineScope({ feedbackTrace: hoverFeedbackTrace(event, detail) });
    return;
  }

  materializeSparseRowActions(item, rowInfo);

  const nextScope: HoverLineScope = {
    rowIndex: rowInfo.index,
    subtreeEndIndex: rowInfo.subtreeEndIndex,
    targetDepth: rowInfo.depth,
    ...(typeof rowInfo.parentRowIndex === "number" ? { parentRowIndex: rowInfo.parentRowIndex } : {})
  };
  const outcome = !pendingHoverGuideApply && sameHoverLineScope(hoverLineScope, nextScope) ? "same-scope" : "hover-row";
  const detail = pointerInputDetail(event, outcome, rowInfo);
  recordInputDelay("sidebar.input.pointerDelay", event, detail);
  setHoverLineScope(nextScope, hoverFeedbackTrace(event, detail));
}

function materializeSparseRowActions(item: HTMLElement, rowInfo: VisibleTreeRow): void {
  const state = currentState;
  const projection = currentProjection;
  if (!state || !projection || !projectionRequiresHydrationCoverage(projection)) {
    return;
  }

  const row = rowForItem(item);
  if (!row) {
    return;
  }

  if (!currentProjectionCoverage) {
    scheduleFullStateHydration(HOVER_MISSING_COVERAGE_HYDRATION_DELAY_MS);
    return;
  }

  if (row.querySelector(".node-actions")) {
    return;
  }

  const node = state.nodes[rowInfo.nodeId];
  if (!node) {
    return;
  }

  const actions = renderNodeActions(
    state,
    node,
    rowInfo,
    createLiveDescendantChecker(state),
    createRestorableDescendantChecker(state)
  );
  if (actions.childElementCount > 0) {
    row.append(actions);
  }
}

function handleTreePointerLeave(event: PointerEvent): void {
  noteNonEditInteraction();
  const detail = pointerInputDetail(event, "pointer-leave-clear");
  clearHoverLineScope({ feedbackTrace: hoverFeedbackTrace(event, detail) });
}

function noteNonEditInteraction(): void {
  const now = performance.now();
  noteNonEditInteractionAt(now);
  broadcastStartupNonEditInteraction(now);
}

function noteRemoteNonEditInteraction(): void {
  noteNonEditInteractionAt(performance.now());
}

function noteNonEditInteractionAt(now: number): void {
  lastNonEditInteractionAt = Math.max(lastNonEditInteractionAt, now);
  if (hydratingFullState && pendingFullHydrationTimer !== undefined) {
    window.clearTimeout(pendingFullHydrationTimer);
    pendingFullHydrationTimer = undefined;
    scheduleFullStateHydration(HYDRATION_AFTER_NON_EDIT_INPUT_DELAY_MS);
  }
}

function broadcastStartupNonEditInteraction(now: number): void {
  if (!hydratingFullState) {
    return;
  }
  if (now - lastNonEditInteractionBroadcastAt < NON_EDIT_INTERACTION_BROADCAST_MIN_INTERVAL_MS) {
    return;
  }

  lastNonEditInteractionBroadcastAt = now;
  void browser.runtime.sendMessage({ type: "sidebarNonEditInteraction" }).catch(() => undefined);
}

function recordInputDelay(name: string, event: Event, detail: TraceDetail): void {
  if (!perfTrace.isEnabled()) {
    return;
  }

  const delayMs = eventQueueDelayMs(event);
  if (typeof delayMs !== "number") {
    return;
  }

  perfTrace.record(name, delayMs, detail);
}

function pointerInputDetail(event: PointerEvent, outcome: string, rowInfo?: VisibleTreeRow): TraceDetail {
  const rows = currentProjection?.rows.length ?? 0;
  return {
    event: event.type,
    hydrating: hydratingFullState,
    pointerType: event.pointerType || "unknown",
    outcome,
    rows,
    ...(rowInfo ? { rowIndex: rowInfo.index, subtreeRows: rowInfo.subtreeEndIndex - rowInfo.index } : {})
  };
}

function hoverFeedbackTrace(event: PointerEvent, detail: TraceDetail): HoverFeedbackTrace | undefined {
  const eventTimeStamp = validEventTimeStamp(event.timeStamp);
  return typeof eventTimeStamp === "number" ? { eventTimeStamp, detail } : undefined;
}

function eventQueueDelayMs(event: Event): number | undefined {
  return delaySinceEventTimeStampMs(event.timeStamp);
}

function validEventTimeStamp(eventTimeStamp: number): number | undefined {
  if (!Number.isFinite(eventTimeStamp) || eventTimeStamp <= 0) {
    return undefined;
  }
  return eventTimeStamp;
}

function delaySinceEventTimeStampMs(eventTimeStamp: number): number | undefined {
  const eventTime = validEventTimeStamp(eventTimeStamp);
  if (typeof eventTime !== "number") {
    return undefined;
  }
  const now = performance.now();
  const delayMs = eventTime > performance.timeOrigin
    ? performance.timeOrigin + now - eventTime
    : now - eventTime;
  if (!Number.isFinite(delayMs)) {
    return undefined;
  }
  return Math.max(0, delayMs);
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, delayMs)));
}

function setHoverLineScope(scope: HoverLineScope, feedbackTrace?: HoverFeedbackTrace): void {
  if (!pendingHoverGuideApply && sameHoverLineScope(hoverLineScope, scope)) {
    return;
  }

  scheduleHoverLineScope(scope, "pointer", feedbackTrace);
}

function clearHoverLineScope(
  options: {
    immediate?: boolean;
    reason?: HoverGuideApplyReason;
    feedbackTrace?: HoverFeedbackTrace | undefined;
  } = {}
): void {
  if (!hoverLineScope && !pendingHoverGuideApply) {
    return;
  }

  if (options.immediate) {
    applyHoverLineScopeNow(undefined, options.reason ?? "pointer-clear", options.feedbackTrace);
    return;
  }

  scheduleHoverLineScope(undefined, options.reason ?? "pointer-clear", options.feedbackTrace);
}

function resetHoverLineScope(): void {
  clearPendingHoverGuide();
  hoverLineScope = undefined;
}

function clearPendingHoverGuide(): void {
  if (scheduledHoverGuideFrame !== undefined) {
    window.cancelAnimationFrame(scheduledHoverGuideFrame);
    scheduledHoverGuideFrame = undefined;
  }
  pendingHoverLineScope = undefined;
  pendingHoverGuideReason = "pointer";
  pendingHoverFeedbackTrace = undefined;
  pendingHoverGuideApply = false;
}

function scheduleHoverLineScope(
  scope: HoverLineScope | undefined,
  reason: HoverGuideApplyReason,
  feedbackTrace?: HoverFeedbackTrace
): void {
  if (shouldApplyHoverLineScopeImmediately()) {
    applyHoverLineScopeNow(scope, reason, feedbackTrace);
    return;
  }

  pendingHoverLineScope = scope;
  pendingHoverGuideReason = reason;
  pendingHoverFeedbackTrace = feedbackTrace;
  pendingHoverGuideApply = true;

  if (scheduledHoverGuideFrame !== undefined) {
    return;
  }

  scheduledHoverGuideFrame = window.requestAnimationFrame(() => {
    scheduledHoverGuideFrame = undefined;
    if (!pendingHoverGuideApply) {
      return;
    }

    const nextScope = pendingHoverLineScope;
    const nextReason = pendingHoverGuideReason;
    const nextFeedbackTrace = pendingHoverFeedbackTrace;
    pendingHoverLineScope = undefined;
    pendingHoverGuideReason = "pointer";
    pendingHoverFeedbackTrace = undefined;
    pendingHoverGuideApply = false;
    applyHoverLineScopeNow(nextScope, nextReason, nextFeedbackTrace);
  });
}

function shouldApplyHoverLineScopeImmediately(): boolean {
  return Boolean(hydratingFullState && currentProjection && isSparseInitialProjection(currentProjection));
}

function applyHoverLineScopeNow(
  scope: HoverLineScope | undefined,
  reason: HoverGuideApplyReason,
  feedbackTrace?: HoverFeedbackTrace
): void {
  clearPendingHoverGuide();

  if (scope ? sameHoverLineScope(hoverLineScope, scope) : !hoverLineScope) {
    return;
  }

  hoverLineScope = scope;
  recordHoverFeedbackDelay(reason, feedbackTrace);
  applyHoverLineScopeToRenderedRows(reason);
  recordHoverFrameDelay(reason, feedbackTrace);
}

function recordHoverFeedbackDelay(reason: HoverGuideApplyReason, feedbackTrace: HoverFeedbackTrace | undefined): void {
  if (!perfTrace.isEnabled() || !feedbackTrace) {
    return;
  }

  const delayMs = delaySinceEventTimeStampMs(feedbackTrace.eventTimeStamp);
  if (typeof delayMs !== "number") {
    return;
  }

  perfTrace.record("sidebar.input.hoverFeedbackDelay", delayMs, {
    ...feedbackTrace.detail,
    reason,
    feedbackRows: currentProjection?.rows.length ?? 0
  });
}

function recordHoverFrameDelay(reason: HoverGuideApplyReason, feedbackTrace: HoverFeedbackTrace | undefined): void {
  if (!perfTrace.isEnabled() || !feedbackTrace) {
    return;
  }

  const detail = {
    ...feedbackTrace.detail,
    reason,
    feedbackRows: currentProjection?.rows.length ?? 0
  };
  const eventTimeStamp = feedbackTrace.eventTimeStamp;
  window.requestAnimationFrame(() => {
    if (!perfTrace.isEnabled()) {
      return;
    }

    const delayMs = delaySinceEventTimeStampMs(eventTimeStamp);
    if (typeof delayMs !== "number") {
      return;
    }

    perfTrace.record("sidebar.input.hoverFrameDelay", delayMs, detail);
  });
}

function sameHoverLineScope(left: HoverLineScope | undefined, right: HoverLineScope): boolean {
  return (
    left?.rowIndex === right.rowIndex &&
    left?.parentRowIndex === right.parentRowIndex &&
    left?.subtreeEndIndex === right.subtreeEndIndex &&
    left?.targetDepth === right.targetDepth
  );
}

function applyHoverLineScopeToRenderedRows(reason: HoverGuideApplyReason): void {
  const items = Array.from(tree?.querySelectorAll<HTMLElement>(".node") ?? []);
  const subtreeRows = hoverLineScopeSubtreeRows(hoverLineScope);
  const skipReason = hoverGuideSkipReason(hoverLineScope);
  perfTrace.measure("sidebar.hoverGuide", {
    reason,
    renderedRows: items.length,
    subtreeRows,
    skipped: Boolean(skipReason),
    ...(skipReason ? { skipReason } : {})
  }, () => {
    if (!tree || !currentProjection) {
      return;
    }

    if (skipReason) {
      removeHoverGuideLayers(items);
      return;
    }

    for (const item of items) {
      const row = rowForItem(item);
      const rowIndex = rowIndexForItem(item);
      const rowInfo = projectionRowByIndex(currentProjection, rowIndex);
      if (row && rowInfo) {
        applyHoverLineClasses(row, rowInfo);
      }
    }
  });
}

function applyHoverLineClasses(row: HTMLElement, rowInfo: VisibleTreeRow): void {
  row.querySelector<HTMLElement>(".tree-guide-layer")?.remove();
  if (!isRenderableHoverLineScope(hoverLineScope)) {
    return;
  }

  const guideSegments = hoverGuideSegmentsForRow(rowInfo);
  if (guideSegments.verticalSegments.size === 0 && typeof guideSegments.horizontalDepth !== "number") {
    return;
  }

  const layer = document.createElement("span");
  layer.className = "tree-guide-layer";
  layer.setAttribute("aria-hidden", "true");

  for (const [depth, segment] of guideSegments.verticalSegments) {
    layer.append(renderVerticalGuideLine(depth, segment));
  }

  if (typeof guideSegments.horizontalDepth === "number") {
    layer.append(renderHorizontalGuideLine(guideSegments.horizontalDepth));
  }

  row.prepend(layer);
}

function removeHoverGuideLayers(items: HTMLElement[]): void {
  for (const item of items) {
    rowForItem(item)?.querySelector<HTMLElement>(".tree-guide-layer")?.remove();
  }
}

function hoverLineScopeSubtreeRows(scope: HoverLineScope | undefined): number {
  return scope ? Math.max(0, scope.subtreeEndIndex - scope.rowIndex) : 0;
}

function hoverGuideSkipReason(scope: HoverLineScope | undefined): "clear" | "large-subtree" | undefined {
  if (!scope) {
    return "clear";
  }
  return hoverLineScopeSubtreeRows(scope) > HOVER_GUIDE_MAX_SUBTREE_ROWS ? "large-subtree" : undefined;
}

function isRenderableHoverLineScope(scope: HoverLineScope | undefined): boolean {
  return Boolean(scope && !hoverGuideSkipReason(scope));
}

function hoverGuideSegmentsForRow(rowInfo: VisibleTreeRow): HoverGuideSegments {
  const verticalSegments = new Map<number, number>();
  const projection = currentProjection;
  const scope = hoverLineScope;
  if (!scope || hoverGuideSkipReason(scope) || !projection) {
    return { verticalSegments };
  }

  const firstGuideIndex = scope.parentRowIndex ?? scope.rowIndex;
  if (rowInfo.index < firstGuideIndex || rowInfo.index >= scope.subtreeEndIndex) {
    return { verticalSegments };
  }

  const isConnectorRow = rowInfo.index >= scope.rowIndex && rowInfo.index < scope.subtreeEndIndex && rowInfo.depth > 0;
  for (let connectorIndex = scope.rowIndex; connectorIndex < scope.subtreeEndIndex; connectorIndex += 1) {
    const connectorRow = projectionRowByIndex(projection, connectorIndex);
    if (!connectorRow || connectorRow.depth <= 0) {
      continue;
    }

    const parentRowIndex = connectorIndex === scope.rowIndex ? scope.parentRowIndex : connectorRow.parentRowIndex;
    if (typeof parentRowIndex !== "number" || rowInfo.index < parentRowIndex || rowInfo.index > connectorIndex) {
      continue;
    }

    const segment =
      rowInfo.index === parentRowIndex ? GUIDE_BOTTOM : rowInfo.index === connectorIndex ? GUIDE_TOP : GUIDE_FULL;
    addVerticalGuideSegment(verticalSegments, connectorRow.depth, segment);
  }

  return {
    verticalSegments,
    ...(isConnectorRow ? { horizontalDepth: rowInfo.depth } : {})
  };
}

function addVerticalGuideSegment(segments: Map<number, number>, depth: number, segment: number): void {
  segments.set(depth, (segments.get(depth) ?? 0) | segment);
}

function renderVerticalGuideLine(depth: number, segment: number): HTMLSpanElement {
  const line = document.createElement("span");
  line.className = "tree-guide-line tree-guide-vertical";
  line.style.setProperty("--tree-guide-depth", String(depth));
  if ((segment & GUIDE_TOP) === GUIDE_TOP) {
    line.style.top = "0";
  } else {
    line.style.top = "50%";
  }
  if ((segment & GUIDE_BOTTOM) === GUIDE_BOTTOM) {
    line.style.bottom = "0";
  } else {
    line.style.bottom = "50%";
  }
  return line;
}

function renderHorizontalGuideLine(depth: number): HTMLSpanElement {
  const line = document.createElement("span");
  line.className = "tree-guide-line tree-guide-horizontal";
  line.style.setProperty("--tree-guide-depth", String(depth));
  return line;
}

function handleTreeClick(event: MouseEvent): void {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-action]") : null;
  if (!button) {
    return;
  }

  const state = currentState;
  const item = nodeItemForTarget(button);
  const nodeId = item?.dataset.nodeId;
  const node = nodeId ? state?.nodes[nodeId] : undefined;
  if (!state || !node) {
    return;
  }

  event.stopPropagation();
  const action = button.dataset.action;
  perfTrace.mark("sidebar.click", {
    action: action ?? "unknown",
    nodeKind: node.kind,
    nodeStatus: node.status
  });
  if (!canRunHydratingRowAction(action, node)) {
    showDiagnosticsNotice("Tree is still loading", { error: true });
    return;
  }
  releasePointerActionFocus(button, event);
  if (action === "toggle") {
    void runAndRender({ type: "toggleCollapsed", nodeId: node.id });
    return;
  }

  if (action === "focus-or-restore") {
    if (node.status === "live") {
      void sendCommand({ type: "focusNode", nodeId: node.id });
    } else if (node.status === "closed") {
      void restoreNodeWithConfirmation(node.id);
    }
    return;
  }

  if (action === "restore-node") {
    void restoreNodeWithConfirmation(node.id);
    return;
  }

  if (action === "show-in-tree") {
    void showSearchResultInTree(node.id);
    return;
  }

  if (action === "close-node") {
    void runAndRender({ type: "closeNode", nodeId: node.id });
    return;
  }

  if (action === "flatten") {
    void runAndRender({ type: "flattenSubtree", nodeId: node.id });
    return;
  }

  if (action === "promote-children") {
    void runAndRender({ type: "promoteChildren", nodeId: node.id });
    return;
  }

  if (action === "group") {
    void runAndRender({ type: "wrapNodeInGroup", nodeId: node.id });
    return;
  }

  if (action === "move-subtree-to-top-level") {
    void runAndRender({ type: "moveSubtreeToTopLevel", nodeId: node.id });
    return;
  }

  if (action === "move-subtree-to-bottom-top-level") {
    void runAndRender({ type: "moveSubtreeToBottomTopLevel", nodeId: node.id });
    return;
  }

  if (action === "cut") {
    cutNodeForPaste(node.id);
    return;
  }

  if (action === "paste") {
    void pasteCutAfter(node.id);
    return;
  }

  if (action === "rename") {
    startRenameGroup(node);
    return;
  }

  if (action === "delete") {
    void runAndRender({ type: "deleteNode", nodeId: node.id });
  }
}

function releasePointerActionFocus(button: HTMLButtonElement, event: MouseEvent): void {
  if (event.detail > 0 && document.activeElement === button) {
    button.blur();
  }
}

function canRunHydratingRowAction(action: string | undefined, node: OutlineNode): boolean {
  if (!projectionRequiresHydrationCoverage(currentProjection)) {
    return true;
  }
  if (action === "focus-or-restore") {
    return node.status === "live" || canRenderHydratingNodeAction("restoreNode", node);
  }
  if (action === "restore-node") {
    return canRenderHydratingNodeAction("restoreNode", node);
  }
  if (action === "toggle") {
    return canRenderHydratingNodeAction("toggle", node);
  }
  return action ? canRenderHydratingNodeAction(action, node) : false;
}

function handleTreeDragStart(event: DragEvent): void {
  const state = currentState;
  const row = rowForEventTarget(event.target);
  const item = row ? nodeItemForTarget(row) : undefined;
  const nodeId = item?.dataset.nodeId;
  if (!state || !row || !nodeId || activeRename?.nodeId === nodeId) {
    event.preventDefault();
    return;
  }
  if (!canStartDragForNode(nodeId)) {
    requestSparseDragDropCoverage();
    event.preventDefault();
    return;
  }

  draggedNodeId = nodeId;
  clearHoverLineScope();
  event.dataTransfer?.setData("text/plain", nodeId);
  event.dataTransfer?.setDragImage(row, 12, 12);
}

function handleTreeDragOver(event: DragEvent): void {
  const state = currentState;
  const row = rowForEventTarget(event.target);
  const item = row ? nodeItemForTarget(row) : undefined;
  const targetId = item?.dataset.nodeId;
  if (!state || !row || !targetId) {
    return;
  }

  const placement = dropPlacementForRowEvent(state, targetId, event.clientY, row);
  if (!placement) {
    clearDropPreview();
    return;
  }
  if (!canUseDropPlacement(placement)) {
    requestSparseDragDropCoverage();
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  showDropPlacement(placement);
}

function handleTreeDrop(event: DragEvent): void {
  const state = currentState;
  const row = rowForEventTarget(event.target);
  const item = row ? nodeItemForTarget(row) : undefined;
  const targetId = item?.dataset.nodeId;
  const sourceId = draggedNodeId;
  if (!state || !row || !targetId || !sourceId) {
    clearDragState();
    return;
  }

  const placement =
    activeDropPlacement?.kind === "node" &&
    activeDropPlacement.sourceId === sourceId &&
    activeDropPlacement.targetId === targetId
      ? activeDropPlacement
      : dropPlacementForRowEvent(state, targetId, event.clientY, row);
  if (!placement) {
    clearDragState();
    return;
  }
  if (!canUseDropPlacement(placement)) {
    requestSparseDragDropCoverage();
    clearDragState();
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  performDrop(placement);
}

function canStartDragForNode(nodeId: NodeId): boolean {
  if (!projectionRequiresHydrationCoverage(currentProjection)) {
    return true;
  }
  return Boolean(
    currentProjection?.visibleNodeIdSet.has(nodeId) &&
    currentProjectionCoverage?.editableNodeIds.has(nodeId)
  );
}

function canUseDropPlacement(placement: DropPlacement): boolean {
  if (!projectionRequiresHydrationCoverage(currentProjection)) {
    return true;
  }

  const coverage = currentProjectionCoverage;
  if (!currentProjection || !coverage?.editableNodeIds.has(placement.sourceId)) {
    return false;
  }

  if (placement.kind === "root") {
    return rootOrderKnownForHydratingDrop();
  }

  if (!currentProjection.visibleNodeIdSet.has(placement.targetId)) {
    return false;
  }

  if (!placement.parentId) {
    return rootOrderKnownForHydratingDrop();
  }

  return coverage.completeSiblingParentIds.has(placement.parentId);
}

function rootOrderKnownForHydratingDrop(): boolean {
  const state = currentState;
  return Boolean(state && state.rootIds.every((nodeId) => Boolean(state.nodes[nodeId])));
}

function requestSparseDragDropCoverage(): void {
  clearDropPreview();
  requestSparseScrollWindowIfNeeded({ force: true });
}

function handleTreeInput(event: Event): void {
  const input = event.target instanceof HTMLInputElement ? event.target : undefined;
  if (input?.classList.contains("node-rename-input") && input.dataset.nodeId) {
    updateRenameDraft(input.dataset.nodeId, input.value);
  }
}

function handleTreeKeydown(event: KeyboardEvent): void {
  const shortcutTarget = cutPasteShortcutTargetForEventTarget(event.target);
  const shortcutAction = keyboardCutPasteAction(event, shortcutTarget, appPreferences.shortcuts);
  const shortcutNodeId = nodeIdForCutPasteTarget(shortcutTarget);
  if (shortcutAction && shortcutNodeId) {
    event.preventDefault();
    event.stopPropagation();
    const shortcutNode = currentState?.nodes[shortcutNodeId];
    if (!shortcutNode || !canRunHydratingRowAction(shortcutAction, shortcutNode)) {
      showDiagnosticsNotice("Tree is still loading", { error: true });
      return;
    }
    if (shortcutAction === "cut") {
      cutNodeForPaste(shortcutNodeId);
    } else {
      void pasteCutAfter(shortcutNodeId);
    }
    return;
  }

  const input = event.target instanceof HTMLInputElement ? event.target : undefined;
  if (!input?.classList.contains("node-rename-input") || !input.dataset.nodeId) {
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    void commitRenameGroup(input.dataset.nodeId, input.value);
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancelRenameGroup(input.dataset.nodeId);
  }
}

function handleTreeFocusOut(event: FocusEvent): void {
  const input = event.target instanceof HTMLInputElement ? event.target : undefined;
  if (
    input?.classList.contains("node-rename-input") &&
    input.dataset.nodeId &&
    activeRename?.nodeId === input.dataset.nodeId
  ) {
    void commitRenameGroup(input.dataset.nodeId, input.value);
  }
}

function renderRenameInput(node: OutlineNode, titleText: string): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "node-rename-input";
  input.type = "text";
  input.value = activeRename?.nodeId === node.id ? activeRename.draft : node.customTitle ?? titleText;
  input.dataset.nodeId = node.id;
  input.draggable = false;
  input.title = "Rename group";
  input.ariaLabel = `Rename ${titleText}`;
  return input;
}

function startRenameGroup(node: OutlineNode): void {
  if (!isRenamableGroup(node)) {
    return;
  }

  activeRename = {
    nodeId: node.id,
    draft: node.customTitle ?? node.title ?? "Group"
  };
  renderAfterLocalRowEdit();
  focusRenameInput(node.id);
}

function updateRenameDraft(nodeId: NodeId, draft: string): void {
  if (activeRename?.nodeId === nodeId) {
    activeRename.draft = draft;
  }
}

async function commitRenameGroup(nodeId: NodeId, title: string): Promise<void> {
  if (activeRename?.nodeId !== nodeId) {
    return;
  }

  activeRename = undefined;
  renderAfterLocalRowEdit();
  await runAndRender({ type: "renameGroup", nodeId, title });
}

function cancelRenameGroup(nodeId: NodeId): void {
  if (activeRename?.nodeId !== nodeId) {
    return;
  }

  activeRename = undefined;
  renderAfterLocalRowEdit();
}

function focusRenameInput(nodeId: NodeId): void {
  window.requestAnimationFrame(() => {
    const input = renameInputForId(nodeId);
    input?.focus();
    input?.select();
  });
}

function renameInputForId(nodeId: NodeId): HTMLInputElement | undefined {
  return Array.from(tree?.querySelectorAll<HTMLInputElement>(".node-rename-input") ?? []).find(
    (input) => input.dataset.nodeId === nodeId
  );
}

function dropPlacementForRowEvent(
  state: OutlineState,
  targetId: NodeId,
  clientY: number,
  row: HTMLElement
): DropPlacement | undefined {
  if (!draggedNodeId) {
    return undefined;
  }

  const rect = row.getBoundingClientRect();
  const relativeY = clientY - rect.top;
  return dropPlacementForNode(state, draggedNodeId, targetId, dropModeForPointer(relativeY, rect.height));
}

function actionButton(label: string, action: string, icon: IconName, disabled = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "icon-button action";
  button.type = "button";
  button.title = label;
  button.ariaLabel = label;
  button.append(iconElement(icon));
  button.dataset.action = action;
  button.disabled = disabled;
  return button;
}

function iconElement(icon: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("button-icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#icon-${icon}`);
  svg.append(use);
  return svg;
}

async function showSearchResultInTree(nodeId: NodeId): Promise<void> {
  if (!currentProjection?.isSearchActive || !currentProjection.matchingNodeIds.has(nodeId)) {
    return;
  }

  pendingShowInTreeNodeId = nodeId;
  const accepted = await runAndRender({ type: "expandAncestors", nodeId });
  if (!accepted) {
    if (pendingShowInTreeNodeId === nodeId) {
      pendingShowInTreeNodeId = undefined;
    }
    return;
  }

  clearSearchQuery({ targetNodeId: nodeId });
}

function cutNodeForPaste(nodeId: NodeId): void {
  if (!currentState?.nodes[nodeId]) {
    return;
  }

  pendingCutNodeId = nodeId;
  currentCutRowRange = currentProjection ? cutSubtreeRowRange(currentProjection.rows, pendingCutNodeId) : undefined;
  if (hydratingFullState && currentProjection && isSparseInitialProjection(currentProjection)) {
    scheduleFullStateHydration(0);
  }
  showDiagnosticsNotice("Cut subtree");
  renderAfterLocalRowEdit();
}

async function pasteCutAfter(targetNodeId: NodeId): Promise<void> {
  const state = currentState;
  const command = state ? pasteAfterCommand(state, pendingCutNodeId, targetNodeId) : undefined;
  if (!command) {
    showDiagnosticsNotice("Cannot paste there", { error: true });
    return;
  }

  const accepted = await runAndRender(command);
  if (!accepted) {
    return;
  }

  pendingCutNodeId = undefined;
  showDiagnosticsNotice("Pasted subtree");
  render();
}

function cutPasteShortcutTargetForEventTarget(target: EventTarget | null): CutPasteShortcutTarget {
  const element = target instanceof Element ? target : undefined;
  const item = nodeItemForTarget(target);
  return {
    ...(item?.dataset.nodeId ? { nodeId: item.dataset.nodeId } : {}),
    ...(element ? { tagName: element.tagName } : {}),
    ...(element ? { isContentEditable: isEditableElement(element) } : {})
  };
}

function isEditableElement(element: Element): boolean {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return true;
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    return true;
  }
  return Boolean(element.closest("[contenteditable='true']"));
}

function isNodeRowEvent(event: DragEvent): boolean {
  return event.target instanceof Element && Boolean(event.target.closest(".node-row"));
}

function isNestedTreeEvent(event: DragEvent): boolean {
  return event.target instanceof Element && Boolean(event.target.closest(".node, .children"));
}

function showDropPlacement(placement: DropPlacement): void {
  if (!tree || !currentProjection) {
    return;
  }

  const preview = dropPreviewForPlacement(placement, currentProjection.rows);
  if (!preview) {
    clearDropPreview();
    return;
  }

  removeDropPreviewElements();
  activeDropPlacement = placement;

  if (placement.kind === "root") {
    rootDropSurface?.classList.add("root-drop-target");
    if (placement.targetId && placement.mode) {
      const targetItem = nodeItemForId(placement.targetId);
      if (!targetItem) {
        clearDropPreview();
        return;
      }
    }

    appendDropPreview(preview, placement.mode ? `drop-${placement.mode}` : "drop-root");
    return;
  }

  const targetItem = nodeItemForId(placement.targetId);
  const targetRow = targetItem ? rowForItem(targetItem) : undefined;
  if (!targetItem || !targetRow) {
    clearDropPreview();
    return;
  }

  const targetDepth = Number(targetRow.style.getPropertyValue("--depth")) || 0;
  if (preview.markerDepth !== (placement.mode === "inside" ? targetDepth + 1 : targetDepth)) {
    clearDropPreview();
    return;
  }
  if (placement.mode === "inside") {
    targetRow.classList.add("drop-inside-target");
  }
  appendDropPreview(preview, `drop-${placement.mode}`);
}

function appendDropPreview(preview: DropPreview, className: string): void {
  if (!tree) {
    return;
  }

  prepareDropMarker(className, preview.markerDepth);
  positionDropMarker(preview.markerRowIndex);
  appendDropGuideLayer(preview.connector, className);
  tree.append(dropMarker);
}

function prepareDropMarker(className: string, depth: number): void {
  dropMarker.className = `drop-marker ${className}`;
  dropMarker.style.setProperty("--depth", String(depth));
}

function positionDropMarker(rowIndex: number): void {
  dropMarker.style.transform = `translateY(${Math.max(0, rowIndex) * currentRowHeight()}px)`;
}

function appendDropGuideLayer(connector: DropPreviewConnector | undefined, markerClassName: string): void {
  if (!tree || !connector) {
    return;
  }

  dropGuideLayer.textContent = "";
  const rowHeight = currentRowHeight();
  const markerCenterY = Math.max(0, connector.endRowIndex) * rowHeight + currentDropMarkerHeight(markerClassName) / 2;
  const startY = (Math.max(0, connector.startRowIndex) + 0.5) * rowHeight;
  const verticalTop = Math.min(startY, markerCenterY);
  const verticalHeight = Math.max(2, Math.abs(markerCenterY - startY));

  const vertical = document.createElement("span");
  vertical.className = "drop-guide-line drop-guide-vertical";
  vertical.style.setProperty("--drop-guide-depth", String(connector.depth));
  vertical.style.top = `${verticalTop}px`;
  vertical.style.height = `${verticalHeight}px`;
  dropGuideLayer.append(vertical);

  const horizontal = document.createElement("span");
  horizontal.className = "drop-guide-line drop-guide-horizontal";
  horizontal.style.setProperty("--drop-guide-depth", String(connector.depth));
  horizontal.style.top = `${markerCenterY - 1}px`;
  dropGuideLayer.append(horizontal);

  tree.append(dropGuideLayer);
}

function currentDropMarkerHeight(markerClassName: string): number {
  const variable =
    markerClassName.includes("drop-inside") || markerClassName.includes("drop-root")
      ? "--drop-marker-inside-height"
      : "--drop-marker-height";
  return currentCssPixelValue(variable, markerClassName.includes("drop-inside") ? 14 : 8);
}

function currentCssPixelValue(name: string, fallback: number): number {
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name);
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function rowIndexForItem(item: HTMLElement): number | undefined {
  const parsed = Number.parseInt(item.dataset.rowIndex ?? "", 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function projectionRowByIndex(
  projection: VisibleTreeProjection | undefined,
  rowIndex: number | undefined
): VisibleTreeRow | undefined {
  if (!projection || typeof rowIndex !== "number") {
    return undefined;
  }

  const denseRow = projection.rows[rowIndex];
  return denseRow?.index === rowIndex ? denseRow : projection.rows.find((row) => row.index === rowIndex);
}

function nodeItemForId(nodeId: NodeId): HTMLElement | undefined {
  if (!tree) {
    return undefined;
  }

  const item = tree.querySelector<HTMLElement>(`.node[data-node-id="${cssEscape(nodeId)}"]`);
  return item ?? undefined;
}

function nodeItemForTarget(target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) {
    return undefined;
  }

  const item = target.closest<HTMLElement>(".node");
  return item && tree?.contains(item) ? item : undefined;
}

function rowForEventTarget(target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) {
    return undefined;
  }

  const row = target.closest<HTMLElement>(".node-row");
  return row && tree?.contains(row) ? row : undefined;
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replaceAll('"', '\\"');
}

function scrollToObservedActiveTab(
  projection: VisibleTreeProjection,
  options: { ignoreSparseViewportIntent?: boolean } = {}
): void {
  if (shouldSuppressObservedActiveScroll(options)) {
    return;
  }
  const rowHeight = currentRowHeight();
  prepareVirtualScrollSurface(projection, rowHeight);
  scrollActiveTabIntoView(
    activeTabScrollTracker,
    activeScrollProjectionForSidebarWindow(projection),
    rootDropSurface ?? undefined,
    rowHeight
  );
}

function shouldSuppressObservedActiveScroll(options: { ignoreSparseViewportIntent?: boolean } = {}): boolean {
  return (
    currentProjectionOwner.kind === "showInTree" ||
    (!options.ignoreSparseViewportIntent && shouldPreserveSparseViewportScrollIntent())
  );
}

function activeScrollNodeIdForSidebarWindow(projection: VisibleTreeProjection): NodeId | undefined {
  return activeScrollNodeIdFromState(currentState) ?? projection.activeTabNodeId;
}

function activeScrollProjectionForSidebarWindow(projection: VisibleTreeProjection): ActiveTabScrollProjection {
  const scopedActiveTabNodeId = activeScrollNodeIdFromState(currentState);
  if (!scopedActiveTabNodeId) {
    return projection;
  }

  if (scopedActiveTabNodeId === projection.activeTabNodeId) {
    return projection;
  }

  const row = projection.rows.find((candidate) => candidate.nodeId === scopedActiveTabNodeId);
  return {
    activeTabNodeId: scopedActiveTabNodeId,
    ...(row ? { activeTabRowIndex: row.index } : {}),
    visibleNodeIdSet: projection.visibleNodeIdSet
  };
}

function activeScrollNodeIdFromState(state: OutlineState | undefined): NodeId | undefined {
  if (!state) {
    return undefined;
  }
  return activeTabNodeIdForSidebarWindow(state, sidebarWindowId) ?? findActiveTabNodeId(state);
}

function invalidateSidebarWindowActiveTabTargets(): void {
  sidebarActiveTabTargetsRevision += 1;
}

function activeTabNodeIdForSidebarWindow(
  state: OutlineState | undefined,
  windowId: number | undefined
): NodeId | undefined {
  if (!state || typeof windowId !== "number") {
    return undefined;
  }

  if (sidebarActiveTabTargetsCacheRevision !== sidebarActiveTabTargetsRevision) {
    sidebarActiveTabTargetsByWindow = activeTabNodeIdsByWindow(state);
    sidebarActiveTabTargetsCacheRevision = sidebarActiveTabTargetsRevision;
  }

  return sidebarActiveTabTargetsByWindow.get(windowId);
}

function activeTabNodeIdsByWindow(state: OutlineState): Map<number, NodeId> {
  const result = new Map<number, NodeId>();
  const visited = new Set<NodeId>();
  const stack = [...state.rootIds].reverse();
  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    if (visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);

    const node = state.nodes[nodeId];
    if (!node) {
      continue;
    }
    if (
      node.kind === "tab" &&
      node.status === "live" &&
      node.active &&
      typeof node.live?.windowId === "number" &&
      !isOutlinerSidebarNode(node)
    ) {
      if (!result.has(node.live.windowId)) {
        result.set(node.live.windowId, node.id);
      }
    }

    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push(node.childIds[index]!);
    }
  }

  return result;
}

function scrollToPendingShowInTreeRow(projection: VisibleTreeProjection): boolean {
  const targetNodeId = pendingShowInTreeNodeId;
  if (!targetNodeId || projection.isSearchActive) {
    return false;
  }

  const row = projection.rows.find((candidate) => candidate.nodeId === targetNodeId);
  pendingShowInTreeNodeId = undefined;
  if (!row) {
    activeRevealTargetNodeId = undefined;
    return false;
  }

  const rowHeight = currentRowHeight();
  prepareVirtualScrollSurface(projection, rowHeight);
  centerRowInViewport(row.index, rootDropSurface ?? undefined, rowHeight);
  activeRevealTargetNodeId = targetNodeId;
  startRevealHighlight(targetNodeId);
  return true;
}

function startRevealHighlight(nodeId: NodeId): void {
  revealHighlightNodeId = nodeId;
  clearRevealHighlightTimer();

  revealHighlightTimer = window.setTimeout(() => {
    revealHighlightTimer = undefined;
    if (revealHighlightNodeId === nodeId) {
      revealHighlightNodeId = undefined;
      scheduleCurrentRowsRender();
    }
  }, SHOW_IN_TREE_HIGHLIGHT_MS);
}

function clearRevealHighlightTimer(): void {
  if (revealHighlightTimer !== undefined) {
    window.clearTimeout(revealHighlightTimer);
    revealHighlightTimer = undefined;
  }
}

function isRevealHighlighted(nodeId: NodeId): boolean {
  return revealHighlightNodeId === nodeId;
}

function centerRowInViewport(rowIndex: number, viewport: HTMLElement | undefined, rowHeight: number): void {
  if (
    !viewport ||
    !Number.isFinite(viewport.clientHeight) ||
    viewport.clientHeight <= 0 ||
    !Number.isFinite(rowIndex)
  ) {
    return;
  }

  const effectiveRowHeight = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 1;
  const rowTop = Math.max(0, rowIndex) * effectiveRowHeight;
  const centeredScrollTop = Math.max(0, rowTop + effectiveRowHeight / 2 - viewport.clientHeight / 2);
  viewport.scrollTop = centeredScrollTop;
}

function prepareVirtualScrollSurface(projection: VisibleTreeProjection, rowHeight: number): void {
  if (!tree) {
    return;
  }

  const effectiveRowHeight = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 1;
  tree.style.height = `${(projection.totalRowCount ?? projection.rows.length) * effectiveRowHeight}px`;
}

function rowForItem(item: HTMLElement): HTMLElement | undefined {
  const firstChild = item.firstElementChild;
  return firstChild instanceof HTMLElement && firstChild.classList.contains("node-row") ? firstChild : undefined;
}

function performDrop(placement: DropPlacement): void {
  const command = commandForDropPlacement(placement);
  clearDragState();
  void runAndRender(command);
}

async function restoreNodeWithConfirmation(nodeId: NodeId): Promise<void> {
  const state = currentState;
  if (!state) {
    return;
  }
  const locallyKnownNodeIdsAtRequest = new Set<NodeId>(Object.keys(state.nodes));
  const restoreScopeRequestRevision = sidebarMutationRevision;

  let scope: RestoreScope;
  try {
    scope = await restoreScopeForNode(state, nodeId);
  } catch (error) {
    showDiagnosticsNotice(commandErrorText(error), { error: true });
    return;
  }
  const locallyKnownScopeNodeIds = new Set<NodeId>(
    scope.nodeIds.filter((scopeNodeId) => locallyKnownNodeIdsAtRequest.has(scopeNodeId))
  );
  locallyKnownScopeNodeIds.add(nodeId);

  if (restoreScopeContainsNodeDeletedAfter(scope, restoreScopeRequestRevision)) {
    return;
  }
  if (!restoreScopeStillApplies(nodeId, scope, locallyKnownScopeNodeIds)) {
    return;
  }
  if (scope.requiresConfirmation && !window.confirm(largeRestoreConfirmationPrompt(scope))) {
    return;
  }
  if (restoreScopeContainsNodeDeletedAfter(scope, restoreScopeRequestRevision)) {
    return;
  }
  if (!restoreScopeStillApplies(nodeId, scope, locallyKnownScopeNodeIds)) {
    return;
  }

  void runAndRender({
    type: "restoreNode",
    nodeId,
    ...(scope.requiresConfirmation ? { confirmedLargeRestore: true } : {})
  });
}

async function restoreScopeForNode(state: OutlineState, nodeId: NodeId): Promise<RestoreScope> {
  if (shouldAskBackgroundForRestoreScope(nodeId)) {
    const response = await sendCommand({ type: "analyzeRestoreScope", nodeId });
    if (isRestoreScope(response)) {
      return response;
    }
    throw new Error("Restore unavailable until the full tree loads");
  }

  return perfTrace.measure("sidebar.restore.scope", () => analyzeRestoreScope(state, nodeId));
}

function restoreScopeStillApplies(
  nodeId: NodeId,
  scope: RestoreScope,
  locallyKnownScopeNodeIds: ReadonlySet<NodeId>
): boolean {
  const state = currentState;
  const target = state?.nodes[nodeId];
  if (!state || !target) {
    return false;
  }
  if (!restoreScopeTargetsNodeOrDescendants(state, nodeId, scope, locallyKnownScopeNodeIds)) {
    return false;
  }
  for (const scopeNodeId of scope.nodeIds) {
    const node = state.nodes[scopeNodeId];
    if (!node && locallyKnownScopeNodeIds.has(scopeNodeId)) {
      return false;
    }
    if (node && node.status !== "closed") {
      return false;
    }
  }
  return true;
}

function shouldAskBackgroundForRestoreScope(nodeId: NodeId): boolean {
  if (!hydratingFullState || !currentProjection || !isSparseInitialProjection(currentProjection)) {
    return false;
  }
  const node = currentState?.nodes[nodeId];
  return Boolean(node && node.kind !== "tab" && !currentProjectionCoverage?.completeSubtreeNodeIds.has(nodeId));
}

function clearDragState(): void {
  draggedNodeId = undefined;
  clearDropPreview();
}

function clearDropPreview(): void {
  activeDropPlacement = undefined;
  removeDropPreviewElements();
}

function removeDropPreviewElements(): void {
  dropMarker.remove();
  dropGuideLayer.remove();
  rootDropSurface?.classList.remove("root-drop-target");
  tree
    ?.querySelectorAll<HTMLElement>(".drop-inside-target")
    .forEach((element) => element.classList.remove("drop-inside-target"));
}

async function runAndRender(command: BackgroundCommand): Promise<boolean> {
  try {
    const response = await sendCommand(command);
    if (isCommandAck(response)) {
      return true;
    }
    if (isOutlineState(response)) {
      setCurrentState(response);
      currentStateFullyLoaded = true;
      currentProjectionCoverage = undefined;
      invalidateSidebarWindowActiveTabTargets();
      render();
      scheduleDiagnosticsLoad();
      return true;
    }
    return true;
  } catch (error) {
    showDiagnosticsNotice(commandErrorText(error), { error: true });
    return false;
  }
}

async function openFullSizeSidebarWindow(): Promise<void> {
  try {
    await sendCommand({ type: "openSidebarWindow" });
  } catch (error) {
    showDiagnosticsNotice(commandErrorText(error), { error: true });
  }
}

async function sendCommand(
  command:
    | BackgroundCommand
    | InitialTreeSnapshotRequest
    | InitialTreeSnapshotWindowRequest
    | TreeProjectionSliceRequest
    | OpenSidebarWindowRequest
    | ExportTreeRequest
): Promise<unknown> {
  const response = await perfTrace.measureAsync("sidebar.command", { command: command.type }, () =>
    browser.runtime.sendMessage(command)
  );
  perfTrace.mark("sidebar.command.response", {
    command: command.type,
    responseType: messageType(response)
  });
  return response;
}

function commandErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function showLoadError(error: unknown): void {
  revealSidebar();
  if (stateCount) {
    stateCount.textContent = "Load failed";
    stateCount.title = error instanceof Error ? error.message : String(error);
  }
  if (diagnostics) {
    diagnostics.textContent = "reload or inspect errors";
  }
}

function showDiagnosticsNotice(message: string, options: { error?: boolean } = {}): void {
  if (!diagnostics) {
    return;
  }

  diagnosticsNoticeUntil = Date.now() + DIAGNOSTICS_NOTICE_MS;
  diagnostics.textContent = message;
  diagnostics.title = message;
  diagnostics.classList.toggle("is-error", Boolean(options.error));

  if (diagnosticsNoticeTimer) {
    window.clearTimeout(diagnosticsNoticeTimer);
  }

  diagnosticsNoticeTimer = window.setTimeout(() => {
    diagnosticsNoticeTimer = undefined;
    diagnosticsNoticeUntil = 0;
    diagnostics.classList.remove("is-error");
    scheduleDiagnosticsLoad();
  }, DIAGNOSTICS_NOTICE_MS);
}

function scheduleDiagnosticsLoad(): void {
  diagnosticsScheduler.request();
}

function diagnosticsNonEditInteractionDeferralMs(): number | undefined {
  if (!Number.isFinite(lastNonEditInteractionAt)) {
    return undefined;
  }

  const idleMs = performance.now() - lastNonEditInteractionAt;
  if (idleMs >= DIAGNOSTICS_AFTER_NON_EDIT_INPUT_DELAY_MS) {
    return undefined;
  }

  const remainingMs = Math.ceil(DIAGNOSTICS_AFTER_NON_EDIT_INPUT_DELAY_MS - idleMs);
  perfTrace.record("sidebar.diagnostics.defer", remainingMs, { reason: "recent-non-edit-interaction" });
  return remainingMs;
}

async function loadDiagnostics(): Promise<void> {
  await perfTrace.measureAsync("sidebar.diagnostics", async () => {
    if (!diagnostics) {
      return;
    }
    if (Date.now() < diagnosticsNoticeUntil) {
      return;
    }

    diagnostics.classList.remove("is-error");

    const result = (await browser.runtime.sendMessage({ type: "getDiagnostics" }).catch(() => undefined)) as
      | OutlineDiagnostics
      | undefined;
    if (!result) {
      diagnostics.textContent = "";
      return;
    }

    diagnostics.textContent = diagnosticsText(result);
    diagnostics.title = result.missingRuntimeTabIds.length
      ? `Missing Firefox tab IDs: ${result.missingRuntimeTabIds.join(", ")}`
      : "";
  });
}

function diagnosticsText(result: OutlineDiagnostics): string {
  if (result.missingRuntimeTabIds.length > 0) {
    return `Firefox ${result.runtimeTabCount} / outline ${result.liveTabNodeCount} / missing ${result.missingRuntimeTabIds.length}`;
  }
  if (result.hiddenLiveTabNodeCount > 0) {
    return `Firefox ${result.runtimeTabCount} / visible ${result.visibleLiveTabNodeCount}`;
  }
  return `Firefox ${result.runtimeTabCount}`;
}

