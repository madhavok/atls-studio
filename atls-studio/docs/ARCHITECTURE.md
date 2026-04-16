# ATLS Studio Architecture

## Overview

ATLS Studio is a Tauri desktop application that wraps the ATLS cognitive runtime in a React/TypeScript UI and a Rust analysis backend. The system is organized around managed working memory: reads, searches, edits, verification results, and chat/tool artifacts are all represented as hash-addressed references that can be pinned, staged, compacted, archived, recalled, and verified across turns.

This document describes every major subsystem and the nested responsibilities inside each one. It is the starting map for contributors who need to locate where a behavior lives and which layer should own a change.

## System Boundaries

| Boundary | Primary implementation | Responsibility |
|---|---|---|
| Desktop shell | Tauri | Native windowing, IPC, filesystem and process access |
| Frontend runtime | `atls-studio/src` | UI, orchestration, memory management, prompt assembly, tool loops, swarm coordination |
| Backend core | `atls-rs/crates/atls-core` | Parsing, queries, indexing, detector execution |
| AI provider edge | provider adapters configured in Studio settings | Model selection, streaming, token accounting, tool-call exchange |

## Core Architectural Principles

1. **Hash-addressed memory first** — content is tracked by stable `h:XXXX` references rather than by temporary UI state.
2. **Managed working memory** — active context is intentionally bounded; pinning, staging, compaction, archival, and recall are first-class operations.
3. **Turn-based freshness** — reads and edits are tracked against revisions and turns so the runtime can detect stale context.
4. **Batch-oriented execution** — the UI submits structured tool steps; the batch executor tracks read coverage, line-number rebasing, edit safety, and verification results.
5. **Durable reasoning artifacts** — blackboard entries, task plans, and verification artifacts survive far longer than the transient prompt window.
6. **Swarm-capable** — the orchestrator can decompose tasks into parallel sub-agents with isolated file claims, context distribution, and synthesis.

## Top-Level Layer Map

```text
┌──────────────────────────────────────────────────────────────────┐
│ React UI surface                                                 │
│ AiChat · CodeViewer · FileExplorer · AtlsPanel · Internals       │
├──────────────────────────────────────────────────────────────────┤
│ Application orchestration                                        │
│ appStore: sessions, settings, workspaces, agent state            │
├──────────────────────────────────────────────────────────────────┤
│ AI service and swarm layer                                       │
│ aiService (multi-provider) · orchestrator · swarmStore           │
├──────────────────────────────────────────────────────────────────┤
│ Managed memory runtime                                           │
│ contextStore · hashProtocol · hashManifest · freshnessTelemetry  │
│ historyCompressor · historyDistiller · roundHistoryStore         │
├──────────────────────────────────────────────────────────────────┤
│ Prompt and tool runtime                                          │
│ contextHash · promptMemory · tokenCounter · contextFormatter     │
│ batch executor · opMap · intents · snapshotTracker               │
├──────────────────────────────────────────────────────────────────┤
│ Rust analysis core                                               │
│ parser · query · indexer · detector                              │
└──────────────────────────────────────────────────────────────────┘
```

## Subsystem Map

| Subsystem | Primary files | Nested subsystems |
|---|---|---|
| UI and application shell | `src/components/*`, `src/stores/appStore.ts` | chat/session model, workspace model, agent control plane, prompt metrics view |
| AI service layer | `src/services/aiService.ts`, `src/services/geminiCache.ts`, `src/services/swarmChat.ts`, `src/services/modelFetcher.ts`, `src/services/uhppExpansion.ts`, `src/services/toolHelpers.ts` | provider adapters, Tauri proxy, Gemini rolling cache, HPP hydration, UHPP expansion, tool-call helpers |
| Swarm orchestrator | `src/services/orchestrator.ts`, `src/stores/swarmStore.ts` | task decomposition, file claims, agent coordination, research digest, synthesis |
| Managed memory runtime | `src/stores/contextStore.ts`, `src/services/hashProtocol.ts`, `src/services/hashManifest.ts`, `src/services/freshnessTelemetry.ts`, `src/services/historyCompressor.ts`, `src/services/historyDistiller.ts` | engram registry, staging, blackboard, task planning, freshness/reconcile, auto-management, hash forwarding, history deflation + tool_use stubbing, rolling summaries |
| Prompt construction | `src/utils/contextHash.ts`, `src/services/promptMemory.ts`, `src/utils/tokenCounter.ts`, `src/services/contextFormatter.ts` | digests and ref formatting, prompt-budget policy, provider-aware token counting, WM formatting |
| Batch and tool execution | `src/utils/toon.ts`, `src/services/batch/executor.ts`, `src/services/batch/opMap.ts`, `src/services/batch/intents.ts`, `src/services/batch/snapshotTracker.ts`, `src/services/batch/policy.ts`, `src/services/batch/paramNorm.ts`, `src/services/batch/resultFormatter.ts`, `src/services/batch/validateBatchSteps.ts` | TOON serialization, step dispatch, policy enforcement, intent expansion, read-range awareness, line rebasing |
| History and verification telemetry | `src/stores/roundHistoryStore.ts` | round snapshots, verification confidence, cost summaries |
| Rust analysis core | `atls-rs/crates/atls-core/src/*` | parser, query engine, indexer, detector pipeline |

---

## Frontend Runtime

### 1. Application Shell and Orchestration Subsystem

Primary module: `atls-studio/src/stores/appStore.ts`

`appStore` is the top-level UI orchestration store. It assembles the user-visible application state into a single runtime model consumed by all React components.

#### Nested subsystems inside `appStore`

| Nested subsystem | Key types | Responsibility |
|---|---|---|
| Chat/session model | `Message`, `MessagePart`, `MessageSegment`, `ChatSession` | Stores chat history, streamed assistant output, and tool-call presentation state |
| Tool-call UI model | `MessageToolCall`, `ToolCall`, `ToolCallStatus`, `StreamChunk`, `StreamPart` | Tracks streaming tool inputs/outputs and how they appear in the chat surface |
| Workspace/project model | `WorkspaceEntry`, `ProjectProfile`, `EntryManifestEntry`, `RootFileTree`, `FileNode`, `ScanStatus` | Represents open workspaces, project summaries, and explorer state |
| Agent control plane | `Agent`, `ChatMode`, `AgentProgress`, `AgentPendingActionState`, `ToolLoopSteering` | Tracks active agent mode, progress, pending actions, and steering metadata |
| Prompt/accounting view | `ContextUsage`, `PromptMetrics`, `CacheMetrics`, `LogicalCacheState`, `PromptSnapshot` | Exposes prompt-size and cache telemetry to the UI |
| User settings | `Settings`, `AIProvider`, `ModelInfo`, `FocusProfile` | Stores provider choices, model configuration, and focus metadata |

`generateTitle` uses the first few messages to produce a session title automatically. `ProjectHistoryEntry` tracks project open history with timestamps.

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

### 2. UI Component Subsystem

