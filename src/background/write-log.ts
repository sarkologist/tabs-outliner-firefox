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

export const WRITE_LOG_SESSION_KEY = "tabsOutlinerWriteLog:v1";
export const WRITE_LOG_LIMIT = 300;

const WRITE_LOG_VERSION = 1;
const DEFAULT_PERSIST_DEBOUNCE_MS = 500;

export type WriteLogKind =
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

export type WriteLogEntry = {
  version: 1;
  // A monotonic id local to this log (NOT the journal seq) so the UI can order and dedupe entries
  // stably across polls even as the ring buffer evicts the oldest.
  seq: number;
  at: string;
  kind: WriteLogKind;
  ok: boolean;
  detail?: StoredDetail;
};

export type WriteLogInput = {
  kind: WriteLogKind;
  ok: boolean;
  detail?: WriteLogDetail;
};

export type WriteLogSnapshot = {
  version: 1;
  entries: WriteLogEntry[];
};

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
    limit?: number;
    persist?: (snapshot: WriteLogSnapshot) => void;
    persistDebounceMs?: number;
  } = {}
): WriteLog {
  const now = options.now ?? Date.now;
  const limit = options.limit ?? WRITE_LOG_LIMIT;
  const persist = options.persist;
  const persistDebounceMs = options.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;

  let entries: WriteLogEntry[] = [];
  let nextSeq = 1;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;

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
    entries.push(entry);
    if (entries.length > limit) {
      entries.splice(0, entries.length - limit);
    }
    schedulePersist();
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
    entries = restored;
    nextSeq = Math.max(0, ...restored.map((entry) => entry.seq)) + 1;
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

  return { record, snapshot, clear, hydrate };
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
  return { ...entry, ...(entry.detail ? { detail: { ...entry.detail } } : {}) };
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
  return [entry];
}

const WRITE_LOG_KINDS: ReadonlySet<string> = new Set<WriteLogKind>([
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
