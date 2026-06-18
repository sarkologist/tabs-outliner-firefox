import type { AppPreferences } from "../preferences.js";
import type { OutlineState } from "../model/types.js";
import type { PerformanceTracer } from "../perf/trace.js";
import type { IncidentLogDetail } from "./incident-log.js";
import {
  AUTOMATIC_BACKUP_ALARM_NAME,
  AUTOMATIC_BACKUP_INTERVAL_MINUTES,
  automaticBackupDue,
  downloadAutomaticBackup,
  errorText as backupErrorText,
  loadAutomaticBackupStatus,
  nextAutomaticBackupTime,
  saveAutomaticBackupStatus,
  type AutomaticBackupStatus
} from "./backups.js";

// Owns the automatic periodic backup: the alarm lifecycle (create/clear AUTOMATIC_BACKUP_ALARM_NAME)
// and the one-in-flight export run. Extracted from createBackgroundController (no behavior change) as
// a Track-B leaf cut: a self-contained state slice (the single automaticBackupInFlight promise) behind
// a small interface. The controller keeps the alarm *listener* (its backup-specific filter is the
// entry point, analogous to the sidebar onConnect listener) and delegates to handleAlarm; it calls
// configure on boot + preference-enable and disable on preference-disable.
//
// Cross-cluster reads are injected: ensureState (the tree to export), ensurePreferences (whether
// backups are enabled), waitForSchedulerIdle (don't export mid-mutation), and recordIncidentLog.
// The perf mark "background.backup.export" and the incident-log event names
// (automaticBackupStart/Success/Failure) are part of the observable contract and are preserved verbatim.

export type BackupCoordinatorDeps = {
  api: WebExtensionBrowser;
  perfTrace: PerformanceTracer;
  now: () => number;
  ensureState: () => Promise<OutlineState>;
  ensurePreferences: () => Promise<AppPreferences>;
  waitForSchedulerIdle: () => Promise<void>;
  recordIncidentLog: (event: string, detail?: IncidentLogDetail) => Promise<void>;
};

export type BackupCoordinator = {
  /** Boot / preference-enable: clear the alarm if disabled, else run-if-due/immediately and (re)schedule it. */
  configure(options?: { runIfDue?: boolean; runImmediately?: boolean }): Promise<void>;
  /** The backup alarm fired: run a backup and reschedule (or clear the alarm if backups are now disabled). */
  handleAlarm(): Promise<void>;
  /** Preference-disable: clear the scheduled backup alarm. */
  disable(): Promise<void>;
};

export function createBackupCoordinator(deps: BackupCoordinatorDeps): BackupCoordinator {
  const {
    api,
    perfTrace,
    now,
    ensureState,
    ensurePreferences,
    waitForSchedulerIdle,
    recordIncidentLog
  } = deps;

  let automaticBackupInFlight: Promise<AutomaticBackupStatus> | undefined;

  async function configure(
    options: { runIfDue?: boolean; runImmediately?: boolean } = {}
  ): Promise<void> {
    const activePreferences = await ensurePreferences();
    if (!activePreferences.automaticBackups.enabled) {
      await api.alarms.clear(AUTOMATIC_BACKUP_ALARM_NAME).catch(() => false);
      return;
    }

    let status = await loadAutomaticBackupStatus(api).catch(() => ({}));
    if (options.runImmediately || (options.runIfDue && automaticBackupDue(status, now()))) {
      status = await runBackup();
    }
    scheduleAlarm(status);
  }

  function scheduleAlarm(status: AutomaticBackupStatus): void {
    api.alarms.create(AUTOMATIC_BACKUP_ALARM_NAME, {
      when: nextAutomaticBackupTime(status, now()),
      periodInMinutes: AUTOMATIC_BACKUP_INTERVAL_MINUTES
    });
  }

  async function handleAlarm(): Promise<void> {
    const activePreferences = await ensurePreferences();
    if (!activePreferences.automaticBackups.enabled) {
      await api.alarms.clear(AUTOMATIC_BACKUP_ALARM_NAME).catch(() => false);
      return;
    }

    const status = await runBackup();
    scheduleAlarm(status);
  }

  async function disable(): Promise<void> {
    await api.alarms.clear(AUTOMATIC_BACKUP_ALARM_NAME).catch(() => false);
  }

  async function runBackup(): Promise<AutomaticBackupStatus> {
    automaticBackupInFlight ??= perfTrace
      .measureAsync("background.backup.export", async () => {
        const attemptedAtMs = now();
        const attemptedAt = new Date(attemptedAtMs).toISOString();
        const previousStatus = await loadAutomaticBackupStatus(api).catch(() => ({}));
        await recordIncidentLog("automaticBackupStart", { attemptedAt });
        try {
          await waitForSchedulerIdle();
          await downloadAutomaticBackup(await ensureState(), api, attemptedAtMs);
          const nextStatus: AutomaticBackupStatus = {
            ...previousStatus,
            lastAttemptedBackupAt: attemptedAt,
            lastSuccessfulBackupAt: attemptedAt
          };
          delete nextStatus.lastError;
          await saveAutomaticBackupStatus(nextStatus, api);
          await recordIncidentLog("automaticBackupSuccess", { attemptedAt });
          return nextStatus;
        } catch (error) {
          const nextStatus: AutomaticBackupStatus = {
            ...previousStatus,
            lastAttemptedBackupAt: attemptedAt,
            lastError: backupErrorText(error)
          };
          await saveAutomaticBackupStatus(nextStatus, api);
          await recordIncidentLog("automaticBackupFailure", {
            attemptedAt,
            error: backupErrorText(error)
          });
          return nextStatus;
        }
      })
      .finally(() => {
        automaticBackupInFlight = undefined;
      });
    return automaticBackupInFlight;
  }

  return { configure, handleAlarm, disable };
}
