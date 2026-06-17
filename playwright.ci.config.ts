import { defineConfig } from "@playwright/test";

import baseConfig from "./playwright.config";

export default defineConfig({
  ...baseConfig,
  forbidOnly: true,
  workers: 1,
  // Only the timing-variance-sensitive perf/profile specs are excluded from CI. The
  // projection-hunt suite is deterministic (state-based waits, no timing assertions) and runs
  // here so a real projection regression cannot land invisibly -- exactly what happened with the
  // search-mode stale-total bug (PT-039): the spec held a frozen regression for it but CI ignored
  // the whole file. At workers:1 the full corpus is ~1.5 min, an acceptable cost for that coverage.
  testIgnore: [
    "**/sidebar-drag-drop-performance.spec.ts",
    "**/sidebar-startup-interaction-profile.spec.ts",
    "**/sidebar-startup-scroll-away-profile.spec.ts"
  ]
});
