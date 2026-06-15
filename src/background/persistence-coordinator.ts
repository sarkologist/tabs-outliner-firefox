import {
  HISTORY_KEY,
  STATE_KEY,
  outlineBootSnapshotItem
} from "./storage.js";
import {
  STATE_V4_MIGRATION_BACKUP_KEY,
  STATE_V4_MIGRATION_BACKUP_META_KEY,
  STATE_V4_NODE_SHARD_COUNT,
  loadStateV4,
  outlineStateV4Snapshot,
  stateV4ShardIndexForNodeId,
  type StateV4Manifest,
  type StateV4ManifestSlot
} from "./storage-v4.js";
import {
  JOURNAL_META_KEY,
  JOURNAL_SPILL_NODE_LIMIT,
  JournalFullError,
  createOutlineJournal,
  migrateJournalStore,
  outlineJournalDeltaWeight,
  type OutlineJournal,
  type OutlineJournalAppendItem
} from "./outline-journal.js";
import { outlineMaterialDelta, type HistoryState } from "./history.js";
import { storageLocalKvStore, type KeyValueStore } from "./key-value-store.js";
import { sameNodeIdList, statesMateriallyEqual } from "./state-equality.js";
import { uniqueDefinedNodeIds } from "./live-node-queries.js";
import { cloneOutlineNode } from "../model/outline.js";
import { exportPortableTree } from "../model/portable-tree.js";
import type { NodeId, OutlineState } from "../model/types.js";
import type { NodeStateUpdate, TreeStructureUpdate } from "./patch-updates.js";
import type { IncidentLogDetail } from "./incident-log.js";
import type { PerformanceTracer } from "../perf/trace.js";
import {
  outlineStateCountDetail,
  emptyOutlineStateCountDetail,
  outlineStateCountDeltaDetail
} from "./outline-state-metrics.js";

// Owns the deferred-save engine (debounce + flush + failure backoff + boot snapshot) and the
// outline journal (command/event delta append, coalescing, spill, v4 compaction, and the
// one-time legacy->v4 migration). Extracted from createBackgroundController as the Track-B
// "#8" sub-system: the most cohesive but also the largest state slice. No behavior change.
//
// What stays in the controller and is injected here as deps: the canonical `state` and
// `lastPersistedState` (read via getState/getLastPersistedState; the save baseline advances
// through deferPersistedStateBaselineClone on success and setLastPersistedState(undefined) on
// failure), the incident log, and the runtime-lifecycle-journal clear that pairs with a save.
// The journal + v4 snapshot are owned here but seeded by the boot phase through
// createAndInitJournal and adoptLoadedV4Snapshot.

const STATE_SAVE_QUIET_DELAY_MS = 1000;
const STATE_SAVE_MAX_DELAY_MS = 5000;
const INTERACTION_STATE_SAVE_QUIET_DELAY_MS = 5000;
const INTERACTION_STATE_SAVE_MAX_DELAY_MS = 30000;
// A save flush only records an incident when it is anomalous: a sharp drop in closed
// or total node count is the signature of the data-loss family. Routine flushes are
// silent so the bounded incident log stays a signal rather than a per-save diary.
const SAVE_FLUSH_ANOMALY_CLOSED_DELTA = -25;
const SAVE_FLUSH_ANOMALY_NODE_DELTA = -50;
// After a failed state save the next attempt is retried with growing backoff so a
// transient storage error does not silently drop the pending change.
const SAVE_FAILURE_BACKOFF_MS = [1000, 4000, 16000] as const;
// Runtime-event deltas (Class B: native closes, creates, moves, metadata) are journaled on
// a short coalescer instead of per event: bursts become one slot write, and the accepted
// loss window on process death is the max delay below (vs 1-30s of deferred-save loss).
const EVENT_JOURNAL_QUIET_DELAY_MS = 50;
const EVENT_JOURNAL_MAX_DELAY_MS = 250;
// The boot snapshot is a cold-start-only first-paint cache, written on its own debounce
// rather than embedded in every save's manifest. Staleness up to this window is harmless:
// it is superseded by full hydration immediately after first paint.
const BOOT_SNAPSHOT_WRITE_DELAY_MS = 10000;

export type SaveSchedule = "normal" | "interaction";

type V4SnapshotRef = { manifest: StateV4Manifest; slot: StateV4ManifestSlot };

export type PersistenceCoordinatorDeps = {
  api: WebExtensionBrowser;
  // Backing store for the hot-path outline journal. Defaults to a `storage.local` pass-through;
  // a later step injects an IndexedDB-backed store here so journal appends stop paying the
  // whole-store-rewrite cost. See docs/storage-rearchitecture/04-STORAGE-WRITE-COST.md section 6.
  journalStore?: KeyValueStore;
  perfTrace: PerformanceTracer;
  now: () => number;
  getState: () => OutlineState | undefined;
  getLastPersistedState: () => OutlineState | undefined;
  setLastPersistedState: (state: OutlineState | undefined) => void;
  deferPersistedStateBaselineClone: (persisted: OutlineState) => void;
  recordIncidentLog: (event: string, detail?: IncidentLogDetail) => Promise<void>;
  clearCompletedRuntimeLifecycleJournalEntriesAfterSave: () => Promise<void>;
};

