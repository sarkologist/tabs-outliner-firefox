import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultResultsPath = join(rootDir, "autoresearch/sidebar-drag-drop/results.tsv");
const testFile = "tests/playwright/sidebar-drag-drop-performance.spec.ts";

const PROFILE_LABELS = [
  "drag-drop-50k-drop",
  "drag-drop-50k",
  "hover-guide-50k",
  "hover-scroll-50k",
  "input-delay-profile"
];

export const DRAG_DROP_RESULTS_TSV_HEADER = [
  "timestamp",
  "tag",
  "commit",
  "runs",
  "baseline_ms",
  "drop_median_ms",
  "drop_max_ms",
  "drop_tree_patch_max_ms",
  "drop_virtual_rows_max_ms",
  "drop_projection_build_count",
  "dragover_p95_max_ms",
  "hover_guide_max_ms",
  "hover_scroll_virtual_rows_max_ms",
  "status",
  "description"
].join("\t");

export function parseArgs(argv) {
  const options = {
    runs: 5,
    tag: `${localDateTag(new Date())}-drag-drop`,
    description: "drag/drop 50k sidebar profile",
    appendResults: false,
    resultsPath: defaultResultsPath,
    baselineMs: undefined
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--") {
      continue;
    } else if (arg === "--runs" && next) {
      options.runs = Number.parseInt(next, 10);
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
    } else if (arg === "--append-results") {
      options.appendResults = true;
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }

  if (!Number.isFinite(options.runs) || options.runs < 1) {
    throw new Error("--runs must be a positive integer");
  }
  if (options.baselineMs !== undefined && (!Number.isFinite(options.baselineMs) || options.baselineMs <= 0)) {
    throw new Error("--baseline-ms must be a positive number");
  }

  return options;
}

export async function runDragDropLoop(options) {
  const results = [];
  for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
    results.push(await runProfile(runIndex + 1));
  }

  const summary = summarizeDragDropRuns(results, { baselineMs: options.baselineMs });
  const timestamp = new Date().toISOString();
  const commit = await currentCommit();
  const tsvRow = formatDragDropTsvRow(summary, {
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
    summary,
    guardFailures: summary.guardFailures,
    tsvHeader: DRAG_DROP_RESULTS_TSV_HEADER,
    tsvRow,
    ...(options.appendResults ? { resultsPath: options.resultsPath } : {}),
    results
  };
}

async function runProfile(run) {
  try {
    const { stdout, stderr } = await execFileAsync("pnpm", [
      "exec",
      "playwright",
      "test",
      testFile,
      "--reporter=list"
    ], {
      cwd: rootDir,
      maxBuffer: 1024 * 1024 * 64
    });

    return {
      run,
      profiles: parseProfileLines(`${stdout}\n${stderr}`)
    };
  } catch (error) {
    const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
    return {
      run,
      profiles: parseProfileLines(output),
      commandFailed: true,
      exitCode: typeof error?.code === "number" ? error.code : 1
    };
  }
}

export function parseProfileLines(output) {
  const profiles = {};
  const labels = PROFILE_LABELS.join("|");
  const profileLinePattern = new RegExp(`^(${labels}) (\\{.*\\})$`);
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(profileLinePattern);
    if (!match) {
      continue;
    }
    profiles[match[1]] = JSON.parse(match[2]);
  }
  return profiles;
}

export function summarizeDragDropRuns(results, options = {}) {
  const dropProfiles = profileValues(results, "drag-drop-50k-drop");
  const dragoverProfiles = profileValues(results, "drag-drop-50k");
  const hoverProfiles = profileValues(results, "hover-guide-50k");
  const hoverScrollProfiles = profileValues(results, "hover-scroll-50k");
  const inputDelayProfiles = profileValues(results, "input-delay-profile");
  const playwrightFailureCount = results.filter((result) => result.commandFailed).length;

  const dropDurations = dropProfiles.map((profile) => profile.dropDispatchToVisibleMs).filter(isFiniteNumber);
  const dropTotalDurations = dropProfiles.map((profile) => profile.elapsedMs).filter(isFiniteNumber);
  const dragoverSetupDurations = dropProfiles.map((profile) => profile.dragoverSetupMs).filter(isFiniteNumber);
  const dropTreePatchDurations = dropProfiles
    .map((profile) => summaryMetric(profile, "sidebar.patch.treeStructure", "totalMs"))
    .filter(isFiniteNumber);
  const dropVirtualRowsDurations = dropProfiles
    .map((profile) => summaryMetric(profile, "sidebar.virtualRows", "totalMs"))
    .filter(isFiniteNumber);
  const dropProjectionBuildCounts = dropProfiles
    .map((profile) => summaryMetric(profile, "sidebar.projection.build", "count") ?? 0)
    .filter(isFiniteNumber);
  const dragoverP95Values = dragoverProfiles.map((profile) => profile.p95Ms).filter(isFiniteNumber);
  const hoverGuideValues = hoverProfiles.map((profile) => profile.hoverGuide?.maxMs).filter(isFiniteNumber);
  const hoverScrollVirtualRowsValues = hoverScrollProfiles
    .map((profile) => profile.virtualRows?.maxMs)
    .filter(isFiniteNumber);

  const baselineMs = options.baselineMs;
  const requiredImprovementMs = typeof baselineMs === "number" ? round(Math.min(baselineMs * 0.1, 5)) : undefined;
  const targetDropMedianMs = typeof baselineMs === "number" && typeof requiredImprovementMs === "number"
    ? round(baselineMs - requiredImprovementMs)
    : undefined;

  const summary = {
    runs: results.length,
    ...(typeof baselineMs === "number" ? { baselineMs } : {}),
    ...(typeof requiredImprovementMs === "number" ? { requiredImprovementMs } : {}),
    ...(typeof targetDropMedianMs === "number" ? { targetDropMedianMs } : {}),
    dropMedianMs: median(dropDurations),
    dropMaxMs: max(dropDurations),
    dropTotalMaxMs: max(dropTotalDurations),
    dragoverSetupMaxMs: max(dragoverSetupDurations),
    dropTreePatchMaxMs: max(dropTreePatchDurations),
    dropVirtualRowsMaxMs: max(dropVirtualRowsDurations),
    dropProjectionBuildCount: sum(dropProjectionBuildCounts),
    dragoverP95MaxMs: max(dragoverP95Values),
    hoverGuideMaxMs: max(hoverGuideValues),
    hoverScrollVirtualRowsMaxMs: max(hoverScrollVirtualRowsValues),
    playwrightFailureCount,
    guardFailures: []
  };

  summary.guardFailures = dragDropGuardFailures(summary, {
    dropProfiles,
    dragoverProfiles,
    hoverProfiles,
    hoverScrollProfiles,
    inputDelayProfiles,
    playwrightFailureCount
  });
  summary.status = summary.guardFailures.length === 0 ? "candidate-keep" : "discard";
  return summary;
}

