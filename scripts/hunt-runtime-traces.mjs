#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const TEST_FILE = "src/background/controller.test.ts";
const TEST_NAME = "adversarial runtime concurrency traces";
const BUG_FILE = process.env.RUNTIME_TRACE_BUGS_FILE ?? "RUNTIME_TRACE_BUGS.md";
const ITERATION_MS = positiveIntegerEnv("RUNTIME_TRACE_HUNT_ITERATION_MS") ?? 5 * 60 * 1000;
const STOP_AFTER_CLEAN = positiveIntegerEnv("RUNTIME_TRACE_HUNT_STOP_AFTER_CLEAN") ?? 3;
const STEPS = positiveIntegerEnv("RUNTIME_TRACE_HUNT_STEPS") ?? 120;
const BASE_SEED = positiveIntegerEnv("RUNTIME_TRACE_HUNT_BASE_SEED") ?? 10_000;
const SEED_STRIDE = positiveIntegerEnv("RUNTIME_TRACE_HUNT_SEED_STRIDE") ?? 1;
const MIN_RUN_BUDGET_MS = 2_000;
const MAX_SEED = 0x7fffffff;

const scheduler = createAdversarialSeedScheduler(BASE_SEED, SEED_STRIDE);
let cleanIterations = 0;
let iteration = 0;
const bugLog = loadBugLog(BUG_FILE);

ensureBugLogFile(BUG_FILE);

console.log(`Runtime trace hunt writing findings to ${BUG_FILE}`);
console.log(`Each iteration is capped at ${ITERATION_MS}ms; stopping after ${STOP_AFTER_CLEAN} clean iterations.`);
console.log(`Replay template: GENERATED_TRACE_BASE_SEED=<seed> GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=${STEPS} pnpm exec vitest run ${TEST_FILE} --testNamePattern "${TEST_NAME}" --reporter=dot`);
console.log("Seed strategy: adaptive deterministic frontier; mutate newly failing seeds first, then fall back to mixed global probes.");

while (cleanIterations < STOP_AFTER_CLEAN) {
  iteration += 1;
  const deadline = Date.now() + ITERATION_MS;
  let runs = 0;
  let failures = 0;
  let duplicateFailures = 0;
  let newFindings = 0;
  const firstSeed = scheduler.peekNextSeed();
  let lastSeed = firstSeed;

  console.log(`\nIteration ${iteration} starting at seed ${firstSeed}`);

  while (Date.now() + MIN_RUN_BUDGET_MS <= deadline) {
    const seed = scheduler.nextSeed();
    lastSeed = seed;
    runs += 1;

    const result = await runSeed(seed, Math.max(MIN_RUN_BUDGET_MS, deadline - Date.now()));
    if (result.timedOut) {
      console.log(`Seed ${seed} timed out at the iteration boundary.`);
      break;
    }
    if (result.code === 0) {
      continue;
    }

    failures += 1;
    const finding = parseFinding(seed, result.output);
    if (!finding) {
      const fallback = {
        seed,
        message: `vitest exited with code ${result.code}`,
        trace: excerpt(result.output, 60),
        signature: `unparsed failure:${result.code}:${seed}`,
        replay: replayCommand(seed)
      };
      const recorded = recordFinding(BUG_FILE, bugLog, fallback);
      scheduler.noteFailure(seed, fallback.signature, recorded);
      if (recorded) {
        newFindings += 1;
      } else {
        duplicateFailures += 1;
      }
      continue;
    }

    const recorded = recordFinding(BUG_FILE, bugLog, finding);
    scheduler.noteFailure(seed, finding.signature, recorded);
    if (recorded) {
      newFindings += 1;
      console.log(`New finding at seed ${seed}: ${finding.message}`);
      break;
    }

    duplicateFailures += 1;
  }

  appendIterationSummary(BUG_FILE, {
    iteration,
    firstSeed,
    lastSeed,
    runs,
    failures,
    duplicateFailures,
    newFindings
  });

  if (newFindings === 0) {
    cleanIterations += 1;
  } else {
    cleanIterations = 0;
  }

  console.log(
    `Iteration ${iteration} done: ${runs} run(s), ${failures} failure(s), ${newFindings} new finding(s), ` +
      `${duplicateFailures} duplicate failure(s), clean streak ${cleanIterations}/${STOP_AFTER_CLEAN}.`
  );
}

