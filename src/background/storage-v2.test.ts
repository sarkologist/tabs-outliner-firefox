import { describe, expect, it, vi } from "vitest";

import {
  INITIAL_TREE_SNAPSHOT_ROW_LIMIT,
  HISTORY_KEY,
  STATE_KEY,
  STATE_V2_MANIFEST_KEY,
  STATE_V3_MANIFEST_KEY,
  loadInitialTreeSnapshot,
  loadState,
  loadStateWithMetadata,
  loadStateV2,
  loadStateV3,
  initialTreeSnapshotForState,
  outlineStateV2Items,
  outlineStateV3Changes,
  saveState,
  saveStateAndHistory
} from "./storage.js";
import { reconcileWithWindows } from "../model/outline.js";
import type { OutlineNode, OutlineState } from "../model/types.js";
import { makeSidebarStartupState } from "../perf/sidebar-startup-shapes.js";
import { generatedTraceConfig, generatedTraceTimeoutMs } from "../test/generated-traces.test-support.js";

function makeLargeState(tabCount: number, options: { activeTabIndex?: number } = {}): OutlineState {
  const activeTabIndex = options.activeTabIndex ?? 0;
  const windowNode: OutlineNode = {
    id: "window:10",
    kind: "window",
    status: "live",
    childIds: Array.from({ length: tabCount }, (_value, index) => `tab:${index + 1}`),
    title: "Group",
    active: true,
    collapsed: false,
    createdAt: 1000,
    updatedAt: 1000,
    live: { windowId: 10 }
  };
  const nodes: OutlineState["nodes"] = {
    [windowNode.id]: windowNode
  };
  for (let index = 0; index < tabCount; index += 1) {
    const id = index + 1;
    nodes[`tab:${id}`] = {
      id: `tab:${id}`,
      kind: "tab",
      status: "live",
      parentId: "window:10",
      childIds: [],
      title: `Tab ${id}`,
      url: `https://example.test/${id}`,
      active: index === activeTabIndex,
      collapsed: false,
      createdAt: 1000,
      updatedAt: 1000,
      live: { tabId: id, windowId: 10 }
    };
  }
  return {
    version: 1,
    rootIds: ["window:10"],
    nodes
  };
}

function fakeApi(items: Record<string, unknown> = {}): WebExtensionBrowser {
  const storage = new Map(Object.entries(items));
  return {
    storage: {
      local: {
        get: vi.fn(async (key?: string | string[] | Record<string, unknown> | null) => {
          if (typeof key === "string") {
            return { [key]: storage.get(key) };
          }
          if (Array.isArray(key)) {
            return Object.fromEntries(key.map((entry) => [entry, storage.get(entry)]));
          }
          return Object.fromEntries(storage);
        }),
        set: vi.fn(async (next: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(next)) {
            storage.set(key, value);
          }
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            storage.delete(key);
          }
        }),
        onChanged: { addListener: vi.fn() }
      }
    }
  } as never;
}

function moveLastTabToFront(state: OutlineState): OutlineState {
  const windowNode = state.nodes["window:10"]!;
  const movedId = windowNode.childIds.at(-1)!;
  return {
    version: state.version,
    rootIds: state.rootIds,
    nodes: {
      ...state.nodes,
      "window:10": {
        ...windowNode,
        childIds: [movedId, ...windowNode.childIds.slice(0, -1)]
      }
    }
  };
}

function removeLastOrderPage(state: OutlineState): OutlineState {
  const windowNode = state.nodes["window:10"]!;
  const removedChildIds = windowNode.childIds.slice(-100);
  const nodes = { ...state.nodes };
  for (const nodeId of removedChildIds) {
    delete nodes[nodeId];
  }
  return {
    version: state.version,
    rootIds: state.rootIds,
    nodes: {
      ...nodes,
      "window:10": {
        ...windowNode,
        childIds: windowNode.childIds.slice(0, -100)
      }
    }
  };
}

