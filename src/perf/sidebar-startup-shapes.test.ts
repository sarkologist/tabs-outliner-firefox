import {
  DEFAULT_ORDER_PAGE_HEAVY_TAB_NODES,
  ORDER_PAGE_HEAVY_LEAF_GROUPS,
  ORDER_PAGE_HEAVY_PARENT_COUNT,
  makeSidebarStartupState,
  sidebarStartupShapeStats,
  validateSidebarStartupShapeOptions
} from "./sidebar-startup-shapes.js";

describe("sidebar startup profile shapes", () => {
  it("builds the closed-heavy shape used by the existing startup profile", () => {
    const state = makeSidebarStartupState({
      shape: "closed-heavy",
      tabs: 50_000,
      liveTabs: 50
    });
    const root = state.nodes["window:10"];

    expect(state.rootIds).toEqual(["window:10"]);
    expect(root?.kind).toBe("window");
    expect(root?.childIds).toHaveLength(50_000);
    expect(state.nodes["tab:1"]).toMatchObject({
      kind: "tab",
      status: "live",
      active: true,
      live: { tabId: 1, windowId: 10 }
    });
    expect(state.nodes["tab:51"]).toMatchObject({
      kind: "tab",
      status: "closed",
      restore: { url: "https://restore.example/51", title: "Saved 51" }
    });
    expect(sidebarStartupShapeStats(state)).toMatchObject({
      totalNodes: 50_001,
      tabNodes: 50_000,
      liveTabNodes: 50,
      parentsWithChildren: 1
    });
  });

  it("builds the calibrated order-page-heavy shape", () => {
    const state = makeSidebarStartupState({
      shape: "order-page-heavy",
      tabs: DEFAULT_ORDER_PAGE_HEAVY_TAB_NODES,
      liveTabs: 50
    });
    const stats = sidebarStartupShapeStats(state);

    expect(stats).toMatchObject({
      totalNodes: 26_495,
      tabNodes: 19_433,
      liveTabNodes: 50,
      parentsWithChildren: ORDER_PAGE_HEAVY_PARENT_COUNT
    });
    expect(Object.values(state.nodes).filter((node) => node.kind === "group" && node.parentId === "window:10"))
      .toHaveLength(100);
    expect(Object.values(state.nodes).filter((node) => node.kind === "group" && node.parentId !== "window:10"))
      .toHaveLength(ORDER_PAGE_HEAVY_LEAF_GROUPS);
    expect(Object.values(state.nodes).filter((node) => node.childIds.length > 1024)).toEqual([]);
  });

  it("rejects order-page-heavy runs that cannot give every leaf group a tab child", () => {
    expect(() => validateSidebarStartupShapeOptions({
      shape: "order-page-heavy",
      tabs: ORDER_PAGE_HEAVY_LEAF_GROUPS + 49,
      liveTabs: 50
    })).toThrow(/every leaf group/i);
  });
});
