import type { BackgroundCommand } from "../background/commands.js";
import type { OutlineDiagnostics } from "../background/diagnostics.js";
import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import {
  commandForDropPlacement,
  dropModeForPointer,
  dropPlacementForNode,
  dropPlacementForRoot,
  type DropPlacement
} from "./drop-target.js";
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
const rootDropSurface = document.querySelector<HTMLElement>("main");
const tree = document.querySelector<HTMLElement>("#tree");
const empty = document.querySelector<HTMLElement>("#empty");

let currentState: OutlineState | undefined;
let draggedNodeId: NodeId | undefined;
let activeDropPlacement: DropPlacement | undefined;
let currentZoom = DEFAULT_ZOOM;
let wheelZoomDelta = 0;

const WHEEL_ZOOM_THRESHOLD_PX = 80;

const dropMarker = document.createElement("li");
dropMarker.className = "drop-marker";
dropMarker.setAttribute("aria-hidden", "true");

const dropPreviewChildren = document.createElement("ol");
dropPreviewChildren.className = "children drop-preview-children";

applyZoom(currentZoom);
registerZoomShortcuts();
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
  tree.textContent = "";
  const state = currentState;
  if (!state) {
    stateCount.textContent = "Loading";
    return;
  }

  const nodes = Object.values(state.nodes);
  const closedCount = nodes.filter((node) => node.status === "closed").length;
  stateCount.textContent = `${nodes.length} items / ${closedCount} saved`;

  if (empty) {
    empty.hidden = nodes.length > 0;
  }

  for (const rootId of state.rootIds) {
    const root = state.nodes[rootId];
    if (root) {
      tree.append(renderNode(state, root, 0, false));
    }
  }
}

