import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_THRESHOLDS = {
  repeatedInitialSnapshotCount: 100,
  slowSaveMs: 150,
  slowEventMs: 100,
  diagnosticsTotalMs: 500,
  diagnosticsDeferredTotalMs: 1000
};

export const STARTUP_STORAGE_FANOUT_TSV_HEADER = [
  "timestamp",
  "tag",
  "profile_exported_at",
  "primary_ms",
  "background_state_load_max_ms",
  "node_shard_read_max_ms",
  "node_shard_read_keys",
  "order_page_read_max_ms",
  "order_page_read_keys",
  "sidebar_hydration_max_ms",
  "sidebar_hydration_median_ms",
  "sidebar_get_state_max_ms",
  "background_get_state_max_ms",
  "projection_slice_max_ms",
  "save_max_ms",
  "save_count",
  "description"
].join("\t");

const defaultStartupStorageFanoutResultsPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../autoresearch/sidebar-startup-storage-fanout/profile-export-results.tsv"
);

export function loadProfileExport(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function analyzePerformanceProfileExport(profile, options = {}) {
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(options.thresholds ?? {})
  };
  const entries = collectTraceEntries(profile);
  const measured = entries.filter((entry) => typeof entry.durationMs === "number");
  const byName = summarizeBy(measured, (entry) => entry.name);
  const runtimeMessages = entries.filter((entry) => entry.name === "background.runtime.message");
  const runtimeMessageTypes = summarizeBy(
    runtimeMessages.filter((entry) => typeof entry.durationMs === "number"),
    (entry) => entry.detail?.type ?? "(unknown)"
  );
  const eventEntries = measured.filter((entry) => /\.event\./.test(entry.name));
  const saveEntries = measured.filter((entry) => entry.name === "background.state.save");
  const diagnosticsEntries = measured.filter(
    (entry) => entry.name === "background.diagnostics" || entry.name === "sidebar.diagnostics"
  );
  const diagnosticsDeferredEntries = measured.filter(
    (entry) => entry.name === "sidebar.diagnostics.defer"
  );
  const initialSnapshotMessages = runtimeMessages.filter(
    (entry) =>
      entry.detail?.type === "getInitialTreeSnapshotWindow" ||
      entry.detail?.type === "getInitialTreeSnapshot"
  );

  const warnings = [];
  if (initialSnapshotMessages.length > thresholds.repeatedInitialSnapshotCount) {
    warnings.push({
      kind: "repeated-initial-snapshot",
      message: `${initialSnapshotMessages.length} initial snapshot runtime messages`,
      count: initialSnapshotMessages.length
    });
  }
  const maxSave = maxDuration(saveEntries);
  if (maxSave > thresholds.slowSaveMs) {
    warnings.push({
      kind: "slow-save",
      message: `background.state.save max ${maxSave}ms`,
      maxMs: maxSave,
      count: saveEntries.length
    });
  }
  const slowEvents = eventEntries.filter((entry) => entry.durationMs > thresholds.slowEventMs);
  for (const event of slowEvents) {
    warnings.push({
      kind: "slow-runtime-event",
      message: `${event.name} took ${event.durationMs}ms`,
      name: event.name,
      durationMs: event.durationMs,
      detail: event.detail
    });
  }
  const diagnosticsTotal = totalDuration(diagnosticsEntries);
  if (diagnosticsTotal > thresholds.diagnosticsTotalMs) {
    warnings.push({
      kind: "diagnostics-churn",
      message: `diagnostics total ${diagnosticsTotal}ms`,
      totalMs: diagnosticsTotal,
      count: diagnosticsEntries.length
    });
  }
  const deferredDiagnosticsTotal = totalDuration(diagnosticsDeferredEntries);
  if (deferredDiagnosticsTotal > thresholds.diagnosticsDeferredTotalMs) {
    warnings.push({
      kind: "diagnostics-defer-churn",
      message: `diagnostics defers total ${deferredDiagnosticsTotal}ms`,
      totalMs: deferredDiagnosticsTotal,
      count: diagnosticsDeferredEntries.length
    });
  }

  return {
    schema: profile?.schema,
    exportedAt: profile?.exportedAt,
    entryCount: entries.length,
    topDurations: byName.slice(0, options.limit ?? 15),
    runtimeMessageTypes: runtimeMessageTypes.slice(0, options.limit ?? 15),
    maxRuntimeEvent: maxEntry(eventEntries),
    saveSummary: summarizeEntries(saveEntries),
    diagnosticsSummary: summarizeEntries(diagnosticsEntries),
    diagnosticsDeferredSummary: summarizeEntries(diagnosticsDeferredEntries),
    repeatedInitialSnapshotRequests: initialSnapshotMessages.length,
    warnings
  };
}

