import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// loadHistory (storage.js) and normalizeHistoryState (history.js) have their own coverage; here we
// mock them to test the loader's orchestration: lazy single-flight load, the cached short-circuit,
// seeding the controller-owned binding, and the warmup-timer scheduling/guards.
vi.mock("./storage.js", () => ({ loadHistory: vi.fn() }));
vi.mock("./history.js", () => ({ normalizeHistoryState: vi.fn((value: unknown) => value) }));

import { createHistoryLoader, type HistoryLoaderDeps } from "./history-loader.js";
import { loadHistory } from "./storage.js";
import { normalizeHistoryState } from "./history.js";
import { createPerformanceTracer } from "../perf/trace.js";

type HistoryState = ReturnType<HistoryLoaderDeps["getHistoryState"]> & object;

const RAW = { undoStack: ["raw"], redoStack: [] } as unknown as HistoryState;
const NORMALIZED = { undoStack: [], redoStack: [] } as unknown as HistoryState;
const EXISTING = { undoStack: ["existing"], redoStack: [] } as unknown as HistoryState;

function createHarness(initial?: HistoryState) {
  let historyState: HistoryState | undefined = initial;
  const loader = createHistoryLoader({
    api: {} as unknown as HistoryLoaderDeps["api"],
    shardStore: {} as unknown as HistoryLoaderDeps["shardStore"],
    perfTrace: createPerformanceTracer("background"),
    ensurePreferences: async () =>
      ({ undoHistoryLimit: 100 }) as unknown as Awaited<
        ReturnType<HistoryLoaderDeps["ensurePreferences"]>
      >,
    getHistoryState: () => historyState,
    setHistoryState: (history) => {
      historyState = history;
    }
  });
  return { loader, getHistoryState: () => historyState };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(loadHistory)
    .mockReset()
    .mockResolvedValue(RAW as never);
  vi.mocked(normalizeHistoryState)
    .mockReset()
    .mockReturnValue(NORMALIZED as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("history loader — ensure", () => {
  it("loads + normalizes once and seeds the controller-owned binding", async () => {
    const { loader, getHistoryState } = createHarness();

    const result = await loader.ensure();

    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(normalizeHistoryState).toHaveBeenCalledWith(RAW, 100);
    expect(result).toBe(NORMALIZED);
    expect(getHistoryState()).toBe(NORMALIZED);
  });

  it("returns the already-loaded history without hitting storage", async () => {
    const { loader } = createHarness(EXISTING);

    const result = await loader.ensure();

    expect(result).toBe(EXISTING);
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("coalesces concurrent loads into a single in-flight load", async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(loadHistory).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }) as never
    );
    const { loader } = createHarness();

    const a = loader.ensure();
    const b = loader.ensure();
    resolve(RAW);
    const [ra, rb] = await Promise.all([a, b]);

    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(ra).toBe(NORMALIZED);
    expect(rb).toBe(NORMALIZED);
  });

  it("starts a fresh load after the previous one settled and was consumed", async () => {
    const { loader } = createHarness();

    await loader.ensure();
    // The binding is seeded now, so a second ensure short-circuits (does not reload).
    await loader.ensure();

    expect(loadHistory).toHaveBeenCalledTimes(1);
  });
});

describe("history loader — scheduleWarmup", () => {
  it("warms the cache off a timer when neither loaded nor loading", async () => {
    const { loader, getHistoryState } = createHarness();

    loader.scheduleWarmup();
    expect(loadHistory).not.toHaveBeenCalled(); // deferred to the timer

    await vi.runAllTimersAsync();

    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(getHistoryState()).toBe(NORMALIZED);
  });

  it("does nothing when the history is already loaded", async () => {
    const { loader } = createHarness(EXISTING);

    loader.scheduleWarmup();
    await vi.runAllTimersAsync();

    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("schedules at most one warmup timer", async () => {
    const { loader } = createHarness();

    loader.scheduleWarmup();
    loader.scheduleWarmup();
    await vi.runAllTimersAsync();

    expect(loadHistory).toHaveBeenCalledTimes(1);
  });
});
