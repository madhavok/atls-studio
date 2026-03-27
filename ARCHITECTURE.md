# ATLS Studio: Managed Working Memory for Agentic LLMs

## Abstract

ATLS Studio is a cognitive runtime that gives large language models managed working memory with freshness guarantees. Instead of treating prompt construction as a flat conversation transcript, ATLS structures it as a hash-addressed external-memory system where units of knowledge (engrams) have explicit activation states, freshness tracking, and lifecycle management. Through a unified batch tool interface, the model can operate on this memory while the runtime handles compaction, archival, recall, and staleness detection.

This document describes the architecture, its core subsystems, and the unsolved API-level problem that constrains its economic viability.

---

## 1. The Problem

Current agent frameworks often rely on a growing conversation transcript as the primary prompt substrate. Messages accumulate until the prompt fills, at which point the system either truncates history, summarizes it, or fails. The model has no mechanism to:

- **Selectively retain knowledge** across turns (everything is either in context or gone)
- **Know when its knowledge is stale** (file content may have changed since it was read)
- **Manage memory pressure** (no concept of compaction, archival, or selective recall)
- **Reference prior knowledge efficiently** (must repeat content or lose it)

This leads to two failure modes at scale:

1. **Context bloat**: Long agentic sessions accumulate tool results, file contents, and search output until the window is saturated with noise and the model loses signal.
2. **Stale reasoning**: The model operates on cached file content that has been modified by its own edits or external changes, producing incorrect patches and hallucinated diffs.

ATLS addresses both by introducing a structured working-memory layer into prompt construction.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        ATLS Studio                              │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │  Cognitive   │  │   Batch      │  │   Prompt Assembly     │  │
│  │  Core        │  │   Executor   │  │   & Cache Strategy    │  │
│  │  (prompt)    │  │   (tools)    │  │   (per-round)         │  │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬───────────┘  │
│         │                 │                      │              │
│  ┌──────┴─────────────────┴──────────────────────┴────────────┐ │
│  │                  Context Store (Zustand)                   │ │
│  │  ┌──────────┐  ┌───────────┐  ┌─────────┐  ┌───────────┐   │ │
│  │  │ Working  │  │ Archived  │  │ Staged  │  │ Blackboard│   │ │
│  │  │ Memory   │  │ Chunks    │  │ Snippets│  │ Entries   │   │ │
│  │  │ (chunks) │  │           │  │         │  │           │   │ │
│  │  └──────────┘  └───────────┘  └─────────┘  └───────────┘   │ │
│  └────────────────────────────────────────────────────────────┘ │
│                           │                                     │
│  ┌────────────────────────┴───────────────────────────────────┐ │
│  │              Freshness & Hash Protocol                     │ │
│  │  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌──────────┐   │ │
│  │  │ HPP      │  │ Snapshot  │  │ Freshness│  │ History  │   │ │
│  │  │ (viz     │  │ Tracker   │  │ Preflight│  │ Compress │   │ │
│  │  │  state)  │  │           │  │ & Rebase │  │          │   │ │
│  │  └──────────┘  └───────────┘  └──────────┘  └──────────┘   │ │
│  └────────────────────────────────────────────────────────────┘ │
│                           │                                     │
│  ┌────────────────────────┴───────────────────────────────────┐ │
│  │                   Tauri/Rust Backend                       │ │
│  │  File I/O · Code Search · Edit Session · Dependency Graph  │ │
│  │  Build/Verify · AST Query · Snapshot Service · PTY         │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

The architecture has four layers:

1. **Cognitive Core**: A behavioral prompt that teaches the model how to operate on engrams — to pin, compact, recall, drop, and stage items within its active working set.
2. **Context Store**: A Zustand-based store that maintains four memory regions (working memory, archive, staged snippets, blackboard) with hash-addressed access.
3. **Freshness & Hash Protocol**: Subsystems that track what the model has seen, when it was seen, whether it's still valid, and how to recover when it isn't.
4. **Rust Backend**: A Tauri application providing file I/O, code intelligence, edit sessions with preimage verification, dependency analysis, and build/verify capabilities.

For subsystem-oriented overviews that complement this runtime-focused architecture doc, see:

