import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:8787",
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHANNEL,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx tsx scripts/e2e-server.ts",
    url: "http://127.0.0.1:8787/api/health",
    timeout: 30_000,
    reuseExistingServer: false,
  },
});
