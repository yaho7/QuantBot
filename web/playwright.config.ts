import { defineConfig } from "@playwright/test";

const port = process.env.QB_BROWSER_PORT ?? "42356";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests",
  use: { baseURL, channel: process.env.QB_BROWSER_CHANNEL || undefined },
  webServer: {
    command: "uv run --directory .. python -m tests.v2.browser_server",
    url: `${baseURL}/healthz`,
    timeout: 20_000,
  },
});
