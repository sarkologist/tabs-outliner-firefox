import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPersistenceCoordinator,
  type PersistenceCoordinatorDeps
} from "./persistence-coordinator.js";
import { createPerformanceTracer } from "../perf/trace.js";
import type { OutlineState } from "../model/types.js";
import type { WriteLogInput } from "./write-log.js";

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
