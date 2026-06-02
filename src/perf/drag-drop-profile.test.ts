import { describe, expect, it } from "vitest";

import {
  DRAG_DROP_RESULTS_TSV_HEADER,
  dragDropGuardFailures,
  formatDragDropTsvRow,
  parseProfileLines,
  summarizeDragDropRuns
} from "../../scripts/profile-drag-drop.mjs";

const goodProfiles = {
  "hover-guide-50k": {
    hoverGuide: { maxMs: 2.4 }
  },
  "hover-scroll-50k": {
    virtualRows: { maxMs: 8.1 }
  },
  "input-delay-profile": {
    summary: []
  },
  "drag-drop-50k": {
    p95Ms: 4.2
  },
  "drag-drop-50k-drop": {
    elapsedMs: 82.5,
    dragoverSetupMs: 30,
    dropDispatchToVisibleMs: 52.5,
    summary: [
      { name: "sidebar.patch.treeStructure", count: 1, totalMs: 3.1, avgMs: 3.1, maxMs: 3.1 },
      { name: "sidebar.virtualRows", count: 1, totalMs: 10.2, avgMs: 10.2, maxMs: 10.2 }
    ]
  }
};

describe("drag/drop autoresearch profile", () => {
  it("parses labeled Playwright console JSON", () => {
    const profiles = parseProfileLines([
      "noise before",
      `drag-drop-50k ${JSON.stringify(goodProfiles["drag-drop-50k"])}`,
      `drag-drop-50k-drop ${JSON.stringify(goodProfiles["drag-drop-50k-drop"])}`,
      `hover-guide-50k ${JSON.stringify(goodProfiles["hover-guide-50k"])}`,
      `hover-scroll-50k ${JSON.stringify(goodProfiles["hover-scroll-50k"])}`,
      `input-delay-profile ${JSON.stringify(goodProfiles["input-delay-profile"])}`
    ].join("\n"));

    expect(profiles["drag-drop-50k"]).toMatchObject({ p95Ms: 4.2 });
    expect(profiles["drag-drop-50k-drop"].summary).toHaveLength(2);
    expect(profiles["hover-guide-50k"].hoverGuide.maxMs).toBe(2.4);
  });

  it("summarizes primary latency and keeps a clean baseline run", () => {
    const summary = summarizeDragDropRuns([
      { run: 1, profiles: goodProfiles },
      {
        run: 2,
        profiles: {
          ...goodProfiles,
          "drag-drop-50k-drop": {
            ...goodProfiles["drag-drop-50k-drop"],
            elapsedMs: 107.5,
            dragoverSetupMs: 50,
            dropDispatchToVisibleMs: 57.5
          }
        }
      }
    ]);

    expect(summary).toMatchObject({
      runs: 2,
      dropMedianMs: 55,
      dropMaxMs: 57.5,
      dropTotalMaxMs: 107.5,
      dragoverSetupMaxMs: 50,
      dropTreePatchMaxMs: 3.1,
      dropVirtualRowsMaxMs: 10.2,
      dropProjectionBuildCount: 0,
      dragoverP95MaxMs: 4.2,
      hoverGuideMaxMs: 2.4,
      hoverScrollVirtualRowsMaxMs: 8.1,
      status: "keep",
      guardFailures: []
    });
  });

  it("requires a baseline improvement for experiments", () => {
    const candidate = summarizeDragDropRuns([
      { run: 1, profiles: goodProfiles },
      { run: 2, profiles: goodProfiles }
    ], { baselineMs: 60 });
    const flat = summarizeDragDropRuns([
      { run: 1, profiles: goodProfiles },
      { run: 2, profiles: goodProfiles }
    ], { baselineMs: 56 });

    expect(candidate.status).toBe("keep");
    expect(flat.status).toBe("discard");
    expect(flat.guardFailures).toContain("drop median must improve by at least 5ms from baseline");
  });

  it("fails missing profiles and budget regressions", () => {
    const badProfiles = {
      ...goodProfiles,
      "drag-drop-50k": { p95Ms: 9 },
      "drag-drop-50k-drop": {
        elapsedMs: 125,
        dragoverSetupMs: 30,
        dropDispatchToVisibleMs: 95,
        summary: [
          { name: "sidebar.patch.treeStructure", count: 1, totalMs: 14, avgMs: 14, maxMs: 14 },
          { name: "sidebar.virtualRows", count: 1, totalMs: 18, avgMs: 18, maxMs: 18 },
          { name: "sidebar.projection.build", count: 1, totalMs: 30, avgMs: 30, maxMs: 30 }
        ]
      },
      "hover-guide-50k": { hoverGuide: { maxMs: 9 } },
      "hover-scroll-50k": { virtualRows: { maxMs: 18 } }
    };
    const summary = summarizeDragDropRuns([{ run: 1, profiles: badProfiles }]);

    expect(dragDropGuardFailures(summary, {
      dropProfiles: [badProfiles["drag-drop-50k-drop"]],
      dragoverProfiles: [badProfiles["drag-drop-50k"]],
      hoverProfiles: [badProfiles["hover-guide-50k"]],
      hoverScrollProfiles: [badProfiles["hover-scroll-50k"]],
      inputDelayProfiles: []
    })).toEqual([
      "missing input-delay-profile output",
      "drop visible update must stay below 90ms",
      "drop tree-structure patch must stay below 12ms",
      "drop virtual-row render must stay below 16ms",
      "drop must not rebuild the full sidebar projection",
      "dragover preview p95 must stay below 8ms",
      "large hover guide work must stay below 8ms",
      "hover-scroll virtual rows must stay below 16ms"
    ]);
  });

  it("requires corrected drop dispatch-to-visible timing", () => {
    const missingDropOnlyTiming = {
      ...goodProfiles,
      "drag-drop-50k-drop": {
        ...goodProfiles["drag-drop-50k-drop"],
        dropDispatchToVisibleMs: undefined
      }
    };
    const summary = summarizeDragDropRuns([{ run: 1, profiles: missingDropOnlyTiming }]);

    expect(summary.status).toBe("discard");
    expect(summary.guardFailures).toContain("missing drop dispatch-to-visible timing");
  });

  it("marks nonzero Playwright runs as discardable profile failures", () => {
    const summary = summarizeDragDropRuns([{ run: 1, profiles: goodProfiles, commandFailed: true }]);

    expect(summary.status).toBe("discard");
    expect(summary.playwrightFailureCount).toBe(1);
    expect(summary.guardFailures).toContain("Playwright drag/drop spec must pass without hard failures");
  });

  it("formats TSV rows for ignored autoresearch results", () => {
    const summary = summarizeDragDropRuns([{ run: 1, profiles: goodProfiles }]);
    const row = formatDragDropTsvRow(summary, {
      timestamp: "2026-06-01T12:00:00.000Z",
      tag: "20260601-drag-drop",
      commit: "abcdef0",
      baselineMs: 60,
      description: "fixture"
    });

    expect(DRAG_DROP_RESULTS_TSV_HEADER).toContain("drop_median_ms");
    expect(row).toContain("20260601-drag-drop");
    expect(row).toContain("\t60\t52.5\t52.5\t3.1\t10.2\t0\t4.2\t2.4\t8.1\tkeep\tfixture");
  });
});
