# Coverage gap reports

These text files list source files with **0% line coverage** from Vitest (`coverage/coverage-summary.json`) and from `cargo llvm-cov --json --summary-only` (Rust). Paths are relative to the **repository root** (`atls-studio/` parent).

## Regenerate

From `atls-studio/`:

1. **TypeScript:** `npm run test:coverage`
2. **Rust (Tauri):** `cd src-tauri && cargo llvm-cov --json --summary-only --output-path target/llvm-cov-tauri-summary.json`  
   Requires `cargo install cargo-llvm-cov` and `rustup component add llvm-tools-preview`.
3. **Rust (atls-rs):** `cd ../../atls-rs && cargo llvm-cov --workspace --json --summary-only --output-path target/llvm-cov-atls-rs-summary.json`
4. **Lists:** `npm run test:coverage:gaps`

Or run `npm run test:coverage:report` after step 2–3 if the LLVM JSON files already exist.

## Exclusions

Configurable in [`../coverage-gap-exclusions.json`](../coverage-gap-exclusions.json) (type-only barrels, entrypoints, scripts outside `src/`, etc.).

## CI

`npm run test:coverage:gaps -- --fail-on-gaps` exits with code 1 if any non-excluded TS file has 0% lines (use only when the gap list is expected to be empty).
