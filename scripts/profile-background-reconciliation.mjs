import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultResultsPath = join(rootDir, "autoresearch/background-reconciliation/results.tsv");
const defaultExportProfilePath = join(rootDir, "dist/tabs-outliner-profile-2026-06-02.json");

export const BACKGROUND_RECONCILIATION_SCENARIOS = [
  "move-leaf",
  "group-live-leaf",
  "move-top-level-live-leaf",
  "command-relocation-echo",
  "command-existing-window-relocation-echo",
  "structural-save-pressure"
];

export const BACKGROUND_RECONCILIATION_RESULTS_TSV_HEADER = [
  "timestamp",
  "tag",
  "commit",
  "runs",
  "tabs",
  "baseline_ms",
  "required_improvement_ms",
  "target_primary_ms",
  "primary_scenario",
  "primary_median_ms",
  "primary_max_ms",
  "move_leaf_median_ms",
  "group_live_leaf_median_ms",
  "move_top_level_live_leaf_median_ms",
  "save_flush_max_ms",
  "event_echo_max_ms",
  "runtime_get_windows_count_max",
  "runtime_get_windows_max_ms",
  "status",
  "description"
].join("\t");

export function parseArgs(argv) {
  const options = {
    runs: 5,
    tabs: 50_000,
    scenarios: [...BACKGROUND_RECONCILIATION_SCENARIOS],
    tag: `${localDateTag(new Date())}-background-reconcile`,
    description: "background reconciliation profile",
    appendResults: false,
    resultsPath: defaultResultsPath,
    baselineMs: undefined,
    baselineSummaryPath: undefined,
    exportProfilePath: defaultExportProfilePath
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--") {
      continue;
    } else if (arg === "--runs" && next) {
      options.runs = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--tabs" && next) {
      options.tabs = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--scenarios" && next) {
      options.scenarios = next.split(",").map((scenario) => scenario.trim()).filter(Boolean);
      index += 1;
    } else if (arg === "--tag" && next) {
      options.tag = next;
      index += 1;
    } else if (arg === "--description" && next) {
      options.description = next;
      index += 1;
    } else if (arg === "--results" && next) {
      options.resultsPath = next;
      index += 1;
    } else if (arg === "--baseline-ms" && next) {
      options.baselineMs = Number.parseFloat(next);
      index += 1;
    } else if (arg === "--baseline-summary" && next) {
      options.baselineSummaryPath = next;
      index += 1;
    } else if (arg === "--export-profile" && next) {
      options.exportProfilePath = next;
      index += 1;
    } else if (arg === "--no-export-profile") {
      options.exportProfilePath = undefined;
    } else if (arg === "--append-results") {
      options.appendResults = true;
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }

  if (!Number.isFinite(options.runs) || options.runs < 1) {
    throw new Error("--runs must be a positive integer");
  }
  if (!Number.isFinite(options.tabs) || options.tabs < 2) {
    throw new Error("--tabs must be an integer >= 2");
  }
  if (options.baselineMs !== undefined && (!Number.isFinite(options.baselineMs) || options.baselineMs <= 0)) {
    throw new Error("--baseline-ms must be a positive number");
  }
  for (const scenario of options.scenarios) {
    if (!BACKGROUND_RECONCILIATION_SCENARIOS.includes(scenario)) {
      throw new Error(`Unknown scenario ${scenario}`);
    }
  }

  return options;
}

