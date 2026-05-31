import { describe, expect, it } from "vitest";

import { RuntimeFactLedger, type RuntimeTabEvidence, type RuntimeTabEvidenceField } from "./runtime-facts.js";
import { RuntimeWindowScopeIndex } from "./runtime-window-scope.js";
import {
  RuntimeReconciler,
  buildRuntimeStateIndexForReconciliation
} from "./runtime-reconciler.js";
import {
  bootstrapFromWindows,
  closeTab,
  closeWindow,
  deleteLiveTabNodeByTabId,
  moveNode,
  moveTabToNewLiveWindow
} from "../model/outline.js";
import type { RuntimeTab, RuntimeWindow } from "../model/types.js";

const tabOne: RuntimeTab = {
  id: 1,
  windowId: 10,
  index: 0,
  active: true,
  url: "https://one.example/",
  title: "One"
};

const tabTwo: RuntimeTab = {
  id: 2,
  windowId: 10,
  index: 1,
  active: false,
  url: "https://two.example/",
  title: "Two"
};

function windowInfo(id: number, tabs: RuntimeTab[], focused = true): RuntimeWindow {
  return {
    id,
    focused,
    incognito: false,
    tabs
  };
}

function updatedEvidence(tab: RuntimeTab, changedFields: RuntimeTabEvidenceField[]): RuntimeTabEvidence {
  return {
    kind: "updated",
    tab,
    changedFields: new Set(changedFields),
    confidence: "eventLocal",
    scopeGeneration: 0,
    sequence: 1
  };
}

function createdEvidence(tab: RuntimeTab): RuntimeTabEvidence {
  return {
    kind: "created",
    tab,
    changedFields: new Set<RuntimeTabEvidenceField>(["windowId", "index", "active", "openerTabId", "url", "title", "favIconUrl"]),
    confidence: "eventLocal",
    scopeGeneration: 0,
    sequence: 1
  };
}

