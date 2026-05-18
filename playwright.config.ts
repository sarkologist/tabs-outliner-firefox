import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/playwright",
  outputDir: "./test-results/playwright",
  reporter: "list",
  timeout: 30_000,
  expect: {
    timeout: 5_000
  },
  use: {
    baseURL: "http://127.0.0.1:4173/sidebar",
    viewport: {
      width: 360,
      height: 520
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "pnpm run build && python3 -m http.server 4173 --directory dist",
    url: "http://127.0.0.1:4173/sidebar/sidebar.html",
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe"
  }
});
