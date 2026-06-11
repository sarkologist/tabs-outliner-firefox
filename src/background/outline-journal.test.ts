import { describe, expect, it } from "vitest";

import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import { createFaultyStorage } from "../test/faulty-storage.test-support.js";
import {
  JOURNAL_META_KEY,
  JOURNAL_SLOT_COUNT,
  JOURNAL_SLOT_PREFIX,
  JournalFullError,
  type OutlineJournalEntry,
  createOutlineJournal,
  journalTouchedNodeIds,
  replayJournal,
  replayJournalWithHistory
} from "./outline-journal.js";
import { createEmptyHistoryState, pushRedoEntry, pushUndoEntry } from "./history.js";

function makeNode(id: NodeId, overrides: Partial<OutlineNode> = {}): OutlineNode {
  return {
    id,
    kind: "tab",
    status: "closed",
    childIds: [],
    title: id,
    collapsed: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  };
}

function makeState(nodes: OutlineNode[], rootIds: NodeId[] = []): OutlineState {
  return {
    version: 1,
    rootIds,
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node]))
  };
}

describe("outline journal", () => {
  it("round-trips appended entries in order with correct seq and epoch", async () => {
    const faulty = createFaultyStorage();
    const journal = createOutlineJournal(faulty.api, { epoch: 7, now: () => 5000 });
    await journal.init();

    await journal.append([
      { kind: "command", label: "rename", delta: { updatedNodes: [makeNode("tab:1")] } },
      { kind: "command", label: "close", delta: { deletedNodeIds: ["tab:2"] } }
    ]);

    const reopened = createOutlineJournal(faulty.api, { epoch: 8, now: () => 9000 });
    const result = await reopened.init();

    expect(result.headSeq).toBe(2);
    expect(result.tailSeq).toBe(0);
    expect(result.entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(result.entries.map((entry) => entry.epoch)).toEqual([7, 7]);
    expect(result.entries[0]).toMatchObject({ kind: "command", label: "rename", at: 5000 });
    expect(result.entries[0]?.delta?.updatedNodes?.[0]?.id).toBe("tab:1");
    expect(result.entries[1]?.delta?.deletedNodeIds).toEqual(["tab:2"]);
  });

  it("writes an explicit spill marker item as a delta-less spill entry", async () => {
    const faulty = createFaultyStorage();
    const journal = createOutlineJournal(faulty.api, { epoch: 1, now: () => 1000 });
    await journal.init();

    const result = await journal.append([{ kind: "command", label: "deleteNode", spill: true }]);

    expect(result.spilled).toBe(true);
    const reopened = createOutlineJournal(faulty.api, { epoch: 2 });
    const reloaded = await reopened.init();
    expect(reloaded.entries).toHaveLength(1);
    expect(reloaded.entries[0]).toMatchObject({ kind: "command", label: "deleteNode", spill: true });
    expect(reloaded.entries[0]?.delta).toBeUndefined();
  });

  it("writes a spill marker without the delta when a delta exceeds the spill limits", async () => {
    const faulty = createFaultyStorage();
    const journal = createOutlineJournal(faulty.api, { epoch: 1, now: () => 1000 });
    await journal.init();

    const hugeDelta = { updatedNodes: Array.from({ length: 2001 }, (_value, index) => makeNode(`tab:${index}`)) };
    const result = await journal.append([{ kind: "command", label: "import", delta: hugeDelta }]);

    expect(result.spilled).toBe(true);
    const reopened = createOutlineJournal(faulty.api, { epoch: 2 });
    const reloaded = await reopened.init();
    expect(reloaded.entries).toHaveLength(1);
    expect(reloaded.entries[0]?.spill).toBe(true);
    expect(reloaded.entries[0]?.delta).toBeUndefined();
  });

  it("throws JournalFullError when the ring wraps without pruning", async () => {
    const faulty = createFaultyStorage();
    const journal = createOutlineJournal(faulty.api, { epoch: 1, now: () => 1000 });
    await journal.init();

    for (let index = 0; index < JOURNAL_SLOT_COUNT; index += 1) {
      await journal.append([{ kind: "command", delta: { updatedNodes: [makeNode(`tab:${index}`)] } }]);
    }

    await expect(journal.append([{ kind: "command", delta: { updatedNodes: [makeNode("tab:overflow")] } }]))
      .rejects.toBeInstanceOf(JournalFullError);
  });

  it("frees slots and advances tailSeq on prune", async () => {
    const faulty = createFaultyStorage();
    const journal = createOutlineJournal(faulty.api, { epoch: 1, now: () => 1000 });
    await journal.init();
    await journal.append([{ kind: "command", delta: { updatedNodes: [makeNode("tab:1")] } }]);
    await journal.append([{ kind: "command", delta: { updatedNodes: [makeNode("tab:2")] } }]);
    expect(journal.pendingEntryCount()).toBe(2);

    await journal.prune(1);

    expect(journal.pendingEntryCount()).toBe(1);
    expect(faulty.snapshot()[`${JOURNAL_SLOT_PREFIX}0`]).toBeUndefined();

    const reopened = createOutlineJournal(faulty.api, { epoch: 2 });
    const result = await reopened.init();
    expect(result.tailSeq).toBe(1);
    expect(result.entries.map((entry) => entry.seq)).toEqual([2]);
  });

  it("replayJournal applies updates, deletes, and root replacement; is identity for untouched and no-op for empty", () => {
    const base = makeState(
      [makeNode("tab:1", { title: "one" }), makeNode("tab:2", { title: "two" }), makeNode("tab:3", { title: "three" })],
      ["tab:1", "tab:2", "tab:3"]
    );

    const entries: OutlineJournalEntry[] = [
      { seq: 1, epoch: 1, at: 1, kind: "command", delta: { updatedNodes: [makeNode("tab:1", { title: "renamed", childIds: ["tab:9"] })] } },
      { seq: 2, epoch: 1, at: 2, kind: "command", delta: { deletedNodeIds: ["tab:2"], rootIds: ["tab:1", "tab:3"] } }
    ];

    const next = replayJournal(base, entries);

    expect(next).not.toBe(base);
    expect(next.nodes["tab:1"]?.title).toBe("renamed");
    expect(next.nodes["tab:1"]?.childIds).toEqual(["tab:9"]);
    expect(next.nodes["tab:2"]).toBeUndefined();
    expect(next.nodes["tab:3"]).toBe(base.nodes["tab:3"]); // untouched node preserved by reference
    expect(next.rootIds).toEqual(["tab:1", "tab:3"]);

    // Empty entry list is a no-op returning the same object.
    expect(replayJournal(base, [])).toBe(base);
  });

  it("stops at the last good seq when a slot is corrupt", async () => {
    const faulty = createFaultyStorage();
    const journal = createOutlineJournal(faulty.api, { epoch: 1, now: () => 1000 });
    await journal.init();
    await journal.append([{ kind: "command", delta: { updatedNodes: [makeNode("tab:1")] } }]); // batch 0, seq 1
    await journal.append([{ kind: "command", delta: { updatedNodes: [makeNode("tab:2")] } }]); // batch 1, seq 2
    await journal.append([{ kind: "command", delta: { updatedNodes: [makeNode("tab:3")] } }]); // batch 2, seq 3

    // Corrupt the second slot.
    await faulty.api.storage.local.set({ [`${JOURNAL_SLOT_PREFIX}1`]: { not: "a slot" } });

    const reopened = createOutlineJournal(faulty.api, { epoch: 2 });
    const result = await reopened.init();

    expect(result.entries.map((entry) => entry.seq)).toEqual([1]);
    expect(result.truncatedAtSeq).toBe(1);
    expect(result.headSeq).toBe(1);
  });

  it("journalTouchedNodeIds is the union of updated and deleted ids", () => {
    const entries: OutlineJournalEntry[] = [
      { seq: 1, epoch: 1, at: 1, kind: "command", delta: { updatedNodes: [makeNode("tab:1"), makeNode("tab:2")] } },
      { seq: 2, epoch: 1, at: 2, kind: "command", delta: { deletedNodeIds: ["tab:2", "tab:3"] } },
      { seq: 3, epoch: 1, at: 3, kind: "recovery", spill: true }
    ];

    expect([...journalTouchedNodeIds(entries)].sort()).toEqual(["tab:1", "tab:2", "tab:3"]);
  });

  it("serializes overlapping appends so they never share a seq or slot", async () => {
    const faulty = createFaultyStorage();
    faulty.setLatencyMs(15);
    const journal = createOutlineJournal(faulty.api, { epoch: 1, now: () => 1000 });
    await journal.init();

    // Fire two appends without awaiting the first (models an event-coalescer timer flush
    // overlapping a command append across the storage await).
    const [first, second] = await Promise.all([
      journal.append([{ kind: "runtimeEvent", label: "a", delta: { updatedNodes: [makeNode("tab:1")] } }]),
      journal.append([{ kind: "command", label: "b", delta: { updatedNodes: [makeNode("tab:2")] } }])
    ]);

    expect(first.seq).not.toBe(second.seq);
    const reopened = createOutlineJournal(faulty.api, { epoch: 2 });
    const result = await reopened.init();
    expect(result.entries.map((entry) => entry.label)).toEqual(["a", "b"]);
    expect(result.entries.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it("serializes prune against a concurrent append so meta never references removed slots", async () => {
    const faulty = createFaultyStorage();
    const journal = createOutlineJournal(faulty.api, { epoch: 1, now: () => 1000 });
    await journal.init();
    await journal.append([{ kind: "command", delta: { updatedNodes: [makeNode("tab:1")] } }]);
    await journal.append([{ kind: "command", delta: { updatedNodes: [makeNode("tab:2")] } }]);

    faulty.setLatencyMs(15);
    const [, appended] = await Promise.all([
      journal.prune(2),
      journal.append([{ kind: "command", label: "later", delta: { updatedNodes: [makeNode("tab:3")] } }])
    ]);

    expect(appended.seq).toBe(3);
    const reopened = createOutlineJournal(faulty.api, { epoch: 2 });
    const result = await reopened.init();
    expect(result.truncatedAtSeq).toBeUndefined();
    expect(result.entries.map((entry) => entry.seq)).toEqual([3]);
    expect(result.tailSeq).toBe(2);
  });

  it("leaves pending state unchanged and rethrows when an append set rejects", async () => {
    const faulty = createFaultyStorage();
    const journal = createOutlineJournal(faulty.api, { epoch: 1, now: () => 1000 });
    await journal.init();
    await journal.append([{ kind: "command", delta: { updatedNodes: [makeNode("tab:1")] } }]);
    expect(journal.pendingEntryCount()).toBe(1);

    faulty.failNextSet(new Error("disk full"));
    await expect(journal.append([{ kind: "command", delta: { updatedNodes: [makeNode("tab:2")] } }]))
      .rejects.toThrow("disk full");

    expect(journal.pendingEntryCount()).toBe(1);
    // The failed append left no slot or meta advance behind.
    expect(faulty.snapshot()[`${JOURNAL_SLOT_PREFIX}1`]).toBeUndefined();
    expect((faulty.snapshot()[JOURNAL_META_KEY] as { headSeq?: number }).headSeq).toBe(1);
  });

  it("round-trips historyEntryId on appended entries, including spill markers", async () => {
    const faulty = createFaultyStorage();
    const journal = createOutlineJournal(faulty.api, { epoch: 1, now: () => 1000 });
    await journal.init();

    await journal.append([
      { kind: "command", label: "deleteNode", historyEntryId: "h-1", delta: { deletedNodeIds: ["tab:1"] } },
      { kind: "command", label: "deleteNode", historyEntryId: "h-2", spill: true }
    ]);

    const reopened = createOutlineJournal(faulty.api, { epoch: 2 });
    const result = await reopened.init();
    expect(result.entries[0]?.historyEntryId).toBe("h-1");
    expect(result.entries[1]).toMatchObject({ historyEntryId: "h-2", spill: true });
  });
});

describe("replayJournalWithHistory", () => {
  function journalEntry(
    seq: number,
    overrides: Partial<OutlineJournalEntry> & Pick<OutlineJournalEntry, "kind">
  ): OutlineJournalEntry {
    return { seq, epoch: 1, at: 1000, ...overrides };
  }

  it("rebuilds a missing undo entry for a history-tracked command from the fold states", () => {
    const tab = makeNode("tab:1", { title: "One" });
    const window = makeNode("window:10", { kind: "window", childIds: ["tab:1"] });
    const state = makeState([window, tab], ["window:10"]);
    const deletedParent = makeNode("window:10", { kind: "window", childIds: [], updatedAt: 2000 });

    const result = replayJournalWithHistory(state, [
      journalEntry(1, {
        kind: "command",
        label: "deleteNode",
        historyEntryId: "h-1",
        delta: { updatedNodes: [deletedParent], deletedNodeIds: ["tab:1"] }
      })
    ], { history: createEmptyHistoryState() });

    expect(result.state.nodes["tab:1"]).toBeUndefined();
    expect(result.historyChanged).toBe(true);
    expect(result.history.undoStack).toHaveLength(1);
    const entry = result.history.undoStack[0]!;
    expect(entry.id).toBe("h-1");
    expect(entry.commandType).toBe("deleteNode");
    // Undo restores the before-images taken from the fold state.
    expect(entry.undo.updatedNodes.map((node) => node.id).sort()).toEqual(["tab:1", "window:10"]);
    expect(entry.undo.updatedNodes.find((node) => node.id === "window:10")?.childIds).toEqual(["tab:1"]);
    expect(entry.redo.deletedNodeIds).toEqual(["tab:1"]);
  });

  it("does not duplicate an entry the loaded history already contains", () => {
    const tab = makeNode("tab:1");
    const state = makeState([tab], ["tab:1"]);
    const persisted = pushUndoEntry(createEmptyHistoryState(), {
      version: 1,
      id: "h-1",
      commandType: "renameGroup",
      label: "Rename",
      undo: { rootIds: ["tab:1"], updatedNodes: [tab], deletedNodeIds: [] },
      redo: { rootIds: ["tab:1"], updatedNodes: [makeNode("tab:1", { title: "Renamed" })], deletedNodeIds: [] }
    });

    const result = replayJournalWithHistory(state, [
      journalEntry(1, {
        kind: "command",
        label: "renameGroup",
        historyEntryId: "h-1",
        delta: { updatedNodes: [makeNode("tab:1", { title: "Renamed" })] }
      })
    ], { history: persisted });

    expect(result.historyChanged).toBe(false);
    expect(result.history.undoStack).toHaveLength(1);
    // The state delta still applies even when the history push is deduplicated.
    expect(result.state.nodes["tab:1"]?.title).toBe("Renamed");
  });

  it("replays an undo stack move and is idempotent when already reflected", () => {
    const renamed = makeNode("tab:1", { title: "Renamed" });
    const original = makeNode("tab:1", { title: "One" });
    const state = makeState([renamed], ["tab:1"]);
    const entry = {
      version: 1 as const,
      id: "h-1",
      commandType: "renameGroup" as const,
      label: "Rename",
      undo: { rootIds: ["tab:1"], updatedNodes: [original], deletedNodeIds: [] },
      redo: { rootIds: ["tab:1"], updatedNodes: [renamed], deletedNodeIds: [] }
    };
    const persisted = pushUndoEntry(createEmptyHistoryState(), entry);
    const undoJournalEntry = journalEntry(2, {
      kind: "historyReplay",
      label: "undo",
      historyEntryId: "h-1",
      delta: { updatedNodes: [original] }
    });

    const result = replayJournalWithHistory(state, [undoJournalEntry], { history: persisted });
    expect(result.historyChanged).toBe(true);
    expect(result.history.undoStack).toHaveLength(0);
    expect(result.history.redoStack.map((stackEntry) => stackEntry.id)).toEqual(["h-1"]);
    expect(result.state.nodes["tab:1"]?.title).toBe("One");

    // Same entry against a history that already moved h-1 to the redo stack: no-op.
    const again = replayJournalWithHistory(state, [undoJournalEntry], { history: result.history });
    expect(again.historyChanged).toBe(false);
    expect(again.history.redoStack).toHaveLength(1);
  });

  it("replays a redo stack move preserving the remaining redo entries", () => {
    const renamed = makeNode("tab:1", { title: "Renamed" });
    const original = makeNode("tab:1", { title: "One" });
    const state = makeState([original], ["tab:1"]);
    const entry = {
      version: 1 as const,
      id: "h-1",
      commandType: "renameGroup" as const,
      label: "Rename",
      undo: { rootIds: ["tab:1"], updatedNodes: [original], deletedNodeIds: [] },
      redo: { rootIds: ["tab:1"], updatedNodes: [renamed], deletedNodeIds: [] }
    };
    const persisted = pushRedoEntry(createEmptyHistoryState(), entry);

    const result = replayJournalWithHistory(state, [
      journalEntry(3, {
        kind: "historyReplay",
        label: "redo",
        historyEntryId: "h-1",
        delta: { updatedNodes: [renamed] }
      })
    ], { history: persisted });

    expect(result.historyChanged).toBe(true);
    expect(result.history.redoStack).toHaveLength(0);
    expect(result.history.undoStack.map((stackEntry) => stackEntry.id)).toEqual(["h-1"]);
    expect(result.state.nodes["tab:1"]?.title).toBe("Renamed");
  });

  it("skips history for spill markers, untracked labels, runtime events, and id-less entries", () => {
    const state = makeState([makeNode("tab:1")], ["tab:1"]);

    const result = replayJournalWithHistory(state, [
      journalEntry(1, { kind: "command", label: "deleteNode", historyEntryId: "h-1", spill: true }),
      journalEntry(2, { kind: "runtimeEvent", label: "tabRemoved", delta: { updatedNodes: [makeNode("tab:1", { title: "Event" })] } }),
      journalEntry(3, { kind: "command", label: "focusNode", historyEntryId: "h-2", delta: { updatedNodes: [makeNode("tab:1", { title: "Untracked" })] } }),
      journalEntry(4, { kind: "command", label: "renameGroup", delta: { updatedNodes: [makeNode("tab:1", { title: "NoId" })] } })
    ], { history: createEmptyHistoryState() });

    expect(result.historyChanged).toBe(false);
    expect(result.history.undoStack).toHaveLength(0);
    expect(result.state.nodes["tab:1"]?.title).toBe("NoId");
  });

  it("enforces the undo limit while folding rebuilt entries", () => {
    const state = makeState([makeNode("tab:1", { title: "t0" })], ["tab:1"]);
    const entries = Array.from({ length: 4 }, (_value, index) =>
      journalEntry(index + 1, {
        kind: "command",
        label: "renameGroup",
        historyEntryId: `h-${index + 1}`,
        delta: { updatedNodes: [makeNode("tab:1", { title: `t${index + 1}`, updatedAt: 1000 + index + 1 })] }
      })
    );

    const result = replayJournalWithHistory(state, entries, { history: createEmptyHistoryState(), limit: 2 });

    expect(result.history.undoStack.map((stackEntry) => stackEntry.id)).toEqual(["h-3", "h-4"]);
    expect(result.state.nodes["tab:1"]?.title).toBe("t4");
  });
});