export function createPersistenceCoordinator(deps: PersistenceCoordinatorDeps) {
  const {
    api,
    journalStore = storageLocalKvStore(api),
    perfTrace,
    now,
    getState,
    getLastPersistedState,
    setLastPersistedState,
    deferPersistedStateBaselineClone,
    recordIncidentLog,
    clearCompletedRuntimeLifecycleJournalEntriesAfterSave
  } = deps;

  let pendingSaveState: OutlineState | undefined;
  let pendingSaveHistory: HistoryState | undefined;
  let pendingSaveCandidateNodeIds: Set<NodeId> | undefined;
  let pendingSaveRequiresFullDiff = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saveMaxTimer: ReturnType<typeof setTimeout> | undefined;
  let saveInFlight: Promise<void> | undefined;
  let saveAfterInFlight = false;
  let saveAfterInFlightSchedule: SaveSchedule = "normal";
  let explicitSaveFlushInProgress = false;
  let pendingSaveBatchStartedAt: number | undefined;
  let pendingSaveMaxDelayMs: number | undefined;
  let saveFailureBackoffIndex = 0;
  let bootSnapshotTimer: ReturnType<typeof setTimeout> | undefined;
  let outlineJournal: OutlineJournal | undefined;
  // The active v4 snapshot (manifest + the slot it occupies). Undefined until the first v4
  // load, migration, or full compaction of this session.
  let currentV4Snapshot: V4SnapshotRef | undefined;
  // The snapshot currentV4Snapshot superseded (still stored in the other manifest slot, the
  // R1 fallback). The next compaction overwrites its slot, at which point the shard keys
  // only it referenced become collectable -- never earlier (I-5).
  let previousV4Snapshot: V4SnapshotRef | undefined;
  // Shard indexes touched by journal appends since the last compaction that folded them in.
  // Unioned with the pending save's candidate shards to compute a compaction's dirty set.
  let journalTouchedSinceCompaction = new Set<number>();
  let pendingEventJournalItems: OutlineJournalAppendItem[] = [];
  let eventJournalQuietTimer: ReturnType<typeof setTimeout> | undefined;
  let eventJournalMaxTimer: ReturnType<typeof setTimeout> | undefined;
  let eventJournalBatchStartedAt: number | undefined;
  let pendingSaveSchedule: SaveSchedule | undefined;

  function scheduleStateSave(
    next: OutlineState,
    schedule: SaveSchedule = "normal",
    candidateNodeIds?: readonly NodeId[]
  ): void {
    pendingSaveState = next;
    // Candidates only widen the compaction's dirty-shard set; deletions need no full-save
    // promotion because a dirty shard is rebuilt wholesale from current state (a deleted
    // node is simply absent from the rebuilt shard). No candidates means a broad change:
    // every shard is dirty.
    if (candidateNodeIds) {
      if (!pendingSaveRequiresFullDiff) {
        pendingSaveCandidateNodeIds ??= new Set<NodeId>();
        for (const nodeId of candidateNodeIds) {
          pendingSaveCandidateNodeIds.add(nodeId);
        }
      }
    } else {
      pendingSaveCandidateNodeIds = undefined;
      pendingSaveRequiresFullDiff = true;
    }
    schedulePendingSave(schedule);
    scheduleBootSnapshotWrite();
  }

  // Refresh the cold-start boot snapshot off the interaction path. Debounced and never part
  // of a save flush, so a one-node change no longer reserializes the 256-row snapshot.
  function scheduleBootSnapshotWrite(): void {
    if (bootSnapshotTimer !== undefined) {
      return;
    }
    bootSnapshotTimer = globalThis.setTimeout(() => {
      bootSnapshotTimer = undefined;
      void writeBootSnapshot();
    }, BOOT_SNAPSHOT_WRITE_DELAY_MS);
  }

  async function writeBootSnapshot(): Promise<void> {
    const current = getState();
    if (!current) {
      return;
    }
    try {
      await perfTrace.measureAsync("background.state.bootSnapshot.write", () =>
        api.storage.local.set(outlineBootSnapshotItem(current, now()))
      );
    } catch (error) {
      perfTrace.mark("background.state.bootSnapshot.error", { message: errorText(error) });
    }
  }

  function scheduleHistorySave(next: HistoryState, schedule: SaveSchedule = "normal"): void {
    pendingSaveHistory = next;
    schedulePendingSave(schedule);
  }

  function schedulePendingSave(schedule: SaveSchedule = "normal"): void {
    if (saveInFlight) {
      saveAfterInFlight = true;
      saveAfterInFlightSchedule = moreDeferredSaveSchedule(saveAfterInFlightSchedule, schedule);
      return;
    }

    pendingSaveSchedule = moreDeferredSaveSchedule(pendingSaveSchedule ?? "normal", schedule);
    const timing = saveScheduleTiming(pendingSaveSchedule);
    const scheduledAt = performance.now();
    pendingSaveBatchStartedAt ??= scheduledAt;
    pendingSaveMaxDelayMs = Math.max(pendingSaveMaxDelayMs ?? 0, timing.maxDelayMs);

    if (saveTimer !== undefined) {
      globalThis.clearTimeout(saveTimer);
    }
    saveTimer = globalThis.setTimeout(() => {
      void flushScheduledSave();
    }, timing.quietDelayMs);

    if (saveMaxTimer !== undefined) {
      globalThis.clearTimeout(saveMaxTimer);
    }
    saveMaxTimer = globalThis.setTimeout(() => {
      void flushScheduledSave();
    }, Math.max(0, pendingSaveBatchStartedAt + pendingSaveMaxDelayMs - scheduledAt));
  }

  async function flushPendingSaves(): Promise<void> {
    clearSaveTimers();

    const previousExplicitSaveFlushInProgress = explicitSaveFlushInProgress;
    explicitSaveFlushInProgress = true;
    try {
      while (pendingSaveState || pendingSaveHistory || saveInFlight) {
        if (saveInFlight) {
          await saveInFlight;
          continue;
        }

        const nextState = pendingSaveState;
        const nextHistory = pendingSaveHistory;
        const nextCandidateNodeIds = pendingSaveRequiresFullDiff
          ? undefined
          : [...(pendingSaveCandidateNodeIds ?? [])];
        if (!nextState && !nextHistory) {
          return;
        }
        pendingSaveState = undefined;
        pendingSaveHistory = undefined;
        pendingSaveCandidateNodeIds = undefined;
        pendingSaveRequiresFullDiff = false;
        saveAfterInFlight = false;
        await startSaveStateAndHistory(nextState, nextHistory, nextCandidateNodeIds);
      }
    } finally {
      explicitSaveFlushInProgress = previousExplicitSaveFlushInProgress;
      if (saveAfterInFlight) {
        const schedule = saveAfterInFlightSchedule;
        saveAfterInFlight = false;
        saveAfterInFlightSchedule = "normal";
        if (!explicitSaveFlushInProgress && (pendingSaveState || pendingSaveHistory)) {
          schedulePendingSave(schedule);
        }
      }
    }
  }

  async function flushScheduledSave(): Promise<void> {
    try {
      clearSaveTimers();
      if (saveInFlight) {
        saveAfterInFlight = true;
        return;
      }

      const nextState = pendingSaveState;
      const nextHistory = pendingSaveHistory;
      const nextCandidateNodeIds = pendingSaveRequiresFullDiff
        ? undefined
        : [...(pendingSaveCandidateNodeIds ?? [])];
      if (!nextState && !nextHistory) {
        return;
      }

      pendingSaveState = undefined;
      pendingSaveHistory = undefined;
      pendingSaveCandidateNodeIds = undefined;
      pendingSaveRequiresFullDiff = false;
      await startSaveStateAndHistory(nextState, nextHistory, nextCandidateNodeIds);
    } catch (error) {
      perfTrace.mark("background.state.save.error", { message: errorText(error) });
    }
  }

  function clearSaveTimers(): void {
    if (saveTimer !== undefined) {
      globalThis.clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    if (saveMaxTimer !== undefined) {
      globalThis.clearTimeout(saveMaxTimer);
      saveMaxTimer = undefined;
    }
    pendingSaveBatchStartedAt = undefined;
    pendingSaveMaxDelayMs = undefined;
    pendingSaveSchedule = undefined;
  }

  function pausePendingSaveTimers(): SaveSchedule | undefined {
    const pausedSchedule = pendingSaveSchedule;
    clearSaveTimers();
    return pausedSchedule;
  }

  function resumePendingSaveTimers(schedule: SaveSchedule | undefined): void {
    if (!pendingSaveState && !pendingSaveHistory) {
      return;
    }
    schedulePendingSave(schedule ?? "normal");
  }

  function saveScheduleTiming(schedule: SaveSchedule): { quietDelayMs: number; maxDelayMs: number } {
    return schedule === "interaction"
      ? {
          quietDelayMs: INTERACTION_STATE_SAVE_QUIET_DELAY_MS,
          maxDelayMs: INTERACTION_STATE_SAVE_MAX_DELAY_MS
        }
      : {
          quietDelayMs: STATE_SAVE_QUIET_DELAY_MS,
          maxDelayMs: STATE_SAVE_MAX_DELAY_MS
        };
  }

  function moreDeferredSaveSchedule(left: SaveSchedule, right: SaveSchedule): SaveSchedule {
    return left === "interaction" || right === "interaction" ? "interaction" : "normal";
  }

  async function saveStateAndHistoryNowWithTrace(
    nextState: OutlineState | undefined,
    nextHistory: HistoryState | undefined,
    candidateNodeIds?: readonly NodeId[]
  ): Promise<void> {
    const baseline = getLastPersistedState();
    const nextCountDetail = nextState ? outlineStateCountDetail(nextState) : undefined;
    const previousCountDetail = baseline
      ? outlineStateCountDetail(baseline)
      : emptyOutlineStateCountDetail();
    const saveIncidentDetail = nextState
      ? {
          candidateNodeCount: candidateNodeIds?.length ?? 0,
          fullDiff: !candidateNodeIds,
          fullSave: !baseline,
          hasHistory: Boolean(nextHistory),
          ...nextCountDetail,
          ...outlineStateCountDeltaDetail(previousCountDetail, nextCountDetail!)
        }
      : undefined;
    // Only stamp journalSeqIncluded when this save serializes the current state: then the
    // snapshot reflects every journaled delta up to the current headSeq and those entries
    // can be pruned. For an older queued snapshot, leave it unstamped (loader replays all,
    // idempotently). Captured synchronously so it pairs with nextState atomically.
    const journalSeqIncluded = nextState && nextState === getState() ? outlineJournal?.headSeq() : undefined;
    // A compaction of the current state subsumes every queued (not yet appended) event
    // delta: their content is in the snapshot, so they are dropped on success and restored
    // on failure. Items queued during the write stay queued (they may postdate nextState).
    const subsumedEventItems = journalSeqIncluded !== undefined ? drainPendingEventJournalItems() : [];
    try {
      await perfTrace.measureAsync("background.state.save", async () => {
        const setItems: Record<string, unknown> = {};
        let v4Snapshot: ReturnType<typeof outlineStateV4Snapshot> | undefined;
        if (nextState) {
          // Dirty set: shards of the flush's candidates plus shards touched by journal
          // appends since the last fully-stamped compaction. No candidates (full-diff
          // promotion, startup rewrites, failure retries) means every shard is dirty.
          // Swap the journal-touched set out before the await so appends that land during
          // the write re-arm cleanly for the next compaction.
          const journalTouched = journalTouchedSinceCompaction;
          if (journalSeqIncluded !== undefined) {
            journalTouchedSinceCompaction = new Set();
          }
          // A loaded store written at a different shard count must be re-sharded wholesale: an
          // incremental write would stamp the new-layout shards the old manifest never had at
          // generation 0 (non-existent keys), corrupting the snapshot. Force one full compaction.
          const shardCountChanged =
            currentV4Snapshot !== undefined &&
            currentV4Snapshot.manifest.shardGenerations.length !== STATE_V4_NODE_SHARD_COUNT;
          const fullCompaction = !candidateNodeIds || !currentV4Snapshot || shardCountChanged;
          const dirtyShardIndexes = fullCompaction
            ? undefined
            : new Set([
                ...[...candidateNodeIds!].map(stateV4ShardIndexForNodeId),
                ...journalTouched
              ]);
          v4Snapshot = outlineStateV4Snapshot(nextState, {
            epoch: outlineJournal?.epoch() ?? 0,
            journalSeqIncluded: journalSeqIncluded ?? currentV4Snapshot?.manifest.journalSeqIncluded ?? 0,
            savedAt: now(),
            ...(currentV4Snapshot ? { previous: currentV4Snapshot } : {}),
            // This write evicts the manifest two compactions back from its slot; only the
            // keys solely referenced by that manifest are collectable (keeps R1 loadable).
            ...(previousV4Snapshot ? { collect: previousV4Snapshot.manifest } : {}),
            ...(dirtyShardIndexes ? { dirtyShardIndexes } : {})
          });
          Object.assign(setItems, v4Snapshot.setItems);
          perfTrace.mark("background.state.save.v4.compact", {
            fullCompaction,
            dirtyShardCount: dirtyShardIndexes ? dirtyShardIndexes.size : v4Snapshot.manifest.shardGenerations.length,
            setKeys: Object.keys(v4Snapshot.setItems).length,
            removeKeys: v4Snapshot.removeKeysAfterCommit.length,
            generation: v4Snapshot.manifest.generation
          });
        }
        if (nextHistory) {
          setItems[HISTORY_KEY] = nextHistory;
        }
        if (Object.keys(setItems).length > 0) {
          await api.storage.local.set(setItems);
        }
        if (v4Snapshot) {
          previousV4Snapshot = currentV4Snapshot;
          currentV4Snapshot = { manifest: v4Snapshot.manifest, slot: v4Snapshot.slot };
          if (v4Snapshot.removeKeysAfterCommit.length > 0) {
            // Keys no stored manifest references anymore; a failed remove is harmless garbage.
            void api.storage.local.remove(v4Snapshot.removeKeysAfterCommit).catch((error) => {
              perfTrace.mark("background.state.save.v4.gc.error", { message: errorText(error) });
            });
          }
        }
      });
    } catch (error) {
      if (subsumedEventItems.length > 0) {
        pendingEventJournalItems = [...subsumedEventItems, ...pendingEventJournalItems];
        armEventJournalTimers();
      }
      handleStateSaveFailure(nextState, nextHistory, error);
      throw error;
    }
    saveFailureBackoffIndex = 0;
    if (journalSeqIncluded !== undefined && outlineJournal && outlineJournal.pendingEntryCount() > 0) {
      await outlineJournal.prune(journalSeqIncluded);
    }
    if (saveIncidentDetail && nextCountDetail) {
      const closedCountDelta = nextCountDetail.closedCount - previousCountDetail.closedCount;
      const nodeCountDelta = nextCountDetail.nodeCount - previousCountDetail.nodeCount;
      if (
        closedCountDelta <= SAVE_FLUSH_ANOMALY_CLOSED_DELTA ||
        nodeCountDelta <= SAVE_FLUSH_ANOMALY_NODE_DELTA
      ) {
        await recordIncidentLog("saveFlushAnomaly", saveIncidentDetail);
      }
    }
    if (nextState) {
      deferPersistedStateBaselineClone(nextState);
    }
    if (nextState || nextHistory) {
      await clearCompletedRuntimeLifecycleJournalEntriesAfterSave();
    }
  }

  function handleStateSaveFailure(
    nextState: OutlineState | undefined,
    nextHistory: HistoryState | undefined,
    error: unknown
  ): void {
    // A partial write may have landed, so the in-memory baseline can no longer be
    // trusted; force the retry to rewrite the full state rather than an incremental diff.
    setLastPersistedState(undefined);
    pendingSaveRequiresFullDiff = true;
    pendingSaveCandidateNodeIds = undefined;
    // Re-queue the snapshot we just failed to persist, unless a newer mutation already
    // superseded it.
    if (nextState && !pendingSaveState) {
      pendingSaveState = nextState;
    }
    if (nextHistory && !pendingSaveHistory) {
      pendingSaveHistory = nextHistory;
    }
    void recordIncidentLog("stateSaveFailed", {
      message: errorText(error),
      backoffIndex: saveFailureBackoffIndex
    });
    armSaveFailureRetryTimer();
  }

  function armSaveFailureRetryTimer(): void {
    const delayMs = SAVE_FAILURE_BACKOFF_MS[Math.min(saveFailureBackoffIndex, SAVE_FAILURE_BACKOFF_MS.length - 1)];
    saveFailureBackoffIndex += 1;
    if (saveTimer !== undefined) {
      globalThis.clearTimeout(saveTimer);
    }
    saveTimer = globalThis.setTimeout(() => {
      void flushScheduledSave();
    }, delayMs);
  }

  // Build a journal delta item from a state transition, or undefined when nothing changed.
  // candidateNodeIds narrows the diff to O(candidates); root changes are detected separately.
  function journalDeltaItem(
    previous: OutlineState,
    next: OutlineState,
    candidateNodeIds: readonly NodeId[] | undefined,
    kind: OutlineJournalAppendItem["kind"],
    label: string,
    historyEntryId?: string
  ): OutlineJournalAppendItem | undefined {
    const delta = outlineMaterialDelta(previous, next, candidateNodeIds);
    const rootsChanged = !sameNodeIdList(previous.rootIds, next.rootIds);
    if (delta.updatedNodes.length === 0 && delta.deletedNodeIds.length === 0 && !rootsChanged) {
      return undefined;
    }
    return {
      kind,
      label,
      ...(historyEntryId !== undefined ? { historyEntryId } : {}),
      delta: {
        ...(delta.updatedNodes.length > 0 ? { updatedNodes: delta.updatedNodes } : {}),
        ...(delta.deletedNodeIds.length > 0 ? { deletedNodeIds: delta.deletedNodeIds } : {}),
        ...(rootsChanged ? { rootIds: [...next.rootIds] } : {})
      }
    };
  }

  // Append a command's delta to the journal before its ack so the change survives a restart
  // before the deferred v3 save lands (invariant I-1). Returns true when the delta (including
  // any runtime-provenance change) was durably journaled, letting the caller skip the
  // runtime-truth checkpoint flush. Returns false when the delta is empty or too heavy to
  // journal cheaply, in which case the caller keeps the checkpoint flush for durability.
  async function appendCommandJournal(
    previous: OutlineState,
    next: OutlineState,
    candidateNodeIds: readonly NodeId[] | undefined,
    label: string,
    kind: "command" | "historyReplay" = "command",
    historyEntryId?: string
  ): Promise<boolean> {
    if (!outlineJournal) {
      return false;
    }
    // Any coalesced event deltas captured before this command must land first so journal
    // seq order stays chronological (replay applies absolute node records in seq order).
    const queuedEventItems = drainPendingEventJournalItems();
    const item = journalDeltaItem(previous, next, candidateNodeIds, kind, label, historyEntryId);
    if (!item) {
      // No durable change to record (e.g. a no-op move); nothing for the checkpoint to flush.
      await appendOutlineJournalItems(queuedEventItems);
      return true;
    }
    // The journal module is the single spill authority (node/childIds weight plus a byte
    // cap): a too-heavy delta is durably recorded as a delta-less spill marker instead.
    // When that happens the change itself is NOT in the journal, so report false -- the
    // caller keeps its checkpoint flush, and the spill already tightened the save schedule.
    const spilled = await appendOutlineJournalItems([...queuedEventItems, item]);
    return !spilled;
  }

  // A spill means the journal does NOT carry the change, so the snapshot save must land
  // soon. schedulePendingSave alone would keep the more-deferred interaction schedule
  // (moreDeferredSaveSchedule escalates, never tightens), so reset the schedule first.
  function tightenPendingSaveScheduleAfterSpill(): void {
    pendingSaveSchedule = "normal";
    pendingSaveBatchStartedAt = undefined;
    pendingSaveMaxDelayMs = undefined;
    schedulePendingSave("normal");
  }

  // Journal a command whose model op mutates the live state in place (toggleCollapsed,
  // expandAncestors): previous === next there, so a diff sees nothing -- the delta is built
  // directly from the known changed node ids instead.
  async function appendCommandJournalForKnownNodeIds(
    next: OutlineState,
    nodeIds: readonly NodeId[],
    label: string,
    historyEntryId?: string
  ): Promise<boolean> {
    if (!outlineJournal) {
      return false;
    }
    const queuedEventItems = drainPendingEventJournalItems();
    const updatedNodes = uniqueDefinedNodeIds([...nodeIds]).flatMap((nodeId) => {
      const node = next.nodes[nodeId];
      return node ? [cloneOutlineNode(node)] : [];
    });
    if (updatedNodes.length === 0) {
      await appendOutlineJournalItems(queuedEventItems);
      return true;
    }
    const spilled = await appendOutlineJournalItems([
      ...queuedEventItems,
      {
        kind: "command",
        label,
        ...(historyEntryId !== undefined ? { historyEntryId } : {}),
        delta: { updatedNodes }
      }
    ]);
    return !spilled;
  }

  // Queue a runtime-event delta for coalesced journaling. Returns true when the transition
  // is durably covered (queued, or nothing material changed), false when the caller must
  // keep its checkpoint flush (no journal, no candidates, or a too-heavy delta).
  function queueRuntimeEventJournal(
    previous: OutlineState,
    next: OutlineState,
    candidateNodeIds: readonly NodeId[] | undefined,
    label: string
  ): boolean {
    if (!outlineJournal || !candidateNodeIds) {
      return false;
    }
    const item = journalDeltaItem(previous, next, candidateNodeIds, "runtimeEvent", label);
    if (!item) {
      return true;
    }
    return queueEventJournalItem(item);
  }

  // The runtime fast path mutates the live state in place, so its delta cannot be diffed
  // from previous/next -- the broadcast update payload already enumerates the changed nodes.
  function queueRuntimeEventJournalFromUpdate(
    update: TreeStructureUpdate | NodeStateUpdate,
    label: string
  ): boolean {
    if (!outlineJournal) {
      return false;
    }
    const updatedNodes = update.updatedNodes.map(cloneOutlineNode);
    const deletedNodeIds = update.type === "treeStructureUpdated" ? [...update.deletedNodeIds] : [];
    if (updatedNodes.length === 0 && deletedNodeIds.length === 0) {
      return true;
    }
    return queueEventJournalItem({
      kind: "runtimeEvent",
      label,
      delta: {
        ...(updatedNodes.length > 0 ? { updatedNodes } : {}),
        ...(deletedNodeIds.length > 0 ? { deletedNodeIds } : {}),
        ...(update.type === "treeStructureUpdated" ? { rootIds: [...update.rootIds] } : {})
      }
    });
  }

  function queueEventJournalItem(item: OutlineJournalAppendItem): boolean {
    // Events have no ack to anchor a synchronous spill response, so a weight-heavy delta is
    // declined here (the caller keeps its checkpoint flush where wired) and the pending
    // save is tightened so the un-journaled change reaches the snapshot within seconds even
    // at call sites that do not check the return value. Byte-heavy deltas that pass this
    // cheap pre-check are caught at flush time by the journal's spill authority, which also
    // tightens the schedule.
    if (item.delta && outlineJournalDeltaWeight(item.delta) > JOURNAL_SPILL_NODE_LIMIT) {
      tightenPendingSaveScheduleAfterSpill();
      return false;
    }
    pendingEventJournalItems.push(item);
    armEventJournalTimers();
    return true;
  }

  function armEventJournalTimers(): void {
    const scheduledAt = performance.now();
    eventJournalBatchStartedAt ??= scheduledAt;
    if (eventJournalQuietTimer !== undefined) {
      globalThis.clearTimeout(eventJournalQuietTimer);
    }
    eventJournalQuietTimer = globalThis.setTimeout(() => {
      void flushEventJournalQueue();
    }, EVENT_JOURNAL_QUIET_DELAY_MS);
    if (eventJournalMaxTimer === undefined) {
      eventJournalMaxTimer = globalThis.setTimeout(() => {
        void flushEventJournalQueue();
      }, Math.max(0, eventJournalBatchStartedAt + EVENT_JOURNAL_MAX_DELAY_MS - scheduledAt));
    }
  }

  function drainPendingEventJournalItems(): OutlineJournalAppendItem[] {
    if (eventJournalQuietTimer !== undefined) {
      globalThis.clearTimeout(eventJournalQuietTimer);
      eventJournalQuietTimer = undefined;
    }
    if (eventJournalMaxTimer !== undefined) {
      globalThis.clearTimeout(eventJournalMaxTimer);
      eventJournalMaxTimer = undefined;
    }
    eventJournalBatchStartedAt = undefined;
    const items = pendingEventJournalItems;
    pendingEventJournalItems = [];
    return items;
  }

  async function flushEventJournalQueue(): Promise<void> {
    const items = drainPendingEventJournalItems();
    if (items.length === 0) {
      return;
    }
    try {
      await appendOutlineJournalItems(items);
    } catch (error) {
      // Class B: a failed coalesced append falls back to the deferred snapshot save.
      perfTrace.mark("background.journal.event.error", { message: errorText(error) });
    }
  }

  // Appends items and returns whether the journal spilled any of them (recorded a delta-less
  // marker instead of the delta). A spill means the change is NOT recoverable from the
  // journal, so the pending save schedule is tightened here for every caller.
  async function appendOutlineJournalItems(items: OutlineJournalAppendItem[]): Promise<boolean> {
    if (!outlineJournal || items.length === 0) {
      return false;
    }
    try {
      const result = await perfTrace.measureAsync("background.journal.append", { entries: items.length }, () =>
        outlineJournal!.append(items)
      );
      for (const item of items) {
        for (const node of item.delta?.updatedNodes ?? []) {
          journalTouchedSinceCompaction.add(stateV4ShardIndexForNodeId(node.id));
        }
        for (const nodeId of item.delta?.deletedNodeIds ?? []) {
          journalTouchedSinceCompaction.add(stateV4ShardIndexForNodeId(nodeId));
        }
      }
      if (result.spilled) {
        perfTrace.mark("background.journal.spill", { entries: items.length });
        tightenPendingSaveScheduleAfterSpill();
      }
      return result.spilled;
    } catch (error) {
      if (error instanceof JournalFullError) {
        await compactOutlineJournal();
        return appendOutlineJournalItems(items);
      }
      throw error;
    }
  }

  // Interim compaction: fold the current state into a v3 snapshot (stamping journalSeqIncluded)
  // and prune the journal. Phase 3 replaces this with the v4 shadow-paged compactor.
  async function compactOutlineJournal(): Promise<void> {
    const current = getState();
    if (!outlineJournal || !current) {
      return;
    }
    const throughSeq = outlineJournal.headSeq();
    scheduleStateSave(current);
    await flushPendingSaves();
    await outlineJournal.prune(throughSeq);
  }

  // One-time v3/v2 -> v4 migration: write a complete v4 store from the loaded legacy state,
  // read it back and verify it reproduces that state exactly, write a portable-tree backup,
  // and only then delete the legacy keys. Any failure removes the just-written v4 keys so
  // the next startup retries with the legacy keys still authoritative.
  async function migrateLegacyStateToV4(stored: OutlineState): Promise<void> {
    const snapshot = outlineStateV4Snapshot(stored, {
      epoch: outlineJournal?.epoch() ?? 0,
      journalSeqIncluded: outlineJournal?.headSeq() ?? 0,
      savedAt: now()
    });
    // One written-key set drives both the write and the failure rollback so they cannot
    // diverge (the boot snapshot key must roll back too).
    const writtenItems: Record<string, unknown> = {
      ...snapshot.setItems,
      ...outlineBootSnapshotItem(stored, now())
    };
    try {
      await perfTrace.measureAsync("background.state.migration.write", () =>
        api.storage.local.set(writtenItems)
      );
      const verify = await loadStateV4(api);
      if (!verify || verify.recovery !== "r0" || !statesMateriallyEqual(verify.state, stored)) {
        throw new Error(verify ? `verification mismatch (${verify.recovery})` : "verification load failed");
      }
      currentV4Snapshot = { manifest: snapshot.manifest, slot: snapshot.slot };
      previousV4Snapshot = undefined;
      await api.storage.local.set({
        [STATE_V4_MIGRATION_BACKUP_KEY]: {
          version: 1,
          exportedAt: now(),
          tree: exportPortableTree(stored, { now: now() })
        },
        // The tiny meta record is the durable "migration completed" evidence: startup gates
        // legacy-key cleanup on it and expires the backup through it without ever
        // deserializing the multi-MB backup value.
        [STATE_V4_MIGRATION_BACKUP_META_KEY]: { version: 1, exportedAt: now() }
      });
      await deleteLegacyStateKeys();
      await recordIncidentLog("v4MigrationComplete", { ...outlineStateCountDetail(stored) });
    } catch (error) {
      currentV4Snapshot = undefined;
      previousV4Snapshot = undefined;
      await api.storage.local.remove(Object.keys(writtenItems)).catch(() => undefined);
      await recordIncidentLog("v4MigrationFailed", { message: errorText(error) });
    }
  }

  async function deleteLegacyStateKeys(): Promise<void> {
    const everything = await api.storage.local.get(null);
    const legacyKeys = Object.keys(everything).filter((key) =>
      key === STATE_KEY ||
      key.startsWith("outlineState:v2:") ||
      key.startsWith("outlineState:v3:")
    );
    if (legacyKeys.length > 0) {
      await api.storage.local.remove(legacyKeys);
    }
  }
  function startSaveStateAndHistory(
    nextState: OutlineState | undefined,
    nextHistory: HistoryState | undefined,
    candidateNodeIds?: readonly NodeId[]
  ): Promise<void> {
    saveInFlight = saveStateAndHistoryNowWithTrace(nextState, nextHistory, candidateNodeIds).finally(() => {
      saveInFlight = undefined;
      if (saveAfterInFlight) {
        const schedule = saveAfterInFlightSchedule;
        saveAfterInFlight = false;
        saveAfterInFlightSchedule = "normal";
        if (!explicitSaveFlushInProgress && (pendingSaveState || pendingSaveHistory)) {
          schedulePendingSave(schedule);
        }
      }
    });
    return saveInFlight;
  }

  async function initJournalOnStore(store: KeyValueStore) {
    // The next session's epoch is the prior epoch + 1, read from wherever the journal now lives.
    const storedMeta = (await store.get(JOURNAL_META_KEY))[JOURNAL_META_KEY];
    const priorEpoch = storedMeta && typeof storedMeta === "object" &&
      typeof (storedMeta as { epoch?: unknown }).epoch === "number"
      ? (storedMeta as { epoch: number }).epoch
      : 0;
    outlineJournal = createOutlineJournal(store, { epoch: priorEpoch + 1, now });
    return perfTrace.measureAsync("background.journal.init", () => outlineJournal!.init());
  }

  async function createAndInitJournal() {
    try {
      // Move the journal off storage.local onto the injected store (IndexedDB in production) on the
      // first run after the substrate swap; a no-op once migrated, and when journalStore is the
      // storage.local pass-through (the test/default path). Must run before the epoch read so the
      // new substrate carries the prior meta.
      await perfTrace.measureAsync("background.journal.migrate", () =>
        migrateJournalStore(storageLocalKvStore(api), journalStore)
      );
      return await initJournalOnStore(journalStore);
    } catch (error) {
      // The journal substrate (IndexedDB in production) is unavailable or flaky -- a private-
      // browsing window, a disabled IDB pref, disk pressure, or a corrupt profile database. The
      // journal must never block startup (the durable tree lives in the v4 snapshot, not the
      // journal). If the storage.local journal still exists (migration has not completed) keep
      // using it this session and retry the move next run; otherwise (already migrated to the now-
      // unreachable store) run journal-less -- prior entries stay safe in the unreachable store for
      // a working session, and the deferred snapshot save covers durability meanwhile. No entries
      // are lost either way.
      await recordIncidentLog("journalStoreUnavailable", { message: errorText(error) });
      const localStore = storageLocalKvStore(api);
      const localMeta = (await localStore.get(JOURNAL_META_KEY))[JOURNAL_META_KEY];
      if (localMeta && typeof localMeta === "object") {
        // storage.local still has a journal -> migration has not completed, so it is authoritative.
        // (A second consecutive IDB fault after an earlier completed migration cannot reach here:
        // that migration removed the local meta. Even if a stale local journal were somehow re-
        // adopted, replay is epoch-stamped + journalSeqIncluded-gated + idempotent -> redundant
        // replay at worst, never loss.)
        return initJournalOnStore(localStore);
      }
      outlineJournal = undefined;
      return { headSeq: 0, tailSeq: 0, entries: [] };
    }
  }

  function adoptLoadedV4Snapshot(
    manifest: StateV4Manifest,
    slot: StateV4ManifestSlot,
    fallback?: V4SnapshotRef
  ): void {
    currentV4Snapshot = { manifest, slot };
    // Seed the GC baseline from the other stored slot so the first post-startup compaction collects
    // the shards it supersedes instead of leaking them (the per-startup shard-GC gap that grew the
    // store to hundreds of orphaned generations). Absent only when the other slot has no valid
    // manifest, in which case the deferred orphan sweep reclaims any leaked keys.
    previousV4Snapshot = fallback;
  }

  // Whether anything still needs persisting (queued or mid-write); lets the controller decide
  // if a durable-base flush is required before journaling a runtime-lifecycle side effect.
  function hasPendingOrInFlightSave(): boolean {
    return Boolean(pendingSaveState || pendingSaveHistory || saveInFlight);
  }

  return {
    scheduleStateSave,
    scheduleHistorySave,
    flushPendingSaves,
    hasPendingOrInFlightSave,
    pausePendingSaveTimers,
    resumePendingSaveTimers,
    appendCommandJournal,
    appendCommandJournalForKnownNodeIds,
    queueRuntimeEventJournal,
    queueRuntimeEventJournalFromUpdate,
    flushEventJournalQueue,
    compactOutlineJournal,
    migrateLegacyStateToV4,
    deleteLegacyStateKeys,
    createAndInitJournal,
    adoptLoadedV4Snapshot
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
