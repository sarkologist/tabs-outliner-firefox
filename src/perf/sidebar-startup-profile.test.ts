import {
  SIDEBAR_STARTUP_RESULTS_TSV_HEADER,
  formatSidebarStartupTsvRow,
  median,
  summarizeSidebarStartupProfile
} from "./sidebar-startup-profile.js";

describe("sidebar startup profile helpers", () => {
  it("calculates medians from sorted copies", () => {
    const values = [610, 580, 620];

    expect(median(values)).toBe(610);
    expect(values).toEqual([610, 580, 620]);
    expect(median([10, 20, 40, 80])).toBe(30);
  });

  it("summarizes startup medians and detects guard regressions", () => {
    const summary = summarizeSidebarStartupProfile([
      startupInitial(620, { phaseMs: { "v3.nodeShardRead": 20, "v3.nodeMaterialize": 80 } }),
      startupInitial(580, { phaseMs: { "v3.nodeShardRead": 10, "v3.nodeMaterialize": 60 } }),
      startupInitial(600, { phaseMs: { "v3.nodeShardRead": 15, "v3.nodeMaterialize": 70 } }),
      startupWarm(37),
      startupWarm(39),
      startupWarm(38),
      startupStored(616, { phaseMs: { "v3.nodeShardRead": 30, "v3.orderPageRead": 40 } }),
      startupStored(600, { phaseMs: { "v3.nodeShardRead": 20, "v3.orderPageRead": 30 } }),
      startupStored(640, { phaseMs: { "v3.nodeShardRead": 40, "v3.orderPageRead": 50 } })
    ], { baselinePrimaryMedianMs: 650 });

    expect(summary.primaryMedianMs).toBe(600);
    expect(summary.hydrationMedianMs).toBe(598);
    expect(summary.phaseMedianMs).toEqual({
      "v3.nodeMaterialize": 70,
      "v3.nodeShardRead": 20,
      "v3.orderPageRead": 40
    });
    expect(summary.shape).toBe("closed-heavy");
    expect(summary.primaryScenario).toBe("startup-initial-snapshot");
    expect(summary.totalNodes).toBe(50_001);
    expect(summary.parentsWithChildren).toBe(1);
    expect(summary.requiredImprovementMs).toBe(50);
    expect(summary.improvementMs).toBe(50);
    expect(summary.status).toBe("keep");
    expect(summary.guardFailures).toEqual([]);
    expect(summary.guardWarnings).toEqual([]);
    expect(summary.snapshotRows).toBe(256);
    expect(summary.snapshotNodes).toBe(256);
    expect(summary.liveTabs).toBe(50);

    const regressed = summarizeSidebarStartupProfile([
      startupInitial(600, { saves: 1, broadcasts: 1 }),
      startupWarm(38, { snapshotRows: 300, snapshotNodes: 300 }),
      startupStored(610, { eventCount: 2 })
    ], { baselinePrimaryMedianMs: 650 });

    expect(regressed.status).toBe("discard");
    expect(regressed.guardFailures).toEqual([
      "startup scenarios must not save during measurement",
      "startup scenarios must not emit broadcasts during measurement",
      "startup scenarios must not process runtime events during measurement",
      "initial snapshot rows must stay <= 256",
      "initial snapshot nodes must stay <= 256"
    ]);
  });

  it("treats the real-browser fanout scenario as diagnostic", () => {
    const summary = summarizeSidebarStartupProfile([
      startupRealBrowserFanout(3_200, {
        eventCount: 5,
        saves: 2,
        totalNodes: 26_495,
        parentsWithChildren: 7_062,
        initialSnapshotMedianMs: 180,
        initialSnapshotMaxMs: 260,
        getStateMedianMs: 2_300,
        getStateMaxMs: 2_800,
        projectionSliceMs: 3_900,
        startupEventTotalMs: 6_600,
        startupEventMaxMs: 6_100,
        saveFlushMs: 4_700,
        phaseMs: {
          "v3.nodeShardRead": 2_100,
          "v3.orderPageRead": 1_600
        }
      })
    ], { shape: "real-browser-20260526" });

    expect(summary.primaryScenario).toBe("startup-real-browser-fanout");
    expect(summary.primaryMedianMs).toBe(3_200);
    expect(summary.realMimicMedianMs).toBe(3_200);
    expect(summary.realMimicInitialSnapshotMedianMs).toBe(180);
    expect(summary.realMimicInitialSnapshotMaxMs).toBe(260);
    expect(summary.realMimicGetStateMedianMs).toBe(2_300);
    expect(summary.realMimicGetStateMaxMs).toBe(2_800);
    expect(summary.realMimicProjectionSliceMs).toBe(3_900);
    expect(summary.realMimicStartupEventTotalMs).toBe(6_600);
    expect(summary.realMimicStartupEventMaxMs).toBe(6_100);
    expect(summary.realMimicSaveFlushMs).toBe(4_700);
    expect(summary.guardFailures).toEqual([]);
    expect(summary.guardWarnings).toEqual([
      "startup real-browser fanout saved during diagnostic measurement"
    ]);
    expect(summary.status).toBe("keep");
  });

  it("formats a stable TSV row", () => {
    const summary = summarizeSidebarStartupProfile([
      startupInitial(600),
      startupWarm(38),
      startupStored(610)
    ], { baselinePrimaryMedianMs: 650 });

    expect(SIDEBAR_STARTUP_RESULTS_TSV_HEADER).toBe(
      "timestamp\ttag\tcommit\tshape\tprimary_scenario\ttab_nodes\tlive_tabs\ttotal_nodes\tparents_with_children\truns\tprimary_median_ms\thydration_median_ms\tstored_startup_median_ms\twarm_snapshot_median_ms\treal_mimic_median_ms\treal_mimic_initial_snapshot_median_ms\treal_mimic_initial_snapshot_max_ms\treal_mimic_get_state_median_ms\treal_mimic_get_state_max_ms\treal_mimic_projection_slice_ms\treal_mimic_startup_event_total_ms\treal_mimic_startup_event_max_ms\treal_mimic_save_flush_ms\tsnapshot_rows\tsnapshot_nodes\tsaves\tbroadcasts\tevent_count\tstatus\twarnings\tphase_median_json\tdescription"
    );
    expect(formatSidebarStartupTsvRow(summary, {
      timestamp: "2026-05-22T13:00:00.000Z",
      tag: "may22",
      commit: "abcdef1",
      description: "baseline\twith newline\ntrimmed"
    })).toBe(
      "2026-05-22T13:00:00.000Z\tmay22\tabcdef1\tclosed-heavy\tstartup-initial-snapshot\t50000\t50\t50001\t1\t1\t600\t598\t610\t38\t\t\t\t\t\t\t\t\t\t256\t256\t0\t0\t0\tkeep\t\t{\"v3.nodeMaterialize\":70,\"v3.nodeShardRead\":20,\"v3.orderPageRead\":40}\tbaseline with newline trimmed"
    );
  });
});

