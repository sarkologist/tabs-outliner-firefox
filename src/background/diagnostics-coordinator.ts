import type { OutlineState, RuntimeWindow } from "../model/types.js";
import type { PerformanceTracer } from "../perf/trace.js";
import { computeDiagnostics, type OutlineDiagnostics } from "./diagnostics.js";
import { getNormalWindows } from "./runtime-snapshot.js";

// Owns the advisory diagnostics readout (a Firefox-vs-outline tab count shown in the
// sidebar footer) and its two caches. Extracted from createBackgroundController (no
// behavior change) as a Track-B decomposition: a self-contained state slice — the
// in-flight promise, the last computed result, and the reused runtime-window snapshot —
// behind a small interface. It only ever *reads* the canonical state (via ensureState);
// it never mutates the outline, so it is disjoint from the controller's state triad.
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
    excludeWindowIds
  } = deps;

  let diagnosticsInFlight: Promise<OutlineDiagnostics> | undefined;
  let lastDiagnostics: { value: OutlineDiagnostics; atMs: number } | undefined;
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
        lastDiagnostics = { value, atMs: now() };
        return value;
      })
      .finally(() => {
        diagnosticsInFlight = undefined;
      });
    return diagnosticsInFlight;
  }

  return { getReadout, invalidateRuntimeCache, seedRuntimeWindows };
}
