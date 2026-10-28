import { defineConfig } from "@playwright/test";

/** Runs against the deployed single-node box over the LAN (self-signed TLS). */
export default defineConfig({
  testDir: "./e2e-live",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    headless: true,
    ignoreHTTPSErrors: true,
    launchOptions: { executablePath: "/usr/bin/google-chrome-stable", args: ["--no-sandbox"] },
    screenshot: "only-on-failure",
  },
});
