# Test coverage backlog

This document tracks **remaining** test priorities for ATLS (Vitest frontend, Playwright E2E, `src-tauri`, `atls-rs`). It is refreshed periodically; verify with `rg '#\[cfg\(test\)\]'` in Rust crates and `npm run test` / `npm run test:e2e` in `atls-studio`.

---

## How to run

| Layer | Command | Location |
| ----- | ------- | -------- |
| Vitest | `npm run test` / `npm run test:coverage` | [`atls-studio`](../atls-studio) |
| Vitest + gap report | `npm run test:coverage:report` (runs coverage then `list-coverage-gaps.ts`) | [`atls-studio`](../atls-studio) |
| Gap-only report | `npm run test:coverage:gaps` | [`atls-studio`](../atls-studio) |
| Playwright | `npm run test:e2e` | [`atls-studio/e2e`](../atls-studio/e2e) |
| Tauri backend | `cargo test` or `cargo llvm-cov` | [`atls-studio/src-tauri`](../atls-studio/src-tauri) |
| Validation-fix subset (Rust) | `npm run test:validation-fixes` | [`atls-studio/src-tauri`](../atls-studio/src-tauri) |
| atls-rs | `npm run test:atls-rs` (alias for `cargo test`) | [`atls-rs`](../atls-rs) |
| Full stack | `npm run test:all` — Vitest then `src-tauri` then `atls-rs` cargo tests | repo-wide |

CI: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs typecheck, Vitest + coverage, Playwright, and `cargo llvm-cov --workspace` over the `atls-rs` workspace (coverage-enabled Rust run — equivalent to `cargo test` plus instrumentation).

---

## 1. Central client state (Zustand) — mostly covered

Dedicated test files exist for **swarmStore**, **attachmentStore**, **refactorStore**, **projectHistory**, partial **appStore** (message parts / helpers), plus newer additions: **bbFreshness**, **contextHelpers**, **costStoreTotals**, **retentionStore**, **terminalStore** (multiple specs), **usePanelResize.clamp**, and **useAtls.buildIssueFilters**. See `atls-studio/src/stores/*.test.ts` and `atls-studio/src/hooks/*.test.ts`.

**Remaining:** deeper **appStore** action coverage without full Tauri (streaming lifecycle, session edges) where practical; mock `invoke` for persistence paths.

---

## 2. Quick-win coverage (implemented)

| Module | Test file |
| ------ | --------- |
| [`streamingHelpers.ts`](../atls-studio/src/components/AiChat/streamingHelpers.ts) | [`streamingHelpers.test.ts`](../atls-studio/src/components/AiChat/streamingHelpers.test.ts) |
| [`fileAttachments.ts`](../atls-studio/src/utils/fileAttachments.ts) | [`fileAttachments.test.ts`](../atls-studio/src/utils/fileAttachments.test.ts) |
| [`tokenCounter.ts`](../atls-studio/src/utils/tokenCounter.ts) | [`tokenCounter.test.ts`](../atls-studio/src/utils/tokenCounter.test.ts) |

---

## 3. `useAtls` and related hooks

**Implemented:** [`useAtlsPaths.test.ts`](../atls-studio/src/hooks/useAtlsPaths.test.ts), [`useAtlsTransforms.test.ts`](../atls-studio/src/hooks/useAtlsTransforms.test.ts), [`useAtls.ownership.test.ts`](../atls-studio/src/hooks/useAtls.ownership.test.ts), [`useChatPersistence.test.ts`](../atls-studio/src/hooks/useChatPersistence.test.ts), plus [`useAtls`](../atls-studio/src/hooks/useAtls.ts) tests where added.

**Remaining:** expand event subscription and cleanup scenarios; optional extraction of non-React helpers for pure unit tests.

---

## 4. Rust (`src-tauri`)

Most modules embed `#[cfg(test)]` tests, including: `ai_execute`, `ai_models`, `ai_streaming`, `ast_query`, `chat_attachments`, `chat_db`, `error`, `gemini_cache`, `git_ops`, `pty`, `search_exec`, `stream_protocol`, `workspace_run`, `batch_query/helpers.rs`, and others listed previously in this doc.

**Typically thin / entry-only (minimal or no unit tests):** `main.rs`, `tokenizer_shorthand_audit.rs` (audit tables; exercised via tokenizer tests).

**Remaining after targeted additions:** exhaustive coverage of `batch_query/mod.rs` orchestration (prefer testing extracted helpers and integration smoke with temp workspaces); full command surface of `chat_db_commands` (wrappers delegate to `chat_db`).

**Priority for ongoing Rust tests:** persistence boundaries, streaming/protocol edges, parsers on untrusted input.

---

## 5. `atls-rs`

[`atls-core`](../atls-rs/crates/atls-core) and [`atls-mcp`](../atls-rs/crates/atls-mcp) use colocated `#[cfg(test)]` modules; coverage is expanded over time (project, query, DB, indexer, MCP handlers).

**Remaining:** grow tests for `QueryEngine`, DB migrations/queries, indexer scanning, and MCP handler modules as behavior changes.

---

## 6. End-to-end (Playwright)

**Implemented:** [`e2e/dev-server-smoke.spec.ts`](../atls-studio/e2e/dev-server-smoke.spec.ts) (Vite webServer), [`e2e/app-layout.spec.ts`](../atls-studio/e2e/app-layout.spec.ts), and [`e2e/chat-session-reload.spec.ts`](../atls-studio/e2e/chat-session-reload.spec.ts).

**Remaining:** optional deeper flows (navigation, settings) without API keys; Tauri-native WebDriver remains optional and costly.

---

## 7. Related priorities

For **`aiService`**, orchestrator, **`swarmChat`**, and **`chatDb` / `geminiCache` / `modelFetcher`**, see service-level `*.test.ts` under [`atls-studio/src/services`](../atls-studio/src/services) and [`docs/swarm-orchestration.md`](swarm-orchestration.md).

**History pipeline coverage (implemented):** [`historyCompressor.test.ts`](../atls-studio/src/services/historyCompressor.test.ts), [`historySerializationTokens.test.ts`](../atls-studio/src/services/historySerializationTokens.test.ts) — covers deflation, rolling-window eviction, and tool_use stub token accounting.

Batch intent logic: [`intents.test.ts`](../atls-studio/src/services/batch/intents.test.ts). Barrel-only modules may stay untested directly.
