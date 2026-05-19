import { expect, test, type Page } from "@playwright/test";

import { APP_PREFERENCES_STORAGE_KEY, DEFAULT_APP_PREFERENCES, type AppPreferences } from "../../src/preferences";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

test.describe("sidebar undo/redo controls", () => {
  test("reflects history status and sends toolbar commands", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page, { canUndo: true, canRedo: false, undoLabel: "Rename" });

    await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Redo" })).toBeDisabled();

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(sentCommands(page)).resolves.toContain("undo");
    await dispatchSidebarMessage(page, {
      type: "historyStatus",
      canUndo: false,
      canRedo: true,
      undoDepth: 0,
      redoDepth: 1,
      redoLabel: "Rename"
    });

    await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Redo" })).toBeEnabled();

    await page.getByRole("button", { name: "Redo" }).click();
    await expect(sentCommands(page)).resolves.toContain("redo");
    expect(issues).toEqual([]);
  });

  test("supports keyboard shortcuts outside editable fields", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page, { canUndo: true, canRedo: true, undoLabel: "Move", redoLabel: "Move" });

    await page.keyboard.press("Control+Z");
    await page.keyboard.press("Control+Shift+Z");
    await page.keyboard.press("Control+Y");

    await expect(sentCommands(page)).resolves.toEqual(expect.arrayContaining(["undo", "redo", "redo"]));
    expect(issues).toEqual([]);
  });

  test("uses stored shortcut preferences for undo and redo", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page, { canUndo: true, canRedo: true, undoLabel: "Move", redoLabel: "Move" }, {
      ...DEFAULT_APP_PREFERENCES,
      shortcuts: {
        ...DEFAULT_APP_PREFERENCES.shortcuts,
        undo: { enabled: true, combo: "Accel+Alt+U" },
        redo: { enabled: false, combo: "Accel+Shift+Z" },
        redoAlternate: { enabled: false, combo: "Accel+Y" }
      }
    });
    await clearSentCommands(page);

    await page.keyboard.press("Control+Z");
    await page.keyboard.press("Control+Shift+Z");
    await page.keyboard.press("Control+Alt+U");

    await expect(sentCommands(page)).resolves.toEqual(["undo"]);
    expect(issues).toEqual([]);
  });

  test("updates shortcut preferences when extension storage changes", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page, { canUndo: true, canRedo: true, undoLabel: "Move", redoLabel: "Move" });
    await clearSentCommands(page);

    await dispatchStorageChange(page, {
      ...DEFAULT_APP_PREFERENCES,
      shortcuts: {
        ...DEFAULT_APP_PREFERENCES.shortcuts,
        undo: { enabled: true, combo: "Accel+Alt+U" }
      }
    });
    await page.keyboard.press("Control+Z");
    await page.keyboard.press("Control+Alt+U");

    await expect(sentCommands(page)).resolves.toEqual(["undo"]);
    expect(issues).toEqual([]);
  });

  test("does not consume undo/redo shortcuts from rename inputs", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadSidebar(page, { canUndo: true, canRedo: true, undoLabel: "Move", redoLabel: "Move" });

    await page.locator(".node[data-node-id='window\\:1'] > .node-row").hover();
    await page.getByRole("button", { name: "Rename" }).click();
    await page.locator(".node-rename-input").fill("Draft");
    await page.keyboard.press("Control+Z");
    await page.keyboard.press("Control+Y");

    await expect(sentCommands(page)).resolves.not.toContain("undo");
    await expect(sentCommands(page)).resolves.not.toContain("redo");
    expect(issues).toEqual([]);
  });
});

async function loadSidebar(
  page: Page,
  historyStatus: { canUndo: boolean; canRedo: boolean; undoLabel?: string; redoLabel?: string },
  preferences?: AppPreferences
): Promise<void> {
  await page.addInitScript(({ state, initialHistoryStatus, initialPreferences, preferencesKey }) => {
    const listeners: Array<(message: unknown) => void> = [];
    const storageListeners: Array<(changes: Record<string, { newValue?: unknown }>, areaName: string) => void> = [];
    const sent: string[] = [];
    (window as typeof window & {
      __dispatchSidebarMessage?: (message: unknown) => void;
      __dispatchStorageChange?: (preferences: unknown) => void;
      __sentSidebarCommands?: string[];
    }).__dispatchSidebarMessage = (message) => {
      for (const listener of listeners) {
        listener(structuredClone(message));
      }
    };
    (window as typeof window & { __dispatchStorageChange?: (preferences: unknown) => void }).__dispatchStorageChange =
      (nextPreferences) => {
        for (const listener of storageListeners) {
          listener({ [preferencesKey]: { newValue: structuredClone(nextPreferences) } }, "local");
        }
      };
    (window as typeof window & { __sentSidebarCommands?: string[] }).__sentSidebarCommands = sent;

    window.browser = {
      runtime: {
        sendMessage: async (message: unknown) => {
          const type = typeof message === "object" && message ? (message as { type?: unknown }).type : undefined;
          if (typeof type === "string") {
            sent.push(type);
          }
          if (type === "getState") {
            return structuredClone(state);
          }
          if (type === "getHistoryStatus") {
            return {
              type: "historyStatus",
              undoDepth: initialHistoryStatus.canUndo ? 1 : 0,
              redoDepth: initialHistoryStatus.canRedo ? 1 : 0,
              ...initialHistoryStatus
            };
          }
          if (type === "getDiagnostics") {
            return {
              runtimeTabCount: 1,
              liveTabNodeCount: 1,
              visibleLiveTabNodeCount: 1,
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
        onChanged: {
          addListener: (listener: (changes: Record<string, { newValue?: unknown }>, areaName: string) => void) => {
            storageListeners.push(listener);
          }
        },
        local: {
          get: async (key?: string) => {
            if (key === preferencesKey) {
              return { [preferencesKey]: structuredClone(initialPreferences) };
            }
            return {};
          },
          set: async () => undefined
        }
      }
    };
  }, { state: fixtureState(), initialHistoryStatus: historyStatus, initialPreferences: preferences, preferencesKey: APP_PREFERENCES_STORAGE_KEY });

  await page.goto("/sidebar/sidebar.html");
  await expect(page.getByRole("treeitem")).toHaveCount(2);
}

async function dispatchSidebarMessage(page: Page, message: unknown): Promise<void> {
  await page.evaluate((payload) => {
    const dispatch = (window as typeof window & { __dispatchSidebarMessage?: (message: unknown) => void })
      .__dispatchSidebarMessage;
    if (!dispatch) {
      throw new Error("Missing sidebar message dispatcher");
    }
    dispatch(payload);
  }, message);
}

async function sentCommands(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...((window as typeof window & { __sentSidebarCommands?: string[] }).__sentSidebarCommands ?? [])
  ]);
}

async function clearSentCommands(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sent = (window as typeof window & { __sentSidebarCommands?: string[] }).__sentSidebarCommands;
    sent?.splice(0, sent.length);
  });
}

async function dispatchStorageChange(page: Page, preferences: AppPreferences): Promise<void> {
  await page.evaluate((payload) => {
    const dispatch = (window as typeof window & { __dispatchStorageChange?: (preferences: unknown) => void })
      .__dispatchStorageChange;
    if (!dispatch) {
      throw new Error("Missing storage change dispatcher");
    }
    dispatch(payload);
  }, preferences);
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
        childIds: ["tab:1"],
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
        title: "Example",
        url: "https://example.com/",
        childIds: [],
        active: true,
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        live: { tabId: 1, windowId: 1 }
      }
    }
  };
}