export function collectTraceEntries(profile) {
  const snapshot = profile?.snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return [];
  }
  const entries = [];
  if (Array.isArray(snapshot.background?.entries)) {
    entries.push(
      ...snapshot.background.entries.map((entry) => ({ ...entry, profileSource: "background" }))
    );
  }
  if (Array.isArray(snapshot.sidebar?.entries)) {
    entries.push(
      ...snapshot.sidebar.entries.map((entry) => ({ ...entry, profileSource: "sidebar" }))
    );
  }
  if (Array.isArray(snapshot.sidebars)) {
    for (const sidebar of snapshot.sidebars) {
      if (Array.isArray(sidebar?.snapshot?.entries)) {
        entries.push(
          ...sidebar.snapshot.entries.map((entry) => ({
            ...entry,
            profileSource: sidebar.label ?? sidebar.id ?? "sidebar"
          }))
        );
      }
    }
  }
  return entries;
}

export function analyzeStartupStorageFanoutProfileExport(profile) {
  const entries = collectTraceEntries(profile);
  const backgroundStateLoad = summarizeMatchingEntries(
    entries,
    (entry) => entry.name === "background.state.load"
  );
  const nodeShardRead = summarizeLoadPhase(entries, "background.state.load.v3.nodeShardRead");
  const orderPageRead = summarizeLoadPhase(entries, "background.state.load.v3.orderPageRead");
  const manifestRead = summarizeLoadPhase(entries, "background.state.load.manifestRead");
  const nodeMaterialize = summarizeLoadPhase(entries, "background.state.load.v3.nodeMaterialize");
  const orderAttach = summarizeLoadPhase(entries, "background.state.load.v3.orderAttach");
  const sidebarHydration = summarizeMatchingEntries(
    entries,
    (entry) => entry.name === "sidebar.hydration"
  );
  const sidebarGetState = summarizeMatchingEntries(
    entries,
    (entry) => entry.name === "sidebar.command" && entry.detail?.command === "getState"
  );
  const backgroundGetState = summarizeMatchingEntries(
    entries,
    (entry) => entry.name === "background.runtime.message" && entry.detail?.type === "getState"
  );
  const projectionSlice = summarizeMatchingEntries(
    entries,
    (entry) =>
      entry.name === "background.runtime.message" && entry.detail?.type === "getTreeProjectionSlice"
  );
  const initialSnapshot = summarizeMatchingEntries(
    entries,
    (entry) =>
      entry.name === "background.runtime.message" &&
      (entry.detail?.type === "getInitialTreeSnapshot" ||
        entry.detail?.type === "getInitialTreeSnapshotWindow")
  );
  const saveSummary = summarizeMatchingEntries(
    entries,
    (entry) => entry.name === "background.state.save"
  );
  const runtimeEvents = summarizeMatchingEntries(entries, (entry) =>
    /^background\.event\./.test(entry.name)
  );
  const diagnostics = summarizeMatchingEntries(
    entries,
    (entry) =>
      entry.name === "background.diagnostics" ||
      entry.name === "sidebar.diagnostics" ||
      entry.name === "sidebar.diagnostics.defer"
  );
  const primaryMs = Math.max(
    backgroundStateLoad.maxMs,
    sidebarHydration.maxMs,
    sidebarGetState.maxMs,
    backgroundGetState.maxMs,
    projectionSlice.maxMs
  );

  return {
    schema: profile?.schema,
    exportedAt: profile?.exportedAt,
    entryCount: entries.length,
    primaryMs,
    backgroundStateLoad,
    manifestRead,
    nodeShardRead,
    nodeMaterialize,
    orderPageRead,
    orderAttach,
    sidebarHydration,
    sidebarGetState,
    backgroundGetState,
    projectionSlice,
    initialSnapshot,
    saveSummary,
    runtimeEvents,
    diagnostics
  };
}

