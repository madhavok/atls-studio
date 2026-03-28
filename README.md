# ATLS Studio

Managed working memory for agentic LLMs. A cognitive runtime that gives language models hash-addressed external memory with freshness guarantees, turning prompt construction from a flat transcript into structured, selectable, referenceable knowledge.

**Built with** TypeScript + Rust (Tauri) | **Validated on** Claude Opus (Anthropic API)

---

## What This Is

ATLS Studio is a desktop application that wraps LLM interactions in a structured working-memory layer. Instead of relying only on a growing conversation transcript, the model works with **engrams** — content-addressed knowledge units that can be pinned, compacted, archived, recalled, and evicted.

Through the ATLS runtime, the model gets structured control over its active working set. The system tracks freshness, and stale content can be detected, blocked, or recovered automatically. The result is an agent workflow designed to maintain coherent working memory across many tool-loop rounds.

## Key Capabilities

- **Hash-addressed engrams** with four activation states (active, dormant, archived, evicted) and model-controlled lifecycle transitions
- **Freshness tracking** — per-engram five-state taxonomy, **universal execution authority** (`canSteerExecution` across blackboard, staged snippets, WM, pins), and a cascade of recovery strategies (edit journal, shape match, symbol identity, fingerprint, line relocation)
- **Unified batch executor** — one tool surface (`batch()`) with 75 `OperationKind` steps (primitives + `intent.*` macros), step-to-step dataflow, intent macros, and multi-level error recovery
- **Universal Hash Pointer Protocol (UHPP)** — rich reference syntax with shapes, line ranges, set selectors, diffs, and boolean operations
- **History compression** via hash-reference deflation, a **rolling verbatim window**, and a **distilled rolling summary** (`[Rolling Summary]`) for API assembly — large tool results replaced with hash pointers, older rounds summarized into structured facts, recallable on demand
- **Prompt cache optimization** — append-only history within tool loops, mutable content isolated to the uncached dynamic block
- **Blackboard architecture** for persistent session knowledge (plans, analysis results, decisions)
- **Cognitive rules** — the model writes rules that shape its own reasoning across turns
- **Task planning** with subtask-scoped memory lifecycle and transition bridges

## Architecture

```
  Cognitive Core (prompt)     Batch Executor (tools)     Prompt Assembly (per-round)
         │                          │                            │
         └──────────────────────────┴────────────────────────────┘
                                    │
                          Context Store (Zustand)
              ┌──────────┬───────────┬──────────┬───────────┐
              │ Working  │ Archived  │  Staged  │ Blackboard│
              │ Memory   │ Chunks    │ Snippets │ Entries   │
              └──────────┴───────────┴──────────┴───────────┘
                                    │
                    Freshness & Hash Protocol Layer
              ┌──────────┬───────────┬──────────┬──────────┐
              │   HPP    │ Snapshot  │Freshness │ History  │
              │(visibility)│ Tracker │ Preflight│ Compress │
              └──────────┴───────────┴──────────┴──────────┘
                                    │
                          Tauri / Rust Backend
           File I/O · Code Search · Edit Session · Dep Graph
           Build/Verify · AST Query · Snapshot Service · PTY
```

