export const SIDEBAR_STARTUP_SCENARIOS = [
  "startup-initial-snapshot",
  "startup-warm-initial-snapshot",
  "startup-stored-unchanged"
] as const;

export const SIDEBAR_STARTUP_SNAPSHOT_LIMIT = 256;

export const SIDEBAR_STARTUP_RESULTS_TSV_HEADER = [
  "timestamp",
  "tag",
  "commit",
  "tabs",
  "runs",
  "primary_median_ms",
  "hydration_median_ms",
  "stored_startup_median_ms",
  "warm_snapshot_median_ms",
  "snapshot_rows",
  "snapshot_nodes",
  "saves",
  "broadcasts",
  "event_count",
  "status",
  "description"
].join("\t");

export type SidebarStartupScenario = typeof SIDEBAR_STARTUP_SCENARIOS[number];

export type SidebarStartupProfileResult = {
  scenario: SidebarStartupScenario;
  tabs: number;
  totalMs?: number;
  hydrateMs?: number;
  totalWithHydrationMs?: number;
  snapshotRows?: number;
  snapshotNodes?: number;
  saves: number;
  broadcasts: number;
  eventCount: number;
};

export type SidebarStartupSummary = {
  tabs: number;
  runs: number;
  primaryMedianMs: number;
  hydrationMedianMs: number;
  storedStartupMedianMs: number;
  warmSnapshotMedianMs: number;
  snapshotRows: number;
  snapshotNodes: number;
  saves: number;
  broadcasts: number;
  eventCount: number;
  baselinePrimaryMedianMs?: number;
  requiredImprovementMs?: number;
  improvementMs?: number;
  guardFailures: string[];
  status: "keep" | "discard";
};

export type SidebarStartupSummaryOptions = {
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
  const initial = resultsForScenario(results, "startup-initial-snapshot");
  const warm = resultsForScenario(results, "startup-warm-initial-snapshot");
  const stored = resultsForScenario(results, "startup-stored-unchanged");
  const primaryMedianMs = median(requiredNumbers(initial, "totalWithHydrationMs"));
  const hydrationValues = numberValues(initial, "hydrateMs");
  const hydrationMedianMs = median(hydrationValues.length > 0 ? hydrationValues : requiredNumbers(initial, "totalWithHydrationMs"));
  const storedStartupMedianMs = median(requiredNumbers(stored, "totalMs"));
  const warmSnapshotMedianMs = median(requiredNumbers(warm, "totalMs"));
  const snapshotRows = Math.max(0, ...numberValues([...initial, ...warm], "snapshotRows"));
  const snapshotNodes = Math.max(0, ...numberValues([...initial, ...warm], "snapshotNodes"));
  const saves = sum(results, "saves");
  const broadcasts = sum(results, "broadcasts");
  const eventCount = sum(results, "eventCount");
  const guardFailures = startupGuardFailures({
    missingScenarios: SIDEBAR_STARTUP_SCENARIOS.filter((scenario) => resultsForScenario(results, scenario).length === 0),
    saves,
    broadcasts,
    eventCount,
    snapshotRows,
    snapshotNodes
  });
  const improvement = improvementDetails(options.baselinePrimaryMedianMs, primaryMedianMs);
  const status = guardFailures.length === 0 && improvement.keep ? "keep" : "discard";

  return {
    tabs: median(requiredNumbers(results, "tabs")),
    runs: Math.min(initial.length, warm.length, stored.length),
    primaryMedianMs,
    hydrationMedianMs,
    storedStartupMedianMs,
    warmSnapshotMedianMs,
    snapshotRows,
    snapshotNodes,
    saves,
    broadcasts,
    eventCount,
    ...(options.baselinePrimaryMedianMs !== undefined
      ? {
          baselinePrimaryMedianMs: options.baselinePrimaryMedianMs,
          requiredImprovementMs: improvement.requiredImprovementMs,
          improvementMs: improvement.improvementMs
        }
      : {}),
    guardFailures,
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
    summary.tabs,
    summary.runs,
    summary.primaryMedianMs,
    summary.hydrationMedianMs,
    summary.storedStartupMedianMs,
    summary.warmSnapshotMedianMs,
    summary.snapshotRows,
    summary.snapshotNodes,
    summary.saves,
    summary.broadcasts,
    summary.eventCount,
    summary.status,
    fields.description
  ].map(tsvCell).join("\t");
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

function startupGuardFailures(metrics: {
  missingScenarios: readonly SidebarStartupScenario[];
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
  if (metrics.saves > 0) {
    failures.push("startup scenarios must not save during measurement");
  }
  if (metrics.broadcasts > 0) {
    failures.push("startup scenarios must not emit broadcasts during measurement");
  }
  if (metrics.eventCount > 0) {
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

function tsvCell(value: string | number): string {
  return String(value).replace(/[\t\r\n]+/g, " ").trim();
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