Primary entry points:
- `src/components/AiChat/index.tsx` — renders streamed chat and the full tool loop (4075 L)
- `src/components/CodeViewer/index.tsx` — file content and hash-addressed slice rendering
- `src/components/FileExplorer/index.tsx` — workspace structure and navigation
- `src/components/AtlsPanel/index.tsx` — working surface assembly and panel routing
- `src/components/AtlsInternals/index.tsx` — internal runtime state for inspection and debugging

Components are the rendering layer over stores and services. They do not define the memory model; they consume it. `AiChat` is the largest component and owns the streaming tool-loop state machine, tool-call rendering, and turn management UI.

---

## AI Service Layer

### 3. AI Service Subsystem

Primary module: `atls-studio/src/services/aiService.ts` and co-located modules

The AI service layer abstracts all model providers behind a unified streaming interface. All API calls are routed through the Tauri backend process via `invoke()` to bypass browser CORS restrictions — no provider API call is made from the renderer process directly.

#### Provider adapters

| Provider | Notes |
|---|---|
| Anthropic (Claude) | Primary provider; supports native tool_use, extended thinking, prompt caching |
| OpenAI (GPT-4, GPT-4o) | Function-call format; streamed via Tauri backend |
| Google AI (Gemini) | Rolling cache management; uncached-message-start tracking |
| Google Vertex AI | Vertex-hosted Gemini; same cache semantics as Google AI |
| LMStudio | Local model server; provider type `'lmstudio'`; no cloud CORS constraints |

`fetchModels` (from `modelFetcher.ts`) performs provider-aware model discovery and returns typed `AIProvider` model lists.

#### Gemini rolling cache subsystem

Gemini supports a server-side cache for the static prefix (system prompt + tools). The cache subsystem (`geminiCache.ts`) manages:
- `manageGeminiRollingCache` — creates or updates the Gemini cache entry when the static prefix changes
- `cleanupGeminiCache` — expires stale cache entries to avoid billing accumulation
- `resetHppHydrationCache` — clears the local HPP hydration cache when provider/model changes make prior cache IDs invalid
- `geminiUncachedMessagesStartIndex` — tracks the index past which messages are not covered by the current cache entry, so the API call can split cached vs uncached content correctly
- `getGeminiCacheSnapshot` / `restoreGeminiCacheSnapshot` — save and restore the cache state across session transitions

#### UHPP expansion layer

`uhppExpansion.ts` resolves UHPP set references and file-path refs inside batch parameters before they reach the executor:
- `expandFilePathRefs` (exported as `expandCanonicalFilePathRefs`) — resolves `h:XXXX:source`-style refs in file-path parameters to concrete paths
- `expandSetRefsInHashes` (exported as `expandCanonicalSetRefsInHashes`) — expands set selectors like `h:@dormant` or `h:@dematerialized` to their concrete hash arrays

#### Tool helpers

`toolHelpers.ts` provides utilities shared across tool handlers:
- `resolveSearchRefs` — resolves `in:stepId.refs` bindings
- `createHashLookup` — builds a fast lookup from hash to chunk content
- `atlsBatchQuery` — sends a nested batch query (used by orchestrator for sub-agent dispatch)
- `resolveToolParams` — normalizes raw step params after UHPP expansion
- `invokeWithTimeout` — wraps Tauri `invoke` with a configurable timeout
- `buildSharedExportRemovalWarning` — generates a warning when an edit removes a shared export
- `buildWorkspaceVerifyHint` — suggests the right workspace for verify steps
- `setProjectPathGetter` / `getProjectPath` — lazy workspace-root injection

#### Typo correction

The service validates native tool names (`batch`, `task_complete`) using a Levenshtein-distance check. If the model calls an unrecognized tool with a name within 4 edits of a valid one, it returns a suggestion rather than a silent failure.

#### Swarm streaming

`swarmChat.ts` exports `streamChatForSwarm` — a dedicated streaming entry point for orchestrated sub-agents. It accepts `SwarmStreamOptions` (including a separate system prompt, agent role, file context, and abort controller) and emits `SwarmStreamCallbacks` events for chunk, tool-call, done, and error. The orchestrator uses this rather than the main chat stream to keep sub-agent traffic isolated from the UI message model.

---

## Swarm Orchestrator

### 4. Swarm Orchestration Subsystem

Primary modules: `atls-studio/src/services/orchestrator.ts`, `atls-studio/src/stores/swarmStore.ts`

The orchestrator enables multi-agent task execution. It decomposes a high-level goal into a `TaskPlan`, assigns each `PlannedTask` to an agent with an `AgentRole`, manages concurrent execution up to `maxConcurrentAgents`, coordinates file claims to avoid edit conflicts, distributes context digests to each agent, and optionally runs a synthesis pass when all agents complete.

#### Configuration

`OrchestratorConfig` controls orchestration behavior:
- `model` / `provider` — which model runs the orchestrator and each agent
- `maxConcurrentAgents` — concurrency ceiling for parallel task execution
- `autoApprove` — whether to run agent edits without a confirmation step
- `enableSynthesis` — whether to run a final synthesis pass after all agent tasks complete

#### Task decomposition types

`TaskPlan`
- `tasks: PlannedTask[]` — ordered list of tasks to execute
- `summary: string` — plain-text plan summary
- `estimatedTokens: number` — pre-execution token estimate for the full plan
- `estimatedCost: number` — pre-execution cost estimate

`PlannedTask`
- `title` / `description` — what the task does
- `role: AgentRole` — which agent persona executes this task
- `files: string[]` — files the agent should operate on
- `contextNeeded: string[]` — symbols or topics the agent needs loaded
- `dependencies: string[]` — task titles this task depends on
- `priority: number` — scheduling order hint
- `editTargets?: EditTarget[]` — pre-identified edit locations

`EditTarget` — a specific symbol targeted for mutation:
- `file`, `symbol`, `kind` (`'function' | 'class' | 'method' | 'export' | 'interface' | 'type' | 'block'`)
- `lineRange?: [number, number]`
- `reason: string` — why this symbol is a target

#### Research digest types

Before agents execute, the orchestrator compiles per-file digests to give each agent focused context without materializing entire files:

`FileDigest`
- `path` + `smartHash` + optional `rawHash`
- `smartContent` / `rawContent` — shaped or full file content
- `signatures: string[]` — extracted symbol signatures
- `imports: string[]` / `importedBy: string[]` — dependency edges
- `editTargets: EditTarget[]` — pre-resolved edit locations

`ResearchResult` (from `swarmStore`) — accumulated findings from the research phase before agents begin editing.

#### Execution and coordination

`AgentExecution` tracks a running agent:
- `taskId` — correlates to `chatDb` task rows
- `abortController` — allows per-agent cancellation
- `promise` — the running agent loop

Two special task IDs are reserved for orchestrator-level LLM calls (not counted as worker tasks):
- `SWARM_ORCHESTRATION_PLAN_TASK_ID = '__swarm_orchestration_plan__'`
- `SWARM_ORCHESTRATION_SYNTHESIS_TASK_ID = '__swarm_orchestration_synthesis__'`

#### Supporting services

- `chatDb` — persists task status (`ChatTaskStatus`) and LLM usage stats per task row
- `rateLimiter` — throttles concurrent API requests across all agents to respect provider rate limits
- `EDIT_DISCIPLINE` prompt constant — injected into each agent's system prompt to enforce consistent edit behavior
- `toTOON` / `countTokensSync` — used to serialize and estimate context distributed to each agent

