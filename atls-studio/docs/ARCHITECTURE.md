# ATLS Studio Architecture

## Overview

ATLS Studio is a Tauri desktop application that wraps the ATLS cognitive runtime in a React/TypeScript UI and a Rust analysis backend. The system is organized around managed working memory: reads, searches, edits, verification results, and chat/tool artifacts are all represented as hash-addressed references that can be pinned, staged, compacted, archived, recalled, and verified across turns.

This document describes the major ATLS subsystems and the subsystems inside those subsystems so contributors can quickly identify where a behavior lives and which layer should own a change.

## System Boundaries

| Boundary | Primary implementation | Responsibility |
|---|---|---|
| Desktop shell | Tauri | Native windowing, IPC, filesystem and process access |
| Frontend runtime | `atls-studio/src` | UI, orchestration, memory management, prompt assembly, tool loops |
| Backend core | `atls-rs/crates/atls-core` | Parsing, queries, indexing, detector execution |
| AI provider edge | provider adapters configured in Studio settings | Model selection, streaming, token accounting, tool-call exchange |

## Core Architectural Principles

1. **Hash-addressed memory first** — content is tracked by stable `h:XXXX` references rather than by temporary UI state.
2. **Managed working memory** — active context is intentionally bounded; pinning, staging, compaction, archival, and recall are first-class operations.
3. **Turn-based freshness** — reads and edits are tracked against revisions and turns so the runtime can detect stale context.
4. **Batch-oriented execution** — the UI submits structured tool steps, while the runtime tracks read coverage, edit safety, and verification results.
5. **Durable reasoning artifacts** — blackboard entries, task plans, and verification artifacts survive far longer than the transient prompt window.

## Top-Level Layer Map

```text
┌──────────────────────────────────────────────────────────┐
│ React UI surface                                         │
│ AiChat · CodeViewer · FileExplorer · AtlsPanel · Internals │
├──────────────────────────────────────────────────────────┤
│ Application orchestration                                │
│ appStore: sessions, settings, workspaces, agent state    │
├──────────────────────────────────────────────────────────┤
│ Managed memory runtime                                   │
│ contextStore + hashProtocol + round history              │
├──────────────────────────────────────────────────────────┤
│ Prompt and tool runtime                                  │
│ contextHash + promptMemory + tokenCounter + batch tools  │
├──────────────────────────────────────────────────────────┤
│ Rust analysis core                                       │
│ parser + query + indexer + detector                      │
└──────────────────────────────────────────────────────────┘
```

## Subsystem Map

| Subsystem | Primary files | Nested subsystems |
|---|---|---|
| UI and application shell | `src/components/*`, `src/stores/appStore.ts` | chat/session model, workspace model, agent control plane, prompt metrics view |
| Managed memory runtime | `src/stores/contextStore.ts`, `src/services/hashProtocol.ts` | engram registry, staging, blackboard, task planning, freshness/reconcile, auto-management |
| Prompt construction | `src/utils/contextHash.ts`, `src/services/promptMemory.ts`, `src/utils/tokenCounter.ts` | digests and ref formatting, prompt-budget policy, provider-aware token counting |
| Batch and tool execution | `src/utils/toon.ts`, `src/services/batch/intents.ts`, `src/services/batch/snapshotTracker.ts` | TOON serialization, line-per-step parsing, intent expansion, read-range awareness |
| History and verification telemetry | `src/stores/roundHistoryStore.ts` | round snapshots, verification confidence, cost summaries |
| Rust analysis core | `atls-rs/crates/atls-core/src/*` | parser, query engine, indexer, detector pipeline |

## Frontend Runtime

### 1. Application Shell and Orchestration Subsystem

Primary module: `atls-studio/src/stores/appStore.ts`

`appStore` is the top-level UI orchestration store. It is the place where the user-visible application state is assembled into a single runtime model.

#### Nested subsystems inside `appStore`

