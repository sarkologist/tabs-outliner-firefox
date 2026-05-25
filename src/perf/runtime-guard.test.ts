import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  evaluateProfileResult,
  parseProfileJson,
  selectScenarios
} from "../../scripts/perf-runtime-guard.mjs";
import {
  analyzePerformanceProfileExport,
  formatProfileExportAnalysis
} from "../../scripts/profile-export-analysis.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("runtime perf guard", () => {
  it("parses JSON profile output after pnpm command noise", () => {
    expect(parseProfileJson("> profile\n{\"totalMeasuredMs\":12,\"saves\":1}\n")).toEqual({
      totalMeasuredMs: 12,
      saves: 1
    });
  });

  it("selects scenarios by id or trace-hunt tags", () => {
    const config = {
      scenarios: [
        { id: "close", tags: ["close", "journal"] },
        { id: "focus", tags: ["focus"] }
      ]
    };

    expect(selectScenarios(config, { tags: "journal" }).map((scenario) => scenario.id)).toEqual(["close"]);
    expect(selectScenarios(config, { scenarios: "focus" }).map((scenario) => scenario.id)).toEqual(["focus"]);
  });

  it("fails hard counters and allows timing tolerance", () => {
    const scenario = {
      id: "close",
      budget: {
        totalMeasuredMs: 100,
        saves: 1,
        projectionMs: 0
      }
    };

    const pass = evaluateProfileResult(scenario, {
      totalMeasuredMs: 114,
      saves: 1,
      projectionMs: 0
    });
    const fail = evaluateProfileResult(scenario, {
      totalMeasuredMs: 116,
      saves: 2,
      projectionMs: 0
    });

    expect(pass.passed).toBe(true);
    expect(fail.passed).toBe(false);
    expect(fail.failures.map((failure) => failure.metric)).toEqual(["totalMeasuredMs", "saves"]);
  });

  it("runs a smoke guard against a fixture command", () => {
    const budget = path.join(repoRoot, "src/perf/fixtures/runtime-perf-budget-smoke.json");
    const result = spawnSync("node", ["scripts/perf-runtime-guard.mjs", "--budget", budget, "--json"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({
      passed: true,
      scenarioCount: 1
    });
  });
});

describe("profile export analysis", () => {
  it("summarizes browser profile exports and flags known sluggishness shapes", () => {
    const fixturePath = path.join(repoRoot, "src/perf/fixtures/profile-export-small.json");
    const profile = JSON.parse(readFileSync(fixturePath, "utf8"));
    const analysis = analyzePerformanceProfileExport(profile, {
      thresholds: {
        repeatedInitialSnapshotCount: 1,
        slowSaveMs: 150,
        slowEventMs: 100,
        diagnosticsDeferredTotalMs: 1000
      }
    });

    expect(analysis.repeatedInitialSnapshotRequests).toBe(2);
    expect(analysis.saveSummary).toMatchObject({
      count: 1,
      maxMs: 220
    });
    expect(analysis.warnings.map((warning) => warning.kind)).toEqual([
      "repeated-initial-snapshot",
      "slow-save",
      "slow-runtime-event",
      "diagnostics-defer-churn"
    ]);
    expect(formatProfileExportAnalysis(analysis)).toContain("Initial snapshot requests: 2");
  });
});
