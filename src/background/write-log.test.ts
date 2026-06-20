import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WRITE_LOG_LIMIT,
  createWriteLog,
  describeWriteLogEntry,
  normalizeWriteLogEntries,
  summarizeWriteLog,
  type WriteLogEntry,
  type WriteLogSnapshot
} from "./write-log.js";

describe("createWriteLog", () => {
  let clock = 0;
  const now = (): number => clock;

  beforeEach(() => {
    clock = 1_700_000_000_000;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records entries newest-last with a monotonic seq and ISO timestamp", () => {
    const log = createWriteLog({ now });
    log.record({ kind: "journalAppend", ok: true, detail: { seq: 3, entries: 1 } });
    clock += 1000;
    log.record({ kind: "snapshotSave", ok: true, detail: { nodeCount: 10 } });

    const { entries } = log.snapshot();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ seq: 1, kind: "journalAppend", ok: true });
    expect(entries[1]).toMatchObject({ seq: 2, kind: "snapshotSave", ok: true });
    expect(entries[0]!.at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(entries[1]!.at).toBe(new Date(1_700_000_001_000).toISOString());
  });

  it("drops undefined detail values and omits empty detail", () => {
    const log = createWriteLog({ now });
    log.record({ kind: "bootSnapshot", ok: true, detail: { message: undefined } });
    log.record({ kind: "journalAppend", ok: true, detail: { seq: 1, skip: undefined } });

    const { entries } = log.snapshot();
    expect(entries[0]!.detail).toBeUndefined();
    expect(entries[1]!.detail).toEqual({ seq: 1 });
  });

  it("caps the ring buffer at the limit, keeping the newest entries", () => {
    const log = createWriteLog({ now, limit: 3 });
    for (let index = 0; index < 5; index += 1) {
      log.record({ kind: "journalAppend", ok: true, detail: { seq: index } });
    }

    const { entries } = log.snapshot();
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.detail?.seq)).toEqual([2, 3, 4]);
    // seq keeps climbing even after eviction so the UI can dedupe stably.
    expect(entries.map((entry) => entry.seq)).toEqual([3, 4, 5]);
  });

  it("clear() empties the buffer", () => {
    const log = createWriteLog({ now });
    log.record({ kind: "snapshotSave", ok: true });
    log.clear();
    expect(log.snapshot().entries).toEqual([]);
  });

  it("debounce-persists a coalesced snapshot after records settle", () => {
    const persist = vi.fn<(snapshot: WriteLogSnapshot) => void>();
    const log = createWriteLog({ now, persist, persistDebounceMs: 500 });

    log.record({ kind: "journalAppend", ok: true, detail: { seq: 1 } });
    log.record({ kind: "snapshotSave", ok: true, detail: { nodeCount: 9 } });
    expect(persist).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]![0].entries).toHaveLength(2);
  });

  it("hydrate() restores prior entries and continues the seq", () => {
    const persist = vi.fn<(snapshot: WriteLogSnapshot) => void>();
    const log = createWriteLog({ now, persist, persistDebounceMs: 500 });
    log.hydrate({
      version: 1,
      entries: [
        { version: 1, seq: 41, at: "2026-06-20T00:00:00.000Z", kind: "snapshotSave", ok: true }
      ]
    } satisfies WriteLogSnapshot);

    // hydration alone does not re-persist (it came from storage).
    vi.advanceTimersByTime(500);
    expect(persist).not.toHaveBeenCalled();

    log.record({ kind: "journalAppend", ok: true, detail: { seq: 1 } });
    const { entries } = log.snapshot();
    expect(entries.map((entry) => entry.seq)).toEqual([41, 42]);
  });
});

