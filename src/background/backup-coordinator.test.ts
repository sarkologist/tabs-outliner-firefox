import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The backup primitives (download/load/save/due/next-time) have their own coverage in
// backups.test.ts; here we mock them to test the coordinator's orchestration: the
// enabled/disabled branches, run-if-due vs run-immediately, alarm scheduling/clearing, the
// single-in-flight guard, and the exact incident-log event names (which are persisted).
vi.mock("./backups.js", () => ({
  AUTOMATIC_BACKUP_ALARM_NAME: "tabs-outliner-automatic-backup",
  AUTOMATIC_BACKUP_INTERVAL_MINUTES: 1440,
  automaticBackupDue: vi.fn(() => false),
  downloadAutomaticBackup: vi.fn(),
  loadAutomaticBackupStatus: vi.fn(),
  nextAutomaticBackupTime: vi.fn(() => 9999),
  saveAutomaticBackupStatus: vi.fn(),
  errorText: (error: unknown) => (error instanceof Error ? error.message : String(error))
}));

import { createBackupCoordinator, type BackupCoordinatorDeps } from "./backup-coordinator.js";
import {
  AUTOMATIC_BACKUP_ALARM_NAME,
  AUTOMATIC_BACKUP_INTERVAL_MINUTES,
  automaticBackupDue,
  downloadAutomaticBackup,
  loadAutomaticBackupStatus,
  nextAutomaticBackupTime,
  saveAutomaticBackupStatus
} from "./backups.js";
import { createPerformanceTracer } from "../perf/trace.js";

type IncidentEntry = { event: string; detail: unknown };

function createHarness(overrides: { enabled?: boolean } & Partial<BackupCoordinatorDeps> = {}) {
  const { enabled = true, ...depOverrides } = overrides;
  const incidents: IncidentEntry[] = [];
  const alarms = {
    clear: vi.fn(async () => true),
    create: vi.fn()
  };
  const coordinator = createBackupCoordinator({
    api: { alarms } as unknown as BackupCoordinatorDeps["api"],
    perfTrace: createPerformanceTracer("background"),
    now: () => 1000,
    ensureState: async () => ({}) as Awaited<ReturnType<BackupCoordinatorDeps["ensureState"]>>,
    ensurePreferences: async () =>
      ({ automaticBackups: { enabled } }) as Awaited<
        ReturnType<BackupCoordinatorDeps["ensurePreferences"]>
      >,
    waitForSchedulerIdle: async () => {},
    recordIncidentLog: async (event, detail) => {
      incidents.push({ event, detail });
    },
    ...depOverrides
  });
  return { coordinator, incidents, alarms };
}

