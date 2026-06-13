import type { OutlineDiagnostics } from "../background/diagnostics.js";
import type { PerformanceTracer } from "../perf/trace.js";
import { createDiagnosticsScheduler } from "./diagnostics-scheduler.js";

const DIAGNOSTICS_NOTICE_MS = 4000;
const DIAGNOSTICS_REFRESH_DELAY_MS = 750;
const DIAGNOSTICS_AFTER_NON_EDIT_INPUT_DELAY_MS = 1500;

type DiagnosticsNoticeDeps = {
  diagnostics: HTMLSpanElement | null;
  perfTrace: PerformanceTracer;
  getLastNonEditInteractionAt: () => number;
};

export type DiagnosticsNotice = {
  show(message: string, options?: { error?: boolean }): void;
  scheduleLoad(): void;
};

export function createDiagnosticsNotice(deps: DiagnosticsNoticeDeps): DiagnosticsNotice {
  const { diagnostics, perfTrace, getLastNonEditInteractionAt } = deps;

  let diagnosticsNoticeUntil = 0;
  let diagnosticsNoticeTimer: number | undefined;

  const diagnosticsScheduler = createDiagnosticsScheduler(loadDiagnostics, {
    clock: {
      setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimeout: (timerId) => window.clearTimeout(timerId)
    },
    delayMs: DIAGNOSTICS_REFRESH_DELAY_MS,
    defer: diagnosticsNonEditInteractionDeferralMs
  });

  function show(message: string, options: { error?: boolean } = {}): void {
    if (!diagnostics) {
      return;
    }

    diagnosticsNoticeUntil = Date.now() + DIAGNOSTICS_NOTICE_MS;
    diagnostics.textContent = message;
    diagnostics.title = message;
    diagnostics.classList.toggle("is-error", Boolean(options.error));

    if (diagnosticsNoticeTimer) {
      window.clearTimeout(diagnosticsNoticeTimer);
    }

    diagnosticsNoticeTimer = window.setTimeout(() => {
      diagnosticsNoticeTimer = undefined;
      diagnosticsNoticeUntil = 0;
      diagnostics.classList.remove("is-error");
      scheduleLoad();
    }, DIAGNOSTICS_NOTICE_MS);
  }

  function scheduleLoad(): void {
    diagnosticsScheduler.request();
  }

  function diagnosticsNonEditInteractionDeferralMs(): number | undefined {
    const lastNonEditInteractionAt = getLastNonEditInteractionAt();
    if (!Number.isFinite(lastNonEditInteractionAt)) {
      return undefined;
    }

    const idleMs = performance.now() - lastNonEditInteractionAt;
    if (idleMs >= DIAGNOSTICS_AFTER_NON_EDIT_INPUT_DELAY_MS) {
      return undefined;
    }

    const remainingMs = Math.ceil(DIAGNOSTICS_AFTER_NON_EDIT_INPUT_DELAY_MS - idleMs);
    perfTrace.record("sidebar.diagnostics.defer", remainingMs, { reason: "recent-non-edit-interaction" });
    return remainingMs;
  }

  async function loadDiagnostics(): Promise<void> {
    await perfTrace.measureAsync("sidebar.diagnostics", async () => {
      if (!diagnostics) {
        return;
      }
      if (Date.now() < diagnosticsNoticeUntil) {
        return;
      }

      diagnostics.classList.remove("is-error");

      const result = (await browser.runtime.sendMessage({ type: "getDiagnostics" }).catch(() => undefined)) as
        | OutlineDiagnostics
        | undefined;
      if (!result) {
        diagnostics.textContent = "";
        return;
      }

      diagnostics.textContent = diagnosticsText(result);
      diagnostics.title = result.missingRuntimeTabIds.length
        ? `Missing Firefox tab IDs: ${result.missingRuntimeTabIds.join(", ")}`
        : "";
    });
  }

  function diagnosticsText(result: OutlineDiagnostics): string {
    if (result.missingRuntimeTabIds.length > 0) {
      return `Firefox ${result.runtimeTabCount} / outline ${result.liveTabNodeCount} / missing ${result.missingRuntimeTabIds.length}`;
    }
    if (result.hiddenLiveTabNodeCount > 0) {
      return `Firefox ${result.runtimeTabCount} / visible ${result.visibleLiveTabNodeCount}`;
    }
    return `Firefox ${result.runtimeTabCount}`;
  }

  return { show, scheduleLoad };
}
