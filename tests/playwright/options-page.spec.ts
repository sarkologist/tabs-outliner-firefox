import { expect, test, type Page } from "@playwright/test";

import { APP_PREFERENCES_STORAGE_KEY, type AppPreferences } from "../../src/preferences";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

test.describe("extension options page", () => {
  test("saves preferences, validates duplicate shortcuts, and resets defaults", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadOptions(page);

    await expect(page.getByLabel("Undo history length")).toHaveValue("20");

    await page.getByLabel("Undo history length").fill("37");
    await page.getByRole("button", { name: "Record Undo shortcut" }).click();
    await page.keyboard.press("Control+Alt+U");
    await expect(page.getByTestId("shortcut-combo-undo")).toHaveText("Accel+Alt+U");

    await page.getByRole("button", { name: "Record Focus search shortcut" }).click();
    await page.keyboard.press("Control+Alt+U");
    await page.getByRole("button", { name: "Save options" }).click();
    await expect(page.getByRole("alert")).toContainText("Shortcut Accel+Alt+U is assigned more than once.");
    await expect(savedPreferences(page)).resolves.toBeUndefined();

    await page.getByRole("button", { name: "Reset Focus search shortcut" }).click();
    await page.getByRole("button", { name: "Record open or close sidebar shortcut" }).click();
    await page.keyboard.press("Control+Shift+Y");
    await page.getByRole("button", { name: "Save options" }).click();

    await expect(page.getByRole("status")).toContainText("Saved");
    await expect(savedPreferences(page)).resolves.toMatchObject({
      undoHistoryLimit: 37,
      shortcuts: {
        undo: {
          enabled: true,
          combo: "Accel+Alt+U"
        }
      }
    });
    await expect(updatedCommandShortcut(page)).resolves.toBe("Ctrl+Shift+Y");

    await page.getByRole("button", { name: "Reset defaults" }).click();
    await page.getByRole("button", { name: "Save options" }).click();

    await expect(savedPreferences(page)).resolves.toMatchObject({
      undoHistoryLimit: 20,
      shortcuts: {
        undo: {
          enabled: true,
          combo: "Accel+Z"
        }
      }
    });
    await expect(resetCommands(page)).resolves.toContain("toggle-sidebar");
    expect(issues).toEqual([]);
  });
});

async function loadOptions(page: Page): Promise<void> {
  await page.addInitScript(({ preferencesKey }) => {
    let savedPreferences: AppPreferences | undefined;
    let updatedCommandShortcut: string | undefined;
    const resetCommands: string[] = [];

    (window as typeof window & {
      __savedPreferences?: () => AppPreferences | undefined;
      __updatedCommandShortcut?: () => string | undefined;
      __resetCommands?: () => string[];
    }).__savedPreferences = () => savedPreferences ? structuredClone(savedPreferences) : undefined;
    (window as typeof window & { __updatedCommandShortcut?: () => string | undefined }).__updatedCommandShortcut =
      () => updatedCommandShortcut;
    (window as typeof window & { __resetCommands?: () => string[] }).__resetCommands = () => [...resetCommands];

    window.browser = {
      commands: {
        getAll: async () => [
          {
            name: "toggle-sidebar",
            description: "Open or close the Tab Session Outliner sidebar",
            shortcut: ""
          }
        ],
        update: async (details: { name: string; shortcut?: string }) => {
          if (details.name === "toggle-sidebar") {
            updatedCommandShortcut = details.shortcut ?? "";
          }
        },
        reset: async (name: string) => {
          resetCommands.push(name);
          if (name === "toggle-sidebar") {
            updatedCommandShortcut = "";
          }
        },
        onCommand: {
          addListener: () => undefined
        }
      },
      storage: {
        onChanged: {
          addListener: () => undefined
        },
        local: {
          get: async (key?: string) => key === preferencesKey ? { [preferencesKey]: savedPreferences } : {},
          set: async (items: Record<string, unknown>) => {
            savedPreferences = items[preferencesKey] as AppPreferences;
          },
          remove: async () => undefined
        }
      },
      action: {
        onClicked: {
          addListener: () => undefined
        }
      },
      sidebarAction: {
        open: async () => undefined,
        toggle: async () => undefined
      },
      runtime: {
        onInstalled: {
          addListener: () => undefined
        },
        onStartup: {
          addListener: () => undefined
        },
        onMessage: {
          addListener: () => undefined
        },
        sendMessage: async () => undefined
      },
      windows: {},
      tabs: {},
      sessions: {}
    };
  }, { preferencesKey: APP_PREFERENCES_STORAGE_KEY });

  await page.goto("/options/options.html");
  await expect(page.getByRole("heading", { name: "Options" })).toBeVisible();
}

async function savedPreferences(page: Page): Promise<AppPreferences | undefined> {
  return page.evaluate(() => {
    const read = (window as typeof window & { __savedPreferences?: () => AppPreferences | undefined })
      .__savedPreferences;
    return read?.();
  });
}

async function updatedCommandShortcut(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const read = (window as typeof window & { __updatedCommandShortcut?: () => string | undefined })
      .__updatedCommandShortcut;
    return read?.();
  });
}

async function resetCommands(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const read = (window as typeof window & { __resetCommands?: () => string[] }).__resetCommands;
    return read?.() ?? [];
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
    issues.push({ kind: "requestfailed", text: `${request.url()} ${request.failure()?.errorText ?? ""}` });
  });
  return issues;
}
