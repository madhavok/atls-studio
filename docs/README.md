# ATLS Studio — Documentation Index

Subsystem docs for the Studio app and batch runtime. Start here for orientation.

## Freshness & edits (read this first)

| Doc | Topics |
|-----|--------|
| **[freshness.md](./freshness.md)** | **Universal freshness** (`canSteerExecution`, `UniversalState`, `validateSourceIdentity`), staged **`stageState`**, snapshot tracker, awareness levels, hash injection, freshness states, preflight (`context` full + `refreshRoundEnd`), **round-end bulk revisions** (`get_current_revisions`, staged + WM + archive), reconciliation, retention/trace distillation vs workspace rev, **sequential `line_edits`**, **cross-step line rebase**, **post-edit context refresh**, **own-write suppression**, freshness telemetry |

Related:

| Doc | Topics |
|-----|--------|
| [batch-executor.md](./batch-executor.md) | `batch()` tool, step loop, snapshot injection, intents |
| [hash-protocol.md](./hash-protocol.md) | `h:` refs, modifiers, resolution rules |
| [engrams.md](./engrams.md) | Working memory chunks and lifecycle |

## Other docs

| Doc | Topics |
|-----|--------|
| [atls-engine.md](./atls-engine.md) | ATLS engine integration |
| [history-compression.md](./history-compression.md) | Hash deflation, rolling verbatim window, `[Rolling Summary]` API-only message, distiller, ties to **snapshot format v5** (`rollingSummary`) |
| [prompt-assembly.md](./prompt-assembly.md) | How prompts are built |
| [session-persistence.md](./session-persistence.md) | Session save/restore, auto-resume, memory snapshot versions (incl. v5 `rollingSummary`), freshness-after-restore timing, Tauri close flush |
| [api-economics.md](./api-economics.md) | Token / API considerations |
| [studio-app-shell.md](./studio-app-shell.md) | UI shell |
| [tauri-backend.md](./tauri-backend.md) | Rust / Tauri layer |
| [mcp-integration.md](./mcp-integration.md) | MCP |
| [swarm-orchestration.md](./swarm-orchestration.md) | Multi-agent orchestration |
| [subagents.md](./subagents.md) | Delegate subagents: four roles, snapshot loop, scoped HPP, budgets, batch ops |

## Repo layout

- App README: [`../atls-studio/README.md`](../atls-studio/README.md)
- High-level architecture: [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- Agent edit rules: [`.cursor/rules/edit-freshness.mdc`](../.cursor/rules/edit-freshness.mdc)
