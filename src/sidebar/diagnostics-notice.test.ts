import { describe, expect, it } from "vitest";
import type { OutlineDiagnostics } from "../background/diagnostics.js";
import { diagnosticsText } from "./diagnostics-notice.js";

function diagnostics(overrides: Partial<OutlineDiagnostics> = {}): OutlineDiagnostics {
  return {
    runtimeTabCount: 41,
    liveTabNodeCount: 41,
    visibleLiveTabNodeCount: 41,
    closedTabNodeCount: 0,
    hiddenLiveTabNodeCount: 0,
    missingRuntimeTabIds: [],
    missingRuntimeTabs: [],
    ...overrides
  };
}

describe("diagnosticsText", () => {
  it("renders nothing when the outline agrees with the browser", () => {
    // The all-clear case must be blank: no redundant live-tab count, no "Firefox N" noise -- the
    // toolbar item counter already reports size, and the diagnostics line stays reserved for trouble.
    expect(diagnosticsText(diagnostics())).toBe("");
  });

  it("warns when the browser reports tabs the outline is missing", () => {
    expect(
      diagnosticsText(diagnostics({ liveTabNodeCount: 39, missingRuntimeTabIds: [7, 8] }))
    ).toBe("41 live / outline 39 / missing 2");
  });

  it("warns when live tab nodes are hidden from the visible tree", () => {
    expect(
      diagnosticsText(diagnostics({ visibleLiveTabNodeCount: 39, hiddenLiveTabNodeCount: 2 }))
    ).toBe("41 live / visible 39");
  });

  it("prioritises the missing-tab warning over the hidden-tab warning", () => {
    expect(
      diagnosticsText(
        diagnostics({
          liveTabNodeCount: 39,
          visibleLiveTabNodeCount: 37,
          hiddenLiveTabNodeCount: 2,
          missingRuntimeTabIds: [7]
        })
      )
    ).toBe("41 live / outline 39 / missing 1");
  });

  it("never mentions Firefox in any state", () => {
    const states = [
      diagnostics(),
      diagnostics({ liveTabNodeCount: 39, missingRuntimeTabIds: [7, 8] }),
      diagnostics({ visibleLiveTabNodeCount: 39, hiddenLiveTabNodeCount: 2 })
    ];
    for (const state of states) {
      expect(diagnosticsText(state)).not.toContain("Firefox");
    }
  });
});