export async function runBackgroundReconciliationLoop(options) {
  const results = [];
  for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
    for (const scenario of options.scenarios) {
      results.push(await runCommandProfile({
        run: runIndex + 1,
        scenario,
        tabs: options.tabs
      }));
    }
  }

  const baselineSummary = options.baselineSummaryPath
    ? await readBaselineSummary(options.baselineSummaryPath)
    : undefined;
  const summary = summarizeBackgroundReconciliationRuns(results, {
    runs: options.runs,
    tabs: options.tabs,
    scenarios: options.scenarios,
    baselineMs: options.baselineMs,
    baselineSummary
  });
  const exportedProfile = options.exportProfilePath && existsSync(options.exportProfilePath)
    ? analyzeBackgroundProfileExport(JSON.parse(await readFile(options.exportProfilePath, "utf8")))
    : undefined;
  const timestamp = new Date().toISOString();
  const commit = await currentCommit();
  const tsvRow = formatBackgroundReconciliationTsvRow(summary, {
    timestamp,
    tag: options.tag,
    commit,
    baselineMs: options.baselineMs,
    description: options.description
  });

  if (options.appendResults) {
    await appendResultsTsv(options.resultsPath, tsvRow);
  }

  return {
    runs: options.runs,
    tabs: options.tabs,
    scenarios: options.scenarios,
    summary,
    guardFailures: summary.guardFailures,
    tsvHeader: BACKGROUND_RECONCILIATION_RESULTS_TSV_HEADER,
    tsvRow,
    ...(options.appendResults ? { resultsPath: options.resultsPath } : {}),
    ...(exportedProfile ? { exportedProfile } : {}),
    results
  };
}

async function runCommandProfile({ run, scenario, tabs }) {
  try {
    const { stdout, stderr } = await execFileAsync("pnpm", [
      "profile:command",
      "--",
      "--tabs",
      String(tabs),
      "--scenario",
      scenario
    ], {
      cwd: rootDir,
      env: {
        ...process.env,
        PROFILE_BACKGROUND_TRACE: "1"
      },
      maxBuffer: 1024 * 1024 * 64
    });

    return {
      run,
      scenario,
      profile: parseCommandProfileJson(`${stdout}\n${stderr}`)
    };
  } catch (error) {
    const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
    let profile;
    try {
      profile = output.trim() ? parseCommandProfileJson(output) : undefined;
    } catch {
      profile = undefined;
    }
    return {
      run,
      scenario,
      ...(profile ? { profile } : {}),
      commandFailed: true,
      exitCode: typeof error?.code === "number" ? error.code : 1
    };
  }
}

export function parseCommandProfileJson(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("profile:command output did not contain JSON");
  }
  return JSON.parse(output.slice(start, end + 1));
}

export function summarizeBackgroundReconciliationRuns(results, options = {}) {
  const scenarios = options.scenarios ?? inferredScenarios(results);
  const scenarioSummaries = Object.fromEntries(scenarios.map((scenario) => [
    scenario,
    summarizeScenario(results.filter((result) => result.scenario === scenario), {
      runs: options.runs ?? results.filter((result) => result.scenario === scenario).length,
      tabs: options.tabs
    })
  ]));
  const primary = Object.values(scenarioSummaries)
    .sort((left, right) => right.totalWithSaveFlushMedianMs - left.totalWithSaveFlushMedianMs)[0] ??
    summarizeScenario([], { runs: 0, tabs: options.tabs });
  const baselineMs = options.baselineMs;
  const requiredImprovementMs = typeof baselineMs === "number" ? round(Math.min(baselineMs * 0.1, 50)) : undefined;
  const targetPrimaryMs = typeof baselineMs === "number" && typeof requiredImprovementMs === "number"
    ? round(baselineMs - requiredImprovementMs)
    : undefined;
  const summary = {
    runs: options.runs ?? 0,
    tabs: options.tabs ?? 0,
    scenarios: scenarioSummaries,
    primaryScenario: primary.scenario,
    primaryMedianMs: primary.totalWithSaveFlushMedianMs,
    primaryMaxMs: primary.totalWithSaveFlushMaxMs,
    saveFlushMaxMs: max(Object.values(scenarioSummaries).map((scenario) => scenario.saveFlushMaxMs)),
    eventEchoMaxMs: max(Object.values(scenarioSummaries).map((scenario) => scenario.eventEchoMaxMs)),
    runtimeGetWindowsCountMax: max(Object.values(scenarioSummaries).map((scenario) => scenario.runtimeGetWindowsCountMax)),
    runtimeGetWindowsMaxMs: max(Object.values(scenarioSummaries).map((scenario) => scenario.runtimeGetWindowsMaxMs)),
    storageSetCallsMax: max(Object.values(scenarioSummaries).map((scenario) => scenario.storageSetCallsMax)),
    stateSavesMax: max(Object.values(scenarioSummaries).map((scenario) => scenario.stateSavesMax)),
    ...(typeof baselineMs === "number" ? { baselineMs } : {}),
    ...(typeof requiredImprovementMs === "number" ? { requiredImprovementMs } : {}),
    ...(typeof targetPrimaryMs === "number" ? { targetPrimaryMs } : {}),
    guardFailures: []
  };
  summary.guardFailures = backgroundReconciliationGuardFailures(summary, {
    results,
    scenarios,
    baselineSummary: options.baselineSummary
  });
  summary.status = summary.guardFailures.length === 0 ? "candidate-keep" : "discard";
  return summary;
}

