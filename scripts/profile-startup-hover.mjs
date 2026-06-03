import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultResultsPath = join(rootDir, "autoresearch/sidebar-startup-hover/results.tsv");
const testFile = "tests/playwright/sidebar-startup-interaction-profile.spec.ts";
const REQUIRED_SPARSE_HOVER_ACTIONS = ["Cut", "Move to top level"];
const DISALLOWED_SPARSE_HOVER_ACTIONS = ["Paste"];

export const STARTUP_HOVER_RESULTS_TSV_HEADER = [
  "timestamp",
  "tag",
  "commit",
  "runs",
  "first_paint_median_ms",
  "first_paint_max_ms",
  "first_paint_action_buttons_max",
  "sparse_hover_action_buttons_min",
  "sparse_idle_action_buttons_min",
  "sparse_hover_frame_max_ms",
  "sparse_hover_feedback_max_ms",
  "sparse_idle_hydration_requests_max",
  "remote_idle_hydration_requests_max",
  "status",
  "description"
].join("\t");

export function parseArgs(argv) {
  const options = {
    runs: 5,
    tag: `${localDateTag(new Date())}-hover`,
    description: "startup hover first-paint margin",
    appendResults: false,
    resultsPath: defaultResultsPath
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--runs" && next) {
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
    } else if (arg === "--append-results") {
      options.appendResults = true;
    }
  }

  if (!Number.isFinite(options.runs) || options.runs < 1) {
    throw new Error("--runs must be a positive integer");
  }

  return options;
}

export async function runStartupHoverLoop(options) {
  const results = [];
  for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
    results.push(await runProfile(runIndex + 1));
  }

  const summary = summarize(results);
  const timestamp = new Date().toISOString();
  const commit = await currentCommit();
  const tsvRow = formatTsvRow(summary, {
    timestamp,
    tag: options.tag,
    commit,
    description: options.description
  });

  if (options.appendResults) {
    await appendResultsTsv(options.resultsPath, tsvRow);
  }

  return {
    runs: options.runs,
    summary,
    guardFailures: summary.guardFailures,
    tsvHeader: STARTUP_HOVER_RESULTS_TSV_HEADER,
    tsvRow,
    ...(options.appendResults ? { resultsPath: options.resultsPath } : {}),
    results
  };
}

async function runProfile(run) {
  const { stdout, stderr } = await execFileAsync("pnpm", [
    "exec",
    "playwright",
    "test",
    testFile,
    "--reporter=list"
  ], {
    cwd: rootDir,
    maxBuffer: 1024 * 1024 * 32
  });

  return {
    run,
    profiles: parseProfileLines(`${stdout}\n${stderr}`)
  };
}

export function parseProfileLines(output) {
  const profiles = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(startup-[a-z0-9-]+) (\{.*\})$/);
    if (!match) {
      continue;
    }
    profiles[match[1]] = JSON.parse(match[2]);
  }
  return profiles;
}

export function summarize(results) {
  const firstPaintProfiles = profileValues(results, "startup-sparse-first-paint");
  const sparseHoverProfiles = profileValues(results, "startup-sparse-hover");
  const sparseIdleProfiles = profileValues(results, "startup-hover-sparse-idle");
  const remoteIdleProfiles = profileValues(results, "startup-remote-interaction-sparse-idle");

  const firstPaintDurations = firstPaintProfiles.map((profile) => profile.initialSnapshotRender?.maxMs)
    .filter(isFiniteNumber);
  const firstPaintActionButtons = firstPaintProfiles.map((profile) => profile.actionButtons).filter(isFiniteNumber);
  const sparseHoverFrameMaxValues = sparseHoverProfiles.map((profile) => profile.hoverFrameDelay?.maxMs)
    .filter(isFiniteNumber);
  const sparseHoverFeedbackMaxValues = sparseHoverProfiles.map((profile) => profile.hoverFeedbackDelay?.maxMs)
    .filter(isFiniteNumber);
  const sparseHoverActionButtons = sparseHoverProfiles.map((profile) => profile.actionButtonsAfterHover)
    .filter(isFiniteNumber);
  const sparseIdleActionButtons = sparseIdleProfiles.map((profile) => profile.actionButtonsAfterIdle)
    .filter(isFiniteNumber);
  const sparseIdleHydrationRequests = sparseIdleProfiles.map((profile) => profile.hydrationRequestsAfterIdle)
    .filter(isFiniteNumber);
  const remoteIdleHydrationRequests = remoteIdleProfiles
    .map((profile) => profile.hydrationRequestsAfterIdle)
    .filter(isFiniteNumber);

  const summary = {
    runs: results.length,
    firstPaintMedianMs: median(firstPaintDurations),
    firstPaintMaxMs: max(firstPaintDurations),
    firstPaintActionButtonsMax: max(firstPaintActionButtons),
    sparseHoverActionButtonsMin: min(sparseHoverActionButtons),
    sparseIdleActionButtonsMin: min(sparseIdleActionButtons),
    sparseHoverFrameMaxMs: max(sparseHoverFrameMaxValues),
    sparseHoverFeedbackMaxMs: max(sparseHoverFeedbackMaxValues),
    sparseIdleHydrationRequestsMax: max(sparseIdleHydrationRequests),
    remoteIdleHydrationRequestsMax: max(remoteIdleHydrationRequests),
    guardFailures: []
  };

  summary.guardFailures = startupHoverGuardFailures(summary, {
    firstPaintProfiles,
    sparseHoverProfiles,
    sparseIdleProfiles,
    remoteIdleProfiles
  });
  summary.status = summary.guardFailures.length === 0 ? "candidate-keep" : "discard";
  return summary;
}

