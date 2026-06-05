import { describe, expect, it } from "vitest";

import {
  BACKGROUND_RECONCILIATION_RESULTS_TSV_HEADER,
  analyzeBackgroundProfileExport,
  formatBackgroundReconciliationTsvRow,
  parseCommandProfileJson,
  summarizeBackgroundReconciliationRuns
} from "../../scripts/profile-background-reconciliation.mjs";

const tabs = 50_000;

describe("background reconciliation autoresearch profile", () => {
  it("parses noisy profile:command JSON output", () => {
    const profile = parseCommandProfileJson([
      "command preface",
      JSON.stringify(profileFor("move-leaf", { totalWithSaveFlushMs: 123 }), null, 2),
      "command epilogue"
    ].join("\n"));

    expect(profile).toMatchObject({
      scenario: "move-leaf",
      totalWithSaveFlushMs: 123,
      ack: { stateChanged: true }
    });
  });

  it("summarizes the worst scenario as the primary baseline score", () => {
    const summary = summarizeBackgroundReconciliationRuns([
      result(1, "move-leaf", { totalWithSaveFlushMs: 200 }),
      result(2, "move-leaf", { totalWithSaveFlushMs: 220 }),
      result(1, "group-live-leaf", { totalWithSaveFlushMs: 300 }),
      result(2, "group-live-leaf", { totalWithSaveFlushMs: 320 }),
      result(1, "move-top-level-live-leaf", { totalWithSaveFlushMs: 500 }),
      result(2, "move-top-level-live-leaf", { totalWithSaveFlushMs: 520 })
    ], { runs: 2, tabs });

    expect(summary).toMatchObject({
      runs: 2,
      tabs,
      primaryScenario: "move-top-level-live-leaf",
      primaryMedianMs: 510,
      primaryMaxMs: 520,
      saveFlushMaxMs: 80,
      eventEchoMaxMs: 10,
      runtimeGetWindowsCountMax: 1,
      runtimeGetWindowsMaxMs: 12,
      status: "candidate-keep",
      guardFailures: []
    });
  });

  it("requires the configured primary-median improvement", () => {
    const keep = summarizeBackgroundReconciliationRuns(candidateResults(), {
      runs: 2,
      tabs,
      baselineMs: 570
    });
    const discard = summarizeBackgroundReconciliationRuns(candidateResults(), {
      runs: 2,
      tabs,
      baselineMs: 550
    });

    expect(keep.status).toBe("candidate-keep");
    expect(keep.requiredImprovementMs).toBe(50);
    expect(discard.status).toBe("discard");
    expect(discard.guardFailures).toContain("primary median must improve by at least 50ms from baseline");
  });

  it("compares scenario guard metrics against a baseline summary", () => {
    const baselineSummary = summarizeBackgroundReconciliationRuns(candidateResults(), { runs: 2, tabs });
    const current = summarizeBackgroundReconciliationRuns([
      result(1, "move-leaf", {
        totalWithSaveFlushMs: 200,
        saveFlushMs: 81,
        storageSetCalls: 2,
        stateSaves: 2,
        eventEchoMs: 36,
        traceSummary: traceSummary({ runtimeGetWindowsCount: 2, runtimeGetWindowsMaxMs: 13 })
      }),
      result(1, "group-live-leaf", { totalWithSaveFlushMs: 300 }),
      result(1, "move-top-level-live-leaf", { totalWithSaveFlushMs: 500 })
    ], {
      runs: 1,
      tabs,
      baselineSummary
    });

    expect(current.status).toBe("discard");
    expect(current.guardFailures).toContain("move-leaf saveFlushMs must not increase versus baseline");
    expect(current.guardFailures).toContain("move-leaf storageSetCalls must not increase versus baseline");
    expect(current.guardFailures).toContain("move-leaf stateSaves must not increase versus baseline");
    expect(current.guardFailures).toContain("move-leaf eventEchoMs must stay within 25ms of baseline");
    expect(current.guardFailures).toContain("move-leaf runtime.getWindows count must not increase versus baseline");
    expect(current.guardFailures).toContain("move-leaf runtime.getWindows max must not increase versus baseline");
  });

  it("fails missing profiles and structural-command guard regressions", () => {
    const missing = summarizeBackgroundReconciliationRuns([
      { run: 1, scenario: "move-leaf", commandFailed: true }
    ], { runs: 1, tabs, scenarios: ["move-leaf"] });
    const badMove = summarizeBackgroundReconciliationRuns([
      result(1, "move-leaf", {
        ack: { type: "commandAck", stateChanged: false },
        nodes: tabs + 2,
        rootShape: { rootCount: 2, missingRootCount: 0, liveWindowRootCount: 1, tabRootCount: 0, groupRootCount: 0 },
        fullStateBroadcasts: 1,
        sameParentReorderBroadcasts: 0,
        projectionMs: 2,
        treePatchMs: 3
      })
    ], { runs: 1, tabs, scenarios: ["move-leaf"] });

    expect(missing.guardFailures).toContain("move-leaf must produce 1 profile outputs");
    expect(badMove.guardFailures).toEqual([
      "move-leaf must acknowledge a state-changing command",
      "move-leaf must preserve the expected node count",
      "move-leaf must preserve the expected root shape",
      "move-leaf must not broadcast full stateUpdated messages",
      "move-leaf must preserve sameParentReorderUpdated broadcasts",
      "move-leaf must not rebuild the synthetic sidebar projection",
      "move-leaf must not spend synthetic tree patch time"
    ]);
  });

  it("guards command relocation echo absorption metrics", () => {
    const summary = summarizeBackgroundReconciliationRuns([
      result(1, "command-relocation-echo", {
        eventEchoMs: 26,
        storageSetCalls: 3,
        stateSaves: 2,
        traceSummary: traceSummary({ runtimeGetWindowsCount: 1, runtimeGetWindowsMaxMs: 12 })
      })
    ], { runs: 1, tabs, scenarios: ["command-relocation-echo"] });

    expect(summary.guardFailures).toContain("command-relocation-echo must absorb native echoes without runtime.getWindows");
    expect(summary.guardFailures).toContain("command-relocation-echo must not add a second state save for native echoes");
    expect(summary.guardFailures).toContain("command-relocation-echo must not add storage writes for native echoes");
    expect(summary.guardFailures).toContain("command-relocation-echo native echo flush must stay below 25ms");
  });

  it("guards structural save pressure latency metrics", () => {
    const summary = summarizeBackgroundReconciliationRuns([
      result(1, "structural-save-pressure", {
        followUpCommandMs: 26,
        stateSaveStartedBeforeAck: true,
        stateSaves: 2,
        fullStateBroadcasts: 1,
        traceSummary: traceSummary({ runtimeGetWindowsCount: 1, runtimeGetWindowsMaxMs: 12 })
      })
    ], { runs: 1, tabs, scenarios: ["structural-save-pressure"] });

    expect(summary.guardFailures).toContain("structural-save-pressure must not start V3 state saves before command ack");
    expect(summary.guardFailures).toContain("structural-save-pressure follow-up command must not wait for deferred state save");
    expect(summary.guardFailures).toContain("structural-save-pressure must not add runtime.getWindows");
    expect(summary.guardFailures).toContain("structural-save-pressure must coalesce to one eventual state save");
    expect(summary.guardFailures).toContain("structural-save-pressure must not broadcast full stateUpdated messages");
  });

  it("formats TSV rows for ignored autoresearch results", () => {
    const summary = summarizeBackgroundReconciliationRuns(candidateResults(), {
      runs: 2,
      tabs,
      baselineMs: 570
    });
    const row = formatBackgroundReconciliationTsvRow(summary, {
      timestamp: "2026-06-02T12:00:00.000Z",
      tag: "20260602-background-reconcile",
      commit: "abcdef0",
      baselineMs: 570,
      description: "fixture"
    });

    expect(BACKGROUND_RECONCILIATION_RESULTS_TSV_HEADER).toContain("primary_median_ms");
    expect(row).toContain("20260602-background-reconcile");
    expect(row).toContain("\t570\t50\t520\tmove-top-level-live-leaf\t510\t520\t210\t310\t510\t80\t10\t1\t12\tcandidate-keep\tfixture");
  });

  it("summarizes exported tabsOutlinerProfile background bottlenecks", () => {
    const analysis = analyzeBackgroundProfileExport({
      exportedAt: "2026-06-02T10:00:00.000Z",
      snapshot: {
        background: {
          entries: [
            { name: "background.state.save", durationMs: 12 },
            { name: "background.mutation.run", durationMs: 30, detail: { reason: "refreshFromRuntime" } },
            { name: "background.runtime.getWindows", durationMs: 20 },
            { name: "background.event.tabs.onUpdated", durationMs: 10 },
            { name: "background.mutation.run", durationMs: 5, detail: { reason: "command" } }
          ]
        },
        sidebars: [
          {
            label: "sidebar-a",
            snapshot: {
              entries: [
                { name: "sidebar.patch.treeStructure", durationMs: 25 },
                { name: "sidebar.render", durationMs: 40 },
                { name: "sidebar.projection.build", durationMs: 50 },
                { name: "sidebar.diagnostics.defer", durationMs: 1000 }
              ]
            }
          }
        ]
      }
    });

    expect(analysis.backgroundStateSave).toMatchObject({ count: 1, totalMs: 12, maxMs: 12 });
    expect(analysis.refreshFromRuntime).toMatchObject({ count: 1, totalMs: 30, maxMs: 30 });
    expect(analysis.runtimeGetWindows).toMatchObject({ count: 1, totalMs: 20, maxMs: 20 });
    expect(analysis.runtimeEvents).toMatchObject({ count: 1, totalMs: 10, maxMs: 10 });
    expect(analysis.sidebarTreeStructure).toMatchObject({ count: 1, totalMs: 25, maxMs: 25 });
    expect(analysis.sidebarRender).toMatchObject({ count: 1, totalMs: 40, maxMs: 40 });
    expect(analysis.sidebarProjectionBuild).toMatchObject({ count: 1, totalMs: 50, maxMs: 50 });
    expect(analysis.diagnosticsDefer).toMatchObject({ count: 1, totalMs: 1000, maxMs: 1000 });
    expect(analysis.topTotals[0]).toMatchObject({ name: "sidebar.diagnostics.defer", totalMs: 1000 });
  });
});