| Nested subsystem | Key types | Responsibility |
|---|---|---|
| Chat/session model | `Message`, `MessagePart`, `MessageSegment`, `ChatSession` | Stores chat history, streamed assistant output, and tool-call presentation state |
| Tool-call UI model | `MessageToolCall`, `ToolCall`, `ToolCallStatus`, `StreamChunk`, `StreamPart` | Tracks streaming tool inputs/outputs and how they appear in the chat surface |
| Workspace/project model | `WorkspaceEntry`, `ProjectProfile`, `EntryManifestEntry`, `RootFileTree`, `FileNode`, `ScanStatus` | Represents open workspaces, project summaries, and explorer state |
| Agent control plane | `Agent`, `ChatMode`, `AgentProgress`, `AgentPendingActionState`, `ToolLoopSteering` | Tracks active agent mode, progress, pending actions, and steering metadata |
| Prompt/accounting view | `ContextUsage`, `PromptMetrics`, `CacheMetrics`, `LogicalCacheState`, `PromptSnapshot` | Exposes prompt-size and cache telemetry to the UI |
| User settings | `Settings`, `AIProvider`, `ModelInfo`, `FocusProfile` | Stores provider choices, model configuration, and focus metadata |

#### What belongs here

- Session lifecycle and title generation
- Open-file and file-tree state
- User settings and provider configuration
- Agent progress and pending-action UI
- Prompt metrics shown to the user

#### What does not belong here

- Chunk lifecycle and archival logic
- Blackboard persistence rules
- Prompt-budget admission policies
- Batch step parsing or snapshot coverage logic

Those responsibilities belong to the subsystems below.

### 2. UI Component Subsystem

Primary entry points include:

- `src/components/AiChat/index.tsx`
- `src/components/CodeViewer/index.tsx`
- `src/components/FileExplorer/index.tsx`
- `src/components/AtlsPanel/index.tsx`
- `src/components/AtlsInternals/index.tsx`

These components are the rendering layer over the stores and services. They do not define the memory model; they consume it.

Typical responsibilities:

- `AiChat` renders streamed chat and tool loops
- `CodeViewer` renders file content and hash-addressed slices
- `FileExplorer` renders workspace structure and navigation state
- `AtlsPanel` assembles the working surfaces into the ATLS shell
- `AtlsInternals` exposes internal runtime state for inspection/debugging

## Managed Memory Runtime

### 3. Context Store Subsystem

Primary module: `atls-studio/src/stores/contextStore.ts`

`contextStore` is the heart of ATLS working memory. It owns the live chunk graph, the archived/dropped state, staging, blackboard artifacts, task plans, awareness data, and memory telemetry.

#### Nested subsystems inside `contextStore`

| Nested subsystem | Key types/functions | Responsibility |
|---|---|---|
| Engram registry | `ContextChunk`, `findChunkByRef`, `findOrPromoteEngram` | Stores active memory objects and resolves hash references |
| Stage manager | `StagedSnippet`, `findStagedByRef`, stage priority helpers | Holds prepared snippets that are cheaper than full chunks but more concrete than BB notes |
| Blackboard | `BlackboardEntry`, `parseBbKey`, `inferBbFilePath` | Persists findings, plans, status, and other durable reasoning artifacts |
| Task planner | `TaskDirective`, `SubTask`, `TaskPlan`, `session.advance` state transitions | Tracks subtask progress and context manifests for multi-step work |
| Awareness and read coverage | `ReadSpan`, `AwarenessCacheEntry` | Remembers which files and ranges have already been examined |
| Freshness/reconcile engine | revision resolvers, `reconcile*` helpers, `refreshRoundEnd` | Revalidates active/staged/archived state against current disk revisions |
| Auto-management and retention | compaction/drop heuristics, archive eviction, relief passes | Keeps working memory inside token and retention budgets |
| Telemetry and diagnostics | `MemoryEvent`, `MemoryTelemetrySummary`, read-spin tracking, verify artifacts | Explains what the memory system did and why |

#### 3.1 Engram registry

