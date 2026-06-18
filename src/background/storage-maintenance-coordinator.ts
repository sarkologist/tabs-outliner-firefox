import type { IncidentLogDetail } from "./incident-log.js";
import type { KeyValueStore } from "./key-value-store.js";
import { measureStorageCensus, storageCensusIncidentDetail } from "./storage-census.js";
import { sweepOrphanedV4Shards } from "./storage-v4.js";

// Owns the two fire-and-forget storage-hygiene operations that run off the critical path and
// record their outcome to the incident log: the opt-in storage census (run when the user turns
// profiling on) and the one-shot orphaned-shard sweep (deferred past startup). Extracted from
// createBackgroundController (no behavior change) as a Track-B decomposition: a self-contained
// state slice — the two in-flight/scheduled guard flags — behind a small interface. Neither
// operation reads or mutates the canonical outline state, so this is fully disjoint from the
// state triad; the controller wires it to its incident-log recorder via the recordIncidentLog dep.

// Defer the one-time orphaned-shard sweep past startup so first paint, hydration, and early
// interaction land first; its whole-store read is the same shape as the storage census.
const ORPHAN_SHARD_SWEEP_DELAY_MS = 8000;

export type StorageMaintenanceCoordinatorDeps = {
  api: WebExtensionBrowser;
  /** Where the bulk node shards live (IndexedDB in production, storage.local otherwise). */
  shardStore: KeyValueStore;
  /** True when an external shard store is injected; the orphan sweep is skipped entirely then. */
  shardStoreExternal: boolean;
  now: () => number;
  recordIncidentLog: (event: string, detail?: IncidentLogDetail) => Promise<void>;
};

export type StorageMaintenanceCoordinator = {
  /** Measure the live storage area once and record it to the incident log (no-op if already running). */
  recordCensus(): Promise<void>;
  /** Schedule the one-shot orphaned-shard reclaim past startup (no-op if external store or already scheduled). */
  scheduleOrphanSweep(): void;
};

export function createStorageMaintenanceCoordinator(
  deps: StorageMaintenanceCoordinatorDeps
): StorageMaintenanceCoordinator {
  const { api, shardStore, shardStoreExternal, now, recordIncidentLog } = deps;

  let storageCensusInFlight = false;
  let orphanShardSweepScheduled = false;

  // One-shot, opt-in storage census run when the user turns profiling on: it measures the
  // live storage.local area (a ~1 KB probe `set` to fingerprint the backend, per-prefix byte
  // breakdown, and the node-shard generation count as a leak signal) and records it to the
  // incident log, which the options page shows and which exported profiles bundle in
  // `snapshot.incidentLog`. This is the field measurement of the per-write cost ceiling that
  // cannot be read from the repo -- see docs/storage-rearchitecture/04-STORAGE-WRITE-COST.md.
  // It deliberately writes nothing to the perf trace (so it does not perturb a cleared trace);
  // it is fire-and-forget so the slow get(null)/probe on a large store never blocks the toggle.
  async function recordCensus(): Promise<void> {
    if (storageCensusInFlight) {
      return;
    }
    storageCensusInFlight = true;
    try {
      const census = await measureStorageCensus(api, { now });
      await recordIncidentLog("storageCensus", storageCensusIncidentDetail(census));
    } catch (error) {
      await recordIncidentLog("storageCensusError", { message: errorText(error) });
    } finally {
      storageCensusInFlight = false;
    }
  }

  // Reclaim leaked v4 node-shard generations (superseded copies of the tree that the shard GC never
  // collected -- historically hundreds, growing the store into the GB range and making every
  // whole-store read, including cold loads and the census, take tens of seconds). Off the startup
  // critical path: deferred so first paint/hydration land first, then fire-and-forget. Runs once
  // per session; with the GC baseline now seeded at startup the backlog does not re-accumulate.
  function scheduleOrphanSweep(): void {
    // DATA-LOSS FIX: the sweep deletes shard keys "no stored manifest references", reading the
    // stored manifests + scanning the shard store. With an external (IndexedDB) shard store the save
    // is split across substrates -- shards are written+committed to IndexedDB BEFORE the manifest is
    // committed to storage.local -- so during that window the just-written shards are not yet
    // referenced by any stored manifest. This fire-and-forget sweep (not serialized with saves) could
    // run in that window, delete those live shards, and then the manifest commit lands referencing
    // them -> the next load can't read them -> r2 salvage re-roots orphans and drops nodes. On the
    // legacy storage.local path the save was one atomic set, so this could not happen. The per-save GC
    // (removeKeysAfterCommit, serialized within the save) + the previousV4Snapshot seeding keep
    // generations bounded without this scan, so skip the sweep entirely when the shard store is
    // external. (A save-serialized sweep could be re-added later if orphan accumulation is ever seen.)
    if (shardStoreExternal) {
      return;
    }
    if (orphanShardSweepScheduled) {
      return;
    }
    orphanShardSweepScheduled = true;
    globalThis.setTimeout(() => {
      void runOrphanSweep();
    }, ORPHAN_SHARD_SWEEP_DELAY_MS);
  }

  async function runOrphanSweep(): Promise<void> {
    try {
      const result = await sweepOrphanedV4Shards(api, shardStore);
      if (result.removed > 0) {
        await recordIncidentLog("orphanShardSweep", result);
      }
    } catch (error) {
      await recordIncidentLog("orphanShardSweepError", { message: errorText(error) });
    }
  }

  return { recordCensus, scheduleOrphanSweep };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
