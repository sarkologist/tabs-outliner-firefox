import { describe, expect, it } from "vitest";

import { createFaultyStorage } from "../test/faulty-storage.test-support.js";
import { storageLocalKvStore } from "./key-value-store.js";

describe("storageLocalKvStore", () => {
  it("delegates get/set/remove to storage.local with the shapes the journal uses", async () => {
    const faulty = createFaultyStorage();
    const store = storageLocalKvStore(faulty.api);

    await store.set({ a: 1, b: 2, c: 3 });

    // single string key
    expect(await store.get("a")).toEqual({ a: 1 });
    // array of keys
    expect(await store.get(["a", "c"])).toEqual({ a: 1, c: 3 });
    // null / omitted -> whole store
    expect(await store.get(null)).toEqual({ a: 1, b: 2, c: 3 });
    expect(await store.get()).toEqual({ a: 1, b: 2, c: 3 });

    await store.remove(["b"]);
    expect(await store.get(null)).toEqual({ a: 1, c: 3 });

    await store.remove("a");
    expect(await store.get(null)).toEqual({ c: 3 });
  });

  it("propagates storage.local.set failures (fault injection reaches through the adapter)", async () => {
    const faulty = createFaultyStorage();
    const store = storageLocalKvStore(faulty.api);

    faulty.failNextSet(new Error("boom"));
    await expect(store.set({ a: 1 })).rejects.toThrow("boom");
    // The failed set applied nothing.
    expect(faulty.snapshot()).toEqual({});

    // Recovers on the next write.
    await store.set({ a: 1 });
    expect(faulty.snapshot()).toEqual({ a: 1 });
  });
});
