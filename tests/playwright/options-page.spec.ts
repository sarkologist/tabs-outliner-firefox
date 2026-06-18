import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

import { APP_PREFERENCES_STORAGE_KEY, type AppPreferences } from "../../src/preferences";
import { PROFILE_STORAGE_KEY } from "../../src/perf/profile";
import { INCIDENT_LOG_STORAGE_KEY } from "../../src/background/incident-log";

type ConsoleIssue = {
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
};

test.describe("extension options page", () => {
  test("saves preferences, validates duplicate shortcuts, and resets defaults", async ({
    page
  }) => {
    const issues = collectPageIssues(page);
    await loadOptions(page);

    await expect(page.getByLabel("Undo history length")).toHaveValue("20");
    await expect(page.getByLabel("Enable automatic backups")).not.toBeChecked();
    await expect(page.locator("#shortcut-list .shortcut-label .label-icon")).toHaveCount(9);
    await expect(page.locator(".global-shortcut-row .shortcut-label .label-icon")).toHaveCount(1);

    await page.getByLabel("Undo history length").fill("37");
    await page.getByLabel("Enable automatic backups").check();
    await page.getByRole("button", { name: "Record Undo shortcut" }).click();
    await page.keyboard.press("Control+Alt+U");
    await expect(page.getByTestId("shortcut-combo-undo")).toHaveText("Accel+Alt+U");

    await page.getByRole("button", { name: "Record Focus search shortcut" }).click();
    await page.keyboard.press("Control+Alt+U");
    await page.getByRole("button", { name: "Save options" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Shortcut Accel+Alt+U is assigned more than once."
    );
    await expect(savedPreferences(page)).resolves.toBeUndefined();

    await page.getByRole("button", { name: "Reset Focus search shortcut" }).click();
    await page.getByRole("button", { name: "Record open or close sidebar shortcut" }).click();
    await page.keyboard.press("Control+Shift+Y");
    await page.getByRole("button", { name: "Save options" }).click();

    await expect(page.getByRole("status")).toContainText("Saved");
    await expect(savedPreferences(page)).resolves.toMatchObject({
      undoHistoryLimit: 37,
      automaticBackups: {
        enabled: true
      },
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
      automaticBackups: {
        enabled: false
      },
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
        entries: [{ source: "background", name: "background.save", atMs: 1, durationMs: 12 }]
      },
      incidentLog: [
        {
          version: 1,
          at: "2026-06-07T12:00:00.000Z",
          event: "startupStateLoaded"
        }
      ],
      portableTree: {
        schema: "tabs-outliner-tree",
        version: 1,
        exportedAt: "2026-06-07T12:00:00.000Z",
        roots: [
          {
            kind: "window",
            title: "Group",
            children: [
              {
                kind: "tab",
                title: "One",
                url: "https://one.example/",
                children: []
              }
            ]
          }
        ]
      },
      sidebars: [
        {
          id: "sidebar-window-10",
          label: "Sidebar window 10",
          windowId: 10,
          snapshot: {
            enabled: true,
            maxEntries: 500,
            entries: [{ source: "sidebar", name: "sidebar.render", atMs: 2, durationMs: 6 }]
          }
        }
      ]
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
        entries: [{ source: "background", name: "background.save", atMs: 3, durationMs: 8 }]
      },
      incidentLog: [
        {
          version: 1,
          at: "2026-06-07T12:00:00.000Z",
          event: "startupStateLoaded"
        }
      ],
      portableTree: {
        schema: "tabs-outliner-tree",
        version: 1,
        exportedAt: "2026-06-07T12:00:00.000Z",
        roots: [
          {
            kind: "window",
            title: "Group",
            children: [
              {
                kind: "tab",
                title: "One",
                url: "https://one.example/",
                children: []
              }
            ]
          }
        ]
      },
      sidebars: [
        {
          id: "sidebar-window-10",
          label: "Sidebar window 10",
          windowId: 10,
          snapshot: {
            enabled: true,
            maxEntries: 500,
            entries: [{ source: "sidebar", name: "sidebar.render", atMs: 4, durationMs: 4 }]
          }
        },
        {
          id: "sidebar-window-20",
          label: "Sidebar window 20",
          windowId: 20,
          snapshot: {
            enabled: true,
            maxEntries: 500,
            entries: [{ source: "sidebar", name: "sidebar.virtualRows", atMs: 5, durationMs: 3 }]
          }
        }
      ]
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
        incidentLog?: Array<{ event?: string }>;
        portableTree?: { schema?: string; roots?: unknown[] };
        sidebars?: Array<{
          id?: string;
          label?: string;
          windowId?: number;
          snapshot?: { entries?: unknown[] };
        }>;
      };
      summary?: Array<{ name?: string; totalMs?: number }>;
    };
    expect(payload.schema).toBe("tabs-outliner-profile");
    expect(payload.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(payload.snapshot?.background?.entries).toHaveLength(1);
    expect(payload.snapshot?.incidentLog).toEqual([
      expect.objectContaining({ event: "startupStateLoaded" })
    ]);
    expect(payload.snapshot?.portableTree).toEqual(
      expect.objectContaining({
        schema: "tabs-outliner-tree",
        roots: expect.any(Array)
      })
    );
    expect(payload.snapshot?.sidebars).toEqual([
      expect.objectContaining({
        id: "sidebar-window-10",
        label: "Sidebar window 10",
        windowId: 10,
        snapshot: expect.objectContaining({ entries: expect.any(Array) })
      }),
      expect.objectContaining({
        id: "sidebar-window-20",
        label: "Sidebar window 20",
        windowId: 20,
        snapshot: expect.objectContaining({ entries: expect.any(Array) })
      })
    ]);
    expect(payload.snapshot?.sidebars?.[0]?.snapshot?.entries).toHaveLength(1);
    expect(payload.snapshot?.sidebars?.[1]?.snapshot?.entries).toHaveLength(1);
    expect(payload.summary).toEqual([
      expect.objectContaining({ name: "background.save", totalMs: 8 }),
      expect.objectContaining({ name: "sidebar.render", totalMs: 4 }),
      expect.objectContaining({ name: "sidebar.virtualRows", totalMs: 3 })
    ]);
    await expect(page.locator("#profile-status")).toHaveText("Profile exported");

    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.locator("#profile-status")).toHaveText("Stopped · 3 entries");
    await expect(profileEnabledFlag(page)).resolves.toBe(false);
    await expect(runtimeMessages(page)).resolves.toContainEqual({
      type: "setPerformanceTraceEnabled",
      enabled: false
    });
    expect(issues).toEqual([]);
  });

  test("renders the storage incident log newest-first with severity classes", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadOptions(page);

    const rows = page.locator("#incident-list .incident-row");
    await expect(rows).toHaveCount(3);

    // Newest entry (journalSpillGap) renders first and is flagged as a warning.
    await expect(rows.first()).toContainText("journalSpillGap");
    await expect(rows.first()).toHaveClass(/is-warning/);
    await expect(rows.first()).toContainText("seq=3");

    // Routine startup/migration events render as neutral info.
    await expect(rows.nth(2)).toContainText("startupStateLoaded");
    await expect(rows.nth(2)).toHaveClass(/is-info/);

    await expect(page.locator("#incident-summary")).toHaveText("3 incidents · 1 warning");
    expect(issues).toEqual([]);
  });
});

