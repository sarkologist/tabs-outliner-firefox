#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";

const files = [
  "src/background/controller.test.ts",
  "src/sidebar/active-scroll.test.ts",
  "src/sidebar/visible-tree.test.ts",
  "src/background/history.test.ts",
  "src/model/outline.test.ts",
  "src/background/storage-v2.test.ts"
];

const baseSeed = positiveIntegerEnv("SOAK_SEED")
  ?? positiveIntegerEnv("GENERATED_TRACE_BASE_SEED")
  ?? randomInt(1, 0x7fffffff);
const seedCount = positiveIntegerEnv("SOAK_SEED_COUNT")
  ?? positiveIntegerEnv("GENERATED_TRACE_SEED_COUNT");
const steps = positiveIntegerEnv("SOAK_STEPS")
  ?? positiveIntegerEnv("GENERATED_TRACE_STEPS");

const replayParts = [`SOAK_SEED=${baseSeed}`];
if (seedCount) {
  replayParts.push(`SOAK_SEED_COUNT=${seedCount}`);
}
if (steps) {
  replayParts.push(`SOAK_STEPS=${steps}`);
}
replayParts.push("pnpm test:soak");
console.log(`Generated trace soak seed: ${baseSeed}`);
console.log(`Generated trace soak seed count: ${seedCount ?? "per-test defaults"}`);
console.log(`Generated trace soak steps/cycles: ${steps ?? "per-test defaults"}`);
console.log(`Replay with: ${replayParts.join(" ")}`);

const generatedTraceEnv = {
  GENERATED_TRACE_SOAK: "1",
  GENERATED_TRACE_BASE_SEED: String(baseSeed)
};
if (seedCount) {
  generatedTraceEnv.GENERATED_TRACE_SEED_COUNT = String(seedCount);
}
if (steps) {
  generatedTraceEnv.GENERATED_TRACE_STEPS = String(steps);
}

const child = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", [
  "exec",
  "vitest",
  "run",
  ...files
], {
  env: {
    ...process.env,
    ...generatedTraceEnv
  },
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Generated trace soak interrupted by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

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
