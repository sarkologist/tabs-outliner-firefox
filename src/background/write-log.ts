import { OUTLINE_CHANGE_TYPES, type OutlineChangeType } from "./outline-change-summary.js";

// Recognized change types, for validating a hydrated session snapshot (an unknown string from a
// corrupted snapshot would match no filter toggle).
const WRITE_LOG_CHANGE_TYPES: ReadonlySet<OutlineChangeType> = new Set(OUTLINE_CHANGE_TYPES);

// Reduce a change-types value to the stored invariant: recognized types only, de-duplicated, in
// first-seen order. Applied to both freshly recorded changes and hydrated session data so a
// corrupted/legacy snapshot (or a future stray duplicate) can never leak into the filter.
function normalizeChangeTypes(value: unknown): OutlineChangeType[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<OutlineChangeType>();
  for (const type of value) {
    if (WRITE_LOG_CHANGE_TYPES.has(type as OutlineChangeType)) {
      seen.add(type as OutlineChangeType);
    }
  }
  return [...seen];
}

// An always-on, in-memory record of the persistence "write events" that make up the durability
// chain -- journal append (durable at ack, invariant I-1) -> snapshot save (folds the journal into
// the sharded snapshot) -> journal prune (trims the folded entries). Surfaced in the options page
// ("Write activity") so the user can watch every change persist and confirm nothing is silently
// dropped: per-save node/closed counts and their deltas make a data-loss event glaring, and the
// journaled-vs-covered seq gap shows how many acked changes are journal-durable but not yet folded
// into a snapshot.
//
// Deliberately NOT backed by storage.local: every storage.local.set is a tracked perf cost
// (scripts/profile-storage-metrics.mjs counts storageSetCalls as a hard CI counter) and the whole
// persistence layer fights write amplification. The buffer lives in memory and is mirrored to
// ephemeral storage.session (in-memory, no disk I/O) so it survives the background event page's
// idle/wake cycles within a browser session. The options page pulls it over the getWriteLog message.

// v2: the entry shape gained the "change" kind + structured `change` field. A bumped key drops any
// stale v1 session rows (which carried the domain text on journalAppend.detail) rather than letting
// them leak into the storage list after an in-session upgrade.
export const WRITE_LOG_SESSION_KEY = "tabsOutlinerWriteLog:v2";
// Separate caps so a burst of domain "change" rows can't evict the storage diagnostics (and vice
// versa); the two are rendered as separate lists.
export const WRITE_LOG_STORAGE_LIMIT = 400;
export const WRITE_LOG_CHANGE_LIMIT = 150;
// The most affected-node names a single change row stores (and the UI shows + 'N more'). Bounds
// session-storage growth while still naming every node for a realistic window delete.
export const WRITE_LOG_CHANGE_LINE_LIMIT = 100;
// Coarse upper bound for a hydrated snapshot before per-category trimming.
export const WRITE_LOG_LIMIT = WRITE_LOG_STORAGE_LIMIT + WRITE_LOG_CHANGE_LIMIT;

const WRITE_LOG_VERSION = 1;
const DEFAULT_PERSIST_DEBOUNCE_MS = 500;

// "change" rows are the domain-level "what happened to my tree" list (deleted/moved/renamed with
// names); the rest are the storage-diagnostic "how it persisted" list (journal/snapshot/prune).
// The options page renders them as two separate lists.
export type WriteLogKind =
  | "change"
  | "journalAppend"
  | "journalSpill"
  | "journalPrune"
  | "snapshotSave"
  | "historySave"
  | "bootSnapshot"
  | "saveFailed";

export type WriteLogDetailValue = string | number | boolean | null | undefined;
export type WriteLogDetail = Record<string, WriteLogDetailValue>;
type StoredDetail = Record<string, string | number | boolean | null>;

