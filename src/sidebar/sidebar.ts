import type { BackgroundCommand } from "../background/commands.js";
import type { CommandAck } from "../background/commands.js";
import type { OutlineDiagnostics } from "../background/diagnostics.js";
import type { HistoryStatus } from "../background/history.js";
import {
  INITIAL_TREE_SNAPSHOT_ROW_LIMIT,
  type InitialTreeSnapshot,
  type ProjectionSliceCoverage
} from "../background/storage.js";
import { analyzeRestoreScope, runtimeTitleForOutlineTab, type RestoreScope } from "../model/outline.js";
import { exportPortableTree, portableTreeFilename, serializePortableTreeFile } from "../model/portable-tree.js";
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
import { segmentSearchText } from "./search.js";
import {
  applyInsertTreeStructurePatchToProjection,
  applyDeleteTreeStructurePatchToProjection,
  applySameParentReorderTreeStructurePatchToProjection,
  buildVisibleTreeProjection,
  calculateVirtualRange,
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
let hydratingFullState = false;
let pendingFullHydrationTimer: number | undefined;
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
let hoverLineScope: HoverLineScope | undefined;
let pendingHoverLineScope: HoverLineScope | undefined;
let pendingHoverGuideApply = false;
let pendingHoverGuideReason: HoverGuideApplyReason = "pointer";
let pendingHoverFeedbackTrace: HoverFeedbackTrace | undefined;
let scheduledHoverGuideFrame: number | undefined;
let lastNonEditInteractionAt = Number.NEGATIVE_INFINITY;
let lastNonEditInteractionBroadcastAt = Number.NEGATIVE_INFINITY;
let pendingCutNodeId: NodeId | undefined;
let currentCutRowRange: CutSubtreeRowRange | undefined;
let pendingShowInTreeNodeId: NodeId | undefined;
let revealHighlightNodeId: NodeId | undefined;
let revealHighlightTimer: number | undefined;
let sidebarWindowId: number | undefined;
let sidebarWindowIdLoaded = false;
let sidebarActiveTabTargetsRevision = 0;
let sidebarActiveTabTargetsCacheRevision = -1;
let sidebarActiveTabTargetsByWindow = new Map<number, NodeId>();
let sparseWindowRequestSequence = 0;
let pendingSparseWindowRequest:
  | {
      centerRowIndex: number;
      rowLimit: number;
    }
  | undefined;
const activeTabScrollTracker = createActiveTabScrollTracker();

const WHEEL_ZOOM_THRESHOLD_PX = 80;
const DIAGNOSTICS_NOTICE_MS = 4000;
const DIAGNOSTICS_REFRESH_DELAY_MS = 750;
const DIAGNOSTICS_AFTER_NON_EDIT_INPUT_DELAY_MS = 1500;
const FULL_STATE_HYDRATION_DELAY_MS = 750;
const HYDRATION_AFTER_NON_EDIT_INPUT_DELAY_MS = 1000;
const HYDRATION_RENDER_INPUT_IDLE_MS = 120;
const HYDRATION_RENDER_INPUT_MAX_DELAY_MS = 1500;
const NON_EDIT_INTERACTION_BROADCAST_MIN_INTERVAL_MS = 500;
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
};

