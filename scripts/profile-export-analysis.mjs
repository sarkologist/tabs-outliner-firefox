import fs from "node:fs";

const DEFAULT_THRESHOLDS = {
  repeatedInitialSnapshotCount: 100,
  slowSaveMs: 150,
  slowEventMs: 100,
  diagnosticsTotalMs: 500,
  diagnosticsDeferredTotalMs: 1000
};

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
  const diagnosticsEntries = measured.filter((entry) => entry.name === "background.diagnostics" || entry.name === "sidebar.diagnostics");
  const diagnosticsDeferredEntries = measured.filter((entry) => entry.name === "sidebar.diagnostics.defer");
  const initialSnapshotMessages = runtimeMessages.filter(
    (entry) => entry.detail?.type === "getInitialTreeSnapshotWindow" ||
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
    entries.push(...snapshot.background.entries.map((entry) => ({ ...entry, profileSource: "background" })));
  }
  if (Array.isArray(snapshot.sidebar?.entries)) {
    entries.push(...snapshot.sidebar.entries.map((entry) => ({ ...entry, profileSource: "sidebar" })));
  }
  if (Array.isArray(snapshot.sidebars)) {
    for (const sidebar of snapshot.sidebars) {
      if (Array.isArray(sidebar?.snapshot?.entries)) {
        entries.push(...sidebar.snapshot.entries.map((entry) => ({
          ...entry,
          profileSource: sidebar.label ?? sidebar.id ?? "sidebar"
        })));
      }
    }
  }
  return entries;
}

export function formatProfileExportAnalysis(analysis) {
  const lines = [
    `Profile export: ${analysis.exportedAt ?? "(unknown date)"} (${analysis.entryCount} entries)`,
    "",
    "Top durations:"
  ];
  for (const row of analysis.topDurations) {
    lines.push(`- ${row.name}: count=${row.count} total=${row.totalMs}ms avg=${row.avgMs}ms max=${row.maxMs}ms`);
  }
  lines.push("", "Runtime message types:");
  for (const row of analysis.runtimeMessageTypes) {
    lines.push(`- ${row.name}: count=${row.count} total=${row.totalMs}ms avg=${row.avgMs}ms max=${row.maxMs}ms`);
  }
  lines.push(
    "",
    `Saves: count=${analysis.saveSummary.count} total=${analysis.saveSummary.totalMs}ms max=${analysis.saveSummary.maxMs}ms`,
    `Diagnostics: count=${analysis.diagnosticsSummary.count} total=${analysis.diagnosticsSummary.totalMs}ms max=${analysis.diagnosticsSummary.maxMs}ms`,
    `Diagnostics defers: count=${analysis.diagnosticsDeferredSummary.count} total=${analysis.diagnosticsDeferredSummary.totalMs}ms max=${analysis.diagnosticsDeferredSummary.maxMs}ms`,
    `Initial snapshot requests: ${analysis.repeatedInitialSnapshotRequests}`
  );
  if (analysis.maxRuntimeEvent) {
    lines.push(`Max runtime event: ${analysis.maxRuntimeEvent.name} ${analysis.maxRuntimeEvent.durationMs}ms`);
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

function totalDuration(entries) {
  return round(entries.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0));
}

function maxDuration(entries) {
  return round(entries.reduce((max, entry) => Math.max(max, entry.durationMs ?? 0), 0));
}

function maxEntry(entries) {
  return entries.reduce((max, entry) => !max || entry.durationMs > max.durationMs ? entry : max, undefined);
}

function round(value) {
  return Math.round(value * 10) / 10;
}
