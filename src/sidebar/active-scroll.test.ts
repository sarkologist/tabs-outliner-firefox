import { describe, expect, it } from "vitest";
import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import {
  createActiveTabScrollTracker,
  findActiveTabNodeId,
  observeActiveTabNodeId,
  observeActiveTabScrollTarget,
  resetActiveTabScrollTracker,
  scrollActiveTabIntoView
} from "./active-scroll.js";

describe("findActiveTabNodeId", () => {
  it("finds the active tab inside the active window in outline order", () => {
    const state = outlineState([
      windowNode("window:1", ["tab:1"], { active: false }),
      tabNode("tab:1", "window:1", { active: true }),
      windowNode("window:2", ["tab:2"], { active: true }),
      tabNode("tab:2", "window:2", { active: true })
    ]);

    expect(findActiveTabNodeId(state)).toBe("tab:2");
  });

  it("ignores active tabs in unfocused windows", () => {
    const state = outlineState([
      windowNode("window:1", ["tab:1"], { active: false }),
      tabNode("tab:1", "window:1", { active: true })
    ]);

    expect(findActiveTabNodeId(state)).toBeUndefined();
  });

  it("finds nested active tab nodes under active windows", () => {
    const state = outlineState([
      windowNode("window:1", ["tab:parent"], { active: true }),
      tabNode("tab:parent", "window:1", { childIds: ["tab:child"] }),
      tabNode("tab:child", "tab:parent", { active: true })
    ]);

    expect(findActiveTabNodeId(state)).toBe("tab:child");
  });

  it("finds an active tab in a 50k-node deep tree without recursive stack overflow", () => {
    expect(findActiveTabNodeId(deepActiveState(50_000))).toBe("tab:50000");
  });
});

describe("observeActiveTabScrollTarget", () => {
  it("does not retrigger for repeated renders of the same active node", () => {
    const tracker = createActiveTabScrollTracker();
    const state = outlineState([
      windowNode("window:1", ["tab:1"], { active: true }),
      tabNode("tab:1", "window:1", { active: true })
    ]);

    expect(observeActiveTabScrollTarget(tracker, state)).toBe("tab:1");
    expect(observeActiveTabScrollTarget(tracker, state)).toBeUndefined();
  });

  it("records hidden active nodes as observed so later visibility changes do not retrigger", () => {
    const tracker = createActiveTabScrollTracker();
    const state = outlineState([
      windowNode("window:1", ["tab:hidden"], { active: true }),
      tabNode("tab:hidden", "window:1", { active: true })
    ]);

    expect(observeActiveTabScrollTarget(tracker, state, { hasRenderedNode: () => false })).toBeUndefined();
    expect(observeActiveTabScrollTarget(tracker, state, { hasRenderedNode: () => true })).toBeUndefined();
  });

  it("can observe a precomputed active node without rescanning state", () => {
    const tracker = createActiveTabScrollTracker();

    expect(observeActiveTabNodeId(tracker, "tab:1")).toBe("tab:1");
    expect(observeActiveTabNodeId(tracker, "tab:1")).toBeUndefined();
    expect(observeActiveTabNodeId(tracker, "tab:2", { hasRenderedNode: () => false })).toBeUndefined();
    expect(observeActiveTabNodeId(tracker, "tab:2", { hasRenderedNode: () => true })).toBeUndefined();
  });

  it("scrolls a newly observed active projection row into view", () => {
    const tracker = createActiveTabScrollTracker();
    const viewport = {
      scrollTop: 0,
      clientHeight: 60
    };

    expect(scrollActiveTabIntoView(tracker, {
      activeTabNodeId: "tab:20",
      activeTabRowIndex: 20,
      visibleNodeIdSet: new Set(["tab:20"])
    }, viewport, 10)).toBe(true);

    expect(viewport.scrollTop).toBe(150);
    expect(scrollActiveTabIntoView(tracker, {
      activeTabNodeId: "tab:20",
      activeTabRowIndex: 20,
      visibleNodeIdSet: new Set(["tab:20"])
    }, viewport, 10)).toBe(false);
    expect(viewport.scrollTop).toBe(150);
  });

  it("retries visible active rows when the viewport is not measurable yet", () => {
    const tracker = createActiveTabScrollTracker();
    const viewport = {
      scrollTop: 0,
      clientHeight: 0
    };

    expect(scrollActiveTabIntoView(tracker, {
      activeTabNodeId: "tab:20",
      activeTabRowIndex: 20,
      visibleNodeIdSet: new Set(["tab:20"])
    }, viewport, 10)).toBe(false);

    viewport.clientHeight = 60;
    expect(scrollActiveTabIntoView(tracker, {
      activeTabNodeId: "tab:20",
      activeTabRowIndex: 20,
      visibleNodeIdSet: new Set(["tab:20"])
    }, viewport, 10)).toBe(true);
    expect(viewport.scrollTop).toBe(150);
  });

  it("retries visible active rows when scrollTop is clamped before virtual height is ready", () => {
    const tracker = createActiveTabScrollTracker();
    let clampedScrollTop = 0;
    const clampedViewport = {
      get scrollTop() {
        return clampedScrollTop;
      },
      set scrollTop(value: number) {
        clampedScrollTop = Math.min(0, value);
      },
      clientHeight: 60
    };

    expect(scrollActiveTabIntoView(tracker, {
      activeTabNodeId: "tab:20",
      activeTabRowIndex: 20,
      visibleNodeIdSet: new Set(["tab:20"])
    }, clampedViewport, 10)).toBe(false);
    expect(clampedViewport.scrollTop).toBe(0);

    const readyViewport = {
      scrollTop: 0,
      clientHeight: 60
    };
    expect(scrollActiveTabIntoView(tracker, {
      activeTabNodeId: "tab:20",
      activeTabRowIndex: 20,
      visibleNodeIdSet: new Set(["tab:20"])
    }, readyViewport, 10)).toBe(true);
    expect(readyViewport.scrollTop).toBe(150);
  });

  it("can be reset so a structurally moved active node scrolls again", () => {
    const tracker = createActiveTabScrollTracker();
    const viewport = {
      scrollTop: 0,
      clientHeight: 60
    };

    expect(scrollActiveTabIntoView(tracker, {
      activeTabNodeId: "tab:20",
      activeTabRowIndex: 20,
      visibleNodeIdSet: new Set(["tab:20"])
    }, viewport, 10)).toBe(true);

    viewport.scrollTop = 0;
    expect(scrollActiveTabIntoView(tracker, {
      activeTabNodeId: "tab:20",
      activeTabRowIndex: 20,
      visibleNodeIdSet: new Set(["tab:20"])
    }, viewport, 10)).toBe(false);

    resetActiveTabScrollTracker(tracker);
    expect(scrollActiveTabIntoView(tracker, {
      activeTabNodeId: "tab:20",
      activeTabRowIndex: 20,
      visibleNodeIdSet: new Set(["tab:20"])
    }, viewport, 10)).toBe(true);
    expect(viewport.scrollTop).toBe(150);
  });
});