function candidateResults() {
  return [
    result(1, "move-leaf", { totalWithSaveFlushMs: 200 }),
    result(2, "move-leaf", { totalWithSaveFlushMs: 220 }),
    result(1, "group-live-leaf", { totalWithSaveFlushMs: 300 }),
    result(2, "group-live-leaf", { totalWithSaveFlushMs: 320 }),
    result(1, "move-top-level-live-leaf", { totalWithSaveFlushMs: 500 }),
    result(2, "move-top-level-live-leaf", { totalWithSaveFlushMs: 520 })
  ];
}

function result(run: number, scenario: string, overrides = {}) {
  return {
    run,
    scenario,
    profile: profileFor(scenario, overrides)
  };
}

function profileFor(scenario: string, overrides: Record<string, unknown> = {}) {
  return {
    scenario,
    tabs,
    commandMs: 120,
    eventEchoMs: 10,
    saveFlushMs: 80,
    totalWithSaveFlushMs: 200,
    firstBroadcastMs: 40,
    storageSetCalls: 1,
    stateSaves: 1,
    fullStateBroadcasts: 0,
    sameParentReorderBroadcasts: scenario === "move-leaf" ? 1 : 0,
    treeStructureBroadcasts: scenario === "move-leaf" ? 0 : 1,
    projectionMs: 0,
    treePatchMs: scenario === "move-leaf" ? 0 : 5,
    ack: { type: "commandAck", stateChanged: true },
    nodes: scenario === "move-leaf" ? tabs + 1 : tabs + 2,
    rootShape: rootShapeFor(scenario),
    traceSummary: traceSummary(),
    ...overrides
  };
}

