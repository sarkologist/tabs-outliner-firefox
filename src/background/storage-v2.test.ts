import { describe, expect, it, vi } from "vitest";

import {
  INITIAL_TREE_SNAPSHOT_ROW_LIMIT,
  STATE_KEY,
  STATE_V2_MANIFEST_KEY,
  STATE_V3_BOOT_SNAPSHOT_KEY,
  STATE_V3_MANIFEST_KEY,
  loadInitialTreeSnapshot,
  loadState,
  loadStateWithMetadata,
  loadStateV2,
  loadStateV3,
  createInitialTreeSnapshotProjector,
  initialTreeSnapshotForState,
  outlineBootSnapshotItem,
  type StateStructureRepair
} from "./storage.js";
import { outlineStateV2Items, outlineStateV3Items } from "./storage-legacy-write.test-support.js";
import type { OutlineNode, OutlineState } from "../model/types.js";
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



function mutateStoredV3Node(
  items: Record<string, unknown>,
  nodeId: string,
  mutate: (node: Record<string, unknown>) => void
): void {
  for (const value of Object.values(items)) {
    if (!value || typeof value !== "object" || !Array.isArray((value as { nodes?: unknown }).nodes)) {
      continue;
    }
    for (const node of (value as { nodes: unknown[] }).nodes) {
      if (node && typeof node === "object" && (node as { id?: unknown }).id === nodeId) {
        mutate(node as Record<string, unknown>);
        return;
      }
    }
  }
  throw new Error(`missing stored v3 node ${nodeId}`);
}

describe("outline state v2 storage", () => {
  it("builds query projection snapshots from the full outline state", () => {
    const state: OutlineState = {
      version: 1,
      rootIds: ["window:10"],
      nodes: {
        "window:10": {
          id: "window:10",
          kind: "window",
          status: "live",
          childIds: ["tab:visible", "group:closed"],
          title: "Window",
          active: true,
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          live: { windowId: 10 }
        },
        "tab:visible": {
          id: "tab:visible",
          kind: "tab",
          status: "live",
          parentId: "window:10",
          childIds: [],
          title: "Visible Tab",
          url: "https://visible.example/",
          active: true,
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          live: { tabId: 1, windowId: 10 }
        },
        "group:closed": {
          id: "group:closed",
          kind: "group",
          status: "closed",
          parentId: "window:10",
          childIds: ["tab:hidden"],
          title: "Closed Group",
          collapsed: true,
          createdAt: 1000,
          updatedAt: 1000,
          closedAt: 1000
        },
        "tab:hidden": {
          id: "tab:hidden",
          kind: "tab",
          status: "closed",
          parentId: "group:closed",
          childIds: [],
          title: "Needle Tab",
          url: "https://needle.example/",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          closedAt: 1001
        }
      }
    };

    const snapshot = initialTreeSnapshotForState(state, {
      query: "needle",
      rowLimit: 10,
      hydrating: true
    });

    expect(snapshot.projection.query).toBe("needle");
    expect(snapshot.projection.isSearchActive).toBe(true);
    expect(snapshot.projection.matchingNodeIds).toEqual(["tab:hidden"]);
    expect(snapshot.projection.visibleNodeIds).toEqual(["window:10", "group:closed", "tab:hidden"]);
    expect(snapshot.projection.rows.map((row) => row.nodeId)).toEqual([
      "window:10",
      "group:closed",
      "tab:hidden"
    ]);
    expect(snapshot.projection.rows[1]).toMatchObject({
      nodeId: "group:closed",
      expanded: true,
      searchRevealsCollapsedChildren: true,
      isSearchPath: true
    });
    expect(snapshot.projection.rows[2]).toMatchObject({
      nodeId: "tab:hidden",
      isSearchMatch: true
    });
    expect(Object.keys(snapshot.state.nodes).sort()).toEqual([
      "group:closed",
      "tab:hidden",
      "window:10"
    ]);
  });

  it("reuses cached query projections for repeated slice windows", () => {
    const state = makeLargeState(900);
    const projectionBuilds: Array<{ query: string; rowCount: number }> = [];
    const projector = createInitialTreeSnapshotProjector({
      onProjectionBuilt: (detail) => {
        projectionBuilds.push({
          query: detail.query,
          rowCount: detail.rowCount
        });
      }
    });

    const first = projector.snapshotForState(state, {
      query: "tab",
      rowLimit: 20,
      centerRowIndex: 20,
      hydrating: true
    });
    const second = projector.snapshotForState(state, {
      query: "tab",
      rowLimit: 20,
      centerRowIndex: 700,
      hydrating: true
    });
    const third = projector.snapshotForState(state, {
      query: "tab 7",
      rowLimit: 20,
      centerRowIndex: 20,
      hydrating: true
    });

    expect(first.projection.rows.some((row) => row.index === 20)).toBe(true);
    expect(second.projection.rows.some((row) => row.index === 700)).toBe(true);
    expect(third.projection.query).toBe("tab 7");
    expect(projectionBuilds).toEqual([
      { query: "tab", rowCount: 901 },
      { query: "tab 7", rowCount: 112 }
    ]);
  });

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
    expect(api.storage.local.get).toHaveBeenCalledWith([
      "outline:v4:bootSnapshot",
      STATE_V3_BOOT_SNAPSHOT_KEY,
      STATE_V3_MANIFEST_KEY,
      STATE_V2_MANIFEST_KEY
    ]);
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
    const api = fakeApi(outlineStateV3Items(state, { revision: 789 }));
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
    const items = outlineStateV3Items(state);
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

});

