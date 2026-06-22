import type { OutlineState, RuntimeWindow } from "../model/types.js";
import type { PerformanceTracer } from "../perf/trace.js";
import {
  computeDiagnostics,
  type MissingRuntimeTab,
  type OutlineDiagnostics
} from "./diagnostics.js";
import { getNormalWindows } from "./runtime-snapshot.js";

// Owns the advisory diagnostics readout (a Firefox-vs-outline tab count shown in the
// sidebar footer) and its two caches. Extracted from createBackgroundController (no
// behavior change) as a Track-B decomposition: a self-contained state slice — the
// in-flight promise, the last computed result, and the reused runtime-window snapshot —
// behind a small interface. It only ever *reads* the canonical state (via ensureState);
// it never mutates the outline, so it is disjoint from the controller's state triad. Its
// one side effect is advisory and injected: when the readout finds runtime tabs missing
// from the outline it forwards them to recordMissingRuntimeTabs (throttled) for the
// incident log — it still never touches outline state.
//
// The cross-cluster reads are injected as callbacks rather than reaching into the
// controller's closure: ensureState (canonical state), and the scheduler's
// waitForSchedulerIdle / isHighPrioritySchedulerIdle (so a readout neither recomputes
// mid-command nor races a pending mutation). The boot path seeds the window snapshot via
// seedRuntimeWindows; the runtime-refresh path drops both caches via invalidateRuntimeCache.

// Diagnostics are an advisory footer readout (a Firefox-vs-outline tab count), so a brief
// staleness window is acceptable. Reusing the last result within this window collapses the
// per-sidebar poll fan-out (3 sidebars re-arm after every command) into at most one
// scheduler-idle wait + browser-window query per window, keeping diagnostics off the
// single background thread's critical path while a command is in flight.
const DIAGNOSTICS_RESULT_TTL_MS = 1000;

// Ephemeral session key holding the tab ids already reported missing, so the missing-tab log
// throttle survives the background event page's idle/wake cycles (see loggedMissingTabIds).
const LOGGED_MISSING_RUNTIME_TAB_IDS_SESSION_KEY =
  "tabsOutliner:diagnostics:loggedMissingRuntimeTabIds";

export type DiagnosticsCoordinatorDeps = {
  api: WebExtensionBrowser;
  perfTrace: PerformanceTracer;
  now: () => number;
  /** The canonical outline state, loaded on demand. The readout reads it; it never mutates it. */
  ensureState: () => Promise<OutlineState>;
  /** Resolve once no mutation is queued or running, so the readout's browser query stays off the command path. */
  waitForSchedulerIdle: () => Promise<void>;
  /** Whether no high-priority mutation is queued/running; a busy scheduler serves the cached readout instead. */
  isHighPrioritySchedulerIdle: () => boolean;
  /**
   * The extension's own full-size popup window ids to exclude from the runtime-window snapshot, so a
   * full-size sidebar (which Firefox may transiently report as type:"normal") is not counted as a
   * real browser window in the Firefox-vs-outline readout. A getter because the set is live.
   */
  excludeWindowIds?: () => ReadonlySet<number>;
  /**
   * Record the runtime tabs missing from the outline (a live Firefox tab with no live tab node) so a
   * "missing N" is identifiable after the fact. Throttled by the coordinator: it fires only when a
   * tab id not previously seen-missing appears, so a persistently missing tab is logged once per
   * background worker rather than on every poll (or every cache invalidation). Optional — when
   * absent the readout is computed without the side effect.
   */
  recordMissingRuntimeTabs?: (
    missing: MissingRuntimeTab[],
    summary: { runtimeTabCount: number; liveTabNodeCount: number }
  ) => void;
};

export type DiagnosticsCoordinator = {
  /**
   * The cached, coalesced diagnostics readout. Serves the last result while it is fresh
   * (within DIAGNOSTICS_RESULT_TTL_MS) or whenever a command is in flight; otherwise waits
   * for the scheduler to idle, queries live windows once, and recomputes. Concurrent callers
   * share one in-flight computation.
   */
  getReadout(): Promise<OutlineDiagnostics>;
  /** Drop both the cached result and the cached window snapshot after an observed runtime event. */
  invalidateRuntimeCache(): void;
  /** Seed the reused window snapshot from a query that already ran (e.g. the startup load). */
  seedRuntimeWindows(windows: RuntimeWindow[]): void;
};