function rootShapeFor(scenario: string) {
  if (scenario === "move-leaf" || scenario === "group-live-leaf") {
    return {
      rootCount: 1,
      missingRootCount: 0,
      windowRootCount: 1,
      liveWindowRootCount: 1,
      tabRootCount: 0,
      groupRootCount: 0,
      childCounts: [tabs]
    };
  }
  return {
    rootCount: 2,
    missingRootCount: 0,
    windowRootCount: 2,
    liveWindowRootCount: 2,
    tabRootCount: 0,
    groupRootCount: 0,
    childCounts: [tabs - 1, 1]
  };
}

function traceSummary(options: {
  runtimeGetWindowsCount?: number;
  runtimeGetWindowsMaxMs?: number;
} = {}) {
  const runtimeGetWindowsCount = options.runtimeGetWindowsCount ?? 1;
  const runtimeGetWindowsMaxMs = options.runtimeGetWindowsMaxMs ?? 12;
  return {
    byName: {
      "background.runtime.getWindows": {
        name: "background.runtime.getWindows",
        count: runtimeGetWindowsCount,
        totalMs: runtimeGetWindowsMaxMs,
        avgMs: runtimeGetWindowsMaxMs / runtimeGetWindowsCount,
        maxMs: runtimeGetWindowsMaxMs
      },
      "background.state.save": {
        name: "background.state.save",
        count: 1,
        totalMs: 80,
        avgMs: 80,
        maxMs: 80
      },
      "background.event.tabs.onUpdated": {
        name: "background.event.tabs.onUpdated",
        count: 1,
        totalMs: 4,
        avgMs: 4,
        maxMs: 4
      }
    },
    runtimeMessageTypes: {},
    mutationRuns: {}
  };
}