describe("runtime reconciliation ledger", () => {
  it("filters stale old-window relocation echoes and restores the current destination tab", () => {
    const base = bootstrapFromWindows([windowInfo(10, [tabOne, tabTwo])], { now: 1000 });
    const movedTab = { ...tabOne, windowId: 20, index: 0, active: true };
    const moved = moveTabToNewLiveWindow(
      base,
      "tab:1",
      windowInfo(20, [movedTab]),
      { now: 2000 }
    );
    const ledger = new RuntimeFactLedger();
    ledger.recordCommandRelocatedTab(1, 10, 20);

    const normalized = new RuntimeReconciler().normalizeSnapshot({
      windows: [
        windowInfo(10, [{ ...tabOne, active: false }, tabTwo], false),
        windowInfo(20, [], true)
      ],
      state: moved,
      index: buildRuntimeStateIndexForReconciliation(moved),
      ledger,
      confidence: "staleSuspect"
    });

    expect(normalized.find((windowValue) => windowValue.id === 10)?.tabs?.map((tab) => tab.id)).toEqual([2]);
    expect(normalized.find((windowValue) => windowValue.id === 20)?.tabs).toMatchObject([
      {
        id: 1,
        windowId: 20,
        title: "One"
      }
    ]);
  });

  it("treats an empty still-open window snapshot as partial evidence", () => {
    const state = bootstrapFromWindows([windowInfo(10, [tabOne, tabTwo])], { now: 1000 });
    const normalized = new RuntimeReconciler().normalizeSnapshot({
      windows: [windowInfo(10, [])],
      state,
      index: buildRuntimeStateIndexForReconciliation(state),
      ledger: new RuntimeFactLedger(),
      confidence: "partial"
    });

    expect(normalized[0]?.tabs?.map((tab) => tab.id)).toEqual([1, 2]);
  });

  it("absorbs no-op command-restored tab creation echoes without dropping stale protection", () => {
    const state = bootstrapFromWindows([windowInfo(10, [tabOne])], { now: 1000 });
    const index = buildRuntimeStateIndexForReconciliation(state);
    const ledger = new RuntimeFactLedger();
    const reconciler = new RuntimeReconciler();
    ledger.recordCommandRestoredTab(1);

    expect(reconciler.consumeCommandRestoredTabEvent(state, index, ledger, tabOne)).toBe(true);
    expect(reconciler.consumeCommandRestoredTabEvent(state, index, ledger, tabOne)).toBe(true);
    expect(reconciler.consumeCommandRestoredTabEvent(state, index, ledger, { ...tabOne, title: "Fresh title" })).toBe(false);
  });

  it("filters event-local tabs through command echo and no-op rules", () => {
    const state = bootstrapFromWindows([windowInfo(10, [tabOne, tabTwo])], { now: 1000 });
    const index = buildRuntimeStateIndexForReconciliation(state);
    const ledger = new RuntimeFactLedger();
    const reconciler = new RuntimeReconciler();
    ledger.recordCommandRestoredTab(1);

    expect(reconciler.filterEventTabsForReconciliation({
      eventTabs: [
        tabOne,
        tabTwo,
        { ...tabTwo, title: "Two updated" }
      ],
      state,
      index,
      ledger
    }).map((evidence) => evidence.tab.title)).toEqual(["Two updated"]);
  });

  it("treats event-local tabs for known runtime ids in new windows as structural changes", () => {
    const base = bootstrapFromWindows([windowInfo(10, [tabOne, tabTwo])], { now: 1000 });
    const movedTab = { ...tabOne, windowId: 20, index: 0, active: true };
    const moved = moveTabToNewLiveWindow(
      base,
      "tab:1",
      windowInfo(20, [movedTab]),
      { now: 2000 }
    );
    const reconciler = new RuntimeReconciler();

    expect(reconciler.filterEventTabsForReconciliation({
      eventTabs: [{ ...tabOne, title: "Stale old window" }],
      state: moved,
      index: buildRuntimeStateIndexForReconciliation(moved),
      ledger: new RuntimeFactLedger()
    }).map((evidence) => evidence.tab.title)).toEqual(["Stale old window"]);

    expect(reconciler.filterEventTabsForReconciliation({
      eventTabs: [{ ...movedTab, title: "Fresh current window" }],
      state: moved,
      index: buildRuntimeStateIndexForReconciliation(moved),
      ledger: new RuntimeFactLedger()
    }).map((evidence) => evidence.tab.title)).toEqual(["Fresh current window"]);
  });

  it("requires corroboration for created events on already-known tabs", () => {
    const state = bootstrapFromWindows([windowInfo(10, [tabOne, tabTwo])], { now: 1000 });
    const index = buildRuntimeStateIndexForReconciliation(state);
    const ledger = new RuntimeFactLedger();
    const reconciler = new RuntimeReconciler();

    expect(reconciler.eventTabsNeedShapeCorroboration({
      eventTabs: [createdEvidence({ ...tabTwo, active: true })],
      state,
      index,
      ledger
    })).toBe(true);
  });

  it("keeps plain metadata updates eligible for the fast path", () => {
    const state = bootstrapFromWindows([windowInfo(10, [tabOne, tabTwo])], { now: 1000 });
    const index = buildRuntimeStateIndexForReconciliation(state);
    const ledger = new RuntimeFactLedger();
    const reconciler = new RuntimeReconciler();

    expect(reconciler.eventTabsNeedShapeCorroboration({
      eventTabs: [updatedEvidence({ ...tabTwo, title: "Two updated" }, ["title"])],
      state,
      index,
      ledger
    })).toBe(false);
  });

  it("uses update field masks to reject stale active/index bundled with metadata", () => {
    const state = bootstrapFromWindows([windowInfo(10, [tabOne, tabTwo])], { now: 1000 });
    const index = buildRuntimeStateIndexForReconciliation(state);
    const ledger = new RuntimeFactLedger();
    const reconciler = new RuntimeReconciler();

    expect(reconciler.eventTabsNeedShapeCorroboration({
      eventTabs: [updatedEvidence({ ...tabTwo, index: 0, active: true, title: "Two updated" }, ["title"])],
      state,
      index,
      ledger
    })).toBe(true);
  });

  it("does not corroborate no-op updated evidence", () => {
    const state = bootstrapFromWindows([windowInfo(10, [tabOne, tabTwo])], { now: 1000 });
    const index = buildRuntimeStateIndexForReconciliation(state);
    const ledger = new RuntimeFactLedger();
    const reconciler = new RuntimeReconciler();

    expect(reconciler.eventTabsNeedShapeCorroboration({
      eventTabs: [updatedEvidence(tabTwo, ["title"])],
      state,
      index,
      ledger
    })).toBe(false);
  });

  it("marks tabs as shape-protected when an update event reveals structural drift", () => {
    const state = bootstrapFromWindows([windowInfo(10, [tabOne, tabTwo])], { now: 1000 });
    const ledger = new RuntimeFactLedger();
    ledger.reconstructFromState(state, [windowInfo(10, [tabOne, tabTwo])]);

    ledger.recordNativeTabUpdated({ ...tabTwo, index: 0 }, { title: tabTwo.title });

    expect(ledger.tabNeedsShapeCorroboration(2)).toBe(true);
  });

  it("records fullscreen as scoped window shape without marking tab shape stale", () => {
    const window = { ...windowInfo(10, [tabOne, tabTwo]), state: "normal" as const };
    const state = bootstrapFromWindows([window], { now: 1000 });
    const ledger = new RuntimeFactLedger();
    ledger.reconstructFromState(state, [window]);
    const generation = ledger.currentScopeGeneration();

    ledger.recordNativeWindowBoundsChanged({ id: 10, focused: true, incognito: false, state: "fullscreen" });

    expect(ledger.acceptedWindowShapeFact(10)).toMatchObject({
      windowId: 10,
      tabOrder: [1, 2],
      activeTabId: 1,
      state: "fullscreen",
      focused: true,
      source: "windowEvent",
      confidence: "eventLocal"
    });
    expect(ledger.currentScopeGeneration()).toBe(generation);
    expect(ledger.tabNeedsShapeCorroboration(1)).toBe(false);
    expect(ledger.tabNeedsShapeCorroboration(2)).toBe(false);
  });

  it("keeps installed-state tab order ahead of stale accepted window shape order", () => {
    const state = bootstrapFromWindows([windowInfo(10, [tabOne, tabTwo])], { now: 1000 });
    const ledger = new RuntimeFactLedger();
    ledger.reconstructFromState(state, [windowInfo(10, [tabOne, tabTwo])]);

    ledger.recordObservation({
      source: "snapshot",
      confidence: "partial",
      windows: [
        windowInfo(10, [
          { ...tabTwo, index: 0 },
          { ...tabOne, index: 1 }
        ])
      ]
    });

    expect(ledger.acceptedWindowShapeFact(10)?.tabOrder).toEqual([2, 1]);

    ledger.reconstructFromState(state, [windowInfo(10, [tabOne, tabTwo])]);

    expect(ledger.acceptedWindowShapeFact(10)?.tabOrder).toEqual([1, 2]);
    expect(ledger.windowScope(10)?.tabOrder).toEqual([1, 2]);
  });

  it("rebuilds synthetic windows from outline order while preserving accepted window metadata", () => {
    const state = bootstrapFromWindows([windowInfo(10, [tabOne, tabTwo])], { now: 1000 });
    const ledger = new RuntimeFactLedger();
    ledger.reconstructFromState(state, [windowInfo(10, [tabOne, tabTwo])]);

    ledger.recordObservation({
      source: "snapshot",
      confidence: "partial",
      windows: [
        {
          ...windowInfo(10, [
            { ...tabTwo, index: 0 },
            { ...tabOne, index: 1 }
          ]),
          state: "fullscreen"
        }
      ]
    });
    ledger.rebuildWindowScopes(state);

    expect(ledger.windowScope(10)?.tabOrder).toEqual([1, 2]);
    expect(ledger.acceptedWindowShapeFact(10)).toMatchObject({
      windowId: 10,
      tabOrder: [1, 2],
      activeTabId: 1,
      state: "fullscreen"
    });
  });

  it("reconstructs restart tombstones for old canonical runtime ids", () => {
    const state = closeTab(bootstrapFromWindows([windowInfo(10, [tabOne, tabTwo])], { now: 1000 }), 1, { now: 2000 });
    const ledger = new RuntimeFactLedger();
    ledger.reconstructFromState(state, [windowInfo(10, [tabTwo])]);

    const normalized = new RuntimeReconciler().normalizeSnapshot({
      windows: [windowInfo(10, [tabTwo, { ...tabOne, index: 1, active: false }])],
      state,
      index: buildRuntimeStateIndexForReconciliation(state),
      ledger,
      confidence: "complete"
    });

    expect(normalized[0]?.tabs?.map((tab) => tab.id)).toEqual([2]);
  });

  it("reconstructs restart tombstones for deleted lower runtime ids from the startup snapshot", () => {
    const state = deleteLiveTabNodeByTabId(
      bootstrapFromWindows([windowInfo(10, [tabOne, tabTwo])], { now: 1000 }),
      1
    );
    const ledger = new RuntimeFactLedger();
    ledger.reconstructFromState(state, [windowInfo(10, [tabTwo])]);
    const reconciler = new RuntimeReconciler();

    expect(reconciler.filterEventTabsForReconciliation({
      eventTabs: [{ ...tabOne, active: false }],
      state,
      index: buildRuntimeStateIndexForReconciliation(state),
      ledger
    })).toEqual([]);

    const normalized = reconciler.normalizeSnapshot({
      windows: [windowInfo(10, [tabTwo, { ...tabOne, index: 1, active: false }])],
      state,
      index: buildRuntimeStateIndexForReconciliation(state),
      ledger,
      confidence: "complete"
    });

    expect(normalized[0]?.tabs?.map((tab) => tab.id)).toEqual([2]);
  });

  it("classifies native close event orders from resource facts", () => {
    const ledger = new RuntimeFactLedger();
    const reconciler = new RuntimeReconciler();

    ledger.recordNativeTabRemoved(1, 10);
    ledger.recordNativeTabRemoved(2, 10);
    expect(reconciler.classifyWindowClosingTabRemoval(ledger, {
      windowId: 10,
      liveTabIds: [1, 2],
      runtimeWindowOpen: false
    })).toBe("close-window");

    expect(reconciler.classifyWindowClosingTabRemoval(ledger, {
      windowId: 10,
      liveTabIds: [1, 2],
      runtimeWindowOpen: true
    })).toBe("wait-for-runtime-window");

    const commandOwned = new RuntimeFactLedger();
    commandOwned.markDeleteClosePlan({ tabIds: [], windowIds: [10] });
    expect(reconciler.classifyWindowClosingTabRemoval(commandOwned, {
      windowId: 10,
      liveTabIds: [1],
      runtimeWindowOpen: false
    })).toBe("ignore-command-owned");
  });

  it("classifies missing live tabs from command ownership and restored state", () => {
    const state = bootstrapFromWindows([windowInfo(10, [tabOne, tabTwo])], { now: 1000 });
    const tabNode = Object.values(state.nodes).find((node) =>
      node.kind === "tab" &&
      node.status === "live" &&
      node.live &&
      "tabId" in node.live &&
      node.live.tabId === 2
    );
    expect(tabNode).toBeDefined();
    const restoredState = {
      ...state,
      nodes: {
        ...state.nodes,
        [tabNode!.id]: {
          ...tabNode!,
          restoredFromClosed: true
        }
      }
    };
    const reconciler = new RuntimeReconciler();
    const ledger = new RuntimeFactLedger();

    ledger.markOutlinerClosePlan({ tabIds: [1], windowIds: [] });
    expect(reconciler.classifyMissingLiveTabRemoval(state, ledger, 1)).toBe("close-outliner-tab");
    expect(reconciler.classifyMissingLiveTabRemoval(state, ledger, 1)).toBe("delete-tab");
    expect(reconciler.classifyMissingLiveTabRemoval(restoredState, ledger, 2)).toBe("delete-tab");
  });

  it("finds missing live tabs from open-window snapshots through ledger filters", () => {
    const state = bootstrapFromWindows([windowInfo(10, [tabOne, tabTwo])], { now: 1000 });
    const reconciler = new RuntimeReconciler();
    const ledger = new RuntimeFactLedger();

    expect(reconciler.missingLiveTabIdsInOpenWindows({
      windows: [windowInfo(10, [tabOne])],
      state,
      ledger
    })).toEqual([2]);

    ledger.recordMissingLiveTab(2);
    expect(reconciler.missingLiveTabIdsInOpenWindows({
      windows: [windowInfo(10, [tabOne])],
      state,
      ledger
    })).toEqual([]);
  });

  it("finds missing browser-created live windows without treating saved windows as session-close evidence", () => {
    const tabThree: RuntimeTab = {
      id: 3,
      windowId: 20,
      index: 0,
      active: true,
      url: "https://three.example/",
      title: "Three"
    };
    const state = bootstrapFromWindows([
      windowInfo(10, [tabOne]),
      windowInfo(20, [tabThree], false)
    ], { now: 1000 });
    const reconciler = new RuntimeReconciler();
    const ledger = new RuntimeFactLedger();

    expect(reconciler.missingBrowserCreatedWindowIds({
      windows: [windowInfo(10, [tabOne])],
      state,
      ledger
    })).toEqual([]);

    ledger.recordBrowserCreatedRuntimeWindow(20);
    expect(reconciler.missingBrowserCreatedWindowIds({
      windows: [windowInfo(10, [tabOne])],
      state,
      ledger
    })).toEqual([20]);

    ledger.recordClosedRuntimeWindow(20, [3]);
    expect(reconciler.missingBrowserCreatedWindowIds({
      windows: [windowInfo(10, [tabOne])],
      state,
      ledger
    })).toEqual([]);
  });

  it("finds missing live window scopes from complete session snapshots", () => {
    const tabThree: RuntimeTab = {
      id: 3,
      windowId: 20,
      index: 0,
      active: true,
      url: "https://three.example/",
      title: "Three"
    };
    const state = bootstrapFromWindows([
      windowInfo(10, [tabOne]),
      windowInfo(20, [tabThree], false)
    ], { now: 1000 });
    const reconciler = new RuntimeReconciler();
    const ledger = new RuntimeFactLedger();

    expect(reconciler.missingLiveWindowIds({
      windows: [windowInfo(10, [tabOne])],
      state,
      ledger
    })).toEqual([20]);

    const movedTabThree = { ...tabThree, windowId: 10, index: 1, active: false };
    expect(reconciler.missingLiveWindowIds({
      windows: [windowInfo(10, [tabOne, movedTabThree])],
      state,
      ledger
    })).toEqual([]);

    ledger.recordClosedRuntimeWindow(20, [3]);
    expect(reconciler.missingLiveWindowIds({
      windows: [windowInfo(10, [tabOne])],
      state,
      ledger
    })).toEqual([]);
  });

  it("classifies corroborated missing live windows by reconstructed provenance", () => {
    const tabThree: RuntimeTab = {
      id: 3,
      windowId: 20,
      index: 0,
      active: true,
      url: "https://three.example/",
      title: "Three"
    };
    const state = bootstrapFromWindows([
      windowInfo(10, [tabOne]),
      windowInfo(20, [tabThree], false)
    ], { now: 1000 });
    const reconciler = new RuntimeReconciler();
    const savedLedger = new RuntimeFactLedger();
    savedLedger.reconstructFromState(state, [windowInfo(10, [tabOne]), windowInfo(20, [tabThree], false)]);

    expect(reconciler.classifyMissingLiveWindowRemoval(state, savedLedger, {
      windowId: 20,
      hasRecentClosedWindowSession: false
    })).toBe("close-window");

    const browserCreatedState = {
      ...state,
      nodes: {
        ...state.nodes,
        "window:20": {
          ...state.nodes["window:20"]!,
          runtimeProvenance: "browserCreated" as const
        }
      }
    };
    const browserLedger = new RuntimeFactLedger();
    browserLedger.reconstructFromState(browserCreatedState, [
      windowInfo(10, [tabOne]),
      windowInfo(20, [tabThree], false)
    ]);

    expect(reconciler.classifyMissingLiveWindowRemoval(browserCreatedState, browserLedger, {
      windowId: 20,
      hasRecentClosedWindowSession: false
    })).toBe("close-window");

    const commandRestoredState = {
      ...state,
      nodes: {
        ...state.nodes,
        "window:20": {
          ...state.nodes["window:20"]!,
          restoredFromClosed: true,
          runtimeProvenance: "commandCreated" as const
        }
      }
    };
    const commandRestoredLedger = new RuntimeFactLedger();
    commandRestoredLedger.reconstructFromState(commandRestoredState, [
      windowInfo(10, [tabOne]),
      windowInfo(20, [tabThree], false)
    ]);

    expect(reconciler.classifyMissingLiveWindowRemoval(commandRestoredState, commandRestoredLedger, {
      windowId: 20,
      hasRecentClosedWindowSession: false
    })).toBe("delete-tabs");
  });

  it("finds live tabs that appear in the wrong runtime window snapshot", () => {
    const base = bootstrapFromWindows([windowInfo(10, [tabOne, tabTwo])], { now: 1000 });
    const movedTab = { ...tabOne, windowId: 20, index: 0, active: true };
    const moved = moveTabToNewLiveWindow(
      base,
      "tab:1",
      windowInfo(20, [movedTab]),
      { now: 2000 }
    );
    const reconciler = new RuntimeReconciler();

    expect(reconciler.mismatchedLiveTabIdsInWindows({
      windows: [
        windowInfo(10, [{ ...tabOne, active: false }, tabTwo], false),
        windowInfo(20, [], true)
      ],
      state: moved,
      index: buildRuntimeStateIndexForReconciliation(moved),
      ledger: new RuntimeFactLedger()
    })).toEqual([1]);
  });

  it("records command transaction provenance for partial side-effect recovery", () => {
    const ledger = new RuntimeFactLedger();
    const transaction = ledger.beginCommandTransaction({
      commandType: "moveNodeToNewWindow",
      plannedTabs: [1],
      plannedWindows: [20],
      ownership: "relocation"
    });

    ledger.recordCommandObserved(transaction.id);
    ledger.rejectCommand(transaction.id);

    expect(ledger.observationsSnapshot()).toMatchObject([
      {
        source: "command",
        commandId: transaction.id,
        kind: "planned"
      },
      {
        source: "command",
        commandId: transaction.id,
        kind: "observed"
      },
      {
        source: "command",
        commandId: transaction.id,
        kind: "rejected"
      }
    ]);
  });

  it("records native removal facts and classifies command-owned removals", () => {
    const ledger = new RuntimeFactLedger();

    ledger.markDeleteClosePlan({ tabIds: [1], windowIds: [10] });
    expect(ledger.recordNativeTabRemoved(1, 10)).toBe("ignore-delete-owned");
    expect(ledger.recordNativeWindowRemoved(10)).toBe("ignore-delete-owned");
    expect(ledger.recordNativeWindowRemoved(10)).toBe("ignore-duplicate");
    expect(ledger.recordNativeTabRemoved(2, 10)).toBe("continue");

    expect(ledger.observationsSnapshot()).toMatchObject([
      {
        source: "tabEvent",
        kind: "removed",
        tabId: 1,
        windowId: 10
      },
      {
        source: "windowEvent",
        kind: "removed",
        windowId: 10
      },
      {
        source: "windowEvent",
        kind: "removed",
        windowId: 10
      },
      {
        source: "tabEvent",
        kind: "removed",
        tabId: 2,
        windowId: 10
      }
    ]);
  });

  it("resolves durable and runtime-only window provenance before canonical fallback", () => {
    const state = bootstrapFromWindows([windowInfo(21, [{ ...tabOne, windowId: 21 }])], { now: 1000 });
    const explicitBrowserNode = {
      ...state.nodes["window:21"]!,
      runtimeProvenance: "browserCreated" as const
    };
    const explicitCommandNode = {
      ...state.nodes["window:21"]!,
      runtimeProvenance: "commandCreated" as const
    };
    const restoredNode = {
      ...state.nodes["window:21"]!,
      restoredFromClosed: true
    };
    const nestedCanonicalNode = {
      ...state.nodes["window:21"]!,
      parentId: "window:10"
    };
    const ledger = new RuntimeFactLedger();

    expect(ledger.resolveRuntimeWindowScopeProvenance({
      runtimeWindowId: 21,
      outlineWindowNode: explicitBrowserNode,
      hasRuntimeWindow: true,
      runtimeOnly: false
    })).toBe("browserCreated");
    expect(ledger.resolveRuntimeWindowScopeProvenance({
      runtimeWindowId: 21,
      outlineWindowNode: explicitCommandNode,
      hasRuntimeWindow: true,
      runtimeOnly: false
    })).toBe("commandCreated");
    expect(ledger.resolveRuntimeWindowScopeProvenance({
      runtimeWindowId: 21,
      outlineWindowNode: restoredNode,
      hasRuntimeWindow: true,
      runtimeOnly: false
    })).toBe("restored");
    expect(ledger.resolveRuntimeWindowScopeProvenance({
      runtimeWindowId: 22,
      hasRuntimeWindow: true,
      runtimeOnly: true
    })).toBe("browserCreated");
    expect(ledger.resolveRuntimeWindowScopeProvenance({
      runtimeWindowId: 21,
      outlineWindowNode: nestedCanonicalNode,
      hasRuntimeWindow: true,
      runtimeOnly: false
    })).toBe("commandCreated");
  });

  it("keeps removed tab tombstones ahead of installed-state rebuilds", () => {
    const state = bootstrapFromWindows([windowInfo(10, [tabOne, tabTwo])], { now: 1000 });
    const ledger = new RuntimeFactLedger();
    ledger.reconstructFromState(state, [windowInfo(10, [tabOne, tabTwo])]);

    expect(ledger.acceptedTabShapeFact(2)).toBeDefined();

    ledger.recordNativeTabRemoved(2, 10);

    expect(ledger.acceptedTabShapeFact(2)).toBeUndefined();
    expect(ledger.acceptedWindowShapeFact(10)?.tabOrder).toEqual([1]);

    ledger.rebuildWindowScopes(state);

    expect(ledger.acceptedTabShapeFact(2)).toBeUndefined();
    expect(ledger.acceptedWindowShapeFact(10)?.tabOrder).toEqual([1]);
    expect(ledger.windowScopeForTab(2)).toBeUndefined();
  });

  it("matches accepted window scopes against unchanged runtime snapshots without a rebuild", () => {
    const state = bootstrapFromWindows([windowInfo(10, [tabOne, tabTwo])], { now: 1000 });
    const ledger = new RuntimeFactLedger();
    ledger.reconstructFromState(state, [windowInfo(10, [tabOne, tabTwo])]);

    expect(ledger.windowScopesMatchRuntimeWindows([windowInfo(10, [tabOne, tabTwo])])).toBe(true);
    expect(ledger.windowScopesMatchRuntimeWindows([windowInfo(10, [
      { ...tabTwo, index: 0 },
      { ...tabOne, index: 1 }
    ])])).toBe(false);
  });

  it("updates touched installed-state window scopes without rebuilding unrelated scopes", () => {
    const state = bootstrapFromWindows([windowInfo(10, [tabOne, tabTwo])], { now: 1000 });
    const moved = moveNode(state, "tab:2", { parentId: "window:10", index: 0, now: 2000 });
    const ledger = new RuntimeFactLedger();
    ledger.reconstructFromState(state, [windowInfo(10, [tabOne, tabTwo])]);

    expect(ledger.updateWindowScopesFromStateTransition(state, moved, ["tab:2", "window:10"])).toBe(true);

    expect(ledger.windowScope(10)?.tabOrder).toEqual([2, 1]);
    expect(ledger.acceptedWindowShapeFact(10)?.tabOrder).toEqual([2, 1]);
    expect(ledger.acceptedTabShapeFact(2)).toMatchObject({
      tabId: 2,
      windowId: 10,
      index: 0,
      source: "installedState"
    });
  });
});

