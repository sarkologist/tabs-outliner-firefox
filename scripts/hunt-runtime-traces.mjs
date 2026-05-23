#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const TEST_FILE = "src/background/controller.test.ts";
const TEST_NAME = "adversarial runtime domain traces";
const BUG_FILE = process.env.RUNTIME_TRACE_BUGS_FILE ?? "RUNTIME_TRACE_BUGS.md";
const CORPUS_RUN_CAP_MS =
  positiveIntegerEnv("RUNTIME_TRACE_HUNT_CORPUS_RUN_MS") ??
  positiveIntegerEnv("RUNTIME_TRACE_HUNT_ITERATION_MS") ??
  5 * 60 * 1000;
const STOP_AFTER_CLEAN = positiveIntegerEnv("RUNTIME_TRACE_HUNT_STOP_AFTER_CLEAN") ?? 3;
const MIN_RUN_BUDGET_MS = 2_000;
const DEFAULT_TRACE_IDS = [
  "rt-active-race",
  "rt-created-race-after-window-close",
  "rt-stale-created-after-move",
  "rt-stale-created-after-fresh-relocation-event",
  "rt-stale-updated-after-move",
  "rt-stale-updated-after-fresh-relocation-event",
  "rt-stale-activation-after-fresh-relocation-event",
  "rt-native-close-after-relocation",
  "rt-restore-delete-delayed-stale-event",
  "rt-direct-new-window-stale-created-after-fresh-event",
  "rt-top-level-stale-updated-after-fresh-event",
  "rt-repeated-direct-relocation-stale-events",
  "rt-repeated-direct-relocation-with-filler-stale-events",
  "rt-repeated-direct-relocation-native-close-stale-event",
  "rt-repeated-top-level-relocation-with-filler-stale-events",
  "rt-direct-new-window-native-close-old-window-stale-created",
  "rt-direct-new-window-outliner-close-old-window-stale-updated",
  "rt-top-level-native-close-old-window-stale-created",
  "rt-group-native-close-old-window-stale-updated",
  "rt-direct-new-window-delete-old-window-rejecting-close-stale-created",
  "rt-top-level-delete-old-window-rejecting-close-stale-updated",
  "rt-group-delete-old-window-rejecting-close-stale-created",
  "rt-top-level-outliner-close-old-window-stale-created",
  "rt-group-outliner-close-old-window-stale-updated",
  "rt-direct-new-window-native-close-destination-stale-updated",
  "rt-direct-new-window-outliner-close-destination-stale-created",
  "rt-top-level-native-close-destination-stale-updated",
  "rt-group-outliner-close-destination-stale-created",
  "rt-direct-new-window-native-close-tab-removed-only-stale-created",
  "rt-direct-new-window-native-close-session-only-stale-updated",
  "rt-top-level-native-close-tab-removed-only-stale-created",
  "rt-group-native-close-session-only-stale-updated",
  "rt-top-level-native-close-session-only-stale-updated",
  "rt-group-native-close-tab-removed-only-stale-created",
  "rt-direct-new-window-native-close-default-order-stale-created",
  "rt-direct-new-window-stale-activation-after-focus",
  "rt-top-level-stale-activation-after-focus",
  "rt-group-stale-activation-after-focus",
  "rt-direct-new-window-old-window-activation-with-stale-relocated-tab",
  "rt-top-level-old-window-activation-with-stale-relocated-tab",
  "rt-group-old-window-activation-with-stale-relocated-tab",
  "rt-direct-new-window-command-focus-stale-updated",
  "rt-top-level-command-focus-stale-created",
  "rt-group-command-focus-stale-updated",
  "rt-direct-new-window-delete-tab-rejecting-close-stale-created",
  "rt-top-level-delete-tab-rejecting-close-stale-updated",
  "rt-group-delete-tab-rejecting-close-stale-created",
  "rt-direct-new-window-outliner-close-tab-stale-updated",
  "rt-top-level-outliner-close-tab-stale-created",
  "rt-group-outliner-close-tab-stale-updated",
  "rt-direct-new-window-close-source-tab-stale-created",
  "rt-top-level-close-source-tab-stale-updated",
  "rt-group-close-source-tab-stale-created",
  "rt-direct-new-window-stale-updated-fast-path-after-fresh-event",
  "rt-top-level-stale-created-fast-path-after-fresh-event",
  "rt-group-stale-updated-fast-path-after-fresh-event",
  "rt-direct-new-window-paired-stale-events-after-fresh-event",
  "rt-top-level-paired-stale-events-after-fresh-event",
  "rt-group-paired-stale-events-after-fresh-event",
  "rt-direct-new-window-open-active-source-tab-stale-updated",
  "rt-top-level-open-active-source-tab-stale-created",
  "rt-group-open-active-source-tab-stale-updated",
  "rt-direct-new-window-open-active-destination-tab-stale-created",
  "rt-top-level-open-active-destination-tab-stale-updated",
  "rt-group-open-active-destination-tab-stale-created"
];

