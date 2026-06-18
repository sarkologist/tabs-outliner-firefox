import { describe, expect, it, vi } from "vitest";
import {
  createDiagnosticsScheduler,
  type DiagnosticsSchedulerClock
} from "./diagnostics-scheduler.js";

describe("createDiagnosticsScheduler", () => {
  it("coalesces burst requests into one delayed diagnostics load", async () => {
    const clock = new FakeClock();
    const load = vi.fn().mockResolvedValue(undefined);
    const scheduler = createDiagnosticsScheduler(load, { clock, delayMs: 250 });

    scheduler.request();
    scheduler.request();
    scheduler.request();

    expect(load).not.toHaveBeenCalled();
    expect(clock.timerCount).toBe(1);

    await clock.runNext();

    expect(load).toHaveBeenCalledTimes(1);
    expect(clock.timerCount).toBe(0);
  });

  it("resets the pending diagnostics timer when more requests arrive before it runs", async () => {
    const clock = new FakeClock();
    const load = vi.fn().mockResolvedValue(undefined);
    const scheduler = createDiagnosticsScheduler(load, { clock, delayMs: 250 });

    scheduler.request();
    scheduler.request();
    scheduler.request();

    expect(load).not.toHaveBeenCalled();
    expect(clock.clearCount).toBe(2);
    expect(clock.timerCount).toBe(1);

    await clock.runNext();

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("runs one follow-up load for requests made while diagnostics are in flight", async () => {
    const clock = new FakeClock();
    const firstLoad = deferred();
    const load = vi.fn(() =>
      load.mock.calls.length === 1 ? firstLoad.promise : Promise.resolve()
    );
    const scheduler = createDiagnosticsScheduler(load, { clock, delayMs: 250 });

    scheduler.request();
    await clock.runNext();

    scheduler.request();
    scheduler.request();

    expect(load).toHaveBeenCalledTimes(1);
    expect(clock.timerCount).toBe(0);

    firstLoad.resolve();
    await firstLoad.promise;
    await Promise.resolve();

    expect(clock.timerCount).toBe(1);

    await clock.runNext();

    expect(load).toHaveBeenCalledTimes(2);
    expect(clock.timerCount).toBe(0);
  });

  it("defers a pending diagnostics load when more idle time is requested", async () => {
    const clock = new FakeClock();
    const load = vi.fn().mockResolvedValue(undefined);
    const defer = vi.fn().mockReturnValueOnce(125).mockReturnValueOnce(0);
    const scheduler = createDiagnosticsScheduler(load, { clock, delayMs: 250, defer });

    scheduler.request();
    await clock.runNext();

    expect(load).not.toHaveBeenCalled();
    expect(defer).toHaveBeenCalledTimes(1);
    expect(clock.delayHistory).toEqual([250, 125]);
    expect(clock.timerCount).toBe(1);

    await clock.runNext();

    expect(load).toHaveBeenCalledTimes(1);
    expect(defer).toHaveBeenCalledTimes(2);
    expect(clock.timerCount).toBe(0);
  });

  it("cancels a pending diagnostics load", () => {
    const clock = new FakeClock();
    const load = vi.fn().mockResolvedValue(undefined);
    const scheduler = createDiagnosticsScheduler(load, { clock, delayMs: 250 });

    scheduler.request();
    scheduler.cancel();

    expect(clock.timerCount).toBe(0);
    expect(load).not.toHaveBeenCalled();
  });
});

class FakeClock implements DiagnosticsSchedulerClock {
  private nextId = 1;
  private readonly timers = new Map<number, () => void>();
  clearCount = 0;
  delayHistory: number[] = [];

  get timerCount(): number {
    return this.timers.size;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.delayHistory.push(delayMs);
    this.timers.set(id, callback);
    return id;
  }

  clearTimeout(timerId: number): void {
    this.clearCount += 1;
    this.timers.delete(timerId);
  }

  async runNext(): Promise<void> {
    const next = this.timers.entries().next().value;
    if (!next) {
      throw new Error("No pending timer");
    }

    const [timerId, callback] = next;
    this.timers.delete(timerId);
    callback();
    await Promise.resolve();
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
