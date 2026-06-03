import { pathToFileURL } from "node:url";

import { runStartupHoverLoop } from "./profile-startup-hover.mjs";
import { runStartupScrollAwayLoop } from "./profile-startup-scroll-away.mjs";

const DEFAULT_RUNS = 5;
const SMOKE_RUNS = 1;
const DEFAULT_RETRIES = 1;

const SCENARIOS = [
  {
    id: "startup-hover",
    description: "sparse startup hover without automatic full hydration",
    run: runStartupHoverLoop,
    displayMetrics: [
      "firstPaintMaxMs",
      "firstPaintActionButtonsMax",
      "sparseHoverActionButtonsMin",
      "sparseIdleActionButtonsMin",
      "sparseHoverFrameMaxMs",
      "sparseHoverFeedbackMaxMs",
      "sparseIdleHydrationRequestsMax",
      "remoteIdleHydrationRequestsMax"
    ]
  },
  {
    id: "startup-scroll-away",
    description: "sparse scroll-away row-window rendering",
    run: runStartupScrollAwayLoop,
    displayMetrics: [
      "visibleRowsMin",
      "missingViewportRowsMax",
      "rowsVisibleMsMax",
      "followOnMissingViewportRowsMax",
      "followOnSparseWindowRequestsMax",
      "hydrationRequestsMax",
      "scrollDelayMaxMs"
    ]
  }
];

export function parseProjectionGuardArgs(argv, env = process.env) {
  const options = {
    runs: env.SIDEBAR_PROJECTION_GUARD_RUNS
      ? Number.parseInt(env.SIDEBAR_PROJECTION_GUARD_RUNS, 10)
      : DEFAULT_RUNS,
    retries: env.SIDEBAR_PROJECTION_GUARD_RETRIES
      ? Number.parseInt(env.SIDEBAR_PROJECTION_GUARD_RETRIES, 10)
      : DEFAULT_RETRIES,
    scenarios: env.SIDEBAR_PROJECTION_GUARD_SCENARIOS,
    smoke: env.SIDEBAR_PROJECTION_GUARD_SMOKE === "1",
    json: false,
    list: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--") {
      continue;
    } else if (arg === "--runs" && next) {
      options.runs = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--retries" && next) {
      options.retries = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--scenarios" && next) {
      options.scenarios = next;
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

  if (options.smoke && !env.SIDEBAR_PROJECTION_GUARD_RUNS && !argv.includes("--runs")) {
    options.runs = SMOKE_RUNS;
  }
  if (!Number.isFinite(options.runs) || options.runs < 1) {
    throw new Error("--runs must be a positive integer");
  }
  if (!Number.isFinite(options.retries) || options.retries < 0) {
    throw new Error("--retries must be a non-negative integer");
  }

  return options;
}

export function selectProjectionGuardScenarios(options = {}) {
  const selected = csvSet(options.scenarios);
  return SCENARIOS.filter((scenario) => selected.size === 0 || selected.has(scenario.id));
}

export async function runSidebarProjectionGuard(options = {}) {
  const scenarios = selectProjectionGuardScenarios(options);
  if (scenarios.length === 0) {
    throw new Error("No sidebar projection perf guard scenarios selected");
  }

  const results = [];
  for (const scenario of scenarios) {
    results.push(await runProjectionScenarioWithRetry(scenario, {
      runs: options.runs ?? DEFAULT_RUNS,
      retries: options.retries ?? DEFAULT_RETRIES
    }));
  }

  return {
    runs: options.runs ?? DEFAULT_RUNS,
    scenarioCount: scenarios.length,
    results,
    passed: results.every((result) => result.passed)
  };
}

async function runProjectionScenarioWithRetry(scenario, options) {
  const attempts = [];
  const maxAttempts = options.retries + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const profile = await scenario.run({
      runs: options.runs,
      tag: `projection-guard-${scenario.id}`,
      description: scenario.description,
      appendResults: false
    });
    const evaluated = evaluateProjectionScenario(scenario, profile);
    attempts.push(evaluated);
    if (evaluated.passed) {
      return {
        ...evaluated,
        attempts
      };
    }
  }

  return {
    ...attempts[attempts.length - 1],
    attempts
  };
}

export function evaluateProjectionScenario(scenario, profile) {
  const guardFailures = Array.isArray(profile.guardFailures) ? profile.guardFailures : [];
  const status = profile.summary?.status;
  const failures = [...guardFailures];
  if (status && status !== "keep" && status !== "candidate-keep" && failures.length === 0) {
    failures.push(`profile status is ${status}`);
  }

  return {
    id: scenario.id,
    summary: profile.summary,
    guardFailures: failures,
    passed: failures.length === 0,
    displayMetrics: scenario.displayMetrics
  };
}

export function formatSidebarProjectionGuardSummary(summary) {
  const lines = [
    `Sidebar projection perf guard: ${summary.passed ? "PASS" : "FAIL"} (${summary.scenarioCount} scenario${summary.scenarioCount === 1 ? "" : "s"}, ${summary.runs} run${summary.runs === 1 ? "" : "s"})`
  ];
  for (const result of summary.results) {
    const status = result.passed ? "PASS" : "FAIL";
    const metrics = result.displayMetrics
      .filter((metric) => typeof result.summary?.[metric] === "number")
      .map((metric) => `${metric}=${result.summary[metric]}`)
      .join(" ");
    lines.push(`${status} ${result.id}${metrics ? ` ${metrics}` : ""}`);
    if (result.passed && result.attempts?.length > 1) {
      const previousFailures = result.attempts
        .slice(0, -1)
        .flatMap((attempt) => attempt.guardFailures)
        .join("; ");
      lines.push(`  passed after retry${previousFailures ? `; prior failure: ${previousFailures}` : ""}`);
    }
    for (const failure of result.guardFailures) {
      lines.push(`  ${failure}`);
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

async function main() {
  const options = parseProjectionGuardArgs(process.argv.slice(2));
  if (options.list) {
    for (const scenario of selectProjectionGuardScenarios(options)) {
      console.log(scenario.id);
    }
    return;
  }

  const summary = await runSidebarProjectionGuard(options);
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    process.stdout.write(formatSidebarProjectionGuardSummary(summary));
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
