import { describe, expect, it } from "vitest";

import { preserveClosedSubtreesAcrossNonDestructiveTransition } from "./closed-subtree-guard.js";
import { cloneOutlineNode } from "./history.js";
import { bootstrapFromWindows, closeWindow } from "../model/outline.js";
import type { OutlineState, RuntimeWindow } from "../model/types.js";

const windows: RuntimeWindow[] = [
  {
    id: 20,
    focused: true,
    incognito: false,
    tabs: [
      {
        id: 2,
        windowId: 20,
        index: 0,
        active: true,
        url: "https://live.example/",
        title: "Live"
      }
    ]
  },
  {
    id: 10,
    focused: false,
    incognito: false,
    tabs: [
      {
        id: 1,
        windowId: 10,
        index: 0,
        active: true,
        url: "https://saved.example/",
        title: "Saved"
      }
    ]
  }
];

describe("preserveClosedSubtreesAcrossNonDestructiveTransition", () => {
  it("restores closed roots lost after live roots", () => {
    const previous = closeWindow(bootstrapFromWindows(windows, { now: 1000 }), 10, {
      now: 2000,
      sessionId: "session-window-10"
    });
    const broken: OutlineState = {
      version: 1,
      rootIds: ["window:20"],
      nodes: {
        "window:20": cloneOutlineNode(previous.nodes["window:20"]!),
        "tab:2": cloneOutlineNode(previous.nodes["tab:2"]!)
      }
    };

    const guarded = preserveClosedSubtreesAcrossNonDestructiveTransition(previous, broken);

    expect([...guarded.restoredNodeIds].sort()).toEqual(["tab:1", "window:10"]);
    expect(guarded.state.rootIds).toEqual(["window:20", "window:10"]);
    expect(guarded.state.nodes["window:10"]?.status).toBe("closed");
    expect(guarded.state.nodes["window:10"]?.childIds).toEqual(["tab:1"]);
    expect(guarded.state.nodes["tab:1"]?.status).toBe("closed");
    expect(guarded.state.nodes["tab:1"]?.parentId).toBe("window:10");
  });

  it("reattaches closed nodes that are present but unreachable", () => {
    const previous = closeWindow(bootstrapFromWindows(windows, { now: 1000 }), 10, {
      now: 2000
    });
    const orphaned: OutlineState = {
      version: 1,
      rootIds: ["window:20"],
      nodes: {
        "window:20": cloneOutlineNode(previous.nodes["window:20"]!),
        "tab:2": cloneOutlineNode(previous.nodes["tab:2"]!),
        "window:10": cloneOutlineNode(previous.nodes["window:10"]!),
        "tab:1": cloneOutlineNode(previous.nodes["tab:1"]!)
      }
    };
    delete orphaned.nodes["window:10"]!.parentId;

    const guarded = preserveClosedSubtreesAcrossNonDestructiveTransition(previous, orphaned);

    expect([...guarded.restoredNodeIds].sort()).toEqual(["tab:1", "window:10"]);
    expect(guarded.state.rootIds).toEqual(["window:20", "window:10"]);
    expect(guarded.state.nodes["tab:1"]?.parentId).toBe("window:10");
  });

  it("does not revert closed nodes that became live", () => {
    const previous = closeWindow(bootstrapFromWindows(windows, { now: 1000 }), 10, {
      now: 2000
    });
    const restoredWindow = cloneOutlineNode(previous.nodes["window:10"]!);
    restoredWindow.status = "live";
    restoredWindow.live = { windowId: 10 };
    delete restoredWindow.closedAt;
    delete restoredWindow.restore;
    const restoredTab = cloneOutlineNode(previous.nodes["tab:1"]!);
    restoredTab.status = "live";
    restoredTab.live = { tabId: 1, windowId: 10 };
    delete restoredTab.closedAt;
    delete restoredTab.restore;
    const next: OutlineState = {
      version: 1,
      rootIds: ["window:20", "window:10"],
      nodes: {
        "window:20": cloneOutlineNode(previous.nodes["window:20"]!),
        "tab:2": cloneOutlineNode(previous.nodes["tab:2"]!),
        "window:10": restoredWindow,
        "tab:1": restoredTab
      }
    };

    const guarded = preserveClosedSubtreesAcrossNonDestructiveTransition(previous, next);

    expect(guarded.restoredNodeIds).toEqual([]);
    expect(guarded.state).toBe(next);
    expect(guarded.state.nodes["window:10"]?.status).toBe("live");
    expect(guarded.state.nodes["tab:1"]?.status).toBe("live");
  });

  it("allows explicit subtree deletion", () => {
    const previous = closeWindow(bootstrapFromWindows(windows, { now: 1000 }), 10, {
      now: 2000
    });
    const deleted: OutlineState = {
      version: 1,
      rootIds: ["window:20"],
      nodes: {
        "window:20": cloneOutlineNode(previous.nodes["window:20"]!),
        "tab:2": cloneOutlineNode(previous.nodes["tab:2"]!)
      }
    };

    const guarded = preserveClosedSubtreesAcrossNonDestructiveTransition(previous, deleted, {
      allowDeletedNodeIds: new Set(["window:10", "tab:1"])
    });

    expect(guarded.restoredNodeIds).toEqual([]);
    expect(guarded.state).toBe(deleted);
  });
});
