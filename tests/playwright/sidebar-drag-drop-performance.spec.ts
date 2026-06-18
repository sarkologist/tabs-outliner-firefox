import { expect, test, type Page } from "@playwright/test";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

const TAB_COUNT = 50_000;
const DRAGOVER_SAMPLES = 80;
const HOVER_SAMPLES = 80;

test.describe("sidebar drag/drop performance", () => {
  test("profiles large-subtree hover guides with 50,000 tabs", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const issues = collectPageIssues(page);

    await loadLargeSidebar(page, TAB_COUNT);
    await page.evaluate(async () => {
      await window.tabsOutlinerProfile?.enable();
      await window.tabsOutlinerProfile?.clear();
    });

    const result = await page.evaluate(
      async ({ samples, targetId }) => {
        const row = document.querySelector(
          `.node[data-node-id="${CSS.escape(targetId)}"] > .node-row`
        );
        if (!(row instanceof HTMLElement)) {
          throw new Error(`Missing target row for ${targetId}`);
        }

        const rect = row.getBoundingClientRect();
        const durations: number[] = [];
        for (let index = 0; index < samples; index += 1) {
          const event = new PointerEvent("pointerover", {
            bubbles: true,
            clientX: rect.left + 20,
            clientY: rect.top + rect.height / 2,
            pointerType: "mouse"
          });
          const startedAt = performance.now();
          row.dispatchEvent(event);
          durations.push(performance.now() - startedAt);
        }

        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

        const sorted = [...durations].sort((left, right) => left - right);
        const percentile = (ratio: number) =>
          sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
        const snapshot = await window.tabsOutlinerProfile?.snapshot();
        const summary = await window.tabsOutlinerProfile?.summary();
        const hoverEntries =
          snapshot?.sidebar.entries.filter((entry) => entry.name === "sidebar.hoverGuide") ?? [];

        return {
          samples,
          avgMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
          p50Ms: percentile(0.5),
          p95Ms: percentile(0.95),
          maxMs: sorted.at(-1) ?? 0,
          hoverGuide: summary?.find((row) => row.name === "sidebar.hoverGuide"),
          hoverEntries: hoverEntries.map((entry) => entry.detail)
        };
      },
      { samples: HOVER_SAMPLES, targetId: "window:1" }
    );

    await testInfo.attach("hover-guide-50k-profile.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json"
    });
    console.log(`hover-guide-50k ${JSON.stringify(result)}`);

    expect(result.p95Ms).toBeLessThan(4);
    expect(result.hoverGuide?.maxMs).toBeLessThan(8);
    expect(result.hoverEntries).toContainEqual(
      expect.objectContaining({
        skipped: true,
        skipReason: "large-subtree",
        subtreeRows: TAB_COUNT + 1
      })
    );
    expect(issues).toEqual([]);
  });

  test("clears large hover guides before scroll rendering", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const issues = collectPageIssues(page);

    await loadLargeSidebar(page, TAB_COUNT);
    await page.evaluate(async () => {
      await window.tabsOutlinerProfile?.enable();
      await window.tabsOutlinerProfile?.clear();
    });

    const result = await page.evaluate(async () => {
      const row = document.querySelector(
        `.node[data-node-id="${CSS.escape("window:1")}"] > .node-row`
      );
      const viewport = document.querySelector("main");
      if (!(row instanceof HTMLElement) || !(viewport instanceof HTMLElement)) {
        throw new Error("Missing sidebar row or viewport");
      }

      const rect = row.getBoundingClientRect();
      row.dispatchEvent(
        new PointerEvent("pointerover", {
          bubbles: true,
          clientX: rect.left + 20,
          clientY: rect.top + rect.height / 2,
          pointerType: "mouse"
        })
      );
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

      viewport.scrollTop = 4000;
      viewport.dispatchEvent(new Event("scroll"));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

      const snapshot = await window.tabsOutlinerProfile?.snapshot();
      const summary = await window.tabsOutlinerProfile?.summary();
      const hoverEntries =
        snapshot?.sidebar.entries.filter((entry) => entry.name === "sidebar.hoverGuide") ?? [];
      const virtualRows =
        snapshot?.sidebar.entries.filter((entry) => entry.name === "sidebar.virtualRows") ?? [];

      return {
        scrollTop: viewport.scrollTop,
        hoverGuide: summary?.find((row) => row.name === "sidebar.hoverGuide"),
        virtualRows: summary?.find((row) => row.name === "sidebar.virtualRows"),
        hoverEntries: hoverEntries.map((entry) => entry.detail),
        virtualRowsEntries: virtualRows.map((entry) => entry.detail)
      };
    });

    await testInfo.attach("hover-scroll-50k-profile.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json"
    });
    console.log(`hover-scroll-50k ${JSON.stringify(result)}`);

    expect(result.scrollTop).toBeGreaterThan(0);
    expect(result.hoverGuide?.maxMs).toBeLessThan(8);
    expect(result.virtualRows?.maxMs).toBeLessThan(16);
    expect(result.hoverEntries).toContainEqual(
      expect.objectContaining({
        reason: "scroll",
        skipped: true,
        skipReason: "clear"
      })
    );
    expect(result.virtualRowsEntries).toContainEqual(
      expect.objectContaining({
        hoverGuideActive: false
      })
    );
    expect(issues).toEqual([]);
  });

  test("profiles queued pointer, hover feedback, and scroll input delay", async ({
    page
  }, testInfo) => {
    test.setTimeout(90_000);
    const issues = collectPageIssues(page);

    await loadLargeSidebar(page, TAB_COUNT);
    await page.evaluate(async () => {
      await window.tabsOutlinerProfile?.enable();
      await window.tabsOutlinerProfile?.clear();
    });

    const result = await page.evaluate(async () => {
      const row = document.querySelector(
        `.node[data-node-id="${CSS.escape("tab:40")}"] > .node-row`
      );
      const viewport = document.querySelector("main");
      if (!(row instanceof HTMLElement) || !(viewport instanceof HTMLElement)) {
        throw new Error("Missing sidebar row or viewport");
      }

      const rect = row.getBoundingClientRect();
      const pointerEvent = new PointerEvent("pointerover", {
        bubbles: true,
        clientX: rect.left + 20,
        clientY: rect.top + rect.height / 2,
        pointerType: "mouse"
      });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 30));
      row.dispatchEvent(pointerEvent);

      const scrollEvent = new Event("scroll");
      await new Promise<void>((resolve) => window.setTimeout(resolve, 30));
      viewport.scrollTop = 600;
      viewport.dispatchEvent(scrollEvent);

      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

      const snapshot = await window.tabsOutlinerProfile?.snapshot();
      const summary = await window.tabsOutlinerProfile?.summary();
      const inputDelayEntries =
        snapshot?.sidebar.entries.filter((entry) => entry.name.startsWith("sidebar.input.")) ?? [];

      return {
        summary,
        inputDelayEntries
      };
    });

    await testInfo.attach("input-delay-profile.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json"
    });
    console.log(`input-delay-profile ${JSON.stringify(result)}`);

    expect(
      result.summary?.find((row) => row.name === "sidebar.input.pointerDelay")?.maxMs
    ).toBeGreaterThanOrEqual(15);
    expect(
      result.summary?.find((row) => row.name === "sidebar.input.hoverFeedbackDelay")?.maxMs
    ).toBeGreaterThanOrEqual(15);
    expect(
      result.summary?.find((row) => row.name === "sidebar.input.hoverFrameDelay")?.maxMs
    ).toBeGreaterThanOrEqual(15);
    expect(
      result.summary?.find((row) => row.name === "sidebar.input.scrollDelay")?.maxMs
    ).toBeGreaterThanOrEqual(15);
    expect(result.inputDelayEntries).toContainEqual(
      expect.objectContaining({
        name: "sidebar.input.pointerDelay",
        detail: expect.objectContaining({
          event: "pointerover",
          outcome: "hover-row"
        })
      })
    );
    expect(result.inputDelayEntries).toContainEqual(
      expect.objectContaining({
        name: "sidebar.input.hoverFeedbackDelay",
        detail: expect.objectContaining({
          event: "pointerover",
          outcome: "hover-row",
          reason: "pointer"
        })
      })
    );
    expect(result.inputDelayEntries).toContainEqual(
      expect.objectContaining({
        name: "sidebar.input.hoverFrameDelay",
        detail: expect.objectContaining({
          event: "pointerover",
          outcome: "hover-row",
          reason: "pointer"
        })
      })
    );
    expect(result.inputDelayEntries).toContainEqual(
      expect.objectContaining({
        name: "sidebar.input.scrollDelay",
        detail: expect.objectContaining({
          event: "scroll"
        })
      })
    );
    expect(issues).toEqual([]);
  });

  test("profiles dragover previews with 50,000 tabs", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const issues = collectPageIssues(page);

    await loadLargeSidebar(page, TAB_COUNT);
    await startDrag(page, "tab:1");

    const result = await page.evaluate(
      ({ samples, targetId }) => {
        const row = document.querySelector(
          `.node[data-node-id="${CSS.escape(targetId)}"] > .node-row`
        );
        if (!(row instanceof HTMLElement)) {
          throw new Error(`Missing target row for ${targetId}`);
        }

        const rect = row.getBoundingClientRect();
        const dataTransfer = new DataTransfer();
        const durations: number[] = [];
        for (let index = 0; index < samples; index += 1) {
          const event = new DragEvent("dragover", {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + 20,
            clientY: rect.bottom - 1,
            dataTransfer
          });
          const startedAt = performance.now();
          row.dispatchEvent(event);
          durations.push(performance.now() - startedAt);
        }

        const sorted = [...durations].sort((left, right) => left - right);
        const percentile = (ratio: number) =>
          sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
        const marker = document.querySelector<HTMLElement>("[data-testid='drop-marker']");
        const tree = document.querySelector<HTMLElement>("#tree");
        const rowHeight = Number.parseFloat(
          window.getComputedStyle(document.documentElement).getPropertyValue("--node-row-height")
        );

        return {
          samples,
          avgMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
          p50Ms: percentile(0.5),
          p95Ms: percentile(0.95),
          maxMs: sorted.at(-1) ?? 0,
          markerDepth: marker
            ? Number.parseInt(marker.style.getPropertyValue("--depth"), 10)
            : undefined,
          markerRowIndex:
            marker && tree
              ? Math.round(
                  (marker.getBoundingClientRect().top - tree.getBoundingClientRect().top) /
                    rowHeight
                )
              : undefined
        };
      },
      { samples: DRAGOVER_SAMPLES, targetId: "tab:40" }
    );

    await testInfo.attach("drag-drop-50k-profile.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json"
    });
    console.log(`drag-drop-50k ${JSON.stringify(result)}`);

    expect(result.markerDepth).toBe(1);
    expect(result.markerRowIndex).toBe(41);
    expect(result.avgMs).toBeLessThan(4);
    expect(result.p95Ms).toBeLessThan(8);
    expect(issues).toEqual([]);
  });

  test("profiles a same-window leaf drop with 50,000 tabs", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const issues = collectPageIssues(page);

    await loadLargeSidebar(page, TAB_COUNT);
    await page.evaluate(async () => {
      await window.tabsOutlinerProfile?.enable();
      await window.tabsOutlinerProfile?.clear();
    });
    await startDrag(page, "tab:40");

    const totalStartedAt = await page.evaluate(() => performance.now());
    await dragOverBefore(page, "tab:1");
    const dropClientY = await rowClientY(page, "tab:1", "before");
    const result = await page.locator(nodeRowSelector("tab:1")).evaluate(
      async (row, { clientY, totalStart }) => {
        const movedNode = document.querySelector<HTMLElement>(".node[data-node-id='tab:40']");
        if (!movedNode) {
          throw new Error("Missing moved row for tab:40");
        }

        const rowIndexIsUpdated = () => movedNode.getAttribute("data-row-index") === "1";
        const waitForVisibleUpdate = async (): Promise<number> => {
          if (rowIndexIsUpdated()) {
            return performance.now();
          }
          await new Promise<void>((resolve, reject) => {
            const observer = new MutationObserver(() => {
              if (rowIndexIsUpdated()) {
                window.clearTimeout(timeout);
                observer.disconnect();
                resolve();
              }
            });
            const timeout = window.setTimeout(() => {
              observer.disconnect();
              reject(
                new Error("Timed out waiting for dropped row to become visible at row index 1")
              );
            }, 5000);
            observer.observe(document.body, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ["data-row-index"]
            });
          });
          return performance.now();
        };

        const dropStart = performance.now();
        row.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            clientY,
            dataTransfer: new DataTransfer()
          })
        );
        const finishedAt = await waitForVisibleUpdate();
        const profile = (window as typeof window & { __lastMoveProfile?: unknown })
          .__lastMoveProfile;
        const summary = await window.tabsOutlinerProfile?.summary();
        return {
          elapsedMs: finishedAt - totalStart,
          dragoverSetupMs: dropStart - totalStart,
          dropDispatchToVisibleMs: finishedAt - dropStart,
          profile,
          summary
        };
      },
      { clientY: dropClientY, totalStart: totalStartedAt }
    );
    await expect(page.locator(".node[data-node-id='tab\\:40']")).toHaveAttribute(
      "data-row-index",
      "1"
    );

    await testInfo.attach("drag-drop-50k-drop-profile.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json"
    });
    console.log(`drag-drop-50k-drop ${JSON.stringify(result)}`);

    const treePatch = result.summary?.find((row) => row.name === "sidebar.patch.treeStructure");
    const projectionBuild = result.summary?.find((row) => row.name === "sidebar.projection.build");
    const virtualRows = result.summary?.find((row) => row.name === "sidebar.virtualRows");
    expect(result.dropDispatchToVisibleMs).toBeLessThan(90);
    expect(treePatch?.totalMs).toBeLessThan(12);
    expect(virtualRows?.totalMs).toBeLessThan(16);
    expect(projectionBuild).toBeUndefined();
    expect(issues).toEqual([]);
  });
});

