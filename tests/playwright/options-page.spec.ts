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

  test("shows the write-activity durability chain, flags failures, and clears", async ({
    page
  }) => {
    const issues = collectPageIssues(page);
    await loadOptions(page);

    // The default fixture is a healthy chain: a domain change + journal append -> snapshot -> prune.
    await expect(page.locator("#write-log-health")).toContainText("99 nodes");
    await expect(page.locator("#write-log-health")).toContainText("no errors");
    await expect(page.locator("#write-log-health")).toHaveClass(/is-ok/);

    // The Changes list names the deletion AND every affected node (not just a count).
    const changeRows = page.locator("#write-log-changes .write-log-row");
    await expect(changeRows).toHaveCount(1);
    await expect(changeRows.first()).toContainText("Deleted 'Work' (window)");
    const changeNodes = page.locator("#write-log-changes .write-log-nodes li");
    await expect(changeNodes).toContainText(["'Work' (window)", "'Gmail'", "'Calendar'"]);

    // The Storage activity list shows the durability mechanics only.
    const storageRows = page.locator("#write-log-storage .write-log-row");
    await expect(storageRows).toHaveCount(3);
    await expect(storageRows.first()).toContainText("Trimmed journal");
    await expect(storageRows.nth(1)).toContainText("Saved snapshot");
    await expect(storageRows.nth(1)).toContainText("99 nodes");
    await expect(storageRows.last()).toContainText("Journaled");
    // Domain descriptions live in the Changes list, not the Storage list.
    await expect(page.locator("#write-log-storage")).not.toContainText("Deleted 'Work'");

    // A spill (warning) and a failed save (error) light up the health line and storage-row severities.
    await setWriteLog(page, {
      version: 1,
      entries: [
        {
          version: 1,
          seq: 4,
          at: "2026-06-20T10:01:00.000Z",
          kind: "journalSpill",
          ok: false,
          detail: { entries: 1 }
        },
        {
          version: 1,
          seq: 5,
          at: "2026-06-20T10:01:01.000Z",
          kind: "saveFailed",
          ok: false,
          detail: { message: "quota exceeded" }
        }
      ]
    });
    await page.locator("#write-log-refresh").click();
    await expect(page.locator("#write-log-health")).toContainText("1 error");
    await expect(page.locator("#write-log-health")).toHaveClass(/is-error/);
    await expect(page.locator("#write-log-storage .write-log-row.is-error")).toContainText(
      "FAILED"
    );
    await expect(page.locator("#write-log-storage .write-log-row.is-warn")).toContainText("spill");

    // Clear empties both lists.
    await page.locator("#write-log-clear").click();
    await expect(page.locator("#write-log-changes .write-log-empty")).toBeVisible();
    await expect(page.locator("#write-log-storage .write-log-empty")).toBeVisible();
    await expect(page.locator("#write-log-health")).toContainText("No write activity yet");

    expect(issues).toEqual([]);
  });

  test("ignores a stale out-of-order write-log response", async ({ page }) => {
    const issues = collectPageIssues(page);
    await loadOptions(page);

    // Pause live polling so only the explicit refreshes below race.
    await page.locator("#write-log-live").uncheck();

    // Refresh A captures the STALE snapshot but resolves slowly.
    await setWriteLog(page, {
      version: 1,
      entries: [
        {
          version: 1,
          seq: 7,
          at: "2026-06-20T10:02:00.000Z",
          kind: "snapshotSave",
          ok: true,
          detail: { nodeCount: 111 }
        }
      ]
    });
    await setWriteLogDelay(page, 400);
    await page.locator("#write-log-refresh").click();

    // Refresh B captures the FRESH snapshot and resolves immediately, superseding A.
    await setWriteLog(page, {
      version: 1,
      entries: [
        {
          version: 1,
          seq: 8,
          at: "2026-06-20T10:02:01.000Z",
          kind: "snapshotSave",
          ok: true,
          detail: { nodeCount: 222 }
        }
      ]
    });
    await page.locator("#write-log-refresh").click();
    await expect(page.locator("#write-log-health")).toContainText("222 nodes");

    // When A's delayed response lands it must NOT overwrite the newer B render.
    await page.waitForTimeout(500);
    await expect(page.locator("#write-log-health")).toContainText("222 nodes");
    await expect(page.locator("#write-log-health")).not.toContainText("111 nodes");

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
      let writeLogSnapshot: { version: 1; entries: unknown[] } = {
        version: 1,
        entries: [
          {
            version: 1,
            seq: 1,
            at: "2026-06-20T10:00:00.000Z",
            kind: "change",
            ok: true,
            detail: { label: "deleteNode" },
            change: {
              headline: "Deleted 'Work' (window) (+2 descendants)",
              lines: ["'Work' (window)", "'Gmail'", "'Calendar'"],
              overflow: 0
            }
          },
          {
            version: 1,
            seq: 2,
            at: "2026-06-20T10:00:01.000Z",
            kind: "journalAppend",
            ok: true,
            detail: { seq: 10, entries: 1, labels: "deleteNode" }
          },
          {
            version: 1,
            seq: 3,
            at: "2026-06-20T10:00:02.000Z",
            kind: "snapshotSave",
            ok: true,
            detail: {
              nodeCount: 99,
              closedCount: 5,
              nodeDelta: -1,
              closedDelta: 0,
              journalSeqIncluded: 10,
              dirtyShardCount: 2,
              generation: 7
            }
          },
          {
            version: 1,
            seq: 4,
            at: "2026-06-20T10:00:03.000Z",
            kind: "journalPrune",
            ok: true,
            detail: { throughSeq: 10 }
          }
        ]
      };
      const runtimeMessages: unknown[] = [];
      // Lets a test force an out-of-order getWriteLog response: the next getWriteLog captures the
      // snapshot now but resolves after this delay.
      let nextWriteLogDelayMs = 0;

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
      (
        window as typeof window & {
          __setWriteLog?: (snapshot: { version: 1; entries: unknown[] }) => void;
        }
      ).__setWriteLog = (snapshot) => {
        writeLogSnapshot = structuredClone(snapshot);
      };
      (window as typeof window & { __setWriteLogDelay?: (ms: number) => void }).__setWriteLogDelay =
        (ms) => {
          nextWriteLogDelayMs = ms;
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
            if (type === "getWriteLog") {
              const captured = structuredClone(writeLogSnapshot);
              const delay = nextWriteLogDelayMs;
              nextWriteLogDelayMs = 0;
              if (delay > 0) {
                await new Promise((resolve) => setTimeout(resolve, delay));
              }
              return captured;
            }
            if (type === "clearWriteLog") {
              writeLogSnapshot = { version: 1, entries: [] };
              return { ok: true };
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

async function setWriteLog(
  page: Page,
  snapshot: { version: 1; entries: unknown[] }
): Promise<void> {
  await page.evaluate((value) => {
    (
      window as typeof window & {
        __setWriteLog?: (snapshot: { version: 1; entries: unknown[] }) => void;
      }
    ).__setWriteLog?.(value);
  }, snapshot);
}

async function setWriteLogDelay(page: Page, ms: number): Promise<void> {
  await page.evaluate((value) => {
    (window as typeof window & { __setWriteLogDelay?: (ms: number) => void }).__setWriteLogDelay?.(
      value
    );
  }, ms);
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