An engram is the primary unit of remembered content. In the store it is represented by `ContextChunk`, which tracks at least:

- content hash and short hash
- source path or derived source
- chunk type and view kind
- token count and compaction state
- freshness/revision metadata
- annotations and synaptic links
- last-accessed/created timestamps

The registry is broader than just active memory. `contextStore` also manages:

- active chunks currently in working memory
- archived chunks that remain recallable
- staged snippets prepared for prompt inclusion
- dropped manifest entries that preserve minimal recall metadata after full eviction

#### 3.2 Stage subsystem

Staging is a subsystem of memory, not just a UI convenience. `StagedSnippet` entries let the runtime keep precise slices, shapes, or snippets available without materializing entire files.

Stage management includes:

- short-hash lookup for staged items
- persistent anchor vs transient payload handling
- budget pruning and deduplication
- restoration checks against disk revisions
- promotion from stage into full chunks when richer memory is needed

#### 3.3 Blackboard subsystem

The blackboard is ATLS's durable reasoning layer. Whereas chunks and staged snippets are prompt-facing memory objects, BB entries are long-lived artifacts such as:

- findings per file/symbol
- task plans and progress summaries
- repair or fix records
- high-value status notes
- derived dependency knowledge tied back to sources

This is why investigations, reviews, and multi-step tasks can survive compaction and session transitions better than raw prompt context.

#### 3.4 Task and subtask subsystem

Task planning is embedded directly into the context runtime. `TaskDirective` and `SubTask` allow the runtime to track:

- the active subtask
- completed subtasks and summaries
- context manifests tied to a subtask
- automatic unload/archive behavior as work progresses

This is the mechanism that turns a single chat request into a managed workflow instead of an unstructured conversation.

#### 3.5 Freshness and reconciliation subsystem

A large part of `contextStore` exists to prevent stale memory from being mistaken for current truth. The reconcile pipeline:

- compares stored revisions with current revisions
- invalidates derived shapes when the source file changes
- marks content as suspect when safety cannot be guaranteed
- reconciles active chunks, archived chunks, and staged snippets separately
- refreshes round state at the end of a tool batch

This subsystem is what makes hash-addressed memory safe enough to reuse across edits and turns.

#### 3.6 Auto-management subsystem

ATLS does not assume context can grow forever. The store continuously manages pressure through:

- chunk compaction
- low-value chunk dropping
- archive eviction
- staged-snippet pruning
- protected-chat heuristics
- telemetry about freed tokens and retention decisions

This subsystem is essential to the project's cognitive-runtime model.

### 4. Hash Protocol Subsystem

Primary module: `atls-studio/src/services/hashProtocol.ts`

`hashProtocol` is the lifecycle tracker for hash references. If `contextStore` is the memory database, `hashProtocol` is the visibility and recency protocol that explains what each reference currently means.

#### Nested subsystems inside `hashProtocol`

| Nested subsystem | Key APIs/types | Responsibility |
|---|---|---|
| Visibility model | `ChunkVisibility`, `materialize`, `dematerialize`, `archive`, `evict` | Tracks whether content is fully visible, digest-only, archived, or gone |
| Turn accounting | `getTurn`, `advanceTurn`, `getTurnDelta` | Tracks recency and turn-based lifecycle changes |
| Ref indexes | short-hash index helpers, `getRef`, `getLatestRefs` | Resolves stable refs to the latest known object |
| Selector queries | `queryRefs`, `collectRefsWhere`, `getRefsBySource`, `getRefsByType` | Supports ref retrieval by scope rather than only by exact hash |
| Scoped views | `ScopedHppView`, `createScopedView` | Supports isolated or filtered visibility for subagents/tools |

#### Visibility states

| State | Meaning |
|---|---|
| `materialized` | Full content is visible to the model/runtime |
| `referenced` | Only digest/reference-level presence is kept in working memory |
| `archived` | Not in active working memory, but recallable |
| `evicted` | No working-memory content remains; only minimal recovery paths exist |

### 5. UHPP and Reference Semantics

