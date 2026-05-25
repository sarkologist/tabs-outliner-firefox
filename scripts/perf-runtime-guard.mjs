import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_BUDGET_FILE = path.join(SCRIPT_DIR, "runtime-perf-budgets.json");
const DEFAULT_TOLERANCE = 0.15;

const TIMING_METRICS = new Set([
  "firstBroadcastMs",
  "totalMeasuredMs",
  "totalWithSaveFlushMs"
]);

const DISPLAY_METRICS = [
  "firstBroadcastMs",
  "totalMeasuredMs",
  "totalWithSaveFlushMs",
  "saves",
  "journalWrites",
  "storageSetCalls",
  "broadcasts",
  "stateBroadcasts",
  "statusBroadcasts",
  "projectionMs",
  "tabsQueryMs",
  "windowsGetAllMs",
  "mbStringified"
];

export function parseProfileJson(stdout) {
  const text = String(stdout ?? "").trim();
  const starts = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "{") {
      starts.push(index);
    }
  }
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(text.slice(starts[index]));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Try the previous opening brace; pnpm prefixes command output before JSON.
    }
  }
  throw new Error("No JSON profile result found in stdout");
}

export function loadBudgetConfig(filePath = DEFAULT_BUDGET_FILE) {
  const resolved = path.resolve(filePath);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.scenarios)) {
    throw new Error(`Invalid runtime perf budget file: ${resolved}`);
  }
  return parsed;
}

export function selectScenarios(config, options = {}) {
  const ids = csvSet(options.scenarios);
  const tags = csvSet(options.tags);
  return config.scenarios.filter((scenario) => {
    if (ids.size > 0 && !ids.has(scenario.id)) {
      return false;
    }
    if (tags.size > 0 && !scenario.tags?.some((tag) => tags.has(tag))) {
      return false;
    }
    return true;
  });
}

export function evaluateProfileResult(scenario, result, options = {}) {
  const smoke = Boolean(options.smoke);
  const tolerance = options.tolerance ?? scenario.tolerance ?? DEFAULT_TOLERANCE;
  const budget = smoke && scenario.smoke?.budget ? scenario.smoke.budget : scenario.budget;
  if (!budget || typeof budget !== "object") {
    throw new Error(`Scenario ${scenario.id} has no ${smoke ? "smoke " : ""}budget`);
  }

  const checks = [];
  const failures = [];
  for (const [metric, expected] of Object.entries(budget)) {
    if (typeof expected !== "number") {
      continue;
    }
    const actual = result[metric];
    if (typeof actual !== "number") {
      failures.push({
        metric,
        expected,
        actual: undefined,
        limit: metricLimit(metric, expected, tolerance),
        reason: "missing"
      });
      continue;
    }
    const limit = metricLimit(metric, expected, tolerance);
    const passed = actual <= limit;
    const check = { metric, expected, actual, limit, passed };
    checks.push(check);
    if (!passed) {
      failures.push({
        ...check,
        reason: TIMING_METRICS.has(metric) ? "timing" : "hard-max"
      });
    }
  }

  return {
    id: scenario.id,
    tags: scenario.tags ?? [],
    result,
    checks,
    failures,
    passed: failures.length === 0
  };
}

export function metricLimit(metric, expected, tolerance = DEFAULT_TOLERANCE) {
  if (TIMING_METRICS.has(metric)) {
    return Math.ceil(expected * (1 + tolerance));
  }
  return expected;
}

export async function runRuntimePerfGuard(options = {}) {
  const config = loadBudgetConfig(options.budgetFile);
  const smoke = Boolean(options.smoke);
  const scenarios = selectScenarios(config, options);
  if (scenarios.length === 0) {
    throw new Error("No runtime perf guard scenarios selected");
  }

  const results = [];
  for (const scenario of scenarios) {
    const profile = runProfileScenario(scenario, { smoke });
    const evaluation = evaluateProfileResult(scenario, profile.result, {
      smoke,
      tolerance: config.tolerance ?? DEFAULT_TOLERANCE
    });
    results.push({
      ...evaluation,
      command: profile.command,
      stdout: profile.stdout,
      stderr: profile.stderr
    });
  }
  return {
    smoke,
    scenarioCount: scenarios.length,
    results,
    passed: results.every((result) => result.passed)
  };
}

export function runProfileScenario(scenario, options = {}) {
  const smoke = Boolean(options.smoke);
  const args = smoke && scenario.smoke?.args ? scenario.smoke.args : scenario.args ?? [];
  const command = scenario.command
    ? [...scenario.command, ...args]
    : ["pnpm", scenario.pnpmScript, "--", ...args];
  const [bin, ...spawnArgs] = command;
  if (!bin) {
    throw new Error(`Scenario ${scenario.id} has no command`);
  }

  const child = spawnSync(bin, spawnArgs, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(scenario.env ?? {})
    }
  });
  if (child.status !== 0) {
    throw new Error([
      `Runtime perf scenario ${scenario.id} failed with exit ${child.status}`,
      `$ ${command.join(" ")}`,
      child.stdout,
      child.stderr
    ].filter(Boolean).join("\n"));
  }
  return {
    command,
    stdout: child.stdout,
    stderr: child.stderr,
    result: parseProfileJson(child.stdout)
  };
}

export function formatGuardSummary(summary) {
  const lines = [
    `Runtime perf guard: ${summary.passed ? "PASS" : "FAIL"} (${summary.scenarioCount} scenario${summary.scenarioCount === 1 ? "" : "s"}${summary.smoke ? ", smoke" : ""})`
  ];
  for (const result of summary.results) {
    const status = result.passed ? "PASS" : "FAIL";
    const metrics = DISPLAY_METRICS
      .filter((metric) => typeof result.result[metric] === "number")
      .map((metric) => `${metric}=${result.result[metric]}`)
      .join(" ");
    lines.push(`${status} ${result.id}${metrics ? ` ${metrics}` : ""}`);
    for (const failure of result.failures) {
      lines.push(`  ${failure.metric}: ${failure.actual ?? "missing"} > ${failure.limit} (${failure.reason}, budget ${failure.expected})`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function csvSet(value) {
  if (!value) {
    return new Set();
  }
  const values = Array.isArray(value) ? value : String(value).split(",");
  return new Set(values.map((item) => String(item).trim()).filter(Boolean));
}

function parseCli(argv) {
  const options = {
    budgetFile: process.env.RUNTIME_PERF_BUDGET_FILE || DEFAULT_BUDGET_FILE,
    scenarios: process.env.RUNTIME_PERF_GUARD_SCENARIOS,
    tags: process.env.RUNTIME_PERF_GUARD_TAGS,
    smoke: process.env.RUNTIME_PERF_GUARD_SMOKE === "1",
    json: false,
    list: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--budget" && next) {
      options.budgetFile = next;
      index += 1;
    } else if (arg === "--scenarios" && next) {
      options.scenarios = next;
      index += 1;
    } else if (arg === "--tags" && next) {
      options.tags = next;
      index += 1;
    } else if (arg === "--smoke") {
      options.smoke = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--list") {
      options.list = true;
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const config = loadBudgetConfig(options.budgetFile);
  if (options.list) {
    for (const scenario of selectScenarios(config, options)) {
      console.log(`${scenario.id}\t${(scenario.tags ?? []).join(",")}`);
    }
    return;
  }

  const summary = await runRuntimePerfGuard(options);
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    process.stdout.write(formatGuardSummary(summary));
  }
  if (!summary.passed) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
