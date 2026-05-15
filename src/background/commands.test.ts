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
    createWindow: vi.fn(async ({ url }) => ({
      id: 42,
      focused: true,
      incognito: false,
      tabs: Array.isArray(url)
        ? url.map((tabUrl, index) => ({
            id: 200 + index,
            windowId: 42,
            index,
            active: index === 0,
            url: tabUrl,
            title: tabUrl
          }))
        : []
    })),
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