export function dragDropGuardFailures(summary, profiles) {
  const failures = [];
  if (profiles.dropProfiles.length !== summary.runs) {
    failures.push("missing drag-drop-50k-drop output");
  }
  if (profiles.dropProfiles.some((profile) => !isFiniteNumber(profile.dropDispatchToVisibleMs))) {
    failures.push("missing drop dispatch-to-visible timing");
  }
  if (profiles.dragoverProfiles.length !== summary.runs) {
    failures.push("missing drag-drop-50k output");
  }
  if (profiles.hoverProfiles.length !== summary.runs) {
    failures.push("missing hover-guide-50k output");
  }
  if (profiles.hoverScrollProfiles.length !== summary.runs) {
    failures.push("missing hover-scroll-50k output");
  }
  if (profiles.inputDelayProfiles.length !== summary.runs) {
    failures.push("missing input-delay-profile output");
  }
  if (profiles.playwrightFailureCount > 0) {
    failures.push("Playwright drag/drop spec must pass without hard failures");
  }
  if (summary.dropMaxMs >= 90) {
    failures.push("drop visible update must stay below 90ms");
  }
  if (summary.dropTreePatchMaxMs >= 12) {
    failures.push("drop tree-structure patch must stay below 12ms");
  }
  if (summary.dropVirtualRowsMaxMs >= 16) {
    failures.push("drop virtual-row render must stay below 16ms");
  }
  if (summary.dropProjectionBuildCount !== 0) {
    failures.push("drop must not rebuild the full sidebar projection");
  }
  if (summary.dragoverP95MaxMs >= 8) {
    failures.push("dragover preview p95 must stay below 8ms");
  }
  if (summary.hoverGuideMaxMs >= 8) {
    failures.push("large hover guide work must stay below 8ms");
  }
  if (summary.hoverScrollVirtualRowsMaxMs >= 16) {
    failures.push("hover-scroll virtual rows must stay below 16ms");
  }
  if (
    typeof summary.baselineMs === "number" &&
    typeof summary.requiredImprovementMs === "number" &&
    typeof summary.targetDropMedianMs === "number" &&
    summary.dropMedianMs > summary.targetDropMedianMs
  ) {
    failures.push(`drop median must improve by at least ${summary.requiredImprovementMs}ms from baseline`);
  }
  return failures;
}

export function formatDragDropTsvRow(summary, fields) {
  return [
    fields.timestamp,
    fields.tag,
    fields.commit,
    summary.runs,
    fields.baselineMs ?? "",
    summary.dropMedianMs,
    summary.dropMaxMs,
    summary.dropTreePatchMaxMs,
    summary.dropVirtualRowsMaxMs,
    summary.dropProjectionBuildCount,
    summary.dragoverP95MaxMs,
    summary.hoverGuideMaxMs,
    summary.hoverScrollVirtualRowsMaxMs,
    summary.status,
    fields.description
  ].map(tsvCell).join("\t");
}

function profileValues(results, label) {
  return results.flatMap((result) => {
    const profile = result.profiles[label];
    return profile ? [profile] : [];
  });
}

function summaryMetric(profile, name, metric) {
  if (!Array.isArray(profile.summary)) {
    return undefined;
  }
  const row = profile.summary.find((entry) => entry?.name === name);
  const value = row?.[metric];
  return isFiniteNumber(value) ? value : undefined;
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
    await writeFile(resultsPath, `${DRAG_DROP_RESULTS_TSV_HEADER}\n`);
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
  const result = await runDragDropLoop(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
