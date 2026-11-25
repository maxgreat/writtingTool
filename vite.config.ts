/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { devCore } from "./scripts/dev-core.mjs";
import { devSpelling } from "./scripts/dev-spelling.mjs";

const host = process.env.TAURI_DEV_HOST;
const root = dirname(fileURLToPath(import.meta.url));

// https://vite.dev/config/
export default defineConfig(() => ({
  // The dev server checks spelling and grammar for the browser preview (see scripts/dev-spelling.mjs and dev-core.mjs).
  plugins: [react(), devSpelling(root), devCore(root)],

  // Options for `tauri dev` and `tauri build`:
  // keep Rust errors visible,
  clearScreen: false,
  server: {
    // use the fixed port Tauri expects, and fail if it is taken,
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    // and don't watch the Rust side.
    watch: { ignored: ["**/src-tauri/**"] },
  },

  test: {
    include: ["src/**/*.test.ts"],
  },
}));
