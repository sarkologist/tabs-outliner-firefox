import { describe, expect, it, vi } from "vitest";

import type { BrowserAdapter } from "./adapter.js";
import { runCommand } from "./commands.js";
import { bootstrapFromWindows, closeTab, closeWindow, moveNode } from "../model/outline.js";
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

describe("background commands", () => {
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

    expect(adapter.closeTab).toHaveBeenCalledWith(2);
    expect(adapter.closeWindow).toHaveBeenCalledWith(10);
  });

  it("deletes closed nodes without closing browser items", async () => {
    const state = closeTab(bootstrapFromWindows(runtimeWindows, { now: 1000 }), 1, {
      now: 2000,
      sessionId: "session-tab-1"
    });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, { type: "deleteNode", nodeId: "tab:1" });

    expect(adapter.closeTab).not.toHaveBeenCalled();
    expect(adapter.closeWindow).not.toHaveBeenCalled();
    expect(result.state.nodes["tab:1"]).toBeUndefined();
    expect(result.state.nodes["tab:2"]).toBeUndefined();
    expect(result.state.nodes["window:10"]?.childIds).toEqual(["tab:3"]);
  });

  it("closes live tab subtrees before deleting them", async () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, { type: "deleteNode", nodeId: "tab:1" });

    expect(adapter.closeTab).toHaveBeenNthCalledWith(1, 2);
    expect(adapter.closeTab).toHaveBeenNthCalledWith(2, 1);
    expect(adapter.closeWindow).not.toHaveBeenCalled();
    expect(result.state.nodes["tab:1"]).toBeUndefined();
    expect(result.state.nodes["tab:2"]).toBeUndefined();
    expect(result.state.nodes["window:10"]?.childIds).toEqual(["tab:3"]);
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

  it("toggles collapsed state locally", async () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const adapter = fakeAdapter();

    const result = await runCommand(state, adapter, { type: "toggleCollapsed", nodeId: "tab:1" });

    expect(result.state.nodes["tab:1"]?.collapsed).toBe(true);
  });
});
