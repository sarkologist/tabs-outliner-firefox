import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import type { KeyValueStore } from "./key-value-store.js";
import {
  createHistoryEntry,
  historyContainsEntryId,
  isTrackableHistoryCommandType,
  popRedoEntry,
  popUndoEntry,
  pushRedoEntry,
  pushUndoEntry,
  pushUndoEntryPreservingRedo,
  type HistoryState,
  type TrackableHistoryCommandType
} from "./history.js";

// v4 mutation journal (pure module, unwired in this phase). The journal persists O(delta)
// mutation records so an acked change survives a background restart before the snapshot is
// compacted. See docs/storage-rearchitecture/01-TARGET-ARCHITECTURE.md sections 2-4.

export const JOURNAL_META_KEY = "outline:v4:journal:meta";
export const JOURNAL_SLOT_PREFIX = "outline:v4:journal:slot:";
export const JOURNAL_SLOT_COUNT = 64;
export const JOURNAL_SPILL_NODE_LIMIT = 2000;
export const JOURNAL_SPILL_BYTE_LIMIT = 512 * 1024;

const JOURNAL_VERSION = 1;

export type OutlineJournalEntryKind = "command" | "runtimeEvent" | "historyReplay" | "recovery";

export type OutlineJournalDelta = {
  rootIds?: NodeId[];
  updatedNodes?: OutlineNode[];
  deletedNodeIds?: NodeId[];
};

export type OutlineJournalEntry = {
  seq: number;
  epoch: number;
  at: number;
  kind: OutlineJournalEntryKind;
  label?: string;
  delta?: OutlineJournalDelta;
  spill?: true;
  // Id of the undo-history entry this command/replay produced. Startup replay rebuilds the
  // history entry from the delta when the persisted history (which rides the deferred
  // snapshot flush) does not contain the id yet -- the journal is durable at ack, the
  // history save is not.
  historyEntryId?: string;
};

export type OutlineJournalAppendItem = {
  kind: OutlineJournalEntryKind;
  label?: string;
  delta?: OutlineJournalDelta;
  // Explicit spill marker: the caller had a delta too heavy to journal and is recording
  // that fact (the snapshot save, not the journal, carries the change). Replay skips it;
  // a loader that replays past an unfolded marker knows the snapshot may miss a broad change.
  spill?: true;
  historyEntryId?: string;
};

export type OutlineJournalAppendResult = {
  seq: number;
  spilled: boolean;
};

export type OutlineJournalInitResult = {
  headSeq: number;
  tailSeq: number;
  entries: OutlineJournalEntry[];
  // Set when a corrupt slot was found: entries with seq > truncatedAtSeq were discarded.
  truncatedAtSeq?: number;
};

export type OutlineJournal = {
  init(): Promise<OutlineJournalInitResult>;
  append(batch: OutlineJournalAppendItem[]): Promise<OutlineJournalAppendResult>;
  prune(throughSeq: number): Promise<void>;
  pendingEntryCount(): number;
  pendingBytes(): number;
  headSeq(): number;
  epoch(): number;
};

export class JournalFullError extends Error {
  constructor(message = "outline journal ring is full; compact before appending") {
    super(message);
    this.name = "JournalFullError";
  }
}

type JournalMeta = {
  version: 1;
  epoch: number;
  headSeq: number;
  tailSeq: number;
  firstBatch: number;
  nextBatch: number;
};

type JournalSlot = {
  version: 1;
  batch: number;
  entries: OutlineJournalEntry[];
};

type LiveBatch = {
  batch: number;
  entries: OutlineJournalEntry[];
};

function slotKey(batch: number): string {
  return `${JOURNAL_SLOT_PREFIX}${batch % JOURNAL_SLOT_COUNT}`;
}

