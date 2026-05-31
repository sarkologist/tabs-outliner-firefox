import { defineConfig } from "@playwright/test";

import baseConfig from "./playwright.config";

export default defineConfig({
  ...baseConfig,
  forbidOnly: true,
  retries: 1,
  workers: 1,
  testIgnore: [
    "**/sidebar-drag-drop-performance.spec.ts",
    "**/sidebar-projection-hunt.spec.ts",
    "**/sidebar-startup-interaction-profile.spec.ts",
    "**/sidebar-startup-scroll-away-profile.spec.ts"
  ]
});
