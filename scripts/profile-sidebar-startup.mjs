import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  SIDEBAR_STARTUP_RESULTS_TSV_HEADER,
  formatSidebarStartupTsvRow,
  sidebarStartupScenariosForShape,
  summarizeSidebarStartupProfile
} from "../dist/perf/sidebar-startup-profile.js";
import {
  defaultTabsForSidebarStartupShape,
  isSidebarStartupShape,
  validateSidebarStartupShapeOptions
} from "../dist/perf/sidebar-startup-shapes.js";

const execFileAsync = promisify(execFile);
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const profileTabOpenScript = join(rootDir, "scripts/profile-tab-open.mjs");
const defaultResultsPath = join(rootDir, "autoresearch/sidebar-startup/results.tsv");

function parseArgs(argv) {
  const options = {
    shape: "closed-heavy",
    tabs: undefined,
    liveTabs: undefined,
    runs: 3,
    tag: localDateTag(new Date()),
    description: "sidebar startup hydration",
    baselinePrimaryMedianMs: undefined,
    commit: undefined,
    appendResults: false,
    resultsPath: defaultResultsPath
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--tabs" && next) {
      options.tabs = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--live-tabs" && next) {
      options.liveTabs = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--runs" && next) {
      options.runs = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--tag" && next) {
      options.tag = next;
      index += 1;
    } else if (arg === "--description" && next) {
      options.description = next;
      index += 1;
    } else if (arg === "--shape" && next) {
      options.shape = next;
      index += 1;
    } else if (arg === "--baseline-ms" && next) {
      options.baselinePrimaryMedianMs = Number.parseFloat(next);
      index += 1;
    } else if (arg === "--commit" && next) {
      options.commit = next;
      index += 1;
    } else if (arg === "--results" && next) {
      options.resultsPath = next;
      index += 1;
    } else if (arg === "--append-results") {
      options.appendResults = true;
    }
  }

  if (!isSidebarStartupShape(options.shape)) {
    throw new Error("--shape must be closed-heavy, order-page-heavy, or real-browser-20260526");
  }
  options.tabs = options.tabs ?? defaultTabsForSidebarStartupShape(options.shape);
  options.liveTabs = options.liveTabs ?? Math.min(50, options.tabs);
  validateSidebarStartupShapeOptions(options);
  if (!Number.isFinite(options.runs) || options.runs < 1) {
    throw new Error("--runs must be a positive integer");
  }
  if (
    options.baselinePrimaryMedianMs !== undefined &&
    (!Number.isFinite(options.baselinePrimaryMedianMs) || options.baselinePrimaryMedianMs <= 0)
  ) {
    throw new Error("--baseline-ms must be a positive number");
  }

  return options;
}

async function runStartupMatrix(options) {
  const results = [];
  const scenarios = sidebarStartupScenariosForShape(options.shape);
  for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
    for (const scenario of scenarios) {
      results.push(
        await runScenario({
          shape: options.shape,
          tabs: options.tabs,
          liveTabs: options.liveTabs,
          scenario,
          runIndex: runIndex + 1
        })
      );
    }
  }

  const summary = summarizeSidebarStartupProfile(results, {
    shape: options.shape,
    ...(options.baselinePrimaryMedianMs !== undefined
      ? { baselinePrimaryMedianMs: options.baselinePrimaryMedianMs }
      : {})
  });
  const timestamp = new Date().toISOString();
  const commit = options.commit ?? (await currentCommit());
  const tsvRow = formatSidebarStartupTsvRow(summary, {
    timestamp,
    tag: options.tag,
    commit,
    description: options.description
  });

  if (options.appendResults) {
    await appendResultsTsv(options.resultsPath, tsvRow);
  }

  return {
    shape: options.shape,
    tabs: options.tabs,
    liveTabs: options.liveTabs,
    runs: options.runs,
    summary,
    guardFailures: summary.guardFailures,
    guardWarnings: summary.guardWarnings,
    tsvHeader: SIDEBAR_STARTUP_RESULTS_TSV_HEADER,
    tsvRow,
    ...(options.appendResults ? { resultsPath: options.resultsPath } : {}),
    results
  };
}

async function runScenario({ shape, tabs, liveTabs, scenario, runIndex }) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      profileTabOpenScript,
      "--shape",
      shape,
      "--tabs",
      String(tabs),
      "--live-tabs",
      String(liveTabs),
      "--scenario",
      scenario
    ],
    {
      cwd: rootDir,
      maxBuffer: 1024 * 1024 * 16
    }
  );

  return {
    run: runIndex,
    ...parseProfileJson(stdout, scenario)
  };
}

function parseProfileJson(stdout, scenario) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `Could not parse ${scenario} profile output as JSON: ${error.message}\n${stdout}`
    );
  }
}

async function currentCommit() {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd: rootDir
    });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

async function appendResultsTsv(resultsPath, row) {
  await mkdir(dirname(resultsPath), { recursive: true });
  if (
    !existsSync(resultsPath) ||
    (await readFile(resultsPath, "utf8").catch(() => "")).trim() === ""
  ) {
    await writeFile(resultsPath, `${SIDEBAR_STARTUP_RESULTS_TSV_HEADER}\n`);
  }
  await appendFile(resultsPath, `${row}\n`);
}

function localDateTag(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

const result = await runStartupMatrix(parseArgs(process.argv.slice(2)));
console.log(JSON.stringify(result, null, 2));
