import { describe, expect, it } from "vitest";

import type { TraceSnapshot } from "./trace.js";
import {
  createPerformanceProfileExport,
  performanceProfileEntryCount,
  performanceProfileFilename,
  summarizePerformanceProfile
} from "./profile.js";

describe("performance profile helpers", () => {
  it("summarizes background and all labeled sidebar trace durations together", () => {
    expect(
      summarizePerformanceProfile({
        background: traceSnapshot([
          { source: "background", name: "background.save", atMs: 1, durationMs: 12 },
          { source: "background", name: "background.save", atMs: 2, durationMs: 8 }
        ]),
        sidebars: [
          {
            id: "sidebar-window-1",
            label: "Sidebar window 1",
            windowId: 1,
            snapshot: traceSnapshot([
              { source: "sidebar", name: "sidebar.render", atMs: 3, durationMs: 6 }
            ])
          },
          {
            id: "sidebar-window-2",
            label: "Sidebar window 2",
            windowId: 2,
            snapshot: traceSnapshot([
              { source: "sidebar", name: "sidebar.patch", atMs: 4, durationMs: 5 }
            ])
          }
        ]
      })
    ).toEqual([
      {
        name: "background.save",
        count: 2,
        totalMs: 20,
        avgMs: 10,
        maxMs: 12
      },
      {
        name: "sidebar.render",
        count: 1,
        totalMs: 6,
        avgMs: 6,
        maxMs: 6
      },
      {
        name: "sidebar.patch",
        count: 1,
        totalMs: 5,
        avgMs: 5,
        maxMs: 5
      }
    ]);
  });

  it("handles profiles without an open sidebar snapshot", () => {
    const profile = {
      background: traceSnapshot([
        { source: "background", name: "background.runtime.message", atMs: 1, durationMs: 3 },
        { source: "background", name: "background.profile.enabled", atMs: 2 }
      ])
    };

    expect(performanceProfileEntryCount(profile)).toBe(2);
    expect(summarizePerformanceProfile(profile)).toEqual([
      {
        name: "background.runtime.message",
        count: 1,
        totalMs: 3,
        avgMs: 3,
        maxMs: 3
      }
    ]);
  });

  it("creates the exported profile payload and date-stamped filename", () => {
    const background = traceSnapshot([
      { source: "background", name: "background.save", atMs: 1000, durationMs: 4 }
    ]);
    const payload = createPerformanceProfileExport({
      background,
      sidebars: [
        {
          id: "sidebar-window-7",
          label: "Sidebar window 7",
          windowId: 7,
          snapshot: traceSnapshot([
            { source: "sidebar", name: "sidebar.render", atMs: 1001, durationMs: 2 }
          ])
        }
      ]
    }, { now: 3000 });

    expect(payload).toEqual({
      schema: "tabs-outliner-profile",
      exportedAt: "1970-01-01T00:00:03.000Z",
      snapshot: {
        background,
        sidebars: [
          {
            id: "sidebar-window-7",
            label: "Sidebar window 7",
            windowId: 7,
            snapshot: traceSnapshot([
              { source: "sidebar", name: "sidebar.render", atMs: 1001, durationMs: 2 }
            ])
          }
        ]
      },
      summary: [
        {
          name: "background.save",
          count: 1,
          totalMs: 4,
          avgMs: 4,
          maxMs: 4
        },
        {
          name: "sidebar.render",
          count: 1,
          totalMs: 2,
          avgMs: 2,
          maxMs: 2
        }
      ]
    });
    expect(performanceProfileFilename(new Date(2026, 4, 9))).toBe("tabs-outliner-profile-2026-05-09.json");
  });
});

function traceSnapshot(entries: TraceSnapshot["entries"]): TraceSnapshot {
  return {
    enabled: true,
    maxEntries: 500,
    entries
  };
}
