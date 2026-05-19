import {
  DEFAULT_APP_PREFERENCES,
  MAX_UNDO_HISTORY_LIMIT,
  MIN_UNDO_HISTORY_LIMIT,
  SIDEBAR_SHORTCUT_DEFINITIONS,
  comboFromKeyboardEvent,
  loadAppPreferences,
  normalizeAppPreferences,
  normalizeShortcutCombo,
  saveAppPreferences,
  validateAppPreferences,
  type AppPreferences,
  type SidebarShortcutAction
} from "../preferences.js";

const TOGGLE_SIDEBAR_COMMAND = "toggle-sidebar";

const form = document.querySelector<HTMLFormElement>("#options-form");
const undoHistoryLimit = document.querySelector<HTMLInputElement>("#undo-history-limit");
const shortcutList = document.querySelector<HTMLOListElement>("#shortcut-list");
const globalShortcut = document.querySelector<HTMLButtonElement>("#global-shortcut");
const clearGlobalShortcut = document.querySelector<HTMLButtonElement>("#clear-global-shortcut");
const resetDefaults = document.querySelector<HTMLButtonElement>("#reset-defaults");
const errors = document.querySelector<HTMLElement>("#errors");
const saveStatus = document.querySelector<HTMLElement>("#save-status");

type RecordingTarget =
  | {
      type: "sidebar";
      action: SidebarShortcutAction;
    }
  | {
      type: "global";
    };

let preferences: AppPreferences = DEFAULT_APP_PREFERENCES;
let nativeSidebarShortcut = "";
let recordingTarget: RecordingTarget | undefined;

void initializeOptions();

async function initializeOptions(): Promise<void> {
  preferences = await loadAppPreferences().catch(() => DEFAULT_APP_PREFERENCES);
  nativeSidebarShortcut = await loadNativeSidebarShortcut();
  renderOptions();
  registerEvents();
}

function registerEvents(): void {
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveOptions();
  });

  undoHistoryLimit?.addEventListener("input", () => {
    preferences = normalizeAppPreferences({
      ...preferences,
      undoHistoryLimit: undoHistoryLimit.valueAsNumber
    });
    showStatus("");
  });

  shortcutList?.addEventListener("change", (event) => {
    const input = event.target instanceof HTMLInputElement ? event.target : undefined;
    if (!input) {
      return;
    }
    const action = input.dataset.shortcutEnabled as SidebarShortcutAction | undefined;
    if (!action) {
      return;
    }
    preferences = normalizeAppPreferences({
      ...preferences,
      shortcuts: {
        ...preferences.shortcuts,
        [action]: {
          ...preferences.shortcuts[action],
          enabled: input.checked
        }
      }
    });
    showStatus("");
  });

  shortcutList?.addEventListener("click", (event) => {
    const button = event.target instanceof HTMLButtonElement ? event.target : undefined;
    if (!button) {
      return;
    }
    const recordAction = button.dataset.recordShortcut as SidebarShortcutAction | undefined;
    if (recordAction) {
      startRecording({ type: "sidebar", action: recordAction });
      return;
    }

    const resetAction = button.dataset.resetShortcut as SidebarShortcutAction | undefined;
    if (resetAction) {
      resetSidebarShortcut(resetAction);
    }
  });

  globalShortcut?.addEventListener("click", () => {
    startRecording({ type: "global" });
  });

  clearGlobalShortcut?.addEventListener("click", () => {
    nativeSidebarShortcut = "";
    recordingTarget = undefined;
    renderOptions();
    showStatus("");
  });

  resetDefaults?.addEventListener("click", () => {
    preferences = normalizeAppPreferences(DEFAULT_APP_PREFERENCES);
    nativeSidebarShortcut = "";
    recordingTarget = undefined;
    renderOptions();
    showStatus("Defaults restored");
  });

  document.addEventListener("keydown", (event) => {
    if (!recordingTarget) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      recordingTarget = undefined;
      renderOptions();
      showStatus("");
      return;
    }

    if (recordingTarget.type === "sidebar") {
      const combo = comboFromKeyboardEvent(event);
      if (!combo) {
        showStatus("Press another key");
        return;
      }
      preferences = normalizeAppPreferences({
        ...preferences,
        shortcuts: {
          ...preferences.shortcuts,
          [recordingTarget.action]: {
            ...preferences.shortcuts[recordingTarget.action],
            combo
          }
        }
      });
    } else {
      const shortcut = nativeCommandShortcutFromEvent(event);
      if (!shortcut) {
        showStatus("Press another key");
        return;
      }
      nativeSidebarShortcut = shortcut;
    }

    recordingTarget = undefined;
    renderOptions();
    showStatus("");
  }, { capture: true });
}

function renderOptions(): void {
  if (undoHistoryLimit) {
    undoHistoryLimit.min = String(MIN_UNDO_HISTORY_LIMIT);
    undoHistoryLimit.max = String(MAX_UNDO_HISTORY_LIMIT);
    undoHistoryLimit.value = String(preferences.undoHistoryLimit);
  }

  renderShortcutRows();
  renderGlobalShortcut();
}

