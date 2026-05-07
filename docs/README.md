# ATLS Studio — Documentation Index

**ATLS** (Augmented Thinking and Language System) is a **code-first cognitive runtime** implemented as an output-compression-first desktop coding agent — approximately **200k LOC** across TypeScript and Rust.

Code is the first mature domain because it gives the runtime concrete anchors: files, symbols, diffs, diagnostics, tests, git history, and verifiable edits. The underlying runtime is broader: hash-addressed work objects, managed working memory, blackboard state, freshness-aware references, batchable tool execution, session persistence, telemetry, and scoped subagents.

Two protocols make that runtime practical:

- **UHPP (Universal Hash Pointer Protocol)** — a reference calculus for addressing, slicing, shaping, and composing LLM working memory (`h:SHORT:slice:shape:op` with temporal refs, set selectors, symbol extraction, and content-as-ref resolution).
- **HPP (Hash Presence Protocol)** — a round-scoped visibility state machine (`materialized → referenced → archived → evicted`) over content-addressed engrams with scoped views for multi-agent coordination.

The core thesis: **every token the model emits should express intent the runtime cannot infer**. Names, paths, coordinates, narration, repetitions, stale-state checks, line rebasing, and context lifecycle are the runtime's job. Measured result: **97.6% cost reduction** from the batch primitive alone on a representative self-audit workload; **20–50× output compression** across all six axes versus naive tool-calling agents.

Start with **[cognitive-runtime.md](./cognitive-runtime.md)** for what ATLS does in practice, then read the **[whitepaper](./whitepaper.md)** for the full technical treatment.

---

## Quick start

```bash
cd atls-studio
npm install
npm run tauri:dev
```

Architecture overview: [`atls-studio/docs/ARCHITECTURE.md`](../atls-studio/docs/ARCHITECTURE.md)

---

## Core protocols

| Doc | What it covers |
|-----|----------------|
| **[whitepaper.md](./whitepaper.md)** | **Full technical paper**: output-compression-first thesis, UHPP grammar + semantics, HPP state machine, six compression axes, ten-layer input compression stack, ~200k LOC system architecture, freshness as epistemic integrity, self-audit evaluation, EBNF grammar, cost model |
| **[cognitive-runtime.md](./cognitive-runtime.md)** | **Practical synthesis**: what ATLS does, why it is effective, what is mature today, and how UHPP/HPP, FileViews, batch execution, freshness, compression, telemetry, and subagents compose into a code-first cognitive runtime |
| **[hash-protocol.md](./hash-protocol.md)** | UHPP reference syntax (v6): `h:` refs, line ranges, shapes, symbols, selectors, set algebra, temporal refs, recency refs, blackboard refs, diff refs, content-as-ref, batch-level resolution |
| **[output-compression.md](./output-compression.md)** | Cross-cutting output-token compression inventory across six axes (lexical / semantic / temporal / spatial / computational / transcript) with per-mechanism source links |
| **[engrams.md](./engrams.md)** | Working memory chunks + the **Unified FileView** surface: data model, activation states (`Active → Dormant → Archived → Evicted`), FileView lifecycle (pin-gated render, skeleton + fills + fullBody, auto-heal reconcile, TTL-thin), memory regions (`chunks`, `fileViews`, archive, staged, blackboard) |

## Freshness & edits

| Doc | What it covers |
|-----|----------------|
| **[freshness.md](./freshness.md)** | Universal freshness (`canSteerExecution`, `UniversalState`), staged `stageState`, snapshot tracker, awareness levels, hash injection, freshness states (fresh/forwarded/shifted/changed/suspect), preflight gating, round-end bulk revisions, reconciliation, own-write suppression, freshness telemetry |
| [batch-executor.md](./batch-executor.md) | `batch()` tool surface, step loop, snapshot injection, intent expansion, `line_edits` coordinate model (intra-step + cross-step rebase), `edits_resolved` chaining, op/param shorthands, execution policy, error recovery |
| [symbol-resolver.md](./symbol-resolver.md) | Tiered regex resolver for `fn()`/`cls()`/`sym()` anchors, string/comment-aware `findBlockEnd` (8 block-end strategies), TS/Rust deterministic parity, consumers (`hashResolver`, `freshnessPreflight`) |

## Prompt & memory

