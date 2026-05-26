import type { SidebarStartupShape } from "./sidebar-startup-shapes.js";

export const SIDEBAR_STARTUP_BASE_SCENARIOS = [
  "startup-initial-snapshot",
  "startup-warm-initial-snapshot",
  "startup-stored-unchanged"
] as const;

export const SIDEBAR_STARTUP_REAL_BROWSER_SCENARIOS = [
  "startup-real-browser-fanout"
] as const;

export const SIDEBAR_STARTUP_SCENARIOS = [
  ...SIDEBAR_STARTUP_BASE_SCENARIOS,
  ...SIDEBAR_STARTUP_REAL_BROWSER_SCENARIOS
] as const;

export const SIDEBAR_STARTUP_SNAPSHOT_LIMIT = 256;
export const SIDEBAR_STARTUP_REAL_BROWSER_EVENT_COUNT = 5;

export const SIDEBAR_STARTUP_RESULTS_TSV_HEADER = [
  "timestamp",
  "tag",
  "commit",
  "shape",
  "primary_scenario",
  "tab_nodes",
  "live_tabs",
  "total_nodes",
  "parents_with_children",
  "runs",
  "primary_median_ms",
  "hydration_median_ms",
  "stored_startup_median_ms",
  "warm_snapshot_median_ms",
  "real_mimic_median_ms",
  "real_mimic_initial_snapshot_median_ms",
  "real_mimic_initial_snapshot_max_ms",
  "real_mimic_get_state_median_ms",
  "real_mimic_get_state_max_ms",
  "real_mimic_projection_slice_ms",
  "real_mimic_startup_event_total_ms",
  "real_mimic_startup_event_max_ms",
  "real_mimic_save_flush_ms",
  "snapshot_rows",
  "snapshot_nodes",
  "saves",
  "broadcasts",
  "event_count",
  "status",
  "warnings",
  "phase_median_json",
  "description"
].join("\t");

export type SidebarStartupScenario = typeof SIDEBAR_STARTUP_SCENARIOS[number];

export type SidebarStartupProfileResult = {
  scenario: SidebarStartupScenario;
  tabs: number;
  liveTabs?: number;
  nodes?: number;
  totalNodes?: number;
  parentsWithChildren?: number;
  totalMs?: number;
  hydrateMs?: number;
  totalWithHydrationMs?: number;
  phaseMs?: Record<string, number>;
  snapshotRows?: number;
  snapshotNodes?: number;
  initialSnapshotMedianMs?: number;
  initialSnapshotMaxMs?: number;
  getStateMedianMs?: number;
  getStateMaxMs?: number;
  projectionSliceMs?: number;
  startupEventTotalMs?: number;
  startupEventMaxMs?: number;
  saveFlushMs?: number;
  saves: number;
  broadcasts: number;
  eventCount: number;
};

export type SidebarStartupSummary = {
  shape: SidebarStartupShape;
  primaryScenario: SidebarStartupScenario;
  tabs: number;
  liveTabs: number;
  totalNodes: number;
  parentsWithChildren: number;
  runs: number;
  primaryMedianMs: number;
  hydrationMedianMs: number;
  storedStartupMedianMs: number;
  warmSnapshotMedianMs: number;
  realMimicMedianMs?: number;
  realMimicInitialSnapshotMedianMs?: number;
  realMimicInitialSnapshotMaxMs?: number;
  realMimicGetStateMedianMs?: number;
  realMimicGetStateMaxMs?: number;
  realMimicProjectionSliceMs?: number;
  realMimicStartupEventTotalMs?: number;
  realMimicStartupEventMaxMs?: number;
  realMimicSaveFlushMs?: number;
  snapshotRows: number;
  snapshotNodes: number;
  saves: number;
  broadcasts: number;
  eventCount: number;
  phaseMedianMs: Record<string, number>;
  baselinePrimaryMedianMs?: number;
  requiredImprovementMs?: number;
  improvementMs?: number;
  guardFailures: string[];
  guardWarnings: string[];
  status: "keep" | "discard";
};

export type SidebarStartupSummaryOptions = {
  shape?: SidebarStartupShape;
  baselinePrimaryMedianMs?: number;
};

export type SidebarStartupTsvFields = {
  timestamp: string;
  tag: string;
  commit: string;
  description: string;
};