export function createOutlineJournal(
  store: KeyValueStore,
  options: { epoch: number; now?: () => number }
): OutlineJournal {
  const now = options.now ?? Date.now;
  const epoch = options.epoch;
  let headSeq = 0;
  let tailSeq = 0;
  let nextBatch = 0;
  let liveBatches: LiveBatch[] = [];
  // All storage-touching operations are serialized through one chain: append() and prune()
  // each read seq/batch bookkeeping, await a storage write, then commit it back. Two such
  // operations overlapping across the await would compute the same seq/slot key (an event
  // coalescer flush runs on plain timers, outside any caller-side queue) and overwrite each
  // other, or prune slots a concurrent append's meta still references.
  let opQueue: Promise<unknown> = Promise.resolve();

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = opQueue.then(operation, operation);
    opQueue = run.catch(() => undefined);
    return run;
  }

  function firstBatch(): number {
    return liveBatches.length > 0 ? liveBatches[0]!.batch : nextBatch;
  }

  async function init(): Promise<OutlineJournalInitResult> {
    const storedMeta = (await store.get(JOURNAL_META_KEY))[JOURNAL_META_KEY];
    const meta = normalizeMeta(storedMeta);
    if (!meta) {
      headSeq = 0;
      tailSeq = 0;
      nextBatch = 0;
      liveBatches = [];
      return { headSeq: 0, tailSeq: 0, entries: [] };
    }

    const slotKeys: string[] = [];
    for (let batch = meta.firstBatch; batch < meta.nextBatch; batch += 1) {
      slotKeys.push(slotKey(batch));
    }
    const slotStore = slotKeys.length > 0 ? await store.get(slotKeys) : {};

    const entries: OutlineJournalEntry[] = [];
    const recovered: LiveBatch[] = [];
    let lastSeq = meta.tailSeq;
    let lastGoodBatch = meta.firstBatch - 1;
    let truncatedAtSeq: number | undefined;

    for (let batch = meta.firstBatch; batch < meta.nextBatch; batch += 1) {
      const slot = slotStore[slotKey(batch)];
      if (
        !isJournalSlot(slot) ||
        slot.batch !== batch ||
        !slotEntriesValid(slot.entries, lastSeq)
      ) {
        // A corrupt or torn slot: stop at the last good seq, discard the rest.
        truncatedAtSeq = lastSeq;
        break;
      }
      entries.push(...slot.entries);
      recovered.push({ batch, entries: slot.entries });
      if (slot.entries.length > 0) {
        lastSeq = slot.entries[slot.entries.length - 1]!.seq;
      }
      lastGoodBatch = batch;
    }

    liveBatches = recovered;
    headSeq = lastSeq;
    tailSeq = meta.tailSeq;
    nextBatch = lastGoodBatch + 1;

    return {
      headSeq,
      tailSeq,
      entries,
      ...(truncatedAtSeq !== undefined ? { truncatedAtSeq } : {})
    };
  }

  async function appendNow(batch: OutlineJournalAppendItem[]): Promise<OutlineJournalAppendResult> {
    if (batch.length === 0) {
      return { seq: headSeq, spilled: false };
    }
    if (liveBatches.length >= JOURNAL_SLOT_COUNT) {
      throw new JournalFullError();
    }

    const batchIndex = nextBatch;
    let seq = headSeq;
    let spilled = false;
    const entries: OutlineJournalEntry[] = batch.map((item) => {
      seq += 1;
      const entry: OutlineJournalEntry = {
        seq,
        epoch,
        at: now(),
        kind: item.kind
      };
      if (item.label !== undefined) {
        entry.label = item.label;
      }
      if (item.historyEntryId !== undefined) {
        entry.historyEntryId = item.historyEntryId;
      }
      if (item.spill || (item.delta && deltaExceedsSpillLimit(item.delta))) {
        entry.spill = true;
        spilled = true;
      } else if (item.delta) {
        entry.delta = item.delta;
      }
      return entry;
    });

    const slot: JournalSlot = { version: JOURNAL_VERSION, batch: batchIndex, entries };
    const meta: JournalMeta = {
      version: JOURNAL_VERSION,
      epoch,
      headSeq: seq,
      tailSeq,
      firstBatch: firstBatch(),
      nextBatch: batchIndex + 1
    };
    // One set writes the slot and advances meta together. If it rejects, no in-memory state
    // changes (pendingEntryCount unchanged) and the caller decides whether to retry.
    await store.set({ [slotKey(batchIndex)]: slot, [JOURNAL_META_KEY]: meta });

    headSeq = seq;
    nextBatch = batchIndex + 1;
    liveBatches.push({ batch: batchIndex, entries });
    return { seq: headSeq, spilled };
  }

  async function pruneNow(throughSeq: number): Promise<void> {
    let removed = 0;
    const removeKeys: string[] = [];
    for (const liveBatch of liveBatches) {
      const maxSeq =
        liveBatch.entries.length > 0
          ? liveBatch.entries[liveBatch.entries.length - 1]!.seq
          : Number.NEGATIVE_INFINITY;
      if (maxSeq <= throughSeq) {
        removeKeys.push(slotKey(liveBatch.batch));
        removed += 1;
      } else {
        break;
      }
    }
    const newTailSeq = Math.max(tailSeq, throughSeq);
    if (removed === 0 && newTailSeq === tailSeq) {
      return;
    }

    const remaining = liveBatches.slice(removed);
    const meta: JournalMeta = {
      version: JOURNAL_VERSION,
      epoch,
      headSeq,
      tailSeq: newTailSeq,
      firstBatch: remaining.length > 0 ? remaining[0]!.batch : nextBatch,
      nextBatch
    };
    await store.set({ [JOURNAL_META_KEY]: meta });
    // Freed slot keys are outside [firstBatch, nextBatch) now, so a failed remove only leaves
    // harmless garbage that init ignores and the next prune/compaction collects.
    if (removeKeys.length > 0) {
      await store.remove(removeKeys);
    }

    liveBatches = remaining;
    tailSeq = newTailSeq;
  }

  function pendingEntryCount(): number {
    return liveBatches.reduce((total, liveBatch) => total + liveBatch.entries.length, 0);
  }

  function pendingBytes(): number {
    if (liveBatches.length === 0) {
      return 0;
    }
    return liveBatches.reduce(
      (total, liveBatch) => total + JSON.stringify(liveBatch.entries).length,
      0
    );
  }

  return {
    init: () => serialize(init),
    append: (batch) => serialize(() => appendNow(batch)),
    prune: (throughSeq) => serialize(() => pruneNow(throughSeq)),
    pendingEntryCount,
    pendingBytes,
    headSeq: () => headSeq,
    epoch: () => epoch
  };
}

