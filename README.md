# ATLS Studio

An **output-compression-first** desktop coding agent. ~200k LOC across TypeScript and Rust.

**Built with** TypeScript + React + Rust (Tauri) | **Providers** Anthropic · OpenAI · Google (Gemini/Vertex) · LM Studio

---

## The Thesis

Contemporary LLM coding agents optimize the **context window** — fitting more into the prompt. ATLS optimizes **model emission** — minimizing what the model writes. Under current pricing (output tokens cost 5x input; cached input costs 0.1x uncached), emission dominates cost. A system that lets the model reference code instead of copying it, chain operations instead of narrating them, and trust the runtime instead of re-verifying assumptions can compress output by **20-50x** versus naive tool-calling agents.



See the **[whitepaper](docs/whitepaper.md)** for the full technical treatment.

## What's New

Recent work tightens the loop between **cheap references**, **honest accounting**, and **what the UI shows** — moving from scattered per-read file chunks and implicit cost toward one file-context pipeline you can reason about and measure.

- **Unified FileView (file-context engine)** — Replaces ad hoc per-read fragments with a single retention model: one hash per file, explicit pin / unpin / drop, and session-scoped pins with persisted snapshots. *Why:* the model and user share one stable view of what's in working memory instead of duplicate or silent staging.
- **Shaped markdown reads** — `:sig` on Markdown can return a **heading outline** (not only code-style signatures). *Why:* navigation and structure without pasting the whole note — same compression story as UHPP shapes for code.
- **Experimental tool-result compression** — Optional encoder path for compressing tool output before it hits the transcript. *Why:* under asymmetric pricing, trimming **emissions** matters as much as input packing; this is the next lever after lexical shorthands and batching.
- **Billing-grade metrics** — Cost and savings lines account for FileView + compression consistently. *Why:* if you can’t trust the meter, you can’t tune the runtime; this closes the gap between "feels cheaper" and ledger-grade totals.
- **Batch + planner alignment** — Session shape resolves `h:fv:` through FileView, batch steps finalize from real executor outcomes, and `session.plan` subtasks are normalized end-to-end. *Why:* plans and rendered context stay in sync so the agent doesn’t plan against ghosts.
- **Prompt cost ordering restored** — File-read prompts put **signature / shaped** paths ahead of verbatim dumps where that hierarchy applies. *Why:* nudges the model toward the cheaper primitive first, matching the protocol design.
- **Context meter clarity** — Tooltips and copy distinguish session **in vs out** token flows on the meter. *Why:* the UI should explain the same economics the runtime optimizes for.

For protocol details on shapes and memory, see [Output Compression](docs/output-compression.md), [Engrams & Memory](docs/engrams.md), and [Hash Protocol](docs/hash-protocol.md).

## Core Protocols

### UHPP -- Universal Hash Pointer Protocol

A reference calculus for LLM working memory. One expression addresses, slices, shapes, and composes content:

```
h:a1b2c3                       direct reference
h:a1b2c3:15-50                 line slice
h:a1b2c3:fn(init):sig          function signature only
h:a1b2c3:fn(init):sig:dedent   shaped + stripped
h:@edited&h:@file=*.ts         set intersection
h:$last_edit                   recency ref
HEAD~1:src/auth.ts:sig         temporal ref (git history)
"content": "h:XXXX:fn(name)"   content-as-ref (inline resolution)
```

Symbol anchors resolve through a **tiered regex + block-end scanner** (not tree-sitter in the hot path) with TypeScript/Rust parity -- sync, pure, no IPC. See [symbol-resolver.md](docs/symbol-resolver.md).

### HPP -- Hash Presence Protocol

A round-scoped visibility state machine over content-addressed engrams:

```
materialized -> referenced -> archived -> evicted
```

Tracks what the model can currently "see." Scoped views let subagents participate without disturbing global presence state. Pinned engrams survive turn boundaries; unpinned refs dematerialize automatically.

## Key Capabilities

- **Single batch tool** -- 76 operations across 9 families (discover, understand, change, verify, session, annotate, delegate, intent, system), step-to-step dataflow, conditional execution, intent macros that expand to primitive sequences
- **Six axes of emission compression** -- lexical (shorthands, TOON), semantic (intent macros, named bindings), temporal (recency refs), spatial (set selectors, shapes, content-as-ref), computational (line rebase, auto-verify, snapshot injection), transcript (hash deflation, rolling summary, batch stubbing)
- **Freshness as epistemic integrity** -- five-state taxonomy (fresh/forwarded/shifted/changed/suspect), preflight gating before every mutation, round-end reconciliation, universal filter on steering signals, own-write suppression
- **Managed working memory** -- content-addressed engrams with HPP visibility, tiered eviction, staging, blackboard, task plans with subtask-scoped lifecycle
- **Multi-agent orchestration** -- research digest with dependency graphs, task hydration with token-budget degradation, file-claim enforcement, engram-first delegate subagents (retriever/design/coder/tester) with scoped HPP views
- **History compression** -- hash-reference deflation (100-token threshold), assistant-side batch stubbing, rolling verbatim window (20 rounds) + distilled summary (1.65k tokens), emergency compression under pressure
- **Cache-optimized prompt assembly** -- state/chat separation (state assembled fresh, never in transcript), two cache breakpoints (static system + append-only history), 9 layered prompt modules (~20k chars of behavioral control)
- **Code intelligence engine** -- tree-sitter indexing, incremental scanning, FTS + optional neural embeddings, pattern-based issue detection, reusable across Tauri host and MCP server
- **First-party telemetry** -- batch efficiency, tool-token distribution, cache composition, cost I/O, spin detection, round snapshots (200-snapshot ring buffer)

## Architecture

