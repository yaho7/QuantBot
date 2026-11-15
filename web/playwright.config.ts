import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: ["v3.spec.ts", "layout-stability.spec.ts"],
  timeout: 60_000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:42357", locale: "zh-CN", channel: process.env.QB_BROWSER_CHANNEL || undefined },
  webServer: {
    command: "node scripts/test-server.mjs",
    url: "http://127.0.0.1:42357/healthz",
    timeout: 60_000,
  },
});
