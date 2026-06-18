import type { OutlineNode, OutlineState } from "../model/types.js";

export const SIDEBAR_STARTUP_SHAPES = [
  "closed-heavy",
  "order-page-heavy",
  "real-browser-20260526"
] as const;

export type SidebarStartupShape = (typeof SIDEBAR_STARTUP_SHAPES)[number];

export const DEFAULT_CLOSED_HEAVY_TAB_NODES = 50_000;
export const DEFAULT_ORDER_PAGE_HEAVY_TAB_NODES = 19_433;
export const ORDER_PAGE_HEAVY_SECTION_GROUPS = 100;
export const ORDER_PAGE_HEAVY_LEAF_GROUPS = 6_961;
export const ORDER_PAGE_HEAVY_PARENT_COUNT =
  1 + ORDER_PAGE_HEAVY_SECTION_GROUPS + ORDER_PAGE_HEAVY_LEAF_GROUPS;
export const ORDER_PAGE_HEAVY_ORDER_PAGE_SIZE = 1_024;

export type SidebarStartupShapeOptions = {
  shape: SidebarStartupShape;
  tabs: number;
  liveTabs: number;
};

export type SidebarStartupShapeStats = {
  totalNodes: number;
  tabNodes: number;
  liveTabNodes: number;
  parentsWithChildren: number;
  maxChildrenPerParent: number;
};

export function defaultTabsForSidebarStartupShape(shape: SidebarStartupShape): number {
  return isOrderPageHeavyStartupShape(shape)
    ? DEFAULT_ORDER_PAGE_HEAVY_TAB_NODES
    : DEFAULT_CLOSED_HEAVY_TAB_NODES;
}

export function isSidebarStartupShape(value: string): value is SidebarStartupShape {
  return SIDEBAR_STARTUP_SHAPES.includes(value as SidebarStartupShape);
}

export function isOrderPageHeavyStartupShape(shape: SidebarStartupShape): boolean {
  return shape === "order-page-heavy" || shape === "real-browser-20260526";
}

export function validateSidebarStartupShapeOptions(options: SidebarStartupShapeOptions): void {
  if (!Number.isFinite(options.tabs) || options.tabs < 1) {
    throw new Error("--tabs must be a positive integer");
  }
  if (!Number.isFinite(options.liveTabs) || options.liveTabs < 1) {
    throw new Error("--live-tabs must be a positive integer");
  }
  if (options.liveTabs > options.tabs) {
    throw new Error("--live-tabs must be less than or equal to --tabs");
  }
  if (!isOrderPageHeavyStartupShape(options.shape)) {
    return;
  }

  const closedTabNodes = options.tabs - options.liveTabs;
  if (closedTabNodes < ORDER_PAGE_HEAVY_LEAF_GROUPS) {
    throw new Error(
      `--tabs must be at least --live-tabs + ${ORDER_PAGE_HEAVY_LEAF_GROUPS} so every leaf group has a tab child`
    );
  }
  if (closedTabNodes > ORDER_PAGE_HEAVY_LEAF_GROUPS * ORDER_PAGE_HEAVY_ORDER_PAGE_SIZE) {
    throw new Error(
      `--tabs is too large for the order-page-heavy shape without exceeding ${ORDER_PAGE_HEAVY_ORDER_PAGE_SIZE} children per leaf group`
    );
  }
}

export function makeSidebarStartupState(options: SidebarStartupShapeOptions): OutlineState {
  validateSidebarStartupShapeOptions(options);
  return isOrderPageHeavyStartupShape(options.shape)
    ? makeOrderPageHeavyStartupState(options.tabs, options.liveTabs)
    : makeClosedHeavyStartupState(options.tabs, options.liveTabs);
}

export function sidebarStartupShapeStats(state: OutlineState): SidebarStartupShapeStats {
  const nodes = Object.values(state.nodes);
  const tabNodes = nodes.filter((node) => node.kind === "tab");
  const parents = nodes.filter((node) => node.childIds.length > 0);
  return {
    totalNodes: nodes.length,
    tabNodes: tabNodes.length,
    liveTabNodes: tabNodes.filter((node) => node.status === "live").length,
    parentsWithChildren: parents.length,
    maxChildrenPerParent: Math.max(0, ...parents.map((node) => node.childIds.length))
  };
}