function renderShortcutRows(): void {
  if (!shortcutList) {
    return;
  }

  shortcutList.replaceChildren(
    ...SIDEBAR_SHORTCUT_DEFINITIONS.map(({ action, label }) => {
      const row = document.createElement("li");
      row.className = "shortcut-row";

      const labelText = document.createElement("span");
      labelText.className = "shortcut-label";
      labelText.textContent = label;

      const enabled = document.createElement("input");
      enabled.className = "shortcut-enabled";
      enabled.type = "checkbox";
      enabled.checked = preferences.shortcuts[action].enabled;
      enabled.dataset.shortcutEnabled = action;
      enabled.setAttribute("aria-label", `Enable ${label} shortcut`);

      const combo = document.createElement("button");
      combo.className = "combo-button";
      combo.type = "button";
      combo.dataset.recordShortcut = action;
      combo.dataset.testid = `shortcut-combo-${action}`;
      combo.setAttribute("aria-label", `Record ${label} shortcut`);
      combo.textContent = comboLabel(preferences.shortcuts[action].combo);
      if (recordingTarget?.type === "sidebar" && recordingTarget.action === action) {
        combo.classList.add("is-recording");
        combo.textContent = "Press keys";
      }

      const reset = document.createElement("button");
      reset.className = "secondary-button";
      reset.type = "button";
      reset.dataset.resetShortcut = action;
      reset.setAttribute("aria-label", `Reset ${label} shortcut`);
      reset.textContent = "Reset";

      row.append(labelText, enabled, combo, reset);
      return row;
    })
  );
}

function renderGlobalShortcut(): void {
  if (!globalShortcut) {
    return;
  }
  globalShortcut.textContent = recordingTarget?.type === "global"
    ? "Press keys"
    : comboLabel(nativeSidebarShortcut);
  globalShortcut.classList.toggle("is-recording", recordingTarget?.type === "global");
}

async function saveOptions(): Promise<void> {
  const nextPreferences = normalizeAppPreferences({
    ...preferences,
    undoHistoryLimit: undoHistoryLimit?.valueAsNumber
  });
  const validationErrors = validateAppPreferences(nextPreferences);
  if (validationErrors.length > 0) {
    showErrors(validationErrors);
    return;
  }

  clearErrors();
  preferences = nextPreferences;
  await saveAppPreferences(preferences);
  const shortcut = nativeSidebarShortcut.trim();
  if (shortcut) {
    await browser.commands.update({ name: TOGGLE_SIDEBAR_COMMAND, shortcut });
  } else {
    await browser.commands.reset(TOGGLE_SIDEBAR_COMMAND);
  }
  renderOptions();
  showStatus("Saved");
}

function resetSidebarShortcut(action: SidebarShortcutAction): void {
  const definition = SIDEBAR_SHORTCUT_DEFINITIONS.find((candidate) => candidate.action === action);
  if (!definition) {
    return;
  }

  preferences = normalizeAppPreferences({
    ...preferences,
    shortcuts: {
      ...preferences.shortcuts,
      [action]: {
        enabled: true,
        combo: definition.defaultCombo
      }
    }
  });
  recordingTarget = undefined;
  renderOptions();
  showStatus("");
}

function startRecording(target: RecordingTarget): void {
  recordingTarget = target;
  clearErrors();
  renderOptions();
  showStatus("Recording");
}

async function loadNativeSidebarShortcut(): Promise<string> {
  const commands = await browser.commands.getAll().catch(() => []);
  return commands.find((command) => command.name === TOGGLE_SIDEBAR_COMMAND)?.shortcut ?? "";
}

function nativeCommandShortcutFromEvent(event: KeyboardEvent): string {
  const key = nativeCommandKey(event.key);
  if (!key || ["Control", "Meta", "Shift", "Alt"].includes(key)) {
    return "";
  }

  return [
    ...(event.ctrlKey ? ["Ctrl"] : []),
    ...(event.metaKey ? ["Command"] : []),
    ...(event.altKey ? ["Alt"] : []),
    ...(event.shiftKey ? ["Shift"] : []),
    key
  ].join("+");
}

function nativeCommandKey(key: string): string {
  if (key === " ") {
    return "Space";
  }
  if (key.length === 1) {
    return /[a-z]/i.test(key) ? key.toLocaleUpperCase() : key;
  }
  return normalizeShortcutCombo(key);
}

function comboLabel(combo: string): string {
  return combo.trim() || "(unset)";
}

function showErrors(messages: string[]): void {
  if (!errors) {
    return;
  }
  errors.hidden = false;
  errors.textContent = messages.join(" ");
  showStatus("");
}

function clearErrors(): void {
  if (!errors) {
    return;
  }
  errors.hidden = true;
  errors.textContent = "";
}

function showStatus(message: string): void {
  if (saveStatus) {
    saveStatus.textContent = message;
  }
}
