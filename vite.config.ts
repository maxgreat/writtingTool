/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import process from "node:process";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

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
