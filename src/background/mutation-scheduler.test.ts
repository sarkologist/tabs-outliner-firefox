import { describe, expect, it } from "vitest";
import { createMutationScheduler } from "./mutation-scheduler.js";
import { createPerformanceTracer } from "../perf/trace.js";

function createScheduler() {
  return createMutationScheduler({
    perfTrace: createPerformanceTracer("background"),
    hasPendingRuntimeRefresh: () => false
  });
}

describe("mutation scheduler high-priority idle predicate", () => {
  it("reports busy while a high-priority mutation runs and idle once it settles", async () => {
    const scheduler = createScheduler();
    expect(scheduler.isHighPrioritySchedulerIdle()).toBe(true);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = scheduler.enqueueMutation(() => gate);

    // The drain is scheduled on a microtask; let it start the mutation before checking.
    await Promise.resolve();
    expect(scheduler.isHighPrioritySchedulerIdle()).toBe(false);

    release();
    await run;
    expect(scheduler.isHighPrioritySchedulerIdle()).toBe(true);
  });

  it("stays idle for a queued low-priority mutation", async () => {
    const scheduler = createScheduler();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = scheduler.enqueueMutation(() => gate, undefined, { priority: "low" });

    await Promise.resolve();
    // A low-priority mutation must not register as high-priority work in flight.
    expect(scheduler.isHighPrioritySchedulerIdle()).toBe(true);

    release();
    await run;
    expect(scheduler.isHighPrioritySchedulerIdle()).toBe(true);
  });
});