export function formatStartupStorageFanoutAnalysis(analysis) {
  return (
    [
      `Startup storage fanout profile: ${analysis.exportedAt ?? "(unknown date)"}`,
      `Primary startup max: ${analysis.primaryMs}ms`,
      `Background state load: max=${analysis.backgroundStateLoad.maxMs}ms`,
      `Node shard read: max=${analysis.nodeShardRead.maxMs}ms keys=${analysis.nodeShardRead.maxKeys}`,
      `Order page read: max=${analysis.orderPageRead.maxMs}ms keys=${analysis.orderPageRead.maxKeys}`,
      `Sidebar hydration: max=${analysis.sidebarHydration.maxMs}ms median=${analysis.sidebarHydration.medianMs}ms`,
      `Sidebar getState command: max=${analysis.sidebarGetState.maxMs}ms`,
      `Background getState: max=${analysis.backgroundGetState.maxMs}ms`,
      `Projection slice: max=${analysis.projectionSlice.maxMs}ms`,
      `Saves: count=${analysis.saveSummary.count} max=${analysis.saveSummary.maxMs}ms`
    ].join("\n") + "\n"
  );
}

export function startupStorageFanoutTsvRow(analysis, options = {}) {
  return [
    options.timestamp ?? new Date().toISOString(),
    options.tag ?? "",
    analysis.exportedAt ?? "",
    analysis.primaryMs,
    analysis.backgroundStateLoad.maxMs,
    analysis.nodeShardRead.maxMs,
    analysis.nodeShardRead.maxKeys,
    analysis.orderPageRead.maxMs,
    analysis.orderPageRead.maxKeys,
    analysis.sidebarHydration.maxMs,
    analysis.sidebarHydration.medianMs,
    analysis.sidebarGetState.maxMs,
    analysis.backgroundGetState.maxMs,
    analysis.projectionSlice.maxMs,
    analysis.saveSummary.maxMs,
    analysis.saveSummary.count,
    options.description ?? ""
  ]
    .map(tsvCell)
    .join("\t");
}

export function appendStartupStorageFanoutTsv(resultsPath, row) {
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  if (!fs.existsSync(resultsPath) || fs.readFileSync(resultsPath, "utf8").trim() === "") {
    fs.writeFileSync(resultsPath, `${STARTUP_STORAGE_FANOUT_TSV_HEADER}\n`);
  }
  fs.appendFileSync(resultsPath, `${row}\n`);
}

