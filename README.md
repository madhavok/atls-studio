# ATLS Studio

**ATLS Studio is a code-first cognitive runtime for software engineering.** It is a desktop agent environment that gives an LLM managed working memory, hash-addressed references, freshness-aware editing, batchable tools, and verification loops, then grounds those capabilities in real code: files, symbols, diagnostics, tests, git history, and a Rust indexing engine.

ATLS is not just a chat UI wrapped around shell commands. It keeps work objects alive across turns, lets the model refer to code without copying it, blocks edits against stale or unread snapshots, rebases line coordinates after mutations, delegates scoped work to subagents, and records first-party telemetry so cost, cache behavior, context pressure, and tool efficiency are visible instead of guessed.

**Built with** TypeScript + React + Rust (Tauri) | **Providers** Anthropic · OpenAI · OpenRouter · Google (Gemini/Vertex) · LM Studio

---

## What ATLS Does

ATLS turns long-running software work into addressable runtime state. A model can read a file as a cheap signature, slice only the relevant lines, pin that FileView into working memory, edit through hash-checked coordinates, verify the result, and carry the surviving context into the next round without re-pasting the world. The same runtime also manages blackboard notes, staged snippets, task plans, archived refs, delegated subagents, and session restore.

That makes ATLS effective in the places where ordinary coding agents become expensive or unreliable: repeated reads, stale context, copied code, multi-step edits, noisy transcripts, and unmeasured token spend.

## Why It Works

The core design rule is simple: **every token the model emits should express intent the runtime cannot infer**. Names, paths, line coordinates, repeated context, stale-state checks, edit rebasing, cache layout, and verification bookkeeping are runtime responsibilities.

ATLS applies that rule on both sides of the token economy:

- **Input compression** keeps what the model reads lean through TOON serialization, shaped reads, FileView incremental access, history deflation, cache-aware prompt layout, token budgets, materialization control, workspace compression, and UHPP content references.
- **Output compression** lets the model write far less through shorthand operations, intent macros, hash refs, recency refs, set selectors, content-as-ref expansion, executor-side line rebasing, auto-verification, and transcript deflation.
- **Epistemic integrity** keeps the runtime honest through snapshot hashes, read-range edit gates, freshness reconciliation, stale-artifact filtering, own-write suppression, and verify artifacts.

The whitepaper reports **20–50× output compression** across representative tool workflows and a **97.6% cost reduction from the batch primitive alone** on a self-audit workload. Those numbers are not magic prompt claims; they come from moving repeated mechanical work out of the model transcript and into a stateful runtime.

See the **[cognitive runtime overview](docs/cognitive-runtime.md)** for the practical model and the **[whitepaper](docs/whitepaper.md)** for the full technical treatment.

## What's New

Recent work tightens the loop between **cheap references**, **honest accounting**, and **what the UI shows** — moving from scattered per-read file chunks and implicit cost toward one file-context pipeline you can reason about and measure.

