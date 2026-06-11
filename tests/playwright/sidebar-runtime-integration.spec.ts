import { expect, test, type Page } from "@playwright/test";

import { outlineStateV3Items } from "../../src/background/storage-legacy-write.test-support";
import { bootstrapFromWindows, closeTab } from "../../src/model/outline";
import type { OutlineState, RuntimeTab, RuntimeWindow } from "../../src/model/types";
import {
  createSidebarRuntimeHarness,
  type AttachedSidebarPage,
  type SidebarRuntimeHarness
} from "./support/sidebar-runtime-harness";

const NOW = 1_700_000_000_000;

test.describe("sidebar/runtime integration", () => {
  test("external native tab open reaches the real sidebar through background patches", async ({ page }) => {
    const harness = createHarness(runtimeFixture(1, ["Alpha"]));
    const sidebar = await loadSidebar(harness, page);
    sidebar.clearProtocol();
    const sideEffectCount = harness.runtime.sideEffects.length;

    await harness.runtime.createTabFromBrowser(tab(2, 1, 1, false, "Beta"));
    await harness.waitForIdle();

    expect(harness.runtime.runtimeTabOrder(1)).toEqual([1, 2]);
    await harness.assertCleanBackground();
    expect(messageTypes(sidebar.protocol(), "background.broadcast")).toContain("treeStructureUpdated");
    expect(messageTypes(sidebar.protocol(), "page.sendMessage")).not.toContain("getState");
    expect(harness.runtime.sideEffects.slice(sideEffectCount)).toEqual([]);
    await expectNodeVisible(page, "tab:2", "Beta");
    await expect(page.locator("#state-count")).toContainText("3 items");
    expect(sidebar.issues).toEqual([]);
  });

  test("external native reorder updates background order and visible rows", async ({ page }) => {
    const harness = createHarness(runtimeFixture(1, ["Alpha", "Beta", "Gamma"]));
    const sidebar = await loadSidebar(harness, page);
    sidebar.clearProtocol();

    await harness.runtime.moveTabFromBrowser(3, { index: 0 });
    await harness.waitForIdle();

    expect(harness.runtime.runtimeTabOrder(1)).toEqual([3, 1, 2]);
    await harness.assertCleanBackground();
    expect(liveTabOrder(await harness.state(), 1)).toEqual([3, 1, 2]);
    await expect(visibleNodeIds(page)).resolves.toEqual(["window:1", "tab:3", "tab:1", "tab:2"]);
    expect(messageTypes(sidebar.protocol(), "background.broadcast")).toContain("treeStructureUpdated");
    expect(messageTypes(sidebar.protocol(), "page.sendMessage")).not.toContain("getState");
    expect(sidebar.issues).toEqual([]);
  });

  test("external native close removes the live row without stale resurrection", async ({ page }) => {
    const harness = createHarness(runtimeFixture(1, ["Alpha", "Beta"]));
    const sidebar = await loadSidebar(harness, page);
    sidebar.clearProtocol();

    await harness.runtime.closeTabFromBrowser(2);
    await harness.waitForIdle();
    expect(messageTypes(sidebar.protocol(), "page.sendMessage")).not.toContain("getState");
    sidebar.clearProtocol();

    await harness.controller.handleMessage({ type: "refresh" });
    await harness.waitForIdle();

    expect(harness.runtime.liveTabIds()).toEqual([1]);
    await harness.assertCleanBackground();
    await expect(page.locator(nodeSelector("tab:2"))).toHaveCount(0);
    await expect(visibleNodeIds(page)).resolves.toEqual(["window:1", "tab:1"]);
    expect(sidebar.issues).toEqual([]);
  });

  test("sidebar close command closes fake browser resources and updates the DOM by broadcast", async ({ page }) => {
    const harness = createHarness(runtimeFixture(1, ["Alpha", "Beta"]));
    const sidebar = await loadSidebar(harness, page);
    sidebar.clearProtocol();

    await clickRowAction(page, "tab:2", "Close");
    await harness.waitForIdle();

    expect(harness.runtime.liveTabIds()).toEqual([1]);
    expect(harness.runtime.sideEffects.some((effect) => effect.kind === "tabs.remove")).toBe(true);
    await harness.assertCleanBackground();
    await expect(page.locator(nodeSelector("tab:2"))).toHaveClass(/is-closed/);
    expect(messageTypes(sidebar.protocol(), "page.sendMessage")).toContain("closeNode");
    expect(messageTypes(sidebar.protocol(), "page.sendMessage")).not.toContain("getState");
    expect(sidebar.issues).toEqual([]);
  });

  test("sidebar restore command creates browser resources and rehydrates live metadata", async ({ page }) => {
    const stored = closedTabStorageFixture();
    const harness = createHarness({
      windows: [runtimeWindow(1, true)],
      tabs: [tab(1, 1, 0, true, "Alpha")],
      initialStorage: outlineStateV3Items(stored)
    });
    const sidebar = await loadSidebar(harness, page);
    sidebar.clearProtocol();

    await clickRowAction(page, "tab:2", "Restore");
    await harness.waitForIdle();

    expect(harness.runtime.liveTabIds()).toEqual([1, 2]);
    expect(harness.runtime.sideEffects.some((effect) => effect.kind === "tabs.create")).toBe(true);
    await harness.assertCleanBackground();
    await expectNodeVisible(page, "tab:2", "Beta");
    expect(messageTypes(sidebar.protocol(), "page.sendMessage")).toContain("restoreNode");
    expect(messageTypes(sidebar.protocol(), "background.broadcast")).not.toContain("stateUpdated");
    expect(sidebar.issues).toEqual([]);
  });

  test("undo after runtime drift preserves runtime-scope order in sidebar rows", async ({ page }) => {
    const harness = createHarness(runtimeFixture(1, ["Alpha", "Beta", "Gamma"]));
    const sidebar = await loadSidebar(harness, page);
    sidebar.clearProtocol();

    await page.locator(`${nodeSelector("window:1")} .twisty`).click();
    await harness.waitForIdle();
    await harness.runtime.moveTabFromBrowser(3, { index: 0 });
    await harness.waitForIdle();
    await page.getByRole("button", { name: "Undo" }).click();
    await harness.waitForIdle();

    expect(harness.runtime.runtimeTabOrder(1)).toEqual([3, 1, 2]);
    await harness.assertCleanBackground();
    expect(liveTabOrder(await harness.state(), 1)).toEqual([3, 1, 2]);
    await expect(visibleNodeIds(page)).resolves.toEqual(["window:1", "tab:3", "tab:1", "tab:2"]);
    expect(messageTypes(sidebar.protocol(), "page.sendMessage")).toEqual(expect.arrayContaining(["toggleCollapsed", "undo"]));
    expect(sidebar.issues).toEqual([]);
  });

  test("sparse search projection absorbs a runtime update without full hydration", async ({ page }) => {
    const large = largeRuntimeFixture(420);
    const stored = bootstrapFromWindows(windowsWithTabs(large.windows, large.tabs), { now: NOW });
    const harness = createHarness({
      ...large,
      initialStorage: outlineStateV3Items(stored)
    });
    const sidebar = await loadSidebar(harness, page);
    sidebar.clearProtocol();

    await page.getByRole("searchbox", { name: "Search tabs" }).fill("Tab 399");
    await expectNodeVisible(page, "tab:399", "Tab 399");
    await harness.runtime.updateTabFromBrowser(399, { title: "Tab 399 Updated" });
    await harness.waitForIdle();

    await harness.assertCleanBackground();
    await expectNodeVisible(page, "tab:399", "Tab 399 Updated");
    await expect(page.getByRole("searchbox", { name: "Search tabs" })).toHaveValue("Tab 399");
    const pageMessages = messageTypes(sidebar.protocol(), "page.sendMessage");
    expect(pageMessages).toContain("getTreeProjectionSlice");
    expect(pageMessages).not.toContain("getState");
    expect(sidebar.issues).toEqual([]);
  });

  test("two sidebars receive one runtime event without corrupting local projection intent", async ({ page, context }) => {
    const harness = createHarness(runtimeFixture(1, ["Alpha", "Beta"]));
    const first = await loadSidebar(harness, page);
    const secondPage = await context.newPage();
    const second = await loadSidebar(harness, secondPage);
    first.clearProtocol();
    second.clearProtocol();

    await secondPage.getByRole("searchbox", { name: "Search tabs" }).fill("Beta");
    await expect(secondPage.locator(nodeSelector("tab:1"))).toHaveCount(0);
    await expectNodeVisible(secondPage, "tab:2", "Beta");

    await harness.runtime.createTabFromBrowser(tab(3, 1, 2, false, "Gamma"));
    await harness.waitForIdle();

    await harness.assertCleanBackground();
    await expectNodeVisible(page, "tab:3", "Gamma");
    await expect(secondPage.getByRole("searchbox", { name: "Search tabs" })).toHaveValue("Beta");
    await expect(secondPage.locator(nodeSelector("tab:3"))).toHaveCount(0);
    expect(messageTypes(first.protocol(), "background.broadcast")).toContain("treeStructureUpdated");
    expect(messageTypes(second.protocol(), "background.broadcast")).toContain("treeStructureUpdated");
    expect(first.issues).toEqual([]);
    expect(second.issues).toEqual([]);
    await secondPage.close();
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
  initialStorage?: Record<string, unknown>;
}): SidebarRuntimeHarness {
  return createSidebarRuntimeHarness({
    ...fixture,
    now: () => NOW
  });
}

function runtimeFixture(windowId: number, titles: string[]): { windows: RuntimeWindow[]; tabs: RuntimeTab[] } {
  return {
    windows: [runtimeWindow(windowId, true)],
    tabs: titles.map((title, index) => tab(index + 1, windowId, index, index === 0, title))
  };
}

function largeRuntimeFixture(tabCount: number): { windows: RuntimeWindow[]; tabs: RuntimeTab[] } {
  return {
    windows: [runtimeWindow(1, true)],
    tabs: Array.from({ length: tabCount }, (_value, index) =>
      tab(index + 1, 1, index, index === 0, `Tab ${index + 1}`)
    )
  };
}

function runtimeWindow(id: number, focused: boolean): RuntimeWindow {
  return {
    id,
    focused,
    incognito: false
  };
}

function tab(id: number, windowId: number, index: number, active: boolean, title: string): RuntimeTab {
  return {
    id,
    windowId,
    index,
    active,
    title,
    url: `https://example.test/${encodeURIComponent(title.toLowerCase().replaceAll(" ", "-"))}`
  };
}

function windowsWithTabs(windows: RuntimeWindow[], tabs: RuntimeTab[]): RuntimeWindow[] {
  return windows.map((windowInfo) => ({
    ...windowInfo,
    tabs: tabs
      .filter((candidate) => candidate.windowId === windowInfo.id)
      .sort((left, right) => left.index - right.index)
  }));
}

function closedTabStorageFixture(): OutlineState {
  const liveState = bootstrapFromWindows(windowsWithTabs(
    [runtimeWindow(1, true)],
    [tab(1, 1, 0, true, "Alpha"), tab(2, 1, 1, false, "Beta")]
  ), { now: NOW });
  return closeTab(liveState, 2, { now: NOW + 1 });
}

function messageTypes(log: ReturnType<AttachedSidebarPage["protocol"]>, kind: "page.sendMessage" | "background.broadcast"): string[] {
  return log
    .filter((entry) => entry.kind === kind)
    .map((entry) => entry.message)
    .filter((message): message is { type: string } =>
      Boolean(message && typeof message === "object" && typeof (message as { type?: unknown }).type === "string")
    )
    .map((message) => message.type);
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

function liveTabOrder(state: OutlineState, windowId: number): number[] {
  const windowNode = Object.values(state.nodes).find((node) =>
    node.kind === "window" &&
    node.status === "live" &&
    node.live &&
    "windowId" in node.live &&
    node.live.windowId === windowId
  );
  if (!windowNode) {
    return [];
  }
  return windowNode.childIds.flatMap((nodeId) => {
    const node = state.nodes[nodeId];
    return node?.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live
      ? [node.live.tabId]
      : [];
  });
}

async function clickRowAction(page: Page, nodeId: string, actionName: string): Promise<void> {
  const node = page.locator(nodeSelector(nodeId));
  await node.locator(".node-row").hover();
  await node.getByRole("button", { name: actionName }).click();
}

async function expectNodeVisible(page: Page, nodeId: string, title: string): Promise<void> {
  const node = page.locator(nodeSelector(nodeId));
  await expect(node).toBeVisible();
  await expect(node.locator(".node-title")).toContainText(title);
}

function nodeSelector(nodeId: string): string {
  return `.node[data-node-id='${nodeId.replaceAll(":", "\\:")}']`;
}
