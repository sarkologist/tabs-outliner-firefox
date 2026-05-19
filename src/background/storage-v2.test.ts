import { describe, expect, it, vi } from "vitest";

import {
  INITIAL_TREE_SNAPSHOT_ROW_LIMIT,
  HISTORY_KEY,
  STATE_KEY,
  STATE_V2_MANIFEST_KEY,
  STATE_V3_MANIFEST_KEY,
  loadInitialTreeSnapshot,
  loadState,
  loadStateV2,
  loadStateV3,
  outlineStateV2Items,
  outlineStateV3Changes,
  saveState,
  saveStateAndHistory
} from "./storage.js";
import type { OutlineNode, OutlineState } from "../model/types.js";

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

  it("hydrates the full state from v2 chunks and order pages", async () => {
    const state = makeLargeState(1200);
    const api = fakeApi(outlineStateV2Items(state, { revision: 789 }));

    const loaded = await loadStateV2(api);

    expect(loaded).toEqual(state);
    expect(api.storage.local.get).toHaveBeenCalledWith(STATE_V2_MANIFEST_KEY);
    expect(vi.mocked(api.storage.local.get).mock.calls.some((call) => Array.isArray(call[0]))).toBe(true);
  });

  it("saves state using v3 keys by default", async () => {
    const state = makeLargeState(20);
    const api = fakeApi();

    await saveState(state, api);

    const saved = vi.mocked(api.storage.local.set).mock.calls.at(-1)?.[0];
    expect(saved?.[STATE_KEY]).toBeUndefined();
    expect(saved?.[STATE_V2_MANIFEST_KEY]).toBeUndefined();
    expect(saved?.[STATE_V3_MANIFEST_KEY]).toBeDefined();
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
  });

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