ATLS exposes memory through hash-pointer syntax rather than through opaque internal IDs. In practice that means contributors will see references such as:

- `h:XXXX` for a content object
- `h:XXXX:15-30` for a line slice
- `h:XXXX:sig` for a shaped signature view
- `h:XXXX:fn(name)` for a symbol-oriented slice
- `h:OLD..h:NEW` for a change/diff relationship

The reference surface is implemented collaboratively:

- `contextHash.ts` formats ref strings and digest views
- `contextStore.ts` resolves refs back to chunks or staged snippets
- `hashProtocol.ts` tracks the lifecycle/freshness of those refs

## Prompt Construction and Token Budgeting

### 6. Digest and Ref Formatting Subsystem

Primary module: `atls-studio/src/utils/contextHash.ts`

`contextHash.ts` is the formatting and digest layer that converts large runtime objects into compact prompt-ready views.

#### Nested responsibilities

- deterministic 16-hex content hashing with 6-char display hashes
- chunk-tag and chunk-ref formatting/parsing
- symbol and code digest generation
- edit-ready digest generation
- search/symbol/dependency summary extraction
- line slicing with optional raw vs numbered output
- diff and shape-ref formatting

This module is why the rest of the runtime can speak in short, stable ref strings instead of repeating large bodies of content.

### 7. Prompt-Budget Policy Subsystem

Primary module: `atls-studio/src/services/promptMemory.ts`

`promptMemory.ts` defines how staged/context items are classified for prompt admission.

#### Nested responsibilities

- persistent-anchor detection
- stage admission classes (`persistentAnchor`, `transientAnchor`, `transientPayload`)
- persistence policies (`persist`, `doNotPersist`, `persistAsDemoted`)
- eviction reasons (`stale`, `duplicated`, `overBudget`, `demoted`, `manual`, `migration`)
- prompt-pressure bucket accounting
- layer-budget creation and total-prompt estimation

This subsystem gives the runtime policy language for deciding what survives into the next prompt.

### 8. Token Counting Subsystem

Primary module: `atls-studio/src/utils/tokenCounter.ts`

`tokenCounter.ts` is the expensive-counting counterpart to the cheaper heuristics in `contextHash.ts`.

#### Nested responsibilities

- async and batch token counting
- provider/model-sensitive caching via an LRU cache
- automatic cache invalidation when provider/model changes
- tool-definition token counting
- heuristic-vs-real drift recording and reporting
- synchronous fallback counting for hot paths

Together, `contextHash.ts`, `promptMemory.ts`, and `tokenCounter.ts` form the prompt subsystem-of-subsystems: formatting, policy, and measurement.

## Batch and Tool Execution Runtime

### 9. TOON Serialization and Batch Parsing Subsystem

Primary module: `atls-studio/src/utils/toon.ts`

TOON is the compact transport format used by the frontend/runtime for large structured values and batch results.

#### Nested responsibilities

- serializing arbitrary runtime values to TOON
- compacting repeated file-based entries by file grouping
- formatting results for display/token estimation
- converting relaxed JS-like objects to JSON
- tokenizing line-per-step batch syntax
- parsing parameter values and dataflow shorthands
- expanding `q` batch text into normalized step objects
- serializing message content for token estimation

This subsystem is the textual protocol bridge between human-friendly batch syntax and structured execution objects.

### 10. Intent Expansion Subsystem

Primary module: `atls-studio/src/services/batch/intents.ts`

The intent layer lets higher-level operations expand into concrete primitive tool steps.

#### Nested responsibilities

- intent registration and lookup
- building an execution context from pinned/staged/BB memory
- resolving intent ops into primitive steps
- estimating intent step counts
- pressure-aware behavior when memory is tight
- computing next likely target files from awareness, staging, and dependency BB data
- checking whether a file is already staged or pinned before requesting more reads

This is the part of the batch runtime that makes macros like understand, investigate, or edit-aware flows possible without hardcoding them in the UI.

