import { describe, expect, it, vi } from "vitest";

import type { BrowserAdapter } from "./adapter.js";
import { isBackgroundCommand, runCommand, syncBrowserOrder } from "./commands.js";
import type { BackgroundCommand, RestoreCreateAttempt } from "./commands.js";
import {
  LARGE_RESTORE_NODE_THRESHOLD,
  bootstrapFromWindows,
  closeTab,
  closeWindow,
  flattenSubtreeOneLevel,
  moveNode,
  promoteChildrenOneLevel
} from "../model/outline.js";
import { PORTABLE_TREE_SCHEMA } from "../model/portable-tree.js";
import type { OutlineState, RuntimeWindow } from "../model/types.js";

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
        url: "https://other.example/",
        title: "Other"
      }
    ]
  }
];

function fakeAdapter(overrides: Partial<BrowserAdapter> = {}): BrowserAdapter {
  return {
    focusTab: vi.fn(async () => undefined),
    closeTab: vi.fn(async () => undefined),
    closeTabs: vi.fn(async () => undefined),
    closeWindow: vi.fn(async () => undefined),
    restoreSession: vi.fn(async () => ({})),
    createTab: vi.fn(async ({ url, windowId = 10 }) => ({
      id: 99,
      windowId,
      index: 0,
      active: true,
      url,
      title: url
    })),
    createWindow: vi.fn(async ({ url }) => {
      const urls = Array.isArray(url) ? url : url ? [url] : [];
      return {
        id: 42,
        focused: true,
        incognito: false,
        tabs: urls.map((tabUrl, index) => ({
          id: 200 + index,
          windowId: 42,
          index,
          active: index === 0,
          url: tabUrl,
          title: tabUrl
        }))
      };
    }),
    moveTabs: vi.fn(async () => undefined),
    ...overrides
  };
}

function stateWithClosedTabs(tabCount: number): OutlineState {
  let state = bootstrapFromWindows([windowWithTabs(10, tabCount)], { now: 1000 });
  for (let tabId = 1; tabId <= tabCount; tabId += 1) {
    state = closeTab(state, tabId, { now: 2000 + tabId });
  }
  return state;
}

function windowWithTabs(windowId: number, tabCount: number): RuntimeWindow {
  return {
    id: windowId,
    focused: true,
    incognito: false,
    tabs: Array.from({ length: tabCount }, (_value, index) => ({
      id: index + 1,
      windowId,
      index,
      active: index === 0,
      url: `https://example.com/${index + 1}`,
      title: `Tab ${index + 1}`
    }))
  };
}

