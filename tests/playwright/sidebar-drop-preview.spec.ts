import { expect, test, type Page, type TestInfo } from "@playwright/test";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

test.describe("sidebar drag/drop target preview", () => {
  test("draws destination guides for an after drop below an expanded subtree", async ({
    page
  }, testInfo) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page);

    await dragFromTo(page, "tab:b", "tab:a", "after");

    await expect(dropMarker(page)).toHaveClass(/drop-after/);
    await expect(dropGuideLayer(page).locator(".drop-guide-vertical")).toHaveCount(1);
    await expect(dropGuideLayer(page).locator(".drop-guide-horizontal")).toHaveCount(1);
    await expect(markerState(page)).resolves.toMatchObject({ depth: 1, rowIndex: 4 });
    await screenshot(page, testInfo, "after-expanded-subtree");
    expect(issues).toEqual([]);
  });

  test("draws child-depth guides for an inside drop at the end of an expanded subtree", async ({
    page
  }, testInfo) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page);

    await dragFromTo(page, "tab:b", "tab:a", "inside");

    await expect(dropMarker(page)).toHaveClass(/drop-inside/);
    await expect(
      page.locator(".node[data-node-id='tab\\:a'] > .node-row.drop-inside-target")
    ).toBeVisible();
    await expect(dropGuideLayer(page).locator(".drop-guide-vertical")).toHaveCount(1);
    await expect(dropGuideLayer(page).locator(".drop-guide-horizontal")).toHaveCount(1);
    await expect(markerState(page)).resolves.toMatchObject({ depth: 2, rowIndex: 4 });
    await screenshot(page, testInfo, "inside-expanded-subtree");
    expect(issues).toEqual([]);
  });

  test("keeps root drops at depth zero without parent guides", async ({ page }, testInfo) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page);

    await startDrag(page, "tab:b");
    await page.locator("main").dispatchEvent("dragover", {
      bubbles: true,
      cancelable: true,
      clientY: 500
    });

    await expect(dropMarker(page)).toHaveClass(/drop-root/);
    await expect(dropGuideLayer(page)).toHaveCount(0);
    await expect(markerState(page)).resolves.toMatchObject({ depth: 0, rowIndex: 6 });
    await screenshot(page, testInfo, "root-end");
    expect(issues).toEqual([]);
  });
});

async function loadSidebar(page: Page): Promise<void> {
  await page.addInitScript((state) => {
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
              runtimeTabCount: 0,
              liveTabNodeCount: 0,
              visibleLiveTabNodeCount: 0,
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
  }, fixtureState());

  await page.goto("/sidebar/sidebar.html");
  await expect(page.getByRole("treeitem")).toHaveCount(6);
}

async function dragFromTo(
  page: Page,
  sourceId: string,
  targetId: string,
  mode: "before" | "inside" | "after"
): Promise<void> {
  await startDrag(page, sourceId);
  const target = page.locator(nodeRowSelector(targetId));
  const box = await target.boundingBox();
  if (!box) {
    throw new Error(`Missing target row for ${targetId}`);
  }

  const clientY =
    mode === "before"
      ? box.y + 1
      : mode === "after"
        ? box.y + box.height - 1
        : box.y + box.height / 2;
  await target.dispatchEvent("dragover", {
    bubbles: true,
    cancelable: true,
    clientY
  });
}

async function startDrag(page: Page, sourceId: string): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await page.locator(nodeRowSelector(sourceId)).dispatchEvent("dragstart", {
    bubbles: true,
    cancelable: true,
    dataTransfer
  });
}

function nodeRowSelector(nodeId: string): string {
  return `.node[data-node-id='${cssString(nodeId)}'] > .node-row`;
}

function cssString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

async function markerState(page: Page): Promise<{ depth: number; rowIndex: number }> {
  return dropMarker(page).evaluate((marker) => {
    const element = marker as HTMLElement;
    const tree = document.querySelector<HTMLElement>("#tree");
    if (!tree) {
      throw new Error("Missing tree");
    }

    const rowHeight = Number.parseFloat(
      window.getComputedStyle(document.documentElement).getPropertyValue("--node-row-height")
    );
    return {
      depth: Number.parseInt(element.style.getPropertyValue("--depth"), 10),
      rowIndex: Math.round(
        (element.getBoundingClientRect().top - tree.getBoundingClientRect().top) / rowHeight
      )
    };
  });
}

function dropMarker(page: Page) {
  return page.getByTestId("drop-marker");
}

function dropGuideLayer(page: Page) {
  return page.getByTestId("drop-guide-layer");
}

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: testInfo.outputPath(`${name}.png`),
    fullPage: true
  });
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

function fixtureState() {
  const now = 1_700_000_000_000;
  return {
    version: 1,
    rootIds: ["window:1"],
    nodes: {
      "window:1": node("window:1", "window", "Window", ["tab:a", "tab:source", "tab:b"], {
        active: true
      }),
      "tab:a": node("tab:a", "tab", "Expanded parent", ["tab:a1", "tab:a2"], {
        parentId: "window:1"
      }),
      "tab:a1": node("tab:a1", "tab", "First child", [], {
        parentId: "tab:a"
      }),
      "tab:a2": node("tab:a2", "tab", "Second child", [], {
        parentId: "tab:a"
      }),
      "tab:source": node("tab:source", "tab", "Stationary sibling", [], {
        parentId: "window:1"
      }),
      "tab:b": node("tab:b", "tab", "Dragged tab", [], {
        parentId: "window:1"
      })
    }
  };

  function node(
    id: string,
    kind: "window" | "tab",
    title: string,
    childIds: string[],
    options: { active?: boolean; parentId?: string } = {}
  ) {
    return {
      id,
      kind,
      status: "live",
      title,
      childIds,
      collapsed: false,
      createdAt: now,
      updatedAt: now,
      ...(options.active ? { active: true } : {}),
      ...(options.parentId ? { parentId: options.parentId } : {})
    };
  }
}