type OpenSidebarWindowRequest = {
  type: "openSidebarWindow";
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
  | "pencil"
  | "trash"
  | "locate";

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
  if (hydratingFullState) {
    return;
  }
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
  if (hydratingFullState) {
    clearDragState();
    return;
  }
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
      currentState = message.state;
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
      if (bootSnapshot.hydrating) {
        scheduleFullStateHydration();
      } else {
        scheduleDiagnosticsLoad();
      }
      return;
    }

    const initial = await sendCommand({ type: "getInitialTreeSnapshot" });
    if (isInitialTreeSnapshot(initial) && shouldUseInitialTreeSnapshot(initial)) {
      applyInitialTreeSnapshot(initial);
      if (initial.hydrating) {
        scheduleFullStateHydration();
      } else {
        scheduleDiagnosticsLoad();
      }
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
      currentState = nextState;
      currentProjectionCoverage = undefined;
      preserveRenderedRowWindowOnce = wasSparseProjection;
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
  if (!hydratingFullState || pendingFullHydrationTimer !== undefined) {
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
  currentState = snapshot.state;
  invalidateSidebarWindowActiveTabTargets();
  hydratingFullState = snapshot.hydrating;
  currentProjection = projectionFromInitialTreeSnapshot(snapshot);
  currentProjectionCoverage = projectionCoverageFromSnapshot(snapshot.coverage);
  projectionState = currentState;
  projectionQuery = "";
  currentCutRowRange = undefined;
  resetHoverLineScope();
  updateHydrationControls();
  renderInitialTreeSnapshot();
}

function renderInitialTreeSnapshot(): void {
  perfTrace.measure("sidebar.render.initialSnapshot", () => {
    if (!tree || !stateCount || !currentProjection) {
      return;
    }
    clearDropPreview();
    updateProjectionChrome(currentProjection);
    renderSnapshotRows(currentProjection);
    revealSidebar();
  });
}

function applySparseScrollWindowSnapshot(snapshot: InitialTreeSnapshot): void {
  if (!currentProjection || !isSparseInitialProjection(currentProjection) || !snapshot.hydrating) {
    return;
  }

  mergeProjectionSliceSnapshot(snapshot);
  currentProjection = projectionFromInitialTreeSnapshot(snapshot);
  projectionState = currentState;
  projectionQuery = "";
  currentCutRowRange = undefined;
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

function mergeProjectionSliceSnapshot(snapshot: InitialTreeSnapshot): void {
  currentState = mergePartialOutlineState(currentState, snapshot.state);
  invalidateSidebarWindowActiveTabTargets();
  hydratingFullState = snapshot.hydrating;
  currentProjectionCoverage = mergeProjectionCoverage(currentProjectionCoverage, snapshot.coverage);
}

function requestSparseScrollWindowIfNeeded(): void {
  if (!rootDropSurface || !currentProjection || !hydratingFullState || !isSparseInitialProjection(currentProjection)) {
    return;
  }

  const rowHeight = currentRowHeight();
  const viewportStartRow = Math.floor(rootDropSurface.scrollTop / rowHeight);
  const viewportEndRow = Math.ceil((rootDropSurface.scrollTop + rootDropSurface.clientHeight) / rowHeight);
  if (viewportEndRow <= viewportStartRow || sparseProjectionCoversViewport(currentProjection, viewportStartRow, viewportEndRow)) {
    return;
  }

  const totalRowCount = currentProjection.totalRowCount ?? currentProjection.rows.length;
  const centerRowIndex = Math.max(
    0,
    Math.min(totalRowCount - 1, Math.floor((viewportStartRow + viewportEndRow - 1) / 2))
  );
  const rowLimit = sparseScrollWindowRowLimit(viewportEndRow - viewportStartRow);
  if (
    pendingSparseWindowRequest?.centerRowIndex === centerRowIndex &&
    pendingSparseWindowRequest.rowLimit === rowLimit
  ) {
    return;
  }

  pendingSparseWindowRequest = { centerRowIndex, rowLimit };
  const requestId = ++sparseWindowRequestSequence;
  perfTrace.mark("sidebar.sparseScrollWindow.request", {
    centerRowIndex,
    rowLimit,
    viewportStartRow,
    viewportEndRow
  });
  void loadSparseScrollWindow(centerRowIndex, rowLimit, requestId);
}

async function loadSparseScrollWindow(centerRowIndex: number, rowLimit: number, requestId: number): Promise<void> {
  try {
    const response = await requestProjectionSlice(centerRowIndex, rowLimit);
    await nextAnimationFrame();
    if (requestId !== sparseWindowRequestSequence) {
      if (
        isInitialTreeSnapshot(response) &&
        currentProjection &&
        isSparseInitialProjection(currentProjection) &&
        sparseSnapshotCoversCurrentViewport(response)
      ) {
        applySparseScrollWindowSnapshot(response);
      }
      requestSparseScrollWindowIfNeeded();
      return;
    }

    if (!isInitialTreeSnapshot(response) || !currentProjection || !isSparseInitialProjection(currentProjection)) {
      pendingSparseWindowRequest = undefined;
      return;
    }

    applySparseScrollWindowSnapshot(response);
    pendingSparseWindowRequest = undefined;
    requestSparseScrollWindowIfNeeded();
  } catch (error) {
    if (requestId === sparseWindowRequestSequence) {
      pendingSparseWindowRequest = undefined;
      perfTrace.mark("sidebar.sparseScrollWindow.error", { message: commandErrorText(error) });
    }
  }
}

async function requestProjectionSlice(centerRowIndex: number, rowLimit: number): Promise<unknown> {
  return sendCommand({
    type: "getTreeProjectionSlice",
    centerRowIndex,
    rowLimit
  });
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
  if (!rootDropSurface) {
    return false;
  }

  const rowHeight = currentRowHeight();
  const viewportStartRow = Math.floor(rootDropSurface.scrollTop / rowHeight);
  const viewportEndRow = Math.ceil((rootDropSurface.scrollTop + rootDropSurface.clientHeight) / rowHeight);
  return sparseRowsCoverViewport(snapshot.projection.rows, viewportStartRow, viewportEndRow);
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
    snapshot.projection.nodeCount <= snapshot.projection.rows.length ||
    typeof snapshot.projection.activeTabRowIndex === "number"
  );
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
  searchInput?.addEventListener("input", () => {
    if (hydratingFullState) {
      return;
    }
    currentSearchQuery = searchInput.value;
    updateSearchControls();
    render();
  });

  clearSearch?.addEventListener("click", () => {
    if (hydratingFullState) {
      return;
    }
    clearSearchQuery({ focus: true });
  });

  document.addEventListener("keydown", (event) => {
    if (hydratingFullState && (isSearchFocusEvent(event) || event.key === "Escape")) {
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
    if (hydratingFullState) {
      showDiagnosticsNotice("Export unavailable until the full tree loads", { error: true });
      return;
    }
    exportCurrentTree();
  });

  importTree?.addEventListener("click", () => {
    if (hydratingFullState) {
      showDiagnosticsNotice("Import unavailable until the full tree loads", { error: true });
      return;
    }
    importTreeFile?.click();
  });

  importTreeFile?.addEventListener("change", () => {
    void importSelectedTreeFile();
  });
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

function exportCurrentTree(): void {
  if (!currentState) {
    showDiagnosticsNotice("Export unavailable until loaded", { error: true });
    return;
  }

  const payload = exportPortableTree(currentState);
  const blob = new Blob([serializePortableTreeFile(payload)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = portableTreeFilename(new Date());
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  showDiagnosticsNotice("Exported tree");
}

async function importSelectedTreeFile(): Promise<void> {
  const file = importTreeFile?.files?.[0];
  if (!file) {
    return;
  }

  try {
    const payload = JSON.parse(await file.text()) as unknown;
    await runAndRender({ type: "importTree", tree: payload });
    showDiagnosticsNotice("Imported tree");
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

function clearSearchQuery(options: { focus?: boolean } = {}): void {
  currentSearchQuery = "";
  if (searchInput) {
    searchInput.value = "";
  }
  updateSearchControls();
  render();
  if (options.focus) {
    searchInput?.focus();
  }
}

function updateSearchControls(): void {
  if (clearSearch) {
    clearSearch.hidden = !currentSearchQuery.trim();
  }
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
    if (!scrollToPendingShowInTreeRow(projection)) {
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
    stateCount.title = hydratingFullState ? "Loading full tree..." : "";
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
  next: ProjectionSliceCoverage | undefined
): SidebarProjectionCoverage | undefined {
  const incoming = projectionCoverageFromSnapshot(next);
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

function mergePartialOutlineState(
  current: OutlineState | undefined,
  incoming: OutlineState
): OutlineState {
  if (!current) {
    return incoming;
  }

  const nodes: OutlineState["nodes"] = { ...current.nodes };
  for (const [nodeId, node] of Object.entries(incoming.nodes)) {
    nodes[nodeId] = node;
  }

  return {
    version: current.version,
    rootIds: incoming.rootIds.length > 0 ? [...incoming.rootIds] : [...current.rootIds],
    nodes
  };
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
  const includeActions = !hydratingFullState || !isSparseInitialProjection(projection);
  activeDropPlacement = undefined;
  removeDropPreviewElements();

  const hasLiveDescendant = includeActions ? createLiveDescendantChecker(currentState) : () => false;
  const items: HTMLElement[] = [];
  for (const row of projection.rows) {
    items.push(renderRow(currentState, row, rowHeight, projection.query, hasLiveDescendant, { includeActions }));
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
  const canPreserveActions = nodeStatusClass(existing) === nodeStatusClass(next);
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
  if (searchInput) {
    searchInput.disabled = hydratingFullState;
    searchInput.title = hydratingFullState ? "Search is available after the full tree loads" : "";
  }
  if (clearSearch) {
    clearSearch.disabled = hydratingFullState;
  }
  if (exportTree) {
    exportTree.disabled = hydratingFullState;
    exportTree.title = hydratingFullState ? "Export is available after the full tree loads" : "Export tree";
  }
  if (importTree) {
    importTree.disabled = hydratingFullState;
    importTree.title = hydratingFullState ? "Import is available after the full tree loads" : "Import tree";
  }
}

function applyActiveStateUpdate(updates: ActiveStateUpdate[]): void {
  perfTrace.measure("sidebar.patch.activeState", { updates: updates.length }, () => {
    const state = currentState;
    if (!state || updates.length === 0) {
      return;
    }

    let windowActiveChanged = false;
    for (const update of updates) {
      const node = state.nodes[update.nodeId];
      if (!node) {
        continue;
      }
      node.active = update.active;
      windowActiveChanged ||= node.kind === "window";
    }
    invalidateSidebarWindowActiveTabTargets();

    if (windowActiveChanged && currentProjection) {
      refreshProjectionActiveWindowFlags(state, currentProjection);
    }
    if (currentProjection) {
      refreshProjectionActiveTabTarget(state, currentProjection);
      scrollToObservedActiveTab(currentProjection);
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
      collapsedChanged ||= previous?.collapsed !== nextNode.collapsed;
      state.nodes[nextNode.id] = nextNode;
      windowActiveChanged ||= nextNode.kind === "window";
    }
    invalidateSidebarWindowActiveTabTargets();
    pendingCutNodeId = nextPendingCutNodeId(state, pendingCutNodeId);

    if (!currentProjection || currentProjection.isSearchActive || collapsedChanged) {
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
    const deletedNodeIds = new Set(update.deletedNodeIds);
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

    if (!currentProjection) {
      invalidateProjectionCache();
      render();
      return;
    }
    if (deletedNodeIds.size === 0) {
      if (applySameParentReorderTreeStructurePatchToProjection(state, currentProjection, update)) {
        refreshProjectionActiveTabTarget(state, currentProjection);
        currentCutRowRange = cutSubtreeRowRange(currentProjection.rows, pendingCutNodeId);
        updateProjectionChrome(currentProjection);
        scrollToObservedActiveTab(currentProjection);
        clearHoverLineScope();
        scheduleCurrentRowsRender();
        return;
      }

      if (applyInsertTreeStructurePatchToProjection(state, currentProjection, update)) {
        currentCutRowRange = cutSubtreeRowRange(currentProjection.rows, pendingCutNodeId);
        updateProjectionChrome(currentProjection);
        scrollToObservedActiveTab(currentProjection);
        clearHoverLineScope();
        scheduleCurrentRowsRender();
        return;
      }

      invalidateProjectionCache();
      render();
      return;
    }

    if (!applyDeleteTreeStructurePatchToProjection(state, currentProjection, update)) {
      invalidateProjectionCache();
      render();
      return;
    }

    refreshProjectionActiveTabTarget(state, currentProjection);
    currentCutRowRange = cutSubtreeRowRange(currentProjection.rows, pendingCutNodeId);
    updateProjectionChrome(currentProjection);
    scrollToObservedActiveTab(currentProjection);
    clearHoverLineScope();
    scheduleCurrentRowsRender();
  });
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
    activeByDepth[row.depth] = parentInsideActiveWindow || Boolean(node?.kind === "window" && node.active);
  }
}

function refreshProjectionActiveTabTarget(state: OutlineState, projection: VisibleTreeProjection): void {
  delete projection.activeTabNodeId;
  delete projection.activeTabRowIndex;

  for (const row of projection.rows) {
    const node = state.nodes[row.nodeId];
    if (
      node?.kind === "tab" &&
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

function isRenamableGroup(node: OutlineNode): boolean {
  return node.kind === "window" || node.kind === "group";
}

function pluralize(count: number, noun: string): string {
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
      ? currentRenderedRowWindow(currentProjection.rows.length, rowHeight) ?? calculatedRange
      : calculatedRange;
    preserveRenderedRowWindowOnce = false;

    activeDropPlacement = undefined;
    removeDropPreviewElements();

    const hasLiveDescendant = createLiveDescendantChecker(currentState);
    const items: HTMLElement[] = [];
    for (let index = range.start; index < range.end; index += 1) {
      const row = currentProjection.rows[index];
      if (row) {
        items.push(renderRow(currentState, row, rowHeight, currentProjection.query, hasLiveDescendant));
      }
    }
    reconcileTreeRows(items, range.totalHeight);
  });
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

function isSparseInitialProjection(projection: VisibleTreeProjection): boolean {
  return typeof projection.totalRowCount === "number" && projection.totalRowCount !== projection.rows.length;
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
  options: { includeActions?: boolean } = {}
): HTMLElement {
  const node = state.nodes[rowInfo.nodeId];
  if (!node) {
    return document.createElement("li");
  }

  const isActiveWindow = node.kind === "window" && Boolean(node.active);
  const isActiveTab = node.kind === "tab" && Boolean(node.active) && rowInfo.insideActiveWindow;
  const isRenaming = activeRename?.nodeId === node.id && isRenamableGroup(node);
  const item = document.createElement("li");
  item.className = `node node-${node.kind} is-${node.status}${isActiveWindow || isActiveTab ? " is-active" : ""}${
    rowInfo.isSearchMatch ? " is-search-match" : ""
  }${rowInfo.isSearchPath ? " is-search-path" : ""}${
    isRowInCutSubtree(rowInfo, currentCutRowRange) ? " is-cut" : ""
  }${isRevealHighlighted(node.id) ? " is-reveal-highlight" : ""
  }`;
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
    label.title = node.status === "closed" ? `Restore ${labelText}` : node.url ?? titleText;
    label.ariaLabel = node.status === "closed" ? `Restore ${labelText}` : labelText;
    label.dataset.action = "focus-or-restore";

    const title = document.createElement("span");
    title.className = "node-title";
    appendTitleText(title, titleText, rowInfo.isSearchMatch ? searchQuery : "");
    label.append(title);

    row.append(label);
  }

  if (options.includeActions ?? true) {
    const actions = renderNodeActions(state, node, rowInfo, hasLiveDescendant);
    if (actions.childElementCount > 0) {
      row.append(actions);
    }
  }

  item.append(row);

  return item;
}

function renderNodeActions(
  state: OutlineState,
  node: OutlineNode,
  rowInfo: VisibleTreeRow,
  hasLiveDescendant: (nodeId: NodeId) => boolean
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
  if ((node.status === "live" || hasLiveDescendant(node.id)) && canRenderHydratingNodeAction("close-node", node)) {
    actions.append(actionButton("Close", "close-node", "close-circle"));
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

function canRenderHydratingNodeAction(action: string, node: OutlineNode): boolean {
  if (!hydratingFullState || !currentProjection || !isSparseInitialProjection(currentProjection)) {
    return true;
  }

  const coverage = currentProjectionCoverage;
  if (!coverage?.editableNodeIds.has(node.id)) {
    return false;
  }

  if (action === "cut" || action === "paste" || action === "move-subtree-to-top-level") {
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
  if (!state || !projection || !hydratingFullState || !isSparseInitialProjection(projection)) {
    return;
  }

  const row = rowForItem(item);
  if (!row || row.querySelector(".node-actions")) {
    return;
  }

  const node = state.nodes[rowInfo.nodeId];
  if (!node) {
    return;
  }

  const actions = renderNodeActions(state, node, rowInfo, createLiveDescendantChecker(state));
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
  if (scheduledHoverGuideFrame !== undefined) {
    window.cancelAnimationFrame(scheduledHoverGuideFrame);
    scheduledHoverGuideFrame = undefined;
  }
  hoverLineScope = undefined;
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
  if (scheduledHoverGuideFrame !== undefined) {
    window.cancelAnimationFrame(scheduledHoverGuideFrame);
    scheduledHoverGuideFrame = undefined;
  }
  pendingHoverLineScope = undefined;
  pendingHoverGuideReason = "pointer";
  pendingHoverFeedbackTrace = undefined;
  pendingHoverGuideApply = false;

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
  if (!hydratingFullState || !currentProjection || !isSparseInitialProjection(currentProjection)) {
    return true;
  }
  if (action === "focus-or-restore") {
    return node.status === "live" || canRenderHydratingNodeAction("restoreNode", node);
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
  if (hydratingFullState || !state || !row || !nodeId || activeRename?.nodeId === nodeId) {
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
  if (hydratingFullState || !state || !row || !targetId) {
    return;
  }

  const placement = dropPlacementForRowEvent(state, targetId, event.clientY, row);
  if (!placement) {
    clearDropPreview();
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
  if (hydratingFullState || !state || !row || !targetId || !sourceId) {
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

  event.preventDefault();
  event.stopPropagation();
  performDrop(placement);
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
  render();
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
  await runAndRender({ type: "renameGroup", nodeId, title });
}

function cancelRenameGroup(nodeId: NodeId): void {
  if (activeRename?.nodeId !== nodeId) {
    return;
  }

  activeRename = undefined;
  render();
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

  clearSearchQuery();
}

function cutNodeForPaste(nodeId: NodeId): void {
  if (!currentState?.nodes[nodeId]) {
    return;
  }

  pendingCutNodeId = nodeId;
  showDiagnosticsNotice("Cut subtree");
  render();
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

function scrollToObservedActiveTab(projection: VisibleTreeProjection): void {
  const rowHeight = currentRowHeight();
  prepareVirtualScrollSurface(projection, rowHeight);
  scrollActiveTabIntoView(
    activeTabScrollTracker,
    activeScrollProjectionForSidebarWindow(projection),
    rootDropSurface ?? undefined,
    rowHeight
  );
}

function activeScrollNodeIdForSidebarWindow(projection: VisibleTreeProjection): NodeId | undefined {
  return activeTabNodeIdForSidebarWindow(currentState, sidebarWindowId) ?? projection.activeTabNodeId;
}

function activeScrollProjectionForSidebarWindow(projection: VisibleTreeProjection): ActiveTabScrollProjection {
  const scopedActiveTabNodeId = activeTabNodeIdForSidebarWindow(currentState, sidebarWindowId);
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
    return false;
  }

  const rowHeight = currentRowHeight();
  prepareVirtualScrollSurface(projection, rowHeight);
  centerRowInViewport(row.index, rootDropSurface ?? undefined, rowHeight);
  startRevealHighlight(targetNodeId);
  return true;
}

function startRevealHighlight(nodeId: NodeId): void {
  revealHighlightNodeId = nodeId;
  if (revealHighlightTimer !== undefined) {
    window.clearTimeout(revealHighlightTimer);
  }

  revealHighlightTimer = window.setTimeout(() => {
    revealHighlightTimer = undefined;
    if (revealHighlightNodeId === nodeId) {
      revealHighlightNodeId = undefined;
      scheduleCurrentRowsRender();
    }
  }, SHOW_IN_TREE_HIGHLIGHT_MS);
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
  const maxScrollTop = Number.isFinite(viewport.scrollHeight)
    ? Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    : centeredScrollTop;
  viewport.scrollTop = Math.min(centeredScrollTop, maxScrollTop);
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

  const scope = await restoreScopeForNode(state, nodeId);
  if (scope.requiresConfirmation && !window.confirm(largeRestoreConfirmationPrompt(scope))) {
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
    const response = await sendCommand({ type: "analyzeRestoreScope", nodeId }).catch(() => undefined);
    if (isRestoreScope(response)) {
      return response;
    }
  }

  return perfTrace.measure("sidebar.restore.scope", () => analyzeRestoreScope(state, nodeId));
}

function shouldAskBackgroundForRestoreScope(nodeId: NodeId): boolean {
  if (!hydratingFullState || !currentProjection || !isSparseInitialProjection(currentProjection)) {
    return false;
  }
  const node = currentState?.nodes[nodeId];
  return Boolean(node && node.kind !== "tab" && !currentProjectionCoverage?.completeSubtreeNodeIds.has(nodeId));
}

function isRestoreScope(value: unknown): value is RestoreScope {
  return Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray((value as { nodeIds?: unknown }).nodeIds) &&
      typeof (value as { totalCount?: unknown }).totalCount === "number" &&
      typeof (value as { tabCount?: unknown }).tabCount === "number" &&
      typeof (value as { windowCount?: unknown }).windowCount === "number" &&
      typeof (value as { threshold?: unknown }).threshold === "number" &&
      typeof (value as { requiresConfirmation?: unknown }).requiresConfirmation === "boolean"
  );
}

function largeRestoreConfirmationPrompt(scope: RestoreScope): string {
  return `Restore ${restoreScopeSummary(scope)}?\n\nThis may open many tabs or windows at once.`;
}

function restoreScopeSummary(scope: RestoreScope): string {
  const parts = [
    scope.tabCount > 0 ? `${scope.tabCount} ${pluralize(scope.tabCount, "tab")}` : undefined,
    scope.windowCount > 0 ? `${scope.windowCount} ${pluralize(scope.windowCount, "window")}` : undefined
  ].filter((part): part is string => Boolean(part));

  return `${scope.totalCount} ${pluralize(scope.totalCount, "restorable closed node")}${parts.length ? ` (${parts.join(", ")})` : ""}`;
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
      currentState = response;
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

function messageType(message: unknown): string {
  return message && typeof message === "object" && typeof (message as { type?: unknown }).type === "string"
    ? (message as { type: string }).type
    : isOutlineState(message)
      ? "OutlineState"
      : "unknown";
}

function isStateUpdated(message: unknown): message is { type: "stateUpdated"; state: OutlineState } {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "stateUpdated" &&
      (message as { state?: unknown }).state
  );
}

function isInitialTreeSnapshot(message: unknown): message is InitialTreeSnapshot {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "initialTreeSnapshot" &&
      (message as { version?: unknown }).version === 1 &&
      isOutlineState((message as { state?: unknown }).state) &&
      typeof (message as { revision?: unknown }).revision === "number" &&
      typeof (message as { hydrating?: unknown }).hydrating === "boolean" &&
      (message as { projection?: unknown }).projection &&
      typeof (message as { projection?: unknown }).projection === "object" &&
      Array.isArray((message as { projection: { rows?: unknown } }).projection.rows) &&
      typeof (message as { projection: { totalRowCount?: unknown } }).projection.totalRowCount === "number" &&
      Array.isArray((message as { projection: { visibleNodeIds?: unknown } }).projection.visibleNodeIds) &&
      Array.isArray((message as { projection: { matchingNodeIds?: unknown } }).projection.matchingNodeIds)
  );
}

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

function isActiveStateUpdated(message: unknown): message is { type: "activeStateUpdated"; updates: ActiveStateUpdate[] } {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "activeStateUpdated" &&
      Array.isArray((message as { updates?: unknown }).updates) &&
      (message as { updates: unknown[] }).updates.every((update) =>
        Boolean(
          update &&
            typeof update === "object" &&
            typeof (update as { nodeId?: unknown }).nodeId === "string" &&
            typeof (update as { active?: unknown }).active === "boolean"
        )
      )
  );
}

function isNodeStateUpdated(message: unknown): message is NodeStateUpdate {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "nodeStateUpdated" &&
      Array.isArray((message as { updatedNodes?: unknown }).updatedNodes) &&
      (message as { updatedNodes: unknown[] }).updatedNodes.every((node) =>
        Boolean(
          node &&
            typeof node === "object" &&
            typeof (node as { id?: unknown }).id === "string" &&
            Array.isArray((node as { childIds?: unknown }).childIds)
        )
      ) &&
      typeof (message as { closedCountDelta?: unknown }).closedCountDelta === "number"
  );
}

function isTreeStructureUpdated(message: unknown): message is TreeStructureUpdate {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "treeStructureUpdated" &&
      Array.isArray((message as { deletedNodeIds?: unknown }).deletedNodeIds) &&
      (message as { deletedNodeIds: unknown[] }).deletedNodeIds.every((nodeId) => typeof nodeId === "string") &&
      Array.isArray((message as { updatedNodes?: unknown }).updatedNodes) &&
      (message as { updatedNodes: unknown[] }).updatedNodes.every((node) =>
        Boolean(
          node &&
            typeof node === "object" &&
            typeof (node as { id?: unknown }).id === "string" &&
            Array.isArray((node as { childIds?: unknown }).childIds)
        )
      ) &&
      Array.isArray((message as { rootIds?: unknown }).rootIds) &&
      (message as { rootIds: unknown[] }).rootIds.every((nodeId) => typeof nodeId === "string") &&
      typeof (message as { deletedClosedCount?: unknown }).deletedClosedCount === "number"
  );
}

function isHistoryStatus(message: unknown): message is { type: "historyStatus" } & HistoryStatus {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "historyStatus" &&
      typeof (message as { canUndo?: unknown }).canUndo === "boolean" &&
      typeof (message as { canRedo?: unknown }).canRedo === "boolean" &&
      typeof (message as { undoDepth?: unknown }).undoDepth === "number" &&
      typeof (message as { redoDepth?: unknown }).redoDepth === "number"
  );
}

function isCommandAck(message: unknown): message is CommandAck {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "commandAck" &&
      typeof (message as { stateChanged?: unknown }).stateChanged === "boolean"
  );
}

function isOutlineState(message: unknown): message is OutlineState {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { version?: unknown }).version === 1 &&
      Array.isArray((message as { rootIds?: unknown }).rootIds) &&
      typeof (message as { nodes?: unknown }).nodes === "object" &&
      (message as { nodes?: unknown }).nodes !== null
  );
}