See [Architecture Document](ARCHITECTURE.md) for the full technical description, or browse the [docs/](docs/) directory for focused deep-dives on each subsystem.

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture Overview](ARCHITECTURE.md) | Complete technical architecture (start here) |
| [Engrams & Memory](docs/engrams.md) | Hash-addressed knowledge units, activation states, memory regions |
| [Batch Executor](docs/batch-executor.md) | Unified tool surface, operation families, dataflow, intents, error recovery |
| [Subagents](docs/subagents.md) | Delegate models: four roles, snapshot loop, scoped HPP, budgets, `delegate.*` batch ops |
| [Freshness System](docs/freshness.md) | Universal freshness (`canSteerExecution`, staged `stageState`), staleness detection, snapshot tracking, preflight (`context` full + store refresh), round-end sweep of chunks/archive/**staged** via bulk `get_current_revisions`, rebase strategies |
| [Hash Protocol](docs/hash-protocol.md) | HPP visibility tracking and UHPP reference syntax |
| [Prompt Assembly](docs/prompt-assembly.md) | Cache-aware prompt construction and middleware pipeline |
| [History Compression](docs/history-compression.md) | Hash-reference deflation, rolling window, distilled summary, snapshot format v5 persistence |
| [API Economics](docs/api-economics.md) | The caching problem and what would fix it |
| [Studio App Shell](docs/studio-app-shell.md) | Desktop UI structure, panel layout, and shell-level responsibilities |
| [Tauri Backend](docs/tauri-backend.md) | Native Rust service layer, command groups, and backend boundaries |
| [Tauri command list](docs/tauri-commands.md) | All `invoke` names registered in `src-tauri` (IPC inventory) |
| [Session Persistence](docs/session-persistence.md) | Per-project chat DB, auto-resume last session, cold restore vs deferred freshness reconcile, Tauri close flush, memory snapshots, swarm persistence |
| [Swarm And Orchestration](docs/swarm-orchestration.md) | Multi-agent research, planning, execution, and task coordination |
| [ATLS Engine](docs/atls-engine.md) | Shared Rust engine for indexing, parsing, queries, and project state |
| [MCP Integration](docs/mcp-integration.md) | External MCP server surface and how it differs from the Studio host |

## Tech Stack

- **Frontend**: TypeScript, React, Zustand (state management), Vite
- **Backend**: Rust, Tauri v2
- **Code Intelligence**: Custom ATLS engine (semantic search, symbol resolution, dependency graphs)
- **Supported Providers**: Anthropic (Claude), OpenAI, Google (Gemini/Vertex), LM Studio

## Repository layout

Paths below are from the **Git repository root** (the folder that contains `ARCHITECTURE.md` and `docs/`).

| Path | Contents |
|------|----------|
| **`docs/`** | Subsystem markdown (freshness, batch executor, Tauri, etc.) |
| **`atls-rs/`** | Rust ATLS engine (`atls-core`) and MCP crate |
| **`atls-studio/`** | Desktop app package — **run all npm scripts from here** |

The Tauri app’s frontend and `src-tauri/` live under **`atls-studio/atls-studio/`** (nested folder). Do not confuse with a top-level `src-tauri/` at repo root (that path is gitignored if present).

## Setup

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 20+ (see `engines` in `atls-studio/package.json`)
- [npm](https://docs.npmjs.com/) (lockfile: `atls-studio/package-lock.json`)

### Install and Run

```bash
cd atls-studio
npm install
npm run tauri:dev
```

### Build

```bash
npm run tauri:build
```

## Project Structure (app package)

From **`atls-studio/`** (the nested app directory):

```
atls-studio/                 # app package — cd here for npm run …
├── src/                     # TypeScript frontend
│   ├── components/          # React UI components
│   ├── hooks/               # React hooks (chat persistence, etc.)
│   ├── prompts/             # Cognitive Core, tool reference, mode prompts
│   ├── services/            # Core services
│   │   ├── aiService.ts     # Prompt assembly, streaming, round loop
│   │   ├── contextFormatter.ts
│   │   ├── hashProtocol.ts
│   │   ├── historyCompressor.ts
│   │   ├── freshnessPreflight.ts
│   │   ├── promptMemory.ts
│   │   └── batch/           # Batch executor (handlers, intents, executor)
│   ├── stores/
│   └── utils/
├── src-tauri/src/           # Rust backend (many modules; see docs/tauri-commands.md)
└── package.json
```

Repo-level **`docs/`** (next to the `atls-studio/` app folder) holds the architecture deep-dives linked from the table above.

## License

[Business Source License 1.1](LICENSE) — Free for non-commercial use, research, evaluation, and personal projects. Commercial use requires a separate license. Converts to Apache 2.0 on March 18, 2030.
