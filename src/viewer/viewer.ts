import {
  PORTABLE_TREE_SCHEMA,
  parsePortableImport,
  type PortableTreeNode
} from "../model/portable-tree.js";

// Read-only viewer for an exported Tab Session Outliner tree (the portable-tree format, or a
// legacy Chrome Tab Outliner export). It renders the export with the SAME look as the live
// outline (it reuses sidebar.css and the same node-row markup), and the only action on a node is
// "Import": appending that node together with its entire subtree to the live outline as new
// top-level node(s). The exported tree is never mutated by the viewer.
//
// This is a separate extension page (opened in its own popup window from the sidebar overflow
// menu). It imports only from the pure model layer and talks to the background solely through
// runtime messages, so it stays a leaf UI surface (see I-16 boundary lint).

const SVG_NS = "http://www.w3.org/2000/svg";

const fileInput = document.querySelector<HTMLInputElement>("#viewer-file");
const loadButton = document.querySelector<HTMLButtonElement>("#viewer-load");
const treeContainer = document.querySelector<HTMLOListElement>("#viewer-tree");
const statusLine = document.querySelector<HTMLElement>("#viewer-status");
const emptyState = document.querySelector<HTMLElement>("#viewer-empty");

// Portable nodes carry no id or collapse state, so the viewer wraps them: a stable path id (for
// selectors/debugging), the depth (for the same indentation the sidebar uses), and per-node
// collapse state. Mirrors the main tree, which is a flat list of visible rows indented by depth.
type ViewerNode = {
  node: PortableTreeNode;
  id: string;
  depth: number;
  children: ViewerNode[];
  collapsed: boolean;
};

let roots: ViewerNode[] = [];

registerEvents();
renderTree();

function registerEvents(): void {
  loadButton?.addEventListener("click", () => {
    fileInput?.click();
  });
  fileInput?.addEventListener("change", () => {
    void loadSelectedFile();
  });
}

async function loadSelectedFile(): Promise<void> {
  const file = fileInput?.files?.[0];
  if (!file) {
    return;
  }

  try {
    const payload = JSON.parse(await file.text()) as unknown;
    roots = buildViewerNodes(parsePortableImport(payload));
    renderTree();
    setStatus(
      roots.length > 0
        ? `Loaded ${file.name} — ${roots.length} top-level node${roots.length === 1 ? "" : "s"}`
        : `Loaded ${file.name} — no importable nodes`
    );
  } catch (error) {
    roots = [];
    renderTree();
    setStatus(loadErrorText(error), true);
  } finally {
    // Allow re-selecting the same file (a no-op "change" otherwise).
    if (fileInput) {
      fileInput.value = "";
    }
  }
}

function buildViewerNodes(portableRoots: PortableTreeNode[]): ViewerNode[] {
  const build = (node: PortableTreeNode, id: string, depth: number): ViewerNode => ({
    node,
    id,
    depth,
    collapsed: false,
    children: node.children.map((child, index) => build(child, `${id}.${index}`, depth + 1))
  });
  return portableRoots.map((node, index) => build(node, String(index), 0));
}

// The rows visible right now: a depth-first walk that skips the descendants of collapsed nodes,
// exactly like the sidebar's visible-tree projection.
function visibleRows(): ViewerNode[] {
  const rows: ViewerNode[] = [];
  const walk = (viewerNode: ViewerNode): void => {
    rows.push(viewerNode);
    if (!viewerNode.collapsed) {
      viewerNode.children.forEach(walk);
    }
  };
  roots.forEach(walk);
  return rows;
}

function renderTree(): void {
  if (treeContainer) {
    treeContainer.replaceChildren(...visibleRows().map(renderRow));
  }
  if (emptyState) {
    emptyState.hidden = roots.length > 0;
  }
}