async function loadOptions(page: Page): Promise<void> {
  await page.addInitScript(
    ({ preferencesKey, profileKey, incidentKey, incidentEntries }) => {
      let savedPreferences: AppPreferences | undefined;
      let updatedCommandShortcut: string | undefined;
      const resetCommands: string[] = [];
      let profileSnapshot = {
        background: {
          enabled: false,
          maxEntries: 500,
          entries: [] as unknown[]
        },
        incidentLog: [
          {
            version: 1,
            at: "2026-06-07T12:00:00.000Z",
            event: "startupStateLoaded"
          }
        ],
        sidebars: [] as unknown[]
      };
      const runtimeMessages: unknown[] = [];

      (
        window as typeof window & {
          __savedPreferences?: () => AppPreferences | undefined;
          __updatedCommandShortcut?: () => string | undefined;
          __resetCommands?: () => string[];
          __runtimeMessages?: () => unknown[];
          __profileEnabledFlag?: () => boolean;
          __setProfileSnapshot?: (snapshot: typeof profileSnapshot) => void;
        }
      ).__savedPreferences = () =>
        savedPreferences ? structuredClone(savedPreferences) : undefined;
      (
        window as typeof window & { __updatedCommandShortcut?: () => string | undefined }
      ).__updatedCommandShortcut = () => updatedCommandShortcut;
      (window as typeof window & { __resetCommands?: () => string[] }).__resetCommands = () => [
        ...resetCommands
      ];
      (window as typeof window & { __runtimeMessages?: () => unknown[] }).__runtimeMessages = () =>
        structuredClone(runtimeMessages);
      (window as typeof window & { __profileEnabledFlag?: () => boolean }).__profileEnabledFlag =
        () => window.localStorage.getItem(profileKey) === "true";
      (
        window as typeof window & {
          __setProfileSnapshot?: (snapshot: typeof profileSnapshot) => void;
        }
      ).__setProfileSnapshot = (snapshot) => {
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
            get: async (key?: string) => {
              if (key === preferencesKey) {
                return { [preferencesKey]: savedPreferences };
              }
              if (key === incidentKey) {
                return { [incidentKey]: { version: 1, entries: incidentEntries } };
              }
              return {};
            },
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
            const type =
              typeof message === "object" && message
                ? (message as { type?: unknown }).type
                : undefined;
            if (type === "setPerformanceTraceEnabled") {
              const enabled = Boolean((message as { enabled?: unknown }).enabled);
              profileSnapshot = {
                background: {
                  ...profileSnapshot.background,
                  enabled
                },
                sidebars: profileSnapshot.sidebars.map((sidebar) =>
                  typeof sidebar === "object" && sidebar
                    ? {
                        ...sidebar,
                        snapshot: {
                          ...(sidebar as { snapshot?: Record<string, unknown> }).snapshot,
                          enabled
                        }
                      }
                    : sidebar
                )
              };
              return { ok: true };
            }
            if (type === "clearPerformanceTrace") {
              profileSnapshot = {
                background: {
                  ...profileSnapshot.background,
                  entries: []
                },
                sidebars: profileSnapshot.sidebars.map((sidebar) =>
                  typeof sidebar === "object" && sidebar
                    ? {
                        ...sidebar,
                        snapshot: {
                          ...(sidebar as { snapshot?: Record<string, unknown> }).snapshot,
                          entries: []
                        }
                      }
                    : sidebar
                )
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
    },
    {
      preferencesKey: APP_PREFERENCES_STORAGE_KEY,
      profileKey: PROFILE_STORAGE_KEY,
      incidentKey: INCIDENT_LOG_STORAGE_KEY,
      incidentEntries: [
        {
          version: 1,
          at: "2026-06-07T12:00:00.000Z",
          event: "startupStateLoaded",
          detail: { nodeCount: 12 }
        },
        {
          version: 1,
          at: "2026-06-07T12:00:01.000Z",
          event: "v4MigrationComplete",
          detail: { nodeCount: 12 }
        },
        { version: 1, at: "2026-06-07T12:00:02.000Z", event: "journalSpillGap", detail: { seq: 3 } }
      ]
    }
  );

  await page.goto("/options/options.html");
  await expect(page.getByRole("heading", { name: "Options" })).toBeVisible();
}

async function savedPreferences(page: Page): Promise<AppPreferences | undefined> {
  return page.evaluate(() => {
    const read = (
      window as typeof window & { __savedPreferences?: () => AppPreferences | undefined }
    ).__savedPreferences;
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
    const read = (window as typeof window & { __runtimeMessages?: () => unknown[] })
      .__runtimeMessages;
    return read?.() ?? [];
  });
}

async function setProfileSnapshot(page: Page, snapshot: unknown): Promise<void> {
  await page.evaluate((nextSnapshot) => {
    (
      window as typeof window & { __setProfileSnapshot?: (snapshot: unknown) => void }
    ).__setProfileSnapshot?.(nextSnapshot);
  }, snapshot);
}

async function profileEnabledFlag(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const read = (window as typeof window & { __profileEnabledFlag?: () => boolean })
      .__profileEnabledFlag;
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
    issues.push({
      kind: "requestfailed",
      text: `${request.url()} ${request.failure()?.errorText ?? ""}`
    });
  });
  return issues;
}
