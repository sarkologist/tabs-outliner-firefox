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
      startupInitial(620),
      startupInitial(580),
      startupInitial(600),
      startupWarm(37),
      startupWarm(39),
      startupWarm(38),
      startupStored(616),
      startupStored(600),
      startupStored(640)
    ], { baselinePrimaryMedianMs: 650 });

    expect(summary.primaryMedianMs).toBe(600);
    expect(summary.hydrationMedianMs).toBe(598);
    expect(summary.requiredImprovementMs).toBe(50);
    expect(summary.improvementMs).toBe(50);
    expect(summary.status).toBe("keep");
    expect(summary.guardFailures).toEqual([]);
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

  it("formats a stable TSV row", () => {
    const summary = summarizeSidebarStartupProfile([
      startupInitial(600),
      startupWarm(38),
      startupStored(610)
    ], { baselinePrimaryMedianMs: 650 });

    expect(SIDEBAR_STARTUP_RESULTS_TSV_HEADER).toBe(
      "timestamp\ttag\tcommit\ttab_nodes\tlive_tabs\truns\tprimary_median_ms\thydration_median_ms\tstored_startup_median_ms\twarm_snapshot_median_ms\tsnapshot_rows\tsnapshot_nodes\tsaves\tbroadcasts\tevent_count\tstatus\tdescription"
    );
    expect(formatSidebarStartupTsvRow(summary, {
      timestamp: "2026-05-22T13:00:00.000Z",
      tag: "may22",
      commit: "abcdef1",
      description: "baseline\twith newline\ntrimmed"
    })).toBe(
      "2026-05-22T13:00:00.000Z\tmay22\tabcdef1\t50000\t50\t1\t600\t598\t610\t38\t256\t256\t0\t0\t0\tkeep\tbaseline with newline trimmed"
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
    totalMs: 2,
    hydrateMs: totalWithHydrationMs - 2,
    totalWithHydrationMs,
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
    totalMs,
    saves: 0,
    broadcasts: 0,
    eventCount: 0,
    ...overrides
  };
}
