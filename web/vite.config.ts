import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.QB_DEV_API ?? "http://127.0.0.1:23456";

export default defineConfig({
  base: "/ui/",
  plugins: [react()],
  server: {
    port: 5174,
    host: "127.0.0.1",
    proxy: { "/api": api, "/openapi.json": api, "/docs": api, "/healthz": api },
  },
  build: { outDir: "../src/quantbot/web", emptyOutDir: true },
});