export function createDiagnosticsCoordinator(
  deps: DiagnosticsCoordinatorDeps
): DiagnosticsCoordinator {
  const {
    api,
    perfTrace,
    now,
    ensureState,
    waitForSchedulerIdle,
    isHighPrioritySchedulerIdle,
    excludeWindowIds,
    recordMissingRuntimeTabs
  } = deps;

  let diagnosticsInFlight: Promise<OutlineDiagnostics> | undefined;
  let lastDiagnostics: { value: OutlineDiagnostics; atMs: number } | undefined;
  // Tab ids already reported missing to recordMissingRuntimeTabs. A tab is logged once when it
  // first goes missing (and again only if it resolves and later reappears), not on every poll.
  // Mirrored to ephemeral storage.session and lazily hydrated from it (memoized promise) so the
  // throttle survives the background event page's idle/wake cycles: the worker restarts often, and
  // an in-memory-only set would re-log every persistent missing tab on each wake and flood the
  // bounded incident ring (session storage resets only on browser restart, where one re-log is
  // fine). Deliberately NOT cleared by invalidateRuntimeCache — runtime events invalidate the
  // result cache constantly, and re-logging a persistent missing tab on each would flood the log.
  let loggedMissingTabIds: Promise<Set<number>> | undefined;
  // Runtime-window snapshot reused by the readout so getNormalWindows (a browser
  // windows.getAll + tabs.query that cost up to ~2.5s on a large session, and contend with
  // the storage writes a delete triggers) runs only after a real tab/window event changes
  // browser state, not on every poll. Cleared together with lastDiagnostics by
  // invalidateRuntimeCache whenever a runtime event is observed.
  let diagnosticsRuntimeWindows: RuntimeWindow[] | undefined;

  // A runtime tab/window event can change the live tab set the diagnostics readout counts,
  // so drop both the cached result and the cached window snapshot; the next poll recomputes
  // from a fresh browser query. Between events the snapshot is reused (no getNormalWindows).
  function invalidateRuntimeCache(): void {
    lastDiagnostics = undefined;
    diagnosticsRuntimeWindows = undefined;
  }

  function seedRuntimeWindows(windows: RuntimeWindow[]): void {
    diagnosticsRuntimeWindows = windows;
  }

  function getReadout(): Promise<OutlineDiagnostics> {
    // Serve the cached readout when it is still fresh, OR whenever a command (high-priority
    // mutation) is queued or running: diagnostics await scheduler idle and then query the
    // browser for live windows, so recomputing here would pile a scheduler-idle wait plus a
    // browser-window query onto the single background thread right when the user is mid-edit.
    // The readout is advisory; the next poll after the command settles refreshes it.
    const cached = lastDiagnostics;
    if (
      cached &&
      (now() - cached.atMs < DIAGNOSTICS_RESULT_TTL_MS || !isHighPrioritySchedulerIdle())
    ) {
      return Promise.resolve(cached.value);
    }
    diagnosticsInFlight ??= perfTrace
      .measureAsync("background.diagnostics", async () => {
        await perfTrace.measureAsync("background.diagnostics.waitForIdle", () =>
          waitForSchedulerIdle()
        );
        const state = await ensureState();
        const windows = await perfTrace.measureAsync(
          "background.diagnostics.getWindows",
          async () => {
            diagnosticsRuntimeWindows ??= await getNormalWindows(api, excludeWindowIds?.());
            return diagnosticsRuntimeWindows;
          }
        );
        const value = computeDiagnostics(state, windows);
        await maybeRecordMissingRuntimeTabs(value);
        lastDiagnostics = { value, atMs: now() };
        return value;
      })
      .finally(() => {
        diagnosticsInFlight = undefined;
      });
    return diagnosticsInFlight;
  }

  // Forward newly-missing runtime tabs to the recorder, throttled: log only when the current
  // missing set contains an id not already logged (per the session-persisted set). The tracked
  // set becomes EXACTLY the current missing ids (not a union), so a tab is logged again if it
  // resolves and later reappears, while a tab that simply stays missing is logged once.
  async function maybeRecordMissingRuntimeTabs(value: OutlineDiagnostics): Promise<void> {
    if (!recordMissingRuntimeTabs) {
      return;
    }
    const logged = await readLoggedMissingTabIds();
    const currentMissing = value.missingRuntimeTabs;
    const hasNewlyMissing = currentMissing.some((tab) => !logged.has(tab.id));
    const nextLogged = new Set(currentMissing.map((tab) => tab.id));
    if (!sameIds(logged, nextLogged)) {
      persistLoggedMissingTabIds(nextLogged);
    }
    if (currentMissing.length > 0 && hasNewlyMissing) {
      recordMissingRuntimeTabs(currentMissing, {
        runtimeTabCount: value.runtimeTabCount,
        liveTabNodeCount: value.liveTabNodeCount
      });
    }
  }

  // Lazily hydrate the logged-missing set from storage.session once per worker (memoized), so the
  // throttle is seeded with what an earlier event-page lifetime already logged. Best-effort: a
  // missing/disabled session store just starts the set empty (degrades to per-worker throttling).
  function readLoggedMissingTabIds(): Promise<Set<number>> {
    loggedMissingTabIds ??= (async () => {
      const session = api.storage.session;
      if (!session || typeof session.get !== "function") {
        return new Set<number>();
      }
      try {
        const stored = await session.get(LOGGED_MISSING_RUNTIME_TAB_IDS_SESSION_KEY);
        const ids = stored[LOGGED_MISSING_RUNTIME_TAB_IDS_SESSION_KEY];
        return new Set(
          Array.isArray(ids) ? ids.filter((id): id is number => typeof id === "number") : []
        );
      } catch {
        return new Set<number>();
      }
    })();
    return loggedMissingTabIds;
  }

  function persistLoggedMissingTabIds(ids: Set<number>): void {
    loggedMissingTabIds = Promise.resolve(ids);
    const session = api.storage.session;
    if (!session || typeof session.set !== "function") {
      return;
    }
    try {
      void session
        .set({ [LOGGED_MISSING_RUNTIME_TAB_IDS_SESSION_KEY]: [...ids] })
        .catch(() => undefined);
    } catch {
      // Best-effort: the session mirror only narrows re-logging; losing it never breaks the readout.
    }
  }

  return { getReadout, invalidateRuntimeCache, seedRuntimeWindows };
}

function sameIds(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const id of b) {
    if (!a.has(id)) {
      return false;
    }
  }
  return true;
}
