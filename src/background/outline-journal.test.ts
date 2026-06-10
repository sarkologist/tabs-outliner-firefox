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
  replayJournal
} from "./outline-journal.js";

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
});
