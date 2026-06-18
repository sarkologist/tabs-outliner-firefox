import {
  exportPortableTree,
  portableTreeBackupFilename,
  serializePortableTreeFile
} from "../model/portable-tree.js";
import type { OutlineState } from "../model/types.js";

export const AUTOMATIC_BACKUP_ALARM_NAME = "tabs-outliner-automatic-backup";
export const AUTOMATIC_BACKUP_STATUS_STORAGE_KEY = "tabsOutlinerAutomaticBackupStatus";
export const AUTOMATIC_BACKUP_INTERVAL_MINUTES = 24 * 60;
export const AUTOMATIC_BACKUP_INTERVAL_MS = AUTOMATIC_BACKUP_INTERVAL_MINUTES * 60 * 1000;

export type AutomaticBackupStatus = {
  lastAttemptedBackupAt?: string;
  lastSuccessfulBackupAt?: string;
  lastError?: string;
};

export async function loadAutomaticBackupStatus(
  api: WebExtensionBrowser = browser
): Promise<AutomaticBackupStatus> {
  const stored = await api.storage.local.get(AUTOMATIC_BACKUP_STATUS_STORAGE_KEY);
  return normalizeAutomaticBackupStatus(stored[AUTOMATIC_BACKUP_STATUS_STORAGE_KEY]);
}

export async function saveAutomaticBackupStatus(
  status: AutomaticBackupStatus,
  api: WebExtensionBrowser = browser
): Promise<void> {
  await api.storage.local.set({
    [AUTOMATIC_BACKUP_STATUS_STORAGE_KEY]: normalizeAutomaticBackupStatus(status)
  });
}

export function normalizeAutomaticBackupStatus(value: unknown): AutomaticBackupStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const source = value as Record<string, unknown>;
  return {
    ...(typeof source.lastAttemptedBackupAt === "string"
      ? { lastAttemptedBackupAt: source.lastAttemptedBackupAt }
      : {}),
    ...(typeof source.lastSuccessfulBackupAt === "string"
      ? { lastSuccessfulBackupAt: source.lastSuccessfulBackupAt }
      : {}),
    ...(typeof source.lastError === "string" ? { lastError: source.lastError } : {})
  };
}

export function automaticBackupDue(status: AutomaticBackupStatus, now: number): boolean {
  const lastSuccessfulBackupAt = parseStoredTime(status.lastSuccessfulBackupAt);
  const lastAttemptedBackupAt = parseStoredTime(status.lastAttemptedBackupAt);
  if (
    lastAttemptedBackupAt !== undefined &&
    lastAttemptedBackupAt > (lastSuccessfulBackupAt ?? 0)
  ) {
    return now - lastAttemptedBackupAt >= AUTOMATIC_BACKUP_INTERVAL_MS;
  }
  return (
    lastSuccessfulBackupAt === undefined ||
    now - lastSuccessfulBackupAt >= AUTOMATIC_BACKUP_INTERVAL_MS
  );
}

export function nextAutomaticBackupTime(status: AutomaticBackupStatus, now: number): number {
  const lastSuccessfulBackupAt = parseStoredTime(status.lastSuccessfulBackupAt);
  const lastAttemptedBackupAt = parseStoredTime(status.lastAttemptedBackupAt);
  const anchor = Math.max(lastSuccessfulBackupAt ?? 0, lastAttemptedBackupAt ?? 0);
  if (anchor <= 0) {
    return now + AUTOMATIC_BACKUP_INTERVAL_MS;
  }
  return Math.max(now + 1, anchor + AUTOMATIC_BACKUP_INTERVAL_MS);
}

export function automaticBackupStatusText(status: AutomaticBackupStatus, enabled: boolean): string {
  if (!enabled) {
    return "Off";
  }
  if (status.lastError) {
    return `Last backup failed: ${status.lastError}`;
  }
  if (status.lastSuccessfulBackupAt) {
    return `Last backup: ${new Date(status.lastSuccessfulBackupAt).toLocaleString()}`;
  }
  return "No backups yet";
}

export async function downloadAutomaticBackup(
  state: OutlineState,
  api: WebExtensionBrowser,
  now: number
): Promise<void> {
  const date = new Date(now);
  const payload = exportPortableTree(state, { now });
  const blob = new Blob([serializePortableTreeFile(payload)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  try {
    await api.downloads.download({
      url,
      filename: portableTreeBackupFilename(date),
      saveAs: false
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function parseStoredTime(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