---

## Managed Memory Runtime

### 5. Context Store Subsystem

Primary module: `atls-studio/src/stores/contextStore.ts`

`contextStore` is the heart of ATLS working memory. It owns the live chunk graph, archived/dropped state, staging, blackboard artifacts, task plans, awareness data, and memory telemetry. It imports and coordinates all of the lower-level memory services.

#### Nested subsystems inside `contextStore`

| Nested subsystem | Key types/functions | Responsibility |
|---|---|---|
| Engram registry | `ContextChunk`, `findChunkByRef`, `findOrPromoteEngram` | Stores active memory objects and resolves hash references |
| Stage manager | `StagedSnippet`, `findStagedByRef`, stage priority helpers | Holds prepared snippets cheaper than full chunks but more concrete than BB notes |
| Blackboard | `BlackboardEntry`, `parseBbKey`, `inferBbFilePath` | Persists findings, plans, status, and other durable reasoning artifacts |
| Task planner | `TaskDirective`, `SubTask`, `TaskPlan`, `session.advance` state transitions | Tracks subtask progress and context manifests for multi-step work |
| Awareness and read coverage | `ReadSpan`, `AwarenessCacheEntry` | Remembers which files and ranges have already been examined |
| Freshness/reconcile engine | revision resolvers, `reconcile*` helpers, `refreshRoundEnd` | Revalidates active/staged/archived state against current disk revisions |
| Auto-management and retention | compaction/drop heuristics, archive eviction, relief passes | Keeps working memory inside token and retention budgets |
| Telemetry and diagnostics | `MemoryEvent`, `MemoryTelemetrySummary`, read-spin tracking, verify artifacts | Explains what the memory system did and why |

External services wired into `contextStore` at startup via lazy accessors (to avoid circular imports):
- `setCacheHitRateAccessor` — injects cache hit rate from `appStore`
- `setWorkspacesAccessor` — injects workspace list from `appStore`
- `setManifestMetricsAccessor(getManifestMetrics)` — wires hash manifest metrics

Path normalization uses `normalizePathForLink` (backslash→forward-slash, lowercase) and `pathMatchesLinkRef` for flexible basename/full-path matching in annotate.link operations.

#### 5.1 Engram registry

An engram is the primary unit of remembered content, represented by `ContextChunk`:
- content hash and 6-char short hash
- source path or derived source
- chunk type and view kind
- token count and compaction state
- freshness and revision metadata
- annotations and synaptic links
- last-accessed and created timestamps

The registry spans four tiers: **active** (in working memory), **archived** (recallable but not materialized), **staged** (prompt-ready snippets), and **dropped** (minimal manifest entry preserved after full eviction).

#### 5.2 Stage subsystem

Staging is a subsystem of memory, not just a UI convenience. `StagedSnippet` entries keep precise slices, shapes, or snippets available without materializing entire files. Stage management includes: short-hash lookup, persistent-anchor vs transient-payload handling (using `classifyStageSnippet` from `promptMemory`), budget pruning and deduplication, restoration checks against disk revisions, and promotion from stage into full chunks when richer memory is needed.

#### 5.3 Blackboard subsystem

The blackboard is ATLS's durable reasoning layer. BB entries outlive prompt compaction and session transitions. Typical BB content:
- findings per file/symbol (`bb:finding:{file}:{symbol}`)
- task plans and progress summaries
- repair and fix records
- high-value status notes
- derived dependency knowledge tied back to sources

`parseBbKey` canonicalizes key strings; `inferBbFilePath` extracts a source path from a structured key so the UI can link BB entries back to files.

#### 5.4 Task and subtask subsystem

`TaskDirective` and `SubTask` embed workflow management directly into the context runtime:
- tracks the active subtask and its context manifest
- records completed subtasks with summaries
- triggers automatic unload/archive as work progresses
- drives `session.advance` state transitions

This is the mechanism that turns a chat request into a managed workflow rather than an unstructured conversation.

#### 5.5 Freshness and reconciliation subsystem

The reconcile pipeline prevents stale memory from being mistaken for current truth:
- compares stored revisions with current on-disk revisions
- invalidates derived shapes when the source file changes
- marks content as suspect when freshness cannot be guaranteed
- reconciles active chunks, archived chunks, and staged snippets separately
- calls `manifestResolveForward` to follow hash-forwarding chains after edits
- calls `incSessionRestoreReconcileCount` (freshness telemetry) during session restore

#### 5.6 Auto-management subsystem

Active context cannot grow without bound. The store continuously manages pressure through:
- chunk compaction to pointer-only digests
- low-value chunk dropping
- archive eviction
- staged-snippet pruning via `PromptReliefAction` signals
- protected-chat heuristics (keeps the most recent conversation visible)
- telemetry about freed tokens and retention decisions

### 6. Hash Protocol Subsystem

Primary module: `atls-studio/src/services/hashProtocol.ts`

`hashProtocol` is the lifecycle tracker for hash references. If `contextStore` is the memory database, `hashProtocol` is the visibility and recency protocol that defines what each reference currently means.

#### ChunkRef fields

Every tracked reference is a `ChunkRef`:

| Field | Type | Meaning |
|---|---|---|
| `hash` | `string` | Full 16-hex content hash |
| `shortHash` | `string` | 6-char display hash (may diverge after collision resolution) |
| `type` | `ChunkType` | Content kind (file, search, symbol, etc.) |
| `source` | `string?` | File path or derived source |
| `totalLines` | `number` | Line count of the content |
| `tokens` | `number` | Token count |
| `editDigest` | `string` | Short fingerprint of edit history |
| `visibility` | `ChunkVisibility` | Current lifecycle state |
| `seenAtTurn` | `number` | Turn number when last materialized |
| `pinned` | `boolean?` | Whether the agent has pinned this ref |
| `pinnedShape` | `string?` | Shape active when pinned (e.g., `'sig'`) |
| `sourceRevision` | `string?` | File revision at read time (freshness anchor) |
| `parentHash` | `string?` | Hash this ref was derived from |
| `editSessionId` | `string?` | Edit session that produced this ref |
| `origin` | `'read'\|'edit'\|'stage'\|'derived'` | How the ref was created |
| `freshness` | `FreshnessState?` | Freshness classification |
| `freshnessCause` | `FreshnessCause?` | Why the ref has its freshness state |

`RefLine` is a compact single-line format emitted for referenced (non-materialized) chunks: `hash`, `shortHash`, `source`, `tokens`, `totalLines`, `editDigest`.

#### Visibility states

| State | Meaning |
|---|---|
| `materialized` | Full content is visible to the model/runtime |
| `referenced` | Only digest/reference-level presence is kept in working memory |
| `archived` | Not in active working memory, but recallable via `rec()` |
| `evicted` | No working-memory content remains; only minimal recovery paths exist |

#### Protocol state and ref indexes

