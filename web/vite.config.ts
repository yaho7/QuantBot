import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    proxy: { "/api": process.env.QB_DEV_API ?? "http://127.0.0.1:23456" },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