function inferredScenarios(results) {
  const names = [];
  for (const result of results) {
    if (typeof result.scenario === "string" && !names.includes(result.scenario)) {
      names.push(result.scenario);
    }
  }
  return names.length > 0 ? names : BACKGROUND_RECONCILIATION_SCENARIOS;
}

function summarizeScenario(results, options = {}) {
  const profiles = results.flatMap((result) => result.profile ? [result.profile] : []);
  const scenario = results[0]?.scenario ?? "";
  return {
    scenario,
    runs: results.length,
    profileCount: profiles.length,
    commandFailureCount: results.filter((result) => result.commandFailed).length,
    totalWithSaveFlushMedianMs: median(profiles.map((profile) => profile.totalWithSaveFlushMs).filter(isFiniteNumber)),
    totalWithSaveFlushMaxMs: max(profiles.map((profile) => profile.totalWithSaveFlushMs).filter(isFiniteNumber)),
    commandMedianMs: median(profiles.map((profile) => profile.commandMs).filter(isFiniteNumber)),
    commandMaxMs: max(profiles.map((profile) => profile.commandMs).filter(isFiniteNumber)),
    followUpCommandMedianMs: median(profiles.map((profile) => profile.followUpCommandMs).filter(isFiniteNumber)),
    followUpCommandMaxMs: max(profiles.map((profile) => profile.followUpCommandMs).filter(isFiniteNumber)),
    stateSaveStartedBeforeAckCount: profiles.filter((profile) => profile.stateSaveStartedBeforeAck === true).length,
    delayedStateSaveCountMax: max(profiles.map((profile) => profile.delayedStateSaveCount).filter(isFiniteNumber)),
    eventEchoMedianMs: median(profiles.map((profile) => profile.eventEchoMs).filter(isFiniteNumber)),
    eventEchoMaxMs: max(profiles.map((profile) => profile.eventEchoMs).filter(isFiniteNumber)),
    saveFlushMedianMs: median(profiles.map((profile) => profile.saveFlushMs).filter(isFiniteNumber)),
    saveFlushMaxMs: max(profiles.map((profile) => profile.saveFlushMs).filter(isFiniteNumber)),
    firstBroadcastMedianMs: median(profiles.map((profile) => profile.firstBroadcastMs).filter(isFiniteNumber)),
    storageSetCallsMax: max(profiles.map((profile) => profile.storageSetCalls).filter(isFiniteNumber)),
    stateSavesMax: max(profiles.map((profile) => profile.stateSaves).filter(isFiniteNumber)),
    fullStateBroadcastsMax: max(profiles.map((profile) => profile.fullStateBroadcasts ?? 0).filter(isFiniteNumber)),
    sameParentReorderBroadcastsMin: min(profiles.map((profile) => profile.sameParentReorderBroadcasts ?? 0).filter(isFiniteNumber)),
    treeStructureBroadcastsMax: max(profiles.map((profile) => profile.treeStructureBroadcasts ?? 0).filter(isFiniteNumber)),
    projectionMaxMs: max(profiles.map((profile) => profile.projectionMs).filter(isFiniteNumber)),
    treePatchMaxMs: max(profiles.map((profile) => profile.treePatchMs).filter(isFiniteNumber)),
    runtimeGetWindowsCountMax: max(profiles.map((profile) => traceMetric(profile, "background.runtime.getWindows", "count")).filter(isFiniteNumber)),
    runtimeGetWindowsMaxMs: max(profiles.map((profile) => traceMetric(profile, "background.runtime.getWindows", "maxMs")).filter(isFiniteNumber)),
    backgroundStateSaveMaxMs: max(profiles.map((profile) => traceMetric(profile, "background.state.save", "maxMs")).filter(isFiniteNumber)),
    runtimeEventMaxMs: max(profiles.map(runtimeEventMaxMs).filter(isFiniteNumber)),
    expectedNodeCount: expectedNodeCount(scenario, options.tabs),
    badAckCount: profiles.filter((profile) => profile.ack?.stateChanged !== true).length,
    badNodeCount: profiles.filter((profile) => profile.nodes !== expectedNodeCount(scenario, options.tabs)).length,
    badRootShapeCount: profiles.filter((profile) => !rootShapeMatches(profile.rootShape, scenario)).length
  };
}

