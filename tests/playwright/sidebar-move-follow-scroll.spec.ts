import { expect, test, type Page } from "@playwright/test";

import type { RuntimeTab, RuntimeWindow } from "../../src/model/types";
import {
  createSidebarRuntimeHarness,
  type AttachedSidebarPage,
  type SidebarRuntimeHarness
} from "./support/sidebar-runtime-harness";

const NOW = 1_700_000_000_000;
// Comfortably past INITIAL_TREE_SNAPSHOT_ROW_LIMIT (256) so the sidebar boots a sparse, active-
// centered projection: the outline's bottom is NOT loaded, which is the condition under which a
// relocation must remotely reveal the active node's new location rather than scroll to a known row.
const BULK_TAB_COUNT = 320;

// A relocation command issued from a docked sidebar must scroll the view to follow the moved active
// node to its new location -- including when the moved node is the active tab's ANCESTOR (its
// window), so the active tab itself is absent from the broadcast's updatedNodes. These drive a real
// sidebar against a real background controller, so they exercise the actual "Move to bottom"
// command + treeStructureUpdated broadcast + sparse-projection reveal path -- not a mock.
test.describe("sidebar follows a moved active node", () => {
  test("scrolls to follow the active WINDOW moved to the bottom of a large outline", async ({
    page
  }) => {
    // window:2 (the sidebar's own focused window) holds the active tab and starts at the top; a big
    // bulk window below pushes the bottom far past the sparse window.
    const harness = createHarness({
      windows: [
        { id: 2, focused: true, incognito: false },
        { id: 1, focused: false, incognito: false }
      ],
      tabs: [
        tab(1, 2, 0, true, "Active tab"),
        ...Array.from({ length: BULK_TAB_COUNT }, (_value, index) =>
          tab(index + 10, 1, index, false, `Bulk ${index + 1}`)
        )
      ]
    });
    const sidebar = await loadSidebar(harness, page);

    // The active tab is visible at the top and the view starts unscrolled.
    await expect(page.locator(`${nodeSelector("tab:1")}.is-active`)).toBeVisible();
    expect(await scrollTop(page)).toBeLessThan(100);

    sidebar.clearProtocol();
    await clickRowAction(page, "window:2", "Move to bottom");
    await harness.waitForIdle();

    // window:2 (with its active tab:1) is now at the bottom, and the view scrolled down to follow it
    // -- pre-fix the sparse projection never loaded the new location and the view stayed at the top.
    await expect(page.locator(`${nodeSelector("tab:1")}.is-active`)).toBeVisible();
    expect(await scrollTop(page)).toBeGreaterThan(500);
    expect(await visibleNodeIds(page)).toContain("window:2");
    expect(sidebar.issues).toEqual([]);
  });

  test("only the initiating sidebar follows; a passive watcher keeps its scroll position", async ({
    page,
    context
  }) => {
    // Two real sidebars on one controller. The initiator issues "Move to bottom"; the watcher only
    // receives the broadcast. The initiator follows the active window down; the watcher must NOT jump
    // (it never asked to go anywhere) -- the initiator-vs-passive distinction this fix turns on.
    const harness = createHarness({
      windows: [
        { id: 2, focused: true, incognito: false },
        { id: 1, focused: false, incognito: false }
      ],
      tabs: [
        tab(1, 2, 0, true, "Active tab"),
        ...Array.from({ length: BULK_TAB_COUNT }, (_value, index) =>
          tab(index + 10, 1, index, false, `Bulk ${index + 1}`)
        )
      ]
    });
    const watcher = await loadSidebar(harness, page);
    const initiatorPage = await context.newPage();
    const initiator = await loadSidebar(harness, initiatorPage);

    for (const view of [page, initiatorPage]) {
      await expect(view.locator(`${nodeSelector("tab:1")}.is-active`)).toBeVisible();
      expect(await scrollTop(view)).toBeLessThan(100);
    }

    watcher.clearProtocol();
    initiator.clearProtocol();
    await clickRowAction(initiatorPage, "window:2", "Move to bottom");
    await harness.waitForIdle();

    // Initiator followed the active window down...
    expect(await scrollTop(initiatorPage)).toBeGreaterThan(500);
    // ...the passive watcher stayed put.
    expect(await scrollTop(page)).toBeLessThan(100);
    expect(watcher.issues).toEqual([]);
    expect(initiator.issues).toEqual([]);
    await initiatorPage.close();
  });

  test("scrolls to follow the active TAB moved to the bottom of a large outline", async ({
    page
  }) => {
    const harness = createHarness({
      windows: [{ id: 1, focused: true, incognito: false }],
      tabs: Array.from({ length: BULK_TAB_COUNT }, (_value, index) =>
        tab(index + 1, 1, index, index === 0, `Tab ${index + 1}`)
      )
    });
    const sidebar = await loadSidebar(harness, page);

    await expect(page.locator(`${nodeSelector("tab:1")}.is-active`)).toBeVisible();
    expect(await scrollTop(page)).toBeLessThan(100);

    sidebar.clearProtocol();
    await clickRowAction(page, "tab:1", "Move to bottom");
    await harness.waitForIdle();

    await expect(page.locator(nodeSelector("tab:1"))).toBeVisible();
    expect(await scrollTop(page)).toBeGreaterThan(500);
    expect((await visibleNodeIds(page)).at(-1)).toBe("tab:1");
    expect(sidebar.issues).toEqual([]);
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
  return { id, windowId, index, active, title, url: `https://example.test/${id}` };
}

async function clickRowAction(page: Page, nodeId: string, actionName: string): Promise<void> {
  const node = page.locator(nodeSelector(nodeId));
  await node.locator(".node-row").hover();
  await node.getByRole("button", { name: actionName, exact: true }).click();
}

async function scrollTop(page: Page): Promise<number> {
  return page.locator("main").evaluate((element) => element.scrollTop);
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