describe("outline state v2 storage", () => {
  it("writes a small manifest snapshot plus chunked node and order pages", () => {
    const state = makeLargeState(INITIAL_TREE_SNAPSHOT_ROW_LIMIT + 20);
    const items = outlineStateV2Items(state, { revision: 123 });
    const manifest = items[STATE_V2_MANIFEST_KEY] as
      | {
          revision?: number;
          nodeCount?: number;
          initialSnapshot?: { state?: OutlineState; projection?: { rows?: unknown[]; nodeCount?: number } };
          nodeChunkKeys?: string[];
          orderPageKeys?: string[];
        }
      | undefined;

    expect(manifest?.revision).toBe(123);
    expect(manifest?.nodeCount).toBe(INITIAL_TREE_SNAPSHOT_ROW_LIMIT + 21);
    expect(manifest?.initialSnapshot?.projection?.rows).toHaveLength(INITIAL_TREE_SNAPSHOT_ROW_LIMIT);
    expect(Object.keys(manifest?.initialSnapshot?.state?.nodes ?? {})).toHaveLength(INITIAL_TREE_SNAPSHOT_ROW_LIMIT);
    expect(manifest?.initialSnapshot?.projection?.nodeCount).toBe(INITIAL_TREE_SNAPSHOT_ROW_LIMIT + 21);
    expect(manifest?.initialSnapshot?.projection?.totalRowCount).toBe(INITIAL_TREE_SNAPSHOT_ROW_LIMIT + 21);
    expect(manifest?.nodeChunkKeys?.length).toBeGreaterThan(0);
    expect(manifest?.orderPageKeys?.length).toBeGreaterThan(0);
    expect(JSON.stringify(manifest?.initialSnapshot)).not.toContain("tab:260");
  });

  it("centers the initial tree snapshot on the active tab when it is outside the first page", () => {
    const state = makeLargeState(800, { activeTabIndex: 799 });
    const items = outlineStateV2Items(state, { revision: 654 });
    const manifest = items[STATE_V2_MANIFEST_KEY] as
      | {
          initialSnapshot?: {
            state?: OutlineState;
            projection?: {
              rows?: Array<{ nodeId?: string; index?: number }>;
              activeTabNodeId?: string;
              activeTabRowIndex?: number;
              totalRowCount?: number;
            };
          };
        }
      | undefined;

    expect(manifest?.initialSnapshot?.projection?.activeTabNodeId).toBe("tab:800");
    expect(manifest?.initialSnapshot?.projection?.activeTabRowIndex).toBe(800);
    expect(manifest?.initialSnapshot?.projection?.rows).toHaveLength(INITIAL_TREE_SNAPSHOT_ROW_LIMIT);
    expect(manifest?.initialSnapshot?.projection?.rows?.some((row) => row.nodeId === "tab:800")).toBe(true);
    expect(manifest?.initialSnapshot?.projection?.rows?.[0]?.index).toBeGreaterThan(0);
    expect(manifest?.initialSnapshot?.projection?.totalRowCount).toBe(801);
    expect(manifest?.initialSnapshot?.state?.nodes["tab:800"]).toBeDefined();
  });

  it("can build an initial tree snapshot centered on an arbitrary visible row", () => {
    const state = makeLargeState(1200, { activeTabIndex: 1199 });
    const snapshot = initialTreeSnapshotForState(state, {
      revision: 777,
      centerRowIndex: 300,
      hydrating: true
    });

    expect(snapshot.revision).toBe(777);
    expect(snapshot.projection.activeTabNodeId).toBe("tab:1200");
    expect(snapshot.projection.activeTabRowIndex).toBe(1200);
    expect(snapshot.projection.rows).toHaveLength(INITIAL_TREE_SNAPSHOT_ROW_LIMIT);
    expect(snapshot.projection.rows.some((row) => row.index === 300)).toBe(true);
    expect(snapshot.projection.rows.some((row) => row.nodeId === "tab:1200")).toBe(false);
    expect(Object.keys(snapshot.state.nodes)).toHaveLength(INITIAL_TREE_SNAPSHOT_ROW_LIMIT);
  });

  it("marks projection slice coverage for editable rows and complete loaded subtrees", () => {
    const state = makeLargeState(20, { activeTabIndex: 10 });
    const snapshot = initialTreeSnapshotForState(state, {
      rowLimit: 8,
      centerRowIndex: 10,
      hydrating: true
    });
    const rowNodeIds = snapshot.projection.rows.map((row) => row.nodeId);

    expect(snapshot.coverage).toBeDefined();
    expect(snapshot.coverage?.startRowIndex).toBe(snapshot.projection.rows[0]?.index);
    expect(snapshot.coverage?.endRowIndex).toBe((snapshot.projection.rows.at(-1)?.index ?? 0) + 1);
    expect(snapshot.coverage?.editableNodeIds).toEqual(rowNodeIds);
    expect(snapshot.coverage?.completeSubtreeNodeIds).toEqual(
      rowNodeIds.filter((nodeId) => state.nodes[nodeId]?.kind === "tab")
    );
    expect(snapshot.coverage?.completeSiblingParentIds).not.toContain("window:10");
  });

  it("skips outliner sidebar pages when choosing the initial snapshot active-scroll target", () => {
    const state = makeLargeState(10);
    state.nodes["tab:1"] = {
      ...state.nodes["tab:1"]!,
      active: true,
      url: "moz-extension://extension-id/sidebar/sidebar.html"
    };
    state.nodes["tab:2"] = {
      ...state.nodes["tab:2"]!,
      active: true
    };
    const items = outlineStateV2Items(state, { revision: 654 });
    const manifest = items[STATE_V2_MANIFEST_KEY] as
      | {
          initialSnapshot?: {
            projection?: {
              rows?: Array<{ nodeId?: string; index?: number }>;
              activeTabNodeId?: string;
              activeTabRowIndex?: number;
            };
          };
        }
      | undefined;

    expect(manifest?.initialSnapshot?.projection?.rows?.some((row) => row.nodeId === "tab:1")).toBe(true);
    expect(manifest?.initialSnapshot?.projection?.activeTabNodeId).toBe("tab:2");
    expect(manifest?.initialSnapshot?.projection?.activeTabRowIndex).toBe(2);
  });

  it("loads the initial tree snapshot by reading only manifest keys", async () => {
    const state = makeLargeState(800);
    const items = outlineStateV2Items(state, { revision: 456 });
    const api = fakeApi(items);

    const snapshot = await loadInitialTreeSnapshot(api);

    expect(snapshot?.revision).toBe(456);
    expect(snapshot?.projection.rows).toHaveLength(INITIAL_TREE_SNAPSHOT_ROW_LIMIT);
    expect(snapshot?.projection.nodeCount).toBe(801);
    expect(Object.keys(snapshot?.state.nodes ?? {})).toHaveLength(INITIAL_TREE_SNAPSHOT_ROW_LIMIT);
    expect(api.storage.local.get).toHaveBeenCalledTimes(1);
    expect(api.storage.local.get).toHaveBeenCalledWith([STATE_V3_MANIFEST_KEY, STATE_V2_MANIFEST_KEY]);
  });

  it("round-trips generated nested states through v2 chunks and order pages", async () => {
    const config = generatedTraceConfig({
      defaultSeedCount: 8,
      defaultSteps: 1,
      soakSeedCount: 48,
      soakSteps: 1
    });
    for (const seed of config.seeds) {
      const state = generatedStorageState(seed);
      const api = fakeApi(outlineStateV2Items(state, { revision: seed }));

      await expect(loadStateV2(api), `seed ${seed}`).resolves.toEqual(state);
    }
  }, generatedTraceTimeoutMs(5_000, 60_000));

  it("hydrates the full state from v2 chunks and order pages", async () => {
    const state = makeLargeState(1200);
    const api = fakeApi(outlineStateV2Items(state, { revision: 789 }));

    const loaded = await loadStateV2(api);

    expect(loaded).toEqual(state);
    expect(api.storage.local.get).toHaveBeenCalledWith(STATE_V2_MANIFEST_KEY);
    expect(vi.mocked(api.storage.local.get).mock.calls.some((call) => Array.isArray(call[0]))).toBe(true);
  });

  it("reports v3 hydration phases while loading metadata", async () => {
    const state = makeLargeState(1200);
    const api = fakeApi(outlineStateV3Changes(state, { revision: 789 }).setItems);
    const phases: Array<{ name: string; durationMs: number }> = [];

    const loaded = await loadStateWithMetadata(api, {
      onPhase: (phase) => {
        phases.push(phase);
      }
    });

    expect(loaded?.state).toEqual(state);
    expect(loaded?.format).toBe("v3");
    expect(phases.map((phase) => phase.name)).toEqual(expect.arrayContaining([
      "manifestRead",
      "v3.nodeShardRead",
      "v3.nodeMaterialize",
      "v3.orderPageKeys",
      "v3.orderPageRead",
      "v3.orderAttach",
      "v3.validation"
    ]));
    expect(phases.every((phase) => phase.durationMs >= 0)).toBe(true);
  });

  it("marks v3 stores with a stale shard count for a full rewrite", async () => {
    const state = makeLargeState(50);
    const items = outlineStateV3Changes(state).setItems;
    items[STATE_V3_MANIFEST_KEY] = {
      ...(items[STATE_V3_MANIFEST_KEY] as Record<string, unknown>),
      nodeShardCount: 256
    };
    const api = fakeApi(items);

    const loaded = await loadStateWithMetadata(api);

    expect(loaded?.state).toEqual(state);
    expect(loaded?.format).toBe("v3");
    expect(loaded?.requiresFullSave).toBe(true);
  });

  it("saves state using v3 keys by default", async () => {
    const state = makeLargeState(20);
    const api = fakeApi();

    await saveState(state, api);

    const saved = vi.mocked(api.storage.local.set).mock.calls.at(-1)?.[0];
    expect(saved?.[STATE_KEY]).toBeUndefined();
    expect(saved?.[STATE_V2_MANIFEST_KEY]).toBeUndefined();
    expect(saved?.[STATE_V3_MANIFEST_KEY]).toBeDefined();
    expect((saved?.[STATE_V3_MANIFEST_KEY] as { nodeShardCount?: number }).nodeShardCount).toBe(32);
    await expect(loadStateV3(api)).resolves.toEqual(state);
  });

  it("saves history without reintroducing the v1 state key", async () => {
    const state = makeLargeState(20);
    const api = fakeApi();

    await saveStateAndHistory(
      state,
      {
        version: 1,
        undoStack: [],
        redoStack: []
      },
      api
    );

    const saved = vi.mocked(api.storage.local.set).mock.calls.at(-1)?.[0];
    expect(saved?.[STATE_KEY]).toBeUndefined();
    expect(saved?.[STATE_V2_MANIFEST_KEY]).toBeUndefined();
    expect(saved?.[STATE_V3_MANIFEST_KEY]).toBeDefined();
    expect(saved?.[HISTORY_KEY]).toEqual({ version: 1, undoStack: [], redoStack: [] });
    await expect(loadStateV3(api)).resolves.toEqual(state);
  });
});

