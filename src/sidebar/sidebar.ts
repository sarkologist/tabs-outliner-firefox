import type { BackgroundCommand } from "../background/commands.js";
import type { CommandAck } from "../background/commands.js";
import type { OutlineDiagnostics } from "../background/diagnostics.js";
import { analyzeRestoreScope, type RestoreScope } from "../model/outline.js";
import { exportPortableTree } from "../model/portable-tree.js";
import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import {
  createPerformanceTracer,
  summarizeTraceEvents,
  type TraceSnapshot,
  type TraceSummaryRow
} from "../perf/trace.js";
import { createActiveTabScrollTracker, scrollActiveTabIntoView } from "./active-scroll.js";
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
import { segmentSearchText } from "./search.js";
import {
  applyDeleteTreeStructurePatchToProjection,
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

const stateCount = document.querySelector<HTMLSpanElement>("#state-count");
const diagnostics = document.querySelector<HTMLSpanElement>("#diagnostics");
const refresh = document.querySelector<HTMLButtonElement>("#refresh");
const exportTree = document.querySelector<HTMLButtonElement>("#export-tree");
const importTree = document.querySelector<HTMLButtonElement>("#import-tree");
const importTreeFile = document.querySelector<HTMLInputElement>("#import-tree-file");
const rootDropSurface = document.querySelector<HTMLElement>("main");
const tree = document.querySelector<HTMLElement>("#tree");
const empty = document.querySelector<HTMLElement>("#empty");
const searchInput = document.querySelector<HTMLInputElement>("#search");
const clearSearch = document.querySelector<HTMLButtonElement>("#clear-search");

let currentState: OutlineState | undefined;
let draggedNodeId: NodeId | undefined;
let activeDropPlacement: DropPlacement | undefined;
let currentZoom = DEFAULT_ZOOM;
let wheelZoomDelta = 0;
let currentSearchQuery = "";
let diagnosticsNoticeUntil = 0;
let diagnosticsNoticeTimer: number | undefined;
let activeRename: RenameSession | undefined;
let currentProjection: VisibleTreeProjection | undefined;
let projectionState: OutlineState | undefined;
let projectionQuery: string | undefined;
let scheduledVirtualRender = false;
let hoverLineScope: HoverLineScope | undefined;
let pendingCutNodeId: NodeId | undefined;
let currentCutRowRange: CutSubtreeRowRange | undefined;
const activeTabScrollTracker = createActiveTabScrollTracker();

const WHEEL_ZOOM_THRESHOLD_PX = 80;
const DIAGNOSTICS_NOTICE_MS = 4000;
const DIAGNOSTICS_REFRESH_DELAY_MS = 750;
const PROFILE_STORAGE_KEY = "tabsOutlinerProfileEnabled";
const VIRTUAL_OVERSCAN_ROWS = 32;
const GUIDE_TOP = 1;
const GUIDE_BOTTOM = 2;
const GUIDE_FULL = GUIDE_TOP | GUIDE_BOTTOM;

type ProfileSnapshot = {
  sidebar: TraceSnapshot;
  background?: TraceSnapshot;
};

type SidebarProfileConsole = {
  enable(): Promise<ProfileSnapshot>;
  disable(): Promise<ProfileSnapshot>;
  clear(): Promise<void>;
  snapshot(): Promise<ProfileSnapshot>;
  summary(): Promise<TraceSummaryRow[]>;
};

declare global {
  interface Window {
    tabsOutlinerProfile?: SidebarProfileConsole;
  }
}

type RenameSession = {
  nodeId: NodeId;
  draft: string;
};

type HoverLineScope = {
  rowIndex: number;
  parentRowIndex?: number;
  subtreeEndIndex: number;
  targetDepth: number;
};

type HoverGuideSegments = {
  horizontalDepth?: number;
  verticalSegments: Map<number, number>;
};

const dropMarker = document.createElement("li");
dropMarker.className = "drop-marker";
dropMarker.setAttribute("aria-hidden", "true");

const diagnosticsScheduler = createDiagnosticsScheduler(loadDiagnostics, {
  clock: {
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timerId) => window.clearTimeout(timerId)
  },
  delayMs: DIAGNOSTICS_REFRESH_DELAY_MS
});
const perfTrace = createPerformanceTracer("sidebar", {
  enabled: storedProfileEnabled()
});

installProfileConsole();
applyZoom(currentZoom);
registerZoomShortcuts();
registerSearchControls();
registerPortableTreeControls();
registerTreeControls();
registerVirtualViewport();
void loadZoomPreference();
void loadState();

