import { describe, expect, it } from "vitest";
import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import {
  generatedTraceConfig,
  generatedTraceTimeoutMs
} from "../test/generated-traces.test-support.js";
import {
  createActiveTabScrollTracker,
  findActiveTabNodeId,
  observeActiveTabNodeId,
  observeActiveTabScrollTarget,
  resetActiveTabScrollTracker,
  scrollActiveTabIntoView
} from "./active-scroll.js";
import { buildVisibleTreeProjection } from "./visible-tree.js";

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

  it("skips outliner sidebar pages as active-scroll targets", () => {
    const state = outlineState([
      windowNode("window:1", ["tab:outliner"], { active: true }),
      tabNode("tab:outliner", "window:1", {
        active: true,
        url: "moz-extension://extension-id/sidebar/sidebar.html"
      }),
      windowNode("window:2", ["tab:external"], { active: true }),
      tabNode("tab:external", "window:2", {
        active: true,
        url: "https://external.example/"
      })
    ]);

    expect(findActiveTabNodeId(state)).toBe("tab:external");
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

  it("retries hidden active nodes after they become renderable", () => {
    const tracker = createActiveTabScrollTracker();
    const state = outlineState([
      windowNode("window:1", ["tab:hidden"], { active: true }),
      tabNode("tab:hidden", "window:1", { active: true })
    ]);

    expect(
      observeActiveTabScrollTarget(tracker, state, { hasRenderedNode: () => false })
    ).toBeUndefined();
    expect(observeActiveTabScrollTarget(tracker, state, { hasRenderedNode: () => true })).toBe(
      "tab:hidden"
    );
  });

  it("can observe a precomputed active node without rescanning state", () => {
    const tracker = createActiveTabScrollTracker();

    expect(observeActiveTabNodeId(tracker, "tab:1")).toBe("tab:1");
    expect(observeActiveTabNodeId(tracker, "tab:1")).toBeUndefined();
    expect(
      observeActiveTabNodeId(tracker, "tab:2", { hasRenderedNode: () => false })
    ).toBeUndefined();
    expect(observeActiveTabNodeId(tracker, "tab:2", { hasRenderedNode: () => true })).toBe("tab:2");
  });

  it("scrolls a newly observed active projection row into view", () => {
    const tracker = createActiveTabScrollTracker();
    const viewport = {
      scrollTop: 0,
      clientHeight: 60,
      scrollHeight: 500
    };

    expect(
      scrollActiveTabIntoView(
        tracker,
        {
          activeTabNodeId: "tab:20",
          activeTabRowIndex: 20,
          visibleNodeIdSet: new Set(["tab:20"])
        },
        viewport,
        10
      )
    ).toBe(true);

    expect(viewport.scrollTop).toBe(175);
    expect(
      scrollActiveTabIntoView(
        tracker,
        {
          activeTabNodeId: "tab:20",
          activeTabRowIndex: 20,
          visibleNodeIdSet: new Set(["tab:20"])
        },
        viewport,
        10
      )
    ).toBe(false);
    expect(viewport.scrollTop).toBe(175);
  });

  it("clamps centered active-row scroll near the end of the tree", () => {
    const tracker = createActiveTabScrollTracker();
    const viewport = {
      scrollTop: 0,
      clientHeight: 60,
      scrollHeight: 500
    };

    expect(
      scrollActiveTabIntoView(
        tracker,
        {
          activeTabNodeId: "tab:47",
          activeTabRowIndex: 47,
          visibleNodeIdSet: new Set(["tab:47"])
        },
        viewport,
        10
      )
    ).toBe(true);

    expect(viewport.scrollTop).toBe(440);
  });

  it("retries visible active rows when the viewport is not measurable yet", () => {
    const tracker = createActiveTabScrollTracker();
    const viewport = {
      scrollTop: 0,
      clientHeight: 0,
      scrollHeight: 0
    };

    expect(
      scrollActiveTabIntoView(
        tracker,
        {
          activeTabNodeId: "tab:20",
          activeTabRowIndex: 20,
          visibleNodeIdSet: new Set(["tab:20"])
        },
        viewport,
        10
      )
    ).toBe(false);

    viewport.clientHeight = 60;
    viewport.scrollHeight = 500;
    expect(
      scrollActiveTabIntoView(
        tracker,
        {
          activeTabNodeId: "tab:20",
          activeTabRowIndex: 20,
          visibleNodeIdSet: new Set(["tab:20"])
        },
        viewport,
        10
      )
    ).toBe(true);
    expect(viewport.scrollTop).toBe(175);
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
      clientHeight: 60,
      scrollHeight: 0
    };

    expect(
      scrollActiveTabIntoView(
        tracker,
        {
          activeTabNodeId: "tab:20",
          activeTabRowIndex: 20,
          visibleNodeIdSet: new Set(["tab:20"])
        },
        clampedViewport,
        10
      )
    ).toBe(false);
    expect(clampedViewport.scrollTop).toBe(0);

    const readyViewport = {
      scrollTop: 0,
      clientHeight: 60,
      scrollHeight: 500
    };
    expect(
      scrollActiveTabIntoView(
        tracker,
        {
          activeTabNodeId: "tab:20",
          activeTabRowIndex: 20,
          visibleNodeIdSet: new Set(["tab:20"])
        },
        readyViewport,
        10
      )
    ).toBe(true);
    expect(readyViewport.scrollTop).toBe(175);
  });

  it("retries active projection rows that become visible after being hidden", () => {
    const tracker = createActiveTabScrollTracker();
    const hiddenViewport = {
      scrollTop: 0,
      clientHeight: 60,
      scrollHeight: 500
    };

    expect(
      scrollActiveTabIntoView(
        tracker,
        {
          activeTabNodeId: "tab:20",
          visibleNodeIdSet: new Set()
        },
        hiddenViewport,
        10
      )
    ).toBe(false);
    expect(hiddenViewport.scrollTop).toBe(0);

    const readyViewport = {
      scrollTop: 0,
      clientHeight: 60,
      scrollHeight: 500
    };
    expect(
      scrollActiveTabIntoView(
        tracker,
        {
          activeTabNodeId: "tab:20",
          activeTabRowIndex: 20,
          visibleNodeIdSet: new Set(["tab:20"])
        },
        readyViewport,
        10
      )
    ).toBe(true);
    expect(readyViewport.scrollTop).toBe(175);
  });

  it("can be reset so a structurally moved active node scrolls again", () => {
    const tracker = createActiveTabScrollTracker();
    const viewport = {
      scrollTop: 0,
      clientHeight: 60,
      scrollHeight: 500
    };

    expect(
      scrollActiveTabIntoView(
        tracker,
        {
          activeTabNodeId: "tab:20",
          activeTabRowIndex: 20,
          visibleNodeIdSet: new Set(["tab:20"])
        },
        viewport,
        10
      )
    ).toBe(true);

    viewport.scrollTop = 0;
    expect(
      scrollActiveTabIntoView(
        tracker,
        {
          activeTabNodeId: "tab:20",
          activeTabRowIndex: 20,
          visibleNodeIdSet: new Set(["tab:20"])
        },
        viewport,
        10
      )
    ).toBe(false);

    resetActiveTabScrollTracker(tracker);
    expect(
      scrollActiveTabIntoView(
        tracker,
        {
          activeTabNodeId: "tab:20",
          activeTabRowIndex: 20,
          visibleNodeIdSet: new Set(["tab:20"])
        },
        viewport,
        10
      )
    ).toBe(true);
    expect(viewport.scrollTop).toBe(175);
  });
});

