import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultResultsPath = join(rootDir, "autoresearch/sidebar-startup-scroll-away/results.tsv");
const testFile = "tests/playwright/sidebar-startup-scroll-away-profile.spec.ts";

const STARTUP_SCROLL_AWAY_RESULTS_TSV_HEADER = [
  "timestamp",
  "tag",
  "commit",
  "runs",
  "target_row",
  "expected_viewport_rows_median",
  "visible_rows_median",
  "visible_rows_min",
  "missing_viewport_rows_max",
  "rows_visible_ms_max",
  "hydration_requests_max",
  "scroll_delay_max_ms",
  "status",
  "description"
].join("\t");

function parseArgs(argv) {
  const options = {
    runs: 5,
    tag: `${localDateTag(new Date())}-scroll-away`,
    description: "startup scroll-away sparse coverage",
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

async function runStartupScrollAwayLoop(options) {
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
    tsvHeader: STARTUP_SCROLL_AWAY_RESULTS_TSV_HEADER,
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
    maxBuffer: 1024 * 1024 * 16
  });

  return {
    run,
    profile: parseProfile(`${stdout}\n${stderr}`)
  };
}

function parseProfile(output) {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^startup-scroll-away (\{.*\})$/);
    if (!match) {
      continue;
    }
    return JSON.parse(match[1]);
  }
  throw new Error(`Could not find startup-scroll-away profile output:\n${output}`);
}

function summarize(results) {
  const profiles = results.map((result) => result.profile);
  const targetRows = profiles.map((profile) => profile.targetRowIndex).filter(isFiniteNumber);
  const expectedRows = profiles.map((profile) => profile.expectedViewportRows).filter(isFiniteNumber);
  const visibleRows = profiles.map((profile) => profile.visibleRowsAfterScroll).filter(isFiniteNumber);
  const missingRows = profiles.map((profile) => profile.missingViewportRows).filter(isFiniteNumber);
  const rowsVisibleMs = profiles.map((profile) => profile.rowsVisibleMs).filter(isFiniteNumber);
  const hydrationRequests = profiles.map((profile) => profile.hydrationRequests).filter(isFiniteNumber);
  const scrollDelayValues = profiles.map((profile) => profile.scrollDelay?.maxMs).filter(isFiniteNumber);

  const summary = {
    runs: results.length,
    targetRow: median(targetRows),
    expectedViewportRowsMedian: median(expectedRows),
    visibleRowsMedian: median(visibleRows),
    visibleRowsMin: min(visibleRows),
    missingViewportRowsMax: max(missingRows),
    rowsVisibleMsMax: rowsVisibleMs.length > 0 ? max(rowsVisibleMs) : undefined,
    hydrationRequestsMax: max(hydrationRequests),
    scrollDelayMaxMs: max(scrollDelayValues),
    guardFailures: []
  };

  summary.guardFailures = startupScrollAwayGuardFailures(summary, profiles);
  summary.status = summary.guardFailures.length === 0 ? "keep" : "discard";
  return summary;
}

function startupScrollAwayGuardFailures(summary, profiles) {
  const failures = [];
  if (profiles.length !== summary.runs) {
    failures.push("missing scroll-away profile output");
  }
  if (summary.hydrationRequestsMax !== 0) {
    failures.push("scroll-away rows must appear without full hydration");
  }
  if (summary.visibleRowsMin < Math.floor(summary.expectedViewportRowsMedian * 0.8)) {
    failures.push("scroll-away viewport must render at least 80% of expected rows");
  }
  if (summary.missingViewportRowsMax > 0) {
    failures.push("scroll-away viewport must not have missing visible rows");
  }
  if (typeof summary.rowsVisibleMsMax !== "number" || summary.rowsVisibleMsMax >= 32) {
    failures.push("scroll-away rows must appear within 32ms");
  }
  if (summary.scrollDelayMaxMs >= 8) {
    failures.push("scroll input queue delay must stay below 8ms");
  }
  return failures;
}

function formatTsvRow(summary, fields) {
  return [
    fields.timestamp,
    fields.tag,
    fields.commit,
    summary.runs,
    summary.targetRow,
    summary.expectedViewportRowsMedian,
    summary.visibleRowsMedian,
    summary.visibleRowsMin,
    summary.missingViewportRowsMax,
    summary.rowsVisibleMsMax ?? "",
    summary.hydrationRequestsMax,
    summary.scrollDelayMaxMs,
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
    await writeFile(resultsPath, `${STARTUP_SCROLL_AWAY_RESULTS_TSV_HEADER}\n`);
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

const result = await runStartupScrollAwayLoop(parseArgs(process.argv.slice(2)));
console.log(JSON.stringify(result, null, 2));
