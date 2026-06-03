import { describe, expect, it } from "vitest";

import {
  AUTORESEARCH_ACCEPTANCE_TSV_HEADER,
  acceptAutoresearchCandidate,
  correctnessCommandsForLanes,
  formatAcceptanceTsvRow,
  parseAcceptanceArgs,
  parseProfileJson
} from "../../scripts/autoresearch-accept.mjs";

describe("autoresearch acceptance guard", () => {
  it("parses lanes and the profile command after --", () => {
    expect(parseAcceptanceArgs([
      "--lanes",
      "runtime,projection",
      "--tag",
      "20260603-test",
      "--description",
      "candidate",
      "--append-results",
      "--",
      "pnpm",
      "profile:background-reconciliation",
      "--",
      "--runs",
      "5"
    ])).toMatchObject({
      lanes: ["runtime", "projection"],
      tag: "20260603-test",
      description: "candidate",
      appendResults: true,
      profileCommand: ["pnpm", "profile:background-reconciliation", "--", "--runs", "5"]
    });
  });

  it("selects lane correctness commands in runbook order", () => {
    expect(correctnessCommandsForLanes(["runtime", "storage"]).map((command) => command.label)).toEqual([
      "runtime oracle build",
      "runtime vitest corpus",
      "runtime build",
      "runtime regression trace hunt",
      "storage vitest corpus",
      "storage first paint"
    ]);
  });

  it("parses noisy profiler JSON output", () => {
    const profile = parseProfileJson(`preface\n${JSON.stringify({ summary: { status: "keep" } })}\nepilogue`);
    expect(profile).toEqual({ summary: { status: "keep" } });
  });

  it("keeps a perf candidate only after correctness lanes pass", async () => {
    const commands: string[] = [];
    const accepted = await acceptAutoresearchCandidate({
      lanes: ["runtime"],
      tag: "20260603-test",
      description: "candidate",
      profileCommand: ["pnpm", "profile:fake"],
      appendResults: false,
      resultsPath: "/unused/results.tsv"
    }, async (command) => {
      commands.push(command.label);
      if (command.label === "profile") {
        return { stdout: JSON.stringify({ summary: { status: "keep" } }), stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    expect(accepted.summary).toMatchObject({
      perfStatus: "candidate-keep",
      correctnessStatus: "pass",
      finalStatus: "keep"
    });
    expect(commands).toEqual([
      "profile",
      "runtime oracle build",
      "runtime vitest corpus",
      "runtime build",
      "runtime regression trace hunt"
    ]);
  });

  it("discards a perf keep when correctness fails", async () => {
    const accepted = await acceptAutoresearchCandidate({
      lanes: ["projection"],
      tag: "20260603-test",
      description: "candidate",
      profileCommand: ["pnpm", "profile:fake"],
      appendResults: false,
      resultsPath: "/unused/results.tsv"
    }, async (command) => {
      if (command.label === "profile") {
        return { stdout: JSON.stringify({ summary: { status: "keep" } }), stderr: "", exitCode: 0 };
      }
      return command.label === "projection hunt"
        ? { stdout: "", stderr: "projection failed", exitCode: 1 }
        : { stdout: "", stderr: "", exitCode: 0 };
    });

    expect(accepted.summary).toMatchObject({
      perfStatus: "candidate-keep",
      correctnessStatus: "fail",
      finalStatus: "discard-correctness"
    });
    expect(accepted.summary.correctnessFailures).toEqual(["projection hunt failed with exit code 1"]);
  });

  it("records acceptance decisions as TSV", () => {
    const row = formatAcceptanceTsvRow({
      timestamp: "2026-06-03T12:00:00.000Z",
      tag: "20260603-test",
      commit: "abcdef0",
      profileCommand: "pnpm profile:fake",
      perfStatus: "candidate-keep",
      correctnessStatus: "pass",
      correctnessLanes: ["runtime", "projection"],
      correctnessCommands: ["pnpm test", "pnpm run build"],
      finalStatus: "keep",
      description: "candidate"
    });

    expect(AUTORESEARCH_ACCEPTANCE_TSV_HEADER).toContain("correctness_status");
    expect(row).toContain("\tcandidate-keep\tpass\truntime,projection\t");
    expect(row.endsWith("\tkeep\tcandidate")).toBe(true);
  });
});