- `refs: Map<string, ChunkRef>` — primary registry keyed by full 16-hex hash
- `shortHashIndex: Map<string, Set<ChunkRef>>` — 6-hex prefix → refs; multiple entries signals ambiguity
- `divergedRefs: Set<ChunkRef>` — refs whose `displayShortHash` differs from `hash.slice(0,6)`, enabling O(diverged) fallback scan during `getRef` prefix resolution
- `refsActiveCount` / `refsEvictedCount` — O(1) burden ratio tracking (invariant: `refsActiveCount + refsEvictedCount === refs.size`)
- `HPP_REFS_MAX_ENTRIES = 8000` — hard bound on `refs` map size in long sessions with heavy read/evict churn

#### Evicted min-heap

To prune the refs map efficiently without O(n log n) sorting, evicted entries are managed with a min-heap (`evictedMinHeap`) ordered by `(seenAtTurn, hash)`:
- `evict(hash)` pushes the entry to the heap
- `pruneEvictedRefsIfBurden()` checks the evicted/active burden ratio and calls `pruneEvictedOldestWhile` when the map exceeds `HPP_REFS_MAX_ENTRIES`
- `popValidEvictedOldest()` skips stale heap entries (already rematerialized or deleted) on pop
- This avoids O(n log n) sort-per-prune at the cost of lazy heap maintenance

#### Turn lifecycle

- `advanceTurn()` — increments `currentTurn`, dematerializes refs not seen this turn, emits turn-delta stats
- `getTurnDelta()` — returns `{ dematerialized, newMaterialized }` for the last turn transition
- `materialize(hash, ...)` — registers or updates a ref as fully visible; uses nullish coalescing for `source` so passing `undefined` preserves the existing source
- `dematerialize(hash)` — marks a ref as referenced (digest-only) without waiting for `advanceTurn`
- `archive(hash)` / `evict(hash)` — move a ref to the appropriate dormant state

#### Selector queries

- `queryRefs(selector: SetSelector)` — resolves set refs like `h:@dormant`, `h:@dematerialized`, `h:@active` to concrete ref arrays
- `collectRefsWhere(pred)` — general-purpose filtered collection
- `getRefsBySource(pattern)` — refs matching a file path pattern
- `getRefsByType(chunkType)` — refs of a specific chunk type
- `getLatestRefs(count)` — most recently materialized refs by `seenAtTurn`

#### Scoped views

`createScopedView()` returns a `ScopedHppView` with an isolated `advanceTurn` that only increments the local counter — no dematerialization or HPP side-effects. Used by sub-agents and test harnesses that need turn-local accounting without disturbing the main protocol state.

### 7. Hash Manifest Subsystem

Primary module: `atls-studio/src/services/hashManifest.ts`

When an edit produces a new file revision, all `h:XXXX` refs pointing to the old content become stale. The hash manifest tracks these supersession relationships so the runtime can follow forwarding chains without re-reading files:

- `recordForwarding(oldHash, newHash)` — registers that `oldHash` was superseded by `newHash` after an edit
- `recordEviction(hash)` — marks a hash as evicted in the manifest (no forwarding target)
- `resolveForward(hash)` — follows the forwarding chain to the latest known hash; returns the input if no forwarding exists
- `getManifestMetrics()` — returns health metrics (chain length distribution, stale entry count) consumed by freshness telemetry

`contextStore` calls `manifestRecordForwarding` after every successful edit and `manifestResolveForward` during reconciliation passes to rebase archived and staged refs to current hashes.

### 8. Freshness Telemetry Subsystem

Primary module: `atls-studio/src/services/freshnessTelemetry.ts`

Freshness telemetry is a lightweight instrumentation layer that tracks how often the runtime encounters stale or expired state:

- `freshnessTelemetry` — the shared telemetry object; accumulates counters and timing
- `incSessionRestoreReconcileCount()` — incremented each time a session restore triggers a reconcile pass (indicates how much state needed revalidation)
- `incCognitiveRulesExpired()` — incremented when a cognitive rule (`ru` entry) expires due to age or session boundary
- `setManifestMetricsAccessor(fn)` — lazy injection of the `getManifestMetrics` function from `hashManifest` to avoid circular imports

The telemetry data is surfaced in `AtlsInternals` and in the session diagnostics block.

### 9. History Distiller Subsystem

Primary module: `atls-studio/src/services/historyDistiller.ts`

The history distiller prevents the chat context window from filling with verbatim tool results from many turns ago. It maintains a `RollingSummary` that condenses older turns into a compact narrative:

- `RollingSummary` — the summary type: holds compressed content, covered turn range, and token count
- `emptyRollingSummary()` — factory for a zero-state summary used at session start

`contextStore` holds the current `RollingSummary` and passes it to the context formatter when assembling the prompt's history block. Turns that fall outside the protected chat window are distilled rather than materialized verbatim, which keeps the effective token cost of long sessions bounded.

---

## Prompt Construction and Token Budgeting

### 10. Digest and Ref Formatting Subsystem

Primary module: `atls-studio/src/utils/contextHash.ts`

`contextHash.ts` converts large runtime objects into compact prompt-ready views and provides the hashing primitives the entire system depends on.

#### Hashing

`hashContentSync(content)` produces a deterministic 16-hex (64-bit) hash using a synchronous algorithm. The first `SHORT_HASH_LEN` (6) characters are used as the display short hash; the full 16 chars are used as the Map key in `hashProtocol`.

`estimateTokens(content)` provides a fast synchronous heuristic calibrated against real BPE tokenizers (~10% correction factor). Use `tokenCounter.ts` for accurate per-provider counting.

#### Ref and tag formatting

- `formatChunkRef(hash, shortHash, type, source?, tokens?, shape?)` — formats the `<<h:XXXX tk:N type>>` tag rendered in prompt context
- `formatChunkTag(hash, shortHash, ...)` — variant used for inline chunk headers
- `parseChunkTag(tag)` — parses a formatted tag string back to its fields (hash, tokens, type, source, lines spec)
- `formatShapeRef(shortHash, shape, lines?)` — formats a shaped ref string like `h:abcdef:sig`
- `formatDiffRef(oldHash, newHash)` — formats `h:OLD..h:NEW` diff refs

#### Digest generation

- `generateDigest(content, type, symbols?)` — generates a compact digest for a chunk based on its type: symbol digests for code, key-lines digests for search results, exec digests for shell output
- `generateEditReadyDigest(content, symbols?)` — produces a more detailed digest that retains enough context for edit planning without the full file
- `formatSymbolDigestWithLines` / `formatSymbolDigest` — formats symbol lists with or without line numbers
- `extractCodeDigestWithLines` / `extractCodeDigest` — extracts the most structurally significant lines from a code block
- `extractSearchDigest` / `extractExecDigest` / `extractKeyLines` — type-specific digest extractors
- `abbreviateKind(kind)` — shortens symbol kind labels for compact display

#### Search and analysis summaries

- `flattenCodeSearchHits(result)` — flattens a nested code-search result into `CodeSearchHitRow[]` for uniform rendering and token estimation
- `extractSearchSummary(result, queries)` — one-line summary from a search result
- `extractSymbolSummary(result, symbolNames)` — one-line summary from a symbol lookup
- `extractDepsSummary(result, filePaths, depMode)` — one-line summary from a dependency analysis

#### Line slicing

