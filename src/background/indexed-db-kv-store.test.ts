import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";

import { indexedDbKvStore } from "./indexed-db-kv-store.js";

describe("indexedDbKvStore", () => {
  it("round-trips get/set/remove with the string, array, and null(=all) shapes the journal uses", async () => {
    const store = indexedDbKvStore("kv-test-shapes", "kv");
    await store.set({ a: 1, b: { x: 2 }, c: [3, 4] });

    expect(await store.get("a")).toEqual({ a: 1 });
    expect(await store.get(["a", "c"])).toEqual({ a: 1, c: [3, 4] });
    // missing keys come back undefined (the journal validators treat that as "absent")
    expect(await store.get("missing")).toEqual({ missing: undefined });
    expect(await store.get(null)).toEqual({ a: 1, b: { x: 2 }, c: [3, 4] });
    expect(await store.get()).toEqual({ a: 1, b: { x: 2 }, c: [3, 4] });

    await store.remove(["b"]);
    expect(await store.get(null)).toEqual({ a: 1, c: [3, 4] });
    await store.remove("a");
    expect(await store.get(null)).toEqual({ c: [3, 4] });
  });

  it("overwrites a key on repeated set", async () => {
    const store = indexedDbKvStore("kv-test-overwrite", "kv");
    await store.set({ k: 1 });
    await store.set({ k: 2 });
    expect(await store.get("k")).toEqual({ k: 2 });
  });

  it("persists across store handles on the same database (survives a background restart)", async () => {
    const first = indexedDbKvStore("kv-test-persist", "kv");
    await first.set({ meta: { epoch: 7 }, "slot:0": [1, 2, 3] });

    const second = indexedDbKvStore("kv-test-persist", "kv");
    expect(await second.get(["meta", "slot:0"])).toEqual({ meta: { epoch: 7 }, "slot:0": [1, 2, 3] });
  });

  it("treats a multi-key set as one transaction and remove of an empty list as a no-op", async () => {
    const store = indexedDbKvStore("kv-test-batch", "kv");
    await store.set({ a: 1, b: 2 });
    await store.remove([]);
    expect(await store.get(null)).toEqual({ a: 1, b: 2 });
  });
});
