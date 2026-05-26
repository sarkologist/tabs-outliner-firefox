import { describe, expect, it } from "vitest";

import type { OutlineState } from "../model/types.js";
import { mergePartialOutlineState } from "./partial-outline-state.js";

describe("partial outline state merge", () => {
  it("does not prune known siblings when merging an incomplete projection snapshot", () => {
    const current = fixtureState();
    const merged = mergePartialOutlineState(current, {
      version: 1,
      rootIds: ["window:1"],
      nodes: {
        "window:1": {
          ...current.nodes["window:1"]!,
          childIds: ["group:hidden"]
        },
        "group:hidden": {
          ...current.nodes["group:hidden"]!,
          childIds: ["hidden:42"]
        },
        "hidden:42": {
          id: "hidden:42",
          kind: "tab",
          status: "closed",
          parentId: "group:hidden",
          childIds: [],
          title: "Hidden 42",
          url: "https://hidden.example/42",
          collapsed: false,
          createdAt: 1000,
          updatedAt: 1000,
          closedAt: 1001
        }
      }
    });

    expect(merged.rootIds).toEqual(["window:1", "window:2"]);
    expect(merged.nodes["window:1"]?.childIds).toEqual(["tab:visible", "group:hidden"]);
    expect(merged.nodes["group:hidden"]?.childIds).toEqual(["hidden:42"]);
    expect(merged.nodes["hidden:42"]?.title).toBe("Hidden 42");
  });

  it("accepts incoming child removals for complete sibling snapshots", () => {
    const current = fixtureState();
    const merged = mergePartialOutlineState(
      current,
      {
        version: 1,
        rootIds: ["window:1"],
        nodes: {
          "window:1": {
            ...current.nodes["window:1"]!,
            childIds: ["group:hidden"]
          }
        }
      },
      { completeSiblingParentIds: new Set(["window:1"]) }
    );

    expect(merged.nodes["window:1"]?.childIds).toEqual(["group:hidden"]);
  });
});

function fixtureState(): OutlineState {
  return {
    version: 1,
    rootIds: ["window:1", "window:2"],
    nodes: {
      "window:1": {
        id: "window:1",
        kind: "window",
        status: "live",
        childIds: ["tab:visible", "group:hidden"],
        title: "Window",
        active: true,
        collapsed: false,
        createdAt: 1000,
        updatedAt: 1000,
        live: { windowId: 1 }
      },
      "tab:visible": {
        id: "tab:visible",
        kind: "tab",
        status: "live",
        parentId: "window:1",
        childIds: [],
        title: "Visible",
        url: "https://visible.example/",
        active: true,
        collapsed: false,
        createdAt: 1000,
        updatedAt: 1000,
        live: { tabId: 1, windowId: 1 }
      },
      "group:hidden": {
        id: "group:hidden",
        kind: "group",
        status: "closed",
        parentId: "window:1",
        childIds: [],
        title: "Hidden group",
        collapsed: true,
        createdAt: 1000,
        updatedAt: 1000,
        closedAt: 1000
      },
      "window:2": {
        id: "window:2",
        kind: "window",
        status: "closed",
        childIds: [],
        title: "Other root",
        collapsed: true,
        createdAt: 1000,
        updatedAt: 1000,
        closedAt: 1000
      }
    }
  };
}
