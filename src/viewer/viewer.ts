import {
  PORTABLE_TREE_SCHEMA,
  parsePortableImport,
  type PortableTreeNode
} from "../model/portable-tree.js";

// Read-only viewer for an exported Tab Session Outliner tree (the portable-tree format, or a
// legacy Chrome Tab Outliner export). It renders a navigable nested outline whose only actions
// are expand/collapse and "Import": appending a node together with its entire subtree to the
// live outline as new top-level node(s). The exported tree is never mutated by the viewer.
//
// This is a separate extension page (opened in its own popup window via the options page), not
// part of the sidebar. It imports only from the pure model layer and talks to the background
// solely through runtime messages, so it stays a leaf UI surface (see I-16 boundary lint).

const fileInput = document.querySelector<HTMLInputElement>("#viewer-file");
const loadButton = document.querySelector<HTMLButtonElement>("#viewer-load");
const treeContainer = document.querySelector<HTMLUListElement>("#viewer-tree");
const statusLine = document.querySelector<HTMLElement>("#viewer-status");
const emptyState = document.querySelector<HTMLElement>("#viewer-empty");

// exportedAt is required by the portable-tree parser when an import is sent back to the
// background. We keep the loaded file's value when present so re-imports round-trip faithfully,
// and otherwise stamp the moment the file was opened.
let loadedExportedAt = new Date().toISOString();

registerEvents();
renderRoots([]);

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
    loadedExportedAt = exportedAtFromPayload(payload);
    const roots = parsePortableImport(payload);
    renderRoots(roots);
    setStatus(
      roots.length > 0
        ? `Loaded ${file.name} — ${roots.length} top-level node${roots.length === 1 ? "" : "s"}`
        : `Loaded ${file.name} — no importable nodes`
    );
  } catch (error) {
    renderRoots([]);
    setStatus(loadErrorText(error), true);
  } finally {
    // Allow re-selecting the same file (a no-op "change" otherwise).
    if (fileInput) {
      fileInput.value = "";
    }
  }
}

function renderRoots(roots: PortableTreeNode[]): void {
  if (!treeContainer) {
    return;
  }
  treeContainer.replaceChildren(...roots.map((root) => renderNode(root)));
  if (emptyState) {
    emptyState.hidden = roots.length > 0;
  }
}

function renderNode(node: PortableTreeNode): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "viewer-node";
  item.setAttribute("role", "treeitem");

  const row = document.createElement("div");
  row.className = "viewer-row";

  const label = nodeLabel(node);
  const hasChildren = node.children.length > 0;
  if (hasChildren) {
    item.setAttribute("aria-expanded", "false");
    row.append(createTwisty(item, node, label));
  } else {
    const spacer = document.createElement("span");
    spacer.className = "viewer-twisty-spacer";
    spacer.setAttribute("aria-hidden", "true");
    row.append(spacer);
  }

  const title = document.createElement("span");
  title.className = "viewer-title";
  title.textContent = label;
  row.append(title);

  if (node.url) {
    const url = document.createElement("span");
    url.className = "viewer-url";
    url.textContent = node.url;
    row.append(url);
  }

  row.append(createImportButton(node, label));
  item.append(row);
  return item;
}

function createTwisty(item: HTMLLIElement, node: PortableTreeNode, label: string): HTMLButtonElement {
  const twisty = document.createElement("button");
  twisty.type = "button";
  twisty.className = "viewer-twisty";
  twisty.setAttribute("aria-label", `Expand ${label}`);

  let childGroup: HTMLUListElement | undefined;
  twisty.addEventListener("click", () => {
    const expanded = item.getAttribute("aria-expanded") === "true";
    if (expanded) {
      item.setAttribute("aria-expanded", "false");
      twisty.setAttribute("aria-label", `Expand ${label}`);
      if (childGroup) {
        childGroup.hidden = true;
      }
      return;
    }

    // Children are rendered lazily on first expand so a large export does not build its whole
    // DOM up front; collapsing keeps the rendered children and just hides them.
    if (!childGroup) {
      childGroup = document.createElement("ul");
      childGroup.className = "viewer-group";
      childGroup.setAttribute("role", "group");
      childGroup.append(...node.children.map((child) => renderNode(child)));
      item.append(childGroup);
    }
    childGroup.hidden = false;
    item.setAttribute("aria-expanded", "true");
    twisty.setAttribute("aria-label", `Collapse ${label}`);
  });

  return twisty;
}

function createImportButton(node: PortableTreeNode, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "viewer-import";
  button.dataset.testid = "viewer-import";
  button.textContent = "Import";
  button.setAttribute("aria-label", `Import ${label} to top level`);
  button.addEventListener("click", () => {
    void importNode(node, label, button);
  });
  return button;
}

async function importNode(node: PortableTreeNode, label: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    await browser.runtime.sendMessage({
      type: "importSubtreeToTopLevel",
      tree: {
        schema: PORTABLE_TREE_SCHEMA,
        version: 1,
        exportedAt: loadedExportedAt,
        roots: [node]
      }
    });
    setStatus(`Imported ${label} to your outline`);
  } catch (error) {
    setStatus(importErrorText(error), true);
  } finally {
    button.disabled = false;
  }
}

function nodeLabel(node: PortableTreeNode): string {
  return node.title.trim() || node.url || "Untitled";
}

function exportedAtFromPayload(payload: unknown): string {
  if (
    payload &&
    typeof payload === "object" &&
    typeof (payload as { exportedAt?: unknown }).exportedAt === "string"
  ) {
    return (payload as { exportedAt: string }).exportedAt;
  }
  return new Date().toISOString();
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
  if (error instanceof Error && error.message.startsWith("Invalid portable tree")) {
    return "Could not load file: not a Tab Session Outliner export";
  }
  return "Could not load file";
}

function importErrorText(error: unknown): string {
  return error instanceof Error && error.message
    ? `Import failed: ${error.message}`
    : "Import failed";
}