console.log(`Runtime trace hunt stopped after ${cleanIterations} consecutive clean iteration(s).`);

function createAdversarialSeedScheduler(baseSeed, stride) {
  const seen = new Set();
  const frontier = [];
  const duplicateMutationCounts = new Map();
  let globalIndex = 0;

  enqueueFrontier([
    baseSeed,
    ...[1, 2, 3, 5, 8, 13, 20, 21, 34, 55, 89, 144, 233].map((offset) => baseSeed + offset * stride),
    ...[1, 2, 4, 8, 16, 32, 64, 128, 256].map((mask) => normalizeSeed(baseSeed ^ mask))
  ]);

  return {
    nextSeed() {
      const queued = dequeueFrontier();
      if (queued !== undefined) {
        return queued;
      }

      for (;;) {
        const seed = globalProbeSeed(baseSeed, globalIndex);
        globalIndex += 1;
        if (!seen.has(seed)) {
          seen.add(seed);
          return seed;
        }
      }
    },

    peekNextSeed() {
      for (const seed of frontier) {
        if (!seen.has(seed)) {
          return seed;
        }
      }
      let probeIndex = globalIndex;
      for (;;) {
        const seed = globalProbeSeed(baseSeed, probeIndex);
        probeIndex += 1;
        if (!seen.has(seed)) {
          return seed;
        }
      }
    },

    noteFailure(seed, signature, isNewFinding) {
      if (isNewFinding) {
        enqueueFrontier(adversarialSeedMutations(seed, stride, "wide"));
        return;
      }

      const count = duplicateMutationCounts.get(signature) ?? 0;
      if (count >= 2) {
        return;
      }
      duplicateMutationCounts.set(signature, count + 1);
      enqueueFrontier(adversarialSeedMutations(seed, stride, "narrow"));
    }
  };

  function enqueueFrontier(seeds) {
    const next = [];
    for (const seed of seeds) {
      const normalized = normalizeSeed(seed);
      if (seen.has(normalized) || next.includes(normalized)) {
        continue;
      }
      next.push(normalized);
    }
    frontier.unshift(...next);
  }

  function dequeueFrontier() {
    while (frontier.length > 0) {
      const seed = frontier.shift();
      if (seed === undefined || seen.has(seed)) {
        continue;
      }
      seen.add(seed);
      return seed;
    }
    return undefined;
  }
}

async function runSeed(seed, timeoutMs) {
  const env = {
    ...process.env,
    GENERATED_TRACE_BASE_SEED: String(seed),
    GENERATED_TRACE_SEED_COUNT: "1",
    GENERATED_TRACE_STEPS: String(STEPS)
  };
  const child = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", [
    "exec",
    "vitest",
    "run",
    TEST_FILE,
    "--testNamePattern",
    TEST_NAME,
    "--reporter=dot"
  ], {
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  return await new Promise((resolve) => {
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, timedOut });
    });
  });
}

function parseFinding(seed, output) {
  const message = output.match(/Error: ([^\n]+)/)?.[1]?.trim();
  const trace = output.match(/Trace:\n([\s\S]*?)(?:\n ❯|\n\n⎯)/)?.[1]?.trim();
  if (!message || !trace) {
    return undefined;
  }

  const traceLines = trace.split("\n").map((line) => line.trim()).filter(Boolean);
  const lastStepIndex = findLastIndex(traceLines, (line) => line.startsWith("step "));
  const operation = lastStepIndex >= 0 ? traceLines[lastStepIndex] : "unknown operation";
  const eventLine = lastStepIndex >= 0
    ? traceLines.slice(lastStepIndex + 1).find((line) => line.startsWith("dispatch ")) ?? ""
    : "";
  const signature = [
    normalizeTraceSignaturePart(message),
    normalizeTraceSignaturePart(operation),
    normalizeTraceSignaturePart(eventLine)
  ].join("\n");
  return {
    seed,
    message,
    trace,
    signature,
    replay: replayCommand(seed)
  };
}

function recordFinding(file, log, finding) {
  if (log.signatures.has(finding.signature)) {
    return false;
  }

  const id = `RT-${String(log.nextId).padStart(3, "0")}`;
  log.nextId += 1;
  log.signatures.add(finding.signature);

  append(file, `
### ${id} ${finding.message}
<!-- signature: ${escapeHtmlComment(finding.signature)} -->

- First seen: ${new Date().toISOString()}
- Repro: \`${finding.replay}\`
- Status: documented, not fixed.

\`\`\`text
${finding.trace}
\`\`\`
`);

  return true;
}

