import { describe, expect, it } from "vitest";

import {
  DEFAULT_HISTORY_LIMIT,
  applyOutlineDelta,
  createEmptyHistoryState,
  createHistoryEntry,
  historyStatus,
  normalizeHistoryState,
  pushRedoEntry,
  pushUndoEntry
} from "./history.js";
import {
  bootstrapFromWindows,
  deleteNode,
  flattenSubtreeOneLevel,
  moveNode,
  promoteChildrenOneLevel,
  renameGroup,
  wrapNodeInGroup
} from "../model/outline.js";
import type { NodeId, OutlineNode, OutlineState, RuntimeWindow } from "../model/types.js";

const runtimeWindows: RuntimeWindow[] = [
  {
    id: 10,
    focused: true,
    incognito: false,
    tabs: [
      {
        id: 1,
        windowId: 10,
        index: 0,
        active: true,
        url: "https://one.example/",
        title: "One"
      },
      {
        id: 2,
        windowId: 10,
        index: 1,
        active: false,
        url: "https://two.example/",
        title: "Two"
      }
    ]
  }
];

describe("outline history", () => {
  it("stores compact undo and redo deltas for node state edits", () => {
    const previous = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const next = renameGroup(previous, "window:10", "Research", { now: 2000 });

    const entry = createHistoryEntry("renameGroup", previous, next);

    expect(entry).toBeDefined();
    expect(entry?.undo.updatedNodes.map((node) => node.id)).toEqual(["window:10"]);
    expect(entry?.undo.deletedNodeIds).toEqual([]);
    expect(entry?.redo.updatedNodes.map((node) => node.id)).toEqual(["window:10"]);
    expect(entry?.redo.deletedNodeIds).toEqual([]);
    expect(applyOutlineDelta(next, entry!.undo).nodes["window:10"]?.title).toBe("Group");
    expect(applyOutlineDelta(previous, entry!.redo).nodes["window:10"]?.title).toBe("Research");
  });

  it("labels ancestor expansion history entries as Expand", () => {
    const previous = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const next = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    next.nodes["window:10"]!.collapsed = false;
    previous.nodes["window:10"]!.collapsed = true;

    const entry = createHistoryEntry("expandAncestors", previous, next);

    expect(entry?.label).toBe("Expand");
  });

  it("stores structural deltas without copying untouched nodes", () => {
    const previous = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const next = moveNode(previous, "tab:2", { parentId: "tab:1", index: 0 });

    const entry = createHistoryEntry("moveNode", previous, next);

    expect(entry).toBeDefined();
    expect(entry?.redo.updatedNodes.map((node) => node.id).sort()).toEqual(["tab:1", "tab:2", "window:10"]);
    expect(entry?.undo.updatedNodes.map((node) => node.id).sort()).toEqual(["tab:1", "tab:2", "window:10"]);
    expect(applyOutlineDelta(next, entry!.undo).nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:2"]);
    expect(applyOutlineDelta(previous, entry!.redo).nodes["tab:1"]?.childIds).toEqual(["tab:2"]);
  });

  it("stores deleted subtree nodes for undo without storing untouched siblings", () => {
    const previous = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const next = deleteNode(previous, "tab:2", { allowLive: true });

    const entry = createHistoryEntry("deleteNode", previous, next);

    expect(entry).toBeDefined();
    expect(entry?.undo.updatedNodes.map((node) => node.id).sort()).toEqual(["tab:2", "window:10"]);
    expect(entry?.undo.deletedNodeIds).toEqual([]);
    expect(entry?.redo.updatedNodes.map((node) => node.id)).toEqual(["window:10"]);
    expect(entry?.redo.deletedNodeIds).toEqual(["tab:2"]);
    expect(entry?.undo.updatedNodes.some((node) => node.id === "tab:1")).toBe(false);
    expect(applyOutlineDelta(next, entry!.undo).nodes["tab:2"]?.title).toBe("Two");
    expect(applyOutlineDelta(previous, entry!.redo).nodes["tab:2"]).toBeUndefined();
  });

  it("clears redo entries and keeps only the newest bounded undo entries", () => {
    let history = {
      ...createEmptyHistoryState(),
      redoStack: [
        createHistoryEntry("renameGroup", emptyState(), emptyStateWithWindowTitle("Redo"))!
      ]
    };

    for (let index = 0; index < DEFAULT_HISTORY_LIMIT + 3; index += 1) {
      history = pushUndoEntry(
        history,
        createHistoryEntry("renameGroup", emptyStateWithWindowTitle(`Before ${index}`), emptyStateWithWindowTitle(`After ${index}`))!
      );
    }

    expect(history.undoStack).toHaveLength(DEFAULT_HISTORY_LIMIT);
    expect(history.redoStack).toEqual([]);
    expect(history.undoStack[0]?.undo.updatedNodes[0]?.title).toBe("Before 3");
    expect(historyStatus(history)).toMatchObject({
      canUndo: true,
      canRedo: false,
      undoDepth: DEFAULT_HISTORY_LIMIT,
      redoDepth: 0
    });
  });

  it("uses caller-provided undo and redo limits when trimming history", () => {
    let history = createEmptyHistoryState();
    for (let index = 0; index < 5; index += 1) {
      history = pushUndoEntry(
        history,
        createHistoryEntry("renameGroup", emptyStateWithWindowTitle(`Before ${index}`), emptyStateWithWindowTitle(`After ${index}`))!,
        2
      );
    }

    let redoHistory = createEmptyHistoryState();
    for (let index = 0; index < 5; index += 1) {
      redoHistory = pushRedoEntry(
        redoHistory,
        createHistoryEntry("renameGroup", emptyStateWithWindowTitle(`Redo before ${index}`), emptyStateWithWindowTitle(`Redo after ${index}`))!,
        3
      );
    }

    expect(history.undoStack.map((entry) => entry.undo.updatedNodes[0]?.title)).toEqual(["Before 3", "Before 4"]);
    expect(redoHistory.redoStack.map((entry) => entry.undo.updatedNodes[0]?.title)).toEqual([
      "Redo before 2",
      "Redo before 3",
      "Redo before 4"
    ]);
  });

  it("normalizes persisted history with the active history limit", () => {
    let history = createEmptyHistoryState();
    for (let index = 0; index < 6; index += 1) {
      history = pushUndoEntry(
        history,
        createHistoryEntry("renameGroup", emptyStateWithWindowTitle(`Before ${index}`), emptyStateWithWindowTitle(`After ${index}`))!
      );
    }

    const normalized = normalizeHistoryState(history, 3);

    expect(normalized.undoStack.map((entry) => entry.undo.updatedNodes[0]?.title)).toEqual([
      "Before 3",
      "Before 4",
      "Before 5"
    ]);
  });

  it("round-trips undo and redo deltas across generated structural traces", () => {
    for (let seed = 1; seed <= 24; seed += 1) {
      runGeneratedHistoryTrace(seed, 18);
    }
  });
});

function runGeneratedHistoryTrace(seed: number, steps: number): void {
  let state = generatedHistoryState(seed);
  let now = seed * 1000;
  const rng = seededRandom(seed);
  const history = [`seed ${seed}`];

  for (let step = 0; step < steps; step += 1) {
    const operation = generatedHistoryOperation(state, rng, now);
    if (!operation) {
      break;
    }
    now += 1;
    history.push(`step ${step + 1}: ${operation.name}`);

    const entry = createHistoryEntry(operation.commandType, state, operation.next);
    expect(entry, history.join("\n")).toBeDefined();
    expect(applyOutlineDelta(state, entry!.redo), history.join("\n")).toEqual(operation.next);
    expect(applyOutlineDelta(operation.next, entry!.undo), history.join("\n")).toEqual(state);
    expectValidOutline(operation.next, history);

    state = operation.next;
  }
}

type GeneratedHistoryOperation = {
  name: string;
  commandType: Parameters<typeof createHistoryEntry>[0];
  next: OutlineState;
};

function generatedHistoryOperation(
  state: OutlineState,
  rng: () => number,
  now: number
): GeneratedHistoryOperation | undefined {
  const operationOrder = [0, 1, 2, 3, 4, 5]
    .map((operation) => ({ operation, sort: rng() }))
    .sort((left, right) => left.sort - right.sort)
    .map((entry) => entry.operation);

  for (const operation of operationOrder) {
    const result =
      operation === 0 ? generatedMoveOperation(state, rng, now) :
      operation === 1 ? generatedWrapOperation(state, rng, now) :
      operation === 2 ? generatedFlattenOperation(state, rng) :
      operation === 3 ? generatedPromoteOperation(state, rng) :
      operation === 4 ? generatedRenameOperation(state, rng, now) :
      generatedDeleteOperation(state, rng);
    if (result && result.next !== state) {
      return result;
    }
  }

  return undefined;
}

function generatedMoveOperation(state: OutlineState, rng: () => number, now: number): GeneratedHistoryOperation | undefined {
  const nodeId = pickOne(rng, movableNodeIds(state));
  if (!nodeId) {
    return undefined;
  }
  const parentId = pickOne(rng, validMoveParentIds(state, nodeId));
  const siblingCount = parentId ? state.nodes[parentId]?.childIds.length ?? 0 : state.rootIds.length;
  const next = moveNode(state, nodeId, {
    ...(parentId ? { parentId } : {}),
    index: Math.floor(rng() * (siblingCount + 1)),
    now
  });
  return {
    name: `move ${nodeId} under ${parentId ?? "root"}`,
    commandType: "moveNode",
    next
  };
}

function generatedWrapOperation(state: OutlineState, rng: () => number, now: number): GeneratedHistoryOperation | undefined {
  const nodeId = pickOne(rng, movableNodeIds(state));
  if (!nodeId) {
    return undefined;
  }
  return {
    name: `wrap ${nodeId}`,
    commandType: "wrapNodeInGroup",
    next: wrapNodeInGroup(state, nodeId, { now })
  };
}

function generatedFlattenOperation(state: OutlineState, rng: () => number): GeneratedHistoryOperation | undefined {
  const nodeId = pickOne(
    rng,
    Object.values(state.nodes)
      .filter((node) => node.childIds.some((childId) => (state.nodes[childId]?.childIds.length ?? 0) > 0))
      .map((node) => node.id)
  );
  return nodeId
    ? { name: `flatten ${nodeId}`, commandType: "flattenSubtree", next: flattenSubtreeOneLevel(state, nodeId) }
    : undefined;
}

function generatedPromoteOperation(state: OutlineState, rng: () => number): GeneratedHistoryOperation | undefined {
  const nodeId = pickOne(
    rng,
    Object.values(state.nodes)
      .filter((node) => node.parentId && node.childIds.length > 0 && !(node.kind === "window" && node.status === "live"))
      .map((node) => node.id)
  );
  return nodeId
    ? { name: `promote ${nodeId}`, commandType: "promoteChildren", next: promoteChildrenOneLevel(state, nodeId) }
    : undefined;
}

function generatedRenameOperation(state: OutlineState, rng: () => number, now: number): GeneratedHistoryOperation | undefined {
  const nodeId = pickOne(
    rng,
    Object.values(state.nodes)
      .filter((node) => node.kind === "window" || node.kind === "group")
      .map((node) => node.id)
  );
  return nodeId
    ? { name: `rename ${nodeId}`, commandType: "renameGroup", next: renameGroup(state, nodeId, `Generated ${now}`, { now }) }
    : undefined;
}

function generatedDeleteOperation(state: OutlineState, rng: () => number): GeneratedHistoryOperation | undefined {
  const nodeId = pickOne(rng, movableNodeIds(state));
  return nodeId
    ? { name: `delete ${nodeId}`, commandType: "deleteNode", next: deleteNode(state, nodeId) }
    : undefined;
}

function generatedHistoryState(seed: number): OutlineState {
  const now = seed * 1000;
  return {
    version: 1,
    rootIds: ["window:root"],
    nodes: {
      "window:root": closedWindow("window:root", ["tab:a", "tab:b", "group:g"], now),
      "tab:a": closedTab("tab:a", "window:root", ["tab:a1", "tab:a2"], now),
      "tab:a1": closedTab("tab:a1", "tab:a", [], now),
      "tab:a2": closedTab("tab:a2", "tab:a", ["tab:a2i"], now),
      "tab:a2i": closedTab("tab:a2i", "tab:a2", [], now),
      "tab:b": closedTab("tab:b", "window:root", ["tab:b1"], now),
      "tab:b1": closedTab("tab:b1", "tab:b", [], now),
      "group:g": neutralGroup("group:g", "window:root", ["tab:g1"]),
      "tab:g1": closedTab("tab:g1", "group:g", [`tab:seed:${seed}`], now),
      [`tab:seed:${seed}`]: closedTab(`tab:seed:${seed}`, "tab:g1", [], now)
    }
  };
}

function closedWindow(id: NodeId, childIds: NodeId[], now: number, parentId?: NodeId): OutlineNode {
  return {
    id,
    kind: "window",
    status: "closed",
    ...(parentId ? { parentId } : {}),
    childIds,
    title: "Group",
    collapsed: false,
    createdAt: now,
    updatedAt: now,
    closedAt: now
  };
}

function closedTab(id: NodeId, parentId: NodeId, childIds: NodeId[], now: number): OutlineNode {
  return {
    id,
    kind: "tab",
    status: "closed",
    parentId,
    childIds,
    title: id,
    url: `https://history.example/${id}`,
    collapsed: false,
    createdAt: now,
    updatedAt: now,
    closedAt: now,
    restore: {
      url: `https://history.example/${id}`,
      title: id
    }
  };
}

function neutralGroup(id: NodeId, parentId: NodeId, childIds: NodeId[]): OutlineNode {
  return {
    id,
    kind: "group",
    status: "neutral",
    parentId,
    childIds,
    title: "Group",
    collapsed: false,
    createdAt: 1,
    updatedAt: 1
  };
}

function movableNodeIds(state: OutlineState): NodeId[] {
  return Object.values(state.nodes)
    .filter((node) => Boolean(node.parentId))
    .map((node) => node.id);
}

function validMoveParentIds(state: OutlineState, nodeId: NodeId): NodeId[] {
  return Object.values(state.nodes)
    .filter((node) => node.id !== nodeId && !isDescendantForTest(state, node.id, nodeId))
    .map((node) => node.id);
}

function isDescendantForTest(state: OutlineState, candidateId: NodeId, ancestorId: NodeId): boolean {
  let current = state.nodes[candidateId];
  const visited = new Set<NodeId>();
  while (current?.parentId && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.parentId === ancestorId) {
      return true;
    }
    current = state.nodes[current.parentId];
  }
  return false;
}

