import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // MapLibre loads its tile worker from a URL relative to its own module. Pre-bundling
  // rewrites that URL and the worker fails to load, which silently breaks tile rendering.
  optimizeDeps: { exclude: ["maplibre-gl"] },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
  preview: { host: "0.0.0.0", port: 4173, strictPort: true },
});
