import { describe, expect, it } from "vitest";

import { RuntimeFactLedger } from "./runtime-facts.js";
import {
  RuntimeReconciler,
  buildRuntimeStateIndexForReconciliation
} from "./runtime-reconciler.js";
import { bootstrapFromWindows, moveTabToNewLiveWindow } from "../model/outline.js";
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

  it("absorbs command-restored tab creation echoes once", () => {
    const state = bootstrapFromWindows([windowInfo(10, [tabOne])], { now: 1000 });
    const index = buildRuntimeStateIndexForReconciliation(state);
    const ledger = new RuntimeFactLedger();
    const reconciler = new RuntimeReconciler();
    ledger.recordCommandRestoredTab(1);

    expect(reconciler.consumeCommandRestoredTabEvent(state, index, ledger, tabOne)).toBe(true);
    expect(reconciler.consumeCommandRestoredTabEvent(state, index, ledger, tabOne)).toBe(false);
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
    }).map((tab) => tab.title)).toEqual(["Two updated"]);
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
    expect(reconciler.classifyMissingLiveTabRemoval(restoredState, ledger, 2)).toBe("close-restored-tab");
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
});
