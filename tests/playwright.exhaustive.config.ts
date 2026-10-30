import { defineConfig } from "@playwright/test";

const chrome = "/usr/bin/google-chrome-stable";

export default defineConfig({
  testDir: "./e2e/exhaustive",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    headless: true,
    ignoreHTTPSErrors: true,
    launchOptions: { executablePath: chrome, args: ["--no-sandbox"] },
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "admin", testMatch: /exhaustive-admin-.*\.spec\.ts/, use: { baseURL: "http://127.0.0.1:5101" } },
    { name: "merchant", testMatch: /exhaustive-merchant-.*\.spec\.ts/, use: { baseURL: "http://127.0.0.1:5102" } },
    { name: "checkout", testMatch: /exhaustive-checkout-.*\.spec\.ts/, use: { baseURL: "http://127.0.0.1:5103" } },
    { name: "fake-rails", testMatch: /exhaustive-fake-rails-.*\.spec\.ts/, use: { baseURL: "http://127.0.0.1:5104" } },
    { name: "live", testMatch: /full-platform-lifecycle-journeys\.spec\.ts/, use: { baseURL: "http://127.0.0.1:5101" } },
  ],
  webServer: [
    {
      command: "bun run preview -- --port 5101 --strictPort --host 127.0.0.1",
      cwd: "../admin-front",
      url: "http://127.0.0.1:5101",
      reuseExistingServer: true,
      timeout: 90_000,
    },
    {
      command: "bun run preview -- --port 5102 --strictPort --host 127.0.0.1",
      cwd: "../merchant-front",
      url: "http://127.0.0.1:5102",
      reuseExistingServer: true,
      timeout: 90_000,
    },
    {
      command: "bun run preview -- --port 5103 --strictPort --host 127.0.0.1",
      cwd: "../checkout-front",
      url: "http://127.0.0.1:5103",
      reuseExistingServer: true,
      timeout: 90_000,
    },
    {
      command: "bun run preview -- --port 5104 --strictPort --host 127.0.0.1",
      cwd: "../fake-rails-front",
      url: "http://127.0.0.1:5104",
      reuseExistingServer: true,
      timeout: 90_000,
    },
  ],
});
