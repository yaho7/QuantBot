import { defineConfig } from "@playwright/test";

const port = process.env.QB_BROWSER_PORT ?? "42356";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests",
  use: { locale: "zh-CN", channel: process.env.QB_BROWSER_CHANNEL || undefined },
  projects: [
    { name: "console", testMatch: "console.spec.ts", use: { baseURL } },
    { name: "setup", testMatch: "setup.spec.ts", use: { baseURL: `http://127.0.0.1:${Number(port) + 1}` } },
    { name: "layout", testMatch: "layout.spec.ts", use: { baseURL: `http://127.0.0.1:${Number(port) + 2}` } },
  ],
  webServer: [{
    command: "uv run --directory .. python -m tests.integration.browser_server",
    url: `${baseURL}/healthz`,
    timeout: 20_000,
  }, {
    command: "uv run --directory .. python -m tests.integration.browser_server",
    env: { QB_BROWSER_PORT: String(Number(port) + 1), QB_BROWSER_FRESH: "1" },
    url: `http://127.0.0.1:${Number(port) + 1}/healthz`,
    timeout: 20_000,
  }, {
    command: "uv run --directory .. python -m tests.integration.browser_server",
    env: { QB_BROWSER_PORT: String(Number(port) + 2) },
    url: `http://127.0.0.1:${Number(port) + 2}/healthz`,
    timeout: 20_000,
  }],
});
