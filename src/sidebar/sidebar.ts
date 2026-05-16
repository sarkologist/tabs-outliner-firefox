import type { BackgroundCommand } from "../background/commands.js";
import type { CommandAck } from "../background/commands.js";
import type { OutlineDiagnostics } from "../background/diagnostics.js";
import { analyzeRestoreScope, type RestoreScope } from "../model/outline.js";
import { exportPortableTree } from "../model/portable-tree.js";
import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import { createActiveTabScrollTracker, observeActiveTabNodeId } from "./active-scroll.js";
import {
  commandForDropPlacement,
  dropModeForPointer,
  dropPlacementForNode,
  dropPlacementForRoot,
  type DropPlacement
} from "./drop-target.js";
import {
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
const activeTabScrollTracker = createActiveTabScrollTracker();

const WHEEL_ZOOM_THRESHOLD_PX = 80;
const DIAGNOSTICS_NOTICE_MS = 4000;
const VIRTUAL_OVERSCAN_ROWS = 32;

type RenameSession = {
  nodeId: NodeId;
  draft: string;
};

const dropMarker = document.createElement("li");
dropMarker.className = "drop-marker";
dropMarker.setAttribute("aria-hidden", "true");

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
  if (isStateUpdated(message)) {
    currentState = message.state;
    render();
    void loadDiagnostics();
    return;
  }
  if (isActiveStateUpdated(message)) {
    applyActiveStateUpdate(message.updates);
    return;
  }
  if (isNodeStateUpdated(message)) {
    applyNodeStateUpdate(message);
    void loadDiagnostics();
    return;
  }
  if (isTreeStructureUpdated(message)) {
    applyTreeStructureUpdate(message);
    void loadDiagnostics();
  }
});

async function loadState(): Promise<void> {
  try {
    currentState = (await sendCommand({ type: "getState" })) as OutlineState;
    render();
    void loadDiagnostics();
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
  if (!tree || !stateCount) {
    return;
  }

  clearDropPreview();
  const state = currentState;
  if (!state) {
    currentProjection = undefined;
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

  const projection = visibleProjectionFor(state, currentSearchQuery);
  currentProjection = projection;
  updateProjectionChrome(projection);
  scrollToObservedActiveTab(projection);
  renderVirtualRows();
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
  }
  scheduleVirtualRender();
}

function applyNodeStateUpdate(update: NodeStateUpdate): void {
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
  scheduleVirtualRender();
}

function applyTreeStructureUpdate(update: TreeStructureUpdate): void {
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

  if (!currentProjection || currentProjection.isSearchActive) {
    invalidateProjectionCache();
    render();
    return;
  }
  if (deletedNodeIds.size === 0) {
    invalidateProjectionCache();
    render();
    return;
  }

  const updatedNodes = new Map(update.updatedNodes.map((node) => [node.id, node]));
  currentProjection.rows = currentProjection.rows.filter((row) => !deletedNodeIds.has(row.nodeId));
  for (let index = 0; index < currentProjection.rows.length; index += 1) {
    const row = currentProjection.rows[index]!;
    row.index = index;
  }
  currentProjection.visibleNodeIds = currentProjection.rows.map((row) => row.nodeId);
  currentProjection.visibleNodeIdSet = new Set(currentProjection.visibleNodeIds);
  currentProjection.nodeCount = Math.max(0, currentProjection.nodeCount - update.deletedNodeIds.length);
  currentProjection.closedCount = Math.max(0, currentProjection.closedCount - update.deletedClosedCount);

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
  scheduleVirtualRender();
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
    return currentProjection;
  }

  projectionState = state;
  projectionQuery = query;
  currentProjection = buildVisibleTreeProjection(state, query);
  return currentProjection;
}

function scheduleVirtualRender(): void {
  if (scheduledVirtualRender) {
    return;
  }

  scheduledVirtualRender = true;
  window.requestAnimationFrame(() => {
    scheduledVirtualRender = false;
    renderVirtualRows();
  });
}

function renderVirtualRows(): void {
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
      fragment.append(renderRow(currentState, row, rowHeight));
    }
  }
  tree.append(fragment);
}

function currentRowHeight(): number {
  const value = window.getComputedStyle(document.documentElement).getPropertyValue("--node-row-height");
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 18;
}

function renderRow(state: OutlineState, rowInfo: VisibleTreeRow, rowHeight: number): HTMLElement {
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
  }${rowInfo.isSearchPath ? " is-search-path" : ""}`;
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
    title.textContent = titleText;
    label.append(title);

    row.append(label);
  }

  const actions = document.createElement("span");
  actions.className = "node-actions";

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

function actionButton(label: string, action: string, glyph?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "icon-button action";
  button.type = "button";
  button.title = label;
  button.textContent = glyph ?? (label === "Delete" ? "x" : label[0] ?? "?");
  button.dataset.action = action;
  return button;
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
  const nodeId = observeActiveTabNodeId(activeTabScrollTracker, projection.activeTabNodeId, {
    hasRenderedNode: (candidate) => projection.visibleNodeIdSet.has(candidate)
  });
  if (!nodeId) {
    return;
  }

  if (typeof projection.activeTabRowIndex !== "number" || !rootDropSurface) {
    return;
  }

  const rowHeight = currentRowHeight();
  const rowTop = projection.activeTabRowIndex * rowHeight;
  const rowBottom = rowTop + rowHeight;
  const viewportTop = rootDropSurface.scrollTop;
  const viewportBottom = viewportTop + rootDropSurface.clientHeight;

  if (rowTop < viewportTop) {
    rootDropSurface.scrollTop = rowTop;
    return;
  }

  if (rowBottom > viewportBottom) {
    rootDropSurface.scrollTop = Math.max(0, rowBottom - rootDropSurface.clientHeight);
  }
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

  const scope = analyzeRestoreScope(state, nodeId);
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

async function runAndRender(command: BackgroundCommand): Promise<void> {
  try {
    const response = await sendCommand(command);
    if (isCommandAck(response)) {
      return;
    }
    if (isOutlineState(response)) {
      currentState = response;
      render();
      void loadDiagnostics();
    }
  } catch (error) {
    showDiagnosticsNotice(commandErrorText(error), { error: true });
  }
}

async function sendCommand(command: BackgroundCommand): Promise<unknown> {
  return browser.runtime.sendMessage(command);
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
    void loadDiagnostics();
  }, DIAGNOSTICS_NOTICE_MS);
}

async function loadDiagnostics(): Promise<void> {
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
