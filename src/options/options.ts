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
import {
  AUTOMATIC_BACKUP_STATUS_STORAGE_KEY,
  automaticBackupStatusText,
  loadAutomaticBackupStatus,
  normalizeAutomaticBackupStatus,
  type AutomaticBackupStatus
} from "../background/backups.js";
import {
  PROFILE_STORAGE_KEY,
  createPerformanceProfileExport,
  downloadPerformanceProfileExport,
  isPerformanceProfileSnapshot,
  performanceProfileEnabled,
  performanceProfileEntryCount,
  type PerformanceProfileSnapshot
} from "../perf/profile.js";
import {
  INCIDENT_LOG_STORAGE_KEY,
  loadIncidentLog,
  type IncidentLogEntry
} from "../background/incident-log.js";
import {
  describeWriteLogEntry,
  normalizeWriteLogEntries,
  summarizeWriteLog,
  type WriteLogEntry,
  type WriteLogHealth,
  type WriteLogSeverity
} from "../background/write-log.js";

const TOGGLE_SIDEBAR_COMMAND = "toggle-sidebar";
const SVG_NS = "http://www.w3.org/2000/svg";

const SHORTCUT_ICON_BY_ACTION: Record<SidebarShortcutAction, string> = {
  search: "search",
  undo: "undo",
  redo: "redo",
  redoAlternate: "redo",
  cut: "scissors",
  paste: "clipboard",
  zoomIn: "zoom-in",
  zoomOut: "zoom-out",
  zoomReset: "zoom-reset"
};

type IncidentSeverity = "error" | "warning" | "info";

// Viewer-side classification for the background page's incident events (see
// recordIncidentLog call sites in src/background/controller.ts). Anything not
// listed renders as neutral "info", so a newly added event is never hidden.
const INCIDENT_SEVERITY_BY_EVENT: Record<string, IncidentSeverity> = {
  v4MigrationFailed: "error",
  v4MigrationDeferredDegradedLoad: "error",
  stateSaveFailed: "error",
  automaticBackupFailure: "error",
  v4LoadRecovery: "warning",
  v3LoadSalvaged: "warning",
  // No longer produced (v2 reads were removed); kept so entries persisted by
  // older versions still render with the right severity.
  staleV2FallbackUsed: "warning",
  bootstrapSkippedStoredDataPresent: "warning",
  bootstrapProvenanceRecovered: "warning",
  legacyKeysRetainedWithoutMigrationEvidence: "warning",
  lifecycleJournalRecovery: "warning",
  saveFlushAnomaly: "warning",
  closedSubtreeGuardRestore: "warning",
  storageLoadStructureRepair: "warning",
  journalSpillGap: "warning"
};

const form = document.querySelector<HTMLFormElement>("#options-form");
const undoHistoryLimit = document.querySelector<HTMLInputElement>("#undo-history-limit");
const automaticBackupsEnabled = document.querySelector<HTMLInputElement>(
  "#automatic-backups-enabled"
);
const backupStatus = document.querySelector<HTMLElement>("#backup-status");
const shortcutList = document.querySelector<HTMLOListElement>("#shortcut-list");
const globalShortcut = document.querySelector<HTMLButtonElement>("#global-shortcut");
const clearGlobalShortcut = document.querySelector<HTMLButtonElement>("#clear-global-shortcut");
const resetDefaults = document.querySelector<HTMLButtonElement>("#reset-defaults");
const errors = document.querySelector<HTMLElement>("#errors");
const saveStatus = document.querySelector<HTMLElement>("#save-status");
const profileStart = document.querySelector<HTMLButtonElement>("#profile-start");
const profileStop = document.querySelector<HTMLButtonElement>("#profile-stop");
const profileReset = document.querySelector<HTMLButtonElement>("#profile-reset");
const profileExport = document.querySelector<HTMLButtonElement>("#profile-export");
const profileStatus = document.querySelector<HTMLElement>("#profile-status");
const incidentRefresh = document.querySelector<HTMLButtonElement>("#incident-refresh");
const incidentSummary = document.querySelector<HTMLElement>("#incident-summary");
const incidentList = document.querySelector<HTMLOListElement>("#incident-list");
const writeLogHealth = document.querySelector<HTMLElement>("#write-log-health");
const writeLogChangesList = document.querySelector<HTMLOListElement>("#write-log-changes");
const writeLogStorageList = document.querySelector<HTMLOListElement>("#write-log-storage");
const writeLogRefresh = document.querySelector<HTMLButtonElement>("#write-log-refresh");
const writeLogClear = document.querySelector<HTMLButtonElement>("#write-log-clear");
const writeLogLive = document.querySelector<HTMLInputElement>("#write-log-live");