// The domain-level change content for a "change" row: a one-line headline plus every affected node
// name (bounded), and the discrete categories the change spans (delete/move/rename/...) that drive
// the options-page per-type filter. Plain strings so it serializes into session storage unchanged.
export type WriteLogChange = {
  headline: string;
  lines: string[];
  overflow: number;
  types: OutlineChangeType[];
};

export type WriteLogEntry = {
  version: 1;
  // A monotonic id local to this log (NOT the journal seq) so the UI can order and dedupe entries
  // stably across polls even as the ring buffer evicts the oldest.
  seq: number;
  at: string;
  kind: WriteLogKind;
  ok: boolean;
  detail?: StoredDetail;
  // Present on "change" rows only.
  change?: WriteLogChange;
};

export type WriteLogInput = {
  kind: Exclude<WriteLogKind, "change">;
  ok: boolean;
  detail?: WriteLogDetail;
};

export type WriteLogChangeInput = {
  headline: string;
  lines: string[];
  overflow?: number;
  label?: string;
  types?: OutlineChangeType[];
};

export type WriteLogSnapshot = {
  version: 1;
  entries: WriteLogEntry[];
};

export function isWriteLogChangeEntry(entry: WriteLogEntry): boolean {
  return entry.kind === "change";
}

export type WriteLogSeverity = "ok" | "warn" | "error";

export type WriteLogHealth = {
  total: number;
  nodeCount?: number;
  closedCount?: number;
  lastSaveAt?: string;
  // Highest journal-append seq observed (changes are durable at this point).
  journaledThroughSeq?: number;
  // Highest journalSeqIncluded folded into a snapshot (changes are now in the snapshot too).
  coveredThroughSeq?: number;
  // Acked changes that are journal-durable but not yet folded into a snapshot. Non-zero is normal
  // and safe (the journal replays on restart); a value that only grows is the signal to watch.
  pendingJournalCount?: number;
  errorCount: number;
  spillCount: number;
  lastNodeDelta?: number;
  lastClosedDelta?: number;
};

export type WriteLog = {
  record(input: WriteLogInput): void;
  recordChange(input: WriteLogChangeInput): void;
  snapshot(): WriteLogSnapshot;
  clear(): void;
  hydrate(value: unknown): void;
};

// A drop this steep in one save matches the data-loss family the save-flush anomaly incident also
// watches for (see SAVE_FLUSH_ANOMALY_* in persistence-coordinator.ts); surface it as a warning so
// it stands out in the timeline rather than scrolling by as a routine green save.
const NODE_DROP_WARN_THRESHOLD = -50;
const CLOSED_DROP_WARN_THRESHOLD = -25;