```
  Prompt System (9 modules)    Batch Executor (76 ops)    Prompt Assembly (per-round)
         |                          |                            |
         +--------------------------+----------------------------+
                                    |
                    +---------------+---------------+
                    |        Context Store           |
                    |  (WM . Archive . Staged . BB)  |
                    +---------------+---------------+
                                    |
        +-----------+-----------+---+---+-----------+------------+
        |    HPP    | Snapshot  |Fresh- | History   |   Spin     |
        |(visibility)| Tracker  |ness   | Compress  | Detection  |
        +-----------+-----------+-------+-----------+------------+
                                    |
        +-----------+-----------+---+---+-----------+------------+
        |   UHPP    |  Symbol   | Edit  |    AI     |  Session   |
        | Resolver  | Resolver  |Session| Streaming |Persistence |
        +-----------+-----------+-------+-----------+------------+
                                    |
                    +---------------+---------------+
                    |     atls-core (Rust engine)    |
                    |  Indexer . Query . Detectors   |
                    |  Tree-sitter . FTS . SQLite    |
                    +-------------------------------+
```

See [Architecture Document](atls-studio/docs/ARCHITECTURE.md) for the full technical description, or browse the [docs/](docs/) directory for 19 focused deep-dives on each subsystem.

## Documentation

| Document | Description |
|----------|-------------|
| **[Whitepaper](docs/whitepaper.md)** | **Full technical paper**: output-compression-first thesis, UHPP grammar, HPP state machine, six compression axes, architecture, evaluation |
| [Architecture Overview](atls-studio/docs/ARCHITECTURE.md) | Complete technical architecture (start here for code orientation) |
| [Hash Protocol](docs/hash-protocol.md) | UHPP v6 reference syntax + HPP visibility tracking |
| [Output Compression](docs/output-compression.md) | Six-axis emission compression inventory with per-mechanism source links |
| [Batch Executor](docs/batch-executor.md) | `batch()` tool surface, operation families, dataflow, intents, line rebase, error recovery |
| [Symbol Resolver](docs/symbol-resolver.md) | Tiered regex resolver, `findBlockEnd`, TS/Rust parity |
| [Freshness System](docs/freshness.md) | Epistemic integrity: five-state taxonomy, preflight gating, round-end reconciliation |
| [Engrams & Memory](docs/engrams.md) | Content-addressed knowledge units, activation states, memory regions |
| [Prompt Assembly](docs/prompt-assembly.md) | State/chat separation, cache breakpoints, dynamic block composition |
| [History Compression](docs/history-compression.md) | Hash deflation, rolling window, distilled summary |
| [API Economics](docs/api-economics.md) | The input/output cost asymmetry and what would fix it |
| [Swarm Orchestration](docs/swarm-orchestration.md) | Multi-agent research, planning, task hydration, execution |
| [Subagents](docs/subagents.md) | Delegate subagents: four roles, scoped HPP, BB handoff |
| [ATLS Engine](docs/atls-engine.md) | `atls-core` Rust engine: indexer, query, detectors |
| [Tauri Backend](docs/tauri-backend.md) | Native Rust host: hash resolver, shape ops, edit session, AI streaming |
| [Tauri Commands](docs/tauri-commands.md) | All `invoke` names registered in `src-tauri` |
| [MCP Integration](docs/mcp-integration.md) | External MCP server (7 tools, literal paths, no UHPP) |
| [Session Persistence](docs/session-persistence.md) | Snapshot format v2-v6, auto-resume, freshness-after-restore |
| [Studio App Shell](docs/studio-app-shell.md) | Desktop UI, Internals dashboard, panel layout |
| [Test Coverage](docs/test-coverage-backlog.md) | 148 TS tests, 36/38 Rust `#[cfg(test)]`, Playwright E2E |

## Tech Stack

- **Frontend**: TypeScript, React, Zustand, Vite (~100k LOC including 148 test files)
- **Backend**: Rust, Tauri v2 (38 modules, ~40k LOC in `src-tauri`)
- **Engine**: `atls-core` -- tree-sitter indexing, FTS + optional neural embeddings, pattern detectors (~20k LOC)
- **Providers**: Anthropic (Claude), OpenAI, Google (Gemini/Vertex), LM Studio

## Repository Layout

```
docs/                         19 subsystem docs + whitepaper
atls-rs/                      Reusable Rust engine
  crates/
    atls-core/                  Indexer, query engine, detectors, DB (~55 .rs files)
    atls-mcp/                   External MCP server (7 tools, stdio JSON-RPC)
atls-studio/                  Desktop app -- run npm scripts from here
  src/                          TypeScript frontend
    components/                   React UI (AiChat, AtlsPanel, SwarmPanel, CodeViewer, Internals)
    hooks/                        useAtls, useChatPersistence
    prompts/                      Cognitive core, tool ref, mode prompts, edit discipline
    services/                     aiService, hashProtocol, freshness, orchestrator
      batch/                        Executor, 10 handler files, intents, policy
    stores/                       contextStore, appStore, costStore, roundHistory, swarm, terminal
    utils/                        symbolResolver, toon, contextHash, uhpp*, tokenCounter
  src-tauri/src/                Rust backend (38 modules)
  e2e/                          Playwright E2E tests
REVIEWED_CLEAN.md             Audit status: reviewed files, bugs found/fixed
```

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

### Test

```bash
cd atls-studio
npm run test                    # Vitest (148 test files)
npm run test:coverage:report    # Coverage + gap analysis
npm run test:e2e                # Playwright
npm run test:all                # Vitest + cargo test (src-tauri + atls-rs)
```

## License

[Business Source License 1.1](LICENSE) -- Free for non-commercial use, research, evaluation, and personal projects. Commercial use requires a separate license. Converts to Apache 2.0 on March 18, 2030.