describe("outline state v3 storage", () => {
  it("round-trips a full v3 save/load for a large state", async () => {
    const state = makeLargeState(1200, { activeTabIndex: 1199 });
    const api = fakeApi();

    await saveState(state, api);

    const saved = vi.mocked(api.storage.local.set).mock.calls.at(-1)?.[0];
    expect(saved?.[STATE_KEY]).toBeUndefined();
    expect(saved?.[STATE_V2_MANIFEST_KEY]).toBeUndefined();
    expect(saved?.[STATE_V3_MANIFEST_KEY]).toBeDefined();
    await expect(loadStateV3(api)).resolves.toEqual(state);
    await expect(loadState(api)).resolves.toEqual(state);
  });

  it("loads v3 before falling back to v2", async () => {
    const v2State = makeLargeState(5);
    const v3State = makeLargeState(7, { activeTabIndex: 6 });
    const api = fakeApi(outlineStateV2Items(v2State, { revision: 10 }));
    await saveState(v3State, api);

    await expect(loadState(api)).resolves.toEqual(v3State);
  });

  it("writes bounded incremental v3 shards and order pages for a large same-parent move", () => {
    const previous = makeLargeState(50_000);
    const next = moveLastTabToFront(previous);

    const changes = outlineStateV3Changes(next, { previousState: previous, revision: 123 });
    const setKeys = Object.keys(changes.setItems);

    expect(changes.setItems[STATE_V3_MANIFEST_KEY]).toBeDefined();
    expect(setKeys.filter((key) => key.includes(":nodes:"))).toHaveLength(0);
    expect(setKeys.filter((key) => key.includes(":order:")).length).toBeGreaterThan(0);
    expect(setKeys.filter((key) => key.includes(":order:")).length).toBeLessThan(60);
    expect(setKeys.length).toBeLessThan(70);
  }, 15_000);

  it("builds dirty v3 node shards in one pass for order-page-heavy startup saves", () => {
    const previous = makeSidebarStartupState({
      shape: "order-page-heavy",
      tabs: 19_433,
      liveTabs: 50
    });
    const tabs = Array.from({ length: 51 }, (_, index) => {
      const tabId = index < 50 ? index + 1 : 19_434;
      return {
        id: tabId,
        windowId: 10,
        index,
        active: index === 50,
        url: index < 50 ? `https://large.example/${tabId}` : "https://startup.example/",
        title: index < 50 ? `Tab ${tabId}` : "Startup Tab 2"
      };
    });
    const next = reconcileWithWindows(previous, [
      {
        id: 10,
        incognito: false,
        focused: true,
        tabs
      }
    ], { now: 2000 }, {
      closeMissing: false,
      respectRuntimeTabOrder: true
    });

    const start = performance.now();
    const changes = outlineStateV3Changes(next, { previousState: previous, revision: 123 });
    const durationMs = performance.now() - start;
    const setKeys = Object.keys(changes.setItems);

    expect(changes.setItems[STATE_V3_MANIFEST_KEY]).toBeDefined();
    expect(setKeys.filter((key) => key.includes(":nodes:"))).toHaveLength(32);
    expect(durationMs).toBeLessThan(700);
  }, 10_000);

  it("keeps generated incremental v3 saves loadable as the exact next state", async () => {
    const config = generatedTraceConfig({
      defaultSeedCount: 8,
      defaultSteps: 1,
      soakSeedCount: 48,
      soakSteps: 1
    });
    for (const seed of config.seeds) {
      const previous = generatedStorageState(seed);
      const next = generatedNextStorageState(previous, seed);
      const api = fakeApi();
      await saveState(previous, api);

      await saveStateAndHistory(next, undefined, api, { previousState: previous });

      await expect(loadStateV3(api), `seed ${seed}`).resolves.toEqual(next);
    }
  }, generatedTraceTimeoutMs(5_000, 60_000));

  it("removes stale v3 order pages when a parent child list shrinks", async () => {
    const previous = makeLargeState(1100);
    const next = removeLastOrderPage(previous);
    const api = fakeApi();
    await saveState(previous, api);
    vi.mocked(api.storage.local.set).mockClear();
    vi.mocked(api.storage.local.remove).mockClear();

    await saveStateAndHistory(next, undefined, api, { previousState: previous });

    expect(vi.mocked(api.storage.local.remove)).toHaveBeenCalled();
    await expect(loadStateV3(api)).resolves.toEqual(next);
  });

  it("loads initial snapshots from the v3 manifest before v2", async () => {
    const v2State = makeLargeState(20);
    const v3State = makeLargeState(800, { activeTabIndex: 799 });
    const api = fakeApi(outlineStateV2Items(v2State, { revision: 111 }));
    await saveState(v3State, api);
    vi.mocked(api.storage.local.get).mockClear();

    const snapshot = await loadInitialTreeSnapshot(api);

    expect(snapshot?.revision).toBeDefined();
    expect(snapshot?.projection.nodeCount).toBe(801);
    expect(snapshot?.projection.activeTabNodeId).toBe("tab:800");
    expect(api.storage.local.get).toHaveBeenCalledTimes(1);
  });
});