`sliceContentByLines(content, linesSpec, raw?, contextLines?)` slices content by a `"start-end"` spec (1-indexed, inclusive). When `raw` is false (default) each line is prefixed with `NNNN|` for display in prompt context. `contextLines` adds surrounding lines to a targeted slice.

### 11. Prompt-Budget Policy Subsystem

Primary module: `atls-studio/src/services/promptMemory.ts`

`promptMemory.ts` defines the policy language for deciding what content survives into the next prompt. This is not a heuristic; it is a typed contract.

#### Budget constants

- `STAGED_ANCHOR_BUDGET_TOKENS` — token budget for persistent-anchor stage entries
- `STAGED_BUDGET_TOKENS` — total stage budget (~20k tokens)
- `STAGED_TOTAL_HARD_CAP_TOKENS` — absolute hard cap beyond which no new stage entries are admitted
- `MAX_PERSISTENT_STAGE_ENTRIES` — entry count limit for the persistent-anchor tier

#### Admission classes

`StageAdmissionClass` classifies each staged item:
- `'persistentAnchor'` — high-value, long-lived (BB entries, key plans, cognitive rules); guarded by `isPersistentAnchorKey(key)`
- `'transientAnchor'` — medium-value (active file slices, pinned sigs); survives moderate pressure
- `'transientPayload'` — low-value (search results, diagnostic outputs); first evicted under pressure

`classifyStageSnippet(key, ...)` determines the admission class for a given staged entry.

#### Persistence policies

`StagePersistencePolicy`:
- `'persist'` — always write back to session storage
- `'doNotPersist'` — ephemeral; dropped at session close
- `'persistAsDemoted'` — written back but at lower priority

#### Eviction reasons

`StageEvictionReason`: `'stale'`, `'duplicated'`, `'overBudget'`, `'demoted'`, `'manual'`, `'migration'`

#### Pressure accounting

- `PromptPressureBuckets` — bucketed breakdown of token pressure by content tier
- `PromptReliefAction` — describes a concrete action to relieve pressure (e.g., demote a specific key, drop a transient entry)
- `createPromptLayerBudgets(promptMetrics)` — returns per-layer budget allocations
- `sumPromptPressureBuckets(...)` — aggregates bucket values for total pressure calculation
- `getEstimatedTotalPromptTokens(...)` — estimates total prompt size from pressure buckets
- `getStaticSystemTokens(promptMetrics)` — tokens consumed by the static system-prompt prefix
- `getStagedTokens(_promptMetrics, stagedTokens)` — tokens consumed by all staged entries

### 12. Token Counting Subsystem

Primary module: `atls-studio/src/utils/tokenCounter.ts`

`tokenCounter.ts` is the accurate-counting counterpart to the cheap heuristics in `contextHash.ts`. The heuristic undercounts by ~10%; this module corrects that for budget-sensitive decisions.

#### LRU cache

An in-process `LRUCache` (capacity configurable) maps `contentHash → tokenCount` for the active provider/model. The cache is invalidated via `clearTokenCache()` when `ensureProviderSubscription()` detects a provider or model change in `appStore`.

#### Counting API

- `countTokens(content, precomputedHash?)` — async, provider-aware; hits the LRU cache first, then delegates to the active provider's tokenizer via `getActiveProviderModel()`
- `countTokensBatch(contents[], precomputedHashes?[])` — batches multiple strings in a single provider call; returns a parallel array of counts
- `countTokensSync(content, precomputedHash?)` — synchronous fallback using the heuristic; used on hot paths where async is not viable
- `countToolDefTokens()` — counts tokens consumed by the current tool-definition block; cached since tool defs rarely change

#### Drift tracking

`recordDrift(heuristic, real)` records the delta between the sync heuristic and the real provider count. `getDriftStats()` returns `{ samples, avgPct, maxPct, overThreshold }` — used in diagnostics to verify the heuristic remains calibrated.

### 13. Context Formatter Subsystem

Primary module: `atls-studio/src/services/contextFormatter.ts`

The context formatter assembles the dynamic block of the prompt from the runtime's current memory state. It is the bridge between the memory objects in `contextStore` and the textual prompt that reaches the model.

- `formatWorkingMemory(chunks, staged, bb, plan, telemetry, ...)` — renders the full working-memory block: active engrams, staged snippets, BB entries, task plan, and memory telemetry stats
- `formatTaggedContext(entries)` — wraps context entries in typed `<<h:XXXX type>>` tags for structured prompt rendering
- `formatStatsLine(stats)` — renders the `<<CTX N/200k (N%) | ...>>` stats line shown at the top of the dynamic block
- `formatTaskLine(task, subtask)` — renders the current task/subtask indicator line

---

## Batch and Tool Execution Runtime

### 14. TOON Serialization and Batch Parsing Subsystem

Primary module: `atls-studio/src/utils/toon.ts`

TOON (Token-Oriented Object Notation) is the compact transport format for large structured values and batch results.

#### Serialization

- `toTOON(value)` — serializes arbitrary runtime values to TOON; falls back to JSON for non-object types
- `detectFileKey(arr)` — heuristically identifies which key in an array of objects represents a file path, enabling file-based grouping
- `compactByFile(data)` — deduplicates repeated file-based entries by grouping them under their file key; only activates when `uniqueFiles < totalEntries` (guarantees actual savings)
- `formatResult(result, maxSize?)` — formats a tool result for display/token estimation, applying TOON compaction when beneficial
- `serializeForTokenEstimate(value)` — serializes to a string suitable for heuristic token estimation (cheaper than `formatResult`)

#### Batch parsing

- `jsObjectToJson(input)` — converts relaxed JS-like object literals (unquoted keys, trailing commas) to valid JSON; handles nested structures and quoted strings
- `skipQuotedString(line, pos)` — advances past a quoted string token (used by the tokenizer)
- `tokenizeBatchLine(line)` — splits a `q:` batch line into `[STEP_ID, OPERATION, ...param_tokens]`; handles quoted values with embedded spaces/colons
- `parseParamValue(raw)` — converts a raw token string to its typed value: boolean, number, array, object, or string
- `expandDataflow(val)` — recognizes `in:stepId.path` syntax and returns an expansion descriptor
- `expandBatchIfShorthand(val)` — handles `if:stepId.ok` and similar conditional shorthands
- `parseBatchLines(q)` — top-level parser: returns `{ version: '1.0', steps: Record<string, unknown>[] }` from a raw `q:` string
- `expandBatchQ(args)` — called by the executor to normalize a raw batch args object into the canonical `{ version, steps }` shape
- `serializeMessageContentForTokens(content)` — serializes Anthropic-style message content (array of text/tool-use/tool-result blocks) to a flat string for token estimation

### 15. Batch Executor Subsystem

Primary module: `atls-studio/src/services/batch/executor.ts`

The batch executor is the step loop. It accepts a `UnifiedBatchRequest`, dispatches each step through the `opMap`, resolves `in:stepId.path` bindings between steps, enforces execution policy, and returns a `UnifiedBatchResult`.

#### Core dispatch