// One-time substrate migration: copy the journal (meta + live slots) from `from` to `to` when
// `to` has no journal yet, then drop the source keys. Used to move the journal off `storage.local`
// onto IndexedDB on the first run after the substrate swap, WITHOUT losing entries a crash left
// unreplayed. Order is copy-then-remove so a crash mid-migration keeps the source authoritative
// (to.set failed -> source intact, retried next run) or leaves only harmless source garbage
// (from.remove failed -> destination authoritative, source ignored). A no-op when the destination
// already has a journal (it is authoritative) or the source has none; safe when from === to.
export async function migrateJournalStore(
  from: KeyValueStore,
  to: KeyValueStore
): Promise<boolean> {
  const destinationMeta = normalizeMeta((await to.get(JOURNAL_META_KEY))[JOURNAL_META_KEY]);
  if (destinationMeta) {
    return false;
  }
  const sourceMetaRaw = (await from.get(JOURNAL_META_KEY))[JOURNAL_META_KEY];
  const sourceMeta = normalizeMeta(sourceMetaRaw);
  if (!sourceMeta) {
    return false;
  }

  // Read the physical slot keys the source meta references. A corrupt over-span meta could
  // otherwise build an unbounded key array; only JOURNAL_SLOT_COUNT distinct physical keys can
  // exist (slotKey is taken mod the slot count) and the destination init re-validates anyway, so
  // dedupe and cap.
  const slotKeySet = new Set<string>();
  for (
    let batch = sourceMeta.firstBatch;
    batch < sourceMeta.nextBatch && slotKeySet.size < JOURNAL_SLOT_COUNT;
    batch += 1
  ) {
    slotKeySet.add(slotKey(batch));
  }
  const slotKeys = [...slotKeySet];
  const slotStore = slotKeys.length > 0 ? await from.get(slotKeys) : {};
  const copy: Record<string, unknown> = { [JOURNAL_META_KEY]: sourceMetaRaw };
  for (const key of slotKeys) {
    const slot = slotStore[key];
    if (slot !== undefined) {
      copy[key] = slot;
    }
  }

  await to.set(copy);
  // Destination now durably holds the journal; only then drop the source keys.
  await from.remove([JOURNAL_META_KEY, ...slotKeys]);
  return true;
}