function renderRow(viewerNode: ViewerNode): HTMLLIElement {
  const node = viewerNode.node;
  const label = nodeLabel(node);
  const hasChildren = viewerNode.children.length > 0;

  // is-closed because an export is saved (not live) content — the same dimmed styling the live
  // outline gives closed nodes.
  const item = document.createElement("li");
  item.className = `node node-${node.kind} is-closed`;
  item.dataset.viewerNodeId = viewerNode.id;
  item.setAttribute("role", "treeitem");
  item.setAttribute("aria-level", String(viewerNode.depth + 1));
  if (hasChildren) {
    item.setAttribute("aria-expanded", String(!viewerNode.collapsed));
  }

  const row = document.createElement("div");
  row.className = "node-row";
  row.style.setProperty("--depth", String(viewerNode.depth));

  // Twisty chevron (disabled placeholder for leaves, exactly like the sidebar — keeps alignment).
  const twisty = document.createElement("button");
  twisty.className = "icon-button twisty";
  twisty.type = "button";
  twisty.disabled = !hasChildren;
  if (hasChildren) {
    twisty.title = viewerNode.collapsed ? "Expand" : "Collapse";
    twisty.setAttribute("aria-label", `${viewerNode.collapsed ? "Expand" : "Collapse"} ${label}`);
    twisty.append(iconElement(viewerNode.collapsed ? "chevron-right" : "chevron-down"));
    twisty.addEventListener("click", () => {
      viewerNode.collapsed = !viewerNode.collapsed;
      renderTree();
    });
  }
  row.append(twisty);

  // Read-only label: a plain span (not an interactive control) so the only action is Import.
  const labelElement = document.createElement("span");
  labelElement.className = "node-label";
  labelElement.title = node.url ? `${label} — ${node.url}` : label;
  const title = document.createElement("span");
  title.className = "node-title";
  title.textContent = label;
  labelElement.append(title);
  row.append(labelElement);

  // The single available action — Import — uses the same hover-revealed node-actions affordance
  // and icon-button styling as the live outline's row actions.
  const actions = document.createElement("span");
  actions.className = "node-actions";
  const importButton = document.createElement("button");
  importButton.className = "icon-button action";
  importButton.type = "button";
  importButton.dataset.testid = "viewer-import";
  importButton.title = "Import to top level";
  importButton.setAttribute("aria-label", `Import ${label} to top level`);
  importButton.append(iconElement("import"));
  importButton.addEventListener("click", () => {
    void importNode(node, label, importButton);
  });
  actions.append(importButton);
  row.append(actions);

  item.append(row);
  return item;
}

function iconElement(name: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("button-icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#icon-${name}`);
  svg.append(use);
  return svg;
}

async function importNode(node: PortableTreeNode, label: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    await browser.runtime.sendMessage({
      type: "importSubtreeToTopLevel",
      tree: {
        schema: PORTABLE_TREE_SCHEMA,
        version: 1,
        // exportedAt is required by the parser but never read after import (node timestamps
        // come from the background clock); stamp the moment of import.
        exportedAt: new Date().toISOString(),
        roots: [node]
      }
    });
    setStatus(`Imported ${label} to your outline`);
  } catch {
    setStatus(importErrorText(), true);
  } finally {
    button.disabled = false;
  }
}

function nodeLabel(node: PortableTreeNode): string {
  return node.title.trim() || node.url || "Untitled";
}

function setStatus(message: string, isError = false): void {
  if (!statusLine) {
    return;
  }
  statusLine.textContent = message;
  statusLine.classList.toggle("is-error", isError);
}

function loadErrorText(error: unknown): string {
  if (error instanceof SyntaxError) {
    return "Could not load file: invalid JSON";
  }
  // Both the portable parser ("Invalid portable tree: …") and the legacy Chrome Tab Outliner
  // parser ("Invalid Chrome Tab Outliner tree: …") signal a recognized-but-malformed file.
  if (
    error instanceof Error &&
    (error.message.startsWith("Invalid portable tree") ||
      error.message.startsWith("Invalid Chrome Tab Outliner tree"))
  ) {
    return "Could not load file: not a Tab Session Outliner export";
  }
  return "Could not load file";
}

function importErrorText(): string {
  // The reject reason from a background sendMessage is an internal string, not a vetted user
  // message; keep the surfaced text generic and stable (mirrors loadErrorText's friendly mapping).
  return "Import failed";
}