refresh?.addEventListener("click", () => {
  void runAndRender({ type: "refresh" });
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

  event.preventDefault();
  performDrop(placement);
});

browser.runtime.onMessage.addListener((message) => {
  perfTrace.measure("sidebar.runtime.message", { type: messageType(message) }, () => {
    if (isStateUpdated(message)) {
      currentState = message.state;
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
    }
  });
});

async function loadState(): Promise<void> {
  try {
    currentState = (await sendCommand({ type: "getState" })) as OutlineState;
    render();
    scheduleDiagnosticsLoad();
  } catch (error) {
    showLoadError(error);
  }
}

async function loadZoomPreference(): Promise<void> {
  const stored = await browser.storage.local.get(ZOOM_STORAGE_KEY).catch(() => undefined);
  if (!stored) {
    return;
  }

  setZoom(normalizeStoredZoom(stored[ZOOM_STORAGE_KEY]), { persist: false });
}

function installProfileConsole(): void {
  if (perfTrace.isEnabled()) {
    void setBackgroundTraceEnabled(true);
  }

  window.tabsOutlinerProfile = {
    enable: async () => {
      storeProfileEnabled(true);
      perfTrace.setEnabled(true);
      perfTrace.mark("sidebar.profile.enabled");
      await setBackgroundTraceEnabled(true);
      return profileSnapshot();
    },
    disable: async () => {
      storeProfileEnabled(false);
      perfTrace.mark("sidebar.profile.disabled");
      perfTrace.setEnabled(false);
      await setBackgroundTraceEnabled(false);
      return profileSnapshot();
    },
    clear: async () => {
      perfTrace.clear();
      await browser.runtime.sendMessage({ type: "clearPerformanceTrace" }).catch(() => undefined);
    },
    snapshot: profileSnapshot,
    summary: async () => {
      const snapshot = await profileSnapshot();
      return summarizeTraceEvents([
        ...snapshot.sidebar.entries,
        ...(snapshot.background?.entries ?? [])
      ]);
    }
  };
}

async function profileSnapshot(): Promise<ProfileSnapshot> {
  const background = (await browser.runtime.sendMessage({ type: "getPerformanceTrace" }).catch(() => undefined)) as
    | TraceSnapshot
    | undefined;

  return {
    sidebar: perfTrace.snapshot(),
    ...(background ? { background } : {})
  };
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
    if (!isZoomModifierEvent(event)) {
      return;
    }

    const action = zoomKeyboardAction(event.key);
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
    currentSearchQuery = searchInput.value;
    updateSearchControls();
    render();
  });

  clearSearch?.addEventListener("click", () => {
    clearSearchQuery({ focus: true });
  });

  document.addEventListener("keydown", (event) => {
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
    exportCurrentTree();
  });

  importTree?.addEventListener("click", () => {
    importTreeFile?.click();
  });

  importTreeFile?.addEventListener("change", () => {
    void importSelectedTreeFile();
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
    () => {
      scheduleVirtualRender();
    },
    { passive: true }
  );
  window.addEventListener("resize", () => {
    scheduleVirtualRender();
  });
}

function exportCurrentTree(): void {
  if (!currentState) {
    showDiagnosticsNotice("Export unavailable until loaded", { error: true });
    return;
  }

  const payload = exportPortableTree(currentState);
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `tabs-outliner-tree-${localDateSlug(new Date())}.json`;
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

function localDateSlug(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLocaleLowerCase() === "f";
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

function zoomKeyboardAction(key: string): ZoomDirection | "reset" | undefined {
  if (key === "+" || key === "=") {
    return "in";
  }

  if (key === "-" || key === "_") {
    return "out";
  }

  if (key === "0" || key === ")") {
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
      hoverLineScope = undefined;
      tree.textContent = "";
      tree.style.height = "0px";
      stateCount.textContent = "Loading";
      return;
    }
    if (activeRename) {
      const renamedNode = state.nodes[activeRename.nodeId];
      if (!renamedNode || renamedNode.kind !== "window") {
        activeRename = undefined;
      }
    }
    pendingCutNodeId = nextPendingCutNodeId(state, pendingCutNodeId);

    const projection = visibleProjectionFor(state, currentSearchQuery);
    currentProjection = projection;
    currentCutRowRange = cutSubtreeRowRange(projection.rows, pendingCutNodeId);
    hoverLineScope = undefined;
    updateProjectionChrome(projection);
    scrollToObservedActiveTab(projection);
    renderVirtualRows();
  });
}