export function createWriteLog(
  options: {
    now?: () => number;
    // Storage-diagnostic cap; `changeLimit` caps the domain-change rows independently.
    limit?: number;
    changeLimit?: number;
    persist?: (snapshot: WriteLogSnapshot) => void;
    persistDebounceMs?: number;
  } = {}
): WriteLog {
  const now = options.now ?? Date.now;
  const storageLimit = options.limit ?? WRITE_LOG_STORAGE_LIMIT;
  const changeLimit = options.changeLimit ?? WRITE_LOG_CHANGE_LIMIT;
  const persist = options.persist;
  const persistDebounceMs = options.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;

  let entries: WriteLogEntry[] = [];
  let nextSeq = 1;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;

  function trimToCaps(): void {
    entries = trimWriteLogEntries(entries, storageLimit, changeLimit);
  }

  function pushEntry(entry: WriteLogEntry): void {
    entries.push(entry);
    trimToCaps();
    schedulePersist();
  }

  function record(input: WriteLogInput): void {
    const entry: WriteLogEntry = {
      version: WRITE_LOG_VERSION,
      seq: nextSeq,
      at: new Date(now()).toISOString(),
      kind: input.kind,
      ok: input.ok
    };
    nextSeq += 1;
    const detail = normalizedDetail(input.detail);
    if (detail) {
      entry.detail = detail;
    }
    pushEntry(entry);
  }

  function recordChange(input: WriteLogChangeInput): void {
    const lines = input.lines.slice(0, WRITE_LOG_CHANGE_LINE_LIMIT);
    const droppedHere = input.lines.length - lines.length;
    const entry: WriteLogEntry = {
      version: WRITE_LOG_VERSION,
      seq: nextSeq,
      at: new Date(now()).toISOString(),
      kind: "change",
      ok: true,
      change: {
        headline: input.headline,
        lines,
        overflow: Math.max(0, Math.floor(input.overflow ?? 0)) + droppedHere,
        types: normalizeChangeTypes(input.types)
      }
    };
    nextSeq += 1;
    if (input.label) {
      entry.detail = { label: input.label };
    }
    pushEntry(entry);
  }

  function snapshot(): WriteLogSnapshot {
    return {
      version: WRITE_LOG_VERSION,
      entries: entries.map(cloneEntry)
    };
  }

  function clear(): void {
    entries = [];
    schedulePersist();
  }

  function hydrate(value: unknown): void {
    // Seed only an empty buffer. Hydration runs once at startup; it must never clobber write
    // events already recorded this session, nor rewind nextSeq behind them, if a record happened
    // to land before the async session read resolved.
    if (entries.length > 0) {
      return;
    }
    const restored = normalizeWriteLogEntries(value);
    if (restored.length === 0) {
      return;
    }
    entries = trimWriteLogEntries(restored, storageLimit, changeLimit);
    nextSeq = Math.max(0, ...entries.map((entry) => entry.seq)) + 1;
  }

  function schedulePersist(): void {
    if (!persist) {
      return;
    }
    if (persistTimer !== undefined) {
      globalThis.clearTimeout(persistTimer);
    }
    persistTimer = globalThis.setTimeout(() => {
      persistTimer = undefined;
      persist(snapshot());
    }, persistDebounceMs);
  }

  return { record, recordChange, snapshot, clear, hydrate };
}

// Drop the oldest entries of each category that exceed its cap, preserving chronological order.
// The two categories are capped independently so a burst of one kind can't evict the other.
function trimWriteLogEntries(
  entries: WriteLogEntry[],
  storageLimit: number,
  changeLimit: number
): WriteLogEntry[] {
  const isChange = (entry: WriteLogEntry): boolean => entry.kind === "change";
  let changeOverflow = entries.filter(isChange).length - changeLimit;
  let storageOverflow = entries.length - entries.filter(isChange).length - storageLimit;
  if (changeOverflow <= 0 && storageOverflow <= 0) {
    return entries;
  }
  return entries.filter((entry) => {
    if (isChange(entry)) {
      if (changeOverflow > 0) {
        changeOverflow -= 1;
        return false;
      }
      return true;
    }
    if (storageOverflow > 0) {
      storageOverflow -= 1;
      return false;
    }
    return true;
  });
}

export function normalizeWriteLogEntries(value: unknown): WriteLogEntry[] {
  const candidate = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as WriteLogSnapshot).entries)
      ? (value as WriteLogSnapshot).entries
      : undefined;
  if (!candidate) {
    return [];
  }
  return candidate.flatMap(normalizeEntry).slice(-WRITE_LOG_LIMIT);
}

