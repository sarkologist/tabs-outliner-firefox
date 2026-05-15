import { describe, expect, it, vi } from "vitest";

import { createStateCache } from "./state-cache.js";

describe("state cache", () => {
  it("returns the latest replaced state after initialization", async () => {
    const initialize = vi.fn(async () => ({ collapsed: false }));
    const cache = createStateCache(initialize);

    expect(await cache.get()).toEqual({ collapsed: false });

    cache.replace({ collapsed: true });

    expect(await cache.get()).toEqual({ collapsed: true });
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it("retries initialization after a failed first load", async () => {
    const initialize = vi
      .fn<() => Promise<{ ready: boolean }>>()
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce({ ready: true });
    const cache = createStateCache(initialize);

    await expect(cache.get()).rejects.toThrow(/storage unavailable/);

    expect(await cache.get()).toEqual({ ready: true });
    expect(initialize).toHaveBeenCalledTimes(2);
  });
});
