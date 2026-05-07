# ATLS as a Code-First Cognitive Runtime

ATLS is easiest to understand as a coding agent, because code is where the system is most concrete: files have paths, symbols have ranges, edits have diffs, tests pass or fail, and stale context can be detected. But the useful abstraction is larger than an editor. ATLS is a runtime for externalized cognitive work: it turns what an AI agent knows, reads, changes, verifies, forgets, recalls, and delegates into explicit state that tools can address.

The claim is deliberately bounded. ATLS is not a general AGI platform and it is not equally mature for every domain. It is code-first because software work supplies strong anchors and objective verification. The same primitives — hash-addressed objects, managed working memory, blackboard state, freshness checks, batch execution, compression, scoped delegation, and telemetry — form a reusable substrate for long-running AI work.

## What ATLS Does

ATLS gives the model a stateful operating surface instead of a growing transcript.

- **It represents work as addressable objects.** Files, shaped reads, search results, tool outputs, blackboard entries, diffs, staged snippets, and verify artifacts become engrams with stable `h:` references.
- **It keeps context bounded and explicit.** Working memory is not whatever happens to remain in chat history. FileViews, pinned refs, archived refs, staged snippets, and blackboard entries are separate runtime regions with lifecycle controls.
- **It lets the model point instead of paste.** UHPP refs can address a file, line range, symbol, shaped view, diff, temporal version, recency target, or blackboard entry without copying the underlying content into every tool call.
- **It turns multi-step work into executable batches.** The `batch()` surface supports ordered steps, dataflow, conditionals, intent expansion, snapshot injection, line rebasing, verification artifacts, and structured error recovery.
- **It protects edits from stale reasoning.** Reads register snapshot identity and line coverage; edits are gated against unread or stale regions; reconciliation forwards, shifts, suppresses, or invalidates state when files change.
- **It delegates without losing the plot.** Retriever, design, coder, and tester subagents operate with scoped HPP views, role allowlists, token budgets, and blackboard handoff instead of uncontrolled transcript sprawl.
- **It measures whether the system is working.** Round snapshots, cost stores, cache metrics, batch-efficiency traces, FileView token accounting, and spin diagnostics make effectiveness observable.

A typical ATLS loop is therefore not "ask model, paste code, run shell." It is: discover cheaply, materialize only the needed slice, retain it as a FileView, edit through a hash-checked coordinate system, verify, reconcile freshness, compact or release old context, and carry durable findings forward.

## Why It Is Effective

ATLS works because it moves repeated mechanical labor out of model text and into runtime machinery.

Ordinary tool-calling agents repeatedly spend high-value output tokens on things the environment could know: file paths, copied code, previous results, JSON boilerplate, line-number arithmetic, stale-state disclaimers, and narration about tool sequencing. ATLS treats those emissions as waste unless they express intent the runtime cannot infer.

The result is practical leverage in several failure modes:

| Failure mode in ordinary agents | ATLS mechanism |
| --- | --- |
| Re-reading the same files because chat state is ambiguous | FileView identity, auto-pin-on-read, HPP visibility, redundant-read blocking |
| Copying large code blocks into tool calls | UHPP refs, shaped reads, content-as-ref resolution |
| Editing stale or unseen code | snapshot tracker, read-range gates, hash preflight, freshness reconciliation |
| Losing long-session decisions in transcript noise | blackboard entries, task plans, staged snippets, session persistence |
| Spending output tokens on JSON and narration | batch shorthand, intent macros, dataflow, executor-side inference |
| Breaking coordinates after prior edits | intra-step and cross-step line rebase, `edits_resolved` chaining |
| Guessing whether cost reductions are real | billing-grade/estimated metric tiers, round snapshots, Internals dashboard |
| Letting subagents duplicate context or drift | scoped HPP views, role budgets, file claims, BB-prefixed handoff |

The economic effect is strongest on output because current model pricing makes generated tokens much more expensive than cached input. ATLS still compresses input aggressively, but the core thesis is output-compression-first: **every token the model emits should express intent the runtime cannot infer**.

## What Is Mature Today

The mature domain is software engineering inside the ATLS desktop/runtime stack.

Implemented and documented capabilities include:

- a Rust code-intelligence engine with indexing, query, detectors, SQLite persistence, and optional embeddings;
- a Tauri backend for file I/O, watcher events, hash resolution, edit sessions, AI streaming, git, terminals, tokenization, and chat persistence;
- a TypeScript cognitive runtime with engrams, FileViews, HPP lifecycle, blackboard, staging, task plans, retention controls, and session restore;
- a batch executor with operation families for discovery, reading, editing, verification, session management, system actions, delegation, and intents;
- UHPP reference resolution across line ranges, shapes, symbols, sets, diffs, temporal refs, recency refs, and content-as-ref fields;
- freshness preflight and round-end reconciliation so the model is steered away from stale artifacts;
- telemetry for prompt/cache behavior, batch efficiency, token/cost accounting, spin detection, and context pressure;
- subagent and swarm infrastructure for bounded delegation.

This is why the docs describe ATLS as **code-first**, not code-only. Code is the proof surface. The runtime primitives are generalizable, but their strongest current implementation is anchored in software projects where correctness can be inspected and verified.

## How The Runtime Layers Compose

| Layer | Responsibility | Primary docs |
| --- | --- | --- |
| Reference layer | Compactly name, slice, shape, compose, and resolve work objects | [hash-protocol.md](./hash-protocol.md), [symbol-resolver.md](./symbol-resolver.md) |
| Memory layer | Maintain engrams, FileViews, active/dormant/archive state, blackboard, staged snippets | [engrams.md](./engrams.md), [auto-pin-on-read.md](./auto-pin-on-read.md) |
| Execution layer | Execute batch steps with dataflow, conditionals, intents, edit rebasing, verification, recovery | [batch-executor.md](./batch-executor.md) |
| Integrity layer | Detect stale context, gate unsafe edits, reconcile changed files, suppress invalid steering | [freshness.md](./freshness.md) |
| Compression layer | Reduce emitted and ingested tokens without hiding necessary state | [output-compression.md](./output-compression.md), [input-compression.md](./input-compression.md), [history-compression.md](./history-compression.md), [prompt-assembly.md](./prompt-assembly.md) |
| Delegation layer | Run scoped retriever/design/coder/tester agents with bounded memory and handoff | [subagents.md](./subagents.md), [swarm-orchestration.md](./swarm-orchestration.md) |
| Measurement layer | Account for cost, cache, FileView tokens, batch efficiency, spin, and context pressure | [metrics.md](./metrics.md), [api-economics.md](./api-economics.md), [assess-context.md](./assess-context.md) |
| Host/product layer | Provide the desktop shell, Rust backend, reusable engine, and external MCP surface | [studio-app-shell.md](./studio-app-shell.md), [tauri-backend.md](./tauri-backend.md), [atls-engine.md](./atls-engine.md), [mcp-integration.md](./mcp-integration.md) |

## What To Tell New Readers

The shortest truthful explanation is:

> ATLS is a code-first cognitive runtime. It gives an AI agent addressable working memory, compressed references, freshness-aware editing, batchable tools, scoped delegation, and telemetry. Code is the first mature domain because files, symbols, diffs, tests, diagnostics, and git make the runtime verifiable. The result is an agent environment that can do real multi-step software work while spending fewer tokens, avoiding stale edits, and keeping its state inspectable.

That statement is forward-looking without pretending the runtime is domain-complete. It says what ATLS already does, why the architecture matters, and why the system is effective in practice.