describe("normalizeWriteLogEntries", () => {
  it("accepts a snapshot object or a bare entries array and rejects junk", () => {
    const valid: WriteLogEntry = {
      version: 1,
      seq: 1,
      at: "2026-06-20T00:00:00.000Z",
      kind: "snapshotSave",
      ok: true,
      detail: { nodeCount: 5 }
    };
    expect(normalizeWriteLogEntries({ version: 1, entries: [valid] })).toEqual([valid]);
    expect(normalizeWriteLogEntries([valid])).toEqual([valid]);
    expect(normalizeWriteLogEntries(undefined)).toEqual([]);
    expect(normalizeWriteLogEntries({ entries: [{ kind: "nope" }] })).toEqual([]);
  });

  it("keeps only the newest LIMIT entries", () => {
    const entries = Array.from({ length: WRITE_LOG_LIMIT + 10 }, (_unused, index) => ({
      version: 1 as const,
      seq: index,
      at: "2026-06-20T00:00:00.000Z",
      kind: "journalAppend" as const,
      ok: true
    }));
    expect(normalizeWriteLogEntries(entries)).toHaveLength(WRITE_LOG_LIMIT);
  });
});

describe("summarizeWriteLog", () => {
  it("derives counts, the latest persisted node totals, and pending journal coverage", () => {
    const entries: WriteLogEntry[] = [
      entry(1, "journalAppend", true, { seq: 10, entries: 2 }),
      entry(2, "snapshotSave", true, {
        nodeCount: 100,
        closedCount: 40,
        nodeDelta: 2,
        closedDelta: 0,
        journalSeqIncluded: 10
      }),
      entry(3, "journalPrune", true, { throughSeq: 10 }),
      entry(4, "journalAppend", true, { seq: 13, entries: 1 }),
      entry(5, "journalSpill", false, { entries: 1 }),
      entry(6, "saveFailed", false, { message: "quota" })
    ];

    const health = summarizeWriteLog(entries);
    expect(health.total).toBe(6);
    expect(health.nodeCount).toBe(100);
    expect(health.closedCount).toBe(40);
    expect(health.journaledThroughSeq).toBe(13);
    expect(health.coveredThroughSeq).toBe(10);
    expect(health.pendingJournalCount).toBe(3);
    expect(health.spillCount).toBe(1);
    expect(health.errorCount).toBe(1);
  });

  it("returns zeroed health for an empty log", () => {
    expect(summarizeWriteLog([])).toMatchObject({ total: 0, errorCount: 0, spillCount: 0 });
  });
});

describe("describeWriteLogEntry", () => {
  it("renders a human title and severity for the durability-chain kinds", () => {
    expect(describeWriteLogEntry(entry(1, "journalAppend", true, { seq: 7, entries: 2 }))).toEqual({
      severity: "ok",
      title: expect.stringContaining("Journaled 2"),
      detailText: expect.stringContaining("seq=7")
    });

    expect(
      describeWriteLogEntry(entry(2, "journalPrune", true, { throughSeq: 7 })).title
    ).toContain("Trimmed journal");

    const save = describeWriteLogEntry(
      entry(3, "snapshotSave", true, { nodeCount: 100, nodeDelta: -1, closedCount: 5 })
    );
    expect(save.severity).toBe("ok");
    expect(save.title).toContain("100");
  });

  it("flags spills and failures as warn/error", () => {
    expect(describeWriteLogEntry(entry(1, "journalSpill", false)).severity).toBe("warn");
    expect(
      describeWriteLogEntry(entry(2, "saveFailed", false, { message: "quota" }))
    ).toMatchObject({ severity: "error" });
  });

  it("flags a large drop in node count as a data-loss warning", () => {
    const save = describeWriteLogEntry(
      entry(1, "snapshotSave", true, { nodeCount: 10, nodeDelta: -200, closedCount: 1 })
    );
    expect(save.severity).toBe("warn");
  });
});

function entry(
  seq: number,
  kind: WriteLogEntry["kind"],
  ok: boolean,
  detail?: WriteLogEntry["detail"]
): WriteLogEntry {
  return {
    version: 1,
    seq,
    at: "2026-06-20T00:00:00.000Z",
    kind,
    ok,
    ...(detail ? { detail } : {})
  };
}