function expectValidOutline(state: OutlineState, history: string[]): void {
  expect(new Set(state.rootIds).size, history.join("\n")).toBe(state.rootIds.length);
  expect(reachableNodeIdsForHistory(state), history.join("\n")).toEqual(Object.keys(state.nodes).sort());
  for (const rootId of state.rootIds) {
    expect(state.nodes[rootId], history.join("\n")).toBeDefined();
    expect(state.nodes[rootId]?.parentId, history.join("\n")).toBeUndefined();
  }
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    expect(new Set(node.childIds).size, history.join("\n")).toBe(node.childIds.length);
    for (const childId of node.childIds) {
      expect(state.nodes[childId], history.join("\n")).toBeDefined();
      expect(state.nodes[childId]?.parentId, history.join("\n")).toBe(nodeId);
    }
  }
}

function reachableNodeIdsForHistory(state: OutlineState): NodeId[] {
  const ids: NodeId[] = [];
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
    ids.push(node.id);
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push(node.childIds[index]!);
    }
  }
  return ids.sort();
}

function pickOne<T>(rng: () => number, values: readonly T[]): T | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values[Math.floor(rng() * values.length) % values.length];
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function emptyState(): OutlineState {
  return {
    version: 1,
    rootIds: [],
    nodes: {}
  };
}

function emptyStateWithWindowTitle(title: string): OutlineState {
  return {
    version: 1,
    rootIds: ["window:10"],
    nodes: {
      "window:10": {
        id: "window:10",
        kind: "window",
        status: "closed",
        childIds: [],
        title,
        collapsed: false,
        createdAt: 1000,
        updatedAt: 1000,
        closedAt: 1000
      }
    }
  };
}
