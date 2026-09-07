import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const companionDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(companionDirectory, "ui"),
  plugins: [react()],
  build: {
    outDir: resolve(companionDirectory, "dist/ui"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/app[extname]"
      }
    }
  }
});