const WRITE_LOG_POLL_INTERVAL_MS = 1500;

type RecordingTarget =
  | {
      type: "sidebar";
      action: SidebarShortcutAction;
    }
  | {
      type: "global";
    };

let preferences: AppPreferences = DEFAULT_APP_PREFERENCES;
let automaticBackupStatus: AutomaticBackupStatus = {};
let nativeSidebarShortcut = "";
let recordingTarget: RecordingTarget | undefined;
let writeLogEntries: WriteLogEntry[] = [];
let writeLogRenderedSeq = -1;
let writeLogPollTimer: number | undefined;
// Monotonic token so a slow in-flight getWriteLog response can never render after a newer
// refresh/clear has superseded it (out-of-order completion).
let writeLogRequestSeq = 0;

void initializeOptions();

async function initializeOptions(): Promise<void> {
  [preferences, automaticBackupStatus] = await Promise.all([
    loadAppPreferences().catch(() => DEFAULT_APP_PREFERENCES),
    loadAutomaticBackupStatus().catch(() => ({}))
  ]);
  nativeSidebarShortcut = await loadNativeSidebarShortcut();
  renderOptions();
  registerEvents();
  void refreshPerformanceProfileStatus();
  void refreshIncidentLog();
  void refreshWriteLog();
  startWriteLogPolling();
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

  automaticBackupsEnabled?.addEventListener("change", () => {
    preferences = normalizeAppPreferences({
      ...preferences,
      automaticBackups: {
        ...preferences.automaticBackups,
        enabled: automaticBackupsEnabled.checked
      }
    });
    renderBackupStatus();
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

  profileStart?.addEventListener("click", () => {
    void startPerformanceProfile();
  });

  profileStop?.addEventListener("click", () => {
    void stopPerformanceProfile();
  });

  profileReset?.addEventListener("click", () => {
    void resetPerformanceProfile();
  });

  profileExport?.addEventListener("click", () => {
    void exportPerformanceProfile();
  });

  incidentRefresh?.addEventListener("click", () => {
    void refreshIncidentLog();
  });

  writeLogRefresh?.addEventListener("click", () => {
    void refreshWriteLog();
  });

  writeLogClear?.addEventListener("click", () => {
    void clearWriteLog();
  });

  writeLogLive?.addEventListener("change", () => {
    if (writeLogLive.checked) {
      startWriteLogPolling();
      void refreshWriteLog();
    } else {
      stopWriteLogPolling();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopWriteLogPolling();
    } else {
      startWriteLogPolling();
      void refreshWriteLog();
    }
  });

  document.addEventListener(
    "keydown",
    (event) => {
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
    },
    { capture: true }
  );

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }
    if (changes[AUTOMATIC_BACKUP_STATUS_STORAGE_KEY]) {
      automaticBackupStatus = normalizeAutomaticBackupStatus(
        changes[AUTOMATIC_BACKUP_STATUS_STORAGE_KEY].newValue
      );
      renderBackupStatus();
    }
    if (changes[INCIDENT_LOG_STORAGE_KEY]) {
      void refreshIncidentLog();
    }
  });
}

function renderOptions(): void {
  if (undoHistoryLimit) {
    undoHistoryLimit.min = String(MIN_UNDO_HISTORY_LIMIT);
    undoHistoryLimit.max = String(MAX_UNDO_HISTORY_LIMIT);
    undoHistoryLimit.value = String(preferences.undoHistoryLimit);
  }

  renderShortcutRows();
  renderGlobalShortcut();
  renderBackups();
}

function renderBackups(): void {
  if (automaticBackupsEnabled) {
    automaticBackupsEnabled.checked = preferences.automaticBackups.enabled;
  }
  renderBackupStatus();
}