- [Freshness & Hash-Safe Edits](docs/freshness.md) — snapshot tracking, sequential `line_edits`, cross-step rebase, post-edit refresh, own-write suppression
- [Batch Executor](docs/batch-executor.md)
- [Docs Index](docs/README.md)
- [Studio App Shell](docs/studio-app-shell.md)
- [Tauri Backend](docs/tauri-backend.md)
- [Session Persistence](docs/session-persistence.md)
- [Swarm And Orchestration](docs/swarm-orchestration.md)
- [ATLS Engine](docs/atls-engine.md)
- [MCP Integration](docs/mcp-integration.md)

---

## 3. Engrams: Hash-Addressed Units of Knowledge

The fundamental data unit is the **engram** — a content-addressed chunk of knowledge with lifecycle metadata:

```typescript
interface ContextChunk {
  hash: string;           // 16-char content hash (two FNV-1a 32-bit)
  shortHash: string;      // First 6 chars for human-readable references
  type: ChunkType;        // file, smart, search, symbol, deps, tree, etc.
  content: string;        // Full content or edit-ready digest if compacted
  tokens: number;         // Estimated token count
  source?: string;        // Origin (file path, tool name, command)
  sourceRevision?: string; // File hash when this engram was created
  viewKind?: 'latest' | 'snapshot' | 'derived';
  
  // Lifecycle
  pinned?: boolean;       // Protected from bulk unload
  compacted?: boolean;    // Content replaced with digest
  compactTier?: 'pointer' | 'sig';
  ttl?: number;           // Turns remaining before auto-drop
  lastAccessed: number;   // For LRU ordering
  
  // Freshness
  freshness?: 'fresh' | 'forwarded' | 'shifted' | 'changed' | 'suspect';
  freshnessCause?: FreshnessCause;
  suspectSince?: number;
  
  // Relationships
  annotations?: EngramAnnotation[];
  synapses?: Synapse[];   // caused_by, depends_on, related_to, supersedes, refines
}
```

Every file read, code search, tool result, and edit output creates an engram. The model references engrams by hash (`h:a1b2c3`) rather than repeating content. The UI renders these as expandable code pills — the model never needs to paste raw code into its output.

### 3.1 Activation States

Engrams exist in one of four states:

| State | Content | Visible | Recallable | Created By |
|-------|---------|---------|------------|------------|
| **Active** | Full | This turn | — | Read, edit, search |
| **Dormant** | Digest only (~60 tokens) | Digest in dormant block | Yes, by `h:ref` | Unpinned after turn end |
| **Archived** | Full (in archive map) | No | Yes, by `h:ref` | Unload, subtask advance |
| **Evicted** | Manifest entry only | No | Must re-read | Drop, emergency eviction |

The runtime exposes explicit transition operations to the model:

- **`pin`**: Keeps an engram active across turns (survives `advanceTurn`)
- **`unpin`**: Allows dormancy on next turn
- **`compact`**: Replace content with structural digest (~60 tokens)
- **`unload`**: Move to archive (recallable but not visible)
- **`drop`**: Evict entirely (manifest only, must re-read)
- **`recall`**: Promote from archive or dormant back to active

Pin inherits through edits: editing a pinned engram auto-pins the result and auto-unpins the source.

### 3.2 Memory Regions

The context store maintains four concurrent memory regions:

| Region | Purpose | Persistence | Budget |
|--------|---------|-------------|--------|
| **Working Memory** (`chunks`) | Active and dormant engrams | Session | ~32k tokens |
| **Archive** (`archivedChunks`) | Full content for recall | Session, LRU-capped at 50k tokens | 50k tokens |
| **Staged Snippets** (`stagedSnippets`) | Pre-cached context for Anthropic prompt caching | Session | ~4k tokens, 12 persistent entries |
| **Blackboard** (`blackboardEntries`) | Persistent session knowledge (plans, findings, decisions) | Session + DB | ~4k tokens |

Working memory is the model's primary workspace. The blackboard persists structured knowledge that survives across turns without consuming working memory budget — plans, analysis results, extracted patterns. The model writes to it via `bb_write` and reads via `bb_read`.

### 3.3 Hash Resolution

The system supports a rich hash reference syntax (UHPP — Universal Hash Pointer Protocol):