function generatedStorageState(seed: number): OutlineState {
  const rng = seededRandom(seed);
  const root: OutlineNode = {
    id: "window:10",
    kind: "window",
    status: "live",
    childIds: [],
    title: "Group",
    active: true,
    collapsed: false,
    createdAt: seed,
    updatedAt: seed,
    live: { windowId: 10 }
  };
  const nodes: Record<string, OutlineNode> = {
    [root.id]: root
  };
  const parentIds = [root.id];
  const depths = new Map<string, number>([[root.id, 0]]);
  const activeTabOrdinal = 1 + Math.floor(rng() * 180);

  for (let ordinal = 1; ordinal <= 180; ordinal += 1) {
    const eligibleParents = parentIds.filter((parentId) => (depths.get(parentId) ?? 0) < 4);
    const parentId = eligibleParents[Math.floor(rng() * eligibleParents.length)] ?? root.id;
    const parent = nodes[parentId]!;
    const depth = (depths.get(parentId) ?? 0) + 1;
    const isGroup = ordinal % 17 === 0;
    const nodeId = isGroup ? `group:${seed}:${ordinal}` : `tab:${seed}:${ordinal}`;
    parent.childIds.push(nodeId);

    if (isGroup) {
      nodes[nodeId] = {
        id: nodeId,
        kind: "group",
        status: "neutral",
        parentId,
        childIds: [],
        title: `Group ${ordinal}`,
        collapsed: ordinal % 34 === 0,
        createdAt: seed + ordinal,
        updatedAt: seed + ordinal
      };
      parentIds.push(nodeId);
      depths.set(nodeId, depth);
      continue;
    }

    nodes[nodeId] = {
      id: nodeId,
      kind: "tab",
      status: "live",
      parentId,
      childIds: [],
      title: `Tab ${ordinal}`,
      url: `https://storage.example/${seed}/${ordinal}`,
      active: ordinal === activeTabOrdinal,
      collapsed: ordinal % 29 === 0,
      createdAt: seed + ordinal,
      updatedAt: seed + ordinal,
      live: { tabId: seed * 1000 + ordinal, windowId: 10 }
    };
    if (ordinal % 3 === 0) {
      parentIds.push(nodeId);
      depths.set(nodeId, depth);
    }
  }

  if (!Object.values(nodes).some((node) => node.kind === "tab" && node.active)) {
    const firstTab = Object.values(nodes).find((node) => node.kind === "tab");
    if (firstTab) {
      firstTab.active = true;
    }
  }

  return {
    version: 1,
    rootIds: [root.id],
    nodes
  };
}

