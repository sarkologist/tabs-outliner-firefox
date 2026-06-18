#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";

const files = [
  "src/background/controller.test.ts",
  "src/sidebar/active-scroll.test.ts",
  "src/sidebar/visible-tree.test.ts",
  "src/background/history.test.ts",
  "src/model/outline.test.ts",
  "src/background/storage-legacy.test.ts",
  // Storage-fault lane (W-4.2): generated mutate/journal/compact/fail/crash/restart runs
  // against the fault-injecting storage mock; every restart must reproduce the model.
  "src/background/storage-v4.test.ts"
];

// Fail loudly if a listed lane no longer exists. Vitest treats a stale path as a
// filter that matches nothing, so a rename would otherwise silently drop a lane.
const missingFiles = files.filter((file) => !existsSync(new URL(`../${file}`, import.meta.url)));
if (missingFiles.length > 0) {
  console.error(`Generated trace soak: listed file(s) not found:\n  ${missingFiles.join("\n  ")}`);
  console.error(
    "Update the `files` list in scripts/run-generated-soak.mjs after a rename or move."
  );
  process.exit(1);
}

const baseSeed =
  positiveIntegerEnv("SOAK_SEED") ??
  positiveIntegerEnv("GENERATED_TRACE_BASE_SEED") ??
  randomInt(1, 0x7fffffff);
const seedCount =
  positiveIntegerEnv("SOAK_SEED_COUNT") ?? positiveIntegerEnv("GENERATED_TRACE_SEED_COUNT");
const steps = positiveIntegerEnv("SOAK_STEPS") ?? positiveIntegerEnv("GENERATED_TRACE_STEPS");
const oracleMode = process.env.GENERATED_TRACE_ORACLE_MODE ?? "gated";
const oracleReport = process.env.GENERATED_TRACE_ORACLE_REPORT;

const replayParts = [`SOAK_SEED=${baseSeed}`];
if (seedCount) {
  replayParts.push(`SOAK_SEED_COUNT=${seedCount}`);
}
if (steps) {
  replayParts.push(`SOAK_STEPS=${steps}`);
}
if (oracleMode !== "gated") {
  replayParts.push(`GENERATED_TRACE_ORACLE_MODE=${oracleMode}`);
}
if (oracleReport) {
  replayParts.push(`GENERATED_TRACE_ORACLE_REPORT=${oracleReport}`);
}
replayParts.push("pnpm test:soak");
console.log(`Generated trace soak seed: ${baseSeed}`);
console.log(`Generated trace soak seed count: ${seedCount ?? "per-test defaults"}`);
console.log(`Generated trace soak steps/cycles: ${steps ?? "per-test defaults"}`);
console.log(`Generated trace oracle mode: ${oracleMode}`);
console.log(`Generated trace oracle report: ${oracleReport ?? "disabled"}`);
console.log(`Replay with: ${replayParts.join(" ")}`);

const generatedTraceEnv = {
  GENERATED_TRACE_SOAK: "1",
  GENERATED_TRACE_BASE_SEED: String(baseSeed)
};
const oracleEntryPoint = new URL(
  "../oracle/purescript/output/TabsOutliner.Oracle/index.js",
  import.meta.url
);
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

if (seedCount) {
  generatedTraceEnv.GENERATED_TRACE_SEED_COUNT = String(seedCount);
}
if (steps) {
  generatedTraceEnv.GENERATED_TRACE_STEPS = String(steps);
}

if (!existsSync(oracleEntryPoint)) {
  console.log("PureScript oracle output missing; running pnpm run oracle:build");
  const oracleBuildExitCode = await runPnpm(["run", "oracle:build"], "PureScript oracle build");
  if (oracleBuildExitCode !== 0) {
    process.exit(oracleBuildExitCode);
  }
}

const vitestExitCode = await runPnpm(["exec", "vitest", "run", ...files], {
  env: {
    ...process.env,
    ...generatedTraceEnv
  }
});

process.exit(vitestExitCode);

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

function runPnpm(args, optionsOrLabel = {}) {
  const options = typeof optionsOrLabel === "string" ? {} : optionsOrLabel;
  const label = typeof optionsOrLabel === "string" ? optionsOrLabel : "Generated trace soak";

  return new Promise((resolve) => {
    const child = spawn(pnpmCommand, args, {
      ...options,
      stdio: "inherit"
    });

    child.on("error", (error) => {
      console.error(`${label} failed to start: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        console.error(`${label} interrupted by ${signal}`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}
