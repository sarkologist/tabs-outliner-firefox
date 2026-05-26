import { expect, test, type Page } from "@playwright/test";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

test.describe("sidebar first paint", () => {
  test("paints the initial snapshot before full hydration starts", async ({ page }) => {
    const issues = collectPageIssues(page);
    await page.addInitScript((snapshot) => {
      const messages: Array<{ type: string; at: number }> = [];
      (window as typeof window & { __sidebarBootMessages?: typeof messages }).__sidebarBootMessages = messages;
      window.browser = {
        runtime: {
          sendMessage: async (message: unknown) => {
            const type = typeof message === "object" && message ? String((message as { type?: unknown }).type) : "";
            messages.push({ type, at: performance.now() });
            if (type === "getInitialTreeSnapshot") {
              return structuredClone(snapshot);
            }
            if (type === "getState") {
              return new Promise(() => undefined);
            }
            if (
              type === "getDiagnostics" ||
              type === "getPerformanceTrace" ||
              type === "setPerformanceTraceEnabled" ||
              type === "clearPerformanceTrace"
            ) {
              return undefined;
            }
            return { ok: true };
          },
          onMessage: {
            addListener: () => undefined
          }
        },
        storage: {
          local: {
            get: async () => ({}),
            set: async () => undefined
          }
        }
      };
    }, fixtureInitialSnapshot(50_000));

    await page.goto("/sidebar/sidebar.html");
    await expect(page.locator(".node[data-node-id='tab:1']")).toBeVisible();
    await expect(page.locator("#state-count")).toHaveText("50001 items / 0 saved");

    const metrics = await page.evaluate(() => {
      const messages = (window as typeof window & { __sidebarBootMessages?: Array<{ type: string; at: number }> })
        .__sidebarBootMessages ?? [];
      const firstRowsAt = performance.getEntriesByName("tabs-outliner.boot.firstRows").at(-1)?.startTime;
      const firstHydrationAt = messages.find((message) => message.type === "getState")?.at;
      return {
        firstRowsAt,
        firstHydrationAt,
        initialSnapshotRequests: messages.filter((message) => message.type === "getInitialTreeSnapshot").length,
        visibleRows: document.querySelectorAll(".node").length
      };
    });

    expect(metrics.firstRowsAt).toBeGreaterThan(0);
    expect(metrics.initialSnapshotRequests).toBe(1);
    expect(metrics.visibleRows).toBeGreaterThan(0);
    if (typeof metrics.firstHydrationAt === "number" && typeof metrics.firstRowsAt === "number") {
      expect(metrics.firstRowsAt).toBeLessThan(metrics.firstHydrationAt);
    }
    console.log("sidebar-first-paint", JSON.stringify(metrics));
    expect(issues).toEqual([]);
  });

  test("does not reveal a top slice before hydration when the snapshot misses the active tab", async ({ page }) => {
    const issues = collectPageIssues(page);
    await page.addInitScript(({ snapshot, fullState }) => {
      const messages: Array<{ type: string; at: number }> = [];
      let resolveGetState: ((state: unknown) => void) | undefined;
      Object.assign(window as typeof window & {
        __sidebarBootMessages?: typeof messages;
        __resolveSidebarGetState?: () => void;
      }, {
        __sidebarBootMessages: messages,
        __resolveSidebarGetState: () => resolveGetState?.(structuredClone(fullState))
      });
      window.browser = {
        runtime: {
          sendMessage: async (message: unknown) => {
            const type = typeof message === "object" && message ? String((message as { type?: unknown }).type) : "";
            messages.push({ type, at: performance.now() });
            if (type === "getInitialTreeSnapshot") {
              return structuredClone(snapshot);
            }
            if (type === "getState") {
              return new Promise((resolve) => {
                resolveGetState = resolve;
              });
            }
            if (
              type === "getDiagnostics" ||
              type === "getPerformanceTrace" ||
              type === "setPerformanceTraceEnabled" ||
              type === "clearPerformanceTrace"
            ) {
              return undefined;
            }
            return { ok: true };
          },
          onMessage: {
            addListener: () => undefined
          }
        },
        storage: {
          local: {
            get: async () => ({}),
            set: async () => undefined
          }
        }
      };
    }, {
      snapshot: fixtureInitialSnapshot(500, { activeTabInSnapshot: false }),
      fullState: fixtureFullState(500, 400)
    });

    await page.goto("/sidebar/sidebar.html");
    await page.waitForFunction(() => {
      const messages = (window as typeof window & { __sidebarBootMessages?: Array<{ type: string }> })
        .__sidebarBootMessages ?? [];
      return messages.some((message) => message.type === "getState");
    });
    await expect(page.locator("body")).toHaveAttribute("data-sidebar-booting", "");
    await expect(page.getByRole("treeitem")).toHaveCount(0);

    await page.evaluate(() => {
      (window as typeof window & { __resolveSidebarGetState?: () => void }).__resolveSidebarGetState?.();
    });

    await expect(page.locator(".node[data-node-id='tab:400'].is-active")).toBeVisible();
    await expect(page.locator("body")).not.toHaveAttribute("data-sidebar-booting", "");
    expect(issues).toEqual([]);
  });

  test("paints an active-centered sparse snapshot before full hydration", async ({ page }) => {
    const issues = collectPageIssues(page);
    await page.addInitScript((snapshot) => {
      const messages: Array<{ type: string; at: number }> = [];
      (window as typeof window & { __sidebarBootMessages?: typeof messages }).__sidebarBootMessages = messages;
      window.browser = {
        runtime: {
          sendMessage: async (message: unknown) => {
            const type = typeof message === "object" && message ? String((message as { type?: unknown }).type) : "";
            messages.push({ type, at: performance.now() });
            if (type === "getInitialTreeSnapshot") {
              return structuredClone(snapshot);
            }
            if (type === "getState") {
              return new Promise(() => undefined);
            }
            if (
              type === "getDiagnostics" ||
              type === "getPerformanceTrace" ||
              type === "setPerformanceTraceEnabled" ||
              type === "clearPerformanceTrace"
            ) {
              return undefined;
            }
            return { ok: true };
          },
          onMessage: {
            addListener: () => undefined
          }
        },
        storage: {
          local: {
            get: async () => ({}),
            set: async () => undefined
          }
        }
      };
    }, fixtureActiveCenteredSnapshot(500, 400));

    await page.goto("/sidebar/sidebar.html");
    await expect(page.locator(".node[data-node-id='tab:400'].is-active")).toBeVisible();

    const metrics = await page.evaluate(() => {
      const messages = (window as typeof window & { __sidebarBootMessages?: Array<{ type: string; at: number }> })
        .__sidebarBootMessages ?? [];
      return {
        hydrationRequests: messages.filter((message) => message.type === "getState").length,
        scrollTop: document.querySelector("main")?.scrollTop ?? 0,
        treeHeight: Number.parseFloat((document.querySelector<HTMLElement>("#tree")?.style.height ?? "0").replace("px", ""))
      };
    });

    expect(metrics.hydrationRequests).toBe(0);
    expect(metrics.scrollTop).toBeGreaterThan(5000);
    expect(metrics.treeHeight).toBeGreaterThan(9000);
    expect(issues).toEqual([]);
  });

  test("exports through the background when a sparse snapshot omits collapsed descendants", async ({ page }) => {
    const issues = collectPageIssues(page);
    await page.addInitScript(({ snapshot, fullState }) => {
      const messages: Array<{ type: string; at: number }> = [];
      let resolveGetState: ((state: unknown) => void) | undefined;
      Object.assign(window as typeof window & {
        __sidebarBootMessages?: typeof messages;
        __resolveSidebarGetState?: () => void;
        __lastSidebarDownload?: { filename: string; href: string };
      }, {
        __sidebarBootMessages: messages,
        __resolveSidebarGetState: () => resolveGetState?.(structuredClone(fullState))
      });
      const originalAnchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function click() {
        if (this.download) {
          (window as typeof window & {
            __lastSidebarDownload?: { filename: string; href: string };
          }).__lastSidebarDownload = { filename: this.download, href: this.href };
          return;
        }
        return originalAnchorClick.call(this);
      };
      window.browser = {
        runtime: {
          sendMessage: async (message: unknown) => {
            const type = typeof message === "object" && message ? String((message as { type?: unknown }).type) : "";
            messages.push({ type, at: performance.now() });
            if (type === "getInitialTreeSnapshot") {
              return structuredClone(snapshot);
            }
            if (type === "getState") {
              return new Promise((resolve) => {
                resolveGetState = resolve;
              });
            }
            if (type === "exportTree") {
              return {
                type: "exportTree",
                filename: "tabs-outliner-tree-2026-05-26.json",
                contentType: "application/json",
                content: "{\"schema\":\"tabs-outliner-tree\",\"version\":1,\"exportedAt\":\"2026-05-26T00:00:00.000Z\",\"roots\":[]}\n"
              };
            }
            if (
              type === "getDiagnostics" ||
              type === "getPerformanceTrace" ||
              type === "setPerformanceTraceEnabled" ||
              type === "clearPerformanceTrace"
            ) {
              return undefined;
            }
            return { ok: true };
          },
          onMessage: {
            addListener: () => undefined
          }
        },
        storage: {
          local: {
            get: async () => ({}),
            set: async () => undefined
          }
        }
      };
    }, {
      snapshot: fixtureCollapsedPartialSnapshot(100),
      fullState: fixtureCollapsedFullState(100)
    });

    await page.goto("/sidebar/sidebar.html");
    await expect(page.locator(".node[data-node-id='group:hidden']")).toBeVisible();
    await expect(page.locator("#state-count")).toHaveText("103 items / 101 saved");
    await expect(page.locator("#export-tree")).toBeEnabled();
    await expect(page.locator("#import-tree")).toBeDisabled();
    await page.locator("#export-tree").click();
    await page.waitForFunction(() => {
      const messages = (window as typeof window & { __sidebarBootMessages?: Array<{ type: string }> })
        .__sidebarBootMessages ?? [];
      return messages.some((message) => message.type === "exportTree");
    });

    const exportMetrics = await page.evaluate(() => {
      const messages = (window as typeof window & { __sidebarBootMessages?: Array<{ type: string }> })
        .__sidebarBootMessages ?? [];
      const download = (window as typeof window & {
        __lastSidebarDownload?: { filename: string; href: string };
      }).__lastSidebarDownload;
      return {
        exportRequests: messages.filter((message) => message.type === "exportTree").length,
        hydrationRequests: messages.filter((message) => message.type === "getState").length,
        filename: download?.filename
      };
    });
    expect(exportMetrics).toEqual({
      exportRequests: 1,
      hydrationRequests: 0,
      filename: "tabs-outliner-tree-2026-05-26.json"
    });
    await page.waitForFunction(() => {
      const messages = (window as typeof window & { __sidebarBootMessages?: Array<{ type: string }> })
        .__sidebarBootMessages ?? [];
      return messages.some((message) => message.type === "getState");
    });

    const beforeHydration = await page.evaluate(() => {
      const messages = (window as typeof window & { __sidebarBootMessages?: Array<{ type: string }> })
        .__sidebarBootMessages ?? [];
      return {
        hydrationRequests: messages.filter((message) => message.type === "getState").length
      };
    });
    expect(beforeHydration.hydrationRequests).toBe(1);

    await page.evaluate(() => {
      (window as typeof window & { __resolveSidebarGetState?: () => void }).__resolveSidebarGetState?.();
    });
    await expect(page.locator("#export-tree")).toBeEnabled();
    await expect(page.locator("#import-tree")).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("hydrates after first paint and exposes startup timing marks", async ({ page }) => {
    const issues = collectPageIssues(page);
    await page.addInitScript(({ snapshot, fullState }) => {
      window.localStorage.setItem("tabsOutlinerProfileEnabled", "true");
      const messages: Array<{ type: string; at: number }> = [];
      (window as typeof window & { __sidebarBootMessages?: typeof messages }).__sidebarBootMessages = messages;
      window.browser = {
        runtime: {
          sendMessage: async (message: unknown) => {
            const type = typeof message === "object" && message ? String((message as { type?: unknown }).type) : "";
            messages.push({ type, at: performance.now() });
            if (type === "getInitialTreeSnapshot") {
              return structuredClone(snapshot);
            }
            if (type === "getState") {
              return structuredClone(fullState);
            }
            if (
              type === "getDiagnostics" ||
              type === "getPerformanceTrace" ||
              type === "setPerformanceTraceEnabled" ||
              type === "clearPerformanceTrace"
            ) {
              return undefined;
            }
            return { ok: true };
          },
          onMessage: {
            addListener: () => undefined
          },
          connect: () => ({
            onMessage: { addListener: () => undefined },
            onDisconnect: { addListener: () => undefined }
          })
        },
        storage: {
          local: {
            get: async () => ({}),
            set: async () => undefined
          },
          onChanged: {
            addListener: () => undefined
          }
        },
        windows: {
          getCurrent: async () => ({ id: 1 })
        }
      };
    }, {
      snapshot: fixtureInitialSnapshot(500),
      fullState: fixtureFullState(500, 1)
    });

    await page.goto("/sidebar/sidebar.html");
    await expect(page.locator(".node[data-node-id='tab:1']")).toBeVisible();
    await expect(page.locator("#search")).toBeDisabled();
    await page.waitForFunction(() =>
      performance.getEntriesByName("tabs-outliner.sidebar.hydration.complete").length > 0
    );
    await expect(page.locator("#search")).toBeEnabled();
    await expect(page.locator("#state-count")).toHaveText("501 items / 0 saved");

    const metrics = await page.evaluate(async () => {
      const mark = (name: string) => performance.getEntriesByName(name).at(-1)?.startTime;
      const messages = (window as typeof window & { __sidebarBootMessages?: Array<{ type: string; at: number }> })
        .__sidebarBootMessages ?? [];
      return {
        initialSnapshotStart: mark("tabs-outliner.boot.initialSnapshot.start"),
        initialSnapshotEnd: mark("tabs-outliner.boot.initialSnapshot.end"),
        firstRowsAt: mark("tabs-outliner.boot.firstRows"),
        fullAppImportStart: mark("tabs-outliner.boot.fullAppImport.start"),
        fullAppImportEnd: mark("tabs-outliner.boot.fullAppImport.end"),
        hydrationStart: mark("tabs-outliner.sidebar.hydration.start"),
        hydrationComplete: mark("tabs-outliner.sidebar.hydration.complete"),
        initialSnapshotRequests: messages.filter((message) => message.type === "getInitialTreeSnapshot").length,
        hydrationRequests: messages.filter((message) => message.type === "getState").length,
        hydrationTrace: (await window.tabsOutlinerProfile?.summary())?.find(
          (row) => row.name === "sidebar.hydration"
        )
      };
    });

    expect(metrics.initialSnapshotRequests).toBe(1);
    expect(metrics.hydrationRequests).toBe(1);
    expect(metrics.firstRowsAt).toBeGreaterThan(0);
    expect(metrics.initialSnapshotStart).toBeLessThanOrEqual(metrics.initialSnapshotEnd);
    expect(metrics.initialSnapshotEnd).toBeLessThanOrEqual(metrics.firstRowsAt);
    expect(metrics.firstRowsAt).toBeLessThan(metrics.fullAppImportStart);
    expect(metrics.fullAppImportStart).toBeLessThanOrEqual(metrics.fullAppImportEnd);
    expect(metrics.fullAppImportEnd).toBeLessThan(metrics.hydrationStart);
    expect(metrics.hydrationStart).toBeLessThanOrEqual(metrics.hydrationComplete);
    expect(metrics.hydrationTrace?.count).toBe(1);
    expect(metrics.hydrationTrace?.maxMs).toBeGreaterThanOrEqual(0);
    expect(issues).toEqual([]);
  });
});

function fixtureInitialSnapshot(tabCount: number, options: { activeTabInSnapshot?: boolean } = {}) {
  const now = 1_700_000_000_000;
  const loadedTabCount = 255;
  const loadedTabIds = Array.from({ length: loadedTabCount }, (_value, index) => `tab:${index + 1}`);
  const activeTabInSnapshot = options.activeTabInSnapshot ?? true;
  const rows = [
    {
      nodeId: "window:1",
      depth: 0,
      index: 0,
      subtreeEndIndex: loadedTabCount + 1,
      childCount: tabCount,
      visibleChildCount: tabCount,
      expanded: true,
      searchRevealsCollapsedChildren: false,
      isSearchMatch: false,
      isSearchPath: false,
      insideActiveWindow: true
    },
    ...loadedTabIds.map((nodeId, index) => ({
      nodeId,
      depth: 1,
      index: index + 1,
      parentRowIndex: 0,
      subtreeEndIndex: index + 2,
      childCount: 0,
      visibleChildCount: 0,
      expanded: true,
      searchRevealsCollapsedChildren: false,
      isSearchMatch: false,
      isSearchPath: false,
      insideActiveWindow: true
    }))
  ];
  return {
    type: "initialTreeSnapshot",
    version: 1,
    revision: 123,
    hydrating: true,
    state: {
      version: 1,
      rootIds: ["window:1"],
      nodes: {
        "window:1": {
          id: "window:1",
          kind: "window",
          status: "live",
          childIds: loadedTabIds,
          title: "Window",
          active: true,
          collapsed: false,
          createdAt: now,
          updatedAt: now,
          live: { windowId: 1 }
        },
        ...Object.fromEntries(
          loadedTabIds.map((id, index) => [
            id,
            {
              id,
              kind: "tab",
              status: "live",
              parentId: "window:1",
              childIds: [],
              title: `Tab ${index + 1}`,
              url: `https://paint.example/${index + 1}`,
              active: activeTabInSnapshot && index === 0,
              collapsed: false,
              createdAt: now,
              updatedAt: now,
              live: { tabId: index + 1, windowId: 1 }
            }
          ])
        )
      }
    },
    projection: {
      query: "",
      isSearchActive: false,
      rows,
      matchingNodeIds: [],
      visibleNodeIds: rows.map((row) => row.nodeId),
      ...(activeTabInSnapshot ? { activeTabNodeId: "tab:1", activeTabRowIndex: 1 } : {}),
      totalRowCount: tabCount + 1,
      nodeCount: tabCount + 1,
      closedCount: 0,
      matchCount: 0
    }
  };
}

function fixtureFullState(tabCount: number, activeTabId: number) {
  const now = 1_700_000_000_000;
  const tabIds = Array.from({ length: tabCount }, (_value, index) => `tab:${index + 1}`);
  return {
    version: 1,
    rootIds: ["window:1"],
    nodes: {
      "window:1": {
        id: "window:1",
        kind: "window",
        status: "live",
        childIds: tabIds,
        title: "Window",
        active: true,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { windowId: 1 }
      },
      ...Object.fromEntries(
        tabIds.map((id, index) => [
          id,
          {
            id,
            kind: "tab",
            status: "live",
            parentId: "window:1",
            childIds: [],
            title: `Tab ${index + 1}`,
            url: `https://paint.example/${index + 1}`,
            active: index + 1 === activeTabId,
            collapsed: false,
            createdAt: now,
            updatedAt: now,
            live: { tabId: index + 1, windowId: 1 }
          }
        ])
      )
    }
  };
}

function fixtureCollapsedPartialSnapshot(hiddenTabCount: number) {
  const now = 1_700_000_000_000;
  return {
    type: "initialTreeSnapshot",
    version: 1,
    revision: 123,
    hydrating: false,
    state: {
      version: 1,
      rootIds: ["window:1"],
      nodes: {
        "window:1": {
          id: "window:1",
          kind: "window",
          status: "live",
          childIds: ["tab:1", "group:hidden"],
          title: "Window",
          active: true,
          collapsed: false,
          createdAt: now,
          updatedAt: now,
          live: { windowId: 1 }
        },
        "tab:1": {
          id: "tab:1",
          kind: "tab",
          status: "live",
          parentId: "window:1",
          childIds: [],
          title: "Visible tab",
          url: "https://visible.example/",
          active: true,
          collapsed: false,
          createdAt: now,
          updatedAt: now,
          live: { tabId: 1, windowId: 1 }
        },
        "group:hidden": {
          id: "group:hidden",
          kind: "group",
          status: "closed",
          parentId: "window:1",
          childIds: [],
          title: "Hidden saved group",
          collapsed: true,
          createdAt: now,
          updatedAt: now,
          closedAt: now
        }
      }
    },
    projection: {
      query: "",
      isSearchActive: false,
      rows: [
        {
          nodeId: "window:1",
          depth: 0,
          index: 0,
          subtreeEndIndex: 3,
          childCount: 2,
          visibleChildCount: 2,
          expanded: true,
          searchRevealsCollapsedChildren: false,
          isSearchMatch: false,
          isSearchPath: false,
          insideActiveWindow: true
        },
        {
          nodeId: "tab:1",
          depth: 1,
          index: 1,
          parentRowIndex: 0,
          subtreeEndIndex: 2,
          childCount: 0,
          visibleChildCount: 0,
          expanded: true,
          searchRevealsCollapsedChildren: false,
          isSearchMatch: false,
          isSearchPath: false,
          insideActiveWindow: true
        },
        {
          nodeId: "group:hidden",
          depth: 1,
          index: 2,
          parentRowIndex: 0,
          subtreeEndIndex: 3,
          childCount: hiddenTabCount,
          visibleChildCount: 0,
          expanded: false,
          searchRevealsCollapsedChildren: false,
          isSearchMatch: false,
          isSearchPath: false,
          insideActiveWindow: true
        }
      ],
      matchingNodeIds: [],
      visibleNodeIds: ["window:1", "tab:1", "group:hidden"],
      activeTabNodeId: "tab:1",
      activeTabRowIndex: 1,
      totalRowCount: 3,
      nodeCount: hiddenTabCount + 3,
      closedCount: hiddenTabCount + 1,
      matchCount: 0
    }
  };
}

function fixtureCollapsedFullState(hiddenTabCount: number) {
  const now = 1_700_000_000_000;
  const hiddenTabIds = Array.from({ length: hiddenTabCount }, (_value, index) => `hidden:${index + 1}`);
  return {
    version: 1,
    rootIds: ["window:1"],
    nodes: {
      "window:1": {
        id: "window:1",
        kind: "window",
        status: "live",
        childIds: ["tab:1", "group:hidden"],
        title: "Window",
        active: true,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { windowId: 1 }
      },
      "tab:1": {
        id: "tab:1",
        kind: "tab",
        status: "live",
        parentId: "window:1",
        childIds: [],
        title: "Visible tab",
        url: "https://visible.example/",
        active: true,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { tabId: 1, windowId: 1 }
      },
      "group:hidden": {
        id: "group:hidden",
        kind: "group",
        status: "closed",
        parentId: "window:1",
        childIds: hiddenTabIds,
        title: "Hidden saved group",
        collapsed: true,
        createdAt: now,
        updatedAt: now,
        closedAt: now
      },
      ...Object.fromEntries(hiddenTabIds.map((id, index) => [
        id,
        {
          id,
          kind: "tab",
          status: "closed",
          parentId: "group:hidden",
          childIds: [],
          title: `Hidden ${index + 1}`,
          url: `https://hidden.example/${index + 1}`,
          collapsed: false,
          createdAt: now,
          updatedAt: now,
          closedAt: now + index + 1,
          restore: {
            url: `https://hidden.example/${index + 1}`,
            title: `Hidden ${index + 1}`
          }
        }
      ]))
    }
  };
}

function fixtureActiveCenteredSnapshot(tabCount: number, activeTabId: number) {
  const now = 1_700_000_000_000;
  const rowLimit = 256;
  const startTabId = Math.max(1, activeTabId - Math.floor(rowLimit / 2));
  const tabIds = Array.from(
    { length: Math.min(rowLimit, tabCount - startTabId + 1) },
    (_value, index) => `tab:${startTabId + index}`
  );
  const rows = tabIds.map((nodeId) => {
    const tabId = Number.parseInt(nodeId.slice("tab:".length), 10);
    return {
      nodeId,
      depth: 1,
      index: tabId,
      parentRowIndex: 0,
      subtreeEndIndex: tabId + 1,
      childCount: 0,
      visibleChildCount: 0,
      expanded: true,
      searchRevealsCollapsedChildren: false,
      isSearchMatch: false,
      isSearchPath: false,
      insideActiveWindow: true
    };
  });
  return {
    type: "initialTreeSnapshot",
    version: 1,
    revision: 124,
    hydrating: true,
    state: {
      version: 1,
      rootIds: [],
      nodes: Object.fromEntries(
        tabIds.map((id) => {
          const tabId = Number.parseInt(id.slice("tab:".length), 10);
          return [
            id,
            {
              id,
              kind: "tab",
              status: "live",
              parentId: "window:1",
              childIds: [],
              title: `Tab ${tabId}`,
              url: `https://paint.example/${tabId}`,
              active: tabId === activeTabId,
              collapsed: false,
              createdAt: now,
              updatedAt: now,
              live: { tabId, windowId: 1 }
            }
          ];
        })
      )
    },
    projection: {
      query: "",
      isSearchActive: false,
      rows,
      matchingNodeIds: [],
      visibleNodeIds: rows.map((row) => row.nodeId),
      activeTabNodeId: `tab:${activeTabId}`,
      activeTabRowIndex: activeTabId,
      totalRowCount: tabCount + 1,
      nodeCount: tabCount + 1,
      closedCount: 0,
      matchCount: 0
    }
  };
}

function collectPageIssues(page: Page): ConsoleIssue[] {
  const issues: ConsoleIssue[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      issues.push({ kind: "console", text: message.text() });
    }
  });
  page.on("pageerror", (error) => {
    issues.push({ kind: "pageerror", text: error.message });
  });
  page.on("requestfailed", (request) => {
    issues.push({ kind: "requestfailed", text: `${request.url()} ${request.failure()?.errorText ?? ""}` });
  });
  return issues;
}
