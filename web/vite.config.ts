import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    host: "127.0.0.1",
    port: 5174,
    proxy: Object.fromEntries(["/api", "/theme-assets", "/lyra-theme.zip"].map(path => [path, process.env.QB_DEV_API ?? "http://127.0.0.1:23456"])),
  },
  build: { outDir: "dist", emptyOutDir: true },
});