```
h:a1b2c3          → Direct hash reference
h:a1b2c3:15-50    → Lines 15-50 of the referenced content
h:a1b2c3:sig      → Structural signature (function/class declarations)
h:a1b2c3:fold     → Folded view (collapsed function bodies)
h:a1b2c3:fn(init) → Specific function within the file
h:bb:plan          → Blackboard entry
h:$last            → Most recently accessed engram
h:@edited          → Set of all edited engrams
h:@file=*.ts       → All TypeScript file engrams
h:@pinned          → All pinned engrams
h:@dormant         → All dormant engrams
h:@edited+h:@file=*.rs → Set union (edited Rust files)
h:@search(auth)    → Dynamic search selector
h:abc..h:def       → Diff between two versions
```

Resolution follows a layered lookup: working memory → archive → staged snippets. When found in archive or staged, the engram is promoted back into working memory automatically.

---

## 4. The Batch Executor

All model-initiated actions flow through a single tool: `batch()`. This collapses the traditional multi-tool surface into a structured execution plan:

```json
{
  "version": "1.0",
  "goal": "read auth module, fix the bug, verify",
  "steps": [
    {"id": "r1", "use": "read.context", "with": {"type": "smart", "file_paths": ["src/auth.ts"]}},
    {"id": "e1", "use": "change.edit", "with": {"file_path": "src/auth.ts", "line_edits": [...]}, "if": {"step_ok": "r1"}},
    {"id": "v1", "use": "verify.typecheck", "if": {"step_ok": "e1"}}
  ]
}
```

### 4.1 Operation Families

| Family | Operations | Purpose |
|--------|-----------|---------|
| **discover** | `search.code`, `search.symbol`, `search.usage`, `search.similar`, `search.issues`, `search.patterns`, `search.memory` | Find code |
| **understand** | `read.context`, `read.shaped`, `read.lines`, `read.file`, `analyze.deps`, `analyze.calls`, `analyze.structure`, `analyze.impact`, `analyze.blast_radius`, `analyze.extract_plan` | Comprehend code |
| **change** | `change.edit`, `change.create`, `change.delete`, `change.refactor`, `change.rollback`, `change.split_module` | Modify code |
| **verify** | `verify.build`, `verify.test`, `verify.lint`, `verify.typecheck` | Validate changes |
| **session** | `session.plan`, `session.advance`, `session.status`, `session.pin`, `session.unpin`, `session.compact`, `session.drop`, `session.recall`, `session.stage`, `session.unstage`, `session.unload`, `session.bb.write`, `session.bb.read`, `session.bb.delete`, `session.bb.list`, `session.rule`, `session.emit`, `session.shape`, `session.load`, `session.debug`, `session.stats`, `session.compact_history` | Manage memory and tasks |
| **annotate** | `annotate.engram`, `annotate.note`, `annotate.link`, `annotate.split`, `annotate.merge`, `annotate.retype`, `annotate.design` | Annotate and connect engrams |
| **delegate** | `delegate.retrieve`, `delegate.design` | Dispatch cheaper sub-models |
| **intent** | `intent.understand`, `intent.edit`, `intent.edit_multi`, `intent.investigate`, `intent.diagnose`, `intent.survey`, `intent.refactor`, `intent.create`, `intent.test`, `intent.search_replace`, `intent.extract` | Macro operations (expand to primitives) |

### 4.2 Dataflow Between Steps

Steps can wire outputs to inputs:

```json
{"id": "r1", "use": "read.context", "with": {"file_paths": ["src/api.ts"]}},
{"id": "p1", "use": "session.pin", "in": {"hashes": {"from_step": "r1", "path": "refs"}}}
```

Binding types:
- `{from_step: "s1", path: "refs.0"}` — Output of a prior step, dot-path navigated
- `{ref: "h:a1b2c3"}` — Literal hash reference
- `{bind: "$name"}` — Named binding (from `out` field)
- `{value: 123}` — Literal value

### 4.3 Intent System

Intents are macros that expand to primitive steps before execution. They encode common workflows with built-in error recovery:

`intent.edit` expands to:
1. `read.context` (if file not already read)
2. `change.edit` (the actual edit)
3. `read.lines` (conditional: only if edit fails — re-read for stale hash recovery)
4. `change.edit` (conditional: retry with fresh content)
5. `verify.typecheck` (optional)

