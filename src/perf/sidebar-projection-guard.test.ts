import { describe, expect, it } from "vitest";

import {
  evaluateProjectionScenario,
  formatSidebarProjectionGuardSummary,
  parseProjectionGuardArgs,
  selectProjectionGuardScenarios
} from "../../scripts/perf-sidebar-projection-guard.mjs";
import { startupHoverGuardFailures } from "../../scripts/profile-startup-hover.mjs";

describe("sidebar projection perf guard", () => {
  it("selects scenarios and supports smoke run defaults", () => {
    expect(selectProjectionGuardScenarios({ scenarios: "startup-hover" }).map((scenario) => scenario.id)).toEqual([
      "startup-hover"
    ]);
    expect(selectProjectionGuardScenarios({ scenarios: "startup-hover,startup-scroll-away" }).map((scenario) => scenario.id))
      .toEqual(["startup-hover", "startup-scroll-away"]);

    expect(parseProjectionGuardArgs(["--", "--smoke"], {})).toMatchObject({
      runs: 1,
      retries: 1,
      smoke: true
    });
    expect(parseProjectionGuardArgs(["--retries", "2"], { SIDEBAR_PROJECTION_GUARD_RUNS: "3" })).toMatchObject({
      runs: 3,
      retries: 2
    });
  });

  it("fails when a profile reports guard failures or discard status", () => {
    const scenario = {
      id: "startup-hover",
      displayMetrics: ["firstPaintMaxMs", "sparseHoverActionButtonsMin"]
    };

    const passing = evaluateProjectionScenario(scenario, {
      guardFailures: [],
      summary: {
        status: "candidate-keep",
        firstPaintMaxMs: 6,
        sparseHoverActionButtonsMin: 5
      }
    });
    const failing = evaluateProjectionScenario(scenario, {
      guardFailures: ["sparse hover must materialize action buttons for the hovered row"],
      summary: {
        status: "discard",
        firstPaintMaxMs: 6,
        sparseHoverActionButtonsMin: 0
      }
    });
    const discardOnly = evaluateProjectionScenario(scenario, {
      guardFailures: [],
      summary: {
        status: "discard",
        firstPaintMaxMs: 6,
        sparseHoverActionButtonsMin: 5
      }
    });

    expect(passing.passed).toBe(true);
    expect(failing.passed).toBe(false);
    expect(failing.guardFailures).toEqual(["sparse hover must materialize action buttons for the hovered row"]);
    expect(discardOnly.passed).toBe(false);
    expect(discardOnly.guardFailures).toEqual(["profile status is discard"]);
  });

  it("guards sparse hover action identities, not just button count", () => {
    const summary = {
      runs: 1,
      firstPaintMaxMs: 6,
      firstPaintActionButtonsMax: 0,
      sparseHoverActionButtonsMin: 3,
      sparseIdleActionButtonsMin: 3,
      sparseHoverFrameMaxMs: 4,
      sparseHoverFeedbackMaxMs: 0.5,
      sparseIdleHydrationRequestsMax: 0,
      remoteIdleHydrationRequestsMax: 0
    };
    const profileGroups = {
      firstPaintProfiles: [{}],
      sparseHoverProfiles: [{
        actionButtonLabelsAfterHover: ["Group", "Close", "Delete"]
      }],
      sparseIdleProfiles: [{
        actionButtonLabelsAfterIdle: ["Cut", "Move to top level", "Paste"]
      }],
      remoteIdleProfiles: [{}]
    };

    expect(startupHoverGuardFailures(summary, profileGroups)).toEqual([
      "sparse hover actions must include Cut and Move to top level",
      "sparse partial actions must not include Paste"
    ]);
  });

  it("formats a compact hard-gate summary", () => {
    const formatted = formatSidebarProjectionGuardSummary({
      passed: false,
      scenarioCount: 2,
      runs: 5,
      results: [
        {
          id: "startup-hover",
          passed: true,
          guardFailures: [],
          displayMetrics: ["firstPaintMaxMs"],
          summary: { firstPaintMaxMs: 6 }
        },
        {
          id: "startup-scroll-away",
          passed: false,
          guardFailures: ["scroll-away rows must appear within 32ms"],
          displayMetrics: ["rowsVisibleMsMax"],
          summary: { rowsVisibleMsMax: 40 }
        }
      ]
    });

    expect(formatted).toContain("Sidebar projection perf guard: FAIL (2 scenarios, 5 runs)");
    expect(formatted).toContain("PASS startup-hover firstPaintMaxMs=6");
    expect(formatted).toContain("FAIL startup-scroll-away rowsVisibleMsMax=40");
    expect(formatted).toContain("scroll-away rows must appear within 32ms");
  });
});
