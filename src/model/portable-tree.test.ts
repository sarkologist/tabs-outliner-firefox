import { describe, expect, it } from "vitest";

import { bootstrapFromWindows, closeTab, renameGroup, wrapNodeInGroup } from "./outline.js";
import {
  PORTABLE_TREE_SCHEMA,
  appendPortableSubtreesAtTopLevel,
  appendPortableTree,
  exportPortableTree,
  parsePortableImport,
  portableTreeBackupFilename,
  portableTreeFilename,
  serializePortableTreeFile
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

  it("creates stable export filenames and serialized JSON files", () => {
    const exported = exportPortableTree(bootstrapFromWindows(runtimeWindows, { now: 1000 }), { now: 3000 });

    expect(portableTreeFilename(new Date("2026-05-19T13:20:00.000Z"))).toBe("tabs-outliner-tree-2026-05-19.json");
    expect(portableTreeBackupFilename(new Date("2026-05-19T13:20:00.000Z"))).toBe(
      "tabs-outliner-backups/tabs-outliner-tree-2026-05-19.json"
    );
    expect(serializePortableTreeFile(exported)).toBe(`${JSON.stringify(exported, null, 2)}\n`);
  });

  it("exports renamed group titles", () => {
    const state = renameGroup(bootstrapFromWindows(runtimeWindows, { now: 1000 }), "window:10", "Research", {
      now: 2000
    });

    const exported = exportPortableTree(state, { now: 3000 });

    expect(exported.roots[0]?.title).toBe("Research");
  });

  it("exports neutral outline groups as portable window groups", () => {
    const state = wrapNodeInGroup(bootstrapFromWindows(runtimeWindows, { now: 1000 }), "window:10", { now: 2000 });

    const exported = exportPortableTree(state, { now: 3000 });

    expect(exported.roots[0]).toMatchObject({
      kind: "window",
      title: "Group",
      children: [
        {
          kind: "window",
          title: "Group"
        }
      ]
    });
  });

  it("exports a 50k-node deep tree without recursive stack overflow", () => {
    const state = deepOutlineState(50_000);

    const exported = exportPortableTree(state, { now: 3000 });

    let current = exported.roots[0];
    for (let index = 1; index <= 50_000; index += 1) {
      current = current?.children[0];
    }
    expect(current?.title).toBe("Leaf");
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
    expect(appended.nodes["window:10"]).toBe(state.nodes["window:10"]);
    expect(appended.nodes["tab:1"]).toBe(state.nodes["tab:1"]);
  });

  it("leaves state unchanged for empty portable tree imports", () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const payload = {
      schema: PORTABLE_TREE_SCHEMA,
      version: 1,
      exportedAt: "2026-05-16T12:00:00.000Z",
      roots: []
    };

    const appended = appendPortableTree(state, payload, { now: 5000 });

    expect(appended).toBe(state);
  });

  it("imports Chrome Tab Outliner tree exports as closed restorable nodes", () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const payload = [
      {
        type: 2000,
        node: {
          type: "session",
          data: {
            treeId: "1483340179831.8303"
          }
        }
      },
      [
        2001,
        {
          type: "savedwin",
          marks: {
            customTitle: "Research",
            customFavicon: "img/chrome-window-icon-gold.png"
          },
          data: {
            type: "normal",
            rect: "22_720_720_874"
          }
        },
        [0]
      ],
      [
        2001,
        {
          data: {
            title: "Parent",
            url: "https://chrome-import.example/parent",
            favIconUrl: "https://chrome-import.example/favicon.ico",
            active: true,
            pinned: true
          }
        },
        [0, 0]
      ],
      [
        2001,
        {
          type: "tab",
          data: {
            title: "Imported Child",
            url: "https://chrome-import.example/child"
          }
        },
        [0, 0, 0]
      ],
      [
        2001,
        {
          type: "group",
          marks: {
            customTitle: "Reading"
          },
          data: {
            rect: "undefined_undefined_undefined_undefined"
          }
        },
        [0, 1]
      ],
      [
        2001,
        {
          data: {
            title: "Nested",
            url: "https://chrome-import.example/nested"
          }
        },
        [0, 1, 0]
      ],
      [
        2001,
        {
          type: "win",
          data: {
            id: 99,
            type: "normal",
            focused: true
          }
        },
        [1]
      ],
      [
        2001,
        {
          type: "tab",
          data: {
            id: 100,
            title: "Live Tab",
            url: "https://chrome-import.example/live",
            favIconUrl: "https://chrome-import.example/live.ico",
            windowId: 99
          }
        },
        [1, 0]
      ],
      [
        2001,
        {
          data: {
            title: "Root Tab",
            url: "https://chrome-import.example/root"
          }
        },
        [2]
      ],
      {
        type: 11111,
        time: 1778944526534
      }
    ];

    const appended = appendPortableTree(state, payload, { now: 5000 });

    expect(appended.rootIds.slice(0, state.rootIds.length)).toEqual(state.rootIds);
    expect(appended.rootIds).toHaveLength(state.rootIds.length + 1);
    expect(Object.keys(appended.nodes)).toHaveLength(Object.keys(state.nodes).length + 9);

    const importGroup = appended.nodes[appended.rootIds.at(-1)!]!;
    const research = nodeByTitle(appended, "Research");
    const parent = nodeByTitle(appended, "Parent");
    const child = nodeByTitle(appended, "Imported Child");
    const reading = nodeByTitle(appended, "Reading");
    const nested = nodeByTitle(appended, "Nested");
    const liveWindow = appended.nodes[importGroup.childIds[1]!]!;
    const liveTab = nodeByTitle(appended, "Live Tab");
    const rootTab = nodeByTitle(appended, "Root Tab");

    expect(importGroup.title).toBe("Chrome Tab Outliner import");
    expect(importGroup.parentId).toBeUndefined();
    expect(importGroup.childIds).toEqual([research.id, liveWindow.id, rootTab.id]);
    expect(research.kind).toBe("window");
    expect(research.customTitle).toBe("Research");
    expect(research.parentId).toBe(importGroup.id);
    expect(research.childIds).toEqual([parent.id, reading.id]);
    expect(parent.parentId).toBe(research.id);
    expect(parent.childIds).toEqual([child.id]);
    expect(reading.kind).toBe("window");
    expect(reading.customTitle).toBe("Reading");
    expect(reading.childIds).toEqual([nested.id]);
    expect(liveWindow.kind).toBe("window");
    expect(liveWindow.title).toBe("Group");
    expect(liveWindow.childIds).toEqual([liveTab.id]);
    expect(rootTab.parentId).toBe(importGroup.id);

    for (const node of [importGroup, research, parent, child, reading, nested, liveWindow, liveTab, rootTab]) {
      expect(node.status).toBe("closed");
      expect(node.collapsed).toBe(false);
      expect(node.createdAt).toBe(5000);
      expect(node.updatedAt).toBe(5000);
      expect(node.closedAt).toBe(5000);
      expect(node.live).toBeUndefined();
      expect(node.active).toBeUndefined();
      expect(node.restore?.sessionId).toBeUndefined();
    }

    expect(parent.restore).toEqual({
      url: "https://chrome-import.example/parent",
      title: "Parent",
      favIconUrl: "https://chrome-import.example/favicon.ico"
    });
    expect(child.restore).toEqual({
      url: "https://chrome-import.example/child",
      title: "Imported Child"
    });
    expect(liveTab.restore).toEqual({
      url: "https://chrome-import.example/live",
      title: "Live Tab",
      favIconUrl: "https://chrome-import.example/live.ico"
    });
    expect(rootTab.restore).toEqual({
      url: "https://chrome-import.example/root",
      title: "Root Tab"
    });
  });

  it("skips Chrome Tab Outliner extension pages while promoting useful descendants", () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const payload = [
      [
        2001,
        {
          type: "win",
          data: {
            type: "popup"
          }
        },
        [0]
      ],
      [
        2001,
        {
          type: "tab",
          data: {
            title: "Tabs Outliner",
            url: "chrome-extension://eggkanocgddhmamlbiijnphhppkpkmkl/activesessionview.html",
            favIconUrl: "chrome-extension://eggkanocgddhmamlbiijnphhppkpkmkl/img/favicon.png"
          }
        },
        [0, 0]
      ],
      [
        2001,
        {
          data: {
            title: "Promoted Child",
            url: "https://chrome-import.example/promoted"
          }
        },
        [0, 0, 0]
      ],
      [
        2001,
        {
          type: "tab",
          data: {
            title: "Tabs Outliner Options",
            url: "chrome-extension://eggkanocgddhmamlbiijnphhppkpkmkl/options.html"
          }
        },
        [1]
      ]
    ];

    const appended = appendPortableTree(state, payload, { now: 5000 });

    expect(JSON.stringify(appended)).not.toContain("chrome-extension://eggkanocgddhmamlbiijnphhppkpkmkl");
    const importGroup = appended.nodes[appended.rootIds.at(-1)!]!;
    const popup = appended.nodes[importGroup.childIds[0]!]!;
    const promoted = nodeByTitle(appended, "Promoted Child");
    expect(importGroup.childIds).toEqual([popup.id]);
    expect(popup.childIds).toEqual([promoted.id]);
    expect(promoted.parentId).toBe(popup.id);
  });

  it("rejects malformed Chrome Tab Outliner tree exports without mutating the original state", () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const before = structuredClone(state);

    expect(() =>
      appendPortableTree(state, [
        [
          2001,
          {
            data: {
              title: "Broken",
              url: "https://broken.example/"
            }
          },
          [0, "not a number"]
        ]
      ], { now: 5000 })
    ).toThrow(/Invalid Chrome Tab Outliner tree/);

    expect(state).toEqual(before);
  });

  it("reconstructs Chrome Tab Outliner paths by numeric order", () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const payload = [
      [
        2001,
        {
          data: {
            title: "Second",
            url: "https://chrome-import.example/second"
          }
        },
        [0, 1]
      ],
      [
        2001,
        {
          data: {
            title: "First child",
            url: "https://chrome-import.example/first-child"
          }
        },
        [0, 0, 0]
      ],
      [
        2001,
        {
          data: {
            title: "Root",
            url: "https://chrome-import.example/root"
          }
        },
        [0]
      ],
      [
        2001,
        {
          data: {
            title: "First",
            url: "https://chrome-import.example/first"
          }
        },
        [0, 0]
      ],
      [
        2001,
        {
          data: {
            title: "After root",
            url: "https://chrome-import.example/after-root"
          }
        },
        [1]
      ]
    ];

    const appended = appendPortableTree(state, payload, { now: 5000 });

    const importGroup = appended.nodes[appended.rootIds.at(-1)!]!;
    const root = nodeByTitle(appended, "Root");
    const first = nodeByTitle(appended, "First");
    const firstChild = nodeByTitle(appended, "First child");
    const second = nodeByTitle(appended, "Second");
    const afterRoot = nodeByTitle(appended, "After root");
    expect(importGroup.childIds).toEqual([root.id, afterRoot.id]);
    expect(root.childIds).toEqual([first.id, second.id]);
    expect(first.childIds).toEqual([firstChild.id]);
    expect([root, first, firstChild, second, afterRoot].every((node) => node.status === "closed")).toBe(true);
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

describe("append portable subtrees at top level", () => {
  const importPayload = (roots: unknown[]) => ({
    schema: PORTABLE_TREE_SCHEMA,
    version: 1,
    exportedAt: "2026-05-16T12:00:00.000Z",
    roots
  });

  const windowWithChild = {
    kind: "window",
    title: "Imported Window",
    children: [
      {
        kind: "tab",
        title: "Imported Child",
        url: "https://imported.example/child",
        children: []
      }
    ]
  };

  it("appends each portable root as a new top-level node with no import-group wrapper", () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const looseTab = { kind: "tab", title: "Loose Tab", url: "https://loose.example/", children: [] };

    const appended = appendPortableSubtreesAtTopLevel(
      state,
      importPayload([windowWithChild, looseTab]),
      { now: 5000 }
    );

    // Existing roots are preserved in order; the two imported roots are appended after them.
    expect(appended.rootIds.slice(0, state.rootIds.length)).toEqual(state.rootIds);
    expect(appended.rootIds).toHaveLength(state.rootIds.length + 2);

    const importedWindow = nodeByTitle(appended, "Imported Window");
    const importedChild = nodeByTitle(appended, "Imported Child");
    const importedLooseTab = nodeByTitle(appended, "Loose Tab");

    // The imported nodes are themselves the new top-level roots: appendPortableTree would have
    // inserted exactly one extra "Group" wrapper root instead of these two. (Note the live
    // window from bootstrap is itself titled "Group" — outline.ts default — so a wrapper can't
    // be detected by title; the root-slice identity below is the precise check.)
    expect(appended.rootIds.slice(state.rootIds.length)).toEqual([importedWindow.id, importedLooseTab.id]);

    expect(importedWindow.parentId).toBeUndefined();
    expect(importedWindow.customTitle).toBe("Imported Window");
    expect(importedWindow.childIds).toEqual([importedChild.id]);
    expect(importedChild.parentId).toBe(importedWindow.id);
    expect(importedLooseTab.parentId).toBeUndefined();
    expect(importedLooseTab.restore).toEqual({ url: "https://loose.example/", title: "Loose Tab" });

    for (const node of [importedWindow, importedChild, importedLooseTab]) {
      expect(node.status).toBe("closed");
      expect(node.live).toBeUndefined();
      expect(node.createdAt).toBe(5000);
      expect(node.id.startsWith("imported:")).toBe(true);
    }
  });

  it("imports a single selected subtree as one independent top-level node", () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });

    const appended = appendPortableSubtreesAtTopLevel(state, importPayload([windowWithChild]), { now: 5000 });

    expect(appended.rootIds).toHaveLength(state.rootIds.length + 1);
    const importedWindow = appended.nodes[appended.rootIds.at(-1)!]!;
    expect(importedWindow.title).toBe("Imported Window");
    expect(importedWindow.parentId).toBeUndefined();
    expect(importedWindow.childIds).toHaveLength(1);
  });

  it("creates independent fresh nodes when the same subtree is imported more than once", () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });

    const once = appendPortableSubtreesAtTopLevel(state, importPayload([windowWithChild]), { now: 5000 });
    // Same clock value on purpose: ids must still be unique (no collision, no dedupe).
    const twice = appendPortableSubtreesAtTopLevel(once, importPayload([windowWithChild]), { now: 5000 });

    expect(twice.rootIds).toHaveLength(state.rootIds.length + 2);
    const firstImportId = once.rootIds.at(-1)!;
    const secondImportId = twice.rootIds.at(-1)!;
    expect(secondImportId).not.toBe(firstImportId);

    // Both imports survive independently — no merge, no dedupe.
    const importedWindows = Object.values(twice.nodes).filter((node) => node.title === "Imported Window");
    const importedChildren = Object.values(twice.nodes).filter((node) => node.title === "Imported Child");
    expect(importedWindows).toHaveLength(2);
    expect(importedChildren).toHaveLength(2);
    expect(new Set(importedWindows.map((node) => node.id)).size).toBe(2);
  });

  it("leaves state unchanged for empty payloads", () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });

    expect(appendPortableSubtreesAtTopLevel(state, importPayload([]), { now: 5000 })).toBe(state);
  });

  it("preserves object identity for existing nodes", () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });

    const appended = appendPortableSubtreesAtTopLevel(state, importPayload([windowWithChild]), { now: 5000 });

    expect(appended.nodes["window:10"]).toBe(state.nodes["window:10"]);
    expect(appended.nodes["tab:1"]).toBe(state.nodes["tab:1"]);
  });

  it("does not mutate the original state", () => {
    const state = bootstrapFromWindows(runtimeWindows, { now: 1000 });
    const before = structuredClone(state);

    appendPortableSubtreesAtTopLevel(state, importPayload([windowWithChild]), { now: 5000 });

    expect(state).toEqual(before);
  });
});

