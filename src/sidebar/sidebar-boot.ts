import type { InitialTreeSnapshot } from "../background/storage.js";

declare global {
  interface Window {
    __tabsOutlinerBootSnapshot?: InitialTreeSnapshot;
  }
}

void bootSidebar();

async function bootSidebar(): Promise<void> {
  performance.mark("tabs-outliner.boot.start");
  const snapshot = await loadInitialSnapshot();
  if (snapshot) {
    window.__tabsOutlinerBootSnapshot = snapshot;
    renderInitialSnapshot(snapshot);
    performance.mark("tabs-outliner.boot.firstRows");
  }

  await afterPaint();
  await import("./sidebar.js");
}

async function loadInitialSnapshot(): Promise<InitialTreeSnapshot | undefined> {
  const response = await browser.runtime.sendMessage({ type: "getInitialTreeSnapshot" }).catch(() => undefined);
  return isInitialTreeSnapshot(response) ? response : undefined;
}

function renderInitialSnapshot(snapshot: InitialTreeSnapshot): void {
  const tree = document.querySelector<HTMLElement>("#tree");
  const stateCount = document.querySelector<HTMLSpanElement>("#state-count");
  const empty = document.querySelector<HTMLElement>("#empty");
  if (!tree) {
    return;
  }

  const rowHeight = currentRowHeight();
  tree.textContent = "";
  tree.style.height = `${snapshot.projection.rows.length * rowHeight}px`;
  const fragment = document.createDocumentFragment();
  for (const row of snapshot.projection.rows) {
    const node = snapshot.state.nodes[row.nodeId];
    if (!node) {
      continue;
    }
    fragment.append(renderBootRow(snapshot, row, rowHeight));
  }
  tree.append(fragment);

  if (stateCount) {
    stateCount.textContent = `${snapshot.projection.nodeCount} items / ${snapshot.projection.closedCount} saved`;
    stateCount.title = snapshot.hydrating ? "Loading full tree..." : "";
  }
  if (empty) {
    empty.hidden = snapshot.projection.rows.length > 0;
  }
}

function renderBootRow(
  snapshot: InitialTreeSnapshot,
  rowInfo: InitialTreeSnapshot["projection"]["rows"][number],
  rowHeight: number
): HTMLElement {
  const node = snapshot.state.nodes[rowInfo.nodeId]!;
  const isActiveWindow = node.kind === "window" && Boolean(node.active);
  const isActiveTab = node.kind === "tab" && Boolean(node.active) && rowInfo.insideActiveWindow;
  const item = document.createElement("li");
  item.className = `node node-${node.kind} is-${node.status}${isActiveWindow || isActiveTab ? " is-active" : ""}`;
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
  row.style.setProperty("--depth", String(rowInfo.depth));

  const twisty = document.createElement("button");
  twisty.className = "icon-button twisty";
  twisty.type = "button";
  twisty.textContent = rowInfo.childCount ? (node.collapsed ? "+" : "-") : "";
  twisty.disabled = true;
  row.append(twisty);

  const label = document.createElement("button");
  label.className = "node-label";
  label.type = "button";
  label.disabled = true;
  const titleText = node.title || "Untitled";
  label.title = node.url ?? titleText;
  label.ariaLabel = node.url ? `${titleText} - ${node.url}` : titleText;
  const title = document.createElement("span");
  title.className = "node-title";
  title.textContent = titleText;
  label.append(title);
  row.append(label);

  item.append(row);
  return item;
}

function currentRowHeight(): number {
  const value = window.getComputedStyle(document.documentElement).getPropertyValue("--node-row-height");
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 18;
}

function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

function isInitialTreeSnapshot(value: unknown): value is InitialTreeSnapshot {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { type?: unknown }).type === "initialTreeSnapshot" &&
      (value as { version?: unknown }).version === 1 &&
      typeof (value as { revision?: unknown }).revision === "number" &&
      typeof (value as { hydrating?: unknown }).hydrating === "boolean" &&
      isOutlineState((value as { state?: unknown }).state) &&
      (value as { projection?: unknown }).projection &&
      typeof (value as { projection?: unknown }).projection === "object" &&
      Array.isArray((value as { projection: { rows?: unknown } }).projection.rows) &&
      Array.isArray((value as { projection: { visibleNodeIds?: unknown } }).projection.visibleNodeIds) &&
      Array.isArray((value as { projection: { matchingNodeIds?: unknown } }).projection.matchingNodeIds)
  );
}

function isOutlineState(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { version?: unknown }).version === 1 &&
      Array.isArray((value as { rootIds?: unknown }).rootIds) &&
      (value as { nodes?: unknown }).nodes &&
      typeof (value as { nodes?: unknown }).nodes === "object"
  );
}