function makeClosedHeavyStartupState(tabCount: number, liveTabCount: number): OutlineState {
  const root: OutlineNode = {
    id: "window:10",
    kind: "window",
    status: "live",
    childIds: [],
    title: "Window 10",
    active: true,
    collapsed: false,
    createdAt: 1000,
    updatedAt: 1000,
    live: { windowId: 10 }
  };
  const state: OutlineState = {
    version: 1,
    rootIds: [root.id],
    nodes: {
      [root.id]: root
    }
  };

  for (let index = 1; index <= tabCount; index += 1) {
    const id = `tab:${index}`;
    root.childIds.push(id);
    if (index <= liveTabCount) {
      state.nodes[id] = liveTabNode(id, root.id, index, index === 1);
    } else {
      state.nodes[id] = closedTabNode(id, root.id, index);
    }
  }

  return state;
}

function makeOrderPageHeavyStartupState(tabCount: number, liveTabCount: number): OutlineState {
  const root: OutlineNode = {
    id: "window:10",
    kind: "window",
    status: "live",
    childIds: [],
    title: "Window 10",
    active: true,
    collapsed: false,
    createdAt: 1000,
    updatedAt: 1000,
    live: { windowId: 10 }
  };
  const state: OutlineState = {
    version: 1,
    rootIds: [root.id],
    nodes: {
      [root.id]: root
    }
  };

  for (let index = 1; index <= liveTabCount; index += 1) {
    const id = `tab:${index}`;
    root.childIds.push(id);
    state.nodes[id] = liveTabNode(id, root.id, index, index === 1);
  }

  const sectionIds: string[] = [];
  for (let index = 1; index <= ORDER_PAGE_HEAVY_SECTION_GROUPS; index += 1) {
    const id = `group:section:${index}`;
    sectionIds.push(id);
    root.childIds.push(id);
    state.nodes[id] = neutralGroupNode(id, root.id, `Section ${index}`);
  }

  const closedTabCount = tabCount - liveTabCount;
  const baseTabsPerLeaf = Math.floor(closedTabCount / ORDER_PAGE_HEAVY_LEAF_GROUPS);
  const extraTabs = closedTabCount % ORDER_PAGE_HEAVY_LEAF_GROUPS;
  let nextTabIndex = liveTabCount + 1;

  for (let leafIndex = 0; leafIndex < ORDER_PAGE_HEAVY_LEAF_GROUPS; leafIndex += 1) {
    const leafId = `group:leaf:${leafIndex + 1}`;
    const sectionId = sectionIds[leafIndex % sectionIds.length]!;
    const section = state.nodes[sectionId]!;
    section.childIds.push(leafId);
    const leaf = neutralGroupNode(leafId, sectionId, `Saved Group ${leafIndex + 1}`);
    const tabChildren = baseTabsPerLeaf + (leafIndex < extraTabs ? 1 : 0);

    for (let index = 0; index < tabChildren; index += 1) {
      const tabId = `tab:${nextTabIndex}`;
      leaf.childIds.push(tabId);
      state.nodes[tabId] = closedTabNode(tabId, leafId, nextTabIndex);
      nextTabIndex += 1;
    }

    state.nodes[leafId] = leaf;
  }

  return state;
}

function liveTabNode(id: string, parentId: string, index: number, active: boolean): OutlineNode {
  return {
    id,
    kind: "tab",
    status: "live",
    parentId,
    childIds: [],
    title: `Tab ${index}`,
    url: `https://large.example/${index}`,
    active,
    collapsed: false,
    createdAt: 1000,
    updatedAt: 1000,
    live: {
      tabId: index,
      windowId: 10
    }
  };
}

function closedTabNode(id: string, parentId: string, index: number): OutlineNode {
  return {
    id,
    kind: "tab",
    status: "closed",
    parentId,
    childIds: [],
    title: `Saved ${index}`,
    url: `https://restore.example/${index}`,
    collapsed: false,
    createdAt: 1000,
    updatedAt: 1000,
    closedAt: 2000 + index,
    restore: {
      url: `https://restore.example/${index}`,
      title: `Saved ${index}`
    }
  };
}

function neutralGroupNode(id: string, parentId: string, title: string): OutlineNode {
  return {
    id,
    kind: "group",
    status: "neutral",
    parentId,
    childIds: [],
    title,
    collapsed: false,
    createdAt: 1000,
    updatedAt: 1000
  };
}