export function backgroundReconciliationGuardFailures(summary, context = {}) {
  const failures = [];
  for (const scenario of context.scenarios ?? []) {
    const scenarioSummary = summary.scenarios[scenario];
    if (!scenarioSummary || scenarioSummary.profileCount !== summary.runs) {
      failures.push(`${scenario} must produce ${summary.runs} profile outputs`);
      continue;
    }
    if (scenarioSummary.commandFailureCount > 0) {
      failures.push(`${scenario} profile command must not fail`);
    }
    if (scenarioSummary.badAckCount > 0) {
      failures.push(`${scenario} must acknowledge a state-changing command`);
    }
    if (scenarioSummary.badNodeCount > 0) {
      failures.push(`${scenario} must preserve the expected node count`);
    }
    if (scenarioSummary.badRootShapeCount > 0) {
      failures.push(`${scenario} must preserve the expected root shape`);
    }
    if (scenarioSummary.fullStateBroadcastsMax > 0) {
      failures.push(`${scenario} must not broadcast full stateUpdated messages`);
    }
    if (scenario === "move-leaf" && scenarioSummary.sameParentReorderBroadcastsMin < 1) {
      failures.push("move-leaf must preserve sameParentReorderUpdated broadcasts");
    }
    if (scenario === "move-leaf" && scenarioSummary.projectionMaxMs !== 0) {
      failures.push("move-leaf must not rebuild the synthetic sidebar projection");
    }
    if (scenario === "move-leaf" && scenarioSummary.treePatchMaxMs !== 0) {
      failures.push("move-leaf must not spend synthetic tree patch time");
    }
    if (isCommandRelocationEchoScenario(scenario) && scenarioSummary.runtimeGetWindowsCountMax > 0) {
      failures.push(`${scenario} must absorb native echoes without runtime.getWindows`);
    }
    if (isCommandRelocationEchoScenario(scenario) && scenarioSummary.stateSavesMax > 1) {
      failures.push(`${scenario} must not add a second state save for native echoes`);
    }
    if (isCommandRelocationEchoScenario(scenario) && scenarioSummary.storageSetCallsMax > 2) {
      failures.push(`${scenario} must not add storage writes for native echoes`);
    }
    if (isCommandRelocationEchoScenario(scenario) && scenarioSummary.eventEchoMaxMs > 25) {
      failures.push(`${scenario} native echo flush must stay below 25ms`);
    }
    if (scenario === "structural-save-pressure" && scenarioSummary.stateSaveStartedBeforeAckCount > 0) {
      failures.push("structural-save-pressure must not start V3 state saves before command ack");
    }
    if (scenario === "structural-save-pressure" && scenarioSummary.followUpCommandMaxMs > 25) {
      failures.push("structural-save-pressure follow-up command must not wait for deferred state save");
    }
    if (scenario === "structural-save-pressure" && scenarioSummary.runtimeGetWindowsCountMax > 0) {
      failures.push("structural-save-pressure must not add runtime.getWindows");
    }
    if (scenario === "structural-save-pressure" && scenarioSummary.stateSavesMax > 1) {
      failures.push("structural-save-pressure must coalesce to one eventual state save");
    }
    if (scenario === "structural-save-pressure" && scenarioSummary.fullStateBroadcastsMax > 0) {
      failures.push("structural-save-pressure must not broadcast full stateUpdated messages");
    }
  }
  if (
    typeof summary.baselineMs === "number" &&
    typeof summary.requiredImprovementMs === "number" &&
    typeof summary.targetPrimaryMs === "number" &&
    summary.primaryMedianMs > summary.targetPrimaryMs
  ) {
    failures.push(`primary median must improve by at least ${summary.requiredImprovementMs}ms from baseline`);
  }
  if (context.baselineSummary) {
    for (const [scenario, baseline] of Object.entries(context.baselineSummary.scenarios ?? {})) {
      const current = summary.scenarios[scenario];
      if (!current) {
        continue;
      }
      if (current.saveFlushMaxMs > baseline.saveFlushMaxMs) {
        failures.push(`${scenario} saveFlushMs must not increase versus baseline`);
      }
      if (current.storageSetCallsMax > baseline.storageSetCallsMax) {
        failures.push(`${scenario} storageSetCalls must not increase versus baseline`);
      }
      if (current.stateSavesMax > baseline.stateSavesMax) {
        failures.push(`${scenario} stateSaves must not increase versus baseline`);
      }
      if (current.eventEchoMaxMs > baseline.eventEchoMaxMs + 25) {
        failures.push(`${scenario} eventEchoMs must stay within 25ms of baseline`);
      }
      if (current.runtimeGetWindowsCountMax > baseline.runtimeGetWindowsCountMax) {
        failures.push(`${scenario} runtime.getWindows count must not increase versus baseline`);
      }
      if (current.runtimeGetWindowsMaxMs > baseline.runtimeGetWindowsMaxMs) {
        failures.push(`${scenario} runtime.getWindows max must not increase versus baseline`);
      }
    }
  }
  return failures;
}