`getHandler(opName)` from `opMap.ts` returns the registered handler function for an operation name. The `opMap` is the canonical registry mapping every operation family and short code to its implementation. Unknown ops return a `not_found` error rather than throwing.

#### Parameter normalization

`normalizeStepParams(params, context)` from `paramNorm.ts` resolves dataflow bindings (`in:stepId.*`), expands UHPP set refs, applies short-code aliases, and enforces required-field constraints. `coerceFilePathsArray(value)` normalizes any file-path input (single string, array, comma-separated) into a uniform `string[]`.

`FILE_PATH_REQUIRED_OPS` — a `Set<OperationKind>` of ops that must receive a non-empty `file_paths` array after coercion: `read.context`, `read.shaped`, `analyze.deps`, `analyze.impact`, `analyze.blast_radius`, `analyze.structure`.

#### Policy enforcement

`policy.ts` exports:
- `isStepAllowed(op, mode, config)` — returns false if the operation is disabled for the current chat mode (e.g., change ops are blocked in `ask` mode)
- `isStepCountExceeded(count, config)` — enforces per-batch step limits
- `isBlockedForSwarm(op, context)` — prevents sub-agents in swarm mode from calling orchestrator-level operations
- `evaluateCondition(condition, outputs)` — evaluates `if:stepId.ok` and similar conditional expressions against prior step results
- `getAutoVerifySteps(editedPaths, config)` — returns implicit verify steps to inject after edits when auto-verify is configured

#### Validation

`validateBatchSteps(steps)` from `validateBatchSteps.ts` performs pre-execution validation: checks that required parameters are present, that dataflow refs point to defined steps, and that `if:` conditions reference valid step IDs. Returns a list of validation issues rather than throwing, so partial batches can be explained to the model.

#### Result formatting

`stepOutputToResult(output, op, params)` from `resultFormatter.ts` converts a raw handler `StepOutput` into a `StepResult` suitable for prompt inclusion. This includes TOON compaction, hash ref injection, and volatile-content warnings.

#### Auto-workspace inference

`inferWorkspaceFromPaths(editedPaths: Set<string>): string | null` — after a batch contains edit steps, the executor collects edited file paths and calls this function to infer the workspace name by matching against the project's workspace registry. If all paths resolve to the same workspace, that name is injected into subsequent `verify.*` steps automatically, eliminating the need for the model to specify `workspace:` on every verify call.

#### Cross-step line-number rebasing

When multiple `change.edit` steps target the same file, each step's line insertions/deletions shift the line numbers of all subsequent steps. The executor maintains a per-file line-offset accumulator across the batch and rebases `le` entries in later steps automatically. This means all `le` coordinates in a batch step should use original (snapshot) line numbers — the executor handles the shift. `edits_resolved` in the step response reports the final resolved coordinates.

#### Session state management

`resetRecallBudget()` (from `session` handler) is called at the start of each batch to reset per-batch recall limits. `registerOwnWrite(hash)` (from `useAtls` hook) tracks hashes written by the current tool loop to avoid false read-spin warnings on content the agent just created.

### 16. Intent Expansion Subsystem

Primary module: `atls-studio/src/services/batch/intents.ts` and `intents/index.ts`

The intent layer expands higher-level operations into sequences of concrete primitive steps, injecting context-aware decisions the model would otherwise need to make explicitly.

#### Registration and lookup

`registerIntent(op, resolver)` maps an `IntentOp` string to an `IntentResolver` function. `getIntentResolver(op)` retrieves it. All resolvers are registered at import time via `intents/index.ts`.

#### Execution context

`buildIntentContext(store, params)` assembles the `IntentContext` from the current runtime state:
- `staged` — currently staged snippets (from `contextStore`)
- `pinnedSources` — file paths of pinned chunks
- `awareness` — per-file `AwarenessCacheEntry` records
- `bbKeys` — active BB keys with token costs (from `mergeChunkDerivedBbKeys`)
- `pressured` — whether memory is currently under pressure (from `isPressured`)

Helper predicates: `isFileStaged`, `isFilePinned`, `getFileAwareness`, `estimateFileLines`.

#### Intent resolvers

Each resolver is registered in `intents/index.ts` and lives in its own file:

| Resolver | Op | What it expands to |
|---|---|---|
| `resolveUnderstand` | `intent.understand` | `rs(sig)` + `pi` + optional `rl` slices for the target files/symbols |
| `resolveEdit` | `intent.edit` | `rl` target region + `ce` with stale-hash retry loop |
| `resolveEditMulti` | `intent.edit_multi` | Multi-file coordinated `rl` reads + `ce` steps with dependency ordering |
| `resolveInvestigate` | `intent.investigate` | Deep `rl` reads for a query + `bw` findings per function/symbol |
| `resolveDiagnose` | `intent.diagnose` | Error-focused investigation: `si` (issues) + targeted `rl` + `bw` diagnosis |
| `resolveSurvey` | `intent.survey` | Directory-level `rc(tree)` + `rs(sig)` for overview |
| `resolveRefactor` | `intent.refactor` | `ab` (blast radius) + `cf` extract/move/rename steps |
| `resolveCreate` | `intent.create` | `cc` scaffolding with ref-file context injection |
| `resolveTest` | `intent.test` | `rs(sig)` source + `cc`/`ce` test file + `vt` verification |
| `resolveSearchReplace` | `intent.search_replace` | `is` (literal search_replace) with match validation |
| `resolveExtract` | `intent.extract` | `ax` (extract plan) + `cm` or `cf` split steps |

#### Target computation

`computeNextTargets(context, params)` selects the most relevant files to read next given current awareness. It calls:
- `collectCandidates(context, params)` — gathers candidate files from params, BB sources, and awareness gaps
- `collectFromDepsGraph(context, bbKeys)` — extracts related files from dependency BB entries via the `derivedFrom` field
- `collectHubFiles(context)` — identifies high-connectivity files from the awareness graph (files with many dependents)

Results are sorted by relevance and deduplicated against already-pinned or already-staged files.

`estimateTotalSteps(op)` returns the expected primitive step count for a given intent op, used for progress estimation.

### 17. Snapshot and Read-Coverage Subsystem

Primary module: `atls-studio/src/services/batch/snapshotTracker.ts`

`SnapshotTracker` is a guardrail that prevents `change.edit` from targeting file regions the agent has not actually examined.

#### Types

- `ReadKind: 'canonical' | 'shaped' | 'cached' | 'lines'` — how a file was read
- `AwarenessLevel` enum — graduated levels of file knowledge (none → shaped → partial → full)
- `LineRegion: { startLine: number; endLine: number }` — a contiguous read range
- `SnapshotIdentity` — ties a hash to a file path, revision, and optional workspace; used for cross-path deduplication
- `RecordOpts` — options for `SnapshotTracker.record()`

#### Core functions

- `canonicalizeSnapshotHash(value)` — normalizes a snapshot hash (strips prefixes, lowercases) so the same file read via different paths resolves to the same identity
- `mergeRanges(ranges)` — merges overlapping or adjacent `LineRegion` entries into a minimal covering set; used to track total read coverage efficiently
- `regionsCover(regions, target)` — checks whether a set of read regions covers a target region; the core guard for `edit_outside_read_range` detection

