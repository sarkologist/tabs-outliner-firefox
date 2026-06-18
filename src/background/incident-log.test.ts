import { describe, expect, it, vi } from "vitest";

import {
  INCIDENT_LOG_STORAGE_KEY,
  appendIncidentLogEntry,
  loadIncidentLog
} from "./incident-log.js";

describe("incident log", () => {
  it("keeps the newest entries in append order", async () => {
    const api = fakeApi();

    for (let index = 0; index < 105; index += 1) {
      await appendIncidentLogEntry(
        api,
        `event-${index}`,
        {
          index
        },
        {
          now: () => Date.parse("2026-06-07T12:00:00.000Z") + index
        }
      );
    }

    const entries = await loadIncidentLog(api);
    expect(entries).toHaveLength(100);
    expect(entries[0]).toMatchObject({ event: "event-5", detail: { index: 5 } });
    expect(entries.at(-1)).toMatchObject({ event: "event-104", detail: { index: 104 } });
  });

  it("serializes concurrent appends so entries are not overwritten", async () => {
    const api = fakeApi();

    await Promise.all(
      Array.from({ length: 5 }, (_value, index) =>
        appendIncidentLogEntry(
          api,
          `concurrent-${index}`,
          {
            index
          },
          {
            now: () => Date.parse("2026-06-07T12:00:00.000Z") + index
          }
        )
      )
    );

    await expect(loadIncidentLog(api)).resolves.toEqual(
      Array.from({ length: 5 }, (_value, index) =>
        expect.objectContaining({
          event: `concurrent-${index}`,
          detail: { index }
        })
      )
    );
  });

  it("appends without re-reading storage after the first append", async () => {
    const api = fakeApi();
    const getMock = vi.mocked(api.storage.local.get);

    for (let index = 0; index < 3; index += 1) {
      await appendIncidentLogEntry(
        api,
        `event-${index}`,
        { index },
        {
          now: () => Date.parse("2026-06-07T12:00:00.000Z") + index
        }
      );
    }

    expect(getMock).toHaveBeenCalledTimes(1);

    const entries = await loadIncidentLog(api);
    expect(entries).toEqual(
      Array.from({ length: 3 }, (_value, index) =>
        expect.objectContaining({
          event: `event-${index}`,
          detail: { index }
        })
      )
    );
  });

  it("normalizes malformed stored logs", async () => {
    const api = fakeApi({
      [INCIDENT_LOG_STORAGE_KEY]: {
        version: 1,
        entries: [
          {
            version: 1,
            at: "2026-06-07T12:00:00.000Z",
            event: "valid",
            detail: { count: 2, ok: true, ignored: { nested: true } }
          },
          {
            version: 1,
            at: 123,
            event: "bad"
          }
        ]
      }
    });

    await expect(loadIncidentLog(api)).resolves.toEqual([
      {
        version: 1,
        at: "2026-06-07T12:00:00.000Z",
        event: "valid",
        detail: { count: 2, ok: true }
      }
    ]);
  });
});

function fakeApi(items: Record<string, unknown> = {}): WebExtensionBrowser {
  const storage = new Map(Object.entries(items));
  return {
    storage: {
      local: {
        get: vi.fn(async (key?: string | string[] | Record<string, unknown> | null) => {
          if (typeof key === "string") {
            return { [key]: storage.get(key) };
          }
          if (Array.isArray(key)) {
            return Object.fromEntries(key.map((entry) => [entry, storage.get(entry)]));
          }
          return Object.fromEntries(storage);
        }),
        set: vi.fn(async (next: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(next)) {
            storage.set(key, value);
          }
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            storage.delete(key);
          }
        })
      }
    }
  } as unknown as WebExtensionBrowser;
}
