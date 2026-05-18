import { describe, expect, it, vi } from "vitest";

import {
  INITIAL_TREE_SNAPSHOT_ROW_LIMIT,
  STATE_V2_MANIFEST_KEY,
  loadInitialTreeSnapshot,
  loadStateV2,
  outlineStateV2Items
} from "./storage.js";
import type { OutlineNode, OutlineState } from "../model/types.js";

function makeLargeState(tabCount: number): OutlineState {
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
      active: id === 1,
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
        remove: vi.fn(async () => undefined),
        onChanged: { addListener: vi.fn() }
      }
    }
  } as never;
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
    expect(manifest?.nodeChunkKeys?.length).toBeGreaterThan(0);
    expect(manifest?.orderPageKeys?.length).toBeGreaterThan(0);
    expect(JSON.stringify(manifest?.initialSnapshot)).not.toContain("tab:260");
  });

  it("loads the initial tree snapshot by reading only the manifest key", async () => {
    const state = makeLargeState(800);
    const items = outlineStateV2Items(state, { revision: 456 });
    const api = fakeApi(items);

    const snapshot = await loadInitialTreeSnapshot(api);

    expect(snapshot?.revision).toBe(456);
    expect(snapshot?.projection.rows).toHaveLength(INITIAL_TREE_SNAPSHOT_ROW_LIMIT);
    expect(snapshot?.projection.nodeCount).toBe(801);
    expect(Object.keys(snapshot?.state.nodes ?? {})).toHaveLength(INITIAL_TREE_SNAPSHOT_ROW_LIMIT);
    expect(api.storage.local.get).toHaveBeenCalledTimes(1);
    expect(api.storage.local.get).toHaveBeenCalledWith(STATE_V2_MANIFEST_KEY);
  });

  it("hydrates the full state from v2 chunks and order pages", async () => {
    const state = makeLargeState(1200);
    const api = fakeApi(outlineStateV2Items(state, { revision: 789 }));

    const loaded = await loadStateV2(api);

    expect(loaded).toEqual(state);
    expect(api.storage.local.get).toHaveBeenCalledWith(STATE_V2_MANIFEST_KEY);
    expect(vi.mocked(api.storage.local.get).mock.calls.some((call) => Array.isArray(call[0]))).toBe(true);
  });
});
