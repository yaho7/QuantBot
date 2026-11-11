import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The page is built into the Python package, so `uv tool install` ships it
// without Node. Rebuild with `npm run build` after changing anything here.
export default defineConfig({
  base: "/ui/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5174,
    host: "127.0.0.1",
    // `npm run dev` talks to a running QuantBot; set QB_DEV_API to its address.
    proxy: { "/ui/api": process.env.QB_DEV_API ?? "http://127.0.0.1:23456", "/ui/login": process.env.QB_DEV_API ?? "http://127.0.0.1:23456" },
  },
  build: {
    outDir: "../src/quantbot/web",
    emptyOutDir: true,
  },
});
