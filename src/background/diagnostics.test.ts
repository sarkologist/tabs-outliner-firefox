import { describe, expect, it } from "vitest";

import { computeDiagnostics } from "./diagnostics.js";
import { bootstrapFromWindows, moveNode } from "../model/outline.js";
import type { RuntimeWindow } from "../model/types.js";

const runtimeWindows: RuntimeWindow[] = [
  {
    id: 10,
    focused: true,
    incognito: false,
    tabs: [
      {
        id: 1,
        windowId: 10,
        index: 0,
        active: true,
        url: "https://example.com/",
        title: "Example"
      },
      {
        id: 2,
        windowId: 10,
        index: 1,
        active: false,
        openerTabId: 1,
        url: "https://example.com/child",
        title: "Child"
      },
      {
        id: 3,
        windowId: 10,
        index: 2,
        active: false,
        url: "https://missing.example/",
        title: "Missing"
      }
    ]
  }
];

describe("diagnostics", () => {
  it("reports runtime tabs missing from the outline model", () => {
    const state = bootstrapFromWindows(
      [
        {
          ...runtimeWindows[0]!,
          tabs: runtimeWindows[0]!.tabs!.slice(0, 2)
        }
      ],
      { now: 1000 }
    );

    expect(computeDiagnostics(state, runtimeWindows)).toEqual({
      runtimeTabCount: 3,
      liveTabNodeCount: 2,
      visibleLiveTabNodeCount: 2,
      closedTabNodeCount: 0,
      hiddenLiveTabNodeCount: 0,
      missingRuntimeTabIds: [3],
      // The unmatched tab carries its window/url/title so a "missing N" is identifiable
      // after the fact (the readout is volatile; the coordinator logs these to the
      // incident log, which a profile export captures).
      missingRuntimeTabs: [
        { id: 3, windowId: 10, url: "https://missing.example/", title: "Missing" }
      ]
    });
  });

  it("reports live tabs hidden by collapsed ancestors", () => {
    const state = moveNode(bootstrapFromWindows(runtimeWindows, { now: 1000 }), "tab:3", {
      parentId: "tab:1",
      index: 0
    });
    state.nodes["tab:1"] = {
      ...state.nodes["tab:1"]!,
      collapsed: true
    };

    expect(computeDiagnostics(state, runtimeWindows)).toEqual({
      runtimeTabCount: 3,
      liveTabNodeCount: 3,
      visibleLiveTabNodeCount: 1,
      closedTabNodeCount: 0,
      hiddenLiveTabNodeCount: 2,
      missingRuntimeTabIds: [],
      missingRuntimeTabs: []
    });
  });
});
