import { describe, expect, it } from "vitest";
import { createPerformanceTracer, summarizeTraceEvents } from "./trace.js";

describe("createPerformanceTracer", () => {
  it("does not record entries while disabled", () => {
    const tracer = createPerformanceTracer("sidebar", { clock: fakeClock() });

    const value = tracer.measure("work", { rows: 10 }, () => 42);
    tracer.mark("ignored");

    expect(value).toBe(42);
    expect(tracer.snapshot().entries).toEqual([]);
  });

  it("records marks and measured durations when enabled", () => {
    const clock = fakeClock();
    const tracer = createPerformanceTracer("background", { clock, enabled: true });

    tracer.mark("start", { command: "restoreNode", ignored: undefined });
    const value = tracer.measure("work", { command: "restoreNode" }, () => {
      clock.advance(12.5);
      return "done";
    });

    expect(value).toBe("done");
    expect(tracer.snapshot().entries).toEqual([
      {
        source: "background",
        name: "start",
        atMs: 1000,
        detail: {
          command: "restoreNode"
        }
      },
      {
        source: "background",
        name: "work",
        atMs: 1000,
        durationMs: 12.5,
        detail: {
          command: "restoreNode"
        }
      }
    ]);
  });

  it("records async measured durations", async () => {
    const clock = fakeClock();
    const tracer = createPerformanceTracer("sidebar", { clock, enabled: true });

    await tracer.measureAsync("async.work", async () => {
      clock.advance(8);
    });

    expect(tracer.snapshot().entries[0]).toMatchObject({
      source: "sidebar",
      name: "async.work",
      atMs: 1000,
      durationMs: 8
    });
  });

  it("keeps a bounded ring buffer", () => {
    const clock = fakeClock();
    const tracer = createPerformanceTracer("sidebar", { clock, enabled: true, maxEntries: 2 });

    tracer.mark("one");
    tracer.mark("two");
    tracer.mark("three");

    expect(tracer.snapshot().entries.map((entry) => entry.name)).toEqual(["two", "three"]);
  });
});

describe("summarizeTraceEvents", () => {
  it("groups measured events by name", () => {
    expect(
      summarizeTraceEvents([
        { source: "sidebar", name: "render", atMs: 1, durationMs: 10 },
        { source: "sidebar", name: "render", atMs: 2, durationMs: 30 },
        { source: "background", name: "save", atMs: 3, durationMs: 20 },
        { source: "background", name: "mark", atMs: 4 }
      ])
    ).toEqual([
      {
        name: "render",
        count: 2,
        totalMs: 40,
        avgMs: 20,
        maxMs: 30
      },
      {
        name: "save",
        count: 1,
        totalMs: 20,
        avgMs: 20,
        maxMs: 20
      }
    ]);
  });
});

function fakeClock(): {
  timeOrigin: number;
  now(): number;
  advance(durationMs: number): void;
} {
  let now = 0;
  return {
    timeOrigin: 1000,
    now: () => now,
    advance: (durationMs) => {
      now += durationMs;
    }
  };
}
