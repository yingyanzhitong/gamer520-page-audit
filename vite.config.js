import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve("frontend"),
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve("frontend/src"),
    },
  },
  build: {
    outDir: path.resolve("public"),
    emptyOutDir: true,
  },
});