async function loadLargeSidebar(page: Page, tabCount: number): Promise<void> {
  await page.addInitScript((count) => {
    const now = 1_700_000_000_000;
    const childIds = Array.from({ length: count }, (_value, index) => `tab:${index + 1}`);
    const state = {
      version: 1,
      rootIds: ["window:1"],
      nodes: {
        "window:1": {
          id: "window:1",
          kind: "window",
          status: "live",
          title: "Window",
          childIds,
          collapsed: false,
          createdAt: now,
          updatedAt: now,
          active: true,
          live: { windowId: 1 }
        },
        ...Object.fromEntries(
          childIds.map((id, index) => [
            id,
            {
              id,
              kind: "tab",
              status: "live",
              parentId: "window:1",
              title: `Tab ${index + 1}`,
              url: `https://drag.example/${index + 1}`,
              childIds: [],
              collapsed: false,
              createdAt: now,
              updatedAt: now,
              active: index === 0,
              live: { tabId: index + 1, windowId: 1 }
            }
          ])
        )
      }
    };

    const listeners: Array<(message: unknown) => void> = [];
    window.browser = {
      runtime: {
        sendMessage: async (message: unknown) => {
          const type =
            typeof message === "object" && message
              ? (message as { type?: unknown }).type
              : undefined;
          if (type === "getState") {
            return structuredClone(state);
          }
          if (type === "getDiagnostics") {
            return {
              runtimeTabCount: count,
              liveTabNodeCount: count,
              visibleLiveTabNodeCount: count,
              hiddenLiveTabNodeCount: 0,
              missingRuntimeTabIds: []
            };
          }
          if (type === "getPerformanceTrace") {
            return undefined;
          }
          if (type === "setPerformanceTraceEnabled" || type === "clearPerformanceTrace") {
            return undefined;
          }
          if (type === "moveNode") {
            const command = message as { nodeId: string; parentId?: string; index: number };
            const startedAt = performance.now();
            const node = state.nodes[command.nodeId];
            const oldParent = node?.parentId ? state.nodes[node.parentId] : undefined;
            const newParent = command.parentId ? state.nodes[command.parentId] : undefined;
            if (!node || !oldParent || !newParent) {
              return { type: "commandAck", stateChanged: false };
            }

            const sourceIndex = oldParent.childIds.indexOf(command.nodeId);
            if (sourceIndex >= 0) {
              oldParent.childIds.splice(sourceIndex, 1);
            }
            const boundedIndex = Math.max(0, Math.min(command.index, newParent.childIds.length));
            newParent.childIds.splice(boundedIndex, 0, command.nodeId);
            node.parentId = command.parentId;

            const update =
              oldParent.id === newParent.id
                ? {
                    type: "sameParentReorderUpdated",
                    parentId: newParent.id,
                    movedNodeId: command.nodeId,
                    fromIndex: sourceIndex,
                    toIndex: boundedIndex,
                    rootIds: [...state.rootIds]
                  }
                : {
                    type: "treeStructureUpdated",
                    deletedNodeIds: [],
                    updatedNodes: [
                      structuredClone(oldParent),
                      structuredClone(newParent),
                      structuredClone(node)
                    ],
                    rootIds: [...state.rootIds],
                    deletedClosedCount: 0
                  };
            for (const listener of listeners) {
              listener(structuredClone(update));
            }
            (window as typeof window & { __lastMoveProfile?: unknown }).__lastMoveProfile = {
              commandMs: performance.now() - startedAt,
              updatedNodes:
                "updatedNodes" in update
                  ? update.updatedNodes.map((updatedNode) => updatedNode.id)
                  : []
            };
            return { type: "commandAck", stateChanged: true };
          }
          return { ok: true };
        },
        onMessage: {
          addListener: (listener: (message: unknown) => void) => {
            listeners.push(listener);
          }
        }
      },
      storage: {
        local: {
          get: async () => ({}),
          set: async () => undefined
        }
      }
    };
  }, tabCount);

  await page.goto("/sidebar/sidebar.html");
  await expect(page.locator("#state-count")).toHaveText(`${tabCount + 1} items / 0 saved`, {
    timeout: 60_000
  });
  await expect(page.locator(nodeRowSelector("tab:40"))).toBeVisible();
}

async function startDrag(page: Page, sourceId: string): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await page.locator(nodeRowSelector(sourceId)).dispatchEvent("dragstart", {
    bubbles: true,
    cancelable: true,
    dataTransfer
  });
}

async function dragOverBefore(page: Page, targetId: string): Promise<void> {
  await page.locator(nodeRowSelector(targetId)).dispatchEvent("dragover", {
    bubbles: true,
    cancelable: true,
    clientY: await rowClientY(page, targetId, "before")
  });
}

async function rowClientY(page: Page, nodeId: string, mode: "before" | "after"): Promise<number> {
  return page.locator(nodeRowSelector(nodeId)).evaluate((row, pointerMode) => {
    const rect = row.getBoundingClientRect();
    return pointerMode === "before" ? rect.top + 1 : rect.bottom - 1;
  }, mode);
}

function nodeRowSelector(nodeId: string): string {
  return `.node[data-node-id='${cssString(nodeId)}'] > .node-row`;
}

function cssString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
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
    issues.push({
      kind: "requestfailed",
      text: `${request.url()} ${request.failure()?.errorText ?? ""}`
    });
  });
  return issues;
}