export function analyzeBackgroundProfileExport(profile) {
  const entries = collectTraceEntries(profile);
  return {
    exportedAt: profile?.exportedAt,
    entryCount: entries.length,
    backgroundStateSave: summarizeMatchingEntries(entries, (entry) => entry.name === "background.state.save"),
    refreshFromRuntime: summarizeMatchingEntries(entries, (entry) =>
      entry.name === "background.mutation.run" && entry.detail?.reason === "refreshFromRuntime"
    ),
    runtimeGetWindows: summarizeMatchingEntries(entries, (entry) => entry.name === "background.runtime.getWindows"),
    runtimeEvents: summarizeMatchingEntries(entries, (entry) => /^background\.event\./.test(entry.name)),
    sidebarTreeStructure: summarizeMatchingEntries(entries, (entry) => entry.name === "sidebar.patch.treeStructure"),
    sidebarRender: summarizeMatchingEntries(entries, (entry) => entry.name === "sidebar.render"),
    sidebarProjectionBuild: summarizeMatchingEntries(entries, (entry) => entry.name === "sidebar.projection.build"),
    diagnostics: summarizeMatchingEntries(entries, (entry) =>
      entry.name === "background.diagnostics" || entry.name === "sidebar.diagnostics"
    ),
    diagnosticsDefer: summarizeMatchingEntries(entries, (entry) => entry.name === "sidebar.diagnostics.defer"),
    topTotals: summarizeBy(entries.filter((entry) => typeof entry.durationMs === "number"), (entry) => entry.name).slice(0, 15)
  };
}

export function formatBackgroundReconciliationTsvRow(summary, fields) {
  return [
    fields.timestamp,
    fields.tag,
    fields.commit,
    summary.runs,
    summary.tabs,
    fields.baselineMs ?? "",
    summary.requiredImprovementMs ?? "",
    summary.targetPrimaryMs ?? "",
    summary.primaryScenario,
    summary.primaryMedianMs,
    summary.primaryMaxMs,
    summary.scenarios["move-leaf"]?.totalWithSaveFlushMedianMs ?? "",
    summary.scenarios["group-live-leaf"]?.totalWithSaveFlushMedianMs ?? "",
    summary.scenarios["move-top-level-live-leaf"]?.totalWithSaveFlushMedianMs ?? "",
    summary.saveFlushMaxMs,
    summary.eventEchoMaxMs,
    summary.runtimeGetWindowsCountMax,
    summary.runtimeGetWindowsMaxMs,
    summary.status,
    fields.description
  ].map(tsvCell).join("\t");
}