export function journalTouchedNodeIds(entries: readonly OutlineJournalEntry[]): Set<NodeId> {
  const touched = new Set<NodeId>();
  for (const entry of entries) {
    if (!entry.delta) {
      continue;
    }
    for (const node of entry.delta.updatedNodes ?? []) {
      touched.add(node.id);
    }
    for (const id of entry.delta.deletedNodeIds ?? []) {
      touched.add(id);
    }
  }
  return touched;
}

// Pure clone-on-write replay of journal deltas in seq order. Spill markers carry no delta
// and are skipped (the loader compacts rather than relying on replay past a spill).
export function replayJournal(
  state: OutlineState,
  entries: readonly OutlineJournalEntry[]
): OutlineState {
  if (entries.length === 0) {
    return state;
  }
  const ordered = [...entries].sort((left, right) => left.seq - right.seq);
  const nodes: Record<NodeId, OutlineNode> = { ...state.nodes };
  let rootIds = state.rootIds;
  let rootsChanged = false;
  for (const entry of ordered) {
    const delta = entry.delta;
    if (!delta) {
      continue;
    }
    for (const node of delta.updatedNodes ?? []) {
      nodes[node.id] = node;
    }
    for (const id of delta.deletedNodeIds ?? []) {
      delete nodes[id];
    }
    if (delta.rootIds) {
      rootIds = delta.rootIds;
      rootsChanged = true;
    }
  }
  return {
    version: state.version,
    rootIds: rootsChanged ? [...rootIds] : state.rootIds,
    nodes
  };
}

// True when startup replay must rebuild this entry's effect on the undo history: the entry
// records a history-tracked command (push) or an undo/redo (stack move) whose history save
// may not have landed before the crash. Spill markers carry no delta to rebuild from.
export function journalEntryAffectsHistory(entry: OutlineJournalEntry): boolean {
  if (entry.historyEntryId === undefined || entry.spill || !entry.delta) {
    return false;
  }
  if (entry.kind === "command") {
    return isTrackableHistoryCommandType(entry.label);
  }
  return entry.kind === "historyReplay" && (entry.label === "undo" || entry.label === "redo");
}

export type OutlineJournalHistoryReplayResult = {
  state: OutlineState;
  history: HistoryState;
  historyChanged: boolean;
};

// replayJournal plus undo-history reconstruction. For each history-tracked command entry
// whose id the loaded history does not contain, the history entry is rebuilt from the fold:
// before-images are the fold state prior to the entry's delta, after-images the state past
// it -- the journal needs no extra payload. historyReplay entries re-apply their stack move
// (undo: top undo entry -> redo stack; redo: mirrored) and skip when the loaded history
// already reflects it (id dedup), so any flush/crash interleaving converges. Copies the
// node table per history-bearing entry; fine for the crash-recovery path's entry counts.
export function replayJournalWithHistory(
  state: OutlineState,
  entries: readonly OutlineJournalEntry[],
  options: { history: HistoryState; limit?: number }
): OutlineJournalHistoryReplayResult {
  let history = options.history;
  let historyChanged = false;
  if (entries.length === 0) {
    return { state, history, historyChanged };
  }

  const ordered = [...entries].sort((left, right) => left.seq - right.seq);
  let current: OutlineState = {
    version: state.version,
    rootIds: [...state.rootIds],
    nodes: { ...state.nodes }
  };
  for (const entry of ordered) {
    const delta = entry.delta;
    if (!delta) {
      continue;
    }
    const next = applyJournalDelta(current, delta);
    if (journalEntryAffectsHistory(entry)) {
      const entryId = entry.historyEntryId!;
      if (entry.kind === "command") {
        if (!historyContainsEntryId(history, entryId)) {
          const touchedNodeIds = [
            ...(delta.updatedNodes ?? []).map((node) => node.id),
            ...(delta.deletedNodeIds ?? [])
          ];
          const rebuilt = createHistoryEntry(
            entry.label as TrackableHistoryCommandType,
            current,
            next,
            {
              candidateNodeIds: touchedNodeIds,
              diffMode: "material",
              id: entryId
            }
          );
          if (rebuilt) {
            history = pushUndoEntry(history, rebuilt, options.limit);
            historyChanged = true;
          }
        }
      } else if (entry.label === "undo") {
        if (
          !history.redoStack.some((stackEntry) => stackEntry.id === entryId) &&
          history.undoStack.at(-1)?.id === entryId
        ) {
          const popped = popUndoEntry(history);
          history = pushRedoEntry(popped.history, popped.entry!, options.limit);
          historyChanged = true;
        }
      } else if (
        !history.undoStack.some((stackEntry) => stackEntry.id === entryId) &&
        history.redoStack.at(-1)?.id === entryId
      ) {
        const popped = popRedoEntry(history);
        history = pushUndoEntryPreservingRedo(popped.history, popped.entry!, options.limit);
        historyChanged = true;
      }
    }
    current = next;
  }

  return { state: current, history, historyChanged };
}

