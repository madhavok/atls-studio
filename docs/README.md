# ATLS Studio — Documentation Index

Subsystem docs for the Studio app and batch runtime. Start here for orientation.

## Freshness & edits (read this first)

| Doc | Topics |
|-----|--------|
| **[freshness.md](./freshness.md)** | Snapshot tracker, awareness levels, hash injection, freshness states, preflight/rebase, reconciliation, **edit freshness protocol**, **sequential `line_edits`**, **cross-step line rebase**, **post-edit context refresh**, **own-write suppression** |

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
| [history-compression.md](./history-compression.md) | Chat / context compression |
| [prompt-assembly.md](./prompt-assembly.md) | How prompts are built |
| [session-persistence.md](./session-persistence.md) | Session save/restore |
| [api-economics.md](./api-economics.md) | Token / API considerations |
| [studio-app-shell.md](./studio-app-shell.md) | UI shell |
| [tauri-backend.md](./tauri-backend.md) | Rust / Tauri layer |
| [mcp-integration.md](./mcp-integration.md) | MCP |
| [swarm-orchestration.md](./swarm-orchestration.md) | Multi-agent orchestration |

## Repo layout

- App README: [`../atls-studio/README.md`](../atls-studio/README.md)
- High-level architecture: [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- Agent edit rules: [`.cursor/rules/edit-freshness.mdc`](../.cursor/rules/edit-freshness.mdc)