const traceIds = selectedTraceIds();
if (traceIds.length === 0) {
  throw new Error("RUNTIME_TRACE_HUNT_TRACE_IDS selected no traces");
}
const bugLog = loadBugLog(BUG_FILE);

ensureBugLogFile(BUG_FILE);

console.log(`Runtime trace hunt writing findings to ${BUG_FILE}`);
console.log(`This corpus run is capped at ${CORPUS_RUN_CAP_MS}ms.`);
console.log(`Agent stop rule: stop after ${STOP_AFTER_CLEAN} clean 5-minute mutation round(s) with no new distinct findings.`);
console.log(`Trace strategy: run the current domain corpus once, recording every distinct failure; Codex/humans mutate trace actions between runs.`);
console.log(`Trace IDs: ${traceIds.join(", ")}`);

const deadline = Date.now() + CORPUS_RUN_CAP_MS;
let runs = 0;
let failures = 0;
let duplicateFailures = 0;
let newFindings = 0;
let lastTraceId = traceIds[0] ?? "";
let completedCorpus = false;

console.log(`\nRunning ${traceIds.length} domain trace(s) once`);

for (const traceId of traceIds) {
  if (Date.now() + MIN_RUN_BUDGET_MS > deadline) {
    console.log(`Trace ${traceId} skipped at the corpus run boundary.`);
    break;
  }

  lastTraceId = traceId;
  runs += 1;
  const result = await runTrace(traceId, Math.max(MIN_RUN_BUDGET_MS, deadline - Date.now()));
  if (result.timedOut) {
    console.log(`Trace ${traceId} timed out at the corpus run boundary.`);
    break;
  }
  if (result.code === 0) {
    completedCorpus = traceId === traceIds.at(-1);
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
      console.log(`New unparsed finding in ${traceId}: ${fallback.message}`);
    } else {
      duplicateFailures += 1;
    }
    completedCorpus = traceId === traceIds.at(-1);
    continue;
  }

  if (recordFinding(BUG_FILE, bugLog, finding)) {
    newFindings += 1;
    console.log(`New finding in ${traceId}: ${finding.message}`);
  } else {
    duplicateFailures += 1;
  }
  completedCorpus = traceId === traceIds.at(-1);
}

appendCorpusRunSummary(BUG_FILE, {
  mode: "agent-corpus-run",
  firstTraceId: traceIds[0] ?? "",
  lastTraceId,
  runs,
  completedCorpus,
  failures,
  duplicateFailures,
  newFindings
});

console.log(
  `Corpus run done: ${runs} run(s), ${failures} failure(s), ${newFindings} new finding(s), ` +
    `${duplicateFailures} duplicate failure(s), completed corpus: ${completedCorpus ? "yes" : "no"}.`
);

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

function appendCorpusRunSummary(file, summary) {
  append(file, `
<!-- hunt-corpus-run: ${JSON.stringify({
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

- Corpus run cap: 5 minutes
- Agent stop condition: 3 consecutive clean 5-minute mutation rounds with no new distinct findings
- Trace selection: execute the current explicit domain trace corpus once, recording every distinct failure; Codex/humans mutate trace actions between runs, not seeds
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
