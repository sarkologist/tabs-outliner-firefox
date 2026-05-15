import type { BackgroundCommand } from "../background/commands.js";
import type { OutlineDiagnostics } from "../background/diagnostics.js";
import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";

const stateCount = document.querySelector<HTMLSpanElement>("#state-count");
const diagnostics = document.querySelector<HTMLSpanElement>("#diagnostics");
const refresh = document.querySelector<HTMLButtonElement>("#refresh");
const tree = document.querySelector<HTMLElement>("#tree");
const empty = document.querySelector<HTMLElement>("#empty");

let currentState: OutlineState | undefined;
let draggedNodeId: NodeId | undefined;

void loadState();

refresh?.addEventListener("click", () => {
  void runAndRender({ type: "refresh" });
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

function render(): void {
  if (!tree || !stateCount) {
    return;
  }

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
      tree.append(renderNode(state, root, 0));
    }
  }
}

function renderNode(state: OutlineState, node: OutlineNode, depth: number): HTMLElement {
  const item = document.createElement("li");
  item.className = `node node-${node.kind} is-${node.status}`;
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
    event.preventDefault();
    row.classList.add("drop-target");
  });
  row.addEventListener("dragleave", () => {
    row.classList.remove("drop-target");
  });
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    row.classList.remove("drop-target");
    const sourceId = draggedNodeId ?? event.dataTransfer?.getData("text/plain");
    draggedNodeId = undefined;
    if (sourceId && sourceId !== node.id) {
      void sendCommand(moveCommandForDrop(state, sourceId, node, event.clientY, row)).then((next) => {
        currentState = next as OutlineState;
        render();
      });
    }
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
    for (const childId of node.childIds) {
      const child = state.nodes[childId];
      if (child) {
        children.append(renderNode(state, child, depth + 1));
      }
    }
    item.append(children);
  }

  return item;
}

function moveCommandForDrop(
  state: OutlineState,
  sourceId: NodeId,
  target: OutlineNode,
  clientY: number,
  row: HTMLElement
): BackgroundCommand {
  const rect = row.getBoundingClientRect();
  const relativeY = clientY - rect.top;
  const mode = relativeY < rect.height / 3 ? "before" : relativeY > (rect.height * 2) / 3 ? "after" : "inside";

  if (mode === "inside") {
    return {
      type: "moveNode",
      nodeId: sourceId,
      parentId: target.id,
      index: target.childIds.length
    };
  }

  const siblings = target.parentId ? state.nodes[target.parentId]?.childIds ?? [] : state.rootIds;
  const targetIndex = siblings.indexOf(target.id);
  return {
    type: "moveNode",
    nodeId: sourceId,
    ...(target.parentId ? { parentId: target.parentId } : {}),
    index: Math.max(0, targetIndex + (mode === "after" ? 1 : 0))
  };
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
