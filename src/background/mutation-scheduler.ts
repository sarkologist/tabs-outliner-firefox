import type { PerformanceTracer, TraceDetail } from "../perf/trace.js";

// Owns the high/low-priority mutation queues and the cooperative drain loop that
// serializes every state mutation routed through createBackgroundController. Extracted
// from the factory (no behavior change) as a Track-B decomposition: a self-contained
// state slice (the two queues + the two idle-resolver lists + the running/draining
// flags) behind a small interface.
//
// The one cross-cluster read — whether a runtime refresh is still pending, which keeps
// the scheduler from reporting "idle" — is injected as the hasPendingRuntimeRefresh
// callback rather than reaching into the controller's refresh-coalescing state.

export type MutationPriority = "high" | "low";

type ScheduledMutation<T = unknown> = {
  operation: () => Promise<T>;
  detail: TraceDetail | undefined;
  priority: MutationPriority;
  queuedAt: number;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export type MutationSchedulerDeps = {
  perfTrace: PerformanceTracer;
  /** Whether a runtime refresh is still pending; the scheduler is not fully idle until it clears. */
  hasPendingRuntimeRefresh: () => boolean;
};

export type MutationScheduler = {
  /**
   * Queue an operation. High priority (the default) drains ahead of low. The returned
   * promise resolves/rejects with the operation's own result.
   */
  enqueueMutation<T>(
    operation: () => Promise<T>,
    detail?: TraceDetail,
    options?: { priority?: MutationPriority }
  ): Promise<T>;
  /** Resolve once the queues are empty, nothing is running or draining, and no runtime refresh is pending. */
  waitForSchedulerIdle(): Promise<void>;
  /** Resolve once no high-priority mutation is running or queued (pending low-priority work may remain). */
  waitForHighPrioritySchedulerIdle(): Promise<void>;
  /** Synchronous read of the same condition as waitForHighPrioritySchedulerIdle: no high-priority mutation running or queued. */
  isHighPrioritySchedulerIdle(): boolean;
};

export function createMutationScheduler(deps: MutationSchedulerDeps): MutationScheduler {
  const { perfTrace, hasPendingRuntimeRefresh } = deps;

  const highPriorityMutations: ScheduledMutation[] = [];
  const lowPriorityMutations: ScheduledMutation[] = [];
  const schedulerIdleResolvers: Array<() => void> = [];
  const highPrioritySchedulerIdleResolvers: Array<() => void> = [];
  let schedulerRunning = false;
  let schedulerDrainQueued = false;
  let runningMutationPriority: MutationPriority | undefined;

  function enqueueMutation<T>(
    operation: () => Promise<T>,
    detail?: TraceDetail,
    options: { priority?: MutationPriority } = {}
  ): Promise<T> {
    const priority = options.priority ?? "high";
    const queuedAt = performance.now();
    const mutationDetail = detail ? { ...detail } : undefined;
    const promise = new Promise<T>((resolve, reject) => {
      const mutation: ScheduledMutation<T> = {
        operation,
        detail: mutationDetail,
        priority,
        queuedAt,
        resolve,
        reject
      };
      if (priority === "high") {
        highPriorityMutations.push(mutation as ScheduledMutation);
      } else {
        lowPriorityMutations.push(mutation as ScheduledMutation);
      }
      scheduleMutationDrain();
    });
    return promise;
  }

  function scheduleMutationDrain(): void {
    if (schedulerRunning || schedulerDrainQueued) {
      return;
    }
    schedulerDrainQueued = true;
    void Promise.resolve().then(runScheduledMutations);
  }

  async function runScheduledMutations(): Promise<void> {
    if (schedulerRunning) {
      schedulerDrainQueued = false;
      return;
    }

    schedulerDrainQueued = false;
    schedulerRunning = true;
    try {
      for (;;) {
        const mutation = highPriorityMutations.shift() ?? lowPriorityMutations.shift();
        if (!mutation) {
          return;
        }
        await runScheduledMutation(mutation);
      }
    } finally {
      schedulerRunning = false;
      if (highPriorityMutations.length > 0 || lowPriorityMutations.length > 0) {
        scheduleMutationDrain();
      } else {
        notifySchedulerIdleIfNeeded();
      }
    }
  }

  async function runScheduledMutation(mutation: ScheduledMutation): Promise<void> {
    const mutationDetail = {
      ...mutation.detail,
      priority: mutation.priority
    };
    perfTrace.mark("background.mutation.start", {
      ...mutationDetail,
      waitMs: Math.round(performance.now() - mutation.queuedAt)
    });
    runningMutationPriority = mutation.priority;
    try {
      const result = await perfTrace.measureAsync("background.mutation.run", mutationDetail, mutation.operation);
      mutation.resolve(result);
    } catch (error) {
      mutation.reject(error);
    } finally {
      runningMutationPriority = undefined;
      notifyHighPrioritySchedulerIdleIfNeeded();
    }
  }

  function waitForSchedulerIdle(): Promise<void> {
    if (isSchedulerIdle()) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      schedulerIdleResolvers.push(resolve);
    });
  }

  function waitForHighPrioritySchedulerIdle(): Promise<void> {
    if (isHighPrioritySchedulerIdle()) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      highPrioritySchedulerIdleResolvers.push(resolve);
    });
  }

  function isSchedulerIdle(): boolean {
    return !schedulerRunning &&
      !schedulerDrainQueued &&
      highPriorityMutations.length === 0 &&
      lowPriorityMutations.length === 0 &&
      !hasPendingRuntimeRefresh();
  }

  function isHighPrioritySchedulerIdle(): boolean {
    return runningMutationPriority !== "high" && highPriorityMutations.length === 0;
  }

  function notifySchedulerIdleIfNeeded(): void {
    if (!isSchedulerIdle() || schedulerIdleResolvers.length === 0) {
      return;
    }

    const resolvers = schedulerIdleResolvers.splice(0);
    for (const resolve of resolvers) {
      resolve();
    }
  }

  function notifyHighPrioritySchedulerIdleIfNeeded(): void {
    if (!isHighPrioritySchedulerIdle() || highPrioritySchedulerIdleResolvers.length === 0) {
      return;
    }

    const resolvers = highPrioritySchedulerIdleResolvers.splice(0);
    for (const resolve of resolvers) {
      resolve();
    }
  }

  return { enqueueMutation, waitForSchedulerIdle, waitForHighPrioritySchedulerIdle, isHighPrioritySchedulerIdle };
}
