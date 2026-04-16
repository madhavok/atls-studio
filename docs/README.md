# ATLS Studio — Documentation Index

Subsystem docs for the Studio app and batch runtime. Start here for orientation.

## Freshness & edits (read this first)

| Doc | Topics |
|-----|--------|
| **[freshness.md](./freshness.md)** | **Universal freshness** (`canSteerExecution`, `UniversalState`, `validateSourceIdentity`), staged **`stageState`**, snapshot tracker, awareness levels, hash injection, freshness states, preflight (`context` full + `refreshRoundEnd`), **round-end bulk revisions** (`get_current_revisions`, staged + WM + archive), reconciliation, retention/trace distillation vs workspace rev, **sequential `line_edits`**, **cross-step line rebase**, **post-edit context refresh**, **own-write suppression**, freshness telemetry |

Related:

| Doc | Topics |
|-----|--------|
| [batch-executor.md](./batch-executor.md) | `batch()` tool, step loop, snapshot injection, intents, `line_edits` spans / `edits_resolved`, discover-step `content` (`file_paths`, `lines`, `end_lines`), **op/param shorthands** (`opShorthand.ts`, `paramNorm.ts`, prompt legend) |
| [hash-protocol.md](./hash-protocol.md) | `h:` refs, modifiers, resolution rules |
| [engrams.md](./engrams.md) | Working memory chunks and lifecycle |

## Other docs

| Doc | Topics |
|-----|--------|
| [atls-engine.md](./atls-engine.md) | `atls-core` Rust engine: `AtlsProject`, `QueryEngine`, JSON pattern catalogs, `neural-embeddings` feature, MCP tool surface |
| [history-compression.md](./history-compression.md) | Hash deflation (threshold 100/200), `deflateToolResults` chunk creation, **`stubBatchToolUseInputs`** (assistant side), rolling verbatim window + distilled `[Rolling Summary]`, substantive round counting, snapshot format v5/v6 |
| [prompt-assembly.md](./prompt-assembly.md) | **State vs chat separation**, BP-static + BP3 cache layers, state block **prepended into last user message** via `prependStateToContent`, entry manifest depth, tool-loop steering signals |
| [api-economics.md](./api-economics.md) | Input-side caching story, pricing mismatch, mitigations table |
| **[output-compression.md](./output-compression.md)** | **Cross-cutting output-token compression inventory** across six axes (lexical / semantic / temporal / spatial / computational / transcript) — the single doc that explains why ATLS emits ~75% fewer tokens per round than a naive tool-calling agent |
| [session-persistence.md](./session-persistence.md) | Session save/restore, auto-resume, memory snapshot versions (v5 `rollingSummary`, v6 verify/awareness/coverage/spin/journal), freshness-after-restore timing, Tauri close flush |
| [studio-app-shell.md](./studio-app-shell.md) | UI shell, AtlsPanel tabs (Issues/File/Patterns/Overview/Health), copy last API payload (debug) |
| [tauri-backend.md](./tauri-backend.md) | Rust / Tauri layer: `hash_resolver`, `edit_session`, `diff_engine`, `ast_query`, `shape_ops`, `git_ops`, etc. |
| [tauri-commands.md](./tauri-commands.md) | Enumerated Tauri `invoke` command names (`generate_handler!` in `lib.rs`) |
| [mcp-integration.md](./mcp-integration.md) | MCP server surface (`batch`, `batch_query`, `find_issues`, `scan_project`, `get_codebase_overview`, `get_patterns`, `export`) |
| [swarm-orchestration.md](./swarm-orchestration.md) | Multi-agent orchestration, rehydration, per-store rate limiting |
| [subagents.md](./subagents.md) | Delegate subagents: four roles, snapshot loop, scoped HPP, `ROLE_BB_PREFIXES`, per-role output caps |
| [test-coverage-backlog.md](./test-coverage-backlog.md) | Remaining test gaps, implemented store/hook/history coverage, E2E specs |

## Repo layout

- **Audit log** ([`DOCUMENTATION_AUDIT.md`](./DOCUMENTATION_AUDIT.md)): what each doc is for and last accuracy pass.
- **Repository root** (contains this `docs/` folder): clone root; the architecture overview lives at [`atls-studio/docs/ARCHITECTURE.md`](../atls-studio/docs/ARCHITECTURE.md).
- **App package** (npm scripts, `src/`, `src-tauri/`): [`../atls-studio/README.md`](../atls-studio/README.md) — run `npm install` and `npm run tauri:dev` from `atls-studio/` inside the clone.
- Optional Cursor rule (local only; `.cursor/` is gitignored): if present, `.cursor/rules/edit-freshness.mdc` — not required for builds.