export function formatProfileExportAnalysis(analysis) {
  const lines = [
    `Profile export: ${analysis.exportedAt ?? "(unknown date)"} (${analysis.entryCount} entries)`,
    "",
    "Top durations:"
  ];
  for (const row of analysis.topDurations) {
    lines.push(
      `- ${row.name}: count=${row.count} total=${row.totalMs}ms avg=${row.avgMs}ms max=${row.maxMs}ms`
    );
  }
  lines.push("", "Runtime message types:");
  for (const row of analysis.runtimeMessageTypes) {
    lines.push(
      `- ${row.name}: count=${row.count} total=${row.totalMs}ms avg=${row.avgMs}ms max=${row.maxMs}ms`
    );
  }
  lines.push(
    "",
    `Saves: count=${analysis.saveSummary.count} total=${analysis.saveSummary.totalMs}ms max=${analysis.saveSummary.maxMs}ms`,
    `Diagnostics: count=${analysis.diagnosticsSummary.count} total=${analysis.diagnosticsSummary.totalMs}ms max=${analysis.diagnosticsSummary.maxMs}ms`,
    `Diagnostics defers: count=${analysis.diagnosticsDeferredSummary.count} total=${analysis.diagnosticsDeferredSummary.totalMs}ms max=${analysis.diagnosticsDeferredSummary.maxMs}ms`,
    `Initial snapshot requests: ${analysis.repeatedInitialSnapshotRequests}`
  );
  if (analysis.maxRuntimeEvent) {
    lines.push(
      `Max runtime event: ${analysis.maxRuntimeEvent.name} ${analysis.maxRuntimeEvent.durationMs}ms`
    );
  }
  if (analysis.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of analysis.warnings) {
      lines.push(`- ${warning.kind}: ${warning.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function summarizeBy(entries, keyFn) {
  const byName = new Map();
  for (const entry of entries) {
    const name = keyFn(entry);
    const row = byName.get(name) ?? {
      name,
      count: 0,
      totalMs: 0,
      maxMs: 0
    };
    row.count += 1;
    row.totalMs += entry.durationMs;
    row.maxMs = Math.max(row.maxMs, entry.durationMs);
    byName.set(name, row);
  }
  return [...byName.values()]
    .map((row) => ({
      ...row,
      totalMs: round(row.totalMs),
      avgMs: round(row.totalMs / row.count),
      maxMs: round(row.maxMs)
    }))
    .sort((left, right) => right.totalMs - left.totalMs || right.maxMs - left.maxMs);
}

function summarizeEntries(entries) {
  if (entries.length === 0) {
    return {
      count: 0,
      totalMs: 0,
      avgMs: 0,
      maxMs: 0
    };
  }
  const total = totalDuration(entries);
  return {
    count: entries.length,
    totalMs: total,
    avgMs: round(total / entries.length),
    maxMs: maxDuration(entries)
  };
}

function summarizeMatchingEntries(entries, predicate) {
  return summarizeDurationValues(
    entries
      .filter(predicate)
      .map(entryDurationMs)
      .filter((value) => typeof value === "number" && Number.isFinite(value))
  );
}

function summarizeLoadPhase(entries, name) {
  const phaseEntries = entries.filter((entry) => entry.name === name);
  const summary = summarizeDurationValues(
    phaseEntries
      .map(entryDurationMs)
      .filter((value) => typeof value === "number" && Number.isFinite(value))
  );
  return {
    ...summary,
    maxKeys: Math.max(0, ...phaseEntries.map((entry) => numericDetail(entry, "keys")))
  };
}

function summarizeDurationValues(values) {
  if (values.length === 0) {
    return {
      count: 0,
      totalMs: 0,
      avgMs: 0,
      medianMs: 0,
      maxMs: 0
    };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    totalMs: round(total),
    avgMs: round(total / values.length),
    medianMs: round(median(sorted)),
    maxMs: round(sorted.at(-1) ?? 0)
  };
}

function entryDurationMs(entry) {
  if (typeof entry.durationMs === "number") {
    return entry.durationMs;
  }
  return numericDetail(entry, "durationMs");
}

function numericDetail(entry, key) {
  const value = entry.detail?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function median(sortedValues) {
  const midpoint = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 1
    ? sortedValues[midpoint]
    : ((sortedValues[midpoint - 1] ?? 0) + (sortedValues[midpoint] ?? 0)) / 2;
}

function totalDuration(entries) {
  return round(entries.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0));
}

function maxDuration(entries) {
  return round(entries.reduce((max, entry) => Math.max(max, entry.durationMs ?? 0), 0));
}

function maxEntry(entries) {
  return entries.reduce(
    (max, entry) => (!max || entry.durationMs > max.durationMs ? entry : max),
    undefined
  );
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function tsvCell(value) {
  return String(value).replace(/\t|\r?\n/g, " ");
}

function parseCliArgs(argv) {
  const options = {
    profilePath: undefined,
    tag: "",
    description: "",
    resultsPath: defaultStartupStorageFanoutResultsPath,
    appendResults: false,
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--tag" && next) {
      options.tag = next;
      index += 1;
    } else if (arg === "--description" && next) {
      options.description = next;
      index += 1;
    } else if (arg === "--results" && next) {
      options.resultsPath = next;
      index += 1;
    } else if (arg === "--append-results") {
      options.appendResults = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (!arg.startsWith("--") && !options.profilePath) {
      options.profilePath = arg;
    }
  }

  if (!options.profilePath) {
    throw new Error(
      "Usage: node scripts/profile-export-analysis.mjs <profile-export.json> [--tag <tag>] [--description <text>] [--append-results] [--results <path>] [--json]"
    );
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const profile = loadProfileExport(options.profilePath);
    const analysis = analyzeStartupStorageFanoutProfileExport(profile);
    const row = startupStorageFanoutTsvRow(analysis, {
      tag: options.tag,
      description: options.description
    });
    if (options.appendResults) {
      appendStartupStorageFanoutTsv(options.resultsPath, row);
    }
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            analysis,
            ...(options.appendResults ? { resultsPath: options.resultsPath, tsvRow: row } : {})
          },
          null,
          2
        )
      );
    } else {
      console.log(formatStartupStorageFanoutAnalysis(analysis));
      if (options.appendResults) {
        console.log(`Appended: ${options.resultsPath}`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
