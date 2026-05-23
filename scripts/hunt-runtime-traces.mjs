#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const TEST_FILE = "src/background/controller.test.ts";
const TEST_NAME = "adversarial runtime domain traces";
const BUG_FILE = process.env.RUNTIME_TRACE_BUGS_FILE ?? "RUNTIME_TRACE_BUGS.md";
const ITERATION_MS = positiveIntegerEnv("RUNTIME_TRACE_HUNT_ITERATION_MS") ?? 5 * 60 * 1000;
const STOP_AFTER_CLEAN = positiveIntegerEnv("RUNTIME_TRACE_HUNT_STOP_AFTER_CLEAN") ?? 3;
const MIN_RUN_BUDGET_MS = 2_000;
const DEFAULT_TRACE_IDS = [
  "rt-active-race",
  "rt-created-race-after-window-close",
  "rt-stale-created-after-move",
  "rt-stale-updated-after-move",
  "rt-native-close-after-relocation",
  "rt-restore-delete-delayed-stale-event"
];

const traceIds = selectedTraceIds();
let cleanIterations = 0;
let iteration = 0;
const bugLog = loadBugLog(BUG_FILE);

ensureBugLogFile(BUG_FILE);

console.log(`Runtime trace hunt writing findings to ${BUG_FILE}`);
console.log(`Each iteration is capped at ${ITERATION_MS}ms; stopping after ${STOP_AFTER_CLEAN} clean iterations.`);
console.log(`Trace strategy: domain-level corpus runner; Codex/humans mutate trace actions, not seeds.`);
console.log(`Trace IDs: ${traceIds.join(", ")}`);

while (cleanIterations < STOP_AFTER_CLEAN) {
  iteration += 1;
  const deadline = Date.now() + ITERATION_MS;
  let runs = 0;
  let failures = 0;
  let duplicateFailures = 0;
  let newFindings = 0;
  let lastTraceId = traceIds[0] ?? "";

  console.log(`\nIteration ${iteration} starting with ${traceIds.length} domain trace(s)`);

  for (const traceId of traceIds) {
    if (Date.now() + MIN_RUN_BUDGET_MS > deadline) {
      console.log(`Trace ${traceId} skipped at the iteration boundary.`);
      break;
    }

    lastTraceId = traceId;
    runs += 1;
    const result = await runTrace(traceId, Math.max(MIN_RUN_BUDGET_MS, deadline - Date.now()));
    if (result.timedOut) {
      console.log(`Trace ${traceId} timed out at the iteration boundary.`);
      break;
    }
    if (result.code === 0) {
      continue;
    }

    failures += 1;
    const finding = parseFinding(traceId, result.output);
    if (!finding) {
      const fallback = {
        traceId,
        message: `vitest exited with code ${result.code}`,
        trace: excerpt(result.output, 80),
        signature: `unparsed failure:${result.code}:${traceId}`,
        replay: replayCommand(traceId)
      };
      if (recordFinding(BUG_FILE, bugLog, fallback)) {
        newFindings += 1;
      } else {
        duplicateFailures += 1;
      }
      continue;
    }

    if (recordFinding(BUG_FILE, bugLog, finding)) {
      newFindings += 1;
      console.log(`New finding in ${traceId}: ${finding.message}`);
    } else {
      duplicateFailures += 1;
    }
  }

  appendIterationSummary(BUG_FILE, {
    iteration,
    firstTraceId: traceIds[0] ?? "",
    lastTraceId,
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

async function runTrace(traceId, timeoutMs) {
  const child = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", [
    "exec",
    "vitest",
    "run",
    TEST_FILE,
    "--testNamePattern",
    TEST_NAME,
    "--reporter=dot"
  ], {
    env: {
      ...process.env,
      RUNTIME_DOMAIN_TRACE_HUNT: "1",
      RUNTIME_TRACE_HUNT_TRACE_IDS: traceId
    },
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

function parseFinding(traceId, output) {
  const message = output.match(/Error: ([^\n]+)/)?.[1]?.trim();
  const domainTraceId = output.match(/Domain trace: ([^\n]+)/)?.[1]?.trim() ?? traceId;
  const action = output.match(/Action \d+: ([^\n]+)/)?.[0]?.trim() ?? "";
  const trace = output.match(/Trace:\n([\s\S]*?)(?:\n ❯|\n\n⎯)/)?.[1]?.trim();
  if (!message || !trace) {
    return undefined;
  }

  const traceLines = trace.split("\n").map((line) => line.trim()).filter(Boolean);
  const actionLine = findLast(traceLines, (line) => line.startsWith("action ")) ?? action;
  const signature = [
    normalizeTraceSignaturePart(message),
    `domain trace: ${domainTraceId}`,
    normalizeTraceSignaturePart(actionLine)
  ].join("\n");
  return {
    traceId: domainTraceId,
    message,
    trace,
    signature,
    replay: replayCommand(domainTraceId)
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
- Trace id: \`${finding.traceId}\`
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

function replayCommand(traceId) {
  return `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=${traceId} pnpm exec vitest run ${TEST_FILE} --testNamePattern "${TEST_NAME}" --reporter=dot`;
}

function ensureBugLogFile(file) {
  if (existsSync(file)) {
    return;
  }

  writeFileSync(file, `# Runtime Trace Bug Hunt

This file records distinct bugs found by deterministic adversarial runtime domain traces.
The hunt intentionally documents findings without fixing them.

Run the hunt with:

\`\`\`sh
pnpm trace-hunt:runtime
\`\`\`

Default hunt bounds:

- Iteration limit: 5 minutes
- Stop condition: 3 consecutive iterations with no new distinct findings
- Trace selection: explicit domain trace corpus; Codex/humans mutate trace actions, not seeds
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

function selectedTraceIds() {
  const rawTraceIds = process.env.RUNTIME_TRACE_HUNT_TRACE_IDS;
  if (!rawTraceIds) {
    return DEFAULT_TRACE_IDS;
  }
  return rawTraceIds
    .split(",")
    .map((traceId) => traceId.trim())
    .filter(Boolean);
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

function findLast(values, predicate) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index], index)) {
      return values[index];
    }
  }
  return undefined;
}

function normalizeTraceSignaturePart(value) {
  return value
    .replace(/^action \d+:/, "action:")
    .replace(/\bseed \d+\b/g, "seed <id>")
    .replace(/\btab \d+\b/g, "tab <id>")
    .replace(/\bwindow \d+\b/g, "window <id>")
    .replace(/\bgroup:\d+\b/g, "group:<id>")
    .replace(/\btab:\d+\b/g, "tab:<id>")
    .replace(/\bwindow:\d+\b/g, "window:<id>");
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