The `SnapshotTracker` instance maintained by the executor accumulates read events as steps execute. Before any `change.edit` step, the executor checks `regionsCover` for the target line range. If the check fails, the step returns `edit_outside_read_range` with a suggestion to read the target region first.

### 18. Operation Families

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
| Intent | `understand`, `edit`, `edit_multi`, `investigate`, `diagnose`, `survey`, `refactor`, `create`, `test`, `search_replace`, `extract` | High-level macros over primitive steps |

---

## History and Verification Telemetry

### 19. Round History Subsystem

Primary module: `atls-studio/src/stores/roundHistoryStore.ts`

Round history is the audit and replay layer for multi-turn execution. ATLS is not a stateless chat UI; it tracks whether previous verification results are still trustworthy.

#### RoundSnapshot

`RoundSnapshot` (~112 fields) is a full snapshot of a completed round. Key fields include: prompt token counts, completion token counts, cache read/write counts, tool call count, verify results, active engram count, staged token count, memory pressure level, and timestamps. The large field count reflects the runtime's telemetry-first design — every significant metric is captured per round.

`VerificationConfidence: 'fresh' | 'cached' | 'stale-suspect' | 'obsolete'` — labels each snapshot's verify result with a trust level. A `fresh` result was produced this session; `obsolete` means the verified state has been superseded by edits.

#### Key functions

- `isMainChatRound(s: RoundSnapshot): boolean` — distinguishes main chat turns from internal tool sub-rounds (used to filter cost stats)
- `computeMainChatRoundCostStats(snapshots)` — aggregates token and cost totals across main-chat rounds only; returns `{ totalInputTokens, totalOutputTokens, totalCost, roundCount }`
- Bounded retention: the store keeps at most `MAX_SNAPSHOTS` entries; older snapshots are dropped when the limit is exceeded

---

## Rust Analysis Core

### 20. Parser Subsystem

Primary module: `atls-rs/crates/atls-core/src/parser/mod.rs`

The parser subsystem wraps tree-sitter for multi-language code parsing and exposes a uniform API to the query and indexer layers.

#### Sub-modules

`languages` — language loading and support:
- `load_language(lang)` — returns the tree-sitter `Language` for a supported language
- `is_supported(lang)` — checks whether a language has a registered grammar
- `create_parser(lang)` — constructs a configured `Parser` instance
- `LanguageError` — error variants for unsupported or failed language loads

`registry` — `ParserRegistry` caches parser instances to avoid repeated grammar initialization; `RegistryError` covers registration failures.

`query` — query compilation and execution:
- `compile_query(lang, source)` — compiles a tree-sitter query string for a language
- `execute_query(tree, source, query)` — runs a compiled query against a parsed tree
- `execute_query_string(lang, source_text, query_source)` — convenience wrapper combining compile + execute
- `QueryError` — covers parse errors, compilation errors, and execution failures
- `QueryResult` — the raw match output

`captures` — match extraction:
- `Capture` — a named capture: name, text, byte range, and point range
- `QueryMatch` — a set of captures from one pattern match
- `extract_matches_from_cursor(cursor, source)` — collects all matches from a running query cursor
- `capture_text(node, source)` — extracts the text for a specific node from the source bytes

### 21. Query Engine Subsystem

Primary module: `atls-rs/crates/atls-core/src/query/mod.rs`

`QueryEngine` (`pub struct QueryEngine`) is the stateful engine for executing structured code queries against a parsed codebase. The core `impl` block in `query/mod.rs` is small; the public query API is spread across `query/*.rs` submodules (`search.rs`, `symbols.rs`, `context.rs`, `files.rs`, `issues.rs`, `graph.rs`, `hybrid.rs`, `feedback.rs`, `grammar.rs`, `structured.rs`, `llm_query.rs`) and exposed to the frontend via Tauri IPC.

`QueryError` variants:
- malformed query input
- unsupported language
- execution failure (tree-sitter runtime error)
- result serialization error

### 22. Indexer Subsystem

Primary module: `atls-rs/crates/atls-core/src/indexer/mod.rs`

The indexer turns raw parsing into structured import/call metadata. Its typed outputs are the primary data source for dependency analysis and symbol navigation in the frontend.

`ParseResult` — file-level analysis output:
- aggregates all imports and calls found in a file
- carries the file path and parse success/failure status

`ImportInfo` — a single import statement:
- module path (the imported module string)
- named imports (individual exported symbols)
- default import (the default binding, if any)
- source location

`CallInfo` — a single call site:
- `callee` — the called symbol name
- `line` — 1-based source line

`IndexerError` — error variants covering file I/O failures, parse failures, and unsupported language errors.

### 23. Detector Subsystem

Primary module: `atls-rs/crates/atls-core/src/detector/mod.rs`

The detector subsystem provides reusable pattern-matching over parsed codebases using tree-sitter queries.

`PatternLoader` (`loader` sub-module) — loads pattern definitions from JSON catalog files (`core.json`, `all.json`, per-language `{lang}.json`) and validates them against registered languages.

`DetectorRegistry` (`registry` sub-module) — holds the active set of loaded patterns and exposes them keyed by language and pattern name. Also owns `FocusMatrix: HashMap<String, HashSet<String>>` — a map from workspace or file-glob patterns to the pattern names that should run against them, enabling per-project detection configuration.

`TreeSitterDetector` (`treesitter` sub-module) — executes a single tree-sitter query pattern against a parsed source tree; returns `QueryMatch[]` results.

`DetectionRunner` (`runner` sub-module) — orchestrates multi-file, multi-pattern detection passes: loads files, runs the appropriate patterns from the `FocusMatrix`, aggregates results, and returns structured `Issue` records consumed by `search.issues`.

`RegistryError` — covers missing patterns, language mismatches, and pattern compilation failures.

---

## Cross-Subsystem Flows

### Read and Understand Flow

1. The UI or agent submits a batch with a read/search step.
2. The executor normalizes params via `paramNorm`, resolves UHPP refs via `uhppExpansion`.
3. The `opMap` dispatches to the read or search handler.
4. `SnapshotTracker.record()` logs the file, range, and read kind.
5. The Rust backend processes the request via Tauri IPC.
6. `contextStore` materializes the result chunk; `hashProtocol.materialize()` registers the ref.
7. `contextHash` formats a compact `<<h:XXXX tk:N type>>` ref for the response.
8. `resultFormatter` wraps the result; the executor returns `StepResult` to the caller.

### Edit and Verify Flow

1. A `change.edit` step arrives; the executor checks `SnapshotTracker.regionsCover()` for the target range.
2. If outside read coverage, the step fails with `edit_outside_read_range`.
3. If covered, the executor dispatches to the change handler; the Rust backend writes the file.
4. `hashManifest.recordForwarding(oldHash, newHash)` registers the edit in the forwarding chain.
5. `contextStore` reconciles derived shapes; `hashProtocol` dematerializes the old ref.
6. If `auto-workspace inference` resolved a workspace, a `verify.*` step is appended.
7. The `RoundHistoryStore` captures the round snapshot with freshness labeled `'fresh'`.

### Swarm Orchestration Flow

