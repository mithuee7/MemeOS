import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The React app is built into ./dist, which the Worker serves as static assets.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    proxy: { "/api": "http://localhost:8787" },
  },
});