- **OpenRouter provider** — OpenRouter is now a first-class provider with its own settings entry, model discovery, chat streaming, subagent/swarm routing, rate limits, and runtime pricing from the OpenRouter model catalog. Routed ids like `openai/gpt-5.2`, `anthropic/claude-*`, and `moonshotai/kimi-*` stay under `provider: openrouter` for API keys, cost buckets, and model selection. OpenRouter reasoning/thought deltas are preserved for continuity and coalesced for display so context is retained without token-sized reasoning parts cluttering the transcript.
- **Unified hash namespace** — FileView refs and chunk refs now share the single `h:<short>` shape (6 hex chars). The prior `h:fv:<16>` prefix is retired — the model sees one hash format everywhere, can't templated-truncate across the asymmetry, and retention ops resolve short refs to the view/chunk by prefix match (views win on collision). *Why:* the old asymmetry was a spin vector — the model would see both formats, try to normalize to one, and fail lookups. `resolveAnyRef` unifies the lookup; `RoundSnapshot.refCollisions` tracks the rare cases where a short hash matches both a view and a chunk (~3% birthday bound at session scale; bump `SHORT_HASH_LEN` to 8 if observed).
- **Auto-pin on read + release-only retention** — Reads (`rs`, `rl`, `rc`, `rf`) now auto-pin their FileView; the model's retention vocabulary collapses to release (`pu` / `pc` / `dro`). Explicit `pi` stays available for non-read artifacts (searches, analyses). Saves output tokens on the "keep what I just read" decision (5x output pricing made it dominant), simplifies cognitive core (~106 cached tokens removed, 3 anti-patterns retired), and feeds ASSESS more evidence to rank on. `autoPinReads` setting is an emergency rollback lever (not A/B — the prompt and runtime flip together); telemetry tracks `autoPinsCreated / autoPinsReleasedUnused` so the "was auto-pin correct?" rate is measurable per session.
- **Pinned-WM hygiene (ASSESS + ephemeral retention output)** — Two complementary layers close the silent-accumulator gap. **ASSESS** is an ephemeral steering block that surfaces the oldest / largest pinned targets with a per-row `release | compact | hold` decision when CTX climbs or a pin survives edit-forwards untouched; single-fire dedupe keyed on candidates + CTX bucket. **Ephemeral retention output:** `session.pin/unpin/drop/unload/compact/bb.delete` are state mutations; their effect is visible in the next round's hash manifest. So persisted history carries no tool_result line on success and no tool_use args — the manifest is the receipt. FAIL lines stay loud (the model needs to know it targeted something that isn't there), and zero-match retention now errs loudly at the handler instead of silently faking success. *Why:* any stable shape in prior tool_use becomes a shape the model re-emits verbatim; removing the shape removes the templating vector. Measured 35.5% input-token savings over 20 sub-threshold retention rounds with byte-stable BP3 prefix.
- **Unified FileView (file-context engine)** — Replaces ad hoc per-read fragments with a single retention model: one hash per file, explicit pin / unpin / drop, and session-scoped pins with persisted snapshots. *Why:* the model and user share one stable view of what's in working memory instead of duplicate or silent staging.
- **Shaped markdown reads** — `:sig` on Markdown can return a **heading outline** (not only code-style signatures). *Why:* navigation and structure without pasting the whole note — same compression story as UHPP shapes for code.
- **Experimental tool-result compression** — Optional encoder path for compressing tool output before it hits the transcript. *Why:* under asymmetric pricing, trimming **emissions** matters as much as input packing; this is the next lever after lexical shorthands and batching.
- **Billing-grade metrics** — Cost and savings lines account for FileView + compression consistently. *Why:* if you can’t trust the meter, you can’t tune the runtime; this closes the gap between "feels cheaper" and ledger-grade totals.
- **Batch + planner alignment** — Session shape resolves FileView refs through the unified `h:<short>` namespace, batch steps finalize from real executor outcomes, and `session.plan` subtasks are normalized end-to-end. *Why:* plans and rendered context stay in sync so the agent doesn’t plan against ghosts.
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
- **Ten-layer input compression** -- TOON serialization (30–60% smaller than JSON), dictionary compression on tool results (substring dedup, ditto encoding, key abbreviation), shaped reads (sig/fold/grep at 5–10% of file size), FileView incremental access (one view per file, slices merge), history deflation (hash-reference replacement above 100-token threshold), cache-aware prompt layout (state/chat separation, two breakpoints), token budgets (per-layer admission control via promptMemory), materialization control (HPP visibility gating), workspace context TOON, UHPP content-as-ref (zero-copy inline expansion)
- **Six axes of emission compression** -- lexical (shorthands, TOON), semantic (intent macros, named bindings), temporal (recency refs), spatial (set selectors, shapes, content-as-ref), computational (line rebase, auto-verify, snapshot injection), transcript (hash deflation, rolling-window eviction, batch stubbing)

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

See [Architecture Document](atls-studio/docs/ARCHITECTURE.md) for the full technical description, or browse the [docs/](docs/) directory for 26 focused docs on the core protocols, runtime, backend, and app shell.

## Documentation

