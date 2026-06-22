import { describe, expect, it } from "vitest";

import {
  createDiagnosticsCoordinator,
  type DiagnosticsCoordinatorDeps
} from "./diagnostics-coordinator.js";
import type { MissingRuntimeTab } from "./diagnostics.js";
import { createPerformanceTracer } from "../perf/trace.js";
import { bootstrapFromWindows } from "../model/outline.js";
import type { RuntimeWindow } from "../model/types.js";

const RUNTIME_WINDOWS: RuntimeWindow[] = [
  {
    id: 10,
    focused: true,
    incognito: false,
    tabs: [
      {
        id: 1,
        windowId: 10,
        index: 0,
        active: true,
        url: "https://example.com/",
        title: "Example"
      },
      {
        id: 2,
        windowId: 10,
        index: 1,
        active: false,
        url: "https://example.com/child",
        title: "Child"
      }
    ]
  }
];

// An outline that knows about the first runtime tab but not the second, so tab 2 is "missing".
const ensureStateMissingTab2: DiagnosticsCoordinatorDeps["ensureState"] = async () =>
  bootstrapFromWindows([{ ...RUNTIME_WINDOWS[0]!, tabs: [RUNTIME_WINDOWS[0]!.tabs![0]!] }], {
    now: 1000
  });

type BrowserHits = { getAll: number; query: number };

// A minimal runtime API that records how often the readout reaches the browser. getNormalWindows
// queries windows.getAll + tabs.query; counting those is exactly the cost the coordinator's caches
// exist to avoid, so the call counts are the behavioural oracle for this seam.
function createCountingApi(hits: BrowserHits): DiagnosticsCoordinatorDeps["api"] {
  return {
    windows: {
      getAll: async () => {
        hits.getAll += 1;
        return RUNTIME_WINDOWS.map(({ tabs: _tabs, ...windowInfo }) => windowInfo);
      }
    },
    tabs: {
      query: async () => {
        hits.query += 1;
        return RUNTIME_WINDOWS.flatMap((windowInfo) => windowInfo.tabs ?? []);
      }
    }
  } as unknown as DiagnosticsCoordinatorDeps["api"];
}

function createHarness(overrides: Partial<DiagnosticsCoordinatorDeps> = {}) {
  const hits: BrowserHits = { getAll: 0, query: 0 };
  let nowMs = 1000;
  let schedulerIdle = true;
  let idleWaits = 0;
  const coordinator = createDiagnosticsCoordinator({
    api: createCountingApi(hits),
    perfTrace: createPerformanceTracer("background"),
    now: () => nowMs,
    ensureState: async () => bootstrapFromWindows(RUNTIME_WINDOWS, { now: 1000 }),
    waitForSchedulerIdle: async () => {
      idleWaits += 1;
    },
    isHighPrioritySchedulerIdle: () => schedulerIdle,
    ...overrides
  });
  return {
    coordinator,
    hits,
    idleWaits: () => idleWaits,
    setNow: (value: number) => {
      nowMs = value;
    },
    setSchedulerBusy: (busy: boolean) => {
      schedulerIdle = !busy;
    }
  };
}

