import { describe, expect, it } from "vitest";

import {
  DEFAULT_APP_PREFERENCES,
  MAX_UNDO_HISTORY_LIMIT,
  MIN_UNDO_HISTORY_LIMIT,
  normalizeAppPreferences,
  normalizeShortcutCombo,
  sidebarShortcutDuplicates,
  shortcutMatchesEvent,
  validateAppPreferences
} from "./preferences.js";

describe("app preferences", () => {
  it("loads defaults for missing or malformed preference data", () => {
    expect(normalizeAppPreferences(undefined)).toEqual(DEFAULT_APP_PREFERENCES);
    expect(normalizeAppPreferences({ version: 1, undoHistoryLimit: "lots", shortcuts: {} })).toEqual(
      DEFAULT_APP_PREFERENCES
    );
    expect(normalizeAppPreferences({
      version: 1,
      undoHistoryLimit: 30,
      shortcuts: DEFAULT_APP_PREFERENCES.shortcuts
    }).automaticBackups).toEqual({ enabled: false });
    expect(normalizeAppPreferences({
      version: 1,
      undoHistoryLimit: 30,
      shortcuts: DEFAULT_APP_PREFERENCES.shortcuts,
      automaticBackups: { enabled: true }
    }).automaticBackups).toEqual({ enabled: true });
    expect(normalizeAppPreferences({
      version: 1,
      undoHistoryLimit: 30,
      shortcuts: DEFAULT_APP_PREFERENCES.shortcuts,
      automaticBackups: { enabled: "yes" }
    }).automaticBackups).toEqual({ enabled: false });
  });

  it("clamps undo history length to the supported range", () => {
    expect(normalizeAppPreferences({ ...DEFAULT_APP_PREFERENCES, undoHistoryLimit: -1 }).undoHistoryLimit).toBe(
      MIN_UNDO_HISTORY_LIMIT
    );
    expect(normalizeAppPreferences({ ...DEFAULT_APP_PREFERENCES, undoHistoryLimit: 500 }).undoHistoryLimit).toBe(
      MAX_UNDO_HISTORY_LIMIT
    );
  });

  it("normalizes keyboard shortcut combos for stable storage and matching", () => {
    expect(normalizeShortcutCombo(" ctrl + shift + z ")).toBe("Accel+Shift+Z");
    expect(normalizeShortcutCombo("Command+F")).toBe("Accel+F");
    expect(normalizeShortcutCombo("")).toBe("");
  });

  it("detects duplicate enabled sidebar shortcuts before saving", () => {
    const preferences = normalizeAppPreferences({
      ...DEFAULT_APP_PREFERENCES,
      shortcuts: {
        ...DEFAULT_APP_PREFERENCES.shortcuts,
        search: { enabled: true, combo: "Accel+Z" },
        undo: { enabled: true, combo: "Accel+Z" },
        redo: { enabled: false, combo: "Accel+Z" }
      }
    });

    expect(sidebarShortcutDuplicates(preferences.shortcuts)).toEqual([
      { combo: "Accel+Z", actions: ["search", "undo"] }
    ]);
    expect(validateAppPreferences(preferences)).toEqual(["Shortcut Accel+Z is assigned more than once."]);
  });

  it("matches default accelerators and shifted zoom aliases", () => {
    expect(
      shortcutMatchesEvent(DEFAULT_APP_PREFERENCES.shortcuts.undo, {
        key: "z",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false
      })
    ).toBe(true);
    expect(
      shortcutMatchesEvent(DEFAULT_APP_PREFERENCES.shortcuts.zoomIn, {
        key: "+",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: true
      })
    ).toBe(true);
    expect(
      shortcutMatchesEvent({ enabled: false, combo: "Accel+Z" }, {
        key: "z",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false
      })
    ).toBe(false);
  });
});
