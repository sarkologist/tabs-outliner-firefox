export const APP_PREFERENCES_STORAGE_KEY = "tabsOutlinerPreferences";
export const MIN_UNDO_HISTORY_LIMIT = 1;
export const MAX_UNDO_HISTORY_LIMIT = 200;
export const DEFAULT_UNDO_HISTORY_LIMIT = 20;

export type SidebarShortcutAction =
  | "search"
  | "undo"
  | "redo"
  | "redoAlternate"
  | "cut"
  | "paste"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset";

export type ShortcutPreference = {
  enabled: boolean;
  combo: string;
};

export type AutomaticBackupPreferences = {
  enabled: boolean;
};

export type AppPreferences = {
  version: 1;
  undoHistoryLimit: number;
  automaticBackups: AutomaticBackupPreferences;
  shortcuts: Record<SidebarShortcutAction, ShortcutPreference>;
};

export type ShortcutKeyboardEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

export type SidebarShortcutDuplicate = {
  combo: string;
  actions: SidebarShortcutAction[];
};

export const SIDEBAR_SHORTCUT_DEFINITIONS: Array<{
  action: SidebarShortcutAction;
  label: string;
  defaultCombo: string;
}> = [
  { action: "search", label: "Focus search", defaultCombo: "Accel+F" },
  { action: "undo", label: "Undo", defaultCombo: "Accel+Z" },
  { action: "redo", label: "Redo", defaultCombo: "Accel+Shift+Z" },
  { action: "redoAlternate", label: "Redo alternate", defaultCombo: "Accel+Y" },
  { action: "cut", label: "Cut outline item", defaultCombo: "Accel+X" },
  { action: "paste", label: "Paste after item", defaultCombo: "Accel+V" },
  { action: "zoomIn", label: "Zoom in", defaultCombo: "Accel+=" },
  { action: "zoomOut", label: "Zoom out", defaultCombo: "Accel+-" },
  { action: "zoomReset", label: "Reset zoom", defaultCombo: "Accel+0" }
];

export const SIDEBAR_SHORTCUT_ACTIONS = SIDEBAR_SHORTCUT_DEFINITIONS.map(({ action }) => action);

export const DEFAULT_SIDEBAR_SHORTCUTS = Object.freeze(
  Object.fromEntries(
    SIDEBAR_SHORTCUT_DEFINITIONS.map(({ action, defaultCombo }) => [
      action,
      Object.freeze({ enabled: true, combo: defaultCombo })
    ])
  ) as Record<SidebarShortcutAction, ShortcutPreference>
);

export const DEFAULT_AUTOMATIC_BACKUPS: AutomaticBackupPreferences = Object.freeze({
  enabled: false
});

export const DEFAULT_APP_PREFERENCES: AppPreferences = Object.freeze({
  version: 1,
  undoHistoryLimit: DEFAULT_UNDO_HISTORY_LIMIT,
  automaticBackups: DEFAULT_AUTOMATIC_BACKUPS,
  shortcuts: DEFAULT_SIDEBAR_SHORTCUTS
});

type ParsedShortcutCombo = {
  accel: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
};

export async function loadAppPreferences(
  api: WebExtensionBrowser = browser
): Promise<AppPreferences> {
  const stored = await api.storage.local.get(APP_PREFERENCES_STORAGE_KEY);
  return normalizeAppPreferences(stored[APP_PREFERENCES_STORAGE_KEY]);
}

export async function saveAppPreferences(
  preferences: AppPreferences,
  api: WebExtensionBrowser = browser
): Promise<void> {
  await api.storage.local.set({
    [APP_PREFERENCES_STORAGE_KEY]: normalizeAppPreferences(preferences)
  });
}

export function normalizeAppPreferences(value: unknown): AppPreferences {
  if (!isRecord(value) || value.version !== 1) {
    return cloneAppPreferences(DEFAULT_APP_PREFERENCES);
  }

  return {
    version: 1,
    undoHistoryLimit: normalizeUndoHistoryLimit(value.undoHistoryLimit),
    automaticBackups: normalizeAutomaticBackups(value.automaticBackups),
    shortcuts: normalizeSidebarShortcuts(value.shortcuts)
  };
}

export function normalizeUndoHistoryLimit(value: unknown): number {
  const limit =
    typeof value === "number" && Number.isFinite(value)
      ? Math.trunc(value)
      : DEFAULT_UNDO_HISTORY_LIMIT;
  return Math.min(MAX_UNDO_HISTORY_LIMIT, Math.max(MIN_UNDO_HISTORY_LIMIT, limit));
}

export function normalizeSidebarShortcuts(
  value: unknown
): Record<SidebarShortcutAction, ShortcutPreference> {
  const source = isRecord(value) ? value : {};
  return Object.fromEntries(
    SIDEBAR_SHORTCUT_DEFINITIONS.map(({ action, defaultCombo }) => {
      const candidate = source[action];
      if (!isRecord(candidate)) {
        return [action, { enabled: true, combo: defaultCombo }];
      }
      const combo = normalizeShortcutCombo(candidate.combo);
      return [
        action,
        {
          enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : true,
          combo: combo || defaultCombo
        }
      ];
    })
  ) as Record<SidebarShortcutAction, ShortcutPreference>;
}