export function startupHoverGuardFailures(summary, profiles) {
  const failures = [];
  if (profiles.firstPaintProfiles.length !== summary.runs) {
    failures.push("missing sparse first-paint profile output");
  }
  if (profiles.sparseHoverProfiles.length !== summary.runs) {
    failures.push("missing sparse hover profile output");
  }
  if (profiles.sparseIdleProfiles.length !== summary.runs) {
    failures.push("missing sparse idle profile output");
  }
  if (profiles.remoteIdleProfiles.length !== summary.runs) {
    failures.push("missing remote sparse idle profile output");
  }
  if (summary.firstPaintMaxMs >= 16) {
    failures.push("sparse initial snapshot render must stay below 16ms");
  }
  if (summary.firstPaintActionButtonsMax !== 0) {
    failures.push("sparse hydrating first paint must not render inert action buttons");
  }
  if (summary.sparseHoverActionButtonsMin <= 0) {
    failures.push("sparse hover must materialize action buttons for the hovered row");
  }
  if (summary.sparseIdleActionButtonsMin <= 0) {
    failures.push("hovered row actions must survive sparse idle");
  }
  if (!profilesHaveActionLabels(profiles.sparseHoverProfiles, "actionButtonLabelsAfterHover", REQUIRED_SPARSE_HOVER_ACTIONS)) {
    failures.push("sparse hover actions must include Cut and Move to top level");
  }
  if (!profilesHaveActionLabels(profiles.sparseIdleProfiles, "actionButtonLabelsAfterIdle", REQUIRED_SPARSE_HOVER_ACTIONS)) {
    failures.push("sparse idle actions must keep Cut and Move to top level");
  }
  if (
    profilesHaveAnyActionLabel(profiles.sparseHoverProfiles, "actionButtonLabelsAfterHover", DISALLOWED_SPARSE_HOVER_ACTIONS) ||
    profilesHaveAnyActionLabel(profiles.sparseIdleProfiles, "actionButtonLabelsAfterIdle", DISALLOWED_SPARSE_HOVER_ACTIONS)
  ) {
    failures.push("sparse partial actions must not include Paste");
  }
  if (summary.sparseHoverFrameMaxMs >= 8) {
    failures.push("sparse hover frame feedback must stay below 8ms");
  }
  if (summary.sparseHoverFeedbackMaxMs >= 4) {
    failures.push("sparse hover DOM feedback must stay below 4ms");
  }
  if (summary.sparseIdleHydrationRequestsMax !== 0) {
    failures.push("sparse startup must not auto-hydrate after startup hover idle");
  }
  if (summary.remoteIdleHydrationRequestsMax !== 0) {
    failures.push("remote sidebar interaction must not trigger sibling full hydration");
  }
  return failures;
}

function profileValues(results, label) {
  return results.flatMap((result) => {
    const profile = result.profiles[label];
    return profile ? [profile] : [];
  });
}

function profilesHaveActionLabels(profiles, key, labels) {
  return profiles.length > 0 && profiles.every((profile) => {
    const values = new Set(Array.isArray(profile[key]) ? profile[key] : []);
    return labels.every((label) => values.has(label));
  });
}

function profilesHaveAnyActionLabel(profiles, key, labels) {
  return profiles.some((profile) => {
    const values = new Set(Array.isArray(profile[key]) ? profile[key] : []);
    return labels.some((label) => values.has(label));
  });
}

function formatTsvRow(summary, fields) {
  return [
    fields.timestamp,
    fields.tag,
    fields.commit,
    summary.runs,
    summary.firstPaintMedianMs,
    summary.firstPaintMaxMs,
    summary.firstPaintActionButtonsMax,
    summary.sparseHoverActionButtonsMin,
    summary.sparseIdleActionButtonsMin,
    summary.sparseHoverFrameMaxMs,
    summary.sparseHoverFeedbackMaxMs,
    summary.sparseIdleHydrationRequestsMax,
    summary.remoteIdleHydrationRequestsMax,
    summary.status,
    fields.description
  ].map(tsvCell).join("\t");
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
    await writeFile(resultsPath, `${STARTUP_HOVER_RESULTS_TSV_HEADER}\n`);
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
  const result = await runStartupHoverLoop(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
