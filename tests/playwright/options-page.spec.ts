import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

import { APP_PREFERENCES_STORAGE_KEY, type AppPreferences } from "../../src/preferences";
import { PROFILE_STORAGE_KEY } from "../../src/perf/profile";

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

  test("controls and exports performance profiles", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadOptions(page);

    await expect(page.locator("#profile-status")).toHaveText("Stopped · 0 entries");

    await page.getByRole("button", { name: "Start" }).click();
    await expect(page.locator("#profile-status")).toHaveText("Running · 0 entries");
    await expect(profileEnabledFlag(page)).resolves.toBe(true);
    await expect(runtimeMessages(page)).resolves.toContainEqual({
      type: "setPerformanceTraceEnabled",
      enabled: true
    });

    await setProfileSnapshot(page, {
      background: {
        enabled: true,
        maxEntries: 500,
        entries: [
          { source: "background", name: "background.save", atMs: 1, durationMs: 12 }
        ]
      },
      sidebar: {
        enabled: true,
        maxEntries: 500,
        entries: [
          { source: "sidebar", name: "sidebar.render", atMs: 2, durationMs: 6 }
        ]
      }
    });
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(page.locator("#profile-status")).toHaveText("Profile reset");
    await expect(profileEnabledFlag(page)).resolves.toBe(true);
    await expect(runtimeMessages(page)).resolves.toContainEqual({
      type: "clearPerformanceTrace"
    });

    await setProfileSnapshot(page, {
      background: {
        enabled: true,
        maxEntries: 500,
        entries: [
          { source: "background", name: "background.save", atMs: 3, durationMs: 8 }
        ]
      },
      sidebar: {
        enabled: true,
        maxEntries: 500,
        entries: [
          { source: "sidebar", name: "sidebar.render", atMs: 4, durationMs: 4 }
        ]
      }
    });
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export profile" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^tabs-outliner-profile-\d{4}-\d{2}-\d{2}\.json$/);
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const payload = JSON.parse(await readFile(downloadPath!, "utf8")) as {
      schema?: string;
      exportedAt?: string;
      snapshot?: {
        background?: { entries?: unknown[] };
        sidebar?: { entries?: unknown[] };
      };
      summary?: Array<{ name?: string; totalMs?: number }>;
    };
    expect(payload.schema).toBe("tabs-outliner-profile");
    expect(payload.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(payload.snapshot?.background?.entries).toHaveLength(1);
    expect(payload.snapshot?.sidebar?.entries).toHaveLength(1);
    expect(payload.summary).toEqual([
      expect.objectContaining({ name: "background.save", totalMs: 8 }),
      expect.objectContaining({ name: "sidebar.render", totalMs: 4 })
    ]);
    await expect(page.locator("#profile-status")).toHaveText("Profile exported");

    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.locator("#profile-status")).toHaveText("Stopped · 2 entries");
    await expect(profileEnabledFlag(page)).resolves.toBe(false);
    await expect(runtimeMessages(page)).resolves.toContainEqual({
      type: "setPerformanceTraceEnabled",
      enabled: false
    });
    expect(issues).toEqual([]);
  });
});

async function loadOptions(page: Page): Promise<void> {
  await page.addInitScript(({ preferencesKey, profileKey }) => {
    let savedPreferences: AppPreferences | undefined;
    let updatedCommandShortcut: string | undefined;
    const resetCommands: string[] = [];
    let profileSnapshot = {
      background: {
        enabled: false,
        maxEntries: 500,
        entries: [] as unknown[]
      },
      sidebar: {
        enabled: false,
        maxEntries: 500,
        entries: [] as unknown[]
      }
    };
    const runtimeMessages: unknown[] = [];

    (window as typeof window & {
      __savedPreferences?: () => AppPreferences | undefined;
      __updatedCommandShortcut?: () => string | undefined;
      __resetCommands?: () => string[];
      __runtimeMessages?: () => unknown[];
      __profileEnabledFlag?: () => boolean;
      __setProfileSnapshot?: (snapshot: typeof profileSnapshot) => void;
    }).__savedPreferences = () => savedPreferences ? structuredClone(savedPreferences) : undefined;
    (window as typeof window & { __updatedCommandShortcut?: () => string | undefined }).__updatedCommandShortcut =
      () => updatedCommandShortcut;
    (window as typeof window & { __resetCommands?: () => string[] }).__resetCommands = () => [...resetCommands];
    (window as typeof window & { __runtimeMessages?: () => unknown[] }).__runtimeMessages =
      () => structuredClone(runtimeMessages);
    (window as typeof window & { __profileEnabledFlag?: () => boolean }).__profileEnabledFlag =
      () => window.localStorage.getItem(profileKey) === "true";
    (window as typeof window & { __setProfileSnapshot?: (snapshot: typeof profileSnapshot) => void })
      .__setProfileSnapshot = (snapshot) => {
        profileSnapshot = structuredClone(snapshot);
      };

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
        sendMessage: async (message: unknown) => {
          runtimeMessages.push(structuredClone(message));
          const type = typeof message === "object" && message ? (message as { type?: unknown }).type : undefined;
          if (type === "setPerformanceTraceEnabled") {
            const enabled = Boolean((message as { enabled?: unknown }).enabled);
            profileSnapshot = {
              background: {
                ...profileSnapshot.background,
                enabled
              },
              sidebar: {
                ...profileSnapshot.sidebar,
                enabled
              }
            };
            return { ok: true };
          }
          if (type === "clearPerformanceTrace") {
            profileSnapshot = {
              background: {
                ...profileSnapshot.background,
                entries: []
              },
              sidebar: {
                ...profileSnapshot.sidebar,
                entries: []
              }
            };
            return { ok: true };
          }
          if (type === "getPerformanceProfile") {
            return structuredClone(profileSnapshot);
          }
          if (type === "getPerformanceTrace") {
            return structuredClone(profileSnapshot.background);
          }
          return undefined;
        }
      },
      windows: {},
      tabs: {},
      sessions: {}
    };
  }, { preferencesKey: APP_PREFERENCES_STORAGE_KEY, profileKey: PROFILE_STORAGE_KEY });

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

async function runtimeMessages(page: Page): Promise<unknown[]> {
  return page.evaluate(() => {
    const read = (window as typeof window & { __runtimeMessages?: () => unknown[] }).__runtimeMessages;
    return read?.() ?? [];
  });
}

async function setProfileSnapshot(page: Page, snapshot: unknown): Promise<void> {
  await page.evaluate((nextSnapshot) => {
    (window as typeof window & { __setProfileSnapshot?: (snapshot: unknown) => void }).__setProfileSnapshot?.(
      nextSnapshot
    );
  }, snapshot);
}

async function profileEnabledFlag(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const read = (window as typeof window & { __profileEnabledFlag?: () => boolean }).__profileEnabledFlag;
    return read?.() ?? false;
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