describe("diagnostics coordinator", () => {
  it("serves the cached readout within the staleness window (one browser query)", async () => {
    const { coordinator, hits } = createHarness();

    const first = await coordinator.getReadout();
    const second = await coordinator.getReadout();

    expect(second).toEqual(first);
    expect(hits.getAll).toBe(1);
    expect(hits.query).toBe(1);
  });

  it("recomputes the readout after the staleness window but reuses the window snapshot", async () => {
    const { coordinator, hits, idleWaits, setNow } = createHarness();

    await coordinator.getReadout();
    expect(hits.getAll).toBe(1);
    expect(idleWaits()).toBe(1);

    // TTL is 1000ms; advance past it so the cached result is no longer fresh.
    setNow(1000 + 1001);
    await coordinator.getReadout();

    // The readout recomputes (a fresh scheduler-idle wait + recount)...
    expect(idleWaits()).toBe(2);
    // ...but the window snapshot persists across polls; only an observed runtime event re-queries.
    expect(hits.getAll).toBe(1);
  });

  it("serves a stale readout while a command is in flight, avoiding a mid-edit browser query", async () => {
    const { coordinator, hits, setNow, setSchedulerBusy } = createHarness();

    await coordinator.getReadout();
    expect(hits.getAll).toBe(1);

    // Past the TTL but with a high-priority mutation queued/running: the readout stays cached.
    setNow(1000 + 5000);
    setSchedulerBusy(true);
    await coordinator.getReadout();

    expect(hits.getAll).toBe(1);
  });

  it("uses a seeded window snapshot instead of querying the browser", async () => {
    const { coordinator, hits } = createHarness();

    coordinator.seedRuntimeWindows(RUNTIME_WINDOWS);
    await coordinator.getReadout();

    expect(hits.getAll).toBe(0);
    expect(hits.query).toBe(0);
  });

  it("drops the cached result and window snapshot on invalidateRuntimeCache", async () => {
    const { coordinator, hits } = createHarness();

    await coordinator.getReadout();
    expect(hits.getAll).toBe(1);

    coordinator.invalidateRuntimeCache();
    await coordinator.getReadout();

    expect(hits.getAll).toBe(2);
  });

  it("coalesces concurrent readouts into a single in-flight computation", async () => {
    const { coordinator, hits, idleWaits } = createHarness();

    const [a, b] = await Promise.all([coordinator.getReadout(), coordinator.getReadout()]);

    expect(a).toEqual(b);
    expect(hits.getAll).toBe(1);
    expect(idleWaits()).toBe(1);
  });

  it("records a missing runtime tab once with its detail, not on every poll", async () => {
    const calls: Array<{
      missing: MissingRuntimeTab[];
      summary: { runtimeTabCount: number; liveTabNodeCount: number };
    }> = [];
    const { coordinator, setNow } = createHarness({
      ensureState: ensureStateMissingTab2,
      recordMissingRuntimeTabs: (missing, summary) => {
        calls.push({ missing, summary });
      }
    });

    await coordinator.getReadout(); // recompute -> logs the newly missing tab
    await coordinator.getReadout(); // served from cache -> no recompute, no log
    setNow(1000 + 1001); // past the TTL
    await coordinator.getReadout(); // recompute, tab 2 still missing & already logged -> no re-log

    expect(calls).toHaveLength(1);
    expect(calls[0]!.missing).toEqual([
      { id: 2, windowId: 10, url: "https://example.com/child", title: "Child" }
    ]);
    expect(calls[0]!.summary).toEqual({ runtimeTabCount: 2, liveTabNodeCount: 1 });
  });

  it("does not record when no runtime tabs are missing", async () => {
    const calls: MissingRuntimeTab[][] = [];
    const { coordinator } = createHarness({
      recordMissingRuntimeTabs: (missing) => {
        calls.push(missing);
      }
    });

    await coordinator.getReadout();

    expect(calls).toHaveLength(0);
  });

  it("does not re-log a persistent missing tab after invalidateRuntimeCache", async () => {
    // A runtime event drops the caches on every tab/window change; the missing-tab throttle must
    // survive that, or a permanently missing tab would be logged on each event and flood the ring.
    const calls: MissingRuntimeTab[][] = [];
    const { coordinator } = createHarness({
      ensureState: ensureStateMissingTab2,
      recordMissingRuntimeTabs: (missing) => {
        calls.push(missing);
      }
    });

    await coordinator.getReadout(); // logs tab 2
    coordinator.invalidateRuntimeCache();
    await coordinator.getReadout(); // recompute, tab 2 still missing -> must NOT re-log

    expect(calls).toHaveLength(1);
  });
});