function renderBackupStatus(): void {
  if (backupStatus) {
    backupStatus.textContent = automaticBackupStatusText(
      automaticBackupStatus,
      preferences.automaticBackups.enabled
    );
  }
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
      labelText.append(iconElement(SHORTCUT_ICON_BY_ACTION[action]), textSpan(label));

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

function iconElement(icon: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("label-icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#icon-${icon}`);
  svg.append(use);
  return svg;
}

function textSpan(text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}

function renderGlobalShortcut(): void {
  if (!globalShortcut) {
    return;
  }
  globalShortcut.textContent =
    recordingTarget?.type === "global" ? "Press keys" : comboLabel(nativeSidebarShortcut);
  globalShortcut.classList.toggle("is-recording", recordingTarget?.type === "global");
}

async function saveOptions(): Promise<void> {
  const nextPreferences = normalizeAppPreferences({
    ...preferences,
    undoHistoryLimit: undoHistoryLimit?.valueAsNumber,
    automaticBackups: {
      ...preferences.automaticBackups,
      enabled: automaticBackupsEnabled?.checked ?? preferences.automaticBackups.enabled
    }
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

async function startPerformanceProfile(): Promise<void> {
  try {
    clearErrors();
    storeProfileEnabled(true);
    await browser.runtime.sendMessage({ type: "setPerformanceTraceEnabled", enabled: true });
    await refreshPerformanceProfileStatus();
  } catch {
    showProfileStatus("Profile unavailable");
  }
}

async function stopPerformanceProfile(): Promise<void> {
  try {
    clearErrors();
    storeProfileEnabled(false);
    await browser.runtime.sendMessage({ type: "setPerformanceTraceEnabled", enabled: false });
    await refreshPerformanceProfileStatus();
  } catch {
    showProfileStatus("Profile unavailable");
  }
}

async function resetPerformanceProfile(): Promise<void> {
  try {
    clearErrors();
    await browser.runtime.sendMessage({ type: "clearPerformanceTrace" });
    showProfileStatus("Profile reset");
  } catch {
    showProfileStatus("Profile unavailable");
  }
}

async function exportPerformanceProfile(): Promise<void> {
  try {
    clearErrors();
    const snapshot = await loadPerformanceProfile();
    downloadPerformanceProfileExport(createPerformanceProfileExport(snapshot));
    showProfileStatus("Profile exported");
  } catch {
    showProfileStatus("Profile unavailable");
  }
}

async function refreshPerformanceProfileStatus(): Promise<void> {
  const snapshot = await loadPerformanceProfile().catch(() => undefined);
  if (snapshot) {
    showProfileStatus(performanceProfileStatusText(snapshot));
    return;
  }
  showProfileStatus(`${storedProfileEnabled() ? "Running" : "Stopped"} · 0 entries`);
}

async function loadPerformanceProfile(): Promise<PerformanceProfileSnapshot> {
  const response = await browser.runtime
    .sendMessage({ type: "getPerformanceProfile" })
    .catch(() => undefined);
  if (!isPerformanceProfileSnapshot(response)) {
    throw new Error("Profile unavailable");
  }
  return response;
}

function performanceProfileStatusText(snapshot: PerformanceProfileSnapshot): string {
  const label = performanceProfileEnabled(snapshot) ? "Running" : "Stopped";
  const count = performanceProfileEntryCount(snapshot);
  return `${label} · ${count} ${count === 1 ? "entry" : "entries"}`;
}

function storedProfileEnabled(): boolean {
  return window.localStorage.getItem(PROFILE_STORAGE_KEY) === "true";
}

function storeProfileEnabled(enabled: boolean): void {
  if (enabled) {
    window.localStorage.setItem(PROFILE_STORAGE_KEY, "true");
  } else {
    window.localStorage.removeItem(PROFILE_STORAGE_KEY);
  }
}

function showProfileStatus(message: string): void {
  if (profileStatus) {
    profileStatus.textContent = message;
  }
}

async function refreshIncidentLog(): Promise<void> {
  const entries = await loadIncidentLog().catch(() => [] as IncidentLogEntry[]);
  renderIncidentLog(entries);
}

function renderIncidentLog(entries: IncidentLogEntry[]): void {
  if (incidentSummary) {
    incidentSummary.textContent = incidentSummaryText(entries);
  }
  if (!incidentList) {
    return;
  }
  if (entries.length === 0) {
    incidentList.replaceChildren(incidentEmptyRow());
    return;
  }
  // Newest first: entries are appended chronologically in storage.
  incidentList.replaceChildren(...[...entries].reverse().map(incidentRow));
}

function incidentSummaryText(entries: IncidentLogEntry[]): string {
  if (entries.length === 0) {
    return "No incidents recorded.";
  }
  let errorCount = 0;
  let warningCount = 0;
  for (const entry of entries) {
    const severity = incidentSeverity(entry.event);
    if (severity === "error") {
      errorCount += 1;
    } else if (severity === "warning") {
      warningCount += 1;
    }
  }
  const parts = [`${entries.length} ${entries.length === 1 ? "incident" : "incidents"}`];
  if (errorCount > 0) {
    parts.push(`${errorCount} ${errorCount === 1 ? "error" : "errors"}`);
  }
  if (warningCount > 0) {
    parts.push(`${warningCount} ${warningCount === 1 ? "warning" : "warnings"}`);
  }
  return parts.join(" · ");
}

function incidentRow(entry: IncidentLogEntry): HTMLLIElement {
  const row = document.createElement("li");
  row.className = `incident-row is-${incidentSeverity(entry.event)}`;

  const header = document.createElement("div");
  header.className = "incident-header";

  const event = document.createElement("span");
  event.className = "incident-event";
  event.textContent = entry.event;

  const time = document.createElement("time");
  time.className = "incident-time";
  time.dateTime = entry.at;
  time.title = entry.at;
  time.textContent = incidentTimeLabel(entry.at);

  header.append(event, time);
  row.append(header);

  const detail = incidentDetailText(entry.detail);
  if (detail) {
    const detailLine = document.createElement("p");
    detailLine.className = "incident-detail";
    detailLine.textContent = detail;
    row.append(detailLine);
  }
  return row;
}

function incidentEmptyRow(): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "incident-empty";
  row.textContent = "Nothing logged yet — startup and migration events appear here.";
  return row;
}

function incidentSeverity(event: string): IncidentSeverity {
  return INCIDENT_SEVERITY_BY_EVENT[event] ?? "info";
}

function incidentTimeLabel(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
}

function incidentDetailText(detail: IncidentLogEntry["detail"]): string {
  if (!detail) {
    return "";
  }
  return Object.entries(detail)
    .map(([key, value]) => `${key}=${value}`)
    .join(" · ");
}

async function refreshWriteLog(): Promise<void> {
  const requestId = (writeLogRequestSeq += 1);
  const entries = await loadWriteLog();
  // Drop a response superseded by a newer refresh/clear so a slow getWriteLog can't render stale
  // rows (or undo a clear) after it.
  if (requestId !== writeLogRequestSeq) {
    return;
  }
  const latestSeq = entries.length > 0 ? entries[entries.length - 1]!.seq : 0;
  // Skip the re-render (and the scroll reset it causes) when nothing new has been recorded.
  if (entries.length === writeLogEntries.length && latestSeq === writeLogRenderedSeq) {
    return;
  }
  writeLogEntries = entries;
  writeLogRenderedSeq = latestSeq;
  renderWriteLog(entries);
}

async function clearWriteLog(): Promise<void> {
  await browser.runtime.sendMessage({ type: "clearWriteLog" }).catch(() => undefined);
  await refreshWriteLog();
}

async function loadWriteLog(): Promise<WriteLogEntry[]> {
  const response = await browser.runtime
    .sendMessage({ type: "getWriteLog" })
    .catch(() => undefined);
  return normalizeWriteLogEntries(response);
}

function startWriteLogPolling(): void {
  stopWriteLogPolling();
  if (!(writeLogLive?.checked ?? true) || document.hidden) {
    return;
  }
  // A light poll keeps the view live; messaging the background also keeps its event page awake
  // while the user is watching, so the in-memory log is not wiped mid-session.
  writeLogPollTimer = window.setInterval(() => {
    void refreshWriteLog();
  }, WRITE_LOG_POLL_INTERVAL_MS);
}

function stopWriteLogPolling(): void {
  if (writeLogPollTimer !== undefined) {
    window.clearInterval(writeLogPollTimer);
    writeLogPollTimer = undefined;
  }
}

function renderWriteLog(entries: WriteLogEntry[]): void {
  const health = summarizeWriteLog(entries);
  if (writeLogHealth) {
    writeLogHealth.textContent = writeLogHealthText(health);
    const severity = writeLogHealthSeverity(health);
    writeLogHealth.classList.toggle("is-ok", severity === "ok");
    writeLogHealth.classList.toggle("is-warn", severity === "warn");
    writeLogHealth.classList.toggle("is-error", severity === "error");
  }
  // Two separate lists: domain-level changes vs storage-diagnostic events.
  const changes = entries.filter((entry) => entry.kind === "change");
  const storage = entries.filter((entry) => entry.kind !== "change");
  renderWriteLogList(writeLogChangesList, changes, "No changes recorded yet.", writeLogChangeRow);
  renderWriteLogList(writeLogStorageList, storage, "No storage activity yet.", writeLogRow);
}

function renderWriteLogList(
  list: HTMLOListElement | null,
  entries: WriteLogEntry[],
  emptyText: string,
  row: (entry: WriteLogEntry) => HTMLLIElement
): void {
  if (!list) {
    return;
  }
  if (entries.length === 0) {
    list.replaceChildren(writeLogEmptyRow(emptyText));
    return;
  }
  // Newest first: entries are appended chronologically.
  list.replaceChildren(...[...entries].reverse().map(row));
}

function writeLogHealthText(health: WriteLogHealth): string {
  if (health.total === 0) {
    return "No write activity yet — perform an action and it will appear here.";
  }
  const parts: string[] = [];
  if (health.nodeCount !== undefined) {
    parts.push(`${health.nodeCount.toLocaleString("en-US")} nodes`);
  }
  if (health.closedCount !== undefined) {
    parts.push(`${health.closedCount.toLocaleString("en-US")} closed`);
  }
  if (health.lastSaveAt) {
    parts.push(`last save ${writeLogTimeLabel(health.lastSaveAt)}`);
  }
  if (health.pendingJournalCount !== undefined) {
    parts.push(
      health.pendingJournalCount === 0
        ? "snapshot covers the journal"
        : `${health.pendingJournalCount} journaled, awaiting snapshot`
    );
  }
  parts.push(
    health.errorCount === 0
      ? "no errors"
      : `${health.errorCount} ${health.errorCount === 1 ? "error" : "errors"}`
  );
  if (health.spillCount > 0) {
    parts.push(`${health.spillCount} ${health.spillCount === 1 ? "spill" : "spills"}`);
  }
  return parts.join(" · ");
}

function writeLogHealthSeverity(health: WriteLogHealth): WriteLogSeverity | "neutral" {
  if (health.total === 0) {
    return "neutral";
  }
  if (health.errorCount > 0) {
    return "error";
  }
  if (
    health.spillCount > 0 ||
    (health.lastNodeDelta ?? 0) <= -50 ||
    (health.lastClosedDelta ?? 0) <= -25
  ) {
    return "warn";
  }
  return "ok";
}

function writeLogRow(entry: WriteLogEntry): HTMLLIElement {
  const { title, severity, detailText } = describeWriteLogEntry(entry);
  const row = document.createElement("li");
  row.className = `write-log-row is-${severity}`;

  const header = document.createElement("div");
  header.className = "write-log-row-header";

  const titleEl = document.createElement("span");
  titleEl.className = "write-log-title";
  titleEl.textContent = title;

  const time = document.createElement("time");
  time.className = "write-log-time";
  time.dateTime = entry.at;
  time.title = entry.at;
  time.textContent = writeLogTimeLabel(entry.at);

  header.append(titleEl, time);
  row.append(header);

  if (detailText) {
    const detail = document.createElement("p");
    detail.className = "write-log-detail";
    detail.textContent = detailText;
    row.append(detail);
  }
  return row;
}

function writeLogChangeRow(entry: WriteLogEntry): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "write-log-row write-log-change";

  const header = document.createElement("div");
  header.className = "write-log-row-header";

  const titleEl = document.createElement("span");
  titleEl.className = "write-log-title";
  titleEl.textContent = entry.change?.headline ?? "Change";

  const time = document.createElement("time");
  time.className = "write-log-time";
  time.dateTime = entry.at;
  time.title = entry.at;
  time.textContent = writeLogTimeLabel(entry.at);

  header.append(titleEl, time);
  row.append(header);

  const lines = entry.change?.lines ?? [];
  if (lines.length > 0) {
    const list = document.createElement("ul");
    list.className = "write-log-nodes";
    for (const line of lines) {
      const item = document.createElement("li");
      item.textContent = line;
      list.append(item);
    }
    if (entry.change && entry.change.overflow > 0) {
      const more = document.createElement("li");
      more.className = "write-log-nodes-more";
      more.textContent = `…and ${entry.change.overflow} more`;
      list.append(more);
    }
    row.append(list);
  }
  return row;
}

function writeLogEmptyRow(text: string): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "write-log-empty";
  row.textContent = text;
  return row;
}

function writeLogTimeLabel(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleTimeString();
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
