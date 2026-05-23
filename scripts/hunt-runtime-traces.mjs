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
const TRACE_HUNT_PROFILE = traceHuntProfile();
const REGRESSION_TRACE_IDS = [
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
  "rt-group-open-active-destination-tab-stale-created",
  "dh-undo-redo-stale-refresh",
  "dh-history-redo-stale-created",
  "dh-history-redo-session-refresh",
  "dh-restore-history-redo-delayed-echo",
  "dh-manual-stale-query-after-source-close",
  "dh-history-manual-stale-query",
  "dh-repeated-relocation-manual-stale-query",
  "dh-opener-source-close-manual-stale-query",
  "dh-group-source-close-manual-stale-query",
  "dh-top-level-source-close-manual-stale-query",
  "dh-created-race-source-close-manual-stale-query",
  "dh-activation-race-source-close-manual-stale-query",
  "dh-outliner-source-close-manual-stale-query",
  "dh-delete-reject-source-window-manual-stale-query",
  "dh-outliner-source-tab-close-manual-stale-query",
  "dh-relocated-tab-missing-manual-query",
  "dh-fresh-relocated-tab-missing-manual-query",
  "dh-opener-child-missing-manual-query"
];
const DISCOVERY_TRACE_IDS = [
  "dh-restore-delayed-focus-refresh",
  "dh-opener-reparent-refresh",
  "dh-nested-parent-native-close",
  "dh-partial-subtree-delete-reject",
  "dh-focus-session-activation-refresh",
  "dh-opener-source-close-stale-child",
  "dh-opener-session-only-close",
  "dh-refresh-delete-reject-relocated-tab",
  "dh-repeated-relocation-refresh-stale-pair",
  "dh-fresh-event-source-close-stale-echo",
  "dh-focus-churn-refresh-stale-echo",
  "dh-refresh-delete-reject-window-after-relocation",
  "dh-created-race-refresh-delete-reject",
  "dh-activation-race-source-close-refresh",
  "dh-update-race-focus-session-refresh",
  "dh-restore-delete-stale-created-refresh",
  "dh-restore-delete-stale-updated-session",
  "dh-nested-opener-delete-reject",
  "dh-nested-opener-native-close-refresh",
  "dh-command-focus-relocated-refresh-stale",
  "dh-outliner-close-destination-refresh-stale",
  "dh-outliner-close-tab-refresh-stale",
  "dh-source-sibling-close-refresh-stale",
  "dh-manual-stale-query-after-relocation",
  "dh-delete-reject-manual-stale-query",
  "dh-outliner-close-manual-stale-query",
  "dh-restore-delete-manual-stale-query",
  "dh-session-only-close-manual-stale-query",
  "dh-destination-close-manual-stale-query",
  "dh-focus-override-manual-stale-query",
  "dh-current-session-refresh-after-relocation",
  "dh-opener-current-refresh-after-relocation",
  "dh-focus-current-refresh-after-relocation",
  "dh-race-current-refresh-after-relocation",
  "dh-repeated-current-refresh-after-relocation",
  "dh-restore-current-refresh-after-delete",
  "dh-delete-reject-current-refresh",
  "dh-outliner-close-current-refresh",
  "dh-native-close-current-refresh",
  "dh-destination-window-current-refresh",
  "dh-source-sibling-current-refresh",
  "dh-active-destination-current-refresh",
  "dh-active-source-current-refresh",
  "dh-opener-active-current-refresh",
  "dh-race-active-current-refresh",
  "dh-repeated-active-current-refresh"
];
const ALL_TRACE_IDS = [...REGRESSION_TRACE_IDS, ...DISCOVERY_TRACE_IDS];
const TRACE_TAGS = new Map([
  ...REGRESSION_TRACE_IDS.map((traceId) => [traceId, ["known-finding"]]),
  ["dh-restore-delayed-focus-refresh", ["restore", "delayed-event", "focus", "manual-refresh"]],
  ["dh-opener-reparent-refresh", ["opener", "reparenting", "relocation", "manual-refresh"]],
  ["dh-nested-parent-native-close", ["nested-window", "native-close", "relocation", "stale-event"]],
  ["dh-partial-subtree-delete-reject", ["delete-rejection", "partial-close", "stale-event", "tombstone"]],
  ["dh-focus-session-activation-refresh", ["focus", "activation", "session", "manual-refresh"]],
  ["dh-undo-redo-stale-refresh", ["undo-redo", "stale-event", "relocation", "manual-refresh"]],
  ["dh-opener-source-close-stale-child", ["opener", "reparenting", "relocation", "native-close", "stale-event"]],
  ["dh-opener-session-only-close", ["opener", "relocation", "session", "stale-event", "tombstone"]],
  ["dh-refresh-delete-reject-relocated-tab", ["manual-refresh", "delete-rejection", "relocation", "tombstone", "stale-event"]],
  ["dh-history-redo-stale-created", ["undo-redo", "stale-event", "relocation", "manual-refresh"]],
  ["dh-history-redo-session-refresh", ["undo-redo", "session", "relocation", "stale-event", "manual-refresh"]],
  ["dh-restore-history-redo-delayed-echo", ["restore", "undo-redo", "delayed-event", "stale-event", "manual-refresh"]],
  ["dh-repeated-relocation-refresh-stale-pair", ["relocation", "manual-refresh", "stale-event", "paired-echo"]],
  ["dh-fresh-event-source-close-stale-echo", ["relocation", "native-close", "fresh-event", "stale-event", "manual-refresh"]],
  ["dh-focus-churn-refresh-stale-echo", ["focus", "activation", "relocation", "manual-refresh", "stale-event"]],
  ["dh-refresh-delete-reject-window-after-relocation", ["delete-rejection", "relocation", "manual-refresh", "tombstone", "stale-event"]],
  ["dh-created-race-refresh-delete-reject", ["created-event", "race", "relocation", "manual-refresh", "delete-rejection"]],
  ["dh-activation-race-source-close-refresh", ["activation", "race", "relocation", "native-close", "manual-refresh"]],
  ["dh-update-race-focus-session-refresh", ["updated-event", "race", "relocation", "focus", "session", "manual-refresh"]],
  ["dh-restore-delete-stale-created-refresh", ["restore", "delayed-event", "stale-event", "manual-refresh", "tombstone"]],
  ["dh-restore-delete-stale-updated-session", ["restore", "delayed-event", "session", "stale-event", "tombstone"]],
  ["dh-nested-opener-delete-reject", ["opener", "nested-window", "delete-rejection", "stale-event", "tombstone"]],
  ["dh-nested-opener-native-close-refresh", ["opener", "nested-window", "native-close", "manual-refresh", "stale-event"]],
  ["dh-command-focus-relocated-refresh-stale", ["focus", "relocation", "manual-refresh", "stale-event"]],
  ["dh-outliner-close-destination-refresh-stale", ["outliner-close", "relocation", "manual-refresh", "stale-event", "tombstone"]],
  ["dh-outliner-close-tab-refresh-stale", ["outliner-close", "relocation", "manual-refresh", "stale-event", "tombstone"]],
  ["dh-source-sibling-close-refresh-stale", ["outliner-close", "relocation", "manual-refresh", "stale-event"]],
  ["dh-manual-stale-query-after-relocation", ["manual-refresh", "stale-query", "relocation", "stale-event"]],
  ["dh-manual-stale-query-after-source-close", ["manual-refresh", "stale-query", "native-close", "relocation", "tombstone"]],
  ["dh-history-manual-stale-query", ["undo-redo", "manual-refresh", "stale-query", "relocation"]],
  ["dh-delete-reject-manual-stale-query", ["delete-rejection", "manual-refresh", "stale-query", "relocation", "tombstone"]],
  ["dh-outliner-close-manual-stale-query", ["outliner-close", "manual-refresh", "stale-query", "relocation", "tombstone"]],
  ["dh-repeated-relocation-manual-stale-query", ["manual-refresh", "stale-query", "relocation", "paired-echo"]],
  ["dh-restore-delete-manual-stale-query", ["restore", "delayed-event", "manual-refresh", "stale-query", "tombstone"]],
  ["dh-session-only-close-manual-stale-query", ["session", "manual-refresh", "stale-query", "relocation", "tombstone"]],
  ["dh-destination-close-manual-stale-query", ["native-close", "manual-refresh", "stale-query", "relocation", "tombstone"]],
  ["dh-focus-override-manual-stale-query", ["focus", "activation", "manual-refresh", "stale-query", "relocation"]],
  ["dh-opener-source-close-manual-stale-query", ["opener", "native-close", "manual-refresh", "stale-query", "relocation"]],
  ["dh-group-source-close-manual-stale-query", ["nested-window", "native-close", "manual-refresh", "stale-query", "relocation"]],
  ["dh-top-level-source-close-manual-stale-query", ["native-close", "manual-refresh", "stale-query", "relocation"]],
  ["dh-created-race-source-close-manual-stale-query", ["created-event", "race", "native-close", "manual-refresh", "stale-query", "relocation"]],
  ["dh-activation-race-source-close-manual-stale-query", ["activation", "race", "native-close", "manual-refresh", "stale-query", "relocation"]],
  ["dh-outliner-source-close-manual-stale-query", ["outliner-close", "manual-refresh", "stale-query", "relocation", "tombstone"]],
  ["dh-delete-reject-source-window-manual-stale-query", ["delete-rejection", "manual-refresh", "stale-query", "relocation", "tombstone"]],
  ["dh-outliner-source-tab-close-manual-stale-query", ["outliner-close", "manual-refresh", "stale-query", "relocation"]],
  ["dh-relocated-tab-missing-manual-query", ["manual-refresh", "partial-snapshot", "relocation"]],
  ["dh-fresh-relocated-tab-missing-manual-query", ["manual-refresh", "partial-snapshot", "relocation", "fresh-event"]],
  ["dh-opener-child-missing-manual-query", ["manual-refresh", "partial-snapshot", "opener", "relocation"]],
  ["dh-current-session-refresh-after-relocation", ["session", "manual-refresh", "relocation", "fresh-event"]],
  ["dh-opener-current-refresh-after-relocation", ["opener", "manual-refresh", "relocation", "fresh-event"]],
  ["dh-focus-current-refresh-after-relocation", ["focus", "activation", "manual-refresh", "relocation", "fresh-event"]],
  ["dh-race-current-refresh-after-relocation", ["created-event", "race", "manual-refresh", "relocation", "fresh-event"]],
  ["dh-repeated-current-refresh-after-relocation", ["paired-echo", "manual-refresh", "relocation", "fresh-event"]],
  ["dh-restore-current-refresh-after-delete", ["restore", "delayed-event", "session", "manual-refresh"]],
  ["dh-delete-reject-current-refresh", ["delete-rejection", "session", "manual-refresh", "tombstone"]],
  ["dh-outliner-close-current-refresh", ["outliner-close", "session", "manual-refresh", "tombstone"]],
  ["dh-native-close-current-refresh", ["native-close", "session", "manual-refresh", "tombstone"]],
  ["dh-destination-window-current-refresh", ["native-close", "session", "manual-refresh", "relocation", "tombstone"]],
  ["dh-source-sibling-current-refresh", ["outliner-close", "session", "manual-refresh", "relocation"]],
  ["dh-active-destination-current-refresh", ["activation", "manual-refresh", "relocation", "fresh-event"]],
  ["dh-active-source-current-refresh", ["activation", "manual-refresh", "relocation", "fresh-event"]],
  ["dh-opener-active-current-refresh", ["opener", "activation", "manual-refresh", "relocation", "fresh-event"]],
  ["dh-race-active-current-refresh", ["activation", "race", "manual-refresh", "relocation", "fresh-event"]],
  ["dh-repeated-active-current-refresh", ["activation", "paired-echo", "manual-refresh", "relocation", "fresh-event"]]
]);
const hasExplicitTraceIds = typeof process.env.RUNTIME_TRACE_HUNT_TRACE_IDS === "string" &&
  process.env.RUNTIME_TRACE_HUNT_TRACE_IDS.trim() !== "";

