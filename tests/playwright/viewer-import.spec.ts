import { expect, test, type Locator, type Page } from "@playwright/test";

import { PORTABLE_TREE_SCHEMA } from "../../src/model/portable-tree";
import type { OutlineState, RuntimeTab, RuntimeWindow } from "../../src/model/types";
import {
  createSidebarRuntimeHarness,
  type AttachedSidebarPage,
  type SidebarRuntimeHarness
} from "./support/sidebar-runtime-harness";

const NOW = 1_700_000_000_000;

const EXPORT_FILE = {
  schema: PORTABLE_TREE_SCHEMA,
  version: 1,
  exportedAt: "2026-05-16T12:00:00.000Z",
  roots: [
    {
      kind: "window",
      title: "Saved Window",
      children: [
        { kind: "tab", title: "Saved Tab", url: "https://saved.example/", children: [] }
      ]
    },
    { kind: "tab", title: "Loose Saved Tab", url: "https://loose.example/", children: [] }
  ]
};

test.describe("exported-tree viewer", () => {
  test("renders like the main tree (read-only), expands/collapses, and imports to top level", async ({ page }) => {
    const harness = createHarness(runtimeFixture(1, ["Alpha"]));
    const viewer = await loadViewer(harness, page);
    const rootCountBefore = (await harness.state()).rootIds.length;

    await loadExport(page, EXPORT_FILE);

    // Same node-row markup as the live outline: every node is a .node treeitem with a .node-title.
    await expect(page.locator("#viewer-tree .node")).toHaveCount(3);
    await expect(page.getByRole("treeitem")).toHaveCount(3);
    // Default-expanded, exactly like the main tree — the nested child is visible without action.
    await expect(page.getByText("Saved Window", { exact: true })).toBeVisible();
    await expect(page.getByText("Saved Tab", { exact: true })).toBeVisible();
    await expect(page.getByText("Loose Saved Tab", { exact: true })).toBeVisible();

    // Read-only: the only per-node controls are the twisty and the (hover-revealed) Import action —
    // no rename/move/delete/close/restore/cut/group, and rows are not draggable.
    for (const action of ["Close", "Delete", "Restore", "Rename", "Move", "Group", "Cut", "Paste", "Flatten"]) {
      await expect(page.getByRole("button", { name: new RegExp(action, "i") })).toHaveCount(0);
    }
    await expect(page.locator("[draggable=true]")).toHaveCount(0);

    // Collapse hides the subtree; expand brings it back (same twisty behavior as the sidebar).
    await page.getByRole("button", { name: "Collapse Saved Window" }).click();
    await expect(page.getByText("Saved Tab", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("treeitem")).toHaveCount(2);
    await page.getByRole("button", { name: "Expand Saved Window" }).click();
    await expect(page.getByText("Saved Tab", { exact: true })).toBeVisible();

    // Import the "Saved Window" subtree into the live outline.
    await importByLabel(page, "Saved Window");
    await harness.waitForIdle();

    const afterImport = await harness.state();
    const importedRoots = topLevelNodesByTitle(afterImport, "Saved Window");
    expect(importedRoots).toHaveLength(1);
    expect(importedRoots[0]!.status).toBe("closed");
    expect(importedRoots[0]!.parentId).toBeUndefined();
    expect(afterImport.rootIds).toHaveLength(rootCountBefore + 1);

    const importedChild = importedRoots[0]!.childIds
      .map((childId) => afterImport.nodes[childId])
      .find((child) => child?.title === "Saved Tab");
    expect(importedChild?.status).toBe("closed");
    expect(importedChild?.restore).toEqual({ url: "https://saved.example/", title: "Saved Tab" });
    expect(Object.values(afterImport.nodes).some((node) => node.title === "Alpha" && node.status === "live")).toBe(true);

    // The exported view itself is never mutated by an import.
    await expect(page.locator("#viewer-tree .node")).toHaveCount(3);

    expect(viewer.issues).toEqual([]);
  });

  test("importing the same node twice creates independent top-level nodes (no dedupe)", async ({ page }) => {
    const harness = createHarness(runtimeFixture(1, ["Alpha"]));
    const viewer = await loadViewer(harness, page);

    await loadExport(page, EXPORT_FILE);

    await importByLabel(page, "Loose Saved Tab");
    await harness.waitForIdle();
    await importByLabel(page, "Loose Saved Tab");
    await harness.waitForIdle();

    const state = await harness.state();
    const imported = topLevelNodesByTitle(state, "Loose Saved Tab");
    expect(imported).toHaveLength(2);
    expect(new Set(imported.map((node) => node.id)).size).toBe(2);

    expect(viewer.issues).toEqual([]);
  });

  test("opens the read-only viewer as its own popup window from the background", async () => {
    const harness = createHarness(runtimeFixture(1, ["Alpha"]));

    await harness.controller.handleMessage({ type: "openImportViewerWindow" });

    const created = harness.runtime.sideEffects.filter((effect) => effect.kind === "windows.create");
    expect(created).toHaveLength(1);
    expect(created[0]!.args[0]).toMatchObject({
      url: "moz-extension://extension-id/viewer/viewer.html",
      type: "popup"
    });
  });
});

async function loadViewer(harness: SidebarRuntimeHarness, page: Page): Promise<AttachedSidebarPage> {
  const viewer = await harness.attachPage(page);
  await page.goto("/viewer/viewer.html");
  await expect(page.getByRole("heading", { name: "Exported tree viewer" })).toBeVisible();
  return viewer;
}

async function loadExport(page: Page, payload: unknown): Promise<void> {
  await page.setInputFiles("#viewer-file", {
    name: "tabs-outliner-tree-2026-05-16.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(payload))
  });
  await expect(page.getByRole("treeitem").first()).toBeVisible();
}

// The Import action is hover-revealed (the same node-actions affordance as the live outline) and
// thus absent from the a11y tree until shown, so locate the row by its always-visible title text,
// hover to reveal the action, then click — mirrors how the sidebar spec drives row actions.
async function importByLabel(page: Page, label: string): Promise<void> {
  const row: Locator = page.locator(".node-row", { has: page.getByText(label, { exact: true }) }).first();
  await row.hover();
  await page.getByRole("button", { name: `Import ${label} to top level` }).click();
}

function topLevelNodesByTitle(state: OutlineState, title: string) {
  return state.rootIds
    .map((rootId) => state.nodes[rootId])
    .filter((node): node is NonNullable<typeof node> => Boolean(node) && node!.title === title);
}

function createHarness(fixture: { windows: RuntimeWindow[]; tabs: RuntimeTab[] }): SidebarRuntimeHarness {
  return createSidebarRuntimeHarness({ ...fixture, now: () => NOW });
}

function runtimeFixture(windowId: number, titles: string[]): { windows: RuntimeWindow[]; tabs: RuntimeTab[] } {
  return {
    windows: [{ id: windowId, focused: true, incognito: false }],
    tabs: titles.map((title, index) => ({
      id: index + 1,
      windowId,
      index,
      active: index === 0,
      title,
      url: `https://example.test/${encodeURIComponent(title.toLowerCase())}`
    }))
  };
}
