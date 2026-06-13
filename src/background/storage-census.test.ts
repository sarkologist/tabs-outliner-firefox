import { describe, expect, it } from "vitest";

import { createFaultyStorage } from "../test/faulty-storage.test-support.js";
import {
  STORAGE_PROBE_KEY,
  measureStorageCensus,
  storageCensusIncidentDetail,
  type StorageCensusResult
} from "./storage-census.js";

function representativeStore(): Record<string, unknown> {
  const shard = (shardIndex: number, generation: number) => ({
    version: 4,
    shardIndex,
    generation,
    nodes: [{ id: `n${shardIndex}`, kind: "tab", status: "closed", childIds: [], title: "t" }]
  });
  return {
    "outline:v4:nodes:00:2437": shard(0, 2437),
    "outline:v4:nodes:01:2437": shard(1, 2437),
    "outline:v4:nodes:00:2436": shard(0, 2436), // leaked older generation
    "outline:v4:journal:meta": { version: 1, headSeq: 5 },
    "outline:v4:journal:slot:0": { version: 1, batch: 0, entries: [] },
    "outline:v4:manifest:a": { version: 4, generation: 2437 },
    "outline:v4:manifest:b": { version: 4, generation: 2436 },
    "outline:v4:bootSnapshot": { version: 3, revision: 1, snapshot: {} },
    "outline:v4:migrationBackup": { version: 1, tree: {} },
    "outline:v4:migrationBackupMeta": { version: 1, exportedAt: 1 },
    "outlineState:v3:manifest": { version: 3 },
    "outlineState:v2:manifest": { version: 2 },
    outlineHistory: { undoStack: [], redoStack: [] },
    outlineState: { version: 1 },
    "tabsOutlinerIncidentLog:v1": { version: 1, entries: [] },
    tabsOutlinerPreferences: { undoLimit: 50 },
    tabsOutlinerProfileEnabled: true,
    somethingElse: { unrelated: true }
  };
}