describe("runtime window scope index", () => {
  it("reconstructs restored window ownership from outline state and runtime shape", () => {
    const base = bootstrapFromWindows([windowInfo(10, [tabOne])], { now: 1000 });
    const closed = closeWindow(base, 10, { now: 2000 });
    const restoredTab: RuntimeTab = {
      ...tabOne,
      id: 22,
      windowId: 42,
      index: 0,
      active: true,
      title: "Restored"
    };
    const restored = {
      ...closed,
      nodes: {
        ...closed.nodes,
        "window:10": {
          ...closed.nodes["window:10"],
          status: "live",
          live: { windowId: 42 },
          restoredFromClosed: true
        },
        "tab:1": {
          ...closed.nodes["tab:1"],
          status: "live",
          live: { tabId: 22, windowId: 42 },
          active: true,
          title: "Restored",
          url: restoredTab.url,
          restoredFromClosed: true
        }
      }
    };

    const scopes = new RuntimeWindowScopeIndex();
    scopes.rebuild({
      state: restored,
      windows: [windowInfo(42, [restoredTab])]
    });

    expect(scopes.scopeForWindow(42)).toMatchObject({
      runtimeWindowId: 42,
      outlineWindowNodeId: "window:10",
      activeTabId: 22,
      provenance: "restored",
      lifecycle: "live",
      tabOrder: [22]
    });
    expect(scopes.scopeForWindow(42)?.tabNodeIdsByRuntimeId.get(22)).toBe("tab:1");
  });

  it("scopes browser-created windows only after confirmed runtime evidence", () => {
    const state = bootstrapFromWindows([windowInfo(10, [tabOne])], { now: 1000 });
    const browserCreatedWindowIds = new Set([21]);
    const scopes = new RuntimeWindowScopeIndex();
    scopes.rebuild({
      state,
      windows: [
        windowInfo(10, [tabOne]),
        windowInfo(21, [{ ...tabTwo, id: 30, windowId: 21, index: 0, active: true }])
      ],
      browserCreatedWindowIds
    });

    expect(scopes.scopeForWindow(21)).toMatchObject({
      runtimeWindowId: 21,
      provenance: "browserCreated",
      lifecycle: "live",
      tabOrder: [30]
    });
    expect(scopes.scopeForWindow(21)?.outlineWindowNodeId).toBeUndefined();
    expect(scopes.scopeForTab(30)?.runtimeWindowId).toBe(21);
  });

  it("filters ignored runtime ids while rebuilding scopes", () => {
    const state = bootstrapFromWindows([windowInfo(10, [tabOne, tabTwo])], { now: 1000 });
    const scopes = new RuntimeWindowScopeIndex();

    scopes.rebuild({
      state,
      windows: [windowInfo(10, [tabOne, tabTwo])],
      ignoredTabIds: new Set([2]),
      ignoredWindowIds: new Set<number>(),
      resolveProvenance: ({ runtimeOnly, outlineWindowNode }) =>
        runtimeOnly ? "browserCreated" : outlineWindowNode?.runtimeProvenance ?? "saved"
    });

    expect(scopes.scopeForWindow(10)?.tabOrder).toEqual([1]);
    expect(scopes.scopeForTab(2)).toBeUndefined();
    expect(scopes.nodeTouchesRemovedRuntimeScope(state, "tab:2")).toBe(true);
  });

  it("recognizes removed restored tabs by outline node id after runtime id reassignment", () => {
    const restoredTab = { ...tabOne, id: 4, windowId: 22 };
    const state = bootstrapFromWindows([windowInfo(22, [restoredTab])], { now: 1000 });
    const restoredNodeState = {
      ...state,
      nodes: {
        ...state.nodes,
        "window:100": {
          ...state.nodes["window:22"]!,
          id: "window:100",
          childIds: ["tab:100"]
        },
        "tab:100": {
          ...state.nodes["tab:4"]!,
          id: "tab:100",
          parentId: "window:100"
        }
      },
      rootIds: ["window:100"]
    };
    delete restoredNodeState.nodes["window:22"];
    delete restoredNodeState.nodes["tab:4"];

    const scopes = new RuntimeWindowScopeIndex();
    scopes.rebuild({
      state: restoredNodeState,
      windows: [windowInfo(22, [restoredTab])]
    });

    scopes.markTabRemoved(4);

    expect(scopes.nodeTouchesRemovedRuntimeScope(restoredNodeState, "tab:100")).toBe(true);
  });

  it("records browser-created provenance when a native attach targets a previously unknown window", () => {
    const state = bootstrapFromWindows([windowInfo(10, [tabOne, tabTwo])], { now: 1000 });
    const ledger = new RuntimeFactLedger();
    ledger.reconstructFromState(state, [windowInfo(10, [tabOne, tabTwo])]);

    ledger.recordNativeTabAttached(2, 20);

    expect(ledger.isBrowserCreatedRuntimeWindow(20)).toBe(true);
  });

  it("marks closed canonical runtime records as removed scope lifecycle", () => {
    const base = bootstrapFromWindows([windowInfo(20, [tabTwo])], { now: 1000 });
    const closed = closeWindow(base, 20, { now: 2000 });
    const scopes = new RuntimeWindowScopeIndex();
    scopes.rebuild({
      state: closed,
      windows: []
    });

    expect(scopes.scopeForWindow(20)).toMatchObject({
      runtimeWindowId: 20,
      outlineWindowNodeId: "window:20",
      provenance: "saved",
      lifecycle: "removed"
    });
    expect(scopes.nodeTouchesRemovedRuntimeScope(closed, "window:20")).toBe(true);
    expect(scopes.nodeTouchesRemovedRuntimeScope(closed, "tab:2")).toBe(true);
  });

  it("routes moved runtime tabs through their current window scope", () => {
    const destinationTab = { ...tabTwo, windowId: 20, index: 0 };
    const base = bootstrapFromWindows([windowInfo(10, [tabOne]), windowInfo(20, [destinationTab])], { now: 1000 });
    const movedTab = { ...tabOne, windowId: 20, index: 1, active: false };
    const state = {
      ...base,
      nodes: {
        ...base.nodes,
        "tab:1": {
          ...base.nodes["tab:1"],
          live: { tabId: 1, windowId: 20 },
          parentId: "window:20"
        },
        "window:10": {
          ...base.nodes["window:10"],
          childIds: []
        },
        "window:20": {
          ...base.nodes["window:20"],
          childIds: ["tab:2", "tab:1"]
        }
      }
    };
    const scopes = new RuntimeWindowScopeIndex();
    scopes.rebuild({
      state,
      windows: [
        windowInfo(10, []),
        windowInfo(20, [destinationTab, movedTab])
      ]
    });

    expect(scopes.scopeForTab(1)?.runtimeWindowId).toBe(20);
    expect(scopes.scopeForWindow(20)?.tabOrder).toEqual([2, 1]);
  });
});