export function normalizeAutomaticBackups(value: unknown): AutomaticBackupPreferences {
  const source = isRecord(value) ? value : {};
  return {
    enabled:
      typeof source.enabled === "boolean" ? source.enabled : DEFAULT_AUTOMATIC_BACKUPS.enabled
  };
}

export function normalizeShortcutCombo(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const rawTokens = value
    .trim()
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean);
  if (rawTokens.length === 0) {
    return "";
  }

  let accel = false;
  let alt = false;
  let shift = false;
  let key = "";
  for (const rawToken of rawTokens) {
    const token = rawToken.toLocaleLowerCase();
    if (["accel", "ctrl", "control", "cmd", "command", "meta"].includes(token)) {
      accel = true;
    } else if (["alt", "option"].includes(token)) {
      alt = true;
    } else if (token === "shift") {
      shift = true;
    } else if (!key) {
      key = normalizeShortcutKey(rawToken);
    } else {
      return "";
    }
  }

  if (!key) {
    return "";
  }

  return [
    ...(accel ? ["Accel"] : []),
    ...(alt ? ["Alt"] : []),
    ...(shift ? ["Shift"] : []),
    key
  ].join("+");
}

export function comboFromKeyboardEvent(event: ShortcutKeyboardEvent): string {
  const key = normalizeShortcutKey(event.key);
  if (!key || key === "Control" || key === "Meta" || key === "Shift" || key === "Alt") {
    return "";
  }

  return [
    ...(event.ctrlKey || event.metaKey ? ["Accel"] : []),
    ...(event.altKey ? ["Alt"] : []),
    ...(event.shiftKey && !isShiftedKeyAliasCandidate(key) ? ["Shift"] : []),
    unshiftedAliasKey(key) ?? key
  ].join("+");
}

export function shortcutMatchesEvent(
  preference: ShortcutPreference,
  event: ShortcutKeyboardEvent
): boolean {
  if (!preference.enabled) {
    return false;
  }
  const parsed = parseShortcutCombo(preference.combo);
  if (!parsed) {
    return false;
  }

  const eventKey = normalizeShortcutKey(event.key);
  const shiftedAlias = !parsed.shift && event.shiftKey && isShiftedAlias(parsed.key, eventKey);
  return (
    parsed.accel === (event.ctrlKey || event.metaKey) &&
    parsed.alt === event.altKey &&
    (parsed.shift === event.shiftKey || shiftedAlias) &&
    (parsed.key === eventKey || isShiftedAlias(parsed.key, eventKey))
  );
}

export function sidebarShortcutDuplicates(
  shortcuts: Record<SidebarShortcutAction, ShortcutPreference>
): SidebarShortcutDuplicate[] {
  const actionsByCombo = new Map<string, SidebarShortcutAction[]>();
  for (const action of SIDEBAR_SHORTCUT_ACTIONS) {
    const shortcut = shortcuts[action];
    if (!shortcut?.enabled) {
      continue;
    }
    const combo = normalizeShortcutCombo(shortcut.combo);
    if (!combo) {
      continue;
    }
    actionsByCombo.set(combo, [...(actionsByCombo.get(combo) ?? []), action]);
  }

  return [...actionsByCombo.entries()]
    .filter(([, actions]) => actions.length > 1)
    .map(([combo, actions]) => ({ combo, actions }));
}

export function validateAppPreferences(preferences: AppPreferences): string[] {
  return sidebarShortcutDuplicates(preferences.shortcuts).map(
    ({ combo }) => `Shortcut ${combo} is assigned more than once.`
  );
}

function cloneAppPreferences(preferences: AppPreferences): AppPreferences {
  return {
    version: 1,
    undoHistoryLimit: preferences.undoHistoryLimit,
    automaticBackups: { ...preferences.automaticBackups },
    shortcuts: Object.fromEntries(
      SIDEBAR_SHORTCUT_ACTIONS.map((action) => [action, { ...preferences.shortcuts[action] }])
    ) as Record<SidebarShortcutAction, ShortcutPreference>
  };
}

function parseShortcutCombo(value: string): ParsedShortcutCombo | undefined {
  const combo = normalizeShortcutCombo(value);
  if (!combo) {
    return undefined;
  }

  const tokens = combo.split("+");
  const key = tokens.at(-1);
  if (!key) {
    return undefined;
  }
  return {
    accel: tokens.includes("Accel"),
    alt: tokens.includes("Alt"),
    shift: tokens.includes("Shift"),
    key
  };
}

function normalizeShortcutKey(value: string): string {
  if (value === " ") {
    return "Space";
  }
  if (value.length === 1) {
    return /[a-z]/i.test(value) ? value.toLocaleUpperCase() : value;
  }
  const lower = value.toLocaleLowerCase();
  if (lower === "esc") {
    return "Escape";
  }
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}

function isShiftedAlias(baseKey: string, eventKey: string): boolean {
  return shiftedAliases[baseKey] === eventKey;
}

function isShiftedKeyAliasCandidate(key: string): boolean {
  return Boolean(unshiftedAliasKey(key));
}

function unshiftedAliasKey(key: string): string | undefined {
  return unshiftedAliases[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const shiftedAliases: Record<string, string> = {
  "=": "+",
  "-": "_",
  "0": ")"
};

const unshiftedAliases = Object.fromEntries(
  Object.entries(shiftedAliases).map(([unshifted, shifted]) => [shifted, unshifted])
) as Record<string, string>;