const traceIds = selectedTraceIds();
if (traceIds.length === 0) {
  throw new Error("RUNTIME_TRACE_HUNT_TRACE_IDS selected no traces");
}
const bugLog = loadBugLog(BUG_FILE);

ensureBugLogFile(BUG_FILE);

console.log(`Runtime trace hunt writing findings to ${BUG_FILE}`);
console.log(`This corpus run is capped at ${CORPUS_RUN_CAP_MS}ms.`);
console.log(`Agent stop rule: stop after ${STOP_AFTER_CLEAN} full 5-minute discovery mutation block(s) with no new distinct findings.`);
console.log(`Trace strategy: run the selected domain corpus once, recording every distinct failure; Codex/humans mutate discovery trace actions between runs.`);
console.log(`Trace profile: ${TRACE_HUNT_PROFILE}${hasExplicitTraceIds ? " (explicit trace IDs override profile)" : ""}`);
console.log(`Trace count: ${traceIds.length}`);
console.log(`Coverage tags: ${coverageTags(traceIds).join(", ") || "unknown"}`);
if (hasExplicitTraceIds || process.env.RUNTIME_TRACE_HUNT_SHOW_TRACE_IDS === "1") {
  console.log(`Trace IDs: ${traceIds.join(", ")}`);
}

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
  profile: TRACE_HUNT_PROFILE,
  coverageTags: coverageTags(traceIds),
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
      RUNTIME_TRACE_HUNT_PROFILE: TRACE_HUNT_PROFILE,
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
- Agent stop condition: 3 full 5-minute discovery mutation blocks with no new distinct findings
- Trace selection: default profile is \`discovery\`; use \`RUNTIME_TRACE_HUNT_PROFILE=regression|all\` for known repro replay, or \`RUNTIME_TRACE_HUNT_TRACE_IDS=...\` for explicit traces
- Corpus semantics: execute the selected explicit domain trace corpus once, recording every distinct failure; Codex/humans mutate discovery trace actions between runs, not seeds
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
    if (TRACE_HUNT_PROFILE === "discovery") {
      return DISCOVERY_TRACE_IDS;
    }
    if (TRACE_HUNT_PROFILE === "regression") {
      return REGRESSION_TRACE_IDS;
    }
    return ALL_TRACE_IDS;
  }
  return rawTraceIds
    .split(",")
    .map((traceId) => traceId.trim())
    .filter(Boolean);
}

function traceHuntProfile() {
  const profile = process.env.RUNTIME_TRACE_HUNT_PROFILE ?? "discovery";
  if (profile === "discovery" || profile === "regression" || profile === "all") {
    return profile;
  }
  throw new Error(`RUNTIME_TRACE_HUNT_PROFILE must be discovery, regression, or all; got ${JSON.stringify(profile)}`);
}

function coverageTags(traceIds) {
  return [...new Set(traceIds.flatMap((traceId) => TRACE_TAGS.get(traceId) ?? ["unknown"]))]
    .sort();
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