export function summarizeWriteLog(entries: readonly WriteLogEntry[]): WriteLogHealth {
  const health: WriteLogHealth = {
    total: entries.length,
    errorCount: 0,
    spillCount: 0
  };
  for (const entry of entries) {
    if (entry.kind === "saveFailed") {
      health.errorCount += 1;
    } else if (entry.kind === "journalSpill") {
      health.spillCount += 1;
    } else if (entry.kind === "journalAppend") {
      const seq = numberDetail(entry, "seq");
      if (seq !== undefined) {
        health.journaledThroughSeq = Math.max(health.journaledThroughSeq ?? 0, seq);
      }
    } else if (entry.kind === "snapshotSave" && entry.ok) {
      const nodeCount = numberDetail(entry, "nodeCount");
      const closedCount = numberDetail(entry, "closedCount");
      const nodeDelta = numberDetail(entry, "nodeDelta");
      const closedDelta = numberDetail(entry, "closedDelta");
      if (nodeCount !== undefined) {
        health.nodeCount = nodeCount;
      }
      if (closedCount !== undefined) {
        health.closedCount = closedCount;
      }
      if (nodeDelta !== undefined) {
        health.lastNodeDelta = nodeDelta;
      }
      if (closedDelta !== undefined) {
        health.lastClosedDelta = closedDelta;
      }
      health.lastSaveAt = entry.at;
      const covered = numberDetail(entry, "journalSeqIncluded");
      if (covered !== undefined) {
        health.coveredThroughSeq = Math.max(health.coveredThroughSeq ?? 0, covered);
      }
    }
  }
  if (health.journaledThroughSeq !== undefined) {
    health.pendingJournalCount = Math.max(
      0,
      health.journaledThroughSeq - (health.coveredThroughSeq ?? 0)
    );
  }
  return health;
}

export function describeWriteLogEntry(entry: WriteLogEntry): {
  title: string;
  severity: WriteLogSeverity;
  detailText: string;
} {
  return {
    title: writeLogTitle(entry),
    severity: writeLogSeverity(entry),
    detailText: writeLogDetailText(entry.detail)
  };
}

function writeLogTitle(entry: WriteLogEntry): string {
  switch (entry.kind) {
    case "change":
      return entry.change?.headline ?? "Change";
    case "journalAppend": {
      const count = numberDetail(entry, "entries") ?? 1;
      const seq = numberDetail(entry, "seq");
      return `Journaled ${count} ${count === 1 ? "change" : "changes"}${
        seq !== undefined ? ` → seq ${seq}` : ""
      }`;
    }
    case "journalSpill":
      return "Journal spill — change too large to journal; carried by the next snapshot";
    case "journalPrune": {
      const through = numberDetail(entry, "throughSeq");
      return `Trimmed journal${through !== undefined ? ` through seq ${through}` : ""}`;
    }
    case "snapshotSave": {
      const nodeCount = numberDetail(entry, "nodeCount");
      const closedCount = numberDetail(entry, "closedCount");
      const parts: string[] = ["Saved snapshot"];
      if (nodeCount !== undefined) {
        parts.push(
          `${formatCount(nodeCount)} nodes${formatDelta(numberDetail(entry, "nodeDelta"))}`
        );
      }
      if (closedCount !== undefined) {
        parts.push(
          `${formatCount(closedCount)} closed${formatDelta(numberDetail(entry, "closedDelta"))}`
        );
      }
      return parts.join(" · ");
    }
    case "historySave":
      return "Saved undo history";
    case "bootSnapshot":
      return entry.ok ? "Refreshed first-paint cache" : "First-paint cache write failed";
    case "saveFailed":
      return "Snapshot save FAILED — will retry";
  }
}

function writeLogSeverity(entry: WriteLogEntry): WriteLogSeverity {
  if (entry.kind === "saveFailed") {
    return "error";
  }
  if (!entry.ok || entry.kind === "journalSpill") {
    return "warn";
  }
  if (entry.kind === "snapshotSave") {
    const nodeDelta = numberDetail(entry, "nodeDelta");
    const closedDelta = numberDetail(entry, "closedDelta");
    if (
      (nodeDelta !== undefined && nodeDelta <= NODE_DROP_WARN_THRESHOLD) ||
      (closedDelta !== undefined && closedDelta <= CLOSED_DROP_WARN_THRESHOLD)
    ) {
      return "warn";
    }
  }
  return "ok";
}

