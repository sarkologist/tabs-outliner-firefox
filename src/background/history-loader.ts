import type { AppPreferences } from "../preferences.js";
import type { PerformanceTracer } from "../perf/trace.js";
import type { KeyValueStore } from "./key-value-store.js";
import { loadHistory } from "./storage.js";
import { normalizeHistoryState, type HistoryState } from "./history.js";

// Owns the lazy-load + warmup machinery for the undo/redo history: the single-flight load promise
// and the warmup timer. Extracted from createBackgroundController (no behavior change) as a Track-B
// cut. This is deliberately NOT a full history extraction: the canonical `historyState` is mutated by
// the core command path (applyHistoryCommand / recordHistoryEntry), boot lifecycle recovery, and the
// preference-limit trim, so it is NOT a disjoint slice and stays a controller binding. Only the two
// vars touched solely by load/warmup — historyLoadInFlight and historyWarmupTimer — move here; the
// loader reads and seeds `historyState` through injected getHistoryState/setHistoryState callbacks,
// the same shape PersistenceCoordinator uses for `state`/`lastPersistedState`.

export type HistoryLoaderDeps = {
  api: WebExtensionBrowser;
  shardStore: KeyValueStore;
  perfTrace: PerformanceTracer;
  ensurePreferences: () => Promise<AppPreferences>;
  /** Read the controller-owned history binding (undefined until first loaded). */
  getHistoryState: () => HistoryState | undefined;
  /** Seed the controller-owned history binding after the first load. */
  setHistoryState: (history: HistoryState) => void;
};

export type HistoryLoader = {
  /** Return the loaded history, loading + normalizing it once (concurrent callers share one load). */
  ensure(): Promise<HistoryState>;
  /** Warm the history cache off a zero-delay timer if it is neither loaded nor loading. */
  scheduleWarmup(): void;
};

export function createHistoryLoader(deps: HistoryLoaderDeps): HistoryLoader {
  const { api, shardStore, perfTrace, ensurePreferences, getHistoryState, setHistoryState } = deps;

  let historyLoadInFlight: Promise<HistoryState> | undefined;
  let historyWarmupTimer: ReturnType<typeof setTimeout> | undefined;

  async function ensure(): Promise<HistoryState> {
    const activePreferences = await ensurePreferences();
    const existing = getHistoryState();
    if (existing) {
      return existing;
    }

    // Single-flight: reuse the in-flight load if one is already running, else start (and own) it.
    // Equivalent to the original `historyLoadInFlight ??= …; await historyLoadInFlight`, but written
    // so the awaited value types as HistoryState (the `.finally` reassignment blocks ??= narrowing).
    const loaded = await (historyLoadInFlight ??
      (historyLoadInFlight = loadHistory(api, activePreferences.undoHistoryLimit, shardStore)
        .then((entry) => normalizeHistoryState(entry, activePreferences.undoHistoryLimit))
        .finally(() => {
          historyLoadInFlight = undefined;
        })));
    setHistoryState(loaded);
    return loaded;
  }

  function warmHistoryCache(): void {
    if (getHistoryState() || historyLoadInFlight) {
      return;
    }
    void ensure().catch((error) => {
      perfTrace.mark("background.history.warm.error", { message: errorText(error) });
    });
  }

  function scheduleWarmup(): void {
    if (getHistoryState() || historyLoadInFlight || typeof historyWarmupTimer === "number") {
      return;
    }

    historyWarmupTimer = globalThis.setTimeout(() => {
      historyWarmupTimer = undefined;
      warmHistoryCache();
    }, 0);
  }

  return { ensure, scheduleWarmup };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