function generatedNextStorageState(previous: OutlineState, seed: number): OutlineState {
  const next = cloneStorageState(previous);
  const rng = seededRandom(seed * 997);
  const parentsWithMultipleChildren = Object.values(next.nodes)
    .filter((node) => node.childIds.length > 1)
    .map((node) => node.id);
  const reorderParentId = parentsWithMultipleChildren[Math.floor(rng() * parentsWithMultipleChildren.length)];
  if (reorderParentId) {
    const parent = next.nodes[reorderParentId]!;
    const movedId = parent.childIds.pop();
    if (movedId) {
      parent.childIds.splice(Math.floor(rng() * (parent.childIds.length + 1)), 0, movedId);
      parent.updatedAt += 1;
    }
  }

  const group = Object.values(next.nodes).find((node) => node.kind === "group");
  if (group) {
    group.title = `Generated ${seed}`;
    group.customTitle = group.title;
    group.updatedAt += 1;
  }

  const insertParent = Object.values(next.nodes).find((node) => node.childIds.length > 0) ?? next.nodes[next.rootIds[0]!];
  if (insertParent) {
    const nodeId = `tab:${seed}:inserted`;
    insertParent.childIds.splice(Math.floor(rng() * (insertParent.childIds.length + 1)), 0, nodeId);
    next.nodes[nodeId] = {
      id: nodeId,
      kind: "tab",
      status: "live",
      parentId: insertParent.id,
      childIds: [],
      title: `Inserted ${seed}`,
      url: `https://storage.example/${seed}/inserted`,
      active: false,
      collapsed: false,
      createdAt: seed * 10_000,
      updatedAt: seed * 10_000,
      live: { tabId: seed * 10_000, windowId: 10 }
    };
    insertParent.updatedAt += 1;
  }

  const deleteCandidates = Object.values(next.nodes)
    .filter((node) => node.parentId && node.childIds.length === 0 && node.id.includes(":"))
  const deleteTarget = deleteCandidates.at(Math.floor(rng() * deleteCandidates.length));
  if (deleteTarget?.parentId) {
    const parent = next.nodes[deleteTarget.parentId];
    if (parent) {
      parent.childIds = parent.childIds.filter((childId) => childId !== deleteTarget.id);
      parent.updatedAt += 1;
    }
    delete next.nodes[deleteTarget.id];
  }

  return next;
}

function cloneStorageState(state: OutlineState): OutlineState {
  return {
    version: state.version,
    rootIds: [...state.rootIds],
    nodes: Object.fromEntries(
      Object.entries(state.nodes).map(([nodeId, node]) => [
        nodeId,
        {
          ...node,
          childIds: [...node.childIds],
          ...(node.live ? { live: { ...node.live } } : {}),
          ...(node.restore ? { restore: { ...node.restore } } : {})
        }
      ])
    )
  };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
