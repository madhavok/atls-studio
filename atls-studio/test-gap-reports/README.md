# Coverage gap reports

These text files list source files with **0% line coverage** from Vitest (`coverage/coverage-summary.json`) and from `cargo llvm-cov --json --summary-only` (Rust). Paths are relative to the **repository root** (`atls-studio/` parent).

## Regenerate

From `atls-studio/`:

1. **TypeScript:** `npm run test:coverage`
2. **Rust (Tauri):** `cd src-tauri && cargo llvm-cov --json --summary-only --output-path target/llvm-cov-tauri-summary.json`  
   Requires `cargo install cargo-llvm-cov` and `rustup component add llvm-tools-preview`.
3. **Rust (atls-rs):** `cd ../../atls-rs && cargo llvm-cov --workspace --json --summary-only --output-path target/llvm-cov-atls-rs-summary.json`
   CI intentionally omits `--all-features` because the neural-embeddings feature pulls `ort-sys` and can fail on external CDN timeouts. CI uses an `lcov` run plus `cargo llvm-cov report --json --summary-only --output-path …`; see `.github/workflows/ci.yml`.
4. **Lists:** `npm run test:coverage:gaps`
5. **Below 100% lines (TypeScript):** `npm run test:coverage:check-100` — writes `ts-below-100-lines.txt`. Use `test:coverage:check-100:fail` only when the repo is ready to enforce per-file 100% lines.

Or run `npm run test:coverage:report` (coverage + gap lists + below-100 list). Add Rust LLVM JSON paths first if you need the Rust gap files.

**Playwright** (`npm run test:e2e`) is complementary smoke for the shell and full integration; it does not replace Vitest line coverage.

## Exclusions

Configurable in [`../coverage-gap-exclusions.json`](../coverage-gap-exclusions.json) (type-only barrels, entrypoints, scripts outside `src/`, etc.).

## CI

`npm run test:coverage:gaps -- --fail-on-gaps` exits with code 1 if any non-excluded TS file has 0% lines (use only when the gap list is expected to be empty).
