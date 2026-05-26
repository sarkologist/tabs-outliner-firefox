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
  analyzeStartupStorageFanoutProfileExport,
  formatProfileExportAnalysis,
  STARTUP_STORAGE_FANOUT_TSV_HEADER,
  startupStorageFanoutTsvRow
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

  it("extracts startup storage fanout metrics for autoresearch TSV rows", () => {
    const fixturePath = path.join(repoRoot, "src/perf/fixtures/profile-export-small.json");
    const profile = JSON.parse(readFileSync(fixturePath, "utf8"));
    const analysis = analyzeStartupStorageFanoutProfileExport(profile);

    expect(analysis.primaryMs).toBe(410);
    expect(analysis.backgroundStateLoad.maxMs).toBe(310);
    expect(analysis.nodeShardRead).toMatchObject({
      maxMs: 200,
      maxKeys: 256
    });
    expect(analysis.orderPageRead).toMatchObject({
      maxMs: 80,
      maxKeys: 7062
    });
    expect(analysis.sidebarHydration.maxMs).toBe(350);
    expect(analysis.backgroundGetState.maxMs).toBe(330);
    expect(analysis.projectionSlice.maxMs).toBe(410);
    expect(analysis.saveSummary.maxMs).toBe(220);

    const row = startupStorageFanoutTsvRow(analysis, {
      tag: "20260526-storage",
      timestamp: "2026-05-26T12:00:00.000Z",
      description: "fixture"
    });
    expect(STARTUP_STORAGE_FANOUT_TSV_HEADER).toContain("node_shard_read_max_ms");
    expect(row).toContain("20260526-storage");
    expect(row).toContain("\t410\t310\t200\t256\t80\t7062\t350\t350\t360\t330\t410\t220\t1\tfixture");
  });
});
