export type DiagnosticsLoader = () => Promise<void> | void;

export type DiagnosticsSchedulerClock = {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(timerId: number): void;
};

export type DiagnosticsScheduler = {
  request(): void;
  cancel(): void;
};

export function createDiagnosticsScheduler(
  load: DiagnosticsLoader,
  options: {
    clock: DiagnosticsSchedulerClock;
    delayMs: number;
  }
): DiagnosticsScheduler {
  let timerId: number | undefined;
  let inFlight = false;
  let rerunAfterInFlight = false;

  async function run(): Promise<void> {
    if (inFlight) {
      rerunAfterInFlight = true;
      return;
    }

    inFlight = true;
    try {
      await load();
    } catch {
      // Diagnostics are advisory; failed refreshes should not surface as unhandled promise rejections.
    } finally {
      inFlight = false;
      if (rerunAfterInFlight) {
        rerunAfterInFlight = false;
        request();
      }
    }
  }

  function request(): void {
    if (inFlight) {
      rerunAfterInFlight = true;
      return;
    }
    if (timerId !== undefined) {
      return;
    }

    timerId = options.clock.setTimeout(() => {
      timerId = undefined;
      void run();
    }, options.delayMs);
  }

  function cancel(): void {
    if (timerId !== undefined) {
      options.clock.clearTimeout(timerId);
      timerId = undefined;
    }
    rerunAfterInFlight = false;
  }

  return {
    request,
    cancel
  };
}
