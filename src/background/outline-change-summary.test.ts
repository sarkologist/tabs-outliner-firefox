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

  it("names a same-parent reorder from the command's subject node (it is absent from the delta)", () => {
    // A reorder is position-only, so the moved child is materially equal and NOT in updatedNodes;
    // only the parent's childIds change. The command's subject node (primaryNodeId) names it.
    const previous = state(
      [
        node({ id: "w", kind: "window", title: "Work", childIds: ["a", "b", "c"] }),
        node({ id: "a", parentId: "w", title: "Gmail" }),
        node({ id: "b", parentId: "w", title: "Docs" }),
        node({ id: "c", parentId: "w", title: "Slack" })
      ],
      ["w"]
    );
    const next = state(
      [
        node({ id: "w", kind: "window", title: "Work", childIds: ["a", "c", "b"] }),
        node({ id: "a", parentId: "w", title: "Gmail" }),
        node({ id: "b", parentId: "w", title: "Docs" }),
        node({ id: "c", parentId: "w", title: "Slack" })
      ],
      ["w"]
    );
    const text = describeOutlineDelta(
      { updatedNodes: [next.nodes["w"]!] }, // only the parent (childIds changed) is material
      { previous, next, primaryNodeId: "c" }
    );
    expect(text).toBe("Moved 'Slack' within 'Work' after 'Gmail'");
  });

  it("names an adjacent top-level reorder from the command's subject node (after X / to the top)", () => {
    const roots = [
      node({ id: "a", kind: "window", title: "Inbox" }),
      node({ id: "b", kind: "window", title: "Work" }),
      node({ id: "c", kind: "window", title: "Reading" })
    ];
    const previous = state(roots, ["a", "b", "c"]);
    // 'Reading' nudged up one slot -- an adjacent swap that order alone can't attribute, but the
    // command says nodeId="c". The moved root is materially unchanged, so the delta is rootIds-only.
    const afterInbox = state(roots, ["a", "c", "b"]);
    expect(
      describeOutlineDelta(
        { rootIds: ["a", "c", "b"] },
        { previous, next: afterInbox, primaryNodeId: "c" }
      )
    ).toBe("Moved 'Reading' (window) after 'Inbox'");

    // 'Work' nudged to the very top.
    const toTop = state(roots, ["b", "a", "c"]);
    expect(
      describeOutlineDelta(
        { rootIds: ["b", "a", "c"] },
        { previous, next: toTop, primaryNodeId: "b" }
      )
    ).toBe("Moved 'Work' (window) to the top");
  });

  it("lists a moved group's contents so a generic title is identifiable", () => {
    const previous = state(
      [
        node({ id: "home", kind: "window", title: "Personal" }),
        node({ id: "g", kind: "group", title: "Group", parentId: "home", childIds: ["t1", "t2"] }),
        node({ id: "t1", parentId: "g", title: "Gmail" }),
        node({ id: "t2", parentId: "g", title: "Calendar" }),
        node({ id: "work", kind: "window", title: "Work" })
      ],
      ["home", "work"]
    );
    // The group 'g' moved from 'Personal' to 'Work'.
    const next = state(
      [
        node({ id: "home", kind: "window", title: "Personal", childIds: [] }),
        node({ id: "g", kind: "group", title: "Group", parentId: "work", childIds: ["t1", "t2"] }),
        node({ id: "t1", parentId: "g", title: "Gmail" }),
        node({ id: "t2", parentId: "g", title: "Calendar" }),
        node({ id: "work", kind: "window", title: "Work", childIds: ["g"] })
      ],
      ["home", "work"]
    );
    const description = buildOutlineChangeDescription(
      { updatedNodes: [next.nodes["g"]!] },
      { previous, next, primaryNodeId: "g" }
    );
    expect(description?.headline).toBe("Moved 'Group' (group) (+2) from 'Personal' to 'Work'");
    // The contents identify which group moved.
    expect(description?.lines).toEqual(["'Group' (group)", "'Gmail'", "'Calendar'"]);
  });

  it("infers an unambiguous top-level reorder even without the subject node", () => {
    const roots = [
      node({ id: "a", kind: "window", title: "Inbox" }),
      node({ id: "b", kind: "window", title: "Work" }),
      node({ id: "c", kind: "window", title: "Reading" }),
      node({ id: "d", kind: "window", title: "Archive" })
    ];
    const previous = state(roots, ["a", "b", "c", "d"]);
    // 'Work' moved two slots (to the end) -- unambiguous, so order alone names it.
    const next = state(roots, ["a", "c", "d", "b"]);
    expect(describeOutlineDelta({ rootIds: ["a", "c", "d", "b"] }, { previous, next })).toBe(
      "Moved 'Work' (window) after 'Archive'"
    );
  });

  it("emits nothing for an ambiguous adjacent swap with no subject node (no noise row)", () => {
    const roots = [
      node({ id: "a", kind: "window", title: "Inbox" }),
      node({ id: "b", kind: "window", title: "Work" }),
      node({ id: "c", kind: "window", title: "Reading" })
    ];
    const previous = state(roots, ["a", "b", "c"]);
    const next = state(roots, ["a", "c", "b"]);
    // Order alone can't say whether Work moved down or Reading moved up, and no subject node was
    // given; emit no row rather than an uninformative "Reordered top level".
    expect(describeOutlineDelta({ rootIds: ["a", "c", "b"] }, { previous, next })).toBe("");
    expect(
      buildOutlineChangeDescription({ rootIds: ["a", "c", "b"] }, { previous, next })
    ).toBeUndefined();
    // A command/undo (allowGenericReorder) still gets a generic row -- a user action shouldn't vanish.
    expect(
      describeOutlineDelta(
        { rootIds: ["a", "c", "b"] },
        { previous, next, allowGenericReorder: true }
      )
    ).toBe("Reordered top level");
  });

  it("does not call a same-count add+remove a reorder", () => {
    const previous = state(
      [
        node({ id: "a", kind: "window", title: "Keep" }),
        node({ id: "b", kind: "window", title: "Old" })
      ],
      ["a", "b"]
    );
    const next = state(
      [
        node({ id: "a", kind: "window", title: "Keep" }),
        node({ id: "c", kind: "window", title: "New" })
      ],
      ["a", "c"]
    );
    // 'Old' removed, 'New' added: same root count, different set.
    const text = describeOutlineDelta(
      { deletedNodeIds: ["b"], updatedNodes: [next.nodes["c"]!], rootIds: ["a", "c"] },
      { previous, next }
    );
    expect(text).not.toContain("Reordered");
    expect(text).toContain("Deleted 'Old' (window)");
    expect(text).toContain("Added 'New' (window)");
  });

  it("emits nothing for an unisolatable multi-node shuffle (no noise row)", () => {
    const roots = [
      node({ id: "a", kind: "window", title: "A" }),
      node({ id: "b", kind: "window", title: "B" }),
      node({ id: "c", kind: "window", title: "C" }),
      node({ id: "d", kind: "window", title: "D" })
    ];
    const previous = state(roots, ["a", "b", "c", "d"]);
    const next = state(roots, ["b", "a", "d", "c"]);
    expect(describeOutlineDelta({ rootIds: ["b", "a", "d", "c"] }, { previous, next })).toBe("");
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