function outlineState(nodes: OutlineNode[]): OutlineState {
  return {
    version: 1,
    rootIds: nodes.filter((node) => !node.parentId).map((node) => node.id),
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node]))
  };
}

function windowNode(
  id: NodeId,
  childIds: NodeId[],
  options: Partial<Pick<OutlineNode, "active" | "collapsed">> = {}
): OutlineNode {
  return {
    id,
    kind: "window",
    status: "live",
    childIds,
    title: "Window",
    active: options.active ?? false,
    collapsed: options.collapsed ?? false,
    createdAt: 1,
    updatedAt: 1,
    live: { windowId: Number(id.replace(/\D/g, "")) || 1 }
  };
}

function tabNode(
  id: NodeId,
  parentId: NodeId,
  options: Partial<Pick<OutlineNode, "active" | "childIds" | "collapsed">> = {}
): OutlineNode {
  return {
    id,
    kind: "tab",
    status: "live",
    parentId,
    childIds: options.childIds ?? [],
    title: id,
    active: options.active ?? false,
    collapsed: options.collapsed ?? false,
    createdAt: 1,
    updatedAt: 1,
    live: { tabId: Number(id.replace(/\D/g, "")) || 1, windowId: 1 }
  };
}

function deepActiveState(depth: number): OutlineState {
  const root = windowNode("window:1", ["tab:1"], { active: true });
  const nodes: Record<NodeId, OutlineNode> = {
    [root.id]: root
  };

  for (let index = 1; index <= depth; index += 1) {
    const id = `tab:${index}`;
    nodes[id] = tabNode(id, index === 1 ? root.id : `tab:${index - 1}`, {
      active: index === depth,
      childIds: index === depth ? [] : [`tab:${index + 1}`]
    });
  }

  return {
    version: 1,
    rootIds: [root.id],
    nodes
  };
}
