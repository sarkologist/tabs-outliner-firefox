import { expect, test, type Page } from "@playwright/test";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

const TAB_COUNT = 50_000;
const ACTIVE_TAB_ID = 40_000;
const TARGET_NODE_ID = `tab:${ACTIVE_TAB_ID}`;

test.describe("sidebar startup interaction profile", () => {
  test("profiles sparse first paint below the startup interaction budget", async ({ page }, testInfo) => {
    const issues = collectPageIssues(page);

    await page.addInitScript(({ snapshot }) => {
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
      snapshot: fixtureActiveCenteredSnapshot(TAB_COUNT, ACTIVE_TAB_ID)
    });

    await page.goto("/sidebar/sidebar.html");
    await expect(page.locator(`.node[data-node-id='${TARGET_NODE_ID}'].is-active`)).toBeVisible();

    const result = await page.evaluate(async (targetNodeId) => {
      const snapshot = await window.tabsOutlinerProfile?.snapshot();
      const summary = await window.tabsOutlinerProfile?.summary();
      const entries = snapshot?.sidebar.entries ?? [];
      const messages = (window as typeof window & { __sidebarBootMessages?: Array<{ type: string; at: number }> })
        .__sidebarBootMessages ?? [];
      const target = document.querySelector<HTMLElement>(`.node[data-node-id="${CSS.escape(targetNodeId)}"]`);
      const tree = document.querySelector<HTMLElement>("#tree");
      const viewport = document.querySelector<HTMLElement>("main");
      const renderedRows = document.querySelectorAll(".node").length;
      const actionButtons = document.querySelectorAll(".node-actions .icon-button").length;

      return {
        targetVisible: Boolean(target && target.offsetParent !== null),
        targetRowIndex: target?.dataset.rowIndex,
        treeHeight: tree?.style.height,
        scrollTop: viewport?.scrollTop ?? 0,
        renderedRows,
        actionButtons,
        initialSnapshotRequests: messages.filter((message) => message.type === "getInitialTreeSnapshot").length,
        hydrationRequests: messages.filter((message) => message.type === "getState").length,
        initialSnapshotRender: summary?.find((row) => row.name === "sidebar.render.initialSnapshot"),
        initialSnapshotEntries: entries.filter((entry) => entry.name === "sidebar.render.initialSnapshot").map((entry) => ({
          durationMs: entry.durationMs,
          detail: entry.detail
        }))
      };
    }, TARGET_NODE_ID);

    await testInfo.attach("startup-sparse-first-paint-profile.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json"
    });
    console.log(`startup-sparse-first-paint ${JSON.stringify(result)}`);

    expect(result.targetVisible).toBe(true);
    expect(result.initialSnapshotRequests).toBe(1);
    expect(result.hydrationRequests).toBe(0);
    expect(result.renderedRows).toBeGreaterThan(0);
    expect(result.initialSnapshotRender?.maxMs).toBeLessThan(16);
    expect(issues).toEqual([]);
  });

  test("profiles hover feedback against a sparse startup snapshot", async ({ page }, testInfo) => {
    const issues = collectPageIssues(page);

    await page.addInitScript(({ snapshot }) => {
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
      snapshot: fixtureActiveCenteredSnapshot(TAB_COUNT, ACTIVE_TAB_ID)
    });

    await page.goto("/sidebar/sidebar.html");
    await expect(page.locator(`.node[data-node-id='${TARGET_NODE_ID}'].is-active`)).toBeVisible();
    await page.waitForFunction(() => Boolean(window.tabsOutlinerProfile));
    await page.evaluate(async () => {
      await window.tabsOutlinerProfile?.enable();
      await window.tabsOutlinerProfile?.clear();
    });

    const result = await page.evaluate(async (targetNodeId) => {
      const row = document.querySelector(`.node[data-node-id="${CSS.escape(targetNodeId)}"] > .node-row`);
      if (!(row instanceof HTMLElement)) {
        throw new Error(`Missing target row for ${targetNodeId}`);
      }

      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new PointerEvent("pointerover", {
        bubbles: true,
        clientX: rect.left + 20,
        clientY: rect.top + rect.height / 2,
        pointerType: "mouse"
      }));

      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

      const snapshot = await window.tabsOutlinerProfile?.snapshot();
      const summary = await window.tabsOutlinerProfile?.summary();
      const entries = snapshot?.sidebar.entries ?? [];
      const pointerEntries = entries.filter((entry) => entry.name === "sidebar.input.pointerDelay");
      const hoverFeedbackEntries = entries.filter((entry) => entry.name === "sidebar.input.hoverFeedbackDelay");
      const hoverFrameEntries = entries.filter((entry) => entry.name === "sidebar.input.hoverFrameDelay");
      const hoverGuideEntries = entries.filter((entry) => entry.name === "sidebar.hoverGuide");
      const messages = (window as typeof window & { __sidebarBootMessages?: Array<{ type: string; at: number }> })
        .__sidebarBootMessages ?? [];
      const tree = document.querySelector<HTMLElement>("#tree");
      const viewport = document.querySelector<HTMLElement>("main");
      const target = document.querySelector<HTMLElement>(`.node[data-node-id="${CSS.escape(targetNodeId)}"]`);
      const actionButtonsAfterHover = target?.querySelectorAll(".node-actions .icon-button").length ?? 0;

      return {
        targetVisible: Boolean(target && target.offsetParent !== null),
        targetRowIndex: target?.dataset.rowIndex,
        treeHeight: tree?.style.height,
        scrollTop: viewport?.scrollTop ?? 0,
        actionButtonsAfterHover,
        hydrationRequests: messages.filter((message) => message.type === "getState").length,
        initialSnapshotRequests: messages.filter((message) => message.type === "getInitialTreeSnapshot").length,
        pointerOutcomes: pointerEntries.map((entry) => entry.detail?.outcome ?? "none"),
        clearMissingRowCount: pointerEntries.filter((entry) => entry.detail?.outcome === "clear-missing-row").length,
        hoverFeedbackCount: hoverFeedbackEntries.length,
        hoverFrameCount: hoverFrameEntries.length,
        hoverGuideCount: hoverGuideEntries.length,
        pointerDelay: summary?.find((row) => row.name === "sidebar.input.pointerDelay"),
        hoverFeedbackDelay: summary?.find((row) => row.name === "sidebar.input.hoverFeedbackDelay"),
        hoverFrameDelay: summary?.find((row) => row.name === "sidebar.input.hoverFrameDelay"),
        hoverGuide: summary?.find((row) => row.name === "sidebar.hoverGuide")
      };
    }, TARGET_NODE_ID);

    await testInfo.attach("startup-sparse-hover-profile.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json"
    });
    console.log(`startup-sparse-hover ${JSON.stringify(result)}`);

    expect(result.targetVisible).toBe(true);
    expect(result.initialSnapshotRequests).toBe(1);
    expect(result.hydrationRequests).toBeGreaterThanOrEqual(0);
    expect(result.actionButtonsAfterHover).toBeGreaterThan(0);
    expect(result.pointerOutcomes.length).toBeGreaterThan(0);
    expect(result.clearMissingRowCount).toBe(0);
    expect(result.hoverFeedbackCount).toBeGreaterThan(0);
    expect(result.hoverFrameCount).toBeGreaterThan(0);
    expect(result.hoverGuideCount).toBeGreaterThan(0);
    expect(result.hoverFeedbackDelay?.maxMs).toBeLessThan(1);
    expect(result.hoverFrameDelay?.maxMs).toBeLessThan(20);
    expect(issues).toEqual([]);
  });

  test("keeps startup hover sparse without automatic full hydration", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const issues = collectPageIssues(page);

    await page.addInitScript(({ snapshot, fullState }) => {
      const messages: Array<{ type: string; at: number }> = [];
      (window as typeof window & {
        __sidebarBootMessages?: typeof messages;
      }).__sidebarBootMessages = messages;
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
      snapshot: fixtureActiveCenteredSnapshot(TAB_COUNT, ACTIVE_TAB_ID),
      fullState: fixtureFullState(TAB_COUNT, ACTIVE_TAB_ID)
    });

    await page.goto("/sidebar/sidebar.html");
    await expect(page.locator(`.node[data-node-id='${TARGET_NODE_ID}'].is-active`)).toBeVisible();
    await page.waitForFunction(() => Boolean(window.tabsOutlinerProfile));
    await page.evaluate(async () => {
      await window.tabsOutlinerProfile?.enable();
      await window.tabsOutlinerProfile?.clear();
    });

    const result = await page.evaluate(async (targetNodeId) => {
      const row = document.querySelector(`.node[data-node-id="${CSS.escape(targetNodeId)}"] > .node-row`);
      if (!(row instanceof HTMLElement)) {
        throw new Error(`Missing target row for ${targetNodeId}`);
      }

      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new PointerEvent("pointerover", {
        bubbles: true,
        clientX: rect.left + 20,
        clientY: rect.top + rect.height / 2,
        pointerType: "mouse"
      }));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const rowAfterHover = document.querySelector<HTMLElement>(
        `.node[data-node-id="${CSS.escape(targetNodeId)}"] > .node-row`
      );
      const actionStripAfterHover = rowAfterHover?.querySelector<HTMLElement>(".node-actions");
      const closeButtonAfterHover = rowAfterHover?.querySelector<HTMLElement>('[data-action="close-node"]');
      const tree = document.querySelector("#tree");
      const detachCounts = {
        row: 0,
        actionStrip: 0,
        closeButton: 0
      };
      const detachObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of Array.from(record.removedNodes)) {
            if (!(node instanceof Node)) {
              continue;
            }
            if (rowAfterHover && (node === rowAfterHover || node.contains(rowAfterHover))) {
              detachCounts.row += 1;
            }
            if (actionStripAfterHover && (node === actionStripAfterHover || node.contains(actionStripAfterHover))) {
              detachCounts.actionStrip += 1;
            }
            if (closeButtonAfterHover && (node === closeButtonAfterHover || node.contains(closeButtonAfterHover))) {
              detachCounts.closeButton += 1;
            }
          }
        }
      });
      if (tree) {
        detachObserver.observe(tree, { childList: true, subtree: true });
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 900));

      const messages = (window as typeof window & { __sidebarBootMessages?: Array<{ type: string; at: number }> })
        .__sidebarBootMessages ?? [];
      const hydrationRequestsBeforeIdle = messages.filter((message) => message.type === "getState").length;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 600));
      const messagesAfterIdle = (window as typeof window & { __sidebarBootMessages?: Array<{ type: string; at: number }> })
        .__sidebarBootMessages ?? [];
      const snapshot = await window.tabsOutlinerProfile?.snapshot();
      const summary = await window.tabsOutlinerProfile?.summary();
      const entries = snapshot?.sidebar.entries ?? [];
      const target = document.querySelector<HTMLElement>(`.node[data-node-id="${CSS.escape(targetNodeId)}"]`);
      const rowAfterIdle = target?.querySelector<HTMLElement>(":scope > .node-row");
      const actionStripAfterIdle = rowAfterIdle?.querySelector<HTMLElement>(".node-actions");
      const closeButtonAfterIdle = rowAfterIdle?.querySelector<HTMLElement>('[data-action="close-node"]');
      detachObserver.disconnect();

      return {
        hoverFrameDelay: summary?.find((row) => row.name === "sidebar.input.hoverFrameDelay"),
        hoverFeedbackDelay: summary?.find((row) => row.name === "sidebar.input.hoverFeedbackDelay"),
        hydration: summary?.find((row) => row.name === "sidebar.hydration"),
        render: summary?.find((row) => row.name === "sidebar.render"),
        actionButtonsAfterIdle: target?.querySelectorAll(".node-actions .icon-button").length ?? 0,
        rowElementPreservedAcrossIdle: rowAfterHover === rowAfterIdle,
        actionStripPreservedAcrossIdle: actionStripAfterHover === actionStripAfterIdle,
        closeButtonPreservedAcrossIdle: closeButtonAfterHover === closeButtonAfterIdle,
        detachedAfterHover: detachCounts,
        hydrationRequestsBeforeIdle,
        hydrationRequestsAfterIdle: messagesAfterIdle.filter((message) => message.type === "getState").length,
        pointerEntries: entries.filter((entry) => entry.name === "sidebar.input.pointerDelay").map((entry) => entry.detail),
        hoverFrameEntries: entries.filter((entry) => entry.name === "sidebar.input.hoverFrameDelay").map((entry) => ({
          durationMs: entry.durationMs,
          detail: entry.detail
        }))
      };
    }, TARGET_NODE_ID);

    await testInfo.attach("startup-hover-sparse-idle-profile.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json"
    });
    console.log(`startup-hover-sparse-idle ${JSON.stringify(result)}`);

    expect(result.hoverFeedbackDelay?.maxMs).toBeLessThan(16);
    expect(result.hoverFrameDelay?.maxMs).toBeLessThan(50);
    expect(result.hydrationRequestsBeforeIdle).toBe(0);
    expect(result.hydrationRequestsAfterIdle).toBe(0);
    expect(result.hydration).toBeUndefined();
    expect(result.render).toBeUndefined();
    expect(result.actionButtonsAfterIdle).toBeGreaterThan(0);
    expect(result.rowElementPreservedAcrossIdle).toBe(true);
    expect(result.actionStripPreservedAcrossIdle).toBe(true);
    expect(result.closeButtonPreservedAcrossIdle).toBe(true);
    expect(result.detachedAfterHover).toEqual({ row: 0, actionStrip: 0, closeButton: 0 });
    expect(issues).toEqual([]);
  });

  test("allows closing a covered visible row while the sidebar is sparse", async ({ page }) => {
    const issues = collectPageIssues(page);

    await page.addInitScript(({ snapshot, targetNodeId }) => {
      const messages: unknown[] = [];
      const listeners: Array<(message: unknown) => void> = [];
      (window as typeof window & { __sidebarBootMessages?: typeof messages }).__sidebarBootMessages = messages;
      window.browser = {
        runtime: {
          sendMessage: async (message: unknown) => {
            messages.push(structuredClone(message));
            const type = typeof message === "object" && message ? String((message as { type?: unknown }).type) : "";
            if (type === "getInitialTreeSnapshot") {
              return structuredClone(snapshot);
            }
            if (type === "getState") {
              return new Promise(() => undefined);
            }
            if (type === "closeNode") {
              const node = structuredClone(snapshot.state.nodes[targetNodeId]);
              delete node.live;
              node.status = "closed";
              node.active = false;
              node.closedAt = 1_700_000_001_000;
              node.restore = {
                url: node.url,
                title: node.title,
                favIconUrl: node.favIconUrl
              };
              window.setTimeout(() => {
                for (const listener of listeners) {
                  listener({
                    type: "nodeStateUpdated",
                    updatedNodes: [node],
                    closedCountDelta: 1
                  });
                }
              }, 0);
              return { type: "commandAck", stateChanged: true };
            }
            if (
              type === "getDiagnostics" ||
              type === "getPerformanceTrace" ||
              type === "setPerformanceTraceEnabled" ||
              type === "clearPerformanceTrace"
            ) {
              return undefined;
            }
            return { type: "commandAck", stateChanged: false };
          },
          onMessage: {
            addListener: (listener: (message: unknown) => void) => {
              listeners.push(listener);
            }
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
      snapshot: fixtureActiveCenteredSnapshot(TAB_COUNT, ACTIVE_TAB_ID),
      targetNodeId: TARGET_NODE_ID
    });

    await page.goto("/sidebar/sidebar.html");
    const target = page.locator(`.node[data-node-id='${TARGET_NODE_ID}']`);
    await expect(target).toBeVisible();
    await target.hover();
    await target.getByRole("button", { name: "Close", exact: true }).click();

    await expect(target).toHaveClass(/is-closed/);
    await expect(target.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    const messages = await page.evaluate(() =>
      ((window as typeof window & { __sidebarBootMessages?: unknown[] }).__sidebarBootMessages ?? [])
        .filter((message) => typeof message === "object" && message && (message as { type?: unknown }).type === "closeNode")
    );
    expect(messages).toEqual([{ type: "closeNode", nodeId: TARGET_NODE_ID }]);
    expect(issues).toEqual([]);
  });

  test("keeps sibling sidebar sparse after another sidebar reports interaction", async ({ page }, testInfo) => {
    const issues = collectPageIssues(page);

    await page.addInitScript(({ snapshot, fullState }) => {
      const messages: Array<{ type: string; at: number }> = [];
      const portListeners: Array<(message: unknown) => void> = [];
      Object.assign(window as typeof window & {
        __sidebarBootMessages?: typeof messages;
        __remoteSidebarInteractionAt?: number;
      }, {
        __sidebarBootMessages: messages
      });

      function emitRemoteSidebarInteraction(): void {
        (window as typeof window & { __remoteSidebarInteractionAt?: number }).__remoteSidebarInteractionAt =
          performance.now();
        for (const listener of portListeners) {
          listener({ type: "sidebarNonEditInteraction" });
        }
      }

      window.browser = {
        runtime: {
          sendMessage: async (message: unknown) => {
            const type = typeof message === "object" && message ? String((message as { type?: unknown }).type) : "";
            messages.push({ type, at: performance.now() });
            if (type === "getInitialTreeSnapshot") {
              window.setTimeout(emitRemoteSidebarInteraction, 50);
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
            onMessage: {
              addListener: (listener: (message: unknown) => void) => {
                portListeners.push(listener);
              }
            },
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
      snapshot: fixtureActiveCenteredSnapshot(TAB_COUNT, ACTIVE_TAB_ID),
      fullState: fixtureFullState(TAB_COUNT, ACTIVE_TAB_ID)
    });

    await page.goto("/sidebar/sidebar.html");
    await expect(page.locator(`.node[data-node-id='${TARGET_NODE_ID}'].is-active`)).toBeVisible();
    await page.waitForFunction(() => {
      return typeof (window as typeof window & { __remoteSidebarInteractionAt?: number }).__remoteSidebarInteractionAt ===
        "number";
    });

    const result = await page.evaluate(async () => {
      const state = window as typeof window & {
        __sidebarBootMessages?: Array<{ type: string; at: number }>;
        __remoteSidebarInteractionAt?: number;
      };
      const remoteInteractionAt = state.__remoteSidebarInteractionAt ?? performance.now();
      const waitUntil = (targetTime: number) =>
        new Promise<void>((resolve) => window.setTimeout(resolve, Math.max(0, targetTime - performance.now())));

      await waitUntil(remoteInteractionAt + 900);
      const messagesBeforeIdle = state.__sidebarBootMessages ?? [];
      const hydrationRequestsBeforeIdle = messagesBeforeIdle.filter((message) => message.type === "getState").length;

      await waitUntil(remoteInteractionAt + 1250);
      const messagesAfterIdle = state.__sidebarBootMessages ?? [];
      const firstHydrationAt = messagesAfterIdle.find((message) => message.type === "getState")?.at;

      return {
        remoteInteractionAt,
        firstHydrationAt,
        hydrationRequestsBeforeIdle,
        hydrationRequestsAfterIdle: messagesAfterIdle.filter((message) => message.type === "getState").length
      };
    });

    await testInfo.attach("startup-remote-interaction-sparse-idle.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json"
    });
    console.log(`startup-remote-interaction-sparse-idle ${JSON.stringify(result)}`);

    expect(result.hydrationRequestsBeforeIdle).toBe(0);
    expect(result.hydrationRequestsAfterIdle).toBe(0);
    expect(result.firstHydrationAt).toBeUndefined();
    expect(issues).toEqual([]);
  });
});

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
  const coverage = fixtureCoverageForRows(rows);
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
    },
    coverage
  };
}

function fixtureCoverageForRows(rows: Array<{ nodeId: string; index: number; subtreeEndIndex: number }>) {
  const startRowIndex = rows[0]?.index ?? 0;
  const endRowIndex = rows.length > 0 ? (rows.at(-1)?.index ?? startRowIndex) + 1 : startRowIndex;
  return {
    startRowIndex,
    endRowIndex,
    editableNodeIds: rows.map((row) => row.nodeId),
    completeSubtreeNodeIds: rows
      .filter((row) => row.subtreeEndIndex <= endRowIndex)
      .map((row) => row.nodeId),
    completeSiblingParentIds: rows.map((row) => row.nodeId)
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
