import { describe, expect, it } from "vitest";

import { bootstrapFromWindows, closeTab, renameGroup } from "./outline.js";
import {
  PORTABLE_TREE_SCHEMA,
  appendPortableTree,
  exportPortableTree
} from "./portable-tree.js";
import type { OutlineNode, OutlineState, RuntimeWindow } from "./types.js";

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
        title: "Example",
        favIconUrl: "https://example.com/favicon.ico"
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

describe("portable tree files", () => {
  it("exports ordered tree content without lifecycle state", () => {
    const state = closeTab(bootstrapFromWindows(runtimeWindows, { now: 1000 }), 2, {
      now: 2000,
      sessionId: "session-tab-2"
    });
    state.nodes["tab:1"]!.collapsed = true;

    const exported = exportPortableTree(state, { now: 3000 });

    expect(exported).toEqual({
      schema: PORTABLE_TREE_SCHEMA,
      version: 1,
      exportedAt: "1970-01-01T00:00:03.000Z",
      roots: [
        {
          kind: "window",
          title: "Group",
          children: [
            {
              kind: "tab",
              title: "Example",
              url: "https://example.com/",
              favIconUrl: "https://example.com/favicon.ico",
              children: [
                {
                  kind: "tab",
                  title: "Child",
                  url: "https://example.com/child",
                  children: []
                }
              ]
            },
            {
              kind: "tab",
              title: "Other",
              url: "https://other.example/",
              children: []
            }
          ]
        }
      ]
    });
    expect(JSON.stringify(exported)).not.toMatch(
      /"status"|"live"|"active"|"collapsed"|"closedAt"|"createdAt"|"updatedAt"|"sessionId"/
    );
  });

  it("exports renamed group titles", () => {
    const state = renameGroup(bootstrapFromWindows(runtimeWindows, { now: 1000 }), "window:10", "Research", {
      now: 2000
    });

    const exported = exportPortableTree(state, { now: 3000 });

    expect(exported.roots[0]?.title).toBe("Research");
  });

  it("omits the outliner sidebar page from exports", () => {
    const state = bootstrapFromWindows([
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
            url: "moz-extension://extension-id/sidebar/sidebar.html",
            title: "Tab Session Outliner"
          },
          {
            id: 2,
            windowId: 10,
            index: 1,
            active: false,
            openerTabId: 1,
            url: "https://example.com/kept-child",
            title: "Kept Child"
          },
          {
            id: 3,
            windowId: 10,
            index: 2,
            active: false,
            url: "https://example.com/sibling",
            title: "Kept Sibling"
          }
        ]
      },
      {
        id: 20,
        focused: false,
        incognito: false,
        tabs: [
          {
            id: 4,
            windowId: 20,
            index: 0,
            active: true,
            url: "file:///Users/sark/code/tabs-outliner/public/sidebar/sidebar.html",
            title: "tabs-outliner/public/sidebar/sidebar.html"
          }
        ]
      }
    ], { now: 1000 });

    const exported = exportPortableTree(state, { now: 3000 });

    expect(exported.roots).toEqual([
      {
        kind: "window",
        title: "Group",
        children: [
          {
            kind: "tab",
            title: "Kept Child",
            url: "https://example.com/kept-child",
            children: []
          },
          {
            kind: "tab",
            title: "Kept Sibling",
            url: "https://example.com/sibling",
            children: []
          }
        ]
      }
    ]);
    expect(JSON.stringify(exported)).not.toContain("sidebar/sidebar.html");
  });

  it("appends imported trees as closed restorable nodes", () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const payload = {
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
              title: "Imported Parent",
              url: "https://imported.example/",
              favIconUrl: "https://imported.example/icon.png",
              children: [
                {
                  kind: "tab",
                  title: "Imported Child",
                  url: "https://imported.example/child",
                  children: []
                }
              ]
            },
            {
              kind: "window",
              title: "Nested Imported Window",
              children: [
                {
                  kind: "tab",
                  title: "Nested Tab",
                  url: "https://nested.example/",
                  children: []
                }
              ]
            }
          ]
        },
        {
          kind: "tab",
          title: "Loose Tab",
          url: "https://loose.example/",
          children: []
        }
      ]
    };

    const appended = appendPortableTree(state, payload, { now: 5000 });

    expect(appended.rootIds.slice(0, state.rootIds.length)).toEqual(state.rootIds);
    expect(appended.rootIds).toHaveLength(state.rootIds.length + 1);
    expect(Object.keys(appended.nodes)).toHaveLength(Object.keys(state.nodes).length + 7);

    const importGroupId = appended.rootIds.at(-1)!;
    const importGroup = appended.nodes[importGroupId]!;
    const importedWindow = nodeByTitle(appended, "Imported Window");
    const importedParent = nodeByTitle(appended, "Imported Parent");
    const importedChild = nodeByTitle(appended, "Imported Child");
    const nestedWindow = nodeByTitle(appended, "Nested Imported Window");
    const nestedTab = nodeByTitle(appended, "Nested Tab");
    const looseTab = nodeByTitle(appended, "Loose Tab");

    expect(importGroup.title).toBe("Group");
    expect(importGroup.customTitle).toBeUndefined();
    expect(importGroup.parentId).toBeUndefined();
    expect(importGroup.childIds).toEqual([importedWindow.id, looseTab.id]);
    expect(importedWindow.customTitle).toBe("Imported Window");
    expect(importedWindow.parentId).toBe(importGroup.id);
    expect(importedWindow.childIds).toEqual([importedParent.id, nestedWindow.id]);
    expect(importedParent.parentId).toBe(importedWindow.id);
    expect(importedParent.childIds).toEqual([importedChild.id]);
    expect(importedChild.parentId).toBe(importedParent.id);
    expect(nestedWindow.customTitle).toBe("Nested Imported Window");
    expect(nestedWindow.parentId).toBe(importedWindow.id);
    expect(nestedWindow.childIds).toEqual([nestedTab.id]);
    expect(nestedTab.parentId).toBe(nestedWindow.id);
    expect(looseTab.parentId).toBe(importGroup.id);

    for (const node of [importGroup, importedWindow, importedParent, importedChild, nestedWindow, nestedTab, looseTab]) {
      expect(node.status).toBe("closed");
      expect(node.collapsed).toBe(false);
      expect(node.createdAt).toBe(5000);
      expect(node.updatedAt).toBe(5000);
      expect(node.closedAt).toBe(5000);
      expect(node.live).toBeUndefined();
      expect(node.active).toBeUndefined();
      expect(node.restore?.sessionId).toBeUndefined();
    }

    expect(importedParent.restore).toEqual({
      url: "https://imported.example/",
      title: "Imported Parent",
      favIconUrl: "https://imported.example/icon.png"
    });
    expect(importedChild.restore).toEqual({
      url: "https://imported.example/child",
      title: "Imported Child"
    });
    expect(nestedTab.restore).toEqual({
      url: "https://nested.example/",
      title: "Nested Tab"
    });
    expect(looseTab.restore).toEqual({
      url: "https://loose.example/",
      title: "Loose Tab"
    });
  });

  it("does not create an empty import group for empty imports", () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const appended = appendPortableTree(state, {
      schema: PORTABLE_TREE_SCHEMA,
      version: 1,
      exportedAt: "2026-05-16T12:00:00.000Z",
      roots: []
    }, { now: 5000 });

    expect(appended).toEqual(state);
  });

  it("rejects invalid imports without mutating the original state", () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const before = structuredClone(state);

    expect(() =>
      appendPortableTree(state, {
        schema: PORTABLE_TREE_SCHEMA,
        version: 1,
        exportedAt: "2026-05-16T12:00:00.000Z",
        roots: [
          {
            kind: "tab",
            title: "Broken",
            children: "not an array"
          }
        ]
      }, { now: 5000 })
    ).toThrow(/Invalid portable tree/);

    expect(state).toEqual(before);
  });
});

function nodeByTitle(state: OutlineState, title: string): OutlineNode {
  const node = Object.values(state.nodes).find((candidate) => candidate.title === title);
  if (!node) {
    throw new Error(`Missing node with title: ${title}`);
  }
  return node;
}