function renderNode(state: OutlineState, node: OutlineNode, depth: number, insideActiveWindow: boolean): HTMLElement {
  const isActiveWindow = node.kind === "window" && Boolean(node.active);
  const isActiveTab = node.kind === "tab" && Boolean(node.active) && insideActiveWindow;
  const item = document.createElement("li");
  item.className = `node node-${node.kind} is-${node.status}${isActiveWindow || isActiveTab ? " is-active" : ""}`;
  item.dataset.nodeId = node.id;

  const row = document.createElement("div");
  row.className = "node-row";
  row.draggable = true;
  row.style.setProperty("--depth", String(depth));
  row.addEventListener("dragstart", (event) => {
    draggedNodeId = node.id;
    event.dataTransfer?.setData("text/plain", node.id);
    event.dataTransfer?.setDragImage(row, 12, 12);
  });
  row.addEventListener("dragover", (event) => {
    const placement = dropPlacementForRowEvent(state, node.id, event.clientY, row);
    if (!placement) {
      clearDropPreview();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    showDropPlacement(placement);
  });
  row.addEventListener("drop", (event) => {
    const sourceId = draggedNodeId;
    const placement =
      sourceId &&
      activeDropPlacement?.kind === "node" &&
      activeDropPlacement.sourceId === sourceId &&
      activeDropPlacement.targetId === node.id
        ? activeDropPlacement
        : dropPlacementForRowEvent(state, node.id, event.clientY, row);
    if (!placement) {
      clearDragState();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    performDrop(placement);
  });
  row.addEventListener("dragend", () => {
    clearDragState();
  });

  const twisty = document.createElement("button");
  twisty.className = "icon-button twisty";
  twisty.type = "button";
  twisty.title = node.collapsed ? "Expand" : "Collapse";
  twisty.textContent = node.childIds.length ? (node.collapsed ? "+" : "-") : "";
  twisty.disabled = node.childIds.length === 0;
  twisty.addEventListener("click", (event) => {
    event.stopPropagation();
    void runAndRender({ type: "toggleCollapsed", nodeId: node.id });
  });
  row.append(twisty);

  const label = document.createElement("button");
  label.className = "node-label";
  label.type = "button";
  const titleText = node.title || "Untitled";
  label.title = node.url ?? titleText;
  label.ariaLabel = node.url ? `${titleText} - ${node.url}` : titleText;
  label.addEventListener("click", () => {
    if (node.status === "live") {
      void sendCommand({ type: "focusNode", nodeId: node.id });
    } else {
      void runAndRender({ type: "restoreNode", nodeId: node.id });
    }
  });

  const title = document.createElement("span");
  title.className = "node-title";
  title.textContent = titleText;
  label.append(title);

  row.append(label);

  row.append(actionButton(node.status === "live" ? "Close" : "Restore", () => {
    void runAndRender({
      type: node.status === "live" ? "closeNode" : "restoreNode",
      nodeId: node.id
    });
  }));

  row.append(actionButton("Delete", () => {
    void runAndRender({ type: "deleteNode", nodeId: node.id });
  }));

  item.append(row);

  if (!node.collapsed && node.childIds.length > 0) {
    const children = document.createElement("ol");
    children.className = "children";
    const childInsideActiveWindow = insideActiveWindow || isActiveWindow;
    for (const childId of node.childIds) {
      const child = state.nodes[childId];
      if (child) {
        children.append(renderNode(state, child, depth + 1, childInsideActiveWindow));
      }
    }
    item.append(children);
  }

  return item;
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

function actionButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "icon-button action";
  button.type = "button";
  button.title = label;
  button.textContent = label === "Delete" ? "x" : label[0] ?? "?";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
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
      if (!targetItem) {
        clearDropPreview();
        return;
      }

      if (placement.mode === "before") {
        targetItem.before(dropMarker);
      } else {
        targetItem.after(dropMarker);
      }
      return;
    }

    tree.append(dropMarker);
    return;
  }

  const targetItem = nodeItemForId(placement.targetId);
  const targetRow = targetItem ? rowForItem(targetItem) : undefined;
  if (!targetItem || !targetRow) {
    clearDropPreview();
    return;
  }

  const targetDepth = Number(targetRow.style.getPropertyValue("--depth")) || 0;
  const markerDepth = placement.mode === "inside" ? targetDepth + 1 : targetDepth;
  prepareDropMarker(`drop-${placement.mode}`, markerDepth);

  if (placement.mode === "before") {
    targetItem.before(dropMarker);
    return;
  }

  if (placement.mode === "after") {
    targetItem.after(dropMarker);
    return;
  }

  targetRow.classList.add("drop-inside-target");
  const children = childrenForItem(targetItem);
  if (children) {
    children.append(dropMarker);
    return;
  }

  dropPreviewChildren.append(dropMarker);
  targetRow.after(dropPreviewChildren);
}

function prepareDropMarker(className: string, depth: number): void {
  dropMarker.className = `drop-marker ${className}`;
  dropMarker.style.setProperty("--depth", String(depth));
}

function nodeItemForId(nodeId: NodeId): HTMLElement | undefined {
  if (!tree) {
    return undefined;
  }

  return Array.from(tree.querySelectorAll<HTMLElement>(".node")).find((item) => item.dataset.nodeId === nodeId);
}

function rowForItem(item: HTMLElement): HTMLElement | undefined {
  const firstChild = item.firstElementChild;
  return firstChild instanceof HTMLElement && firstChild.classList.contains("node-row") ? firstChild : undefined;
}

function childrenForItem(item: HTMLElement): HTMLOListElement | undefined {
  return Array.from(item.children).find(
    (child): child is HTMLOListElement => child instanceof HTMLOListElement && child.classList.contains("children")
  );
}

function performDrop(placement: DropPlacement): void {
  const command = commandForDropPlacement(placement);
  clearDragState();
  void runAndRender(command);
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
  dropPreviewChildren.remove();
  rootDropSurface?.classList.remove("root-drop-target");
  tree
    ?.querySelectorAll<HTMLElement>(".drop-inside-target")
    .forEach((element) => element.classList.remove("drop-inside-target"));
}

async function runAndRender(command: BackgroundCommand): Promise<void> {
  currentState = (await sendCommand(command)) as OutlineState;
  render();
  void loadDiagnostics();
}

async function sendCommand(command: BackgroundCommand): Promise<unknown> {
  return browser.runtime.sendMessage(command);
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

async function loadDiagnostics(): Promise<void> {
  if (!diagnostics) {
    return;
  }

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