| Doc | What it covers |
|-----|----------------|
| [prompt-assembly.md](./prompt-assembly.md) | State vs chat separation, BP-static + BP3 cache layers, state block prepended into last user message, entry manifest depth, tool-loop steering signals, cognitive core, working memory block |
| [assess-context.md](./assess-context.md) | Ephemeral pinned-WM cleanup steering: `<<ASSESS:…>>` block with per-row `release` / `compact` / `hold` options, trigger model (user-turn boundary + mid-loop pressure), single-fire dedupe by `(candidate set, CTX bucket)`, ranking (`tokens × (idleRounds + 2 × survivedEditsWhileIdle)`), silent edit-forward detection via session sidecar |
| [auto-pin-on-read.md](./auto-pin-on-read.md) | Retention default inverted: `rs` / `rl` / `rc` / `rf` auto-pin their FileView; model's vocabulary collapses to release-only (`pu` / `pc` / `dro`). Settings flag `autoPinReads`, `autoPinnedAt` marker on FileView, `autoPinsCreated` / `autoPinsReleasedUnused` telemetry on RoundSnapshot, cognitive-core simplification (~106 cached tokens saved) |
| [history-compression.md](./history-compression.md) | Hash deflation (threshold 100/200 tokens), `deflateToolResults` chunk creation, `stubBatchToolUseInputs` (assistant side), rolling verbatim window (20 rounds) + distilled summary (1.65k tokens), substantive round counting, **batch-shell cruft reduction** (failed-step dedupe, FileView-merge pointer, `isContentArchiveWorthy` skip-archive gate, repeated-misuse telemetry) |
| **[input-compression.md](./input-compression.md)** | Ten-layer input compression stack: TOON wire format, dictionary compression with ditto encoding, shaped reads (progressive disclosure), FileView merging, history deflation, cache-aware prompt layout, token budget admission control, HPP materialization gating, workspace-context TOON, UHPP content references — with algorithmic detail and source links |
| [api-economics.md](./api-economics.md) | Input/output cost asymmetry, cache breakpoint architecture, pricing mismatch analysis, mitigation strategies |
| [input-compression-merit.md](./input-compression-merit.md) | Merit assessment of a proposed "dictionary + ditto-mark" input compressor for tabular tool results: overlap with `compactByFile`/TOON/engram deflation, risks (tokenizer, cache thrash, decode cost), scoped spike gates and kill criteria |
| [metrics.md](./metrics.md) | Billing-grade vs estimated metric tiers: full catalog of chat/session/today cost, cumulative savings delta math, FileView-aware WM token counting, cache-savings formula, `RoundSnapshot.cacheSavingsCents`, tooltip tier prefixes, test invariants |
| [session-persistence.md](./session-persistence.md) | Session save/restore, auto-resume, memory snapshot format v2–v6, freshness-after-restore timing, Tauri close flush |

## Multi-agent

| Doc | What it covers |
|-----|----------------|
| [swarm-orchestration.md](./swarm-orchestration.md) | Multi-agent orchestration, research digest (symbols, dependency graph, edit targets), task hydration with token-budget degradation, dependency-aware scheduling, file-claim enforcement |
| [subagents.md](./subagents.md) | Delegate subagents (retriever/design/coder/tester), engram-first snapshot loop, scoped HPP views, role allowlists, BB-prefixed write scoping, per-role output caps |

## Infrastructure

| Doc | What it covers |
|-----|----------------|
| [atls-engine.md](./atls-engine.md) | `atls-core` Rust engine: `AtlsProject`, `ParserRegistry` (tree-sitter), `Indexer` (incremental + hash-based), `QueryEngine` (FTS + optional neural embeddings), `DetectorRegistry` (pattern-based issue detection), SQLite WAL persistence |
| [tauri-backend.md](./tauri-backend.md) | Native Rust host: `hash_resolver` (UHPP resolution, ~3k LOC), `shape_ops` (shapes + symbol resolver, ~5.7k LOC), `edit_session` (preimage verification), AI streaming (Anthropic, OpenAI, OpenRouter, Gemini/Vertex, LM Studio), PTY terminals, git ops |
| [tauri-commands.md](./tauri-commands.md) | Enumerated Tauri `invoke` command names (`generate_handler!` in `lib.rs`) |
| [mcp-integration.md](./mcp-integration.md) | External MCP server: 7 tools over stdio JSON-RPC, per-root project caching, literal paths only (no UHPP) |
| [studio-app-shell.md](./studio-app-shell.md) | React/Vite UI: multi-panel workspace, AtlsPanel tabs (Issues/File/Patterns/Overview/Health), Internals dashboard (batch efficiency, tool tokens, cache composition, cost I/O, spin trace), copy last API payload |
| [test-coverage-backlog.md](./test-coverage-backlog.md) | Test strategy: 185 frontend test files, Rust `#[cfg(test)]` coverage across most `src-tauri` and `atls-rs` modules, Playwright E2E, coverage gap tracking |

## Repo layout

```
atls-studio/          # Tauri desktop app (React + Rust)
  src/                #   TypeScript: cognitive runtime, batch handlers, prompt system, stores, UI
  src-tauri/          #   Rust backend: 36 Rust files (hash resolver, shape ops, edit session, AI streaming, persistence)
  e2e/                #   Playwright E2E tests
atls-rs/              # Reusable Rust engine
  crates/atls-core/   #   Code intelligence: indexer, query engine, detectors, DB
  crates/atls-mcp/    #   MCP server
docs/                 # This folder: 26 focused docs including the whitepaper
```

- **Architecture overview**: [`atls-studio/docs/ARCHITECTURE.md`](../atls-studio/docs/ARCHITECTURE.md)
- **App README** (npm scripts, dev/build): [`atls-studio/README.md`](../atls-studio/README.md)
