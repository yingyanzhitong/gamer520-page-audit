import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import packageInfo from "./package.json" with { type: "json" };

const stripChunkTrailingWhitespace = {
  name: "strip-chunk-trailing-whitespace",
  apply: "build",
  augmentChunkHash() {
    return "strip-chunk-trailing-whitespace-v1";
  },
  generateBundle(_options, bundle) {
    for (const output of Object.values(bundle)) {
      if (output.type === "chunk") {
        output.code = output.code.replace(/[\t ]+$/gm, "");
      }
    }
  },
};

export default defineConfig({
  root: path.resolve("frontend"),
  define: {
    __APP_VERSION__: JSON.stringify(packageInfo.version),
  },
  plugins: [react(), stripChunkTrailingWhitespace],
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
