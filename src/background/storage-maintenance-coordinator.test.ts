import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The census and sweep primitives have their own coverage (storage-census.test.ts,
// storage-v4.test.ts); here we mock them to test the coordinator's orchestration contract in
// isolation: the in-flight/scheduled guards, the skip-when-external rule, and the exact
// incident-log event names (persisted/observable strings that must not drift).
vi.mock("./storage-census.js", () => ({
  measureStorageCensus: vi.fn(),
  storageCensusIncidentDetail: vi.fn(() => ({ census: "ok" }))
}));
vi.mock("./storage-v4.js", () => ({
  sweepOrphanedV4Shards: vi.fn()
}));

import {
  createStorageMaintenanceCoordinator,
  type StorageMaintenanceCoordinatorDeps
} from "./storage-maintenance-coordinator.js";
import { measureStorageCensus, storageCensusIncidentDetail } from "./storage-census.js";
import { sweepOrphanedV4Shards } from "./storage-v4.js";

type IncidentEntry = { event: string; detail: unknown };

function createHarness(overrides: Partial<StorageMaintenanceCoordinatorDeps> = {}) {
  const incidents: IncidentEntry[] = [];
  const coordinator = createStorageMaintenanceCoordinator({
    api: {} as unknown as StorageMaintenanceCoordinatorDeps["api"],
    shardStore: {} as unknown as StorageMaintenanceCoordinatorDeps["shardStore"],
    shardStoreExternal: false,
    now: () => 1000,
    recordIncidentLog: async (event, detail) => {
      incidents.push({ event, detail });
    },
    ...overrides
  });
  return { coordinator, incidents };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(measureStorageCensus).mockReset();
  vi.mocked(storageCensusIncidentDetail).mockReset().mockReturnValue({ census: "ok" });
  vi.mocked(sweepOrphanedV4Shards).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("storage maintenance coordinator — census", () => {
  it("records the census to the incident log under the storageCensus event", async () => {
    vi.mocked(measureStorageCensus).mockResolvedValue({} as never);
    vi.mocked(storageCensusIncidentDetail).mockReturnValue({ census: "measured" });
    const { coordinator, incidents } = createHarness();

    await coordinator.recordCensus();

    expect(measureStorageCensus).toHaveBeenCalledTimes(1);
    expect(storageCensusIncidentDetail).toHaveBeenCalledTimes(1);
    expect(incidents).toEqual([{ event: "storageCensus", detail: { census: "measured" } }]);
  });

  it("coalesces concurrent census runs behind the in-flight guard", async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(measureStorageCensus).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }) as never
    );
    const { coordinator } = createHarness();

    const first = coordinator.recordCensus();
    const second = coordinator.recordCensus();
    resolve({ probeSetMs: 1 });
    await Promise.all([first, second]);

    expect(measureStorageCensus).toHaveBeenCalledTimes(1);
  });

  it("records a storageCensusError and clears the guard so a later run proceeds", async () => {
    vi.mocked(measureStorageCensus).mockRejectedValueOnce(new Error("probe failed"));
    const { coordinator, incidents } = createHarness();

    await coordinator.recordCensus();
    expect(incidents).toEqual([
      { event: "storageCensusError", detail: { message: "probe failed" } }
    ]);

    // Guard cleared in finally → a subsequent run is not blocked.
    vi.mocked(measureStorageCensus).mockResolvedValue({ probeSetMs: 2 } as never);
    await coordinator.recordCensus();
    expect(measureStorageCensus).toHaveBeenCalledTimes(2);
  });
});

describe("storage maintenance coordinator — orphan sweep", () => {
  it("skips the sweep entirely when the shard store is external", async () => {
    const { coordinator } = createHarness({ shardStoreExternal: true });

    coordinator.scheduleOrphanSweep();
    await vi.runAllTimersAsync();

    expect(sweepOrphanedV4Shards).not.toHaveBeenCalled();
  });

  it("schedules the sweep at most once per session", async () => {
    vi.mocked(sweepOrphanedV4Shards).mockResolvedValue({ removed: 0 } as never);
    const { coordinator } = createHarness({ shardStoreExternal: false });

    coordinator.scheduleOrphanSweep();
    coordinator.scheduleOrphanSweep();
    await vi.runAllTimersAsync();

    expect(sweepOrphanedV4Shards).toHaveBeenCalledTimes(1);
  });

  it("records the result only when shards were reclaimed", async () => {
    vi.mocked(sweepOrphanedV4Shards).mockResolvedValue({ removed: 3 } as never);
    const { coordinator, incidents } = createHarness({ shardStoreExternal: false });

    coordinator.scheduleOrphanSweep();
    await vi.runAllTimersAsync();

    expect(incidents).toEqual([{ event: "orphanShardSweep", detail: { removed: 3 } }]);
  });

  it("records nothing when the sweep reclaimed no shards", async () => {
    vi.mocked(sweepOrphanedV4Shards).mockResolvedValue({ removed: 0 } as never);
    const { coordinator, incidents } = createHarness({ shardStoreExternal: false });

    coordinator.scheduleOrphanSweep();
    await vi.runAllTimersAsync();

    expect(incidents).toEqual([]);
  });

  it("records an orphanShardSweepError when the sweep throws", async () => {
    vi.mocked(sweepOrphanedV4Shards).mockRejectedValue(new Error("scan failed"));
    const { coordinator, incidents } = createHarness({ shardStoreExternal: false });

    coordinator.scheduleOrphanSweep();
    await vi.runAllTimersAsync();

    expect(incidents).toEqual([
      { event: "orphanShardSweepError", detail: { message: "scan failed" } }
    ]);
  });
});