function applyJournalDelta(state: OutlineState, delta: OutlineJournalDelta): OutlineState {
  const nodes: Record<NodeId, OutlineNode> = { ...state.nodes };
  for (const node of delta.updatedNodes ?? []) {
    nodes[node.id] = node;
  }
  for (const id of delta.deletedNodeIds ?? []) {
    delete nodes[id];
  }
  return {
    version: state.version,
    rootIds: delta.rootIds ? [...delta.rootIds] : state.rootIds,
    nodes
  };
}

// The single authority for "too heavy to journal". Weight counts nodes plus their inline
// childIds (a cheap serialization proxy that catches huge-childIds parents without
// stringifying); the byte check catches node-light but byte-heavy deltas (long URLs,
// data-URI favicons) and only runs when the weight check passed.
export function outlineJournalDeltaWeight(delta: OutlineJournalDelta): number {
  const updatedNodes = delta.updatedNodes ?? [];
  return (
    updatedNodes.length +
    (delta.deletedNodeIds?.length ?? 0) +
    updatedNodes.reduce((sum, node) => sum + node.childIds.length, 0)
  );
}

function deltaExceedsSpillLimit(delta: OutlineJournalDelta): boolean {
  if (outlineJournalDeltaWeight(delta) > JOURNAL_SPILL_NODE_LIMIT) {
    return true;
  }
  return JSON.stringify(delta).length > JOURNAL_SPILL_BYTE_LIMIT;
}

function slotEntriesValid(entries: unknown, afterSeq: number): boolean {
  if (!Array.isArray(entries)) {
    return false;
  }
  let previousSeq = afterSeq;
  for (const entry of entries) {
    if (!isJournalEntry(entry) || entry.seq <= previousSeq) {
      return false;
    }
    previousSeq = entry.seq;
  }
  return true;
}

function normalizeMeta(value: unknown): JournalMeta | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const meta = value as JournalMeta;
  if (
    meta.version !== JOURNAL_VERSION ||
    typeof meta.epoch !== "number" ||
    typeof meta.headSeq !== "number" ||
    typeof meta.tailSeq !== "number" ||
    typeof meta.firstBatch !== "number" ||
    typeof meta.nextBatch !== "number" ||
    meta.firstBatch > meta.nextBatch
  ) {
    return undefined;
  }
  return meta;
}

function isJournalSlot(value: unknown): value is JournalSlot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const slot = value as JournalSlot;
  return (
    slot.version === JOURNAL_VERSION &&
    typeof slot.batch === "number" &&
    Array.isArray(slot.entries)
  );
}

function isJournalEntry(value: unknown): value is OutlineJournalEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as OutlineJournalEntry;
  return (
    typeof entry.seq === "number" &&
    typeof entry.epoch === "number" &&
    typeof entry.at === "number" &&
    typeof entry.kind === "string"
  );
}