| Document | Description |
|----------|-------------|
| **[Whitepaper](docs/whitepaper.md)** | **Full technical paper**: output-compression-first thesis, UHPP grammar, HPP state machine, six compression axes, architecture, evaluation |
| **[Cognitive Runtime](docs/cognitive-runtime.md)** | **Practical synthesis**: what ATLS does, why it is effective, what is mature today, and how the runtime layers compose |
| [Architecture Overview](atls-studio/docs/ARCHITECTURE.md) | Complete technical architecture (start here for code orientation) |
| [Hash Protocol](docs/hash-protocol.md) | UHPP v6 reference syntax + HPP visibility tracking |
| [Output Compression](docs/output-compression.md) | Six-axis emission compression inventory with per-mechanism source links |
| [Input Compression](docs/input-compression.md) | Ten-layer input-side compression stack: TOON, dictionary, shaped reads, FileView, history deflation, cache layout, budgets, HPP, workspace TOON, UHPP |
| [Batch Executor](docs/batch-executor.md) | `batch()` tool surface, operation families, dataflow, intents, line rebase, error recovery |
| [Symbol Resolver](docs/symbol-resolver.md) | Tiered regex resolver, `findBlockEnd`, TS/Rust parity |
| [Freshness System](docs/freshness.md) | Epistemic integrity: five-state taxonomy, preflight gating, round-end reconciliation |
| [Engrams & Memory](docs/engrams.md) | Content-addressed knowledge units, activation states, memory regions |
| [Prompt Assembly](docs/prompt-assembly.md) | State/chat separation, cache breakpoints, dynamic block composition |
| [ASSESS Context](docs/assess-context.md) | Ephemeral pinned-working-memory cleanup steering |
| [Auto-Pin on Read](docs/auto-pin-on-read.md) | Read-time FileView pinning and release-only retention vocabulary |
| [History Compression](docs/history-compression.md) | Hash deflation, rolling window, distilled summary |
| [Input Compression Merit](docs/input-compression-merit.md) | Spike criteria and risk assessment for dictionary/ditto input compression |
| [API Economics](docs/api-economics.md) | The input/output cost asymmetry and what would fix it |
| [Metrics](docs/metrics.md) | Billing-grade and estimated metric tiers for cost, cache, and savings accounting |
| [Swarm Orchestration](docs/swarm-orchestration.md) | Multi-agent research, planning, task hydration, execution |
| [Subagents](docs/subagents.md) | Delegate subagents: four roles, scoped HPP, BB handoff |
| [ATLS Engine](docs/atls-engine.md) | `atls-core` Rust engine: indexer, query, detectors |
| [Tauri Backend](docs/tauri-backend.md) | Native Rust host: hash resolver, shape ops, edit session, AI streaming |
| [Tauri Commands](docs/tauri-commands.md) | All `invoke` names registered in `src-tauri` |
| [MCP Integration](docs/mcp-integration.md) | External MCP server (7 tools, literal paths, no UHPP) |
| [Session Persistence](docs/session-persistence.md) | Snapshot format v2-v6, auto-resume, freshness-after-restore |
| [Studio App Shell](docs/studio-app-shell.md) | Desktop UI, Internals dashboard, panel layout |
| [Test Coverage](docs/test-coverage-backlog.md) | 185 frontend test files, Rust `#[cfg(test)]` coverage across most `src-tauri` and `atls-rs` modules, Playwright E2E |

## Tech Stack

- **Frontend**: TypeScript, React, Zustand, Vite (~120k LOC including 185 test files)
- **Backend**: Rust, Tauri v2 (36 Rust files, ~54k LOC in `src-tauri/src`)
- **Engine**: `atls-core` -- tree-sitter indexing, FTS + optional neural embeddings, pattern detectors (~20k LOC)
- **Providers**: Anthropic (Claude), OpenAI, OpenRouter, Google (Gemini/Vertex), LM Studio

## Repository Layout

```
docs/                         26 focused docs including the whitepaper
atls-rs/                      Reusable Rust engine
  crates/
    atls-core/                  Indexer, query engine, detectors, DB (45 Rust files)
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
  src-tauri/src/                Rust backend (36 Rust files)
  e2e/                          Playwright E2E tests
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
npm run test                    # Vitest (185 frontend test files)
npm run test:coverage:report    # Coverage + gap analysis
npm run test:e2e                # Playwright
npm run test:all                # Vitest + cargo test (src-tauri + atls-rs)
```

## License

[Business Source License 1.1](LICENSE) -- Free for non-commercial use, research, evaluation, and personal projects. Commercial use requires a separate license. Converts to Apache 2.0 on March 18, 2030.
