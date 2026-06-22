import { describe, expect, it } from "vitest";

import {
  computeDiagnostics,
  serializeMissingRuntimeTabsForIncidentLog,
  MISSING_RUNTIME_TAB_LOG_LIMIT,
  type MissingRuntimeTab
} from "./diagnostics.js";
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

describe("serializeMissingRuntimeTabsForIncidentLog", () => {
  it("serializes each tab's id/window/url/title to a JSON string", () => {
    const missing: MissingRuntimeTab[] = [
      { id: 7, windowId: 3, url: "https://a.example/", title: "A" },
      { id: 9, windowId: 3 }
    ];

    expect(JSON.parse(serializeMissingRuntimeTabsForIncidentLog(missing))).toEqual([
      { id: 7, windowId: 3, url: "https://a.example/", title: "A" },
      { id: 9, windowId: 3 }
    ]);
  });

  it("caps the number of serialized tabs (true total stays in the separate missingCount)", () => {
    const missing: MissingRuntimeTab[] = Array.from(
      { length: MISSING_RUNTIME_TAB_LOG_LIMIT + 5 },
      (_unused, index) => ({ id: index + 1, windowId: 1 })
    );

    expect(JSON.parse(serializeMissingRuntimeTabsForIncidentLog(missing))).toHaveLength(
      MISSING_RUNTIME_TAB_LOG_LIMIT
    );
  });

  it("truncates an oversized url/title and marks it with an ellipsis", () => {
    const longUrl = `https://example.com/${"x".repeat(1000)}`;
    const [entry] = JSON.parse(
      serializeMissingRuntimeTabsForIncidentLog([{ id: 1, windowId: 1, url: longUrl, title: "ok" }])
    ) as Array<{ url: string; title: string }>;

    expect(entry!.url.length).toBeLessThan(longUrl.length);
    expect(entry!.url.endsWith("…")).toBe(true);
    expect(entry!.title).toBe("ok");
  });
});