describe("active scroll generated search/collapse traces", () => {
  it(
    "scrolls newly visible active tabs across deterministic search and collapse interleavings",
    () => {
      const config = generatedTraceConfig({
        defaultSeedCount: 32,
        defaultSteps: 6,
        soakSeedCount: 96,
        soakSteps: 24
      });
      for (const seed of config.seeds) {
        runSearchCollapseTrace(seed, config.steps);
      }
    },
    generatedTraceTimeoutMs(10_000, 120_000)
  );
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
  options: Partial<Pick<OutlineNode, "active" | "childIds" | "collapsed" | "url">> = {}
): OutlineNode {
  return {
    id,
    kind: "tab",
    status: "live",
    parentId,
    childIds: options.childIds ?? [],
    title: id,
    ...(options.url ? { url: options.url } : {}),
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

type SearchCollapseTraceState = {
  state: OutlineState;
  leavesByParent: Map<NodeId, NodeId[]>;
  leafIds: NodeId[];
  plainLeafIds: NodeId[];
  parentIds: NodeId[];
};

function runSearchCollapseTrace(seed: number, cycles: number): void {
  const fixture = searchCollapseTraceState();
  const tracker = createActiveTabScrollTracker();
  const viewport = {
    scrollTop: 0,
    clientHeight: 40,
    scrollHeight: 0
  };
  const oracle: { observedActiveNodeId?: NodeId } = {};
  const rng = seededRandom(seed);
  const history = [`seed ${seed}`];
  let query = "";

  const render = (label: string): void => {
    assertTraceScrollState(fixture.state, query, tracker, viewport, oracle, [...history, label]);
  };

  render("initial render");

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    const searchHiddenTarget = pickOne(rng, fixture.plainLeafIds);
    query = "needle";
    history.push(`cycle ${cycle}: search needle`);
    render("search render");

    activateTraceNode(fixture.state, searchHiddenTarget);
    viewport.scrollTop = 0;
    history.push(`cycle ${cycle}: activate ${searchHiddenTarget} while hidden by search`);
    render("hidden active under search");

    toggleTraceCollapse(fixture.state, parentIdForLeaf(searchHiddenTarget));
    history.push(`cycle ${cycle}: toggle ancestor while active is search-hidden`);
    render("search-hidden after collapse toggle");

    query = "";
    history.push(`cycle ${cycle}: clear search`);
    render("cleared search render");

    ensureExpanded(fixture.state, parentIdForLeaf(searchHiddenTarget));
    history.push(`cycle ${cycle}: ensure ancestor expanded after search clear`);
    render("revealed after search clear");

    const collapseParent = pickOne(rng, fixture.parentIds);
    const collapseTarget = pickOne(
      rng,
      fixture.leavesByParent.get(collapseParent) ?? fixture.leafIds
    );
    query = "";
    ensureExpanded(fixture.state, collapseParent);
    history.push(`cycle ${cycle}: reset ${collapseParent} expanded`);
    render("expanded before collapse scenario");

    toggleTraceCollapse(fixture.state, collapseParent);
    history.push(`cycle ${cycle}: collapse ${collapseParent}`);
    render("collapsed ancestor render");

    activateTraceNode(fixture.state, collapseTarget);
    viewport.scrollTop = 0;
    history.push(`cycle ${cycle}: activate ${collapseTarget} while hidden by collapsed ancestor`);
    render("hidden active under collapsed ancestor");

    query = rng() < 0.5 ? "needle" : "missing";
    history.push(`cycle ${cycle}: set search ${query} while ancestor is collapsed`);
    render("search while collapsed");

    query = "";
    history.push(`cycle ${cycle}: clear search while ancestor is still collapsed`);
    render("cleared search while collapsed");

    ensureExpanded(fixture.state, collapseParent);
    history.push(`cycle ${cycle}: expand ${collapseParent}`);
    render("revealed after collapse");

    runSearchCollapseNoiseStep(fixture, rng, history, render);
  }
}

function assertTraceScrollState(
  state: OutlineState,
  query: string,
  tracker: ReturnType<typeof createActiveTabScrollTracker>,
  viewport: { scrollTop: number; clientHeight: number; scrollHeight: number },
  oracle: { observedActiveNodeId?: NodeId },
  history: string[]
): void {
  const rowHeight = 10;
  const projection = buildVisibleTreeProjection(state, query);
  viewport.scrollHeight = projection.rows.length * rowHeight;

  const activeNodeId = projection.activeTabNodeId;
  const activeRowIndex = projection.activeTabRowIndex;
  const activeIsVisible =
    Boolean(activeNodeId) &&
    typeof activeRowIndex === "number" &&
    projection.visibleNodeIdSet.has(activeNodeId!);
  const previouslyObserved = Boolean(activeNodeId && oracle.observedActiveNodeId === activeNodeId);
  const expectedScrollTop = activeIsVisible
    ? expectedCenteredScrollTop(activeRowIndex!, viewport, rowHeight)
    : undefined;

  scrollActiveTabIntoView(tracker, projection, viewport, rowHeight);

  if (!activeNodeId) {
    delete oracle.observedActiveNodeId;
    return;
  }
  if (!activeIsVisible) {
    return;
  }

  if (
    !previouslyObserved &&
    typeof expectedScrollTop === "number" &&
    viewport.scrollHeight > viewport.clientHeight
  ) {
    traceInvariant(
      Math.abs(viewport.scrollTop - expectedScrollTop) < 0.001,
      history,
      `expected newly visible active ${activeNodeId} to scroll to ${expectedScrollTop}, got ${viewport.scrollTop}`
    );
  }
  if (
    typeof expectedScrollTop === "number" &&
    Math.abs(viewport.scrollTop - expectedScrollTop) < 0.001
  ) {
    oracle.observedActiveNodeId = activeNodeId;
  }
}

function expectedCenteredScrollTop(
  rowIndex: number,
  viewport: { clientHeight: number; scrollHeight: number },
  rowHeight: number
): number {
  const centeredScrollTop = Math.max(
    0,
    rowIndex * rowHeight + rowHeight / 2 - viewport.clientHeight / 2
  );
  return Math.min(centeredScrollTop, Math.max(0, viewport.scrollHeight - viewport.clientHeight));
}

function runSearchCollapseNoiseStep(
  fixture: SearchCollapseTraceState,
  rng: () => number,
  history: string[],
  render: (label: string) => void
): void {
  const operation = Math.floor(rng() * 4);
  if (operation === 0) {
    const parentId = pickOne(rng, fixture.parentIds);
    toggleTraceCollapse(fixture.state, parentId);
    history.push(`noise: toggle ${parentId}`);
    render("noise collapse render");
    return;
  }
  if (operation === 1) {
    const target = pickOne(rng, fixture.leafIds);
    activateTraceNode(fixture.state, target);
    history.push(`noise: activate ${target}`);
    render("noise active render");
    return;
  }
  history.push("noise: full projection render");
  render("noise full render");
}

function searchCollapseTraceState(): SearchCollapseTraceState {
  const now = 1;
  const parentIds = ["tab:parent:1", "tab:parent:2", "tab:parent:3", "tab:parent:4"];
  const leafIds: NodeId[] = [];
  const plainLeafIds: NodeId[] = [];
  const leavesByParent = new Map<NodeId, NodeId[]>();
  const nodes: Record<NodeId, OutlineNode> = {
    "window:1": {
      id: "window:1",
      kind: "window",
      status: "live",
      childIds: ["tab:home", ...parentIds],
      title: "Window",
      active: true,
      collapsed: false,
      createdAt: now,
      updatedAt: now,
      live: { windowId: 1 }
    },
    "tab:home": {
      id: "tab:home",
      kind: "tab",
      status: "live",
      parentId: "window:1",
      childIds: [],
      title: "Needle home",
      active: true,
      collapsed: false,
      createdAt: now,
      updatedAt: now,
      live: { tabId: 1, windowId: 1 }
    }
  };

  let tabId = 2;
  for (const [parentIndex, parentId] of parentIds.entries()) {
    const children = Array.from(
      { length: 12 },
      (_value, childIndex) => `tab:${parentIndex + 1}:${childIndex + 1}`
    );
    leavesByParent.set(parentId, children);
    nodes[parentId] = {
      id: parentId,
      kind: "tab",
      status: "live",
      parentId: "window:1",
      childIds: children,
      title: `Parent ${parentIndex + 1}`,
      active: false,
      collapsed: false,
      createdAt: now,
      updatedAt: now,
      live: { tabId: tabId++, windowId: 1 }
    };

    for (const [childIndex, childId] of children.entries()) {
      const isNeedle = childIndex % 4 === 0;
      leafIds.push(childId);
      if (!isNeedle) {
        plainLeafIds.push(childId);
      }
      nodes[childId] = {
        id: childId,
        kind: "tab",
        status: "live",
        parentId,
        childIds: [],
        title: isNeedle ? `Needle child ${childId}` : `Plain child ${childId}`,
        active: false,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { tabId: tabId++, windowId: 1 }
      };
    }
  }

  return {
    state: {
      version: 1,
      rootIds: ["window:1"],
      nodes
    },
    leavesByParent,
    leafIds,
    plainLeafIds,
    parentIds
  };
}

function activateTraceNode(state: OutlineState, nodeId: NodeId): void {
  for (const node of Object.values(state.nodes)) {
    if (node.kind === "tab") {
      node.active = node.id === nodeId;
    }
  }
}

function toggleTraceCollapse(state: OutlineState, nodeId: NodeId): void {
  const node = state.nodes[nodeId];
  if (node) {
    node.collapsed = !node.collapsed;
  }
}

function ensureExpanded(state: OutlineState, nodeId: NodeId): void {
  const node = state.nodes[nodeId];
  if (node) {
    node.collapsed = false;
  }
}

function parentIdForLeaf(nodeId: NodeId): NodeId {
  return `tab:parent:${nodeId.split(":")[1]}`;
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function pickOne<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)]!;
}

function traceInvariant(condition: boolean, history: string[], message: string): void {
  if (!condition) {
    throw new Error(`${message}\nTrace:\n${history.join("\n")}`);
  }
}