describe("background commands", () => {
  it("recognizes every supported background command variant", () => {
    const supportedCommands = [
      { type: "getState" },
      { type: "focusNode", nodeId: "tab:1" },
      { type: "closeNode", nodeId: "tab:1" },
      { type: "restoreNode", nodeId: "tab:1" },
      { type: "deleteNode", nodeId: "tab:1" },
      { type: "moveNode", nodeId: "tab:1", parentId: "window:10", index: 0 },
      { type: "moveNodeToNewWindow", nodeId: "tab:1", index: 0 },
      { type: "wrapNodeInGroup", nodeId: "tab:1" },
      { type: "moveSubtreeToTopLevel", nodeId: "tab:1" },
      { type: "moveSubtreeToBottomTopLevel", nodeId: "tab:1" },
      { type: "flattenSubtree", nodeId: "window:10" },
      { type: "promoteChildren", nodeId: "tab:1" },
      { type: "toggleCollapsed", nodeId: "tab:1" },
      { type: "expandAncestors", nodeId: "tab:1" },
      { type: "renameGroup", nodeId: "window:10", title: "Research" },
      {
        type: "importTree",
        tree: {
          schema: PORTABLE_TREE_SCHEMA,
          version: 1,
          exportedAt: "2026-05-16T12:00:00.000Z",
          roots: []
        }
      },
      { type: "refresh" }
    ] satisfies BackgroundCommand[];

    expect(supportedCommands.every(isBackgroundCommand)).toBe(true);
  });

  it("rejects unknown background command types", () => {
    expect(isBackgroundCommand({ type: "notACommand" })).toBe(false);
  });

  it("focuses a live tab node", async () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter();

    await runCommand(state, adapter, { type: "focusNode", nodeId: "tab:2" });

    expect(adapter.focusTab).toHaveBeenCalledWith(2, 10);
  });

  it("closes live tab and window nodes through the adapter", async () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter();

    await runCommand(state, adapter, { type: "closeNode", nodeId: "tab:2" });
    await runCommand(state, adapter, { type: "closeNode", nodeId: "window:10" });

    expect(adapter.closeTabs).toHaveBeenCalledWith([2]);
    expect(adapter.closeTab).not.toHaveBeenCalled();
    expect(adapter.closeWindow).toHaveBeenCalledWith(10);
  });

  it("closes live descendants for neutral outline groups without changing outline state immediately", async () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const groupingAdapter = fakeAdapter();
    const grouped = await runCommand(state, groupingAdapter, { type: "wrapNodeInGroup", nodeId: "window:10" });
    const innerGroupId = grouped.state.nodes["window:10"]?.parentId;
    const nested = await runCommand(grouped.state, groupingAdapter, {
      type: "wrapNodeInGroup",
      nodeId: innerGroupId!
    });
    const outerGroupId = nested.state.nodes[innerGroupId!]?.parentId;
    const closeAdapter = fakeAdapter();

    const result = await runCommand(nested.state, closeAdapter, {
      type: "closeNode",
      nodeId: outerGroupId!
    });

    expect(closeAdapter.closeWindow).toHaveBeenCalledWith(10);
    expect(closeAdapter.closeTabs).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(result.state).toBe(nested.state);
    expect(result.state.nodes[outerGroupId!]?.status).toBe("neutral");
    expect(result.state.nodes["window:10"]?.status).toBe("live");
  });

  it("closes live descendants for closed parent groups without restoring the parent", async () => {
    const base = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const state: OutlineState = {
      ...base,
      rootIds: ["window:closed-parent"],
      nodes: {
        ...base.nodes,
        "window:closed-parent": {
          id: "window:closed-parent",
          kind: "window",
          status: "closed",
          title: "Group",
          childIds: ["window:10"],
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          closedAt: 1000,
          restore: { sessionId: "session-closed-parent" }
        },
        "window:10": {
          ...base.nodes["window:10"]!,
          parentId: "window:closed-parent"
        }
      }
    };
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, {
      type: "closeNode",
      nodeId: "window:closed-parent"
    });

    expect(adapter.closeWindow).toHaveBeenCalledWith(10);
    expect(adapter.restoreSession).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(result.state).toBe(state);
  });

  it("deletes closed nodes without closing promoted live children", async () => {
    const state = closeTab(bootstrapFromWindows(runtimeWindows, { now: 1000 }), 1, {
      now: 2000,
      sessionId: "session-tab-1"
    });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, { type: "deleteNode", nodeId: "tab:1" });

    expect(adapter.closeTab).not.toHaveBeenCalled();
    expect(adapter.closeWindow).not.toHaveBeenCalled();
    expect(result.state.nodes["tab:1"]).toBeUndefined();
    expect(result.state.nodes["tab:2"]?.status).toBe("live");
    expect(result.state.nodes["tab:2"]?.parentId).toBe("window:10");
    expect(result.state.nodes["window:10"]?.childIds).toEqual(["tab:2", "tab:3"]);
  });

  it("closes live tab subtrees before deleting them", async () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, { type: "deleteNode", nodeId: "tab:1" });

    expect(adapter.closeTabs).toHaveBeenCalledWith([2, 1]);
    expect(adapter.closeTabs).toHaveBeenCalledTimes(1);
    expect(adapter.closeTab).not.toHaveBeenCalled();
    expect(adapter.closeWindow).not.toHaveBeenCalled();
    expect(result.state.nodes["tab:1"]).toBeUndefined();
    expect(result.state.nodes["tab:2"]).toBeUndefined();
    expect(result.state.nodes["window:10"]?.childIds).toEqual(["tab:3"]);
  });

  it("batches large live tab subtree deletes into one runtime close", async () => {
    const tabCount = 100;
    const state = bootstrapFromWindows([
      {
        id: 10,
        focused: true,
        incognito: false,
        tabs: Array.from({ length: tabCount }, (_value, index) => ({
          id: index + 1,
          windowId: 10,
          index,
          active: index === 0,
          ...(index > 0 ? { openerTabId: index } : {}),
          url: `https://example.com/${index + 1}`,
          title: `Tab ${index + 1}`
        }))
      }
    ], { now: 1000 });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, { type: "deleteNode", nodeId: "tab:1" });

    expect(adapter.closeTabs).toHaveBeenCalledTimes(1);
    expect(adapter.closeTabs).toHaveBeenCalledWith(
      Array.from({ length: tabCount }, (_value, index) => tabCount - index)
    );
    expect(adapter.closeTab).not.toHaveBeenCalled();
    expect(Object.keys(result.state.nodes)).toHaveLength(0);
  });

  it("closes live windows before deleting them", async () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, { type: "deleteNode", nodeId: "window:10" });

    expect(adapter.closeWindow).toHaveBeenCalledWith(10);
    expect(adapter.closeTab).not.toHaveBeenCalled();
    expect(result.state.rootIds).toEqual([]);
    expect(result.state.nodes).toEqual({});
  });

  it("restores with native sessions before falling back to urls", async () => {
    const state = closeTab(bootstrapFromWindows(runtimeWindows, { now: 1000 }), 2, {
      now: 2000,
      sessionId: "session-tab-2"
    });
    const adapter = fakeAdapter({
      restoreSession: vi.fn(async () => ({
        tab: {
          id: 22,
          windowId: 10,
          index: 2,
          active: true,
          url: "https://example.com/child",
          title: "Child"
        }
      }))
    });

    const result = await runCommand(state, adapter, { type: "restoreNode", nodeId: "tab:2" });

    expect(adapter.restoreSession).toHaveBeenCalledWith("session-tab-2");
    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(result.state.nodes["tab:2"]?.live).toEqual({ tabId: 22, windowId: 10 });
  });

  it("falls back to opening stored urls when session restore fails", async () => {
    const state = closeTab(bootstrapFromWindows(runtimeWindows, { now: 1000 }), 2, {
      now: 2000,
      sessionId: "session-tab-2"
    });
    const adapter = fakeAdapter({
      restoreSession: vi.fn(async () => {
        throw new Error("expired");
      }),
      createTab: vi.fn(async () => ({
        id: 23,
        windowId: 10,
        index: 2,
        active: true,
        url: "https://example.com/child",
        title: "Child"
      }))
    });

    const result = await runCommand(state, adapter, { type: "restoreNode", nodeId: "tab:2" });

    expect(adapter.createTab).toHaveBeenCalledWith({
      url: "https://example.com/child",
      windowId: 10,
      active: false,
      index: 1
    });
    expect(result.state.nodes["tab:2"]?.live).toEqual({ tabId: 23, windowId: 10 });
  });

  it("records restore tab create attempts for command-side recovery", async () => {
    const state = closeTab(bootstrapFromWindows(runtimeWindows, { now: 1000 }), 2, {
      now: 2000,
      sessionId: "session-tab-2"
    });
    const adapter = fakeAdapter({
      restoreSession: vi.fn(async () => {
        throw new Error("expired");
      })
    });
    const attempts: RestoreCreateAttempt[] = [];

    await runCommand(state, adapter, { type: "restoreNode", nodeId: "tab:2" }, {
      restoreObserver: {
        recordCreateAttempt: (attempt) => attempts.push(attempt)
      }
    });

    expect(attempts).toEqual([
      {
        kind: "tab",
        nodeId: "tab:2",
        windowNodeId: "window:10",
        createProperties: {
          url: "https://example.com/child",
          windowId: 10,
          active: false,
          index: 1
        }
      }
    ]);
  });

  it("skips invalid restore fallback URLs instead of creating browser tabs", async () => {
    const state = closeTab(bootstrapFromWindows(runtimeWindows, { now: 1000 }), 2, {
      now: 2000,
      sessionId: "session-tab-2"
    });
    const closedTab = state.nodes["tab:2"];
    if (closedTab?.restore) {
      closedTab.restore.url = "about home";
    }
    const adapter = fakeAdapter({
      restoreSession: vi.fn(async () => {
        throw new Error("expired");
      }),
      createTab: vi.fn(async ({ url, windowId = 10 }) => {
        if (url === "about home") {
          throw new Error("illegal url: about home");
        }
        return {
          id: 24,
          windowId,
          index: 2,
          active: false,
          url,
          title: url
        };
      })
    });

    const result = await runCommand(state, adapter, { type: "restoreNode", nodeId: "tab:2" });

    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(result.state.nodes["tab:2"]?.status).toBe("closed");
  });

  it("records restore window create attempts for command-side recovery", async () => {
    const state = closeWindow(bootstrapFromWindows([
      ...runtimeWindows,
      {
        id: 20,
        focused: false,
        incognito: false,
        tabs: [
          {
            id: 5,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://solo.example/",
            title: "Solo"
          }
        ]
      }
    ], { now: 1000 }), 20, { now: 2000 });
    const adapter = fakeAdapter();
    const attempts: RestoreCreateAttempt[] = [];

    await runCommand(state, adapter, { type: "restoreNode", nodeId: "tab:5" }, {
      restoreObserver: {
        recordCreateAttempt: (attempt) => attempts.push(attempt)
      }
    });

    expect(attempts).toEqual([
      {
        kind: "window",
        windowNodeId: "window:20",
        tabNodeIds: ["tab:5"],
        urls: ["https://solo.example/"],
        createData: {
          url: "https://solo.example/"
        }
      }
    ]);
  });

  it("records multi-tab closed-window restore create attempts for command-side recovery", async () => {
    const state = closeWindow(bootstrapFromWindows([
      {
        id: 20,
        focused: true,
        incognito: false,
        tabs: [
          {
            id: 5,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://one.example/",
            title: "One"
          },
          {
            id: 6,
            windowId: 20,
            index: 1,
            active: false,
            url: "https://two.example/",
            title: "Two"
          }
        ]
      }
    ], { now: 1000 }), 20, { now: 2000 });
    const adapter = fakeAdapter();
    const attempts: RestoreCreateAttempt[] = [];

    await runCommand(state, adapter, { type: "restoreNode", nodeId: "window:20" }, {
      restoreObserver: {
        recordCreateAttempt: (attempt) => attempts.push(attempt)
      }
    });

    expect(attempts).toEqual([
      {
        kind: "window",
        windowNodeId: "window:20",
        tabNodeIds: ["tab:5", "tab:6"],
        urls: ["https://one.example/", "https://two.example/"],
        createData: {
          url: ["https://one.example/", "https://two.example/"]
        }
      }
    ]);
  });

  it("records restored session tab moves into closed-window destinations", async () => {
    const state = closeTab(bootstrapFromWindows(runtimeWindows, { now: 1000 }), 1, {
      now: 2000,
      sessionId: "session-tab-1"
    });
    const adapter = fakeAdapter({
      restoreSession: vi.fn(async () => ({
        tab: {
          id: 21,
          windowId: 10,
          index: 0,
          active: true,
          url: "https://example.com/parent",
          title: "Parent"
        }
      })),
      createWindow: vi.fn(async ({ tabId }) => ({
        id: 42,
        focused: true,
        incognito: false,
        tabs: typeof tabId === "number"
          ? [
              {
                id: tabId,
                windowId: 42,
                index: 0,
                active: true,
                url: "https://example.com/parent",
                title: "Parent"
              }
            ]
          : []
      }))
    });
    const moved = await runCommand(state, adapter, {
      type: "moveNodeToNewWindow",
      nodeId: "tab:1"
    });
    const placeholderId = moved.state.rootIds.at(-1)!;
    const attempts: RestoreCreateAttempt[] = [];

    await runCommand(moved.state, adapter, { type: "restoreNode", nodeId: placeholderId }, {
      restoreObserver: {
        recordCreateAttempt: (attempt) => attempts.push(attempt)
      }
    });

    expect(attempts).toEqual([
      {
        kind: "window",
        windowNodeId: placeholderId,
        tabNodeIds: ["tab:1"],
        createData: {
          tabId: 21
        }
      }
    ]);
  });

  it("does not use broad order sync to pull browser-detached tabs across windows", async () => {
    const state = moveNode(bootstrapFromWindows([
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
            url: "https://source.example/one",
            title: "Source One"
          },
          {
            id: 2,
            windowId: 10,
            index: 1,
            active: false,
            url: "https://source.example/two",
            title: "Source Two"
          }
        ]
      },
      {
        id: 20,
        focused: false,
        incognito: false,
        tabs: [
          {
            id: 3,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://detached.example/",
            title: "Detached"
          }
        ]
      }
    ], { now: 1000 }), "tab:2", { parentId: "window:20", index: 1 });
    const adapter = fakeAdapter();

    await syncBrowserOrder(state, adapter);

    expect(adapter.moveTabs).toHaveBeenCalledWith([1], { windowId: 10, index: 0 });
    expect(adapter.moveTabs).toHaveBeenCalledWith([3], { windowId: 20, index: 0 });
    expect(adapter.moveTabs).not.toHaveBeenCalledWith(
      expect.arrayContaining([2]),
      expect.objectContaining({ windowId: 20 })
    );
  });

  it("refuses large restores that have not been confirmed", async () => {
    const state = stateWithClosedTabs(LARGE_RESTORE_NODE_THRESHOLD + 1);
    const adapter = fakeAdapter();

    await expect(runCommand(state, adapter, {
      type: "restoreNode",
      nodeId: "window:10"
    })).rejects.toThrow(/26 restorable closed nodes/);

    expect(adapter.restoreSession).not.toHaveBeenCalled();
    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(adapter.createWindow).not.toHaveBeenCalled();
  });

  it("restores large scopes after explicit confirmation", async () => {
    const state = stateWithClosedTabs(LARGE_RESTORE_NODE_THRESHOLD + 1);
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, {
      type: "restoreNode",
      nodeId: "window:10",
      confirmedLargeRestore: true
    });

    expect(adapter.createTab).toHaveBeenCalledTimes(LARGE_RESTORE_NODE_THRESHOLD + 1);
    expect(result.state.nodes["tab:1"]?.status).toBe("live");
    expect(result.state.nodes[`tab:${LARGE_RESTORE_NODE_THRESHOLD + 1}`]?.status).toBe("live");
  });

  it("restores threshold-sized scopes without confirmation", async () => {
    const state = stateWithClosedTabs(LARGE_RESTORE_NODE_THRESHOLD);
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, {
      type: "restoreNode",
      nodeId: "window:10"
    });

    expect(adapter.createTab).toHaveBeenCalledTimes(LARGE_RESTORE_NODE_THRESHOLD);
    expect(result.state.nodes["tab:1"]?.status).toBe("live");
    expect(result.state.nodes[`tab:${LARGE_RESTORE_NODE_THRESHOLD}`]?.status).toBe("live");
  });

  it("restores closed window URL fallbacks with one multi-url window create", async () => {
    const state = closeWindow(bootstrapFromWindows([
      {
        id: 20,
        focused: true,
        incognito: false,
        tabs: [
          {
            id: 1,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://example.com/one",
            title: "One"
          },
          {
            id: 2,
            windowId: 20,
            index: 1,
            active: false,
            url: "https://example.com/two",
            title: "Two"
          },
          {
            id: 3,
            windowId: 20,
            index: 2,
            active: false,
            url: "https://example.com/three",
            title: "Three"
          }
        ]
      }
    ], { now: 1000 }), 20, { now: 2000 });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, { type: "restoreNode", nodeId: "window:20" });

    expect(adapter.createWindow).toHaveBeenCalledTimes(1);
    expect(adapter.createWindow).toHaveBeenCalledWith({
      url: [
        "https://example.com/one",
        "https://example.com/two",
        "https://example.com/three"
      ]
    });
    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(result.state.nodes["window:20"]?.live).toEqual({ windowId: 42 });
    expect(result.state.nodes["window:20"]?.active).toBe(true);
    expect(result.state.nodes["tab:1"]?.live).toEqual({ tabId: 200, windowId: 42 });
    expect(result.state.nodes["tab:2"]?.live).toEqual({ tabId: 201, windowId: 42 });
    expect(result.state.nodes["tab:3"]?.live).toEqual({ tabId: 202, windowId: 42 });
  });

  it("restores renamed closed tab groups with one multi-url window create", async () => {
    let state: OutlineState = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    state = closeTab(state, 1, { now: 2001, sessionId: "session-tab-1" });
    state = closeTab(state, 2, { now: 2002, sessionId: "session-tab-2" });
    const groupId = "window:placeholder:3000";
    state = {
      ...state,
      rootIds: [groupId, "window:10"],
      nodes: {
        ...state.nodes,
        [groupId]: {
          id: groupId,
          kind: "window",
          status: "closed",
          title: "voyager trackpad",
          customTitle: "voyager trackpad",
          childIds: ["tab:1", "tab:2"],
          collapsed: false,
          createdAt: 3000,
          updatedAt: 3000,
          closedAt: 3000
        },
        "window:10": {
          ...state.nodes["window:10"]!,
          childIds: ["tab:3"]
        },
        "tab:1": {
          ...state.nodes["tab:1"]!,
          parentId: groupId
        },
        "tab:2": {
          ...state.nodes["tab:2"]!,
          parentId: groupId
        }
      }
    };
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, { type: "restoreNode", nodeId: groupId });

    expect(adapter.restoreSession).not.toHaveBeenCalled();
    expect(adapter.createWindow).toHaveBeenCalledTimes(1);
    expect(adapter.createWindow).toHaveBeenCalledWith({
      url: ["https://example.com/", "https://example.com/child"]
    });
    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(result.state.nodes[groupId]?.status).toBe("live");
    expect(result.state.nodes[groupId]?.live).toEqual({ windowId: 42 });
    expect(result.state.nodes[groupId]?.customTitle).toBe("voyager trackpad");
    expect(result.state.nodes["tab:1"]?.live).toEqual({ tabId: 200, windowId: 42 });
    expect(result.state.nodes["tab:2"]?.live).toEqual({ tabId: 201, windowId: 42 });
  });

  it("restores a closed tab moved into a previously closed window after that window session", async () => {
    let state = bootstrapFromWindows([
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
            url: "https://original.example/",
            title: "Original"
          }
        ]
      },
      {
        id: 20,
        focused: false,
        incognito: false,
        tabs: [
          {
            id: 2,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://detached.example/",
            title: "Detached"
          }
        ]
      }
    ], { now: 1000 });
    state = closeWindow(state, 20, { now: 2000, sessionId: "session-window-20" });
    state = closeWindow(state, 10, { now: 3000, sessionId: "session-window-10" });
    state = moveNode(state, "tab:2", { parentId: "window:10", index: 1 });
    const adapter = fakeAdapter({
      restoreSession: vi.fn(async (sessionId) => {
        if (sessionId !== "session-window-10") {
          return {};
        }
        return {
          window: {
            id: 42,
            focused: true,
            incognito: false,
            tabs: [
              {
                id: 200,
                windowId: 42,
                index: 0,
                active: true,
                url: "https://original.example/",
                title: "Original"
              }
            ]
          }
        };
      }),
      createTab: vi.fn(async ({ url, windowId = 10 }) => ({
        id: 201,
        windowId,
        index: 1,
        active: false,
        url,
        title: url
      }))
    });

    const result = await runCommand(state, adapter, { type: "restoreNode", nodeId: "window:10" });

    expect(adapter.restoreSession).toHaveBeenCalledWith("session-window-10");
    expect(adapter.createWindow).not.toHaveBeenCalled();
    expect(adapter.createTab).toHaveBeenCalledWith({
      url: "https://detached.example/",
      windowId: 42,
      active: false,
      index: 1
    });
    expect(result.state.nodes["window:10"]?.live).toEqual({ windowId: 42 });
    expect(result.state.nodes["tab:1"]?.live).toEqual({ tabId: 200, windowId: 42 });
    expect(result.state.nodes["tab:2"]?.live).toEqual({ tabId: 201, windowId: 42 });
  });

  it("restores an earlier closed tab moved into a window session that returns no tab list", async () => {
    let state = bootstrapFromWindows([
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
            url: "https://calendar.example/week",
            title: "Google Calendar - Week of May 25, 2026"
          }
        ]
      },
      {
        id: 20,
        focused: false,
        incognito: false,
        tabs: [
          {
            id: 2,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://calendar.example/week",
            title: "Google Calendar - Week of May 25, 2026"
          }
        ]
      }
    ], { now: 1000 });
    state = closeWindow(state, 20, { now: 2000, sessionId: "session-window-20" });
    state = closeWindow(state, 10, { now: 3000, sessionId: "session-window-10" });
    state = moveNode(state, "tab:2", { parentId: "window:10", index: 1 });
    const adapter = fakeAdapter({
      restoreSession: vi.fn(async (sessionId) => {
        if (sessionId !== "session-window-10") {
          return {};
        }
        return {
          window: {
            id: 42,
            focused: true,
            incognito: false
          }
        };
      }),
      createTab: vi.fn(async ({ url, windowId = 10 }) => ({
        id: 201,
        windowId,
        index: 1,
        active: false,
        url,
        title: url
      }))
    });

    const result = await runCommand(state, adapter, { type: "restoreNode", nodeId: "window:10" });

    expect(adapter.restoreSession).toHaveBeenCalledWith("session-window-10");
    expect(adapter.createTab).toHaveBeenCalledTimes(1);
    expect(adapter.createTab).toHaveBeenCalledWith({
      url: "https://calendar.example/week",
      windowId: 42,
      active: false,
      index: 1
    });
    expect(result.state.nodes["window:10"]?.live).toEqual({ windowId: 42 });
    expect(result.state.nodes["tab:2"]?.live).toEqual({ tabId: 201, windowId: 42 });
  });

  it("restores a single-tab closed window when the browser returns a tab session", async () => {
    let state = bootstrapFromWindows([
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
            url: "https://calendar.example/week",
            title: "Google Calendar - Week of May 25, 2026"
          }
        ]
      }
    ], { now: 1000 });
    state = closeWindow(state, 10, { now: 2000, sessionId: "session-window-10" });
    const adapter = fakeAdapter({
      restoreSession: vi.fn(async () => ({
        tab: {
          id: 201,
          windowId: 42,
          index: 0,
          active: true,
          url: "https://calendar.example/week",
          title: "Google Calendar - Week of May 25, 2026"
        }
      }))
    });

    const result = await runCommand(state, adapter, { type: "restoreNode", nodeId: "window:10" });

    expect(result.state.nodes["window:10"]?.live).toEqual({ windowId: 42 });
    expect(result.state.nodes["tab:1"]?.live).toEqual({ tabId: 201, windowId: 42 });
    expect(result.state.nodes["window:10"]?.childIds).toEqual(["tab:1"]);
  });

  it("moves a restored tab session into its current outline window", async () => {
    let state = bootstrapFromWindows([
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
            url: "https://calendar.example/week",
            title: "Google Calendar - Week of May 25, 2026"
          }
        ]
      },
      {
        id: 20,
        focused: false,
        incognito: false,
        tabs: [
          {
            id: 2,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://calendar.example/week",
            title: "Google Calendar - Week of May 25, 2026"
          }
        ]
      }
    ], { now: 1000 });
    state = closeTab(state, 2, { now: 2000, sessionId: "session-tab-2" });
    state = closeTab(state, 1, { now: 3000, sessionId: "session-tab-1" });
    state = moveNode(state, "tab:2", { parentId: "window:10", index: 1 });
    const adapter = fakeAdapter({
      restoreSession: vi.fn(async (sessionId) => ({
        tab: {
          id: sessionId === "session-tab-1" ? 201 : 202,
          windowId: sessionId === "session-tab-1" ? 10 : 20,
          index: 0,
          active: false,
          url: "https://calendar.example/week",
          title: "Google Calendar - Week of May 25, 2026"
        }
      }))
    });

    const result = await runCommand(state, adapter, { type: "restoreNode", nodeId: "window:10" });

    expect(adapter.restoreSession).toHaveBeenCalledWith("session-tab-1");
    expect(adapter.restoreSession).toHaveBeenCalledWith("session-tab-2");
    expect(adapter.moveTabs).toHaveBeenCalledWith([202], { windowId: 10, index: 1 });
    expect(result.state.nodes["tab:1"]?.live).toEqual({ tabId: 201, windowId: 10 });
    expect(result.state.nodes["tab:2"]?.live).toEqual({ tabId: 202, windowId: 10 });
    expect(result.state.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:2"]);
  });

  it("restores a nested closed detached window moved under a previously closed group", async () => {
    let state = bootstrapFromWindows([
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
            url: "https://calendar.example/week",
            title: "Google Calendar - Week of May 25, 2026"
          }
        ]
      },
      {
        id: 20,
        focused: false,
        incognito: false,
        tabs: [
          {
            id: 2,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://calendar.example/week",
            title: "Google Calendar - Week of May 25, 2026"
          }
        ]
      }
    ], { now: 1000 });
    state = closeWindow(state, 20, { now: 2000, sessionId: "session-window-20" });
    state = closeWindow(state, 10, { now: 3000, sessionId: "session-window-10" });
    state = moveNode(state, "window:20", { parentId: "window:10", index: 1 });
    const adapter = fakeAdapter({
      restoreSession: vi.fn(async (sessionId) => ({
        window: {
          id: sessionId === "session-window-10" ? 42 : 43,
          focused: sessionId === "session-window-10",
          incognito: false,
          tabs: [
            {
              id: sessionId === "session-window-10" ? 201 : 202,
              windowId: sessionId === "session-window-10" ? 42 : 43,
              index: 0,
              active: true,
              url: "https://calendar.example/week",
              title: "Google Calendar - Week of May 25, 2026"
            }
          ]
        }
      }))
    });

    const result = await runCommand(state, adapter, { type: "restoreNode", nodeId: "window:10" });

    expect(adapter.restoreSession).toHaveBeenCalledWith("session-window-10");
    expect(adapter.restoreSession).toHaveBeenCalledWith("session-window-20");
    expect(result.state.nodes["window:10"]?.live).toEqual({ windowId: 42 });
    expect(result.state.nodes["tab:1"]?.live).toEqual({ tabId: 201, windowId: 42 });
    expect(result.state.nodes["window:20"]?.live).toEqual({ windowId: 43 });
    expect(result.state.nodes["tab:2"]?.live).toEqual({ tabId: 202, windowId: 43 });
  });

  it("uses the owning closed window session when restoring its only tab", async () => {
    const url = "moz-extension://one-sec/dashboard.html";
    const state = closeWindow(bootstrapFromWindows([
      ...runtimeWindows,
      {
        id: 20,
        focused: false,
        incognito: false,
        tabs: [
          {
            id: 5,
            windowId: 20,
            index: 0,
            active: true,
            url,
            title: "Dashboard | one sec"
          }
        ]
      }
    ], { now: 1000 }), 20, {
      now: 2000,
      sessionId: "session-window-20"
    });
    const adapter = fakeAdapter({
      restoreSession: vi.fn(async () => ({
        window: {
          id: 42,
          focused: true,
          incognito: false,
          tabs: [
            {
              id: 200,
              windowId: 42,
              index: 0,
              active: true,
              url,
              title: "Dashboard | one sec"
            }
          ]
        }
      })),
      createWindow: vi.fn(async () => {
        throw new Error("Illegal URL");
      })
    });

    const result = await runCommand(state, adapter, { type: "restoreNode", nodeId: "tab:5" });

    expect(adapter.restoreSession).toHaveBeenCalledWith("session-window-20");
    expect(adapter.createWindow).not.toHaveBeenCalled();
    expect(result.state.nodes["window:20"]?.status).toBe("live");
    expect(result.state.nodes["window:20"]?.live).toEqual({ windowId: 42 });
    expect(result.state.nodes["window:20"]?.active).toBe(true);
    expect(result.state.nodes["window:10"]?.active).toBe(false);
    expect(result.state.nodes["tab:5"]?.status).toBe("live");
    expect(result.state.nodes["tab:5"]?.live).toEqual({ tabId: 200, windowId: 42 });
  });

  it("restores a tab from a closed single-tab window into a new window", async () => {
    const state = closeWindow(bootstrapFromWindows([
      ...runtimeWindows,
      {
        id: 20,
        focused: false,
        incognito: false,
        tabs: [
          {
            id: 5,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://solo.example/",
            title: "Solo"
          }
        ]
      }
    ], { now: 1000 }), 20, {
      now: 2000,
      sessionId: "session-window-20"
    });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, { type: "restoreNode", nodeId: "tab:5" });

    expect(adapter.createWindow).toHaveBeenCalledWith({ url: "https://solo.example/" });
    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(result.state.nodes["window:20"]?.status).toBe("live");
    expect(result.state.nodes["window:20"]?.live).toEqual({ windowId: 42 });
    expect(result.state.nodes["window:20"]?.active).toBe(true);
    expect(result.state.nodes["window:10"]?.active).toBe(false);
    expect(result.state.nodes["window:20"]?.childIds).toEqual(["tab:5"]);
    expect(result.state.nodes["tab:5"]?.parentId).toBe("window:20");
    expect(result.state.nodes["tab:5"]?.live).toEqual({ tabId: 200, windowId: 42 });
  });

  it("restores a closed new-tab node in a live window as browser-safe about blank", async () => {
    const state = closeTab(bootstrapFromWindows([
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
            url: "about:newtab",
            title: "New Tab"
          }
        ]
      }
    ], { now: 1000 }), 2, { now: 2000 });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, { type: "restoreNode", nodeId: "tab:2" });

    expect(adapter.createTab).toHaveBeenCalledWith({
      url: "about:blank",
      windowId: 10,
      active: false,
      index: 1
    });
    expect(adapter.createTab).not.toHaveBeenCalledWith(expect.objectContaining({ url: "about:newtab" }));
    expect(result.state.nodes["tab:2"]?.status).toBe("live");
    expect(result.state.nodes["tab:2"]?.live).toEqual({ tabId: 99, windowId: 10 });
  });

  it("restores a closed blank-only window with browser-safe about blank urls", async () => {
    const state = closeWindow(bootstrapFromWindows([
      {
        id: 20,
        focused: true,
        incognito: false,
        tabs: [
          {
            id: 5,
            windowId: 20,
            index: 0,
            active: true,
            url: "about:newtab",
            title: "New Tab"
          },
          {
            id: 6,
            windowId: 20,
            index: 1,
            active: false,
            url: "about:blank",
            title: "New Tab"
          }
        ]
      }
    ], { now: 1000 }), 20, { now: 2000 });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, { type: "restoreNode", nodeId: "window:20" });

    expect(adapter.createWindow).toHaveBeenCalledWith({ url: ["about:blank", "about:blank"] });
    expect(adapter.createWindow).not.toHaveBeenCalledWith(expect.objectContaining({ url: expect.arrayContaining(["about:newtab"]) }));
    expect(result.state.nodes["window:20"]?.status).toBe("live");
    expect(result.state.nodes["tab:5"]?.live).toEqual({ tabId: 200, windowId: 42 });
    expect(result.state.nodes["tab:6"]?.live).toEqual({ tabId: 201, windowId: 42 });
  });

  it("does not fall through to child url restore when a window session reports no tabs yet", async () => {
    const url = "about:debugging#/runtime/this-firefox";
    const state = closeWindow(bootstrapFromWindows([
      ...runtimeWindows,
      {
        id: 20,
        focused: false,
        incognito: false,
        tabs: [
          {
            id: 5,
            windowId: 20,
            index: 0,
            active: true,
            url,
            title: "Debugging - Runtime / this-firefox"
          }
        ]
      }
    ], { now: 1000 }), 20, {
      now: 2000,
      sessionId: "session-window-20"
    });
    const adapter = fakeAdapter({
      restoreSession: vi.fn(async () => ({
        window: {
          id: 42,
          focused: true,
          incognito: false,
          tabs: []
        }
      })),
      createTab: vi.fn(async () => {
        throw new Error("Internal URL cannot be created directly");
      })
    });

    const result = await runCommand(state, adapter, { type: "restoreNode", nodeId: "window:20" });

    expect(adapter.restoreSession).toHaveBeenCalledWith("session-window-20");
    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(adapter.createWindow).not.toHaveBeenCalled();
    expect(result.state.nodes["window:20"]?.status).toBe("live");
    expect(result.state.nodes["window:20"]?.live).toEqual({ windowId: 42 });
    expect(result.state.nodes["tab:5"]?.status).toBe("closed");
  });

  it("moves outline nodes and asks Firefox to move the changed preorder segment", async () => {
    const state: OutlineState = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, {
      type: "moveNode",
      nodeId: "tab:3",
      parentId: "tab:1",
      index: 0
    });

    expect(result.state).toEqual(moveNode(state, "tab:3", { parentId: "tab:1", index: 0 }));
    expect(adapter.moveTabs).toHaveBeenCalledWith([3], { windowId: 10, index: 1 });
    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(adapter.createWindow).not.toHaveBeenCalled();
    expect(result.state.nodes["tab:3"]?.live).toEqual({ tabId: 3, windowId: 10 });
  });

  it("moves one leaf tab instead of syncing a whole 50k-tab window after drag/drop", async () => {
    const tabCount = 50_000;
    const state: OutlineState = bootstrapFromWindows([
      {
        id: 10,
        focused: true,
        incognito: false,
        tabs: Array.from({ length: tabCount }, (_value, index) => ({
          id: index + 1,
          windowId: 10,
          index,
          active: index === 0,
          url: `https://large.example/${index + 1}`,
          title: `Tab ${index + 1}`
        }))
      }
    ], { now: 1000 });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, {
      type: "moveNode",
      nodeId: `tab:${tabCount}`,
      parentId: "window:10",
      index: 0
    });
    const firstMoveCall = vi.mocked(adapter.moveTabs).mock.calls[0];
    const movedTabIds = firstMoveCall?.[0];

    expect(result.state.nodes["window:10"]?.childIds[0]).toBe(`tab:${tabCount}`);
    expect(adapter.moveTabs).toHaveBeenCalledTimes(1);
    expect(Array.isArray(movedTabIds) ? movedTabIds.length : 1).toBe(1);
    expect(adapter.moveTabs).toHaveBeenCalledWith([tabCount], { windowId: 10, index: 0 });
  });

  it("flattens outline subtrees without asking Firefox to reorder tabs", async () => {
    const state: OutlineState = moveNode(bootstrapFromWindows(runtimeWindows, { now: 1000 }), "tab:3", {
      parentId: "tab:2",
      index: 0
    });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, {
      type: "flattenSubtree",
      nodeId: "window:10"
    });

    expect(result.state).toEqual(flattenSubtreeOneLevel(state, "window:10"));
    expect(adapter.moveTabs).not.toHaveBeenCalled();
  });

  it("promotes children without asking Firefox to reorder tabs", async () => {
    const state: OutlineState = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, {
      type: "promoteChildren",
      nodeId: "tab:1"
    });

    expect(result.state).toEqual(promoteChildrenOneLevel(state, "tab:1"));
    expect(result.state.nodes["window:10"]?.childIds).toEqual(["tab:1", "tab:2", "tab:3"]);
    expect(result.state.nodes["tab:1"]?.childIds).toEqual([]);
    expect(adapter.moveTabs).not.toHaveBeenCalled();
  });

  it("wraps live tabs by creating a Firefox window group and moving subtree descendants", async () => {
    const state: OutlineState = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, {
      type: "wrapNodeInGroup",
      nodeId: "tab:1"
    });

    expect(adapter.createWindow).toHaveBeenCalledWith({ tabId: 1 });
    expect(result.state.nodes["window:10"]?.childIds).toEqual(["window:42", "tab:3"]);
    expect(result.state.nodes["window:42"]).toMatchObject({
      kind: "window",
      status: "live",
      parentId: "window:10",
      childIds: ["tab:1"],
      live: { windowId: 42 }
    });
    expect(result.state.nodes["tab:1"]?.live).toEqual({ tabId: 1, windowId: 42 });
    expect(result.state.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: 42 });
    expect(adapter.moveTabs).toHaveBeenCalledTimes(1);
    expect(adapter.moveTabs).toHaveBeenCalledWith([2], { windowId: 42, index: 1 });
  });

  it("wraps one live leaf tab without syncing a whole large source window", async () => {
    const tabCount = 50_000;
    const state: OutlineState = bootstrapFromWindows([windowWithTabs(10, tabCount)], { now: 1000 });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, {
      type: "wrapNodeInGroup",
      nodeId: "tab:1"
    });

    expect(result.state.nodes["window:10"]?.childIds[0]).toBe("window:42");
    expect(result.state.nodes["window:42"]?.childIds).toEqual(["tab:1"]);
    expect(adapter.createWindow).toHaveBeenCalledWith({ tabId: 1 });
    expect(adapter.moveTabs).not.toHaveBeenCalled();
  });

  it("wraps closed tabs in closed window groups without touching Firefox", async () => {
    const state = closeTab(bootstrapFromWindows(runtimeWindows, { now: 1000 }), 1, {
      now: 2000,
      sessionId: "session-tab-1"
    });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, {
      type: "wrapNodeInGroup",
      nodeId: "tab:1"
    });
    const wrapperId = result.state.nodes["tab:1"]?.parentId;

    expect(wrapperId).toMatch(/^window:placeholder:/);
    expect(result.state.nodes[wrapperId!]).toMatchObject({
      kind: "window",
      status: "closed",
      childIds: ["tab:1"]
    });
    expect(adapter.focusTab).not.toHaveBeenCalled();
    expect(adapter.closeTab).not.toHaveBeenCalled();
    expect(adapter.closeWindow).not.toHaveBeenCalled();
    expect(adapter.restoreSession).not.toHaveBeenCalled();
    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(adapter.createWindow).not.toHaveBeenCalled();
    expect(adapter.moveTabs).not.toHaveBeenCalled();
  });

  it("wraps existing window rows in neutral outline groups without touching Firefox", async () => {
    const state: OutlineState = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, {
      type: "wrapNodeInGroup",
      nodeId: "window:10"
    });
    const wrapperId = result.state.nodes["window:10"]?.parentId;

    expect(wrapperId).toMatch(/^group:/);
    expect(result.state.rootIds).toEqual([wrapperId]);
    expect(result.state.nodes[wrapperId!]).toMatchObject({
      kind: "group",
      status: "neutral",
      childIds: ["window:10"]
    });
    expect(adapter.focusTab).not.toHaveBeenCalled();
    expect(adapter.closeTab).not.toHaveBeenCalled();
    expect(adapter.closeWindow).not.toHaveBeenCalled();
    expect(adapter.restoreSession).not.toHaveBeenCalled();
    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(adapter.createWindow).not.toHaveBeenCalled();
    expect(adapter.moveTabs).not.toHaveBeenCalled();
  });

  it("moves group-like subtrees to top level without touching Firefox", async () => {
    const wrapped = await runCommand(bootstrapFromWindows([
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
            url: "https://one.example/",
            title: "One"
          }
        ]
      },
      {
        id: 20,
        focused: false,
        incognito: false,
        tabs: [
          {
            id: 2,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://two.example/",
            title: "Two"
          }
        ]
      }
    ], { now: 1000 }), fakeAdapter(), {
      type: "wrapNodeInGroup",
      nodeId: "window:10"
    });
    const wrapperId = wrapped.state.nodes["window:10"]?.parentId;
    const nested = moveNode(wrapped.state, "window:20", { parentId: wrapperId, index: 1 });
    const adapter = fakeAdapter();

    const result = await runCommand(nested, adapter, {
      type: "moveSubtreeToTopLevel",
      nodeId: "window:10"
    });

    expect(result.state.rootIds).toEqual([wrapperId, "window:10"]);
    expect(result.state.nodes[wrapperId!]?.childIds).toEqual(["window:20"]);
    expect(result.state.nodes["window:10"]?.parentId).toBeUndefined();
    expect(adapter.focusTab).not.toHaveBeenCalled();
    expect(adapter.closeTab).not.toHaveBeenCalled();
    expect(adapter.closeWindow).not.toHaveBeenCalled();
    expect(adapter.restoreSession).not.toHaveBeenCalled();
    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(adapter.createWindow).not.toHaveBeenCalled();
    expect(adapter.moveTabs).not.toHaveBeenCalled();
  });

  it("wraps live tabs before moving them to top level", async () => {
    const state: OutlineState = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, {
      type: "moveSubtreeToTopLevel",
      nodeId: "tab:1"
    });

    expect(adapter.createWindow).toHaveBeenCalledWith({ tabId: 1 });
    expect(adapter.moveTabs).toHaveBeenCalledWith([2], { windowId: 42, index: 1 });
    expect(result.state.rootIds).toEqual(["window:10", "window:42"]);
    expect(result.state.nodes["window:10"]?.childIds).toEqual(["tab:3"]);
    expect(result.state.nodes["window:42"]?.childIds).toEqual(["tab:1"]);
    expect(result.state.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: 42 });
  });

  it("wraps live tabs before moving them to the bottom top level", async () => {
    const state: OutlineState = bootstrapFromWindows([
      ...runtimeWindows,
      {
        id: 20,
        focused: false,
        incognito: false,
        tabs: [
          {
            id: 20,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://last.example/",
            title: "Last"
          }
        ]
      }
    ], { now: 1000 });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, {
      type: "moveSubtreeToBottomTopLevel",
      nodeId: "tab:1"
    });

    expect(adapter.createWindow).toHaveBeenCalledWith({ tabId: 1 });
    expect(adapter.moveTabs).toHaveBeenCalledWith([2], { windowId: 42, index: 1 });
    expect(result.state.rootIds).toEqual(["window:10", "window:20", "window:42"]);
    expect(result.state.nodes["window:10"]?.childIds).toEqual(["tab:3"]);
    expect(result.state.nodes["window:42"]?.childIds).toEqual(["tab:1"]);
    expect(result.state.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: 42 });
  });

  it("moves root group-like rows to the bottom top level without touching Firefox", async () => {
    const state: OutlineState = bootstrapFromWindows([
      ...runtimeWindows,
      {
        id: 20,
        focused: false,
        incognito: false,
        tabs: [
          {
            id: 20,
            windowId: 20,
            index: 0,
            active: true,
            url: "https://last.example/",
            title: "Last"
          }
        ]
      }
    ], { now: 1000 });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, {
      type: "moveSubtreeToBottomTopLevel",
      nodeId: "window:10"
    });

    expect(result.state.rootIds).toEqual(["window:20", "window:10"]);
    expect(result.state.nodes["window:10"]?.parentId).toBeUndefined();
    expect(adapter.focusTab).not.toHaveBeenCalled();
    expect(adapter.closeTab).not.toHaveBeenCalled();
    expect(adapter.closeWindow).not.toHaveBeenCalled();
    expect(adapter.restoreSession).not.toHaveBeenCalled();
    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(adapter.createWindow).not.toHaveBeenCalled();
    expect(adapter.moveTabs).not.toHaveBeenCalled();
  });

  it("wraps closed tabs before moving them to top level without touching Firefox", async () => {
    const state = closeTab(bootstrapFromWindows(runtimeWindows, { now: 1000 }), 1, {
      now: 2000,
      sessionId: "session-tab-1"
    });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, {
      type: "moveSubtreeToTopLevel",
      nodeId: "tab:1"
    });
    const wrapperId = result.state.nodes["tab:1"]?.parentId;

    expect(wrapperId).toMatch(/^window:placeholder:/);
    expect(result.state.rootIds).toEqual(["window:10", wrapperId]);
    expect(result.state.nodes["window:10"]?.childIds).toEqual(["tab:2", "tab:3"]);
    expect(result.state.nodes[wrapperId!]).toMatchObject({
      kind: "window",
      status: "closed",
      childIds: ["tab:1"]
    });
    expect(adapter.focusTab).not.toHaveBeenCalled();
    expect(adapter.closeTab).not.toHaveBeenCalled();
    expect(adapter.closeWindow).not.toHaveBeenCalled();
    expect(adapter.restoreSession).not.toHaveBeenCalled();
    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(adapter.createWindow).not.toHaveBeenCalled();
    expect(adapter.moveTabs).not.toHaveBeenCalled();
  });

  it("imports portable trees without touching browser tabs or windows", async () => {
    const state: OutlineState = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, {
      type: "importTree",
      tree: {
        schema: PORTABLE_TREE_SCHEMA,
        version: 1,
        exportedAt: "2026-05-16T12:00:00.000Z",
        roots: [
          {
            kind: "window",
            title: "Imported Window",
            children: [
              {
                kind: "tab",
                title: "Imported Tab",
                url: "https://imported.example/",
                children: []
              }
            ]
          }
        ]
      }
    });

    expect(adapter.focusTab).not.toHaveBeenCalled();
    expect(adapter.closeTab).not.toHaveBeenCalled();
    expect(adapter.closeWindow).not.toHaveBeenCalled();
    expect(adapter.restoreSession).not.toHaveBeenCalled();
    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(adapter.createWindow).not.toHaveBeenCalled();
    expect(adapter.moveTabs).not.toHaveBeenCalled();

    const importedWindow = Object.values(result.state.nodes).find((node) => node.title === "Imported Window");
    const importGroup = importedWindow?.parentId ? result.state.nodes[importedWindow.parentId] : undefined;
    const importedTab = Object.values(result.state.nodes).find((node) => node.title === "Imported Tab");
    expect(importGroup?.title).toBe("Group");
    expect(importGroup?.parentId).toBeUndefined();
    expect(importGroup?.status).toBe("closed");
    expect(importedWindow?.status).toBe("closed");
    expect(importedWindow?.parentId).toBe(importGroup?.id);
    expect(importedTab?.status).toBe("closed");
    expect(importedTab?.restore).toEqual({
      url: "https://imported.example/",
      title: "Imported Tab"
    });
  });

  it("keeps a restored imported subgroup attached to its parent group", async () => {
    const state: OutlineState = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter();
    const imported = await runCommand(state, adapter, {
      type: "importTree",
      tree: {
        schema: PORTABLE_TREE_SCHEMA,
        version: 1,
        exportedAt: "2026-05-16T12:00:00.000Z",
        roots: [
          {
            kind: "window",
            title: "Imported parent group",
            children: [
              {
                kind: "window",
                title: "Imported subgroup",
                children: [
                  {
                    kind: "tab",
                    title: "Imported subgroup first",
                    url: "https://imported.example/first",
                    children: []
                  },
                  {
                    kind: "tab",
                    title: "Imported subgroup second",
                    url: "https://imported.example/second",
                    children: []
                  }
                ]
              }
            ]
          }
        ]
      }
    });
    const importedParent = Object.values(imported.state.nodes).find((node) => node.title === "Imported parent group");
    const importedSubgroup = Object.values(imported.state.nodes).find((node) => node.title === "Imported subgroup");
    const importedTabs = ["Imported subgroup first", "Imported subgroup second"].map((title) =>
      Object.values(imported.state.nodes).find((node) => node.title === title)
    );

    expect(importedParent).toBeDefined();
    expect(importedSubgroup).toBeDefined();
    expect(importedSubgroup?.parentId).toBe(importedParent?.id);
    expect(importedTabs.every(Boolean)).toBe(true);

    const restored = await runCommand(imported.state, adapter, {
      type: "restoreNode",
      nodeId: importedSubgroup!.id
    });

    const restoredParent = restored.state.nodes[importedParent!.id];
    const restoredSubgroup = restored.state.nodes[importedSubgroup!.id];
    expect(restoredParent?.status).toBe("closed");
    expect(restoredParent?.childIds).toContain(importedSubgroup!.id);
    expect(restoredSubgroup).toMatchObject({
      status: "live",
      parentId: importedParent!.id,
      live: { windowId: 42 }
    });
    for (const importedTab of importedTabs) {
      expect(restored.state.nodes[importedTab!.id]).toMatchObject({
        status: "live",
        parentId: importedSubgroup!.id,
        live: { windowId: 42 }
      });
    }
  });

  it("restores nested parent tabs inside an imported subgroup window", async () => {
    const state: OutlineState = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    let nextCreatedTabId = 300;
    const adapter = fakeAdapter({
      createTab: vi.fn(async ({ url, windowId = 10, active = false }) => ({
        id: nextCreatedTabId++,
        windowId,
        index: nextCreatedTabId - 301,
        active,
        url,
        title: url
      }))
    });
    const imported = await runCommand(state, adapter, {
      type: "importTree",
      tree: {
        schema: PORTABLE_TREE_SCHEMA,
        version: 1,
        exportedAt: "2026-05-16T12:00:00.000Z",
        roots: [
          {
            kind: "window",
            title: "Imported parent group",
            children: [
              {
                kind: "window",
                title: "Imported subgroup",
                children: [
                  {
                    kind: "tab",
                    title: "Imported parent tab",
                    url: "https://imported.example/parent",
                    children: [
                      {
                        kind: "tab",
                        title: "Imported nested child",
                        url: "https://imported.example/child",
                        children: []
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    });
    const importedParent = Object.values(imported.state.nodes).find((node) => node.title === "Imported parent group");
    const importedSubgroup = Object.values(imported.state.nodes).find((node) => node.title === "Imported subgroup");
    const importedParentTab = Object.values(imported.state.nodes).find((node) => node.title === "Imported parent tab");
    const importedChild = Object.values(imported.state.nodes).find((node) => node.title === "Imported nested child");

    expect(importedParent).toBeDefined();
    expect(importedSubgroup).toBeDefined();
    expect(importedParentTab).toBeDefined();
    expect(importedChild).toBeDefined();

    const restored = await runCommand(imported.state, adapter, {
      type: "restoreNode",
      nodeId: importedSubgroup!.id
    });

    expect(adapter.createWindow).toHaveBeenCalledWith({
      url: ["https://imported.example/parent", "https://imported.example/child"]
    });
    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(restored.state.nodes[importedParent!.id]?.status).toBe("closed");
    expect(restored.state.nodes[importedParent!.id]?.childIds).toContain(importedSubgroup!.id);
    expect(restored.state.nodes[importedSubgroup!.id]).toMatchObject({
      status: "live",
      parentId: importedParent!.id,
      live: { windowId: 42 }
    });
    expect(restored.state.nodes[importedParentTab!.id]).toMatchObject({
      status: "live",
      parentId: importedSubgroup!.id,
      live: { windowId: 42 }
    });
    expect(restored.state.nodes[importedChild!.id]).toMatchObject({
      status: "live",
      parentId: importedParentTab!.id,
      live: { windowId: 42 }
    });
    expect(restored.state.rootIds).not.toContain(importedSubgroup!.id);
  });

  it("restores a nested imported tab chain in outline order", async () => {
    const state: OutlineState = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter();
    const imported = await runCommand(state, adapter, {
      type: "importTree",
      tree: {
        schema: PORTABLE_TREE_SCHEMA,
        version: 1,
        exportedAt: "2026-05-16T12:00:00.000Z",
        roots: [
          {
            kind: "window",
            title: "Imported parent group",
            children: [
              {
                kind: "window",
                title: "Imported subgroup",
                children: [
                  {
                    kind: "tab",
                    title: "Imported first",
                    url: "https://imported.example/1",
                    children: [
                      {
                        kind: "tab",
                        title: "Imported second",
                        url: "https://imported.example/2",
                        children: [
                          {
                            kind: "tab",
                            title: "Imported third",
                            url: "https://imported.example/3",
                            children: [
                              {
                                kind: "tab",
                                title: "Imported fourth",
                                url: "https://imported.example/4",
                                children: []
                              }
                            ]
                          }
                        ]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    });
    const importedSubgroup = Object.values(imported.state.nodes).find((node) => node.title === "Imported subgroup");
    const importedTabs = ["Imported first", "Imported second", "Imported third", "Imported fourth"].map((title) =>
      Object.values(imported.state.nodes).find((node) => node.title === title)
    );
    expect(importedSubgroup).toBeDefined();
    expect(importedTabs.every(Boolean)).toBe(true);

    const restored = await runCommand(imported.state, adapter, {
      type: "restoreNode",
      nodeId: importedSubgroup!.id
    });

    expect(adapter.createWindow).toHaveBeenCalledWith({
      url: [
        "https://imported.example/1",
        "https://imported.example/2",
        "https://imported.example/3",
        "https://imported.example/4"
      ]
    });
    expect(adapter.createTab).not.toHaveBeenCalled();
    for (const [index, importedTab] of importedTabs.entries()) {
      expect(restored.state.nodes[importedTab!.id]).toMatchObject({
        status: "live",
        live: { windowId: 42 }
      });
      if (index > 0) {
        expect(restored.state.nodes[importedTab!.id]?.parentId).toBe(importedTabs[index - 1]!.id);
      }
    }
  });

  it("restores a branching imported tab tree in outline order", async () => {
    const state: OutlineState = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter();
    const imported = await runCommand(state, adapter, {
      type: "importTree",
      tree: {
        schema: PORTABLE_TREE_SCHEMA,
        version: 1,
        exportedAt: "2026-05-16T12:00:00.000Z",
        roots: [
          {
            kind: "window",
            title: "Imported parent group",
            children: [
              {
                kind: "window",
                title: "Imported subgroup",
                children: [
                  {
                    kind: "tab",
                    title: "Imported first",
                    url: "https://imported.example/1",
                    children: [
                      {
                        kind: "tab",
                        title: "Imported second",
                        url: "https://imported.example/2",
                        children: [
                          {
                            kind: "tab",
                            title: "Imported third",
                            url: "https://imported.example/3",
                            children: [
                              {
                                kind: "tab",
                                title: "Imported fourth",
                                url: "https://imported.example/4",
                                children: []
                              },
                              {
                                kind: "tab",
                                title: "Imported fifth",
                                url: "https://imported.example/5",
                                children: []
                              }
                            ]
                          }
                        ]
                      },
                      {
                        kind: "tab",
                        title: "Imported sixth",
                        url: "https://imported.example/6",
                        children: []
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    });
    const importedSubgroup = Object.values(imported.state.nodes).find((node) => node.title === "Imported subgroup");

    expect(importedSubgroup).toBeDefined();

    const restored = await runCommand(imported.state, adapter, {
      type: "restoreNode",
      nodeId: importedSubgroup!.id
    });

    expect(adapter.createWindow).toHaveBeenCalledWith({
      url: [
        "https://imported.example/1",
        "https://imported.example/2",
        "https://imported.example/3",
        "https://imported.example/4",
        "https://imported.example/5",
        "https://imported.example/6"
      ]
    });
    expect(adapter.createTab).not.toHaveBeenCalled();
    for (const url of [
      "https://imported.example/1",
      "https://imported.example/2",
      "https://imported.example/3",
      "https://imported.example/4",
      "https://imported.example/5",
      "https://imported.example/6"
    ]) {
      const node = Object.values(restored.state.nodes).find((candidate) => candidate.kind === "tab" && candidate.url === url);
      expect(node).toMatchObject({
        status: "live",
        live: { windowId: 42 }
      });
    }
  });

  it("moves batch-created imported tabs back into outline order when Firefox reports children before parents", async () => {
    const state: OutlineState = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const tabIdByUrl = new Map<string, number>();
    const adapter = fakeAdapter({
      createWindow: vi.fn(async ({ url }) => {
        const urls = Array.isArray(url) ? url : url ? [url] : [];
        const reportedUrls = [
          "https://imported.example/1",
          "https://imported.example/3",
          "https://imported.example/4",
          "https://imported.example/2",
          "https://imported.example/6",
          "https://imported.example/5"
        ].filter((reportedUrl) => urls.includes(reportedUrl));
        const tabs = reportedUrls.map((tabUrl, index) => {
          const tabId = 300 + index;
          tabIdByUrl.set(tabUrl, tabId);
          return {
            id: tabId,
            windowId: 42,
            index,
            active: index === 0,
            url: tabUrl,
            title: tabUrl
          };
        });
        return {
          id: 42,
          focused: true,
          incognito: false,
          tabs
        };
      })
    });
    const imported = await runCommand(state, adapter, {
      type: "importTree",
      tree: {
        schema: PORTABLE_TREE_SCHEMA,
        version: 1,
        exportedAt: "2026-05-16T12:00:00.000Z",
        roots: [
          {
            kind: "window",
            title: "Imported parent group",
            children: [
              {
                kind: "window",
                title: "Imported subgroup",
                children: [
                  {
                    kind: "tab",
                    title: "Imported first",
                    url: "https://imported.example/1",
                    children: [
                      {
                        kind: "tab",
                        title: "Imported second",
                        url: "https://imported.example/2",
                        children: [
                          {
                            kind: "tab",
                            title: "Imported third",
                            url: "https://imported.example/3",
                            children: [
                              {
                                kind: "tab",
                                title: "Imported fourth",
                                url: "https://imported.example/4",
                                children: []
                              }
                            ]
                          }
                        ]
                      },
                      {
                        kind: "tab",
                        title: "Imported fifth",
                        url: "https://imported.example/5",
                        children: [
                          {
                            kind: "tab",
                            title: "Imported sixth",
                            url: "https://imported.example/6",
                            children: []
                          }
                        ]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    });
    const importedSubgroup = Object.values(imported.state.nodes).find((node) => node.title === "Imported subgroup");

    expect(importedSubgroup).toBeDefined();

    await runCommand(imported.state, adapter, {
      type: "restoreNode",
      nodeId: importedSubgroup!.id
    });

    expect(adapter.createWindow).toHaveBeenCalledWith({
      url: [
        "https://imported.example/1",
        "https://imported.example/2",
        "https://imported.example/3",
        "https://imported.example/4",
        "https://imported.example/5",
        "https://imported.example/6"
      ]
    });
    expect(adapter.moveTabs).toHaveBeenCalledWith(
      [
        tabIdByUrl.get("https://imported.example/1"),
        tabIdByUrl.get("https://imported.example/2"),
        tabIdByUrl.get("https://imported.example/3"),
        tabIdByUrl.get("https://imported.example/4"),
        tabIdByUrl.get("https://imported.example/5"),
        tabIdByUrl.get("https://imported.example/6")
      ],
      { windowId: 42, index: 0 }
    );
  });

  it("keeps a restored Chrome-imported tab subgroup attached to its parent group", async () => {
    const state: OutlineState = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter();
    const imported = await runCommand(state, adapter, {
      type: "importTree",
      tree: [
        {
          type: 2000,
          node: {
            type: "session",
            data: {
              treeId: "1483340179831.8303"
            }
          }
        },
        [
          2001,
          {
            type: "savedwin",
            marks: {
              customTitle: "Research"
            },
            data: {
              type: "normal"
            }
          },
          [0]
        ],
        [
          2001,
          {
            data: {
              title: "Imported subgroup",
              url: "https://imported.example/subgroup"
            }
          },
          [0, 0]
        ],
        [
          2001,
          {
            type: "tab",
            data: {
              title: "Imported subgroup child",
              url: "https://imported.example/child"
            }
          },
          [0, 0, 0]
        ]
      ]
    });
    const importGroup = Object.values(imported.state.nodes).find((node) => node.title === "Chrome Tab Outliner import");
    const importedParent = Object.values(imported.state.nodes).find((node) => node.title === "Research");
    const importedSubgroup = Object.values(imported.state.nodes).find((node) => node.title === "Imported subgroup");
    const importedChild = Object.values(imported.state.nodes).find((node) => node.title === "Imported subgroup child");

    expect(importGroup).toBeDefined();
    expect(importedParent).toBeDefined();
    expect(importedSubgroup).toBeDefined();
    expect(importedChild).toBeDefined();
    expect(importedParent?.parentId).toBe(importGroup?.id);
    expect(importedSubgroup?.kind).toBe("tab");
    expect(importedSubgroup?.parentId).toBe(importedParent?.id);
    expect(importedChild?.parentId).toBe(importedSubgroup?.id);

    const restored = await runCommand(imported.state, adapter, {
      type: "restoreNode",
      nodeId: importedSubgroup!.id
    });

    expect(adapter.createWindow).toHaveBeenCalledWith({
      url: ["https://imported.example/subgroup", "https://imported.example/child"]
    });
    expect(adapter.createTab).not.toHaveBeenCalled();

    const restoredImportGroup = restored.state.nodes[importGroup!.id];
    const restoredParent = restored.state.nodes[importedParent!.id];
    const restoredSubgroup = restored.state.nodes[importedSubgroup!.id];
    const restoredChild = restored.state.nodes[importedChild!.id];
    expect(restored.state.rootIds).not.toContain(importedSubgroup!.id);
    expect(restoredImportGroup?.childIds).toContain(importedParent!.id);
    expect(restoredParent?.status).toBe("closed");
    expect(restoredParent?.childIds).toContain(importedSubgroup!.id);
    expect(restoredSubgroup).toMatchObject({
      status: "live",
      parentId: importedParent!.id,
      childIds: [importedChild!.id],
      live: { windowId: 42 }
    });
    expect(restoredChild).toMatchObject({
      status: "live",
      parentId: importedSubgroup!.id,
      live: { windowId: 42 }
    });
  });

  it("renames groups locally without touching browser tabs or windows", async () => {
    const state: OutlineState = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, {
      type: "renameGroup",
      nodeId: "window:10",
      title: "  Research  "
    });

    expect(result.state.nodes["window:10"]?.title).toBe("Research");
    expect(result.state.nodes["window:10"]?.customTitle).toBe("Research");
    expect(adapter.focusTab).not.toHaveBeenCalled();
    expect(adapter.closeTab).not.toHaveBeenCalled();
    expect(adapter.closeWindow).not.toHaveBeenCalled();
    expect(adapter.restoreSession).not.toHaveBeenCalled();
    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(adapter.createWindow).not.toHaveBeenCalled();
    expect(adapter.moveTabs).not.toHaveBeenCalled();
  });

  it("skips imported internal Firefox urls that WebExtensions cannot reopen", async () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter({
      createWindow: vi.fn(async ({ url }) => {
        if (url === "about:debugging#/runtime/this-firefox") {
          throw new Error("Illegal URL");
        }
        return {
          id: 42,
          focused: true,
          incognito: false,
          tabs: [
            {
              id: 200,
              windowId: 42,
              index: 0,
              active: true,
              url: String(url),
              title: String(url)
            }
          ]
        };
      })
    });
    const imported = await runCommand(state, adapter, {
      type: "importTree",
      tree: {
        schema: PORTABLE_TREE_SCHEMA,
        version: 1,
        exportedAt: "2026-05-16T12:00:00.000Z",
        roots: [
          {
            kind: "window",
            title: "Imported Window",
            children: [
              {
                kind: "tab",
                title: "Debugging",
                url: "about:debugging#/runtime/this-firefox",
                children: []
              },
              {
                kind: "tab",
                title: "Restorable",
                url: "https://restorable.example/",
                children: []
              }
            ]
          }
        ]
      }
    });
    const importedWindow = Object.values(imported.state.nodes).find((node) => node.title === "Imported Window")!;
    const importGroup = imported.state.nodes[importedWindow.parentId!]!;

    const restored = await runCommand(imported.state, adapter, {
      type: "restoreNode",
      nodeId: importGroup.id
    });

    const debugging = Object.values(restored.state.nodes).find((node) => node.title === "Debugging");
    const restorable = Object.values(restored.state.nodes).find((node) => node.title === "Restorable");
    expect(adapter.createWindow).not.toHaveBeenCalledWith({ url: "about:debugging#/runtime/this-firefox" });
    expect(adapter.createWindow).toHaveBeenCalledWith({ url: "https://restorable.example/" });
    expect(debugging?.status).toBe("closed");
    expect(debugging?.restore?.url).toBe("about:debugging#/runtime/this-firefox");
    expect(restorable?.status).toBe("live");
    expect(restorable?.live).toEqual({ tabId: 200, windowId: 42 });
  });

  it("moves a live tab subtree into a newly created browser window", async () => {
    const state: OutlineState = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter({
      createWindow: vi.fn(async ({ tabId }) => ({
        id: 42,
        focused: true,
        incognito: false,
        tabs: typeof tabId === "number"
          ? [
              {
                id: tabId,
                windowId: 42,
                index: 0,
                active: true,
                url: "https://example.com/",
                title: "Example"
              }
            ]
          : []
      }))
    });

    const result = await runCommand(state, adapter, {
      type: "moveNodeToNewWindow",
      nodeId: "tab:1"
    });

    expect(adapter.createWindow).toHaveBeenCalledWith({ tabId: 1 });
    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(adapter.restoreSession).not.toHaveBeenCalled();
    expect(result.state.rootIds).toEqual(["window:10", "window:42"]);
    expect(result.state.nodes["window:10"]?.childIds).toEqual(["tab:3"]);
    expect(result.state.nodes["window:42"]?.childIds).toEqual(["tab:1"]);
    expect(result.state.nodes["tab:1"]?.live).toEqual({ tabId: 1, windowId: 42 });
    expect(result.state.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: 42 });
    expect(adapter.moveTabs).toHaveBeenNthCalledWith(1, [2], { windowId: 42, index: 1 });
    expect(adapter.moveTabs).toHaveBeenNthCalledWith(2, [3], { windowId: 10, index: 0 });
    expect(adapter.moveTabs).toHaveBeenNthCalledWith(3, [1, 2], { windowId: 42, index: 0 });
  });

  it("keeps root-positioned tab drops inside a newly created window", async () => {
    const state: OutlineState = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter({
      createWindow: vi.fn(async ({ tabId }) => ({
        id: 42,
        focused: true,
        incognito: false,
        tabs: typeof tabId === "number"
          ? [
              {
                id: tabId,
                windowId: 42,
                index: 0,
                active: true,
                url: "https://example.com/",
                title: "Example"
              }
            ]
          : []
      }))
    });

    const result = await runCommand(state, adapter, {
      type: "moveNode",
      nodeId: "tab:1",
      index: 0
    });

    expect(result.state.rootIds).toEqual(["window:42", "window:10"]);
    expect(result.state.nodes["window:42"]?.childIds).toEqual(["tab:1"]);
    expect(result.state.nodes["tab:1"]?.parentId).toBe("window:42");
    expect(result.state.nodes["tab:1"]?.live).toEqual({ tabId: 1, windowId: 42 });
    expect(adapter.createWindow).toHaveBeenCalledWith({ tabId: 1 });
    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(result.state.rootIds).not.toContain("tab:1");
  });

  it("moves a closed tab subtree into a placeholder without touching Firefox", async () => {
    const state = closeTab(bootstrapFromWindows(runtimeWindows, { now: 1000 }), 1, {
      now: 2000,
      sessionId: "session-tab-1"
    });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, {
      type: "moveNodeToNewWindow",
      nodeId: "tab:1"
    });
    const placeholderId = result.state.rootIds.at(-1)!;

    expect(adapter.createWindow).not.toHaveBeenCalled();
    expect(adapter.moveTabs).not.toHaveBeenCalled();
    expect(result.state.nodes[placeholderId]?.kind).toBe("window");
    expect(result.state.nodes[placeholderId]?.status).toBe("closed");
    expect(result.state.nodes[placeholderId]?.childIds).toEqual(["tab:1"]);
    expect(result.state.nodes["tab:1"]?.parentId).toBe(placeholderId);
  });

  it("restores a root-dropped closed tab itself through its native session", async () => {
    const state = closeTab(bootstrapFromWindows(runtimeWindows, { now: 1000 }), 2, {
      now: 2000,
      sessionId: "session-tab-2"
    });
    const adapter = fakeAdapter({
      restoreSession: vi.fn(async () => ({
        tab: {
          id: 22,
          windowId: 10,
          index: 1,
          active: true,
          url: "about:debugging#/runtime/this-firefox",
          title: "Debugging - Runtime / this-firefox"
        }
      })),
      createWindow: vi.fn(async ({ tabId, url }) => {
        if (url) {
          throw new Error("Internal URL cannot be created directly");
        }

        return {
          id: 42,
          focused: true,
          incognito: false,
          tabs: typeof tabId === "number"
            ? [
                {
                  id: tabId,
                  windowId: 42,
                  index: 0,
                  active: true,
                  url: "about:debugging#/runtime/this-firefox",
                  title: "Debugging - Runtime / this-firefox"
                }
              ]
            : []
        };
      })
    });
    const moved = await runCommand(state, adapter, {
      type: "moveNodeToNewWindow",
      nodeId: "tab:2"
    });
    const placeholderId = moved.state.rootIds.at(-1)!;

    const restored = await runCommand(moved.state, adapter, {
      type: "restoreNode",
      nodeId: "tab:2"
    });

    expect(adapter.restoreSession).toHaveBeenCalledWith("session-tab-2");
    expect(adapter.createWindow).toHaveBeenCalledWith({ tabId: 22 });
    expect(restored.state.nodes[placeholderId]?.status).toBe("live");
    expect(restored.state.nodes[placeholderId]?.live).toEqual({ windowId: 42 });
    expect(restored.state.nodes["tab:2"]?.status).toBe("live");
    expect(restored.state.nodes["tab:2"]?.live).toEqual({ tabId: 22, windowId: 42 });
  });

  it("restores a root-dropped lone child tab through its source closed window session", async () => {
    const state = closeWindow(bootstrapFromWindows([
      ...runtimeWindows,
      {
        id: 20,
        focused: false,
        incognito: false,
        tabs: [
          {
            id: 5,
            windowId: 20,
            index: 0,
            active: true,
            url: "about:debugging#/runtime/this-firefox",
            title: "Debugging - Runtime / this-firefox"
          }
        ]
      }
    ], { now: 1000 }), 20, {
      now: 2000,
      sessionId: "session-window-20"
    });
    const adapter = fakeAdapter({
      restoreSession: vi.fn(async () => ({
        window: {
          id: 42,
          focused: true,
          incognito: false,
          tabs: [
            {
              id: 50,
              windowId: 42,
              index: 0,
              active: true,
              url: "about:debugging#/runtime/this-firefox",
              title: "Debugging - Runtime / this-firefox"
            }
          ]
        }
      })),
      createWindow: vi.fn(async ({ url }) => {
        throw new Error(`Cannot create ${url}`);
      })
    });
    const moved = await runCommand(state, adapter, {
      type: "moveNodeToNewWindow",
      nodeId: "tab:5"
    });
    const placeholderId = moved.state.rootIds.at(-1)!;

    const restored = await runCommand(moved.state, adapter, {
      type: "restoreNode",
      nodeId: "tab:5"
    });

    expect(adapter.restoreSession).toHaveBeenCalledWith("session-window-20");
    expect(adapter.createWindow).not.toHaveBeenCalled();
    expect(restored.state.nodes[placeholderId]?.status).toBe("live");
    expect(restored.state.nodes[placeholderId]?.live).toEqual({ windowId: 42 });
    expect(restored.state.nodes["tab:5"]?.status).toBe("live");
    expect(restored.state.nodes["tab:5"]?.live).toEqual({ tabId: 50, windowId: 42 });
  });

  it("restores a lone-child placeholder through its source closed window session", async () => {
    const state = closeWindow(bootstrapFromWindows([
      ...runtimeWindows,
      {
        id: 20,
        focused: false,
        incognito: false,
        tabs: [
          {
            id: 5,
            windowId: 20,
            index: 0,
            active: true,
            url: "about:debugging#/runtime/this-firefox",
            title: "Debugging - Runtime / this-firefox"
          }
        ]
      }
    ], { now: 1000 }), 20, {
      now: 2000,
      sessionId: "session-window-20"
    });
    const adapter = fakeAdapter({
      restoreSession: vi.fn(async () => ({
        window: {
          id: 42,
          focused: true,
          incognito: false,
          tabs: [
            {
              id: 50,
              windowId: 42,
              index: 0,
              active: true,
              url: "about:debugging#/runtime/this-firefox",
              title: "Debugging - Runtime / this-firefox"
            }
          ]
        }
      })),
      createWindow: vi.fn(async ({ url }) => {
        throw new Error(`Cannot create ${url}`);
      })
    });
    const moved = await runCommand(state, adapter, {
      type: "moveNodeToNewWindow",
      nodeId: "tab:5"
    });
    const placeholderId = moved.state.rootIds.at(-1)!;

    const restored = await runCommand(moved.state, adapter, {
      type: "restoreNode",
      nodeId: placeholderId
    });

    expect(adapter.restoreSession).toHaveBeenCalledWith("session-window-20");
    expect(adapter.createWindow).not.toHaveBeenCalled();
    expect(restored.state.nodes[placeholderId]?.status).toBe("live");
    expect(restored.state.nodes[placeholderId]?.live).toEqual({ windowId: 42 });
    expect(restored.state.nodes["tab:5"]?.status).toBe("live");
    expect(restored.state.nodes["tab:5"]?.live).toEqual({ tabId: 50, windowId: 42 });
  });

  it("restores a closed placeholder window through the dragged tab session", async () => {
    const state = closeTab(bootstrapFromWindows(runtimeWindows, { now: 1000 }), 1, {
      now: 2000,
      sessionId: "session-tab-1"
    });
    const adapter = fakeAdapter({
      restoreSession: vi.fn(async () => ({
        tab: {
          id: 21,
          windowId: 10,
          index: 0,
          active: true,
          url: "about:debugging#/runtime/this-firefox",
          title: "Debugging - Runtime / this-firefox"
        }
      })),
      createWindow: vi.fn(async ({ tabId, url }) => {
        if (url) {
          throw new Error("Internal URL cannot be created directly");
        }

        return {
          id: 42,
          focused: true,
          incognito: false,
          tabs: typeof tabId === "number"
            ? [
                {
                  id: tabId,
                  windowId: 42,
                  index: 0,
                  active: true,
                  url: "about:debugging#/runtime/this-firefox",
                  title: "Debugging - Runtime / this-firefox"
                }
              ]
            : []
        };
      })
    });
    const moved = await runCommand(state, adapter, {
      type: "moveNodeToNewWindow",
      nodeId: "tab:1"
    });
    const placeholderId = moved.state.rootIds.at(-1)!;

    const restored = await runCommand(moved.state, adapter, {
      type: "restoreNode",
      nodeId: placeholderId
    });

    expect(adapter.restoreSession).toHaveBeenCalledWith("session-tab-1");
    expect(adapter.createWindow).toHaveBeenCalledWith({ tabId: 21 });
    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(restored.state.nodes[placeholderId]?.status).toBe("live");
    expect(restored.state.nodes[placeholderId]?.live).toEqual({ windowId: 42 });
    expect(restored.state.nodes["tab:1"]?.live).toEqual({ tabId: 21, windowId: 42 });
    expect(restored.state.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: 10 });
  });

  it("restores url siblings into a closed imported group window created by a child tab session", async () => {
    const sessionOnlyUrl = "about:debugging#/runtime/this-firefox";
    const siblingUrl = "https://calendar.example/week";
    const imported = await runCommand(bootstrapFromWindows(runtimeWindows, { now: 1000 }), fakeAdapter(), {
      type: "importTree",
      tree: {
        schema: PORTABLE_TREE_SCHEMA,
        version: 1,
        exportedAt: "2026-05-18T12:00:00.000Z",
        roots: [
          {
            kind: "window",
            title: "Imported group",
            children: [
              {
                kind: "tab",
                title: "First imported",
                url: sessionOnlyUrl,
                children: []
              },
              {
                kind: "tab",
                title: "Second imported",
                url: siblingUrl,
                children: []
              }
            ]
          }
        ]
      }
    });
    const importedGroup = Object.values(imported.state.nodes)
      .find((node) => node.kind === "window" && node.title === "Imported group")!;
    const firstTab = Object.values(imported.state.nodes)
      .find((node) => node.kind === "tab" && node.title === "First imported")!;
    const secondTab = Object.values(imported.state.nodes)
      .find((node) => node.kind === "tab" && node.title === "Second imported")!;
    const state: OutlineState = {
      ...imported.state,
      nodes: {
        ...imported.state.nodes,
        [firstTab.id]: {
          ...firstTab,
          restore: {
            ...firstTab.restore,
            sessionId: "session-imported-first"
          }
        },
        [secondTab.id]: {
          ...secondTab,
          restore: undefined
        }
      }
    };
    const adapter = fakeAdapter({
      restoreSession: vi.fn(async () => ({
        tab: {
          id: 21,
          windowId: 10,
          index: 1,
          active: true,
          url: sessionOnlyUrl,
          title: "First imported"
        }
      })),
      createWindow: vi.fn(async ({ tabId, url }) => {
        if (typeof tabId === "number") {
          return {
            id: 42,
            focused: true,
            incognito: false,
            tabs: [
              {
                id: tabId,
                windowId: 42,
                index: 0,
                active: true,
                url: sessionOnlyUrl,
                title: "First imported"
              }
            ]
          };
        }
        const urls = Array.isArray(url) ? url : url ? [url] : [];
        return {
          id: 43,
          focused: true,
          incognito: false,
          tabs: urls.map((tabUrl, index) => ({
            id: 200 + index,
            windowId: 43,
            index,
            active: index === 0,
            url: tabUrl,
            title: tabUrl
          }))
        };
      }),
      createTab: vi.fn(async ({ url, windowId = 10 }) => ({
        id: 22,
        windowId,
        index: 1,
        active: false,
        url,
        title: "Second imported"
      }))
    });

    const restored = await runCommand(state, adapter, { type: "restoreNode", nodeId: importedGroup.id });

    expect(adapter.restoreSession).toHaveBeenCalledWith("session-imported-first");
    expect(adapter.createWindow).toHaveBeenCalledTimes(1);
    expect(adapter.createWindow).toHaveBeenCalledWith({ tabId: 21 });
    expect(adapter.createTab).toHaveBeenCalledWith({
      url: siblingUrl,
      windowId: 42,
      active: false,
      index: 1
    });
    expect(restored.state.nodes[importedGroup.id]?.live).toEqual({ windowId: 42 });
    expect(restored.state.nodes[firstTab.id]?.live).toEqual({ tabId: 21, windowId: 42 });
    expect(restored.state.nodes[secondTab.id]?.live).toEqual({ tabId: 22, windowId: 42 });
  });

  it("restores imported url descendants after a reclosed group window session reports no tabs yet", async () => {
    const imported = await runCommand(bootstrapFromWindows(runtimeWindows, { now: 1000 }), fakeAdapter(), {
      type: "importTree",
      tree: {
        schema: PORTABLE_TREE_SCHEMA,
        version: 1,
        exportedAt: "2026-05-18T12:00:00.000Z",
        roots: [
          {
            kind: "window",
            title: "Imported group",
            children: [
              {
                kind: "tab",
                title: "First imported",
                url: "https://images.example/first.jpg",
                children: []
              },
              {
                kind: "tab",
                title: "Second imported",
                url: "https://images.example/second.jpg",
                children: []
              },
              {
                kind: "tab",
                title: "Third imported",
                url: "https://images.example/third.jpg",
                children: []
              }
            ]
          }
        ]
      }
    });
    const importedGroup = Object.values(imported.state.nodes)
      .find((node) => node.kind === "window" && node.title === "Imported group")!;
    const importedTabs = ["First imported", "Second imported", "Third imported"].map((title) =>
      Object.values(imported.state.nodes).find((node) => node.kind === "tab" && node.title === title)!
    );
    const restampedNodes: OutlineState["nodes"] = {
      ...imported.state.nodes,
      [importedGroup.id]: {
        ...importedGroup,
        updatedAt: 2000,
        closedAt: 2000,
        restore: { sessionId: "session-imported-window" }
      }
    };
    for (const tab of importedTabs) {
      restampedNodes[tab.id] = {
        ...tab,
        updatedAt: 2000,
        closedAt: 2000
      };
    }
    const state: OutlineState = {
      ...imported.state,
      nodes: restampedNodes
    };
    let nextTabId = 200;
    const adapter = fakeAdapter({
      restoreSession: vi.fn(async (sessionId) => {
        if (sessionId !== "session-imported-window") {
          return {};
        }
        return {
          window: {
            id: 42,
            focused: true,
            incognito: false,
            tabs: []
          }
        };
      }),
      createTab: vi.fn(async ({ url, windowId = 10, active = false }) => ({
        id: nextTabId++,
        windowId,
        index: nextTabId - 201,
        active,
        url,
        title: url
      }))
    });

    const restored = await runCommand(state, adapter, { type: "restoreNode", nodeId: importedGroup.id });

    expect(adapter.restoreSession).toHaveBeenCalledWith("session-imported-window");
    expect(adapter.createWindow).not.toHaveBeenCalled();
    expect(adapter.createTab).toHaveBeenCalledTimes(3);
    for (const [index, tab] of importedTabs.entries()) {
      expect(adapter.createTab).toHaveBeenCalledWith({
        url: tab.url,
        windowId: 42,
        active: false,
        index
      });
      expect(restored.state.nodes[tab.id]).toMatchObject({
        status: "live",
        live: { windowId: 42 }
      });
    }
    expect(restored.state.nodes[importedGroup.id]?.live).toEqual({ windowId: 42 });
  });

  it("falls back to urls when restoring a closed placeholder window without a session match", async () => {
    const state = closeTab(bootstrapFromWindows(runtimeWindows, { now: 1000 }), 1, {
      now: 2000,
      sessionId: "session-tab-1"
    });
    const adapter = fakeAdapter();
    const moved = await runCommand(state, adapter, {
      type: "moveNodeToNewWindow",
      nodeId: "tab:1"
    });
    const placeholderId = moved.state.rootIds.at(-1)!;

    const restored = await runCommand(moved.state, adapter, {
      type: "restoreNode",
      nodeId: placeholderId
    });

    expect(adapter.restoreSession).toHaveBeenCalledWith("session-tab-1");
    expect(adapter.createWindow).toHaveBeenCalledWith({ url: "https://example.com/" });
    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(restored.state.nodes[placeholderId]?.status).toBe("live");
    expect(restored.state.nodes[placeholderId]?.live).toEqual({ windowId: 42 });
    expect(restored.state.nodes["tab:1"]?.live).toEqual({ tabId: 200, windowId: 42 });
    expect(restored.state.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: 10 });
  });

  it("toggles collapsed state locally", async () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, { type: "toggleCollapsed", nodeId: "tab:1" });

    expect(result.changed).toBe(true);
    expect(result.state).toBe(state);
    expect(state.nodes["tab:1"]?.collapsed).toBe(true);
    expect(result.state.nodes["tab:1"]?.collapsed).toBe(true);
  });

  it("expands collapsed ancestors without toggling the target itself", async () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter();
    state.nodes["window:10"]!.collapsed = true;
    state.nodes["tab:1"]!.collapsed = true;
    state.nodes["tab:2"]!.collapsed = true;

    const result = await runCommand(state, adapter, { type: "expandAncestors", nodeId: "tab:2" } as BackgroundCommand);

    expect(result.changed).toBe(true);
    expect(result.state).toBe(state);
    expect(state.nodes["window:10"]?.collapsed).toBe(false);
    expect(state.nodes["tab:1"]?.collapsed).toBe(false);
    expect(state.nodes["tab:2"]?.collapsed).toBe(true);
    expect(adapter.focusTab).not.toHaveBeenCalled();
    expect(adapter.closeTabs).not.toHaveBeenCalled();
    expect(adapter.closeWindow).not.toHaveBeenCalled();
    expect(adapter.restoreSession).not.toHaveBeenCalled();
    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(adapter.createWindow).not.toHaveBeenCalled();
    expect(adapter.moveTabs).not.toHaveBeenCalled();
  });

  it("leaves already-visible and missing expand-ancestor targets unchanged", async () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter();

    const visible = await runCommand(state, adapter, { type: "expandAncestors", nodeId: "tab:1" } as BackgroundCommand);
    const missing = await runCommand(state, adapter, {
      type: "expandAncestors",
      nodeId: "tab:missing"
    } as BackgroundCommand);

    expect(visible.changed).toBe(false);
    expect(missing.changed).toBe(false);
    expect(visible.state).toBe(state);
    expect(missing.state).toBe(state);
    expect(adapter.focusTab).not.toHaveBeenCalled();
    expect(adapter.closeTabs).not.toHaveBeenCalled();
    expect(adapter.closeWindow).not.toHaveBeenCalled();
    expect(adapter.restoreSession).not.toHaveBeenCalled();
    expect(adapter.createTab).not.toHaveBeenCalled();
    expect(adapter.createWindow).not.toHaveBeenCalled();
    expect(adapter.moveTabs).not.toHaveBeenCalled();
  });
});
