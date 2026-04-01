# Test coverage backlog

This document extends the gap analysis for [`aiService`](../atls-studio/src/services/aiService.ts), orchestrator, swarm chat, DB/cache invoke paths, and related areas. It records **remaining** priorities: central client state, UI-adjacent logic, the `useAtls` bridge, Rust modules without unit tests, and the absence of E2E automation.

Quick-win unit tests now live beside the sources (see [Quick-win coverage](#quick-win-coverage-implemented)).

---

## 1. Central client state (Zustand)

**Status:** backlog — no dedicated test files for these stores.

| Store | Path | Why it matters |
| ----- | ---- | -------------- |
| **appStore** | [`appStore.ts`](../atls-studio/src/stores/appStore.ts) | Messages, tool calls, streaming flags, settings, sessions, agent progress; primary surface for [`AiChat`](../atls-studio/src/components/AiChat/index.tsx) and [`streamChat`](../atls-studio/src/services/aiService.ts). |
| **swarmStore** | [`swarmStore.ts`](../atls-studio/src/stores/swarmStore.ts) | Tasks, cancellation, agent configs; heavily used by [`orchestrator.ts`](../atls-studio/src/services/orchestrator.ts). |
| **attachmentStore** | [`attachmentStore.ts`](../atls-studio/src/stores/attachmentStore.ts) | Chat attachments and drag/drop payloads. |
| **refactorStore** | [`refactorStore.ts`](../atls-studio/src/stores/refactorStore.ts) | Refactor workflow state. |
| **projectHistory** | [`projectHistory.ts`](../atls-studio/src/stores/projectHistory.ts) | Project-scoped history entries (also consumed by appStore). |

**Already covered elsewhere:** [`contextStore.test.ts`](../atls-studio/src/stores/contextStore.test.ts), [`costStore.test.ts`](../atls-studio/src/stores/costStore.test.ts), [`roundHistoryStore.test.ts`](../atls-studio/src/stores/roundHistoryStore.test.ts), [`retentionStore.test.ts`](../atls-studio/src/stores/retentionStore.test.ts).

**Suggested approach:** Start with pure exports from `appStore` (e.g. `getMessageParts`, `extractFirstTextFromMessage`, `generateTitle` if exported or test via small harness), then actions that do not require Tauri. For swarm, test reducers/actions with a fresh store instance. Mock `invoke` / persistence when testing save/load paths.

---

## 2. Quick-win coverage (implemented)

| Module | Test file |
| ------ | --------- |
| [`streamingHelpers.ts`](../atls-studio/src/components/AiChat/streamingHelpers.ts) | [`streamingHelpers.test.ts`](../atls-studio/src/components/AiChat/streamingHelpers.test.ts) |
| [`fileAttachments.ts`](../atls-studio/src/utils/fileAttachments.ts) | [`fileAttachments.test.ts`](../atls-studio/src/utils/fileAttachments.test.ts) |
| [`tokenCounter.ts`](../atls-studio/src/utils/tokenCounter.ts) | [`tokenCounter.test.ts`](../atls-studio/src/utils/tokenCounter.test.ts) |

Extend these files as behavior grows; they are not exhaustive of every edge case.

---

## 3. `useAtls` and related hooks — integration-test backlog

**Primary:** [`useAtls.ts`](../atls-studio/src/hooks/useAtls.ts) — `invoke`, `safeListen` / [`tauri.ts`](../atls-studio/src/utils/tauri.ts), file tree and intel events, `registerOwnWrite`, multiple stores.

**Suggested testing strategy:**

- `vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))`.
- `vi.mock('../utils/tauri', () => ({ safeListen: vi.fn().mockResolvedValue(() => {}) }))`.
- Drive the hook with `@testing-library/react` **or** extract non-React helpers from `useAtls` into a testable module and test those first.

**Secondary (lower priority):** [`useAtlsPaths.ts`](../atls-studio/src/hooks/useAtlsPaths.ts), [`useAtlsTransforms.ts`](../atls-studio/src/hooks/useAtlsTransforms.ts), [`usePanelResize.ts`](../atls-studio/src/hooks/usePanelResize.ts), [`useKeyboardShortcuts.ts`](../atls-studio/src/hooks/useKeyboardShortcuts.ts), [`useOS.ts`](../atls-studio/src/hooks/useOS.ts) — add tests when touching behavior; paths/transforms may be easiest to unit-test without the full hook.

[`useChatPersistence.test.ts`](../atls-studio/src/hooks/useChatPersistence.test.ts) already provides a pattern for hook + store testing.

---

## 4. Rust (`src-tauri`) — files without `#[cfg(test)]`

Frontend Vitest suites mock `invoke`; they **do not** execute Rust. The following `atls-studio/src-tauri/src` modules contain **no** in-file `#[cfg(test)]` blocks (non-exhaustive; verify with ripgrep after refactors):

| Module |
| ------ |
| `ai_execute.rs` |
| `ai_models.rs` |
| `ai_streaming.rs` |
| `ast_query.rs` |
| `atls_ops.rs` |
| `batch_query/mod.rs` (helpers in `batch_query/helpers.rs` have tests) |
| `chat_attachments.rs` |
| `chat_db.rs` |
| `chat_db_commands.rs` |
| `code_intel.rs` |
| `commands/mod.rs` |
| `error.rs` |
| `gemini_cache.rs` |
| `git_ops.rs` |
| `main.rs` |
| `pty.rs` |
| `search_exec.rs` |
| `stream_protocol.rs` |
| `workspace_run.rs` |

**Modules that already embed tests** (examples): `lib.rs`, `hash_resolver.rs`, `hash_protocol.rs`, `shape_ops.rs`, `tokenizer.rs`, `diff_engine.rs`, `snapshot.rs`, `edit_session.rs`, `refactor_engine.rs`, `file_ops.rs`, `linter.rs`, `path_utils.rs`, `line_remap.rs`, `file_watcher.rs`, `hash_commands.rs`, `batch_query/helpers.rs`.

**Priority for new Rust tests:** `chat_db` / persistence boundaries, `ai_streaming` / `stream_protocol`, `gemini_cache`, and anything that parses untrusted input.

---

## 5. End-to-end / browser automation

**Status:** There is **no** Playwright, Cypress, or similar E2E suite in this repository. Vitest covers unit and module integration with mocks.

Full-stack confidence (Tauri + real `invoke` + React) would require a separate E2E approach (e.g. WebDriver against the built app, or Tauri’s driver when applicable). Treat as optional and expensive; one smoke path may be enough if introduced.

---

## 6. Related priorities (from the broader gap list)

For streaming, tool loops, provider wiring, caching, and UI side effects in **`aiService`**, orchestrator phases, **`swarmChat`** streaming rounds, and sampled **`chatDb` / `geminiCache` / `modelFetcher`** paths, see the original planning discussion and [`docs/swarm-orchestration.md`](swarm-orchestration.md) where relevant.

**Batch barrels** (`batch/index.ts`, `batch/intents/index.ts`) and type-only **`batch/types.ts`** may remain out of scope for direct tests; intent logic is covered heavily by [`intents.test.ts`](../atls-studio/src/services/batch/intents.test.ts).
