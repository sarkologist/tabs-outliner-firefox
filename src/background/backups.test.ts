import { describe, expect, it } from "vitest";

import {
  AUTOMATIC_BACKUP_INTERVAL_MS,
  automaticBackupDue,
  nextAutomaticBackupTime
} from "./backups.js";

describe("automatic backups", () => {
  it("uses last success for daily catch-up while avoiding tight retry loops after failures", () => {
    const now = Date.parse("2026-05-19T13:20:00.000Z");

    expect(automaticBackupDue({}, now)).toBe(true);
    expect(
      automaticBackupDue(
        {
          lastSuccessfulBackupAt: new Date(now - AUTOMATIC_BACKUP_INTERVAL_MS - 1).toISOString()
        },
        now
      )
    ).toBe(true);
    expect(
      automaticBackupDue(
        {
          lastSuccessfulBackupAt: new Date(now - 60_000).toISOString()
        },
        now
      )
    ).toBe(false);
    expect(
      automaticBackupDue(
        {
          lastSuccessfulBackupAt: new Date(now - AUTOMATIC_BACKUP_INTERVAL_MS - 1).toISOString(),
          lastAttemptedBackupAt: new Date(now - 60_000).toISOString(),
          lastError: "download denied"
        },
        now
      )
    ).toBe(false);
    expect(
      automaticBackupDue(
        {
          lastAttemptedBackupAt: new Date(now - AUTOMATIC_BACKUP_INTERVAL_MS - 1).toISOString(),
          lastError: "download denied"
        },
        now
      )
    ).toBe(true);
  });

  it("schedules the next alarm from the latest attempt or success", () => {
    const now = Date.parse("2026-05-19T13:20:00.000Z");
    const failedAttempt = now - 60_000;

    expect(nextAutomaticBackupTime({}, now)).toBe(now + AUTOMATIC_BACKUP_INTERVAL_MS);
    expect(
      nextAutomaticBackupTime(
        {
          lastSuccessfulBackupAt: new Date(now - 2 * 60_000).toISOString(),
          lastAttemptedBackupAt: new Date(failedAttempt).toISOString(),
          lastError: "download denied"
        },
        now
      )
    ).toBe(failedAttempt + AUTOMATIC_BACKUP_INTERVAL_MS);
  });
});