describe("parsePortableImport", () => {
  it("normalizes a portable file into renderable roots", () => {
    const roots = parsePortableImport({
      schema: PORTABLE_TREE_SCHEMA,
      version: 1,
      exportedAt: "2026-05-16T12:00:00.000Z",
      roots: [
        {
          kind: "window",
          title: "Window",
          children: [{ kind: "tab", title: "Tab", url: "https://example.test/", children: [] }]
        }
      ]
    });

    expect(roots).toHaveLength(1);
    expect(roots[0]!.title).toBe("Window");
    expect(roots[0]!.children[0]!.url).toBe("https://example.test/");
  });

  it("throws on an invalid payload", () => {
    expect(() => parsePortableImport({ schema: "wrong" })).toThrow(/Invalid portable tree/);
  });
});

function nodeByTitle(state: OutlineState, title: string): OutlineNode {
  const node = Object.values(state.nodes).find((candidate) => candidate.title === title);
  if (!node) {
    throw new Error(`Missing node with title: ${title}`);
  }
  return node;
}

function deepOutlineState(depth: number): OutlineState {
  const root: OutlineNode = {
    id: "window:deep",
    kind: "window",
    status: "closed",
    childIds: ["tab:1"],
    title: "Deep",
    collapsed: false,
    createdAt: 1,
    updatedAt: 1,
    closedAt: 1
  };
  const nodes: Record<string, OutlineNode> = {
    [root.id]: root
  };

  for (let index = 1; index <= depth; index += 1) {
    const id = `tab:${index}`;
    nodes[id] = {
      id,
      kind: "tab",
      status: "closed",
      parentId: index === 1 ? root.id : `tab:${index - 1}`,
      childIds: index === depth ? [] : [`tab:${index + 1}`],
      title: index === depth ? "Leaf" : `Node ${index}`,
      url: `https://deep.example/${index}`,
      collapsed: false,
      createdAt: 1,
      updatedAt: 1,
      closedAt: 1,
      restore: {
        url: `https://deep.example/${index}`,
        title: index === depth ? "Leaf" : `Node ${index}`
      }
    };
  }

  return {
    version: 1,
    rootIds: [root.id],
    nodes
  };
}