The model gets automatic stale-hash retry without manual plumbing. Intents skip steps that are already satisfied — staged files skip re-read, pinned files skip re-pin, blackboard-cached results skip re-search.

### 4.4 Error Recovery

The executor provides three levels of error handling:

1. **Per-step `on_error`**: `stop` (halt batch), `continue` (skip to next), `rollback` (revert prior changes)
2. **Handler-level retry**: The change handler detects `stale_hash`, `anchor_not_found`, `range_drifted`, and `span_out_of_range` errors. On retry-eligible failures, it refreshes content hashes and re-attempts the edit.
3. **Batch interruption**: Operations returning `preview`, `paused`, `rollback`, `action_required`, or `confirm-needed` halt the batch and surface the state to the model for decision.

---

## 5. Freshness: Knowing When Knowledge Is Stale

The freshness system is the critical differentiator. Without it, an agent that reads a file, edits it, then reasons about the old content will produce incorrect results. ATLS tracks freshness at every level.

### 5.1 Snapshot Tracker

During batch execution, the `SnapshotTracker` records the content hash of every file read. When the executor encounters a `change.*` step, it automatically injects the tracked `snapshot_hash` into the edit parameters. The Rust backend then verifies that the file hasn't changed since it was read — if it has, the edit is rejected with `stale_hash`.

Awareness is tiered:

| Level | Meaning | Acquired By |
|-------|---------|-------------|
| **CANONICAL** | Full file content read | `read.context(type: full)` |
| **TARGETED** | Specific line range read | `read.lines` |
| **SHAPED** | Structural signature only | `read.shaped` |
| **NONE** | No awareness | — |

### 5.2 Freshness States

Each engram carries a freshness classification:

| State | Meaning |
|-------|---------|
| **fresh** | Content matches current file state |
| **forwarded** | Hash updated after own edit (known good) |
| **shifted** | Same file edited in a prior step (line numbers may have moved) |
| **changed** | External change detected |
| **suspect** | Freshness uncertain (watcher event, unknown cause) |

### 5.3 Freshness Preflight

Before mutation operations, the freshness preflight classifies every target:

- **Fresh** → proceed
- **Rebaseable** (from own prior edit or hash forward) → attempt line relocation, then proceed
- **Suspect** (external change, watcher event) → hard stop, require re-read

When an engram is rebaseable, the system attempts recovery through a cascade of strategies:

1. **Edit journal**: Use recorded line deltas from prior edits to relocate (high confidence)
2. **Shape match**: Compare structural hash — if unchanged, content is equivalent (high confidence)
3. **Symbol identity**: Resolve symbol name to current line range (medium confidence)
4. **Fingerprint match**: Locate content snippet by fuzzy matching (medium confidence)
5. **Line relocation**: Search for content in a window around expected position (medium/high confidence)
6. **Identity lost**: Cannot locate the content → block the operation

Each recovery attempt records its strategy, confidence, and evidence factors in a `RebindOutcome`, enabling the system to reason about the reliability of its knowledge.

### 5.4 Reconciliation

When files change (via edit, external modification, or watcher event), `reconcileSourceRevision` sweeps all memory regions:

- **Active latest engrams**: Update `sourceRevision` to current
- **Snapshot engrams**: Preserve regardless (intentionally frozen)
- **Derived engrams** with stale revision: Evict (derived content is invalid when source changes)
- **Dormant stale unpinned engrams**: Archive if large enough, drop if small (batch stubs)
- **Staged snippets**: Same logic — update, preserve snapshots, evict stale derived

The model is never silently given stale content. Either the freshness system updates the metadata, blocks the operation, or evicts the stale engram entirely.

---

## 6. The Hash Presence Protocol (HPP)

HPP tracks visibility of every engram across turns, enabling the prompt assembly layer to know exactly what the model can "see":

```typescript
type ChunkVisibility = 'materialized' | 'referenced' | 'archived' | 'evicted';

interface ChunkRef {
  hash: string;
  shortHash: string;
  type: ChunkType;
  visibility: ChunkVisibility;
  seenAtTurn: number;
  pinned?: boolean;
  source?: string;
  tokens: number;
  freshness?: FreshnessState;
}
```

