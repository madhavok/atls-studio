/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  // Vitest runs Vite in `test` mode; suppress toolchain deprecation noise (esbuild vs oxc) there only.
  logLevel: mode === "test" ? "error" : "info",
  plugins: [react()],
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    globals: true,
    environmentMatchGlobs: [
      ["**/*.dom.test.ts", "happy-dom"],
      ["**/*.dom.test.tsx", "happy-dom"],
    ],
    // Instrumented sources: all app code; test files excluded from denominator.
    // *.dom.test.tsx matches **/*.test.tsx — same exclusion as other tests; imported modules still gain coverage when run under happy-dom.
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      thresholds: {
        // Baseline ~37% stmts / 32% branch / 28% funcs / 38% lines. Tighten over time.
        statements: 36,
        branches: 30,
        functions: 27,
        lines: 37,
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
