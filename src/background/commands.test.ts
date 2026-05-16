import { describe, expect, it, vi } from "vitest";

import type { BrowserAdapter } from "./adapter.js";
import { isBackgroundCommand, runCommand } from "./commands.js";
import type { BackgroundCommand } from "./commands.js";
import {
  LARGE_RESTORE_NODE_THRESHOLD,
  bootstrapFromWindows,
  closeTab,
  closeWindow,
  flattenSubtreeOneLevel,
  moveNode
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
      { type: "flattenSubtree", nodeId: "window:10" },
      { type: "toggleCollapsed", nodeId: "tab:1" },
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
      active: false
    });
    expect(result.state.nodes["tab:2"]?.live).toEqual({ tabId: 23, windowId: 10 });
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
    expect(result.state.nodes["tab:1"]?.live).toEqual({ tabId: 200, windowId: 42 });
    expect(result.state.nodes["tab:2"]?.live).toEqual({ tabId: 201, windowId: 42 });
    expect(result.state.nodes["tab:3"]?.live).toEqual({ tabId: 202, windowId: 42 });
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
    expect(result.state.nodes["window:20"]?.childIds).toEqual(["tab:5"]);
    expect(result.state.nodes["tab:5"]?.parentId).toBe("window:20");
    expect(result.state.nodes["tab:5"]?.live).toEqual({ tabId: 200, windowId: 42 });
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

  it("moves outline nodes and asks Firefox to match preorder", async () => {
    const state: OutlineState = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, {
      type: "moveNode",
      nodeId: "tab:3",
      parentId: "tab:1",
      index: 0
    });

    expect(result.state).toEqual(moveNode(state, "tab:3", { parentId: "tab:1", index: 0 }));
    expect(adapter.moveTabs).toHaveBeenCalledWith([1, 3, 2], { windowId: 10, index: 0 });
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
    const restorable = Object.values(restored.state.nodes).find((node) => node.title === "https://restorable.example/");
    expect(adapter.createWindow).toHaveBeenCalledWith({ url: "about:debugging#/runtime/this-firefox" });
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
    expect(result.state.rootIds).toEqual(["window:10", "window:42"]);
    expect(result.state.nodes["window:10"]?.childIds).toEqual(["tab:3"]);
    expect(result.state.nodes["window:42"]?.childIds).toEqual(["tab:1"]);
    expect(result.state.nodes["tab:1"]?.live).toEqual({ tabId: 1, windowId: 42 });
    expect(result.state.nodes["tab:2"]?.live).toEqual({ tabId: 2, windowId: 42 });
    expect(adapter.moveTabs).toHaveBeenNthCalledWith(1, [3], { windowId: 10, index: 0 });
    expect(adapter.moveTabs).toHaveBeenNthCalledWith(2, [1, 2], { windowId: 42, index: 0 });
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

    expect(result.state.nodes["tab:1"]?.collapsed).toBe(true);
  });
});