function collectTraceEntries(profile) {
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

function summarizeMatchingEntries(entries, predicate) {
  return summarizeEntries(entries.filter((entry) => predicate(entry) && typeof entry.durationMs === "number"));
}

function summarizeEntries(entries) {
  const durations = entries.map((entry) => entry.durationMs).filter(isFiniteNumber);
  return {
    count: durations.length,
    totalMs: sum(durations),
    medianMs: median(durations),
    maxMs: max(durations)
  };
}

function summarizeBy(entries, keyFn) {
  const byKey = new Map();
  for (const entry of entries) {
    const name = keyFn(entry);
    const row = byKey.get(name) ?? {
      name,
      count: 0,
      totalMs: 0,
      maxMs: 0
    };
    row.count += 1;
    row.totalMs += entry.durationMs;
    row.maxMs = Math.max(row.maxMs, entry.durationMs);
    byKey.set(name, row);
  }
  return [...byKey.values()]
    .map((row) => ({
      ...row,
      totalMs: round(row.totalMs),
      avgMs: round(row.totalMs / row.count),
      maxMs: round(row.maxMs)
    }))
    .sort((left, right) => right.totalMs - left.totalMs);
}

function traceMetric(profile, name, metric) {
  const value = profile.traceSummary?.byName?.[name]?.[metric];
  return isFiniteNumber(value) ? value : 0;
}

function runtimeEventMaxMs(profile) {
  const rows = Object.values(profile.traceSummary?.byName ?? {})
    .filter((row) => row.name?.startsWith("background.event."));
  return max(rows.map((row) => row.maxMs).filter(isFiniteNumber));
}

function isCommandRelocationEchoScenario(scenario) {
  return scenario === "command-relocation-echo" ||
    scenario === "command-existing-window-relocation-echo";
}

function expectedNodeCount(scenario, tabs) {
  if (!Number.isFinite(tabs)) {
    return undefined;
  }
  if (scenario === "move-leaf") {
    return tabs + 1;
  }
  if (
    scenario === "group-live-leaf" ||
    scenario === "move-top-level-live-leaf" ||
    scenario === "command-relocation-echo" ||
    scenario === "command-existing-window-relocation-echo" ||
    scenario === "structural-save-pressure"
  ) {
    return tabs + 2;
  }
  return undefined;
}

function rootShapeMatches(rootShape, scenario) {
  const expected = expectedRootShape(scenario);
  if (!expected) {
    return true;
  }
  return rootShape?.rootCount === expected.rootCount &&
    rootShape?.missingRootCount === 0 &&
    rootShape?.liveWindowRootCount === expected.liveWindowRootCount &&
    rootShape?.tabRootCount === 0 &&
    rootShape?.groupRootCount === 0;
}

function expectedRootShape(scenario) {
  if (scenario === "move-leaf" || scenario === "group-live-leaf") {
    return { rootCount: 1, liveWindowRootCount: 1 };
  }
  if (
    scenario === "move-top-level-live-leaf" ||
    scenario === "command-relocation-echo" ||
    scenario === "command-existing-window-relocation-echo" ||
    scenario === "structural-save-pressure"
  ) {
    return { rootCount: 2, liveWindowRootCount: 2 };
  }
  return undefined;
}

async function readBaselineSummary(path) {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  return parsed.summary ?? parsed;
}

async function currentCommit() {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: rootDir });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

async function appendResultsTsv(resultsPath, row) {
  await mkdir(dirname(resultsPath), { recursive: true });
  if (!existsSync(resultsPath) || (await readFile(resultsPath, "utf8").catch(() => "")).trim() === "") {
    await writeFile(resultsPath, `${BACKGROUND_RECONCILIATION_RESULTS_TSV_HEADER}\n`);
  }
  await appendFile(resultsPath, `${row}\n`);
}

function localDateTag(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function median(values) {
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

function min(values) {
  return values.length > 0 ? round(Math.min(...values)) : 0;
}

function max(values) {
  return values.length > 0 ? round(Math.max(...values)) : 0;
}

function sum(values) {
  return round(values.reduce((total, value) => total + value, 0));
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function tsvCell(value) {
  return String(value).replace(/[\t\r\n]+/g, " ").trim();
}

async function main() {
  const result = await runBackgroundReconciliationLoop(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