### 11. Snapshot and Read-Coverage Subsystem

Primary module: `atls-studio/src/services/batch/snapshotTracker.ts`

`SnapshotTracker` is a guardrail subsystem for file-aware operations.

#### Nested responsibilities

- canonical snapshot hash normalization
- awareness-level tracking
- range merging and coverage checks
- read-kind tracking (`canonical`, `shaped`, `cached`, `lines`)
- determining whether an edit is inside previously read coverage

This subsystem protects the edit loop from mutating regions the agent has not actually examined.

### 12. Operation Families

ATLS groups tool operations into consistent families so the UI, docs, and batch runtime can reason about them uniformly.

| Family | Examples | Purpose |
|---|---|---|
| Discover | `search.code`, `search.symbol`, `search.issues` | Find targets |
| Understand | `read.context`, `read.shaped`, `read.lines`, `analyze.*` | Load or summarize code |
| Change | `change.edit`, `change.refactor`, `change.create` | Mutate files |
| Verify | `verify.build`, `verify.test`, `verify.lint`, `verify.typecheck` | Confirm validity |
| Session | `plan`, `advance`, `pin`, `stage`, `bb.write`, `recall` | Manage memory and workflow |
| Annotate | `engram`, `note`, `link`, `split`, `merge` | Enrich memory objects |
| Delegate | `retrieve`, `design`, `code`, `test` | Use specialized subagents |
| System | `exec`, `git`, `workspaces`, `help` | System-level integration |
| Intent | `understand`, `edit`, `diagnose`, `survey`, `extract` | High-level macros over primitive steps |

## History and Verification Telemetry

### 13. Round History Subsystem

Primary module: `atls-studio/src/stores/roundHistoryStore.ts`

Round history is the audit and replay layer for multi-turn execution.

#### Nested responsibilities

- `RoundSnapshot` persistence
- verification-confidence labeling (`fresh`, `cached`, `stale-suspect`, `obsolete`)
- main-chat round filtering
- cost statistics over prior rounds
- bounded snapshot retention

This subsystem matters because ATLS is not just a stateless chat UI; it tracks whether previous verification results are still trustworthy.

## Rust Analysis Core

### 14. Parser Subsystem

Primary module: `atls-rs/crates/atls-core/src/parser/mod.rs`

The parser subsystem exports the language/runtime pieces needed to parse and capture code structure:

- language loading and support checks
- parser creation
- registry management
- query compilation/execution helpers
- capture extraction utilities

### 15. Query Subsystem

Primary module: `atls-rs/crates/atls-core/src/query/mod.rs`

The query subsystem exposes the `QueryEngine` and `QueryError` types used to execute structured code queries against parsed sources.

### 16. Indexer Subsystem

Primary module: `atls-rs/crates/atls-core/src/indexer/mod.rs`

The indexer subsystem provides the typed outputs that higher layers rely on for static structure:

- `ParseResult`
- `ImportInfo`
- `CallInfo`

This is the analysis layer that turns raw parsing into import/call metadata.

### 17. Detector Subsystem

Primary module: `atls-rs/crates/atls-core/src/detector/mod.rs`

The detector subsystem exports:

- `PatternLoader`
- `DetectorRegistry`
- `FocusMatrix`
- `TreeSitterDetector`
- `DetectionRunner`

This layer is responsible for reusable pattern/detection logic over parsed codebases.

## Cross-Subsystem Flows

### Read and Understand Flow

1. The UI requests a read/search through the batch runtime.
2. Batch parsing and intent expansion normalize the request.
3. Snapshot tracking records what file/range has been examined.
4. `contextStore` materializes chunks or staged snippets.
5. `hashProtocol` updates reference visibility and recency.
6. `contextHash` formats compact refs/digests for prompt reuse.

### Edit and Verify Flow

1. A change request is expanded into concrete tool steps.
2. Snapshot coverage ensures the target region was actually read.
3. The mutation produces fresh hashes for changed content.
4. `contextStore` reconciles old and new derived state.
5. Verification artifacts and round history record whether the result is still trustworthy.