function appendIterationSummary(file, summary) {
  append(file, `
<!-- hunt-iteration: ${JSON.stringify({
    at: new Date().toISOString(),
    ...summary
  })} -->
`);
}

function replayCommand(seed) {
  return `env GENERATED_TRACE_BASE_SEED=${seed} GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=${STEPS} pnpm exec vitest run ${TEST_FILE} --testNamePattern "${TEST_NAME}" --reporter=dot`;
}

function ensureBugLogFile(file) {
  if (existsSync(file)) {
    return;
  }

  writeFileSync(file, `# Runtime Trace Bug Hunt

This file records distinct bugs found by deterministic adversarial runtime concurrency traces.
The hunt intentionally documents findings without fixing them.

Run the hunt with:

\`\`\`sh
pnpm trace-hunt:runtime
\`\`\`

Default hunt bounds:

- Iteration limit: 5 minutes
- Stop condition: 3 consecutive iterations with no new distinct findings
- Trace selection: deterministic adaptive frontier; mutate newly failing seeds first, then fall back to mixed global probes
- Test target: \`${TEST_FILE}\`
- Test name: \`${TEST_NAME}\`

## Findings
`);
}

function loadBugLog(file) {
  if (!existsSync(file)) {
    return { signatures: new Set(), nextId: 1 };
  }

  const text = readFileSync(file, "utf8");
  const signatures = new Set(
    [...text.matchAll(/<!-- signature: ([\s\S]*?) -->/g)].map((match) => unescapeHtmlComment(match[1] ?? ""))
  );
  const ids = [...text.matchAll(/^### RT-(\d+)/gm)].map((match) => Number(match[1]));
  return {
    signatures,
    nextId: ids.length > 0 ? Math.max(...ids) + 1 : 1
  };
}

function append(file, text) {
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(file, `${current}${text}`);
}

function excerpt(text, maxLines) {
  return text.split("\n").slice(0, maxLines).join("\n").trim();
}

function escapeHtmlComment(value) {
  return value.replaceAll("--", "- -");
}

function unescapeHtmlComment(value) {
  return value.replaceAll("- -", "--");
}

function findLastIndex(values, predicate) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index], index)) {
      return index;
    }
  }
  return -1;
}

function normalizeTraceSignaturePart(value) {
  return value
    .replace(/^step \d+:/, "step:")
    .replace(/\bseed \d+\b/g, "seed <id>")
    .replace(/\btab \d+\b/g, "tab <id>")
    .replace(/\bwindow \d+\b/g, "window <id>")
    .replace(/\bgroup:\d+\b/g, "group:<id>")
    .replace(/\btab:\d+\b/g, "tab:<id>")
    .replace(/\bwindow:\d+\b/g, "window:<id>");
}

function adversarialSeedMutations(seed, stride, width) {
  const offsets = width === "wide"
    ? [1, -1, 2, -2, 3, -3, 5, -5, 8, -8, 13, -13, 21, -21, 34, -34, 55, -55, 89, -89, 144, -144]
    : [1, -1, 2, -2, 5, -5, 13, -13];
  const masks = width === "wide"
    ? [0x1, 0x2, 0x4, 0x8, 0x10, 0x20, 0x40, 0x80, 0x100, 0x200, 0x400, 0x800, 0x1000, 0x55, 0xaa, 0x5a5a]
    : [0x1, 0x2, 0x4, 0x8, 0x10, 0x55];
  return [
    ...offsets.map((offset) => seed + offset * stride),
    ...masks.map((mask) => seed ^ mask),
    mixSeed(seed),
    mixSeed(seed ^ 0x9e3779b9),
    mixSeed(seed + 0x7f4a7c15)
  ];
}

function globalProbeSeed(baseSeed, index) {
  if (index === 0) {
    return normalizeSeed(baseSeed);
  }
  return normalizeSeed(mixSeed(baseSeed + Math.imul(index, 0x9e3779b1)));
}

function mixSeed(seed) {
  let value = seed >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

function normalizeSeed(seed) {
  const normalized = seed % MAX_SEED;
  return normalized > 0 ? normalized : normalized + MAX_SEED;
}

function positiveIntegerEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}