function startupInitial(
  totalWithHydrationMs: number,
  overrides: Partial<Parameters<typeof summarizeSidebarStartupProfile>[0][number]> = {}
) {
  return {
    scenario: "startup-initial-snapshot" as const,
    tabs: 50_000,
    liveTabs: 50,
    totalNodes: 50_001,
    parentsWithChildren: 1,
    totalMs: 2,
    hydrateMs: totalWithHydrationMs - 2,
    totalWithHydrationMs,
    phaseMs: {
      "v3.nodeShardRead": 20,
      "v3.nodeMaterialize": 70,
      "v3.orderPageRead": 40
    },
    snapshotRows: 256,
    snapshotNodes: 256,
    saves: 0,
    broadcasts: 0,
    eventCount: 0,
    ...overrides
  };
}

function startupWarm(totalMs: number, overrides: Partial<Parameters<typeof summarizeSidebarStartupProfile>[0][number]> = {}) {
  return {
    scenario: "startup-warm-initial-snapshot" as const,
    tabs: 50_000,
    liveTabs: 50,
    totalNodes: 50_001,
    parentsWithChildren: 1,
    totalMs,
    snapshotRows: 256,
    snapshotNodes: 256,
    saves: 0,
    broadcasts: 0,
    eventCount: 0,
    ...overrides
  };
}

function startupStored(totalMs: number, overrides: Partial<Parameters<typeof summarizeSidebarStartupProfile>[0][number]> = {}) {
  return {
    scenario: "startup-stored-unchanged" as const,
    tabs: 50_000,
    liveTabs: 50,
    totalNodes: 50_001,
    parentsWithChildren: 1,
    totalMs,
    saves: 0,
    broadcasts: 0,
    eventCount: 0,
    ...overrides
  };
}

function startupRealBrowserFanout(
  totalMs: number,
  overrides: Partial<Parameters<typeof summarizeSidebarStartupProfile>[0][number]> = {}
) {
  return {
    scenario: "startup-real-browser-fanout" as const,
    tabs: 19_433,
    liveTabs: 50,
    totalNodes: 26_495,
    parentsWithChildren: 7_062,
    totalMs,
    snapshotRows: 256,
    snapshotNodes: 256,
    saves: 0,
    broadcasts: 0,
    eventCount: 5,
    ...overrides
  };
}
