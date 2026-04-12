# Documentation audit log

Last pass: 2026-04-12 — README operation counts verified against `ALL_OPERATIONS` in [`atls-studio/src/services/batch/families.ts`](../atls-studio/src/services/batch/families.ts) (76 ops); Tauri `generate_handler` in `lib.rs` matches [tauri-commands.md](./tauri-commands.md). Use this table to see what each file is for and whether it was checked against code.

| File | Kind | Notes |
|------|------|--------|
| [README.md](../README.md) | Mixed | Vision + links; app path corrected (`atls-studio/` at repo root, not `atls-studio/atls-studio/`) |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | Reference | `ContextChunk` block labeled simplified; full schema in `contextStore.ts` |
| [README.md](./README.md) | Index | Links validated |
| [api-economics.md](./api-economics.md) | Narrative | |
| [atls-engine.md](./atls-engine.md) | Reference | Paths under `atls-rs/crates/atls-core` verified |
| [batch-executor.md](./batch-executor.md) | Reference | Aligns with `batch/` types and handlers |
| [engrams.md](./engrams.md) | Reference | Simplified `ContextChunk`; full `ChunkType` in `contextHash.ts` |
| [freshness.md](./freshness.md) | Reference | Symbols in `universalFreshness`, batch, `aiService` |
| [hash-protocol.md](./hash-protocol.md) | Reference | `hashProtocol` / resolver utilities |
| [history-compression.md](./history-compression.md) | Reference | `historyCompressor`, snapshot v5 |
| [mcp-integration.md](./mcp-integration.md) | Reference | `atls-mcp` |
| [prompt-assembly.md](./prompt-assembly.md) | Reference | `aiService` prompt paths |
| [session-persistence.md](./session-persistence.md) | Reference | `useChatPersistence`, `chatDb` |
| [studio-app-shell.md](./studio-app-shell.md) | UI | |
| [subagents.md](./subagents.md) | Reference | `subagentService` |
| [swarm-orchestration.md](./swarm-orchestration.md) | Reference | `swarmChat` / stores |
| [tauri-backend.md](./tauri-backend.md) | Reference | Module map; cross-check with `src-tauri` |
| [tauri-commands.md](./tauri-commands.md) | Reference | Kept in sync with `lib.rs` `generate_handler!` |
| [test-coverage-backlog.md](./test-coverage-backlog.md) | Reference | Matches `.github/workflows/ci.yml` |
| [atls-studio/README.md](../atls-studio/README.md) | Mixed | Doc links relative to app package; clone-path wording aligned with repo layout |
| [atls-studio/docs/ARCHITECTURE.md](../atls-studio/docs/ARCHITECTURE.md) | Pointer | Canonical doc is root `ARCHITECTURE.md` |
| [atls-rs/LANGUAGES.md](../atls-rs/LANGUAGES.md) | Reference | Language list |
