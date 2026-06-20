import { describe, expect, it } from "vitest";

import {
  buildOutlineChangeDescription,
  describeOutlineDelta,
  summarizeOutlineDelta
} from "./outline-change-summary.js";
import type { OutlineNode, OutlineState } from "../model/types.js";

function node(partial: Partial<OutlineNode> & { id: string }): OutlineNode {
  return {
    kind: "tab",
    status: "neutral",
    childIds: [],
    title: partial.id,
    collapsed: false,
    createdAt: 0,
    updatedAt: 0,
    ...partial
  };
}

function state(nodes: OutlineNode[], rootIds: string[] = []): OutlineState {
  return {
    version: 1,
    rootIds,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry]))
  };
}

describe("summarizeOutlineDelta / describeOutlineDelta", () => {
  it("describes a deleted subtree by its root, kind, and descendant count", () => {
    const previous = state(
      [
        node({ id: "w", kind: "window", title: "Work" }),
        node({ id: "t1", parentId: "w", title: "Gmail" }),
        node({ id: "t2", parentId: "w", title: "Calendar" })
      ],
      ["w"]
    );
    const next = state([], []);
    const delta = { deletedNodeIds: ["w", "t1", "t2"], rootIds: [] };

    const summary = summarizeOutlineDelta(delta, { previous, next });
    expect(summary.deleted.total).toBe(3);
    expect(summary.deleted.roots.map((ref) => ref.title)).toEqual(["Work"]);

    const text = describeOutlineDelta(delta, { previous, next });
    expect(text).toContain("Deleted");
    expect(text).toContain("Work");
    expect(text).toContain("window");
    expect(text).toContain("2 descendants");
  });

  it("describes a move with the destination (and source) parent names", () => {
    const previous = state(
      [
        node({ id: "work", kind: "window", title: "Work" }),
        node({ id: "home", kind: "window", title: "Personal" }),
        node({ id: "t", parentId: "work", title: "Gmail" })
      ],
      ["work", "home"]
    );
    const next = state(
      [
        node({ id: "work", kind: "window", title: "Work" }),
        node({ id: "home", kind: "window", title: "Personal" }),
        node({ id: "t", parentId: "home", title: "Gmail" })
      ],
      ["work", "home"]
    );
    const delta = { updatedNodes: [next.nodes["t"]!] };

    const summary = summarizeOutlineDelta(delta, { previous, next });
    expect(summary.moved).toHaveLength(1);
    expect(summary.moved[0]).toMatchObject({ from: "Work", to: "Personal" });

    const text = describeOutlineDelta(delta, { previous, next });
    expect(text).toBe("Moved 'Gmail' from 'Work' to 'Personal'");
  });

  it("lists EVERY affected node name (not just the subtree root) in the description", () => {
    const previous = state(
      [
        node({ id: "w", kind: "window", title: "Work" }),
        node({ id: "t1", parentId: "w", title: "Gmail" }),
        node({ id: "t2", parentId: "w", title: "Calendar" }),
        node({ id: "t3", parentId: "w", title: "GitHub" })
      ],
      ["w"]
    );
    const description = buildOutlineChangeDescription(
      { deletedNodeIds: ["w", "t1", "t2", "t3"], rootIds: [] },
      { previous, next: state([], []) }
    );
    expect(description?.headline).toBe("Deleted 'Work' (window) (+3 descendants)");
    expect(description?.lines).toEqual(["'Work' (window)", "'Gmail'", "'Calendar'", "'GitHub'"]);
    expect(description?.overflow).toBe(0);
  });

  it("caps the name list with an overflow count past maxLines", () => {
    const nodes = Array.from({ length: 10 }, (_unused, index) =>
      node({ id: `t${index}`, title: `Tab ${index}` })
    );
    const previous = state(
      nodes,
      nodes.map((entry) => entry.id)
    );
    const description = buildOutlineChangeDescription(
      { deletedNodeIds: nodes.map((entry) => entry.id), rootIds: [] },
      { previous, next: state([], []), maxLines: 4 }
    );
    expect(description?.lines).toHaveLength(4);
    expect(description?.overflow).toBe(6);
  });

  it("describes a same-parent reorder as a move within the parent", () => {
    const previous = state(
      [
        node({ id: "w", kind: "window", title: "Work", childIds: ["a", "b"] }),
        node({ id: "a", parentId: "w", title: "Gmail" }),
        node({ id: "b", parentId: "w", title: "Docs" })
      ],
      ["w"]
    );
    const next = state(
      [
        node({ id: "w", kind: "window", title: "Work", childIds: ["b", "a"] }),
        node({ id: "a", parentId: "w", title: "Gmail" }),
        node({ id: "b", parentId: "w", title: "Docs" })
      ],
      ["w"]
    );
    // moveNode's same-parent path journals [parent, movedNode].
    const text = describeOutlineDelta(
      { updatedNodes: [next.nodes["w"]!, next.nodes["b"]!] },
      { previous, next }
    );
    expect(text).toBe("Moved 'Docs' within 'Work'");
  });

  it("reports every aspect of a node that both moved and was renamed", () => {
    const previous = state(
      [
        node({ id: "w", kind: "window", title: "Work" }),
        node({ id: "h", kind: "window", title: "Home" }),
        node({ id: "t", parentId: "w", title: "Old" })
      ],
      ["w", "h"]
    );
    const next = state(
      [
        node({ id: "w", kind: "window", title: "Work" }),
        node({ id: "h", kind: "window", title: "Home" }),
        node({ id: "t", parentId: "h", title: "Old", customTitle: "New" })
      ],
      ["w", "h"]
    );
    const text = describeOutlineDelta({ updatedNodes: [next.nodes["t"]!] }, { previous, next });
    expect(text).toContain("Moved 'New' from 'Work' to 'Home'");
    expect(text).toContain("Renamed 'Old' → 'New'");
  });

  it("reports coarse counts for a delta past the detail limit", () => {
    const updatedNodes = Array.from({ length: 300 }, (_unused, index) =>
      node({ id: `n${index}`, title: `N${index}` })
    );
    const next = state(
      updatedNodes,
      updatedNodes.map((entry) => entry.id)
    );
    const summary = summarizeOutlineDelta({ updatedNodes, deletedNodeIds: ["x", "y"] }, { next });
    expect(summary.moved).toEqual([]);
    expect(summary.otherChanges).toBe(300);
    const text = describeOutlineDelta({ updatedNodes, deletedNodeIds: ["x", "y"] }, { next });
    expect(text).toContain("Deleted 2 nodes");
    expect(text).toContain("300 node changes");
  });

  it("describes a move to the top level", () => {
    const previous = state(
      [
        node({ id: "w", kind: "window", title: "Work" }),
        node({ id: "t", parentId: "w", title: "Gmail" })
      ],
      ["w"]
    );
    const next = state(
      [node({ id: "w", kind: "window", title: "Work" }), node({ id: "t", title: "Gmail" })],
      ["w", "t"]
    );
    const text = describeOutlineDelta(
      { updatedNodes: [next.nodes["t"]!], rootIds: ["w", "t"] },
      {
        previous,
        next
      }
    );
    expect(text).toContain("Moved");
    expect(text).toContain("top level");
  });

  it("describes a rename using customTitle precedence", () => {
    const previous = state([node({ id: "t", title: "Old Title" })]);
    const next = state([node({ id: "t", title: "Old Title", customTitle: "My Tab" })]);
    const summary = summarizeOutlineDelta({ updatedNodes: [next.nodes["t"]!] }, { previous, next });
    expect(summary.renamed).toEqual([expect.objectContaining({ from: "Old Title", to: "My Tab" })]);
    expect(
      describeOutlineDelta({ updatedNodes: [next.nodes["t"]!] }, { previous, next })
    ).toContain("Renamed");
  });

  it("describes created nodes and status changes", () => {
    const previous = state(
      [node({ id: "w", kind: "window", title: "Work", status: "live" })],
      ["w"]
    );
    const next = state(
      [
        node({ id: "w", kind: "window", title: "Work", status: "closed" }),
        node({ id: "n", kind: "group", title: "Notes" })
      ],
      ["w", "n"]
    );
    const summary = summarizeOutlineDelta(
      { updatedNodes: [next.nodes["w"]!, next.nodes["n"]!], rootIds: ["w", "n"] },
      { previous, next }
    );
    expect(summary.created.roots.map((ref) => ref.title)).toContain("Notes");
    expect(summary.statusChanged).toEqual([
      expect.objectContaining({ ref: expect.objectContaining({ title: "Work" }), to: "closed" })
    ]);

    const text = describeOutlineDelta(
      { updatedNodes: [next.nodes["w"]!, next.nodes["n"]!], rootIds: ["w", "n"] },
      { previous, next }
    );
    expect(text).toContain("Closed");
    expect(text).toContain("Added");
  });

  it("falls back to titled updates when no previous state is available", () => {
    const next = state([node({ id: "t", title: "Gmail" })]);
    const text = describeOutlineDelta({ updatedNodes: [next.nodes["t"]!] }, { next });
    expect(text).toContain("Gmail");
  });

  it("reports deletions by count (not '(unknown)') when there is no previous state", () => {
    const text = describeOutlineDelta({ deletedNodeIds: ["a", "b"] }, { next: state([], []) });
    expect(text).toBe("Deleted 2 nodes");
    expect(text).not.toContain("unknown");
  });

  it("returns an empty description for a metadata-only change", () => {
    const previous = state([node({ id: "t", title: "Gmail", favIconUrl: "a" })]);
    const next = state([node({ id: "t", title: "Gmail", favIconUrl: "b" })]);
    expect(describeOutlineDelta({ updatedNodes: [next.nodes["t"]!] }, { previous, next })).toBe("");
  });

  it("caps long lists with a +N suffix", () => {
    const nodes = Array.from({ length: 8 }, (_unused, index) =>
      node({ id: `t${index}`, title: `Tab ${index}` })
    );
    const previous = state(
      nodes,
      nodes.map((entry) => entry.id)
    );
    const text = describeOutlineDelta(
      { deletedNodeIds: nodes.map((entry) => entry.id), rootIds: [] },
      { previous, next: state([], []), maxNames: 3 }
    );
    expect(text).toMatch(/\+\d+ more/);
  });
});