1. The user activates swarm mode; `orchestrator` calls the planner LLM to produce a `TaskPlan`.
2. Each `PlannedTask` is assigned an `AgentRole`; the orchestrator compiles a `FileDigest` for each task's files.
3. Tasks are dispatched concurrently up to `maxConcurrentAgents`; each agent receives its digest via `streamChatForSwarm`.
4. File claims prevent two agents from editing the same file simultaneously.
5. The `rateLimiter` throttles concurrent API requests; `chatDb` records task status and token usage.
6. When all agents complete, if `enableSynthesis` is set, a synthesis LLM call consolidates results.
7. `swarmStore` accumulates `ResearchResult` entries; the UI surfaces per-agent progress.

### Plan and Investigate Flow

1. A task plan enters the blackboard/task subsystem via `session.plan`.
2. Findings are written as durable BB artifacts rather than only as chat text.
3. Memory pressure may compact or unload raw chunks while BB state remains intact.
4. `session.advance` transitions subtask state; context manifests are unloaded automatically.
5. Later rounds recover the reasoning path from BB plus hash refs via `hashManifest.resolveForward`.

---

## Chat Modes

| Mode | Purpose |
|------|----------|
| `agent` | Full autonomous agent with tool access |
| `designer` | Architecture and design focus; `annotate.design` available |
| `ask` | Q&A without tool execution; change ops blocked by policy |
| `reviewer` | Code review mode; focused on read and annotate ops |
| `retriever` | Search and information gathering for delegate.retrieve |
| `custom` | User-defined system prompt |
| `swarm` | Multi-agent coordination via orchestrator |
| `refactor` | Code refactoring focus |
| `planner` | Task planning and decomposition |

---

## Data Flow

1. **User input** → AI provider (streaming via Tauri IPC)
2. **AI response** → tool calls extracted from stream
3. **Tool calls** → `parseBatchLines` / `expandBatchQ` → normalized step array
4. **Validation** → `validateBatchSteps` checks params and dataflow refs
5. **Each step** → `paramNorm` (UHPP expansion + alias resolution) → `opMap` dispatch
6. **Policy check** → `isStepAllowed` / `isBlockedForSwarm` / `isStepCountExceeded`
7. **Read steps** → `SnapshotTracker.record` → Rust backend (Tauri IPC) → result materialized
8. **Edit steps** → `SnapshotTracker.regionsCover` guard → Rust backend → `hashManifest.recordForwarding`
9. **Results** → `stepOutputToResult` (TOON compaction + hash ref injection) → batch response
10. **Hash refs** → `hashProtocol.materialize` → `contextStore` chunk registration
11. **History compression** → large outputs deflated to `h:XXXX` refs by `resultFormatter`
12. **Round end** → `advanceTurn` dematerializes unreferenced refs → `refreshRoundEnd` reconcile
13. **Next turn** → `contextFormatter.formatWorkingMemory` + rolling summary → prompt assembly

---

## Memory Architecture

```
┌─────────────────────────────────────────┐
│          Static Prefix (cached)          │
│   System prompt + tool definitions       │
├─────────────────────────────────────────┤
│          History (append-only)           │
│   Deflated tool results (hash ptrs)      │
│   Rolling summary for oldest turns       │
├─────────────────────────────────────────┤
│          Dynamic Block (uncached)        │
│   BB + dormant + staged + active +       │
│   workspace context + steering           │
├─────────────────────────────────────────┤
│          Chat Messages                   │
│   Protected window + compressed older    │
└─────────────────────────────────────────┘
```

**Budget constraints:**
- Stage anchor tier: `STAGED_ANCHOR_BUDGET_TOKENS` (persistent anchors)
- Stage total: `STAGED_BUDGET_TOKENS` (~20k tokens) with `STAGED_TOTAL_HARD_CAP_TOKENS` absolute ceiling
- Persistent stage entries: ≤ `MAX_PERSISTENT_STAGE_ENTRIES`
- Pin budget: ≤15 engrams recommended
- HPP refs map: hard cap at `HPP_REFS_MAX_ENTRIES = 8000` entries
- Auto-eviction at 90% memory pressure
- History compression reduces tool outputs to hash references
- Rolling summaries (`historyDistiller`) for turns outside the protected chat window

---

## Where to Extend the System

| If you need to change... | Start here |
|---|---|
| Chat/session UI behavior | `src/stores/appStore.ts` and relevant React components |
| Memory lifecycle, BB behavior, staging, reconcile | `src/stores/contextStore.ts` |
| Ref visibility or turn-based lifecycle | `src/services/hashProtocol.ts` |
| Hash forwarding after edits | `src/services/hashManifest.ts` |
| Freshness and reconcile telemetry | `src/services/freshnessTelemetry.ts` |
| Rolling chat history compression | `src/services/historyDistiller.ts` |
| Digest formatting or hash/ref presentation | `src/utils/contextHash.ts` |
| Prompt WM block and context assembly | `src/services/contextFormatter.ts` |
| Prompt budgets and stage-admission policy | `src/services/promptMemory.ts` |
| Real token counting and token cache behavior | `src/utils/tokenCounter.ts` |
| Batch syntax or TOON transport | `src/utils/toon.ts` |
| Step dispatch and operation registration | `src/services/batch/opMap.ts` |
| Step loop, line rebasing, workspace inference | `src/services/batch/executor.ts` |
| Step validation and pre-execution checks | `src/services/batch/validateBatchSteps.ts` |
| Execution policy and mode restrictions | `src/services/batch/policy.ts` |
| Intent-to-step expansion | `src/services/batch/intents.ts` and `intents/*.ts` |
| Read coverage and snapshot safety | `src/services/batch/snapshotTracker.ts` |
| Verification history and trust labeling | `src/stores/roundHistoryStore.ts` |
| AI provider adapters or streaming | `src/services/aiService.ts`, `swarmChat.ts`, `modelFetcher.ts` |
| Gemini cache management | `src/services/geminiCache.ts` |
| UHPP set/file-path ref expansion | `src/services/uhppExpansion.ts` |
| Swarm task decomposition and agent coordination | `src/services/orchestrator.ts`, `src/stores/swarmStore.ts` |
| Core parsing/query/index/detection capabilities | `atls-rs/crates/atls-core/src/*` |

---

## Summary

ATLS is not a single orchestrator module; it is a layered cognitive runtime made from cooperating subsystem trees:

- the **application shell** that manages user-visible sessions and agent state
- the **AI service layer** that abstracts five provider adapters, manages Gemini caching, and routes all calls through the Tauri backend
- the **swarm orchestrator** that decomposes goals into parallel agent tasks with file claims, context digests, and synthesis
- the **managed memory runtime** that owns engrams, staging, BB artifacts, hash forwarding, freshness telemetry, and rolling history
- the **prompt subsystem** that formats, budgets, and measures context for every provider and model
- the **batch runtime** that parses, validates, normalizes, dispatches, and safely executes tool steps with line rebasing and workspace inference
- the **history subsystem** that tracks verification trust over time
- the **Rust analysis core** that parses, indexes, queries, and detects structure across multiple languages

Understanding ATLS means understanding those subsystem boundaries and the contracts between them. This document is the starting map for that work.
