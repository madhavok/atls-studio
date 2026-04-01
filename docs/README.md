# ATLS Studio — Documentation Index

Subsystem docs for the Studio app and batch runtime. Start here for orientation.

## Freshness & edits (read this first)

| Doc | Topics |
|-----|--------|
| **[freshness.md](./freshness.md)** | **Universal freshness** (`canSteerExecution`, `UniversalState`, `validateSourceIdentity`), staged **`stageState`**, snapshot tracker, awareness levels, hash injection, freshness states, preflight (`context` full + `refreshRoundEnd`), **round-end bulk revisions** (`get_current_revisions`, staged + WM + archive), reconciliation, retention/trace distillation vs workspace rev, **sequential `line_edits`**, **cross-step line rebase**, **post-edit context refresh**, **own-write suppression**, freshness telemetry |

Related:

| Doc | Topics |
|-----|--------|
| [batch-executor.md](./batch-executor.md) | `batch()` tool, step loop, snapshot injection, intents, `line_edits` spans / `edits_resolved`, discover-step `content` (`file_paths`, `lines`, `end_lines`) |
| [hash-protocol.md](./hash-protocol.md) | `h:` refs, modifiers, resolution rules |
| [engrams.md](./engrams.md) | Working memory chunks and lifecycle |

## Other docs

| Doc | Topics |
|-----|--------|
| [atls-engine.md](./atls-engine.md) | ATLS engine integration |
| [history-compression.md](./history-compression.md) | Hash deflation, rolling verbatim window, `[Rolling Summary]` API-only message, distiller, ties to **snapshot format v5** (`rollingSummary`) |
| [prompt-assembly.md](./prompt-assembly.md) | Cache layers, entry manifest depth (`paths` / `sigs` / `paths_sigs`), main agent tool-loop guards (research budget, verify gate, convergence nudges) |
| [session-persistence.md](./session-persistence.md) | Session save/restore, auto-resume, memory snapshot versions (incl. v5 `rollingSummary`), freshness-after-restore timing, Tauri close flush |
| [api-economics.md](./api-economics.md) | Token / API considerations |
| [studio-app-shell.md](./studio-app-shell.md) | UI shell, copy last API payload (debug) |
| [tauri-backend.md](./tauri-backend.md) | Rust / Tauri layer |
| [tauri-commands.md](./tauri-commands.md) | Enumerated Tauri `invoke` command names (`lib.rs`) |
| [mcp-integration.md](./mcp-integration.md) | MCP |
| [swarm-orchestration.md](./swarm-orchestration.md) | Multi-agent orchestration |
| [subagents.md](./subagents.md) | Delegate subagents: four roles, snapshot loop, scoped HPP, batch ops |
| [test-coverage-backlog.md](./test-coverage-backlog.md) | Remaining test gaps (stores, `useAtls`, Rust without `cfg(test)`, E2E); quick-win tests implemented |

## Repo layout

- **Repository root** (contains this `docs/` folder): clone root; [`ARCHITECTURE.md`](../ARCHITECTURE.md) lives here.
- **App package** (npm scripts, `src/`, `src-tauri/`): [`../atls-studio/README.md`](../atls-studio/README.md) — run `npm install` and `npm run tauri:dev` from `atls-studio/` inside the clone.
- Optional Cursor rule (local only; `.cursor/` is gitignored): if present, `.cursor/rules/edit-freshness.mdc` — not required for builds.