### Plan and Investigate Flow

1. A task plan enters the blackboard/task subsystem.
2. Findings are written as durable BB artifacts rather than only as chat text.
3. Memory pressure may compact or unload raw chunks while BB state remains.
4. Later rounds recover the reasoning path from BB plus hash refs.

## Where to Extend the System

| If you need to change... | Start here |
|---|---|
| Chat/session UI behavior | `src/stores/appStore.ts` and relevant React components |
| Memory lifecycle, BB behavior, staging, reconcile | `src/stores/contextStore.ts` |
| Ref visibility or turn-based lifecycle | `src/services/hashProtocol.ts` |
| Digest formatting or hash/ref presentation | `src/utils/contextHash.ts` |
| Prompt budgets and stage-admission policy | `src/services/promptMemory.ts` |
| Real token counting and token cache behavior | `src/utils/tokenCounter.ts` |
| Batch syntax or TOON transport | `src/utils/toon.ts` |
| Intent-to-step expansion | `src/services/batch/intents.ts` |
| Read coverage and snapshot safety | `src/services/batch/snapshotTracker.ts` |
| Verification history and trust labeling | `src/stores/roundHistoryStore.ts` |
| Core parsing/query/index/detection capabilities | `atls-rs/crates/atls-core/src/*` |

## Summary

ATLS is not a single orchestrator module; it is a layered cognitive runtime made from several cooperating subsystem trees:

- the **application shell** that manages user-visible sessions and agent state
- the **managed memory runtime** that owns engrams, staging, BB artifacts, and freshness
- the **prompt subsystem** that formats, budgets, and measures context
- the **batch runtime** that parses, expands, and safely executes tool steps
- the **history subsystem** that tracks verification trust over time
- the **Rust analysis core** that parses, indexes, queries, and detects structure in code

Understanding ATLS means understanding those subsystem boundaries and the contracts between them. This document should be the starting map for that work.
| **System** | exec, git, workspaces, help | xe, xg, xw, xh |
| **Intent** | understand, edit, edit_multi, investigate, diagnose, survey, refactor, create, test, search_replace, extract | iu, ie, im, iv, id, srv, ifr, ic, it, is, ix |

## Chat Modes

| Mode | Purpose |
|------|----------|
| `agent` | Full autonomous agent with tool access |
| `designer` | Architecture and design focus |
| `ask` | Q&A without tool execution |
| `reviewer` | Code review mode |
| `retriever` | Search and information gathering |
| `custom` | User-defined system prompt |
| `swarm` | Multi-agent coordination |
| `refactor` | Code refactoring focus |
| `planner` | Task planning and decomposition |

## Data Flow

1. **User input** → AI provider (streaming)
2. **AI response** → tool calls extracted
3. **Tool calls** → batch executor dispatches steps
4. **Each step** → hash resolution → positional rebase → Rust backend (Tauri IPC)
5. **Rust backend** → file I/O, edits, search, verification
6. **Results** → hash references created, context updated
7. **History compression** → large outputs deflated to `h:XXXX` refs
8. **Next turn** → rolling summary + active engrams + staged snippets → prompt assembly

## Memory Architecture

```
┌─────────────────────────────────────────┐
│          Static Prefix (cached)          │
│   System prompt + tool definitions       │
├─────────────────────────────────────────┤
│          History (append-only)           │
│   Deflated tool results (hash ptrs)      │
├─────────────────────────────────────────┤
│          Dynamic Block (uncached)        │
│   BB + dormant + staged + active +       │
│   workspace context + steering           │
├─────────────────────────────────────────┤
│          Chat Messages                   │
│   Protected window + compressed older    │
└─────────────────────────────────────────┘
```

**Budget Constraints:**
- Stage: ≤20k tokens with priority sorting
- Pin budget: ≤15 engrams recommended
- Auto-eviction at 90% memory pressure
- History compression reduces tool outputs to hash references
- Rolling summaries for older interactions
