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
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        // Root shell: exercised by Playwright; composition-only unit tests are low ROI.
        "src/App.tsx",
        // Type-only / re-export surfaces (see coverage-gap-exclusions.json).
        "src/vite-env.d.ts",
        "src/services/batch/index.ts",
        "src/services/batch/types.ts",
        "src/utils/uhppTypes.ts",
        "src/utils/uhppCanonical.ts",
        "src/prompts/index.ts",
        "src/components/AtlsPanel/types.ts",
      ],
      thresholds: {
        // Raised as coverage improves; repo target ~90% on meaningful runtime code (see coverage-gap-exclusions.json).
        statements: 40,
        branches: 35,
        functions: 31,
        lines: 42,
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
