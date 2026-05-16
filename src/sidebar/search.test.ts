import { describe, expect, it } from "vitest";
import type { NodeId, OutlineNode, OutlineState } from "../model/types.js";
import { computeOutlineSearch } from "./search.js";

describe("computeOutlineSearch", () => {
  it("matches titles case-insensitively and trims queries", () => {
    const state = outlineState([
      windowNode("window:1", ["tab:docs"]),
      tabNode("tab:docs", "window:1", "Project Docs")
    ]);

    expect(computeOutlineSearch(state, "  docs  ")).toMatchObject({
      isActive: true,
      query: "docs",
      visibleNodeIds: ["window:1", "tab:docs"],
      matchCount: 1
    });
  });

  it("matches URLs", () => {
    const state = outlineState([
      windowNode("window:1", ["tab:docs", "tab:mail"]),
      tabNode("tab:docs", "window:1", "Docs", "https://example.com/spec"),
      tabNode("tab:mail", "window:1", "Mail", "https://mail.example.com")
    ]);

    expect(computeOutlineSearch(state, "spec").visibleNodeIds).toEqual(["window:1", "tab:docs"]);
    expect([...computeOutlineSearch(state, "spec").matchingNodeIds]).toEqual(["tab:docs"]);
  });

  it("returns every root path in outline order for an empty trimmed query", () => {
    const state = outlineState([
      windowNode("window:1", ["tab:alpha"]),
      tabNode("tab:alpha", "window:1", "Alpha"),
      windowNode("window:2", ["tab:beta"]),
      tabNode("tab:beta", "window:2", "Beta")
    ]);

    expect(computeOutlineSearch(state, "   ")).toMatchObject({
      isActive: false,
      query: "",
      visibleNodeIds: ["window:1", "tab:alpha", "window:2", "tab:beta"],
      matchCount: 0
    });
  });

  it("keeps ancestors of matching descendants visible", () => {
    const state = outlineState([
      windowNode("window:1", ["tab:parent"]),
      tabNode("tab:parent", "window:1", "Parent"),
      tabNode("tab:child", "tab:parent", "Needle")
    ]);
    state.nodes["tab:parent"]!.childIds = ["tab:child"];

    expect(computeOutlineSearch(state, "needle")).toMatchObject({
      visibleNodeIds: ["window:1", "tab:parent", "tab:child"],
      matchCount: 1
    });
  });

  it("hides unrelated branches", () => {
    const state = outlineState([
      windowNode("window:1", ["tab:match", "tab:other"]),
      tabNode("tab:match", "window:1", "Needle"),
      tabNode("tab:other", "window:1", "Other"),
      windowNode("window:2", ["tab:elsewhere"]),
      tabNode("tab:elsewhere", "window:2", "Elsewhere")
    ]);

    expect(computeOutlineSearch(state, "needle").visibleNodeIds).toEqual(["window:1", "tab:match"]);
  });

  it("includes matching descendants below collapsed ancestors without matching those ancestors", () => {
    const state = outlineState([
      windowNode("window:1", ["tab:parent"], { collapsed: true }),
      tabNode("tab:parent", "window:1", "Parent", undefined, { collapsed: true }),
      tabNode("tab:child", "tab:parent", "Needle")
    ]);
    state.nodes["tab:parent"]!.childIds = ["tab:child"];

    const result = computeOutlineSearch(state, "needle");

    expect(result.visibleNodeIds).toEqual(["window:1", "tab:parent", "tab:child"]);
    expect([...result.matchingNodeIds]).toEqual(["tab:child"]);
    expect(result.matchCount).toBe(1);
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
  options: Partial<Pick<OutlineNode, "collapsed">> = {}
): OutlineNode {
  return {
    id,
    kind: "window",
    status: "live",
    childIds,
    title: "Window",
    collapsed: options.collapsed ?? false,
    createdAt: 1,
    updatedAt: 1,
    live: { windowId: Number(id.replace(/\D/g, "")) || 1 }
  };
}

function tabNode(
  id: NodeId,
  parentId: NodeId,
  title: string,
  url?: string,
  options: Partial<Pick<OutlineNode, "collapsed">> = {}
): OutlineNode {
  return {
    id,
    kind: "tab",
    status: "live",
    parentId,
    childIds: [],
    title,
    ...(url ? { url } : {}),
    collapsed: options.collapsed ?? false,
    createdAt: 1,
    updatedAt: 1,
    live: { tabId: Number(id.replace(/\D/g, "")) || 1, windowId: 1 }
  };
}
