import { expect, test, type Page } from "@playwright/test";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

test.describe("sidebar first paint", () => {
  test("paints the initial sparse snapshot without full hydration", async ({ page }) => {
    const issues = collectPageIssues(page);
    await page.addInitScript((snapshot) => {
      const messages: Array<{ type: string; at: number }> = [];
      (
        window as typeof window & { __sidebarBootMessages?: typeof messages }
      ).__sidebarBootMessages = messages;
      window.browser = {
        runtime: {
          sendMessage: async (message: unknown) => {
            const type =
              typeof message === "object" && message
                ? String((message as { type?: unknown }).type)
                : "";
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
    await expect(page.locator("#state-count")).toHaveText("50001 items / 50000 open");

    const metrics = await page.evaluate(() => {
      const messages =
        (window as typeof window & { __sidebarBootMessages?: Array<{ type: string; at: number }> })
          .__sidebarBootMessages ?? [];
      const firstRowsAt = performance
        .getEntriesByName("tabs-outliner.boot.firstRows")
        .at(-1)?.startTime;
      const firstHydrationAt = messages.find((message) => message.type === "getState")?.at;
      return {
        firstRowsAt,
        firstHydrationAt,
        initialSnapshotRequests: messages.filter(
          (message) => message.type === "getInitialTreeSnapshot"
        ).length,
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

  test("does not reveal a top slice before hydration when the snapshot misses the active tab", async ({
    page
  }) => {
    const issues = collectPageIssues(page);
    await page.addInitScript(
      ({ snapshot, fullState }) => {
        const messages: Array<{ type: string; at: number }> = [];
        let resolveGetState: ((state: unknown) => void) | undefined;
        Object.assign(
          window as typeof window & {
            __sidebarBootMessages?: typeof messages;
            __resolveSidebarGetState?: () => void;
          },
          {
            __sidebarBootMessages: messages,
            __resolveSidebarGetState: () => resolveGetState?.(structuredClone(fullState))
          }
        );
        window.browser = {
          runtime: {
            sendMessage: async (message: unknown) => {
              const type =
                typeof message === "object" && message
                  ? String((message as { type?: unknown }).type)
                  : "";
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
      },
      {
        snapshot: fixtureInitialSnapshot(500, { activeTabInSnapshot: false }),
        fullState: fixtureFullState(500, 400)
      }
    );

    await page.goto("/sidebar/sidebar.html");
    await page.waitForFunction(() => {
      const messages =
        (window as typeof window & { __sidebarBootMessages?: Array<{ type: string }> })
          .__sidebarBootMessages ?? [];
      return messages.some((message) => message.type === "getState");
    });
    await expect(page.locator("body")).toHaveAttribute("data-sidebar-booting", "");
    await expect(page.getByRole("treeitem")).toHaveCount(0);

    await page.evaluate(() => {
      (
        window as typeof window & { __resolveSidebarGetState?: () => void }
      ).__resolveSidebarGetState?.();
    });

    await expect(page.locator(".node[data-node-id='tab:400'].is-active")).toBeVisible();
    await expect(page.locator("body")).not.toHaveAttribute("data-sidebar-booting", "");
    expect(issues).toEqual([]);
  });

  test("paints an active-centered sparse snapshot without full hydration", async ({ page }) => {
    const issues = collectPageIssues(page);
    await page.addInitScript(
      (snapshot) => {
        const messages: Array<{ type: string; at: number }> = [];
        (
          window as typeof window & { __sidebarBootMessages?: typeof messages }
        ).__sidebarBootMessages = messages;
        window.browser = {
          runtime: {
            sendMessage: async (message: unknown) => {
              const type =
                typeof message === "object" && message
                  ? String((message as { type?: unknown }).type)
                  : "";
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
      },
      fixtureActiveCenteredSnapshot(500, 400)
    );

    await page.goto("/sidebar/sidebar.html");
    await expect(page.locator(".node[data-node-id='tab:400'].is-active")).toBeVisible();

    const metrics = await page.evaluate(() => {
      const messages =
        (window as typeof window & { __sidebarBootMessages?: Array<{ type: string; at: number }> })
          .__sidebarBootMessages ?? [];
      return {
        hydrationRequests: messages.filter((message) => message.type === "getState").length,
        scrollTop: document.querySelector("main")?.scrollTop ?? 0,
        treeHeight: Number.parseFloat(
          (document.querySelector<HTMLElement>("#tree")?.style.height ?? "0").replace("px", "")
        )
      };
    });

    expect(metrics.hydrationRequests).toBe(0);
    expect(metrics.scrollTop).toBeGreaterThan(5000);
    expect(metrics.treeHeight).toBeGreaterThan(9000);
    expect(issues).toEqual([]);
  });

  test("replaces a stale boot snapshot with background truth without user interaction", async ({
    page
  }) => {
    const issues = collectPageIssues(page);
    await page.addInitScript(
      ({ snapshot, fullState }) => {
        const messages: Array<{ type: string; at: number }> = [];
        (
          window as typeof window & { __sidebarBootMessages?: typeof messages }
        ).__sidebarBootMessages = messages;
        window.browser = {
          runtime: {
            sendMessage: async (message: unknown) => {
              const type =
                typeof message === "object" && message
                  ? String((message as { type?: unknown }).type)
                  : "";
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
            }
          },
          storage: {
            local: {
              get: async () => ({}),
              set: async () => undefined
            }
          }
        };
      },
      {
        // The boot snapshot still contains tab:99, whose journaled delete the stored
        // snapshot missed (the background serves it while its own startup load runs).
        snapshot: fixtureStaleBootSnapshot(),
        fullState: fixtureFullState(3, 1)
      }
    );

    await page.goto("/sidebar/sidebar.html");
    // Stale paint first: the phantom node is visible without any interaction...
    await expect(page.locator(".node[data-node-id='tab:99']")).toBeVisible();
    // ...and the scheduled hydration replaces it with background truth, still without
    // any interaction (no hover, click, or broadcast).
    await expect(page.locator(".node[data-node-id='tab:99']")).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator(".node[data-node-id='tab:3']")).toBeVisible();

    const hydrationRequests = await page.evaluate(
      () =>
        (
          (window as typeof window & { __sidebarBootMessages?: Array<{ type: string }> })
            .__sidebarBootMessages ?? []
        ).filter((message) => message.type === "getState").length
    );
    expect(hydrationRequests).toBeGreaterThanOrEqual(1);
    expect(issues).toEqual([]);
  });

  test("exports and imports through the background when a sparse snapshot omits collapsed descendants", async ({
    page
  }) => {
    const issues = collectPageIssues(page);
    await page.addInitScript(
      ({ snapshot, fullState, searchSnapshot }) => {
        const messages: Array<{ type: string; at: number; query?: string }> = [];
        let resolveGetState: ((state: unknown) => void) | undefined;
        Object.assign(
          window as typeof window & {
            __sidebarBootMessages?: typeof messages;
            __resolveSidebarGetState?: () => void;
            __lastSidebarDownload?: { filename: string; href: string };
            __lastSidebarImport?: unknown;
            __sidebarSearchSnapshot?: unknown;
          },
          {
            __sidebarBootMessages: messages,
            __resolveSidebarGetState: () => resolveGetState?.(structuredClone(fullState)),
            __sidebarSearchSnapshot: searchSnapshot
          }
        );
        const originalAnchorClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function click() {
          if (this.download) {
            (
              window as typeof window & {
                __lastSidebarDownload?: { filename: string; href: string };
              }
            ).__lastSidebarDownload = { filename: this.download, href: this.href };
            return;
          }
          return originalAnchorClick.call(this);
        };
        window.browser = {
          runtime: {
            sendMessage: async (message: unknown) => {
              const type =
                typeof message === "object" && message
                  ? String((message as { type?: unknown }).type)
                  : "";
              const query =
                typeof message === "object" &&
                message &&
                typeof (message as { query?: unknown }).query === "string"
                  ? (message as { query: string }).query
                  : undefined;
              messages.push({
                type,
                at: performance.now(),
                ...(query !== undefined ? { query } : {})
              });
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
                  content:
                    '{"schema":"tabs-outliner-tree","version":1,"exportedAt":"2026-05-26T00:00:00.000Z","roots":[]}\n'
                };
              }
              if (type === "importTree") {
                (window as typeof window & { __lastSidebarImport?: unknown }).__lastSidebarImport =
                  (message as { tree?: unknown }).tree;
                return { ok: true };
              }
              if (
                type === "getTreeProjectionSlice" &&
                (message as { query?: unknown }).query === "hidden 42"
              ) {
                return structuredClone(
                  (window as typeof window & { __sidebarSearchSnapshot?: unknown })
                    .__sidebarSearchSnapshot
                );
              }
              if (
                type === "getTreeProjectionSlice" &&
                (message as { query?: unknown }).query === undefined
              ) {
                return structuredClone(snapshot);
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
      },
      {
        snapshot: fixtureCollapsedPartialSnapshot(100),
        fullState: fixtureCollapsedFullState(100),
        searchSnapshot: fixtureCollapsedSearchSnapshot(100, 42)
      }
    );

    await page.goto("/sidebar/sidebar.html");
    await expect(page.locator(".node[data-node-id='group:hidden']")).toBeVisible();
    await expect(page.locator("#state-count")).toHaveText("103 items / 1 open");
    await expect(page.locator("#export-tree")).toBeHidden();
    await expect(page.locator("#import-tree")).toBeHidden();
    await openToolbarOverflow(page);
    await expect(page.locator("#export-tree")).toBeEnabled();
    await expect(page.locator("#import-tree")).toBeEnabled();
    await page.locator("#export-tree").click();
    await page.waitForFunction(() => {
      const messages =
        (window as typeof window & { __sidebarBootMessages?: Array<{ type: string }> })
          .__sidebarBootMessages ?? [];
      return messages.some((message) => message.type === "exportTree");
    });

    const exportMetrics = await page.evaluate(() => {
      const messages =
        (window as typeof window & { __sidebarBootMessages?: Array<{ type: string }> })
          .__sidebarBootMessages ?? [];
      const download = (
        window as typeof window & {
          __lastSidebarDownload?: { filename: string; href: string };
        }
      ).__lastSidebarDownload;
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

    const importedTree = {
      schema: "tabs-outliner-tree",
      version: 1,
      exportedAt: "2026-05-26T00:00:00.000Z",
      roots: [
        {
          kind: "window",
          title: "Imported Window",
          children: [
            {
              kind: "tab",
              title: "Imported Tab",
              url: "https://imported.example/"
            }
          ]
        }
      ]
    };
    await page.locator("#import-tree-file").setInputFiles({
      name: "tabs-outliner-tree.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(importedTree))
    });
    await page.waitForFunction(() => {
      const messages =
        (window as typeof window & { __sidebarBootMessages?: Array<{ type: string }> })
          .__sidebarBootMessages ?? [];
      return messages.some((message) => message.type === "importTree");
    });

    const importMetrics = await page.evaluate(() => {
      const messages =
        (window as typeof window & { __sidebarBootMessages?: Array<{ type: string }> })
          .__sidebarBootMessages ?? [];
      const imported = (
        window as typeof window & {
          __lastSidebarImport?: {
            roots?: Array<{ title?: string; children?: Array<{ title?: string }> }>;
          };
        }
      ).__lastSidebarImport;
      return {
        importRequests: messages.filter((message) => message.type === "importTree").length,
        hydrationRequests: messages.filter((message) => message.type === "getState").length,
        importRootTitle: imported?.roots?.[0]?.title,
        importTabTitle: imported?.roots?.[0]?.children?.[0]?.title
      };
    });
    expect(importMetrics).toEqual({
      importRequests: 1,
      hydrationRequests: 0,
      importRootTitle: "Imported Window",
      importTabTitle: "Imported Tab"
    });

    await expect(page.locator("#search")).toBeEnabled();
    await page.locator("#search").fill("hidden 42");
    await page.waitForFunction(() => {
      const messages =
        (
          window as typeof window & {
            __sidebarBootMessages?: Array<{ type: string; query?: string }>;
          }
        ).__sidebarBootMessages ?? [];
      return messages.some(
        (message) => message.type === "getTreeProjectionSlice" && message.query === "hidden 42"
      );
    });
    await expect(page.locator(".node[data-node-id='hidden:42']")).toBeVisible();
    await expect(page.locator("#state-count")).toHaveText("1 match / 103 items");

    const searchMetrics = await page.evaluate(() => {
      const messages =
        (
          window as typeof window & {
            __sidebarBootMessages?: Array<{ type: string; query?: string }>;
          }
        ).__sidebarBootMessages ?? [];
      return {
        searchRequests: messages.filter(
          (message) => message.type === "getTreeProjectionSlice" && message.query === "hidden 42"
        ).length,
        hydrationRequests: messages.filter((message) => message.type === "getState").length
      };
    });
    expect(searchMetrics).toEqual({
      searchRequests: 1,
      hydrationRequests: 0
    });

    await page.locator("#clear-search").click();
    await page.waitForFunction(() => {
      const messages =
        (
          window as typeof window & {
            __sidebarBootMessages?: Array<{ type: string; query?: string }>;
          }
        ).__sidebarBootMessages ?? [];
      return messages.some(
        (message) => message.type === "getTreeProjectionSlice" && message.query === undefined
      );
    });
    await expect(page.locator("#search")).toHaveValue("");
    await expect(page.locator(".node[data-node-id='tab:1']")).toBeVisible();
    await expect(page.locator(".node[data-node-id='group:hidden']")).toBeVisible();
    await expect(page.locator(".node[data-node-id='hidden:42']")).toHaveCount(0);
    await expect(page.locator("#state-count")).toHaveText("103 items / 1 open");

    const clearMetrics = await page.evaluate(() => {
      const messages =
        (
          window as typeof window & {
            __sidebarBootMessages?: Array<{ type: string; query?: string }>;
          }
        ).__sidebarBootMessages ?? [];
      return {
        clearRequests: messages.filter(
          (message) => message.type === "getTreeProjectionSlice" && message.query === undefined
        ).length,
        hydrationRequests: messages.filter((message) => message.type === "getState").length
      };
    });
    expect(clearMetrics).toEqual({
      clearRequests: 1,
      hydrationRequests: 0
    });
    await page.waitForTimeout(900);

    const beforeHydration = await page.evaluate(() => {
      const messages =
        (window as typeof window & { __sidebarBootMessages?: Array<{ type: string }> })
          .__sidebarBootMessages ?? [];
      return {
        hydrationRequests: messages.filter((message) => message.type === "getState").length
      };
    });
    expect(beforeHydration.hydrationRequests).toBe(0);
    await openToolbarOverflow(page);
    await expect(page.locator("#export-tree")).toBeEnabled();
    await expect(page.locator("#import-tree")).toBeEnabled();
    expect(issues).toEqual([]);
  });

  test("coalesces sparse remote search typing to the final query", async ({ page }) => {
    const issues = collectPageIssues(page);
    await page.addInitScript(
      ({ snapshot, searchSnapshot }) => {
        const messages: Array<{ type: string; at: number; query?: string }> = [];
        Object.assign(
          window as typeof window & {
            __sidebarBootMessages?: typeof messages;
            __sidebarSearchSnapshot?: unknown;
          },
          {
            __sidebarBootMessages: messages,
            __sidebarSearchSnapshot: searchSnapshot
          }
        );
        window.browser = {
          runtime: {
            sendMessage: async (message: unknown) => {
              const type =
                typeof message === "object" && message
                  ? String((message as { type?: unknown }).type)
                  : "";
              const query =
                typeof message === "object" &&
                message &&
                typeof (message as { query?: unknown }).query === "string"
                  ? (message as { query: string }).query
                  : undefined;
              messages.push({
                type,
                at: performance.now(),
                ...(query !== undefined ? { query } : {})
              });
              if (type === "getInitialTreeSnapshot") {
                return structuredClone(snapshot);
              }
              if (type === "getState") {
                return new Promise(() => undefined);
              }
              if (type === "getTreeProjectionSlice" && query === "hidden 42") {
                return structuredClone(
                  (window as typeof window & { __sidebarSearchSnapshot?: unknown })
                    .__sidebarSearchSnapshot
                );
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
      },
      {
        snapshot: fixtureCollapsedPartialSnapshot(100),
        searchSnapshot: fixtureCollapsedSearchSnapshot(100, 42)
      }
    );

    await page.goto("/sidebar/sidebar.html");
    await expect(page.locator("#search")).toBeEnabled();
    await expect(page.locator(".node[data-node-id='group:hidden']")).toBeVisible();
    await page.locator("#search").evaluate((element, query) => {
      const input = element as HTMLInputElement;
      input.focus();
      input.value = "";
      for (const character of query) {
        input.value += character;
        input.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: character
          })
        );
      }
    }, "hidden 42");
    await page.waitForFunction(() => {
      const messages =
        (
          window as typeof window & {
            __sidebarBootMessages?: Array<{ type: string; query?: string }>;
          }
        ).__sidebarBootMessages ?? [];
      return messages.some(
        (message) => message.type === "getTreeProjectionSlice" && message.query === "hidden 42"
      );
    });
    await expect(page.locator(".node[data-node-id='hidden:42']")).toBeVisible();

    const metrics = await page.evaluate(() => {
      const messages =
        (
          window as typeof window & {
            __sidebarBootMessages?: Array<{ type: string; query?: string }>;
          }
        ).__sidebarBootMessages ?? [];
      return {
        searchQueries: messages
          .filter(
            (message) => message.type === "getTreeProjectionSlice" && message.query !== undefined
          )
          .map((message) => message.query),
        hydrationRequests: messages.filter((message) => message.type === "getState").length
      };
    });

    expect(metrics).toEqual({
      searchQueries: ["hidden 42"],
      hydrationRequests: 0
    });
    expect(issues).toEqual([]);
  });

  test("clears sparse remote search through the background after sparse merges know every node id", async ({
    page
  }) => {
    const issues = collectPageIssues(page);
    await page.addInitScript(
      ({ snapshot, searchSnapshot }) => {
        const messages: Array<{ type: string; at: number; query?: string }> = [];
        Object.assign(
          window as typeof window & {
            __sidebarBootMessages?: typeof messages;
            __sidebarSearchSnapshot?: unknown;
          },
          {
            __sidebarBootMessages: messages,
            __sidebarSearchSnapshot: searchSnapshot
          }
        );
        window.browser = {
          runtime: {
            sendMessage: async (message: unknown) => {
              const type =
                typeof message === "object" && message
                  ? String((message as { type?: unknown }).type)
                  : "";
              const query =
                typeof message === "object" &&
                message &&
                typeof (message as { query?: unknown }).query === "string"
                  ? (message as { query: string }).query
                  : undefined;
              messages.push({
                type,
                at: performance.now(),
                ...(query !== undefined ? { query } : {})
              });
              if (type === "getInitialTreeSnapshot") {
                return structuredClone(snapshot);
              }
              if (type === "getState") {
                return new Promise(() => undefined);
              }
              if (type === "getTreeProjectionSlice" && query === "hidden 1") {
                return structuredClone(
                  (window as typeof window & { __sidebarSearchSnapshot?: unknown })
                    .__sidebarSearchSnapshot
                );
              }
              if (type === "getTreeProjectionSlice" && query === undefined) {
                return structuredClone(snapshot);
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
      },
      {
        snapshot: fixtureCollapsedPartialSnapshot(1),
        searchSnapshot: fixtureCollapsedSearchSnapshot(1, 1)
      }
    );

    let releaseSidebarImport: () => void = () => undefined;
    const sidebarImportRelease = new Promise<void>((resolve) => {
      releaseSidebarImport = resolve;
    });
    let resolveSidebarImportPaused: () => void = () => undefined;
    const sidebarImportPaused = new Promise<void>((resolve) => {
      resolveSidebarImportPaused = resolve;
    });
    await page.route("**/sidebar/sidebar.js", async (route) => {
      resolveSidebarImportPaused();
      await sidebarImportRelease;
      await route.continue();
    });

    await page.goto("/sidebar/sidebar.html");
    await expect(page.locator("#search")).toBeEnabled();
    await expect(page.locator(".node[data-node-id='group:hidden']")).toBeVisible();
    await sidebarImportPaused;
    await page.locator("#search").fill("hidden 1");
    releaseSidebarImport();
    await page.waitForFunction(
      () => performance.getEntriesByName("tabs-outliner.boot.fullAppImport.end").length > 0
    );
    await page.waitForFunction(() => {
      const messages =
        (
          window as typeof window & {
            __sidebarBootMessages?: Array<{ type: string; query?: string }>;
          }
        ).__sidebarBootMessages ?? [];
      return messages.some(
        (message) => message.type === "getTreeProjectionSlice" && message.query === "hidden 1"
      );
    });
    await expect(page.locator(".node[data-node-id='hidden\\:1']")).toBeVisible();

    await page.locator("#clear-search").click();
    await page.waitForFunction(() => {
      const messages =
        (
          window as typeof window & {
            __sidebarBootMessages?: Array<{ type: string; query?: string }>;
          }
        ).__sidebarBootMessages ?? [];
      return messages.some(
        (message) => message.type === "getTreeProjectionSlice" && message.query === undefined
      );
    });
    await expect(page.locator("#search")).toHaveValue("");
    await expect(page.locator(".node[data-node-id='tab\\:1']")).toBeVisible();
    await expect(page.locator("#state-count")).toHaveText("4 items / 1 open");

    const metrics = await page.evaluate(() => {
      const messages =
        (
          window as typeof window & {
            __sidebarBootMessages?: Array<{ type: string; query?: string }>;
          }
        ).__sidebarBootMessages ?? [];
      return {
        clearRequests: messages.filter(
          (message) => message.type === "getTreeProjectionSlice" && message.query === undefined
        ).length,
        hydrationRequests: messages.filter((message) => message.type === "getState").length
      };
    });

    expect(metrics).toEqual({
      clearRequests: 1,
      hydrationRequests: 0
    });
    expect(issues).toEqual([]);
  });

  test("refreshes sparse projection through the background after undo before full hydration", async ({
    page
  }) => {
    const issues = collectPageIssues(page);
    await page.addInitScript(
      ({ snapshot, refreshedSnapshot, undoUpdate }) => {
        const messages: Array<{ type: string; at: number; centerRowIndex?: number }> = [];
        const listeners: Array<(message: unknown) => void> = [];
        Object.assign(
          window as typeof window & {
            __sidebarBootMessages?: typeof messages;
          },
          {
            __sidebarBootMessages: messages
          }
        );
        window.browser = {
          runtime: {
            sendMessage: async (message: unknown) => {
              const type =
                typeof message === "object" && message
                  ? String((message as { type?: unknown }).type)
                  : "";
              const centerRowIndex =
                typeof message === "object" &&
                message &&
                typeof (message as { centerRowIndex?: unknown }).centerRowIndex === "number"
                  ? (message as { centerRowIndex: number }).centerRowIndex
                  : undefined;
              messages.push({
                type,
                at: performance.now(),
                ...(centerRowIndex !== undefined ? { centerRowIndex } : {})
              });
              if (type === "getInitialTreeSnapshot") {
                return structuredClone(snapshot);
              }
              if (type === "getHistoryStatus") {
                return {
                  type: "historyStatus",
                  canUndo: true,
                  canRedo: false,
                  undoDepth: 1,
                  redoDepth: 0,
                  undoLabel: "Move"
                };
              }
              if (type === "undo") {
                window.queueMicrotask(() => {
                  for (const listener of listeners) {
                    listener(structuredClone(undoUpdate));
                  }
                });
                return { type: "commandAck", stateChanged: true };
              }
              if (type === "getTreeProjectionSlice") {
                return structuredClone(refreshedSnapshot);
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
      },
      {
        snapshot: fixtureInitialSnapshot(1_000),
        refreshedSnapshot: fixtureInitialSnapshot(1_000),
        undoUpdate: fixtureSparseUnsafeUndoUpdate()
      }
    );

    await page.goto("/sidebar/sidebar.html");
    await expect(page.locator(".node[data-node-id='tab\\:1']")).toBeVisible();
    await expect(page.locator("#undo-history")).toBeEnabled();

    await page.locator("#undo-history").click();
    await page.waitForFunction(() => {
      const messages =
        (
          window as typeof window & {
            __sidebarBootMessages?: Array<{ type: string }>;
          }
        ).__sidebarBootMessages ?? [];
      return messages.some((message) => message.type === "getTreeProjectionSlice");
    });

    await expect(page.locator("#state-count")).toHaveText("1001 items / 1000 open");
    await expect(page.locator(".node")).toHaveCount(256);

    const metrics = await page.evaluate(() => {
      const messages =
        (
          window as typeof window & {
            __sidebarBootMessages?: Array<{ type: string }>;
          }
        ).__sidebarBootMessages ?? [];
      return {
        undoRequests: messages.filter((message) => message.type === "undo").length,
        projectionRequests: messages.filter((message) => message.type === "getTreeProjectionSlice")
          .length,
        hydrationRequests: messages.filter((message) => message.type === "getState").length
      };
    });

    expect(metrics).toEqual({
      undoRequests: 1,
      projectionRequests: 1,
      hydrationRequests: 0
    });
    expect(issues).toEqual([]);
  });

  test("refreshes sparse remote search when background updates arrive for the same query", async ({
    page
  }) => {
    const issues = collectPageIssues(page);
    await page.addInitScript(
      ({ snapshot, searchSnapshots }) => {
        const messages: Array<{ type: string; at: number; query?: string }> = [];
        const listeners: Array<(message: unknown) => void> = [];
        const pendingSearchSnapshots = [...searchSnapshots];
        Object.assign(
          window as typeof window & {
            __sidebarBootMessages?: typeof messages;
            __emitSidebarMessage?: (message: unknown) => void;
          },
          {
            __sidebarBootMessages: messages,
            __emitSidebarMessage: (message: unknown) => {
              for (const listener of listeners) {
                listener(structuredClone(message));
              }
            }
          }
        );
        window.browser = {
          runtime: {
            sendMessage: async (message: unknown) => {
              const type =
                typeof message === "object" && message
                  ? String((message as { type?: unknown }).type)
                  : "";
              const query =
                typeof message === "object" &&
                message &&
                typeof (message as { query?: unknown }).query === "string"
                  ? (message as { query: string }).query
                  : undefined;
              messages.push({
                type,
                at: performance.now(),
                ...(query !== undefined ? { query } : {})
              });
              if (type === "getInitialTreeSnapshot") {
                return structuredClone(snapshot);
              }
              if (type === "getState") {
                return new Promise(() => undefined);
              }
              if (type === "getTreeProjectionSlice" && query === "hidden 42") {
                return structuredClone(
                  pendingSearchSnapshots.shift() ?? pendingSearchSnapshots.at(-1)
                );
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
      },
      {
        snapshot: fixtureCollapsedPartialSnapshot(100),
        searchSnapshots: [
          fixtureSparseSearchWindowSnapshot("hidden 42", 320, 32, 500),
          fixtureCollapsedSearchSnapshot(100, 42, { totalRowCount: 500 })
        ]
      }
    );

    await page.goto("/sidebar/sidebar.html");
    await expect(page.locator("#search")).toBeEnabled();
    await expect(page.locator(".node[data-node-id='group:hidden']")).toBeVisible();
    await page.locator("#search").evaluate((element, query) => {
      const input = element as HTMLInputElement;
      input.focus();
      input.value = query;
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: query
        })
      );
    }, "hidden 42");
    await page.waitForFunction(() => {
      const messages =
        (
          window as typeof window & {
            __sidebarBootMessages?: Array<{ type: string; query?: string }>;
          }
        ).__sidebarBootMessages ?? [];
      return (
        messages.filter(
          (message) => message.type === "getTreeProjectionSlice" && message.query === "hidden 42"
        ).length >= 1
      );
    });
    await expect(page.locator(".node[data-node-id='hidden:42']")).toHaveCount(0);
    await page.locator("main").evaluate((element) => {
      element.scrollTop = 320 * 18;
    });

    const firstSearchRequestCount = await sparseSearchRequestCount(page, "hidden 42");

    await page.evaluate((node) => {
      (
        window as typeof window & { __emitSidebarMessage?: (message: unknown) => void }
      ).__emitSidebarMessage?.({
        type: "nodeStateUpdated",
        updatedNodes: [node],
        liveTabCountDelta: 0
      });
    }, hiddenTabNode(42));

    await page.waitForFunction((previousCount) => {
      const messages =
        (
          window as typeof window & {
            __sidebarBootMessages?: Array<{ type: string; query?: string }>;
          }
        ).__sidebarBootMessages ?? [];
      return (
        messages.filter(
          (message) => message.type === "getTreeProjectionSlice" && message.query === "hidden 42"
        ).length > previousCount
      );
    }, firstSearchRequestCount);
    await expect(page.locator(".node[data-node-id='hidden:42']")).toBeInViewport();

    const metrics = await page.evaluate(() => {
      const messages =
        (
          window as typeof window & {
            __sidebarBootMessages?: Array<{ type: string; query?: string }>;
          }
        ).__sidebarBootMessages ?? [];
      return {
        searchQueries: messages
          .filter(
            (message) => message.type === "getTreeProjectionSlice" && message.query !== undefined
          )
          .map((message) => message.query),
        hydrationRequests: messages.filter((message) => message.type === "getState").length
      };
    });

    expect(metrics.hydrationRequests).toBe(0);
    expect(metrics.searchQueries.every((query) => query === "hidden 42")).toBe(true);
    expect(metrics.searchQueries.length).toBeGreaterThan(firstSearchRequestCount);
    expect(issues).toEqual([]);
  });

  test("does not auto-hydrate after sparse first paint", async ({ page }) => {
    const issues = collectPageIssues(page);
    await page.addInitScript(
      ({ snapshot, fullState }) => {
        window.localStorage.setItem("tabsOutlinerProfileEnabled", "true");
        const messages: Array<{ type: string; at: number }> = [];
        (
          window as typeof window & { __sidebarBootMessages?: typeof messages }
        ).__sidebarBootMessages = messages;
        window.browser = {
          runtime: {
            sendMessage: async (message: unknown) => {
              const type =
                typeof message === "object" && message
                  ? String((message as { type?: unknown }).type)
                  : "";
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
      },
      {
        snapshot: fixtureInitialSnapshot(500),
        fullState: fixtureFullState(500, 1)
      }
    );

    await page.goto("/sidebar/sidebar.html");
    await expect(page.locator(".node[data-node-id='tab:1']")).toBeVisible();
    await expect(page.locator("#search")).toBeEnabled();
    await page.waitForFunction(() => {
      const fullAppImportEnd = performance
        .getEntriesByName("tabs-outliner.boot.fullAppImport.end")
        .at(-1)?.startTime;
      return typeof fullAppImportEnd === "number" && performance.now() - fullAppImportEnd > 900;
    });
    await expect(page.locator("#search")).toBeEnabled();
    await expect(page.locator("#state-count")).toHaveText("501 items / 500 open");

    const metrics = await page.evaluate(async () => {
      const mark = (name: string) => performance.getEntriesByName(name).at(-1)?.startTime;
      const messages =
        (window as typeof window & { __sidebarBootMessages?: Array<{ type: string; at: number }> })
          .__sidebarBootMessages ?? [];
      return {
        initialSnapshotStart: mark("tabs-outliner.boot.initialSnapshot.start"),
        initialSnapshotEnd: mark("tabs-outliner.boot.initialSnapshot.end"),
        firstRowsAt: mark("tabs-outliner.boot.firstRows"),
        fullAppImportStart: mark("tabs-outliner.boot.fullAppImport.start"),
        fullAppImportEnd: mark("tabs-outliner.boot.fullAppImport.end"),
        hydrationStart: mark("tabs-outliner.sidebar.hydration.start"),
        hydrationComplete: mark("tabs-outliner.sidebar.hydration.complete"),
        initialSnapshotRequests: messages.filter(
          (message) => message.type === "getInitialTreeSnapshot"
        ).length,
        hydrationRequests: messages.filter((message) => message.type === "getState").length,
        hydrationTrace: (await window.tabsOutlinerProfile?.summary())?.find(
          (row) => row.name === "sidebar.hydration"
        )
      };
    });

    expect(metrics.initialSnapshotRequests).toBe(1);
    expect(metrics.hydrationRequests).toBe(0);
    expect(metrics.firstRowsAt).toBeGreaterThan(0);
    expect(metrics.initialSnapshotStart).toBeLessThanOrEqual(metrics.initialSnapshotEnd);
    expect(metrics.initialSnapshotEnd).toBeLessThanOrEqual(metrics.firstRowsAt);
    expect(metrics.firstRowsAt).toBeLessThan(metrics.fullAppImportStart);
    expect(metrics.fullAppImportStart).toBeLessThanOrEqual(metrics.fullAppImportEnd);
    expect(metrics.hydrationStart).toBeUndefined();
    expect(metrics.hydrationComplete).toBeUndefined();
    expect(metrics.hydrationTrace).toBeUndefined();
    expect(issues).toEqual([]);
  });
});

function fixtureInitialSnapshot(tabCount: number, options: { activeTabInSnapshot?: boolean } = {}) {
  const now = 1_700_000_000_000;
  const loadedTabCount = 255;
  const loadedTabIds = Array.from(
    { length: loadedTabCount },
    (_value, index) => `tab:${index + 1}`
  );
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
      liveTabCount: tabCount,
      matchCount: 0
    }
  };
}

// A storage-served boot snapshot (hydrating: true) whose tree predates a journaled delete:
// it still contains tab:99 alongside tabs 1-3. The matching background truth is
// fixtureFullState(3, 1), which lacks tab:99.
function fixtureStaleBootSnapshot() {
  const now = 1_700_000_000_000;
  const tabIds = ["tab:1", "tab:2", "tab:3", "tab:99"];
  const rows = [
    {
      nodeId: "window:1",
      depth: 0,
      index: 0,
      subtreeEndIndex: tabIds.length + 1,
      childCount: tabIds.length,
      visibleChildCount: tabIds.length,
      expanded: true,
      searchRevealsCollapsedChildren: false,
      isSearchMatch: false,
      isSearchPath: false,
      insideActiveWindow: true
    },
    ...tabIds.map((nodeId, index) => ({
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
    revision: 7,
    hydrating: true,
    fromStorage: true,
    state: {
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
              title: id === "tab:99" ? "Stale" : `Tab ${index + 1}`,
              url: `https://paint.example/${id}`,
              active: index === 0,
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
      activeTabNodeId: "tab:1",
      activeTabRowIndex: 1,
      totalRowCount: tabIds.length + 1,
      nodeCount: tabIds.length + 1,
      liveTabCount: tabIds.length,
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
      liveTabCount: 1,
      matchCount: 0
    }
  };
}

function fixtureCollapsedFullState(hiddenTabCount: number) {
  const now = 1_700_000_000_000;
  const hiddenTabIds = Array.from(
    { length: hiddenTabCount },
    (_value, index) => `hidden:${index + 1}`
  );
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
      ...Object.fromEntries(
        hiddenTabIds.map((id, index) => [
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
        ])
      )
    }
  };
}

function fixtureCollapsedSearchSnapshot(
  hiddenTabCount: number,
  matchIndex: number,
  options: { totalRowCount?: number } = {}
) {
  const now = 1_700_000_000_000;
  const matchNodeId = `hidden:${matchIndex}`;
  return {
    type: "initialTreeSnapshot",
    version: 1,
    revision: 124,
    hydrating: true,
    state: {
      version: 1,
      rootIds: ["window:1"],
      nodes: {
        "window:1": {
          id: "window:1",
          kind: "window",
          status: "live",
          childIds: ["group:hidden"],
          title: "Window",
          active: true,
          collapsed: false,
          createdAt: now,
          updatedAt: now,
          live: { windowId: 1 }
        },
        "group:hidden": {
          id: "group:hidden",
          kind: "group",
          status: "closed",
          parentId: "window:1",
          childIds: [matchNodeId],
          title: "Hidden saved group",
          collapsed: true,
          createdAt: now,
          updatedAt: now,
          closedAt: now
        },
        [matchNodeId]: {
          id: matchNodeId,
          kind: "tab",
          status: "closed",
          parentId: "group:hidden",
          childIds: [],
          title: `Hidden ${matchIndex}`,
          url: `https://hidden.example/${matchIndex}`,
          collapsed: false,
          createdAt: now,
          updatedAt: now,
          closedAt: now + matchIndex,
          restore: {
            url: `https://hidden.example/${matchIndex}`,
            title: `Hidden ${matchIndex}`
          }
        }
      }
    },
    projection: {
      query: `hidden ${matchIndex}`,
      isSearchActive: true,
      rows: [
        {
          nodeId: "window:1",
          depth: 0,
          index: 0,
          subtreeEndIndex: 3,
          childCount: 2,
          visibleChildCount: 1,
          expanded: true,
          searchRevealsCollapsedChildren: false,
          isSearchMatch: false,
          isSearchPath: true,
          insideActiveWindow: true
        },
        {
          nodeId: "group:hidden",
          depth: 1,
          index: 1,
          parentRowIndex: 0,
          subtreeEndIndex: 3,
          childCount: hiddenTabCount,
          visibleChildCount: 1,
          expanded: true,
          searchRevealsCollapsedChildren: true,
          isSearchMatch: false,
          isSearchPath: true,
          insideActiveWindow: true
        },
        {
          nodeId: matchNodeId,
          depth: 2,
          index: 2,
          parentRowIndex: 1,
          subtreeEndIndex: 3,
          childCount: 0,
          visibleChildCount: 0,
          expanded: true,
          searchRevealsCollapsedChildren: false,
          isSearchMatch: true,
          isSearchPath: false,
          insideActiveWindow: true
        }
      ],
      matchingNodeIds: [matchNodeId],
      visibleNodeIds: ["window:1", "group:hidden", matchNodeId],
      activeTabNodeId: "tab:1",
      totalRowCount: options.totalRowCount ?? 3,
      nodeCount: hiddenTabCount + 3,
      liveTabCount: 1,
      matchCount: 1
    }
  };
}

function fixtureSparseUnsafeUndoUpdate() {
  const now = 1_700_000_000_000;
  return {
    type: "treeStructureUpdated",
    rootIds: ["window:1"],
    deletedNodeIds: [],
    updatedNodes: [
      {
        id: "window:1",
        kind: "window",
        status: "live",
        childIds: ["tab:999"],
        title: "Window",
        active: true,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { windowId: 1 }
      }
    ],
    deletedLiveTabCount: 0
  };
}

function fixtureSparseSearchWindowSnapshot(
  query: string,
  startRowIndex: number,
  rowCount: number,
  totalRowCount: number
) {
  const now = 1_700_000_000_000;
  const rows = Array.from({ length: rowCount }, (_value, index) => {
    const rowIndex = startRowIndex + index;
    return {
      nodeId: `search:${rowIndex}`,
      depth: 0,
      index: rowIndex,
      subtreeEndIndex: rowIndex + 1,
      childCount: 0,
      visibleChildCount: 0,
      expanded: true,
      searchRevealsCollapsedChildren: false,
      isSearchMatch: true,
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
      rootIds: rows.map((row) => row.nodeId),
      nodes: Object.fromEntries(
        rows.map((row) => [
          row.nodeId,
          {
            id: row.nodeId,
            kind: "tab",
            status: "closed",
            childIds: [],
            title: `Search result ${row.index}`,
            url: `https://search.example/${row.index}`,
            collapsed: false,
            createdAt: now,
            updatedAt: now,
            closedAt: now + row.index,
            restore: {
              url: `https://search.example/${row.index}`,
              title: `Search result ${row.index}`
            }
          }
        ])
      )
    },
    projection: {
      query,
      isSearchActive: true,
      rows,
      matchingNodeIds: rows.map((row) => row.nodeId),
      visibleNodeIds: rows.map((row) => row.nodeId),
      totalRowCount,
      nodeCount: totalRowCount,
      liveTabCount: 0,
      matchCount: totalRowCount
    }
  };
}

function hiddenTabNode(index: number) {
  const now = 1_700_000_000_000;
  return {
    id: `hidden:${index}`,
    kind: "tab",
    status: "closed",
    parentId: "group:hidden",
    childIds: [],
    title: `Hidden ${index}`,
    url: `https://hidden.example/${index}`,
    collapsed: false,
    createdAt: now,
    updatedAt: now,
    closedAt: now + index,
    restore: {
      url: `https://hidden.example/${index}`,
      title: `Hidden ${index}`
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
      liveTabCount: tabCount,
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
    issues.push({
      kind: "requestfailed",
      text: `${request.url()} ${request.failure()?.errorText ?? ""}`
    });
  });
  return issues;
}

async function sparseSearchRequestCount(page: Page, query: string): Promise<number> {
  return page.evaluate((expectedQuery) => {
    const messages =
      (
        window as typeof window & {
          __sidebarBootMessages?: Array<{ type: string; query?: string }>;
        }
      ).__sidebarBootMessages ?? [];
    return messages.filter(
      (message) => message.type === "getTreeProjectionSlice" && message.query === expectedQuery
    ).length;
  }, query);
}

async function openToolbarOverflow(page: Page): Promise<void> {
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.locator("#toolbar-overflow-menu")).toBeVisible();
}