function updateProjectionChrome(projection: VisibleTreeProjection): void {
  if (stateCount) {
    stateCount.textContent = projection.isSearchActive
      ? `${projection.matchCount} ${pluralize(projection.matchCount, "match")} / ${projection.nodeCount} items`
      : `${projection.nodeCount} items / ${projection.closedCount} saved`;
  }

  if (empty) {
    empty.textContent = projection.isSearchActive ? "No matching tabs." : "No tabs captured yet.";
    empty.hidden = projection.isSearchActive ? projection.rows.length > 0 : projection.nodeCount > 0;
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

    if (windowActiveChanged && currentProjection) {
      refreshProjectionActiveWindowFlags(state, currentProjection);
    }
    if (currentProjection) {
      refreshProjectionActiveTabTarget(state, currentProjection);
      scrollToObservedActiveTab(currentProjection);
    }
    scheduleVirtualRender();
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
      collapsedChanged ||= previous?.collapsed !== node.collapsed;
      state.nodes[node.id] = node;
      windowActiveChanged ||= node.kind === "window";
    }
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
    scheduleVirtualRender();
  });
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

    const deletedNodeIds = new Set(update.deletedNodeIds);
    for (const nodeId of deletedNodeIds) {
      delete state.nodes[nodeId];
    }
    for (const node of update.updatedNodes) {
      state.nodes[node.id] = node;
    }
    state.rootIds = [...update.rootIds];
    if (activeRename && deletedNodeIds.has(activeRename.nodeId)) {
      activeRename = undefined;
    }
    pendingCutNodeId = nextPendingCutNodeId(state, pendingCutNodeId);

    if (!currentProjection) {
      invalidateProjectionCache();
      render();
      return;
    }
    if (deletedNodeIds.size === 0) {
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
    scheduleVirtualRender();
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
    if (node?.kind === "tab" && node.active && row.insideActiveWindow) {
      projection.activeTabNodeId = node.id;
      projection.activeTabRowIndex = row.index;
      return;
    }
  }
}

