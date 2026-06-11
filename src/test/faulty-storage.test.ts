import { describe, expect, it } from "vitest";

import { createFaultyStorage } from "./faulty-storage.test-support.js";

describe("faulty storage helper", () => {
  it("reads and writes like storage.local by default", async () => {
    const faulty = createFaultyStorage({ existing: 1 });

    await faulty.api.storage.local.set({ a: "x", b: "y" });

    expect(await faulty.api.storage.local.get("a")).toEqual({ a: "x" });
    expect(await faulty.api.storage.local.get(["a", "b", "missing"])).toEqual({ a: "x", b: "y", missing: undefined });
    expect(faulty.snapshot()).toEqual({ existing: 1, a: "x", b: "y" });
  });

  it("fails the next set without applying any key", async () => {
    const faulty = createFaultyStorage();
    faulty.failNextSet(new Error("disk full"));

    await expect(faulty.api.storage.local.set({ a: 1, b: 2 })).rejects.toThrow("disk full");
    expect(faulty.snapshot()).toEqual({});

    // Only the next set fails; the following one succeeds.
    await faulty.api.storage.local.set({ a: 1 });
    expect(faulty.snapshot()).toEqual({ a: 1 });
  });

  it("tears the next set, applying only the first n keys", async () => {
    const faulty = createFaultyStorage();
    faulty.tearNextSet(2);

    await faulty.api.storage.local.set({ a: 1, b: 2, c: 3, d: 4 });

    expect(faulty.snapshot()).toEqual({ a: 1, b: 2 });
    // The tear is one-shot.
    await faulty.api.storage.local.set({ c: 3, d: 4 });
    expect(faulty.snapshot()).toEqual({ a: 1, b: 2, c: 3, d: 4 });
  });

  it("removes keys", async () => {
    const faulty = createFaultyStorage({ a: 1, b: 2, c: 3 });

    await faulty.api.storage.local.remove(["a", "c"]);

    expect(faulty.snapshot()).toEqual({ b: 2 });
  });

  it("counts set calls including failed and torn ones", async () => {
    const faulty = createFaultyStorage();
    faulty.failNextSet();
    await expect(faulty.api.storage.local.set({ a: 1 })).rejects.toThrow();
    faulty.tearNextSet(0);
    await faulty.api.storage.local.set({ b: 2 });
    await faulty.api.storage.local.set({ c: 3 });

    expect(faulty.setCallCount()).toBe(3);
  });

  it("injects latency into operations", async () => {
    const faulty = createFaultyStorage();
    faulty.setLatencyMs(20);

    const start = Date.now();
    await faulty.api.storage.local.set({ a: 1 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});
