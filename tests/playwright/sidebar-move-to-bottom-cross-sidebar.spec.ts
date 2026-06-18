import { expect, test, type Page } from "@playwright/test";

import { outlineStateV3Items } from "../../src/background/storage-legacy-write.test-support";
import type {
  NodeId,
  OutlineNode,
  OutlineState,
  RuntimeTab,
  RuntimeWindow
} from "../../src/model/types";
import {
  createSidebarRuntimeHarness,
  type AttachedSidebarPage,
  type SidebarRuntimeHarness
} from "./support/sidebar-runtime-harness";

const NOW = 1_700_000_000_000;

// A "Move to bottom" command issued from one sidebar must reach the bottom of the outline in
// every other open sidebar (the full-size sidebar the user is watching). These drive two real
// sidebars against one real background controller, so they exercise the actual
// `treeStructureUpdated` broadcast path -- not a mock.
test.describe("move-to-bottom cross-sidebar", () => {
  // Regression: moving a window's ONLY live tab to the bottom empties + removes that source
  // window, which used to leave the new wrapper window in the source's old (top) slot instead of
  // the bottom -- so the full-size sidebar showed the node unmoved.
  test("moves a window's only live tab to the bottom (was landing at the top)", async ({
    page,
    context
  }) => {
    const harness = createHarness({
      windows: [
        { id: 1, focused: true, incognito: false },
        { id: 2, focused: false, incognito: false }
      ],
      tabs: [tab(1, 1, 0, true, "Solo"), tab(2, 2, 0, false, "Gamma"), tab(3, 2, 1, false, "Delta")]
    });
    const watcher = await loadSidebar(harness, page);
    const initiatorPage = await context.newPage();
    const initiator = await loadSidebar(harness, initiatorPage);

    watcher.clearProtocol();
    initiator.clearProtocol();

    await clickRowAction(initiatorPage, "tab:1", "Move to bottom");
    await harness.waitForIdle();

    const watcherRows = await visibleNodeIds(page);
    const initiatorRows = await visibleNodeIds(initiatorPage);
    // Both sidebars agree, the emptied source window is gone, and tab:1 is at the bottom.
    expect(watcherRows).toEqual(initiatorRows);
    expect(watcherRows).not.toContain("window:1");
    expect(watcherRows.at(-1)).toBe("tab:1");
    expect(watcher.issues).toEqual([]);
    expect(initiator.issues).toEqual([]);
    await initiatorPage.close();
  });

  test("moves a live tab from a multi-tab window to the bottom", async ({ page, context }) => {
    const harness = createHarness({
      windows: [{ id: 1, focused: true, incognito: false }],
      tabs: [tab(1, 1, 0, true, "Alpha"), tab(2, 1, 1, false, "Beta"), tab(3, 1, 2, false, "Gamma")]
    });
    const watcher = await loadSidebar(harness, page);
    const initiatorPage = await context.newPage();
    const initiator = await loadSidebar(harness, initiatorPage);

    watcher.clearProtocol();
    initiator.clearProtocol();

    await clickRowAction(initiatorPage, "tab:2", "Move to bottom");
    await harness.waitForIdle();

    const state = await harness.state();
    const watcherRows = await visibleNodeIds(page);
    expect(state.nodes["tab:2"]?.parentId).not.toBe("window:1");
    expect(watcherRows).toEqual(await visibleNodeIds(initiatorPage));
    expect(watcherRows.at(-1)).toBe("tab:2");
    expect(watcher.issues).toEqual([]);
    expect(initiator.issues).toEqual([]);
    await initiatorPage.close();
  });

  test("moves a nested saved (closed) tab to the bottom", async ({ page, context }) => {
    const harness = createSidebarRuntimeHarness({
      windows: [],
      tabs: [],
      initialStorage: outlineStateV3Items(savedTreeState()),
      now: () => NOW
    });
    const watcher = await loadSidebar(harness, page);
    const initiatorPage = await context.newPage();
    const initiator = await loadSidebar(harness, initiatorPage);
    expect(await visibleNodeIds(page)).toContain("tab:sa");

    watcher.clearProtocol();
    initiator.clearProtocol();

    await clickRowAction(initiatorPage, "tab:sa", "Move to bottom");
    await harness.waitForIdle();

    const state = await harness.state();
    const watcherRows = await visibleNodeIds(page);
    expect(state.nodes["tab:sa"]?.parentId).not.toBe("group:a");
    expect(watcherRows).toEqual(await visibleNodeIds(initiatorPage));
    expect(watcherRows.at(-1)).toBe("tab:sa");
    expect(watcher.issues).toEqual([]);
    expect(initiator.issues).toEqual([]);
    await initiatorPage.close();
  });
});

async function loadSidebar(
  harness: SidebarRuntimeHarness,
  page: Page
): Promise<AttachedSidebarPage> {
  const sidebar = await harness.attachPage(page);
  await sidebar.load();
  await expect(page.locator("body")).not.toHaveAttribute("data-sidebar-booting", "");
  await expect(page.getByRole("treeitem").first()).toBeVisible();
  return sidebar;
}

function createHarness(fixture: {
  windows: RuntimeWindow[];
  tabs: RuntimeTab[];
}): SidebarRuntimeHarness {
  return createSidebarRuntimeHarness({ ...fixture, now: () => NOW });
}

function tab(
  id: number,
  windowId: number,
  index: number,
  active: boolean,
  title: string
): RuntimeTab {
  return {
    id,
    windowId,
    index,
    active,
    title,
    url: `https://example.test/${encodeURIComponent(title.toLowerCase())}`
  };
}

function savedNode(
  id: NodeId,
  kind: "group" | "tab",
  childIds: NodeId[],
  parentId?: NodeId
): OutlineNode {
  return {
    id,
    kind,
    status: kind === "group" ? "neutral" : "closed",
    ...(parentId ? { parentId } : {}),
    childIds,
    title: id,
    active: false,
    collapsed: false,
    createdAt: 1,
    updatedAt: 1,
    ...(kind === "tab" ? { closedAt: 1 } : {})
  };
}

function savedTreeState(): OutlineState {
  return {
    version: 1,
    rootIds: ["group:a", "group:b"],
    nodes: {
      "group:a": savedNode("group:a", "group", ["tab:sa", "tab:sa2"]),
      "tab:sa": savedNode("tab:sa", "tab", [], "group:a"),
      "tab:sa2": savedNode("tab:sa2", "tab", [], "group:a"),
      "group:b": savedNode("group:b", "group", ["tab:sb"]),
      "tab:sb": savedNode("tab:sb", "tab", [], "group:b")
    }
  };
}

async function clickRowAction(page: Page, nodeId: string, actionName: string): Promise<void> {
  const node = page.locator(nodeSelector(nodeId));
  await node.locator(".node-row").hover();
  await node.getByRole("button", { name: actionName, exact: true }).click();
}

async function visibleNodeIds(page: Page): Promise<string[]> {
  return page.locator(".node").evaluateAll((nodes) =>
    nodes
      .map((node) => ({
        id: (node as HTMLElement).dataset.nodeId ?? "",
        row: Number((node as HTMLElement).dataset.rowIndex ?? "0")
      }))
      .sort((left, right) => left.row - right.row)
      .map((row) => row.id)
  );
}

function nodeSelector(nodeId: string): string {
  return `.node[data-node-id='${nodeId.replaceAll(":", "\\:")}']`;
}