describe("storage census", () => {
  it("counts keys and bytes and breaks them down by prefix", async () => {
    const initial = representativeStore();
    const { api } = createFaultyStorage(initial);

    const result = await measureStorageCensus(api, { probe: false });

    expect(result.totalKeys).toBe(Object.keys(initial).length);
    expect(result.totalBytes).toBeGreaterThan(0);

    const byPrefix = new Map(result.byPrefix.map((entry) => [entry.prefix, entry]));
    expect(byPrefix.get("outline:v4:nodes:")?.keyCount).toBe(3);
    expect(byPrefix.get("outline:v4:journal:")?.keyCount).toBe(2);
    expect(byPrefix.get("outline:v4:manifest:")?.keyCount).toBe(2);
    expect(byPrefix.get("outline:v4:migrationBackup")?.keyCount).toBe(2); // backup + backupMeta
    expect(byPrefix.get("outlineState:v3:")?.keyCount).toBe(1);
    expect(byPrefix.get("outlineState:v2:")?.keyCount).toBe(1);
    expect(byPrefix.get("outlineState")?.keyCount).toBe(1); // bare v1 key, not the v2/v3 ones
    expect(byPrefix.get("outlineHistory")?.keyCount).toBe(1);
    expect(byPrefix.get("tabsOutlinerIncidentLog")?.keyCount).toBe(1);
    expect(byPrefix.get("tabsOutliner")?.keyCount).toBe(2); // preferences + profile flag
    expect(byPrefix.get("other")?.keyCount).toBe(1);

    // Every key is attributed to exactly one bucket.
    const attributed = result.byPrefix.reduce((sum, entry) => sum + entry.keyCount, 0);
    expect(attributed).toBe(result.totalKeys);
    const attributedBytes = result.byPrefix.reduce((sum, entry) => sum + entry.bytes, 0);
    expect(attributedBytes).toBe(result.totalBytes);
  });

  it("counts node-shard keys and distinct generations as a leak signal", async () => {
    const { api } = createFaultyStorage(representativeStore());
    const result = await measureStorageCensus(api, { probe: false });
    expect(result.nodeShardKeyCount).toBe(3);
    expect(result.nodeShardDistinctGenerations).toBe(2); // generations 2437 and 2436
  });

  it("sorts the prefix breakdown by bytes descending", async () => {
    const { api } = createFaultyStorage(representativeStore());
    const result = await measureStorageCensus(api, { probe: false });
    for (let index = 1; index < result.byPrefix.length; index += 1) {
      expect(result.byPrefix[index - 1]!.bytes).toBeGreaterThanOrEqual(result.byPrefix[index]!.bytes);
    }
  });

  it("probes with a self-cleaning key and leaves the store otherwise untouched", async () => {
    const initial = representativeStore();
    const faulty = createFaultyStorage(initial);

    const result = await measureStorageCensus(faulty.api);

    expect(result.probeSetMs).toBeTypeOf("number");
    expect(result.probeSetWarmMs).toBeTypeOf("number");
    expect(result.probeError).toBeUndefined();
    expect(faulty.setCallCount()).toBe(2); // cold + warm probe writes
    // The probe key is removed; nothing else changed.
    const after = faulty.snapshot();
    expect(after).not.toHaveProperty(STORAGE_PROBE_KEY);
    expect(after).toEqual(initial);
  });

  it("does not write at all when probing is disabled", async () => {
    const initial = representativeStore();
    const faulty = createFaultyStorage(initial);

    const result = await measureStorageCensus(faulty.api, { probe: false });

    expect(result.probeSetMs).toBeNull();
    expect(result.probeSetWarmMs).toBeNull();
    expect(faulty.setCallCount()).toBe(0);
    expect(faulty.snapshot()).toEqual(initial);
  });

  it("reflects backend latency in the probe timing", async () => {
    const faulty = createFaultyStorage(representativeStore());
    faulty.setLatencyMs(25);
    const result = await measureStorageCensus(faulty.api, { now: () => 1 });
    expect(result.probeSetMs).toBeGreaterThanOrEqual(10);
  });

  it("records a probe error without throwing and cleans up", async () => {
    const initial = representativeStore();
    const faulty = createFaultyStorage(initial);
    faulty.failNextSet(new Error("simulated whole-store rewrite failure"));

    const result = await measureStorageCensus(faulty.api);

    expect(result.probeSetMs).toBeNull();
    expect(result.probeSetWarmMs).toBeNull();
    expect(result.probeError).toContain("simulated whole-store rewrite failure");
    // The read-only census still succeeded.
    expect(result.totalKeys).toBe(Object.keys(initial).length);
    // No probe key was left behind (the failing set never applied it).
    expect(faulty.snapshot()).not.toHaveProperty(STORAGE_PROBE_KEY);
  });

  it("flattens into incident-log detail with a JSON prefix breakdown", () => {
    const result: StorageCensusResult = {
      totalKeys: 170,
      totalBytes: 13_000_000,
      byPrefix: [
        { prefix: "outline:v4:nodes:", keyCount: 96, bytes: 12_500_000 },
        { prefix: "outlineHistory", keyCount: 1, bytes: 400_000 }
      ],
      nodeShardKeyCount: 96,
      nodeShardDistinctGenerations: 3,
      probeSetMs: 1711,
      probeSetWarmMs: 40
    };

    const detail = storageCensusIncidentDetail(result);

    expect(detail.totalKeys).toBe(170);
    expect(detail.totalBytes).toBe(13_000_000);
    expect(detail.nodeShardKeyCount).toBe(96);
    expect(detail.nodeShardDistinctGenerations).toBe(3);
    expect(detail.probeSetMs).toBe(1711);
    expect(detail.probeSetWarmMs).toBe(40);
    expect(detail).not.toHaveProperty("probeError");
    expect(JSON.parse(detail.byPrefix as string)).toEqual([
      ["outline:v4:nodes:", 96, 12_500_000],
      ["outlineHistory", 1, 400_000]
    ]);
    // All values are incident-log storable scalars.
    for (const value of Object.values(detail)) {
      expect(["string", "number", "boolean"].includes(typeof value) || value === null).toBe(true);
    }
  });

  it("carries the probe error into incident-log detail when present", () => {
    const detail = storageCensusIncidentDetail({
      totalKeys: 1,
      totalBytes: 1,
      byPrefix: [],
      nodeShardKeyCount: 0,
      nodeShardDistinctGenerations: 0,
      probeSetMs: null,
      probeSetWarmMs: null,
      probeError: "quota exceeded"
    });
    expect(detail.probeError).toBe("quota exceeded");
    expect(detail.probeSetMs).toBeNull();
  });
});
