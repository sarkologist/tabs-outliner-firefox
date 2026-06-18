import { expect, test, type Page } from "@playwright/test";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

test.describe("sidebar restore title stability", () => {
  test("does not paint URL-like loading titles for restored rows", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page);
    await recordNodeTitleChanges(page, "tab:local");

    await dispatchSidebarMessage(page, {
      type: "nodeStateUpdated",
      updatedNodes: [
        restoredLocalNode({
          title: "localhost:8089/"
        })
      ],
      closedCountDelta: -1
    });
    await nextAnimationFrame(page);
    await expect(nodeTitle(page, "tab:local")).toHaveText("Saved Local");

    await dispatchSidebarMessage(page, {
      type: "nodeStateUpdated",
      updatedNodes: [
        restoredLocalNode({
          title: "Loaded Local"
        })
      ],
      closedCountDelta: 0
    });

    await expect(nodeTitle(page, "tab:local")).toHaveText("Loaded Local");
    await expect(titleSamples(page)).resolves.not.toContain("localhost:8089/");
    expect(issues).toEqual([]);
  });
});

async function loadSidebar(page: Page): Promise<void> {
  await page.addInitScript((state) => {
    const listeners: Array<(message: unknown) => void> = [];
    (
      window as typeof window & { __dispatchSidebarMessage?: (message: unknown) => void }
    ).__dispatchSidebarMessage = (message) => {
      for (const listener of listeners) {
        listener(structuredClone(message));
      }
    };
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
          return { type: "commandAck", stateChanged: true };
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
  await expect(page.getByRole("treeitem")).toHaveCount(2);
  await expect(nodeTitle(page, "tab:local")).toHaveText("Saved Local");
}

async function dispatchSidebarMessage(page: Page, message: unknown): Promise<void> {
  await page.evaluate((payload) => {
    const dispatch = (
      window as typeof window & { __dispatchSidebarMessage?: (message: unknown) => void }
    ).__dispatchSidebarMessage;
    if (!dispatch) {
      throw new Error("Missing sidebar message dispatcher");
    }
    dispatch(payload);
  }, message);
}

async function recordNodeTitleChanges(page: Page, nodeId: string): Promise<void> {
  await page.evaluate((selector) => {
    const samples: string[] = [];
    const testWindow = window as typeof window & { __restoreTitleSamples?: string[] };
    testWindow.__restoreTitleSamples = samples;
    const record = (): void => {
      const text = document.querySelector(selector)?.textContent;
      if (text) {
        samples.push(text);
      }
    };
    record();
    const target = document.querySelector("#tree");
    if (!target) {
      throw new Error("Missing tree root");
    }
    new MutationObserver(record).observe(target, {
      childList: true,
      characterData: true,
      subtree: true
    });
  }, nodeTitleSelector(nodeId));
}

async function nextAnimationFrame(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
  );
}

function titleSamples(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...((window as typeof window & { __restoreTitleSamples?: string[] }).__restoreTitleSamples ??
      [])
  ]);
}

function nodeTitle(page: Page, nodeId: string) {
  return page.locator(nodeTitleSelector(nodeId));
}

function nodeTitleSelector(nodeId: string): string {
  return `${nodeSelector(nodeId)} .node-title`;
}

function nodeSelector(nodeId: string): string {
  return `.node[data-node-id='${cssString(nodeId)}']`;
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

function restoredLocalNode(overrides: { title: string }) {
  return {
    id: "tab:local",
    kind: "tab",
    status: "live",
    parentId: "window:1",
    title: overrides.title,
    url: "http://localhost:8089/restored",
    childIds: [],
    active: true,
    collapsed: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
    live: { tabId: 2, windowId: 1 },
    restoredFromClosed: true
  };
}

function fixtureState() {
  const now = 1_700_000_000_000;
  return {
    version: 1,
    rootIds: ["window:1"],
    nodes: {
      "window:1": {
        id: "window:1",
        kind: "window",
        status: "live",
        title: "Window",
        childIds: ["tab:local"],
        active: true,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { windowId: 1 }
      },
      "tab:local": {
        id: "tab:local",
        kind: "tab",
        status: "closed",
        parentId: "window:1",
        title: "Saved Local",
        url: "http://localhost:8089/restored",
        childIds: [],
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        closedAt: now,
        restore: {
          sessionId: "session-local",
          url: "http://localhost:8089/restored",
          title: "Saved Local"
        }
      }
    }
  };
}