beforeEach(() => {
  vi.mocked(automaticBackupDue).mockReset().mockReturnValue(false);
  vi.mocked(nextAutomaticBackupTime).mockReset().mockReturnValue(9999);
  vi.mocked(downloadAutomaticBackup)
    .mockReset()
    .mockResolvedValue(undefined as never);
  vi.mocked(loadAutomaticBackupStatus).mockReset().mockResolvedValue({});
  vi.mocked(saveAutomaticBackupStatus)
    .mockReset()
    .mockResolvedValue(undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("backup coordinator — configure", () => {
  it("clears the alarm and runs nothing when backups are disabled", async () => {
    const { coordinator, alarms } = createHarness({ enabled: false });

    await coordinator.configure({ runIfDue: true });

    expect(alarms.clear).toHaveBeenCalledWith(AUTOMATIC_BACKUP_ALARM_NAME);
    expect(alarms.create).not.toHaveBeenCalled();
    expect(downloadAutomaticBackup).not.toHaveBeenCalled();
  });

  it("schedules the alarm without running a backup when not due", async () => {
    vi.mocked(automaticBackupDue).mockReturnValue(false);
    const { coordinator, alarms } = createHarness({ enabled: true });

    await coordinator.configure({ runIfDue: true });

    expect(downloadAutomaticBackup).not.toHaveBeenCalled();
    expect(alarms.create).toHaveBeenCalledWith(
      AUTOMATIC_BACKUP_ALARM_NAME,
      expect.objectContaining({ when: 9999, periodInMinutes: AUTOMATIC_BACKUP_INTERVAL_MINUTES })
    );
  });

  it("runs a backup when due, then schedules", async () => {
    vi.mocked(automaticBackupDue).mockReturnValue(true);
    const { coordinator, alarms } = createHarness({ enabled: true });

    await coordinator.configure({ runIfDue: true });

    expect(downloadAutomaticBackup).toHaveBeenCalledTimes(1);
    expect(alarms.create).toHaveBeenCalledTimes(1);
  });

  it("runs a backup immediately regardless of due-ness", async () => {
    vi.mocked(automaticBackupDue).mockReturnValue(false);
    const { coordinator } = createHarness({ enabled: true });

    await coordinator.configure({ runImmediately: true });

    expect(downloadAutomaticBackup).toHaveBeenCalledTimes(1);
  });
});

describe("backup coordinator — alarm + disable", () => {
  it("handleAlarm runs a backup and reschedules when enabled", async () => {
    const { coordinator, alarms } = createHarness({ enabled: true });

    await coordinator.handleAlarm();

    expect(downloadAutomaticBackup).toHaveBeenCalledTimes(1);
    expect(alarms.create).toHaveBeenCalledTimes(1);
  });

  it("handleAlarm clears the alarm and runs nothing when disabled", async () => {
    const { coordinator, alarms } = createHarness({ enabled: false });

    await coordinator.handleAlarm();

    expect(alarms.clear).toHaveBeenCalledWith(AUTOMATIC_BACKUP_ALARM_NAME);
    expect(downloadAutomaticBackup).not.toHaveBeenCalled();
    expect(alarms.create).not.toHaveBeenCalled();
  });

  it("disable clears the scheduled alarm", async () => {
    const { coordinator, alarms } = createHarness();

    await coordinator.disable();

    expect(alarms.clear).toHaveBeenCalledWith(AUTOMATIC_BACKUP_ALARM_NAME);
  });
});

describe("backup coordinator — run outcome", () => {
  it("records start + success and saves a success status", async () => {
    const { coordinator, incidents } = createHarness({ enabled: true });

    await coordinator.configure({ runImmediately: true });

    expect(incidents.map((i) => i.event)).toEqual([
      "automaticBackupStart",
      "automaticBackupSuccess"
    ]);
    const saved = vi.mocked(saveAutomaticBackupStatus).mock.calls[0]?.[0];
    expect(saved).toMatchObject({ lastSuccessfulBackupAt: expect.any(String) });
    expect(saved).not.toHaveProperty("lastError");
  });

  it("records start + failure and saves an error status when the export throws", async () => {
    vi.mocked(downloadAutomaticBackup).mockRejectedValueOnce(new Error("disk full"));
    const { coordinator, incidents } = createHarness({ enabled: true });

    await coordinator.configure({ runImmediately: true });

    expect(incidents.map((i) => i.event)).toEqual([
      "automaticBackupStart",
      "automaticBackupFailure"
    ]);
    const saved = vi.mocked(saveAutomaticBackupStatus).mock.calls[0]?.[0];
    expect(saved).toMatchObject({ lastError: "disk full" });
    expect(saved).not.toHaveProperty("lastSuccessfulBackupAt");
  });

  it("coalesces concurrent backup runs behind the in-flight guard", async () => {
    let release!: () => void;
    vi.mocked(downloadAutomaticBackup).mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }) as never
    );
    const { coordinator } = createHarness({ enabled: true });

    const a = coordinator.configure({ runImmediately: true });
    const b = coordinator.configure({ runImmediately: true });
    release();
    await Promise.all([a, b]);

    expect(downloadAutomaticBackup).toHaveBeenCalledTimes(1);
  });
});