export function summarizeSidebarStartupProfile(
  results: readonly SidebarStartupProfileResult[],
  options: SidebarStartupSummaryOptions = {}
): SidebarStartupSummary {
  const shape = options.shape ?? "closed-heavy";
  const primaryScenario = primaryScenarioForShape(shape);
  const expectedScenarios = sidebarStartupScenariosForShape(shape);
  const initial = resultsForScenario(results, "startup-initial-snapshot");
  const warm = resultsForScenario(results, "startup-warm-initial-snapshot");
  const stored = resultsForScenario(results, "startup-stored-unchanged");
  const realBrowser = resultsForScenario(results, "startup-real-browser-fanout");
  const primaryMedianMs = shape === "real-browser-20260526"
    ? median(requiredNumbers(realBrowser, "totalMs"))
    : median(requiredNumbers(initial, "totalWithHydrationMs"));
  const hydrationValues = numberValues(initial, "hydrateMs");
  const hydrationMedianMs = shape === "real-browser-20260526"
    ? median(numberValues(realBrowser, "getStateMedianMs"))
    : median(hydrationValues.length > 0 ? hydrationValues : requiredNumbers(initial, "totalWithHydrationMs"));
  const storedStartupMedianMs = shape === "real-browser-20260526" ? 0 : median(requiredNumbers(stored, "totalMs"));
  const warmSnapshotMedianMs = shape === "real-browser-20260526" ? 0 : median(requiredNumbers(warm, "totalMs"));
  const snapshotRows = Math.max(0, ...numberValues(results, "snapshotRows"));
  const snapshotNodes = Math.max(0, ...numberValues(results, "snapshotNodes"));
  const saves = sum(results, "saves");
  const broadcasts = sum(results, "broadcasts");
  const eventCount = sum(results, "eventCount");
  const phaseMedianMs = startupPhaseMedianMs(results);
  const runs = shape === "real-browser-20260526"
    ? realBrowser.length
    : Math.min(initial.length, warm.length, stored.length);
  const guardFailures = startupGuardFailures({
    shape,
    missingScenarios: expectedScenarios.filter((scenario) => resultsForScenario(results, scenario).length === 0),
    runs,
    saves,
    broadcasts,
    eventCount,
    snapshotRows,
    snapshotNodes
  });
  const guardWarnings = startupGuardWarnings({ shape, saves });
  const improvement = improvementDetails(options.baselinePrimaryMedianMs, primaryMedianMs);
  const status = guardFailures.length === 0 && improvement.keep ? "keep" : "discard";
  const totalNodeValues = numberValues(results, "totalNodes");

  return {
    shape,
    primaryScenario,
    tabs: median(requiredNumbers(results, "tabs")),
    liveTabs: median(numberValues(results, "liveTabs")),
    totalNodes: median(totalNodeValues.length > 0 ? totalNodeValues : numberValues(results, "nodes")),
    parentsWithChildren: median(numberValues(results, "parentsWithChildren")),
    runs,
    primaryMedianMs,
    hydrationMedianMs,
    storedStartupMedianMs,
    warmSnapshotMedianMs,
    ...(shape === "real-browser-20260526"
      ? {
          realMimicMedianMs: primaryMedianMs,
          realMimicInitialSnapshotMedianMs: median(numberValues(realBrowser, "initialSnapshotMedianMs")),
          realMimicInitialSnapshotMaxMs: median(numberValues(realBrowser, "initialSnapshotMaxMs")),
          realMimicGetStateMedianMs: median(numberValues(realBrowser, "getStateMedianMs")),
          realMimicGetStateMaxMs: median(numberValues(realBrowser, "getStateMaxMs")),
          realMimicProjectionSliceMs: median(numberValues(realBrowser, "projectionSliceMs")),
          realMimicStartupEventTotalMs: median(numberValues(realBrowser, "startupEventTotalMs")),
          realMimicStartupEventMaxMs: median(numberValues(realBrowser, "startupEventMaxMs")),
          realMimicSaveFlushMs: median(numberValues(realBrowser, "saveFlushMs"))
        }
      : {}),
    snapshotRows,
    snapshotNodes,
    saves,
    broadcasts,
    eventCount,
    phaseMedianMs,
    ...(options.baselinePrimaryMedianMs !== undefined
      ? {
          baselinePrimaryMedianMs: options.baselinePrimaryMedianMs,
          requiredImprovementMs: improvement.requiredImprovementMs,
          improvementMs: improvement.improvementMs
        }
      : {}),
    guardFailures,
    guardWarnings,
    status
  };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return round(sorted[midpoint] ?? 0);
  }
  return round(((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2);
}

export function formatSidebarStartupTsvRow(summary: SidebarStartupSummary, fields: SidebarStartupTsvFields): string {
  return [
    fields.timestamp,
    fields.tag,
    fields.commit,
    summary.shape,
    summary.primaryScenario,
    summary.tabs,
    summary.liveTabs,
    summary.totalNodes,
    summary.parentsWithChildren,
    summary.runs,
    summary.primaryMedianMs,
    summary.hydrationMedianMs,
    summary.storedStartupMedianMs,
    summary.warmSnapshotMedianMs,
    summary.realMimicMedianMs,
    summary.realMimicInitialSnapshotMedianMs,
    summary.realMimicInitialSnapshotMaxMs,
    summary.realMimicGetStateMedianMs,
    summary.realMimicGetStateMaxMs,
    summary.realMimicProjectionSliceMs,
    summary.realMimicStartupEventTotalMs,
    summary.realMimicStartupEventMaxMs,
    summary.realMimicSaveFlushMs,
    summary.snapshotRows,
    summary.snapshotNodes,
    summary.saves,
    summary.broadcasts,
    summary.eventCount,
    summary.status,
    summary.guardWarnings.join("; "),
    JSON.stringify(summary.phaseMedianMs),
    fields.description
  ].map(tsvCell).join("\t");
}

export function sidebarStartupScenariosForShape(shape: SidebarStartupShape): readonly SidebarStartupScenario[] {
  return shape === "real-browser-20260526"
    ? SIDEBAR_STARTUP_REAL_BROWSER_SCENARIOS
    : SIDEBAR_STARTUP_BASE_SCENARIOS;
}

function primaryScenarioForShape(shape: SidebarStartupShape): SidebarStartupScenario {
  return shape === "real-browser-20260526"
    ? "startup-real-browser-fanout"
    : "startup-initial-snapshot";
}

function resultsForScenario(
  results: readonly SidebarStartupProfileResult[],
  scenario: SidebarStartupScenario
): SidebarStartupProfileResult[] {
  return results.filter((result) => result.scenario === scenario);
}

function requiredNumbers<K extends keyof SidebarStartupProfileResult>(
  results: readonly SidebarStartupProfileResult[],
  key: K
): number[] {
  return numberValues(results, key);
}

function numberValues<K extends keyof SidebarStartupProfileResult>(
  results: readonly SidebarStartupProfileResult[],
  key: K
): number[] {
  return results.flatMap((result) => {
    const value = result[key];
    return typeof value === "number" && Number.isFinite(value) ? [value] : [];
  });
}

function sum<K extends keyof SidebarStartupProfileResult>(
  results: readonly SidebarStartupProfileResult[],
  key: K
): number {
  return numberValues(results, key).reduce((total, value) => total + value, 0);
}

function startupPhaseMedianMs(results: readonly SidebarStartupProfileResult[]): Record<string, number> {
  const valuesByPhase = new Map<string, number[]>();
  for (const result of results) {
    for (const [phase, value] of Object.entries(result.phaseMs ?? {})) {
      if (!Number.isFinite(value)) {
        continue;
      }
      const values = valuesByPhase.get(phase) ?? [];
      values.push(value);
      valuesByPhase.set(phase, values);
    }
  }

  return Object.fromEntries(
    [...valuesByPhase.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([phase, values]) => [phase, median(values)])
  );
}

function startupGuardFailures(metrics: {
  shape: SidebarStartupShape;
  missingScenarios: readonly SidebarStartupScenario[];
  runs: number;
  saves: number;
  broadcasts: number;
  eventCount: number;
  snapshotRows: number;
  snapshotNodes: number;
}): string[] {
  const failures: string[] = [];
  if (metrics.missingScenarios.length > 0) {
    failures.push(`missing startup scenarios: ${metrics.missingScenarios.join(", ")}`);
  }
  if (metrics.shape !== "real-browser-20260526" && metrics.saves > 0) {
    failures.push("startup scenarios must not save during measurement");
  }
  if (metrics.broadcasts > 0) {
    failures.push("startup scenarios must not emit broadcasts during measurement");
  }
  if (metrics.shape === "real-browser-20260526") {
    const expectedEventCount = metrics.runs * SIDEBAR_STARTUP_REAL_BROWSER_EVENT_COUNT;
    if (metrics.eventCount !== expectedEventCount) {
      failures.push(`startup real-browser fanout must process exactly ${expectedEventCount} runtime events`);
    }
  } else if (metrics.eventCount > 0) {
    failures.push("startup scenarios must not process runtime events during measurement");
  }
  if (metrics.snapshotRows > SIDEBAR_STARTUP_SNAPSHOT_LIMIT) {
    failures.push(`initial snapshot rows must stay <= ${SIDEBAR_STARTUP_SNAPSHOT_LIMIT}`);
  }
  if (metrics.snapshotNodes > SIDEBAR_STARTUP_SNAPSHOT_LIMIT) {
    failures.push(`initial snapshot nodes must stay <= ${SIDEBAR_STARTUP_SNAPSHOT_LIMIT}`);
  }
  return failures;
}

function startupGuardWarnings(metrics: {
  shape: SidebarStartupShape;
  saves: number;
}): string[] {
  const warnings: string[] = [];
  if (metrics.shape === "real-browser-20260526" && metrics.saves > 0) {
    warnings.push("startup real-browser fanout saved during diagnostic measurement");
  }
  return warnings;
}

function improvementDetails(
  baselinePrimaryMedianMs: number | undefined,
  primaryMedianMs: number
): { keep: boolean; requiredImprovementMs?: number; improvementMs?: number } {
  if (baselinePrimaryMedianMs === undefined) {
    return { keep: true };
  }

  const requiredImprovementMs = round(Math.min(baselinePrimaryMedianMs * 0.1, 50));
  const improvementMs = round(baselinePrimaryMedianMs - primaryMedianMs);
  return {
    keep: improvementMs >= requiredImprovementMs,
    requiredImprovementMs,
    improvementMs
  };
}

function tsvCell(value: string | number | undefined): string {
  return value === undefined ? "" : String(value).replace(/[\t\r\n]+/g, " ").trim();
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