describe("outline state v3 storage", () => {
  it("round-trips a full v3 save/load for a large state", async () => {
    const state = makeLargeState(1200, { activeTabIndex: 1199 });
    const api = fakeApi();

    await api.storage.local.set(outlineStateV3Items(state));

    const saved = vi.mocked(api.storage.local.set).mock.calls.at(-1)?.[0];
    expect(saved?.[STATE_KEY]).toBeUndefined();
    expect(saved?.[STATE_V2_MANIFEST_KEY]).toBeUndefined();
    expect(saved?.[STATE_V3_MANIFEST_KEY]).toBeDefined();
    await expect(loadStateV3(api)).resolves.toEqual(state);
    await expect(loadState(api)).resolves.toEqual(state);
  });

  it("loads v3 structure from manifest roots and order pages over stale parent ids", async () => {
    const state: OutlineState = {
      version: 1,
      rootIds: ["window:10", "window:20", "window:30"],
      nodes: {
        "window:10": {
          id: "window:10",
          kind: "window",
          status: "closed",
          childIds: [],
          title: "First root",
          active: false,
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          closedAt: 1100
        },
        "window:20": {
          id: "window:20",
          kind: "window",
          status: "closed",
          childIds: ["tab:20"],
          title: "Second root",
          active: false,
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          closedAt: 1100
        },
        "tab:20": {
          id: "tab:20",
          kind: "tab",
          status: "closed",
          parentId: "window:20",
          childIds: [],
          title: "Second tab",
          url: "https://two.example/",
          active: false,
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          closedAt: 1100
        },
        "window:30": {
          id: "window:30",
          kind: "window",
          status: "closed",
          childIds: ["tab:30"],
          title: "Unreferenced root",
          active: false,
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          closedAt: 1100
        },
        "tab:30": {
          id: "tab:30",
          kind: "tab",
          status: "closed",
          parentId: "window:30",
          childIds: [],
          title: "Unreferenced tab",
          url: "https://three.example/",
          active: false,
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          closedAt: 1100
        }
      }
    };
    const items = outlineStateV3Items(state, { revision: 321 });
    mutateStoredV3Node(items, "window:20", (node) => {
      node.parentId = "window:10";
    });
    mutateStoredV3Node(items, "tab:20", (node) => {
      node.parentId = "window:10";
    });
    mutateStoredV3Node(items, "window:30", (node) => {
      node.parentId = "window:10";
    });
    items[STATE_V3_MANIFEST_KEY] = {
      ...(items[STATE_V3_MANIFEST_KEY] as Record<string, unknown>),
      rootIds: ["window:10", "window:20"]
    };
    const repairs: StateStructureRepair[] = [];

    const loaded = await loadStateWithMetadata(fakeApi(items), {
      onStructureRepair: (repair) => {
        repairs.push(repair);
      }
    });

    expect(loaded?.state.rootIds).toEqual(["window:10", "window:20", "window:30"]);
    expect(loaded?.state.nodes["window:10"]?.childIds).toEqual([]);
    expect(loaded?.state.nodes["window:20"]?.parentId).toBeUndefined();
    expect(loaded?.state.nodes["window:20"]?.childIds).toEqual(["tab:20"]);
    expect(loaded?.state.nodes["tab:20"]?.parentId).toBe("window:20");
    expect(loaded?.state.nodes["window:30"]?.parentId).toBeUndefined();
    expect(loaded?.state.nodes["tab:30"]?.parentId).toBe("window:30");
    expect(repairs).toEqual([
      expect.objectContaining({
        source: "v3",
        rootCountBefore: 2,
        rootCountAfter: 3,
        parentMismatchCount: 3,
        staleRootParentCount: 2,
        extraRootCount: 1,
        unreachableNodeCount: 2
      })
    ]);
  });

  it("loads v3 before falling back to v2", async () => {
    const v2State = makeLargeState(5);
    const v3State = makeLargeState(7, { activeTabIndex: 6 });
    const api = fakeApi(outlineStateV2Items(v2State, { revision: 10 }));
    await api.storage.local.set(outlineStateV3Items(v3State));

    await expect(loadState(api)).resolves.toEqual(v3State);
  });

  it("salvages v3 when an order page is missing instead of failing the load", async () => {
    const state = makeLargeState(1500, { activeTabIndex: 0 });
    const items = outlineStateV3Items(state);
    const secondPageKey = Object.keys(items).find(
      (key) => key.startsWith("outlineState:v3:order:") && key.endsWith(":1")
    );
    expect(secondPageKey).toBeDefined();
    delete items[secondPageKey!];
    const repairs: StateStructureRepair[] = [];

    const loaded = await loadStateWithMetadata(fakeApi(items), {
      onStructureRepair: (repair) => repairs.push(repair)
    });

    expect(loaded?.format).toBe("v3");
    expect(loaded?.salvaged).toBe(true);
    expect(loaded?.requiresFullSave).toBe(true);
    // Page 0 (1024 children) survives; the rest are re-rooted by structure repair.
    expect(loaded?.state.nodes["window:10"]?.childIds).toHaveLength(1024);
    expect(repairs.length).toBeGreaterThan(0);
  });

  it("salvages v3 when a shard is corrupt", async () => {
    const state = makeLargeState(400);
    const items = outlineStateV3Items(state);
    const shardKey = Object.keys(items).find((key) => key.startsWith("outlineState:v3:nodes:"));
    expect(shardKey).toBeDefined();
    items[shardKey!] = { not: "a shard" };

    const loaded = await loadStateWithMetadata(fakeApi(items));

    expect(loaded?.format).toBe("v3");
    expect(loaded?.salvaged).toBe(true);
    expect(loaded?.requiresFullSave).toBe(true);
    const survivingNodeCount = Object.keys(loaded!.state.nodes).length;
    expect(survivingNodeCount).toBeGreaterThan(0);
    expect(survivingNodeCount).toBeLessThan(401);
  });

  it("does not fall back to v2 when a v3 manifest exists", async () => {
    const v3State = makeLargeState(300);
    const items = outlineStateV3Items(v3State);
    const shardKey = Object.keys(items).find((key) => key.startsWith("outlineState:v3:nodes:"));
    items[shardKey!] = { not: "a shard" };
    // A stale but structurally valid v2 manifest must NOT win over salvageable v3.
    Object.assign(items, outlineStateV2Items(makeLargeState(5), { revision: 10 }));

    const loaded = await loadStateWithMetadata(fakeApi(items));

    expect(loaded?.format).toBe("v3");
    expect(loaded?.salvaged).toBe(true);
  });

  it("loads the boot snapshot from its own key before v2", async () => {
    const v2State = makeLargeState(20);
    const v3State = makeLargeState(800, { activeTabIndex: 799 });
    const api = fakeApi(outlineStateV2Items(v2State, { revision: 111 }));
    await api.storage.local.set(outlineStateV3Items(v3State));
    await api.storage.local.set(outlineBootSnapshotItem(v3State, 222));
    vi.mocked(api.storage.local.get).mockClear();

    const snapshot = await loadInitialTreeSnapshot(api);

    expect(snapshot?.revision).toBeDefined();
    expect(snapshot?.projection.nodeCount).toBe(801);
    expect(snapshot?.projection.activeTabNodeId).toBe("tab:800");
    expect(api.storage.local.get).toHaveBeenCalledTimes(1);
  });

  it("loads the embedded snapshot from older v3 manifests for back-compat", async () => {
    const state = makeLargeState(40, { activeTabIndex: 5 });
    const items = outlineStateV3Items(state);
    // Simulate an older manifest that still embeds the snapshot and has no boot snapshot key.
    items[STATE_V3_MANIFEST_KEY] = {
      ...(items[STATE_V3_MANIFEST_KEY] as Record<string, unknown>),
      initialSnapshot: initialTreeSnapshotForState(state, { revision: 9, hydrating: true })
    };

    const snapshot = await loadInitialTreeSnapshot(fakeApi(items));

    expect(snapshot?.projection.nodeCount).toBe(41);
    expect(snapshot?.projection.activeTabNodeId).toBe("tab:6");
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



function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
