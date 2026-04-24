# Test ownership and multi-agent coverage

This project aims for high line coverage on TypeScript and Rust, coordinated so parallel work does not collide. **Do not** broaden `coverage-gap-exclusions.json` to hide real code; use it only for documented edge cases.

## Merge order (coordinator / rebases)

1. **Utils + non-batch services** (pure / small files first)
2. **Batch + `stores` + `chatDb.ts`** (single active branch for `chatDb` when possible)
3. **Hooks + `useAtls` + `App` + `main`**
4. **Components** by subfolder (avoid two PRs on the same `index.tsx` in the same week)
5. **Rust** (`atls-studio/src-tauri` lib, `atls-rs` crates) after TS store/IPC shape is stable, or in parallel if bindings are unchanged
6. **CI gate** (`test:coverage:check-100:fail`, Vite `coverage.thresholds` ratchet) **last**, when the gap list is empty or the team flips the switch. Today CI runs `test:coverage:check-100` with `continue-on-error: true` (see `.github/workflows/ci.yml`); when the per-file list is empty, remove `continue-on-error` and/or switch the script to `test:coverage:check-100:fail`, then keep ratcheting thresholds toward 100 (branches last).

## Directory scope (one primary owner per area)

| Area | Path | Notes |
| --- | --- | --- |
| Utils | `src/utils/` | Prefer `*.test.ts` in repo root of utils |
| Services (non-batch) | `src/services/` except `batch/` | Co-locate `*.test.ts` / `*.test.tsx`; `vi.mock` Tauri/IPC where needed |
| Batch | `src/services/batch/` | `executor`, `intents/`, `handlers/`, `snapshotTracker` — align with `executor.test.ts` patterns |
| Stores + DB | `src/stores/`, `src/services/chatDb.ts` | One owner for `chatDb` mocks per sprint |
| Hooks + shell | `src/hooks/`, `src/App.tsx`, `src/main.tsx` | `*.dom.test.tsx` for DOM; `main.entry.test.ts` for bootstrap |
| Components | `src/components/<Subfolder>/` | Split by subfolder: e.g. AiChat+ChatMessage, CodeViewer+FileExplorer, AtlsPanel+…, MenuBar+Toast+… |
| Prompts + constants | `src/prompts/`, `src/constants/` | Structural tests; avoid full-text snapshot churn |
| Tauri (Rust) | `src-tauri/src/` (not `main.rs` policy) | `#[cfg(test)]`, `cargo llvm-cov` |
| atls-rs | `atls-rs/crates/` | Same as Tauri; `main.rs` excluded by policy if applicable |

## Tooling (single source of truth)

- **TS gaps / below-threshold list:** `npm run test:coverage` then `npm run test:coverage:report` (or `scripts/list-coverage-below-pct.ts`, `list-coverage-gaps.ts`); `test:coverage:check-100:fail` when CI is ready.
- **Exclusions:** `coverage-gap-exclusions.json` and `vite.config.ts` `coverage.exclude` must stay aligned.
- **Playwright:** smoke only; do not use E2E to chase line %.
- **Shared mocks:** `src/testUtils/tauriMocks.ts` and patterns in `App.dom.test.tsx` / `Settings.dom.test.tsx`.

## PR body (copy-paste when changing tests)

- Wave / directory owned (e.g. “utils + services, non-batch”)
- `coverage/coverage-summary.json` or `test-gap-reports` paste optional (local artifacts are often gitignored)
- If touching another owner’s file, say “coordinator merge order: …”
