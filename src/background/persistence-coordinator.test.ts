import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPersistenceCoordinator,
  type PersistenceCoordinatorDeps
} from "./persistence-coordinator.js";
import { createPerformanceTracer } from "../perf/trace.js";
import type { OutlineNode, OutlineState } from "../model/types.js";
import type { WriteLogChangeInput, WriteLogInput } from "./write-log.js";

// Focused coverage for the write-activity instrumentation's safety contract: the debug log is
// observational and must never affect persistence. The broader save/journal behavior is covered by
// controller.test.ts (which drives the real controller).

function emptyState(): OutlineState {
  return { version: 1, rootIds: [], nodes: {} };
}

function fakeApi(setCalls: Record<string, unknown>[]): WebExtensionBrowser {
  const store = new Map<string, unknown>();
  return {
    storage: {
      local: {
        get: async (key?: string | string[] | Record<string, unknown> | null) =>
          typeof key === "string" ? { [key]: store.get(key) } : Object.fromEntries(store.entries()),
        set: async (items: Record<string, unknown>) => {
          setCalls.push(items);
          for (const [key, value] of Object.entries(items)) {
            store.set(key, value);
          }
        },
        remove: async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            store.delete(key);
          }
        }
      },
      onChanged: { addListener: () => undefined, removeListener: () => undefined }
    }
  } as unknown as WebExtensionBrowser;
}

function makeDeps(
  overrides: Partial<PersistenceCoordinatorDeps> & { setCalls?: Record<string, unknown>[] } = {}
): PersistenceCoordinatorDeps {
  const setCalls = overrides.setCalls ?? [];
  const state = emptyState();
  return {
    api: fakeApi(setCalls),
    perfTrace: createPerformanceTracer("background"),
    now: () => 1000,
    getState: () => state,
    getLastPersistedState: () => undefined,
    setLastPersistedState: () => undefined,
    deferPersistedStateBaselineClone: () => undefined,
    recordIncidentLog: async () => undefined,
    recordWriteEvent: () => undefined,
    recordWriteChange: () => undefined,
    clearCompletedRuntimeLifecycleJournalEntriesAfterSave: async () => undefined,
    ...overrides
  };
}

describe("persistence coordinator write-activity safety", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a snapshotSave on a successful save", async () => {
    const events: WriteLogInput[] = [];
    const coordinator = createPersistenceCoordinator(
      makeDeps({ recordWriteEvent: (event) => events.push(event) })
    );

    coordinator.scheduleStateSave(emptyState());
    await coordinator.flushPendingSaves();

    expect(events.some((event) => event.kind === "snapshotSave" && event.ok)).toBe(true);
  });

  it("names deleted nodes from the runtime fast path using the pre-update state", async () => {
    const changes: WriteLogChangeInput[] = [];
    const tab: OutlineNode = {
      id: "tab:1",
      kind: "tab",
      status: "live",
      childIds: [],
      title: "Gmail",
      collapsed: false,
      createdAt: 0,
      updatedAt: 0
    };
    const previous: OutlineState = { version: 1, rootIds: ["tab:1"], nodes: { "tab:1": tab } };
    const coordinator = createPersistenceCoordinator(
      makeDeps({
        // getState() returns the post-delete state; `previous` carries the node's title.
        getState: () => emptyState(),
        recordWriteChange: (change) => changes.push(change)
      })
    );
    await coordinator.createAndInitJournal();

    coordinator.queueRuntimeEventJournalFromUpdate(
      {
        type: "treeStructureUpdated",
        updatedNodes: [],
        deletedNodeIds: ["tab:1"],
        deletedClosedCount: 0,
        rootIds: []
      },
      "runtimeFastPath",
      previous
    );
    await coordinator.flushEventJournalQueue();

    expect(changes).toHaveLength(1);
    expect(changes[0]!.headline).toContain("Deleted");
    expect(changes[0]!.lines).toContain("'Gmail'");
  });

  it("names a top-level reorder in the change log from the command's subject node", async () => {
    const changes: WriteLogChangeInput[] = [];
    const win = (id: string, title: string): OutlineNode => ({
      id,
      kind: "window",
      status: "live",
      childIds: [],
      title,
      collapsed: false,
      createdAt: 0,
      updatedAt: 0
    });
    const nodes = {
      "win:1": win("win:1", "Inbox"),
      "win:2": win("win:2", "Work"),
      "win:3": win("win:3", "Reading")
    };
    const previous: OutlineState = { version: 1, rootIds: ["win:1", "win:2", "win:3"], nodes };
    // 'Reading' nudged up one slot -- an adjacent swap that order alone can't attribute.
    const next: OutlineState = { version: 1, rootIds: ["win:1", "win:3", "win:2"], nodes };
    const coordinator = createPersistenceCoordinator(
      makeDeps({ getState: () => next, recordWriteChange: (change) => changes.push(change) })
    );
    await coordinator.createAndInitJournal();

    await coordinator.appendCommandJournal(
      previous,
      next,
      ["win:3"],
      "moveNode",
      "command",
      undefined,
      "win:3"
    );

    expect(changes.map((change) => change.headline)).toContain(
      "Moved 'Reading' (window) after 'Inbox'"
    );
  });

  it("names a non-journaled (startup/reconciliation) tree change at save time", async () => {
    const changes: WriteLogChangeInput[] = [];
    const work: OutlineNode = {
      id: "win:work",
      kind: "window",
      status: "closed",
      childIds: [],
      title: "Work",
      collapsed: false,
      createdAt: 0,
      updatedAt: 0
    };
    const phantom: OutlineNode = {
      id: "win:phantom",
      kind: "window",
      status: "live",
      childIds: ["tab:new"],
      title: "Group",
      collapsed: false,
      createdAt: 0,
      updatedAt: 0
    };
    const newTab: OutlineNode = {
      id: "tab:new",
      kind: "tab",
      status: "live",
      parentId: "win:phantom",
      childIds: [],
      title: "New Tab",
      collapsed: false,
      createdAt: 0,
      updatedAt: 0
    };
    const loaded: OutlineState = { version: 1, rootIds: ["win:work"], nodes: { "win:work": work } };
    // Startup reconcile added a phantom window+tab (the bug) and persisted it WITHOUT journaling.
    const reconciled: OutlineState = {
      version: 1,
      rootIds: ["win:work", "win:phantom"],
      nodes: { "win:work": work, "win:phantom": phantom, "tab:new": newTab }
    };
    const coordinator = createPersistenceCoordinator(
      makeDeps({
        getState: () => reconciled,
        getLastPersistedState: () => loaded, // the persisted baseline is the loaded tree
        recordWriteChange: (change) => changes.push(change)
      })
    );

    coordinator.scheduleStateSave(reconciled, "normal", ["win:phantom", "tab:new"]);
    await coordinator.flushPendingSaves();

    expect(changes).toHaveLength(1);
    expect(changes[0]!.headline).toContain("Added 'Group' (window)");
    expect(changes[0]!.lines).toContain("'New Tab'");
  });

  it("never lets a throwing write-activity logger break the save (durability is independent)", async () => {
    const setCalls: Record<string, unknown>[] = [];
    const coordinator = createPersistenceCoordinator(
      makeDeps({
        setCalls,
        recordWriteEvent: () => {
          throw new Error("write-log boom");
        }
      })
    );

    coordinator.scheduleStateSave(emptyState());
    // Must resolve, not reject: the logger fault is swallowed and the snapshot still commits.
    await expect(coordinator.flushPendingSaves()).resolves.toBeUndefined();
    expect(setCalls.length).toBeGreaterThan(0);
  });
});
