import { defineConfig } from "@playwright/test";

const chrome = "/usr/bin/google-chrome-stable";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
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
    { name: "admin", testDir: "./e2e/admin", use: { baseURL: "http://127.0.0.1:5101" } },
    { name: "merchant", testDir: "./e2e/merchant", use: { baseURL: "http://127.0.0.1:5102" } },
    { name: "checkout", testDir: "./e2e/checkout", use: { baseURL: "http://127.0.0.1:5103" } },
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
  ],
});