On each turn:
1. `advanceTurn()` increments the turn counter
2. Materialized refs from prior turns (unpinned, `seenAtTurn < currentTurn`) become `referenced`
3. New reads/edits call `materialize()` with current turn
4. Compression calls `dematerialize()` when content is replaced with a hash reference

The prompt formatter uses HPP to decide what to include:
- **Materialized** → Full content in the ACTIVE ENGRAMS section
- **Referenced** → Counted in the dormant summary line
- **Archived** → Invisible, but recallable by hash
- **Evicted** → Gone, must re-read

This means the working memory section of the prompt naturally shrinks as engrams age out, without the model needing to explicitly manage every transition.

---

## 7. History Compression

As the conversation grows, tool results and long messages accumulate. ATLS compresses history by replacing content with hash references:

```
Before: [full 2000-token tool result inline in history]
After:  [-> h:a1b2c3, 2000tk | search results for "auth"]
        fn authenticate:15-32 | cls AuthService:34-89
```

The compressed content remains accessible — the model can recall it by hash reference. Compression runs between user turns (never during a tool loop, to maintain cache prefix stability) and protects recent rounds from compression.

Additionally, `deflateToolResults` runs immediately after tool execution, replacing inline tool results with hash references when a matching engram already exists in working memory. This prevents duplicate content from accumulating between the history and working memory.

### 7.1 Rolling window and distilled summary

A **rolling verbatim window** (see `ROLLING_WINDOW_ROUNDS` in `promptMemory.ts`) keeps only the most recent rounds in full in the history array used for compression. When older rounds age out, `historyDistiller.ts` extracts facts into a structured `RollingSummary` in the context store. For the API payload, the runtime prepends a **synthetic** assistant message beginning with `[Rolling Summary]` — it is not a row in the saved chat transcript. The distilled summary is persisted on disk as part of **snapshot format v5** (`rollingSummary` on the memory snapshot). Details: [docs/history-compression.md](docs/history-compression.md), [docs/session-persistence.md](docs/session-persistence.md).

---

## 8. Prompt Assembly and Cache Strategy

The final prompt sent to the API is assembled in layers with cache awareness:

```
┌─────────────────────────────────────────────────────────────┐
│ CACHED: System prompt + tool definitions (5min TTL)         │
│   Mode prompt · Shell guide · Tool reference · Entry        │
│   manifest · Cognitive Core · HPP spec                      │
│                                           cache_control ──┤ │
├─────────────────────────────────────────────────────────────┤
│ CACHED: Prior conversation history (append-only)            │
│   All prior user/assistant/tool turns                       │
│                              PRIOR_TURN_BOUNDARY ──┤        │
├─────────────────────────────────────────────────────────────┤
│ UNCACHED: Dynamic block (rebuilt every round)               │
│   Staged snippets · Task line · Context stats ·             │
│   Blackboard entries · Dormant engram manifest ·            │
│   Workspace context · Working memory (active engrams) ·     │
│   User message / tool results                               │
└─────────────────────────────────────────────────────────────┘
```

The system places two Anthropic cache breakpoints:
- **BP1+BP2**: On the last tool definition (caches system prompt + all tool schemas as one block)
- **BP3**: On the last prior conversation turn (caches append-only history)

Mutable content (blackboard, dormant manifest, staged snippets, working memory, workspace context) is deliberately placed after the last breakpoint. This ensures that changes to living memory never invalidate the cached prefix.

History compression is deferred to round 0 (between user turns), so within a multi-round tool loop the history prefix is byte-identical and Anthropic serves cache reads at 0.1x cost.

### 8.1 The Middleware Pipeline

Before each round, middleware runs in sequence:

1. **History compression**: On round 0, compress old tool results and long messages into hash references; apply the **rolling window** so excess rounds are distilled into `RollingSummary` rather than kept verbatim (see §7.1)
2. **Context hygiene**: After 20+ rounds, aggressive compression if history exceeds 20k tokens
3. **Prompt budget**: Prune staged snippets if over budget

---

## 9. Cognitive Rules and Self-Directed Behavior

The model can write rules that shape its own reasoning across turns:

```
rule(key: "rust-safety", content: "Always check lifetime issues before proposing moves")
rule(key: "test-first", content: "Write test expectations before implementation")
```

Rules persist within the session and appear in the working memory block on every turn. The model can list, update, and delete its own rules. This enables self-correcting behavior — if the model notices a pattern of errors, it can encode a rule to prevent recurrence.

---

## 10. Task Planning and Subtask Lifecycle

ATLS supports structured task plans with subtask-scoped memory:

```json
{
  "goal": "Refactor auth module into microservice",
  "subtasks": [
    {"id": "s1", "label": "Inventory current auth surface", "status": "done"},
    {"id": "s2", "label": "Extract AuthService class", "status": "active"},
    {"id": "s3", "label": "Update consumers", "status": "pending"}
  ]
}
```

When a subtask advances:
- Engrams bound to the completed subtask are unloaded (freed from working memory)
- A transition bridge surfaces relevant archived context for the next subtask
- The model starts the next subtask with a clean working memory but retains blackboard knowledge

Engrams can be bound to multiple subtasks (`subtaskIds`), surviving until all bound subtasks complete.

---

## 11. The Unsolved Problem: API Economics

ATLS has been validated on Claude Opus, producing correct multi-step agentic behavior with structured working-memory management, freshness guarantees, and context-aware reasoning.

The blocker is economic.

Anthropic's prompt caching model rewards static, immutable prefixes. A chatbot with a fixed system prompt gets 80-90% cache reads at 0.1x input cost. ATLS, by design, has a large mutable working memory that changes every round — because that's what thinking looks like. The engrams shift, the blackboard updates, the dormant manifest reflects compaction, the freshness metadata tracks edits.

In a typical 10-round tool loop:

| Region | Tokens | Cost | Cacheable? |
|--------|--------|------|------------|
| System + tools | ~5k | $0.50/MTok (cached) | Yes |
| History | ~5-10k | $0.50/MTok (cached) | Yes (append-only) |
| Dynamic block (BB, staged, WM, dormant) | ~20-40k | $5.00/MTok (full price) | No — changes every round |
| Output | ~2-4k | $25.00/MTok | N/A |

The dynamic block — the cognitive state — is 60-70% of input tokens, charged at full price, resent on every round. This is the part that makes ATLS work. And it's the part the caching model penalizes.

What would fix this:

- **Content-addressable caching**: Cache individual content blocks by hash, regardless of position. If engram `h:a1b2c3` is byte-identical between rounds, don't charge again. ATLS already assigns stable hashes to every content block — the API just doesn't support this pattern.
- **More granular breakpoints**: 4 breakpoints for a system with 6+ regions of varying stability is insufficient.
- **Diff-based pricing**: Charge full price for tokens that actually changed, 0.1x for tokens that didn't, regardless of position.

The architecture is ahead of where the APIs are. The model can do the cognition. The memory system makes it reliable. The pricing model makes it expensive.

---

## 12. Summary

ATLS Studio demonstrates that LLMs can operate with genuine managed memory when given the right infrastructure:

1. **Hash-addressed engrams** with activation states replace a flat transcript-centric prompt with structured, selectable, referenceable knowledge.
2. **Freshness tracking** with a taxonomy of states and a cascade of recovery strategies ensures the model never silently reasons about stale content.
3. **A unified batch executor** with dataflow bindings, intent macros, and multi-level error recovery provides reliable tool execution.
4. **History compression** via hash-reference deflation keeps the conversation efficient without losing access to prior knowledge.
5. **The Hash Presence Protocol** provides turn-aware visibility tracking, so the prompt assembly layer knows exactly what the model can see.
6. **Structured working-set management** — the model can pin, compact, drop, recall, and write rules to manage its active cognitive state through the runtime.

The result is an agent workflow designed to maintain coherent working memory across many tool-loop rounds, know when its knowledge is stale, recover gracefully from freshness violations, and manage its context budget through the runtime.

---

*ATLS Studio is a Tauri desktop application. The cognitive architecture is implemented in TypeScript (frontend memory management, prompt assembly, batch execution) and Rust (file I/O, code intelligence, edit verification, dependency analysis). The system is model-agnostic but has been validated primarily on Claude Opus via the Anthropic API.*