function writeLogDetailText(detail: WriteLogEntry["detail"]): string {
  if (!detail) {
    return "";
  }
  return Object.entries(detail)
    .map(([key, value]) => `${key}=${value}`)
    .join(" · ");
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatDelta(delta: number | undefined): string {
  if (delta === undefined || delta === 0) {
    return "";
  }
  return ` (${delta > 0 ? "+" : "−"}${formatCount(Math.abs(delta))})`;
}

function numberDetail(entry: WriteLogEntry, key: string): number | undefined {
  const value = entry.detail?.[key];
  return typeof value === "number" ? value : undefined;
}

function cloneEntry(entry: WriteLogEntry): WriteLogEntry {
  return {
    ...entry,
    ...(entry.detail ? { detail: { ...entry.detail } } : {}),
    ...(entry.change
      ? {
          change: {
            ...entry.change,
            lines: [...entry.change.lines],
            types: [...entry.change.types]
          }
        }
      : {})
  };
}

function normalizeEntry(value: unknown): WriteLogEntry[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const candidate = value as {
    version?: unknown;
    seq?: unknown;
    at?: unknown;
    kind?: unknown;
    ok?: unknown;
    detail?: unknown;
    change?: unknown;
  };
  if (
    candidate.version !== WRITE_LOG_VERSION ||
    typeof candidate.seq !== "number" ||
    typeof candidate.at !== "string" ||
    !isWriteLogKind(candidate.kind) ||
    typeof candidate.ok !== "boolean"
  ) {
    return [];
  }
  const entry: WriteLogEntry = {
    version: WRITE_LOG_VERSION,
    seq: candidate.seq,
    at: candidate.at,
    kind: candidate.kind,
    ok: candidate.ok
  };
  const detail =
    candidate.detail && typeof candidate.detail === "object" && !Array.isArray(candidate.detail)
      ? normalizedDetail(candidate.detail as Record<string, unknown>)
      : undefined;
  if (detail) {
    entry.detail = detail;
  }
  const change = normalizeChange(candidate.change);
  if (change) {
    entry.change = change;
  }
  return [entry];
}

function normalizeChange(value: unknown): WriteLogChange | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as {
    headline?: unknown;
    lines?: unknown;
    overflow?: unknown;
    types?: unknown;
  };
  if (typeof candidate.headline !== "string" || !Array.isArray(candidate.lines)) {
    return undefined;
  }
  // Defend against a corrupted/oversized session snapshot: bound the line list (the producer
  // already caps it) and clamp overflow to a finite non-negative integer.
  const allLines = candidate.lines.filter((line): line is string => typeof line === "string");
  const lines = allLines.slice(0, WRITE_LOG_CHANGE_LINE_LIMIT);
  const storedOverflow =
    typeof candidate.overflow === "number" && Number.isFinite(candidate.overflow)
      ? Math.max(0, Math.floor(candidate.overflow))
      : 0;
  // Change rows written before the `types` field existed (older same-session storage) have no
  // `types` and default to an empty list (shown unfiltered); junk is dropped (see normalizeChangeTypes).
  return {
    headline: candidate.headline,
    lines,
    overflow: storedOverflow + (allLines.length - lines.length),
    types: normalizeChangeTypes(candidate.types)
  };
}

const WRITE_LOG_KINDS: ReadonlySet<string> = new Set<WriteLogKind>([
  "change",
  "journalAppend",
  "journalSpill",
  "journalPrune",
  "snapshotSave",
  "historySave",
  "bootSnapshot",
  "saveFailed"
]);

function isWriteLogKind(value: unknown): value is WriteLogKind {
  return typeof value === "string" && WRITE_LOG_KINDS.has(value);
}

function normalizedDetail(detail: Record<string, unknown> | undefined): StoredDetail | undefined {
  if (!detail) {
    return undefined;
  }
  const normalized = Object.fromEntries(
    Object.entries(detail).filter((entry): entry is [string, string | number | boolean | null] =>
      isStoredDetailValue(entry[1])
    )
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function isStoredDetailValue(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}