function canFlattenSubtree(state: OutlineState, node: OutlineNode): boolean {
  return node.childIds.some((childId) => (state.nodes[childId]?.childIds.length ?? 0) > 0);
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

function renderVirtualRows(): void {
  perfTrace.measure("sidebar.virtualRows", {
    rows: currentProjection?.rows.length ?? 0
  }, () => {
    if (!tree || !currentProjection || !currentState) {
      return;
    }

    const rowHeight = currentRowHeight();
    const range = calculateVirtualRange(
      currentProjection.rows.length,
      rootDropSurface?.scrollTop ?? 0,
      rootDropSurface?.clientHeight ?? window.innerHeight,
      rowHeight,
      VIRTUAL_OVERSCAN_ROWS
    );

    activeDropPlacement = undefined;
    removeDropPreviewElements();
    tree.style.height = `${range.totalHeight}px`;
    tree.textContent = "";

    const fragment = document.createDocumentFragment();
    for (let index = range.start; index < range.end; index += 1) {
      const row = currentProjection.rows[index];
      if (row) {
        fragment.append(renderRow(currentState, row, rowHeight, currentProjection.query));
      }
    }
    tree.append(fragment);
  });
}

function currentRowHeight(): number {
  const value = window.getComputedStyle(document.documentElement).getPropertyValue("--node-row-height");
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 18;
}

function renderRow(state: OutlineState, rowInfo: VisibleTreeRow, rowHeight: number, searchQuery: string): HTMLElement {
  const node = state.nodes[rowInfo.nodeId];
  if (!node) {
    return document.createElement("li");
  }

  const isActiveWindow = node.kind === "window" && Boolean(node.active);
  const isActiveTab = node.kind === "tab" && Boolean(node.active) && rowInfo.insideActiveWindow;
  const isRenaming = activeRename?.nodeId === node.id && node.kind === "window";
  const item = document.createElement("li");
  item.className = `node node-${node.kind} is-${node.status}${isActiveWindow || isActiveTab ? " is-active" : ""}${
    rowInfo.isSearchMatch ? " is-search-match" : ""
  }${rowInfo.isSearchPath ? " is-search-path" : ""}${
    isRowInCutSubtree(rowInfo, currentCutRowRange) ? " is-cut" : ""
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
  twisty.textContent = rowInfo.childCount ? (node.collapsed ? "+" : "-") : "";
  twisty.disabled = rowInfo.childCount === 0;
  row.append(twisty);

  const titleText = node.title || "Untitled";
  if (isRenaming) {
    row.append(renderRenameInput(node, titleText));
  } else {
    const label = document.createElement("button");
    label.className = "node-label";
    label.type = "button";
    label.title = node.url ?? titleText;
    label.ariaLabel = node.url ? `${titleText} - ${node.url}` : titleText;
    label.dataset.action = "focus-or-restore";

    const title = document.createElement("span");
    title.className = "node-title";
    appendTitleText(title, titleText, rowInfo.isSearchMatch ? searchQuery : "");
    label.append(title);

    row.append(label);
  }

  const actions = document.createElement("span");
  actions.className = "node-actions";

  actions.append(actionButton("Cut", "cut", "X"));
  if (pendingCutNodeId) {
    actions.append(actionButton("Paste", "paste", "P", !pasteAfterCommand(state, pendingCutNodeId, node.id)));
  }
  actions.append(actionButton(node.status === "live" ? "Close" : "Restore", "close-or-restore"));

  if (canFlattenSubtree(state, node)) {
    actions.append(actionButton("Flatten", "flatten"));
  }

  if (node.kind === "window") {
    actions.append(actionButton("Rename", "rename", "N"));
  }

  actions.append(actionButton("Delete", "delete"));
  row.append(actions);

  item.append(row);

  return item;
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
  if (event.pointerType === "touch") {
    clearHoverLineScope();
    return;
  }

  const item = nodeItemForTarget(event.target);
  if (!item) {
    clearHoverLineScope();
    return;
  }

  const rowIndex = rowIndexForItem(item);
  const rowInfo = typeof rowIndex === "number" ? currentProjection?.rows[rowIndex] : undefined;
  if (!rowInfo) {
    clearHoverLineScope();
    return;
  }

  const nextScope: HoverLineScope = {
    rowIndex: rowInfo.index,
    subtreeEndIndex: rowInfo.subtreeEndIndex,
    targetDepth: rowInfo.depth,
    ...(typeof rowInfo.parentRowIndex === "number" ? { parentRowIndex: rowInfo.parentRowIndex } : {})
  };
  setHoverLineScope(nextScope);
}

function handleTreePointerLeave(event: PointerEvent): void {
  clearHoverLineScope();
}

function setHoverLineScope(scope: HoverLineScope): void {
  if (sameHoverLineScope(hoverLineScope, scope)) {
    return;
  }

  hoverLineScope = scope;
  applyHoverLineScopeToRenderedRows();
}

function clearHoverLineScope(): void {
  if (!hoverLineScope) {
    return;
  }

  hoverLineScope = undefined;
  applyHoverLineScopeToRenderedRows();
}

function sameHoverLineScope(left: HoverLineScope | undefined, right: HoverLineScope): boolean {
  return (
    left?.rowIndex === right.rowIndex &&
    left?.parentRowIndex === right.parentRowIndex &&
    left?.subtreeEndIndex === right.subtreeEndIndex &&
    left?.targetDepth === right.targetDepth
  );
}

function applyHoverLineScopeToRenderedRows(): void {
  if (!tree || !currentProjection) {
    return;
  }

  for (const item of Array.from(tree.querySelectorAll<HTMLElement>(".node"))) {
    const row = rowForItem(item);
    const rowIndex = rowIndexForItem(item);
    const rowInfo = typeof rowIndex === "number" ? currentProjection.rows[rowIndex] : undefined;
    if (row && rowInfo) {
      applyHoverLineClasses(row, rowInfo);
    }
  }
}

function applyHoverLineClasses(row: HTMLElement, rowInfo: VisibleTreeRow): void {
  row.querySelector<HTMLElement>(".tree-guide-layer")?.remove();

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

function hoverGuideSegmentsForRow(rowInfo: VisibleTreeRow): HoverGuideSegments {
  const verticalSegments = new Map<number, number>();
  const projection = currentProjection;
  const scope = hoverLineScope;
  if (!scope || !projection) {
    return { verticalSegments };
  }

  const firstGuideIndex = scope.parentRowIndex ?? scope.rowIndex;
  if (rowInfo.index < firstGuideIndex || rowInfo.index >= scope.subtreeEndIndex) {
    return { verticalSegments };
  }

  const isConnectorRow = rowInfo.index >= scope.rowIndex && rowInfo.index < scope.subtreeEndIndex && rowInfo.depth > 0;
  for (let connectorIndex = scope.rowIndex; connectorIndex < scope.subtreeEndIndex; connectorIndex += 1) {
    const connectorRow = projection.rows[connectorIndex];
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
  if (action === "toggle") {
    void runAndRender({ type: "toggleCollapsed", nodeId: node.id });
    return;
  }

  if (action === "focus-or-restore") {
    if (node.status === "live") {
      void sendCommand({ type: "focusNode", nodeId: node.id });
    } else {
      restoreNodeWithConfirmation(node.id);
    }
    return;
  }

  if (action === "close-or-restore") {
    if (node.status === "live") {
      void runAndRender({ type: "closeNode", nodeId: node.id });
    } else {
      restoreNodeWithConfirmation(node.id);
    }
    return;
  }

  if (action === "flatten") {
    void runAndRender({ type: "flattenSubtree", nodeId: node.id });
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

function handleTreeDragStart(event: DragEvent): void {
  const state = currentState;
  const row = rowForEventTarget(event.target);
  const item = row ? nodeItemForTarget(row) : undefined;
  const nodeId = item?.dataset.nodeId;
  if (!state || !row || !nodeId || activeRename?.nodeId === nodeId) {
    event.preventDefault();
    return;
  }

  draggedNodeId = nodeId;
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
  const shortcutAction = keyboardCutPasteAction(event, shortcutTarget);
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
  if (node.kind !== "window") {
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

function actionButton(label: string, action: string, glyph?: string, disabled = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "icon-button action";
  button.type = "button";
  button.title = label;
  button.textContent = glyph ?? (label === "Delete" ? "x" : label[0] ?? "?");
  button.dataset.action = action;
  button.disabled = disabled;
  return button;
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
  if (!tree) {
    return;
  }

  removeDropPreviewElements();
  activeDropPlacement = placement;

  if (placement.kind === "root") {
    rootDropSurface?.classList.add("root-drop-target");
    prepareDropMarker(placement.mode ? `drop-${placement.mode}` : "drop-root", 0);
    if (placement.targetId && placement.mode) {
      const targetItem = nodeItemForId(placement.targetId);
      const targetRowIndex = targetItem ? rowIndexForItem(targetItem) : undefined;
      if (!targetItem || typeof targetRowIndex !== "number") {
        clearDropPreview();
        return;
      }

      positionDropMarker(targetRowIndex + (placement.mode === "after" ? 1 : 0));
      tree.append(dropMarker);
      return;
    }

    positionDropMarker(currentProjection?.rows.length ?? 0);
    tree.append(dropMarker);
    return;
  }

  const targetItem = nodeItemForId(placement.targetId);
  const targetRow = targetItem ? rowForItem(targetItem) : undefined;
  const targetRowIndex = targetItem ? rowIndexForItem(targetItem) : undefined;
  if (!targetItem || !targetRow || typeof targetRowIndex !== "number") {
    clearDropPreview();
    return;
  }

  const targetDepth = Number(targetRow.style.getPropertyValue("--depth")) || 0;
  const markerDepth = placement.mode === "inside" ? targetDepth + 1 : targetDepth;
  prepareDropMarker(`drop-${placement.mode}`, markerDepth);
  positionDropMarker(targetRowIndex + (placement.mode === "before" ? 0 : 1));
  if (placement.mode === "inside") {
    targetRow.classList.add("drop-inside-target");
  }
  tree.append(dropMarker);
}

function prepareDropMarker(className: string, depth: number): void {
  dropMarker.className = `drop-marker ${className}`;
  dropMarker.style.setProperty("--depth", String(depth));
}

function positionDropMarker(rowIndex: number): void {
  dropMarker.style.transform = `translateY(${Math.max(0, rowIndex) * currentRowHeight()}px)`;
}

function rowIndexForItem(item: HTMLElement): number | undefined {
  const parsed = Number.parseInt(item.dataset.rowIndex ?? "", 10);
  return Number.isFinite(parsed) ? parsed : undefined;
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
  scrollActiveTabIntoView(activeTabScrollTracker, projection, rootDropSurface ?? undefined, currentRowHeight());
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

function restoreNodeWithConfirmation(nodeId: NodeId): void {
  const state = currentState;
  if (!state) {
    return;
  }

  const scope = perfTrace.measure("sidebar.restore.scope", () => analyzeRestoreScope(state, nodeId));
  if (scope.requiresConfirmation && !window.confirm(largeRestoreConfirmationPrompt(scope))) {
    return;
  }

  void runAndRender({
    type: "restoreNode",
    nodeId,
    ...(scope.requiresConfirmation ? { confirmedLargeRestore: true } : {})
  });
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

async function sendCommand(command: BackgroundCommand): Promise<unknown> {
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
