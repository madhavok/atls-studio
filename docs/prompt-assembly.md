# Prompt Assembly: State vs Chat

ATLS constructs the LLM prompt by cleanly separating **chat** (the event log) from **session state** (current truth). State is assembled fresh each round and never persisted into the conversation transcript. This document describes how the prompt is built, what goes where, and how the caching strategy works.

## Core Principle

**Chat is a log. Everything else is state.**

- **Chat log**: user text, assistant text/reasoning, tool_use, tool_result. Append-only, compactable. "What happened."
- **Session state**: task/plan, blackboard, engram inventory, staged snippets, working memory, steering signals, workspace context. "What is true now." Assembled fresh, never in transcript.

## Prompt Structure

```
┌─────────────────────────────────────────────────────────────┐
│ CACHED: Static system block (5min TTL)         BP-static   │
│   Mode prompt · Project line · Shell guide ·                │
│   Tool reference · Entry manifest · Context control ·       │
│   HPP spec · Provider reinforcement                         │
│                                     cache_control ──┤       │
├─────────────────────────────────────────────────────────────┤
│ CACHED: Conversation history (append-only, clean)    BP3    │
│   [Rolling Summary] (if present; unshift-ed onto history)   │
│   All prior user / assistant / tool_result turns            │
│   (no state embedded — just what happened)                  │
│                            PRIOR_TURN_BOUNDARY ──┤          │
├─────────────────────────────────────────────────────────────┤
│ UNCACHED: Last user message (state injected here)           │
│   State block prepended via prependStateToContent:          │
│     1. Staged snippets                                      │
│     2. Dynamic context (task, stats, BB, steering, TOON)    │
│     3. Working memory (active engrams, metadata)            │
│   Followed by the real user text and/or tool results        │
└─────────────────────────────────────────────────────────────┘
```

## Cache Breakpoints (Anthropic)

Anthropic allows up to 4 cache breakpoints. ATLS uses 2:

| Breakpoint | Placement | Content | Stability |
|-----------|-----------|---------|-----------|
| **BP-static** | `cache_control` on last tool definition | System prompt + all tool schemas | Static per session (5min TTL) — a single breakpoint covering both the prompt and the tool block |
| **BP3** | `<<PRIOR_TURN_BOUNDARY>>` marker on last prior turn | All conversation history before the current (last) user message | Append-only within a tool loop |

The older "BP1+BP2" split referred to two notional cache layers over the static prefix; in practice Anthropic exposes a single breakpoint on the last tool and the system prompt + tools are cached together. The Rust streaming layer ([`src-tauri/src/ai_streaming.rs`](../atls-studio/src-tauri/src/ai_streaming.rs)) emits exactly that one breakpoint.

### State placement (non-durable)

Session state — task/plan, blackboard, staged snippets, working memory, steering signals, workspace context — is assembled fresh each round by `buildStateBlock()` and injected into the **last user message** of the assembled payload by `prependStateToContent` in [`aiService.ts`](../atls-studio/src/services/aiService.ts) ~1141-1202. This places state **after** the BP3 boundary in the uncached tail, so mutating state never invalidates the cached history prefix. For Gemini/Vertex, the state block flows through a separate `dynamicContext` parameter to the Rust streaming function instead of being embedded in message content.

The state block is **never stored** in `conversationHistory` — it's rebuilt fresh every round and never retained.

### Rolling summary

When the context store holds distilled facts from the [rolling history window](./history-compression.md), `aiService.ts` ~1758-1763 calls `conversationHistory.unshift(formatSummaryMessage(trimmed))` — the summary message lands at the **front of the history array** (inside BP3), not merged with the state block. Non-Gemini paths include it in the cached prefix; Gemini skips boundary markers entirely. BP3 hashes and cache behavior are modeled by [`logicalCacheMetrics.ts`](../atls-studio/src/services/logicalCacheMetrics.ts).

### `priorTurnBoundary` within the main chat path

The current main chat tool loop uses `priorTurnBoundary = 0` ([`aiService.ts`](../atls-studio/src/services/aiService.ts) ~1766). History compression middleware is free to rewrite any turn; in practice it runs only at round 0 (between user turns), and within a single tool loop the history array is append-only — so BP3 remains byte-stable mid-loop even with the permissive boundary.

### History reused from cache (middleware bypass)

When the assembled payload contains a `historyReusedFromCache` marker, `chatMiddleware.ts` ~104-106 skips round-0 compression entirely for that request. This preserves cache continuity when the runtime can prove the history hasn't changed since the last successful assembly.

### Clean history: why it matters for caching

Because state is never merged into `conversationHistory`, old turns contain only real content — no stale `<<TASK>>`, `<<PLAN>>`, or `<<SYSTEM:` strings. This makes the BP3 history prefix **more byte-stable** between rounds, improving cache hit rates. Within a multi-round tool loop, the saved transcript is strictly append-only — no insertions, no modifications to prior turns.

### Tool-loop steering signals

Steering signals (completion gates, spin nudges, pending actions, edit-awareness hints, etc.) are **conditional sections within the state preamble**, not fake user messages in chat history. When a condition is true, the signal appears in the state block for that round; when false, it is absent. Tool-loop counters are published via `toolLoopSteering` on `appStore` and read by `buildDynamicContextBlock()` (and by the spin detector).

### Logical cache metrics vs provider metrics

[`logicalCacheMetrics.ts`](../atls-studio/src/services/logicalCacheMetrics.ts) computes **expected** static (system+tools) and BP3 hits from our own rules (e.g. append-only BP3 prefix ⇒ hit). **`updateLogicalCache`** in the app store records these for the UI. They are **not** the same numbers as provider-reported cache read/write tokens — those still come from API usage metadata. See [api-economics.md](./api-economics.md).

## Batch tool reference and shorthands

The static system block includes **`BATCH_TOOL_REF`** ([`toolRef.ts`](../atls-studio/src/prompts/toolRef.ts)): operation families, examples, and a generated **shorthand legend** from `generateShorthandLegend()` in [`opShorthand.ts`](../atls-studio/src/services/batch/opShorthand.ts). Short codes reduce tokens in model-authored `batch` payloads; the runtime normalizes them to canonical `OperationKind` and parameter names before dispatch (see [batch-executor.md](./batch-executor.md#operation-and-parameter-shorthands)).

## Assembly Flow

### Per-Session (once)

`_buildStaticSystemPrompt()` assembles the static block, cached by key:

```
Cache key: ${mode}|${os}|${shell}|${cwd}|${atlsReady}|${provider}|${refactorConfig}|${entryManifestDepth}|${manifestFingerprint}
```

`manifestFingerprint` is derived from the serialized entry manifest (length of JSON) so changes to the manifest invalidate the cached static block, not only `entryManifestDepth`.

Contents (in order):
1. Mode prompt (agent, designer, reviewer, etc.)
2. Project line (working directory)
3. Shell guide (OS-aware shell instructions)
4. Tool reference (`BATCH_TOOL_REF` or mode-specific subset)
5. Entry manifest (optional project file listing; see **Entry manifest depth** below)
6. Mode-specific rules
7. Cognitive Core (`CONTEXT_CONTROL_V4`)
8. HPP spec
9. Provider reinforcement (Gemini-specific conciseness rules)

#### Entry manifest depth

Setting `entryManifestDepth` (app settings / model UI, stored in [`appStore.ts`](../atls-studio/src/stores/appStore.ts)) controls whether and how **Entry Points** are injected into the static system prompt when a workspace profile supplies `entryManifest` entries.

| Depth | Behavior |
|-------|----------|
| `off` | No entry manifest section |
| `paths` | `## Entry Points`: each entry as `path (method, linesL)` |
| `sigs` | `## Entry Points`: signature text lines only (entries with a non-empty `sig`) |
| `paths_sigs` | Both: path list first, then signature lines (same combined block as implemented in [`aiService.ts`](../atls-studio/src/services/aiService.ts) `_buildStaticSystemPrompt`) |

### Per-Round

Each round of the tool loop:

1. **`advanceTurn()`** (round > 0): Dematerialize prior engrams, compact dormant chunks; the hash-protocol hook also runs **`refreshRoundEnd`** here (not before round 0 — see [freshness.md](./freshness.md) round-end sweep).
2. **Middleware pipeline**:
   - History compression (round 0 only, threshold-based; includes [rolling window](./history-compression.md) / distillation)
   - Context hygiene (after 20+ rounds, aggressive compression)
   - Prompt budget (prune staged if over budget)
3. **Publish tool-loop steering**: `setToolLoopSteering()` writes current counters/conditions to `appStore`
4. **`buildDynamicContextBlock()`**: Assemble mutable context + conditional steering signals
5. **`buildStateBlock()`**: Combine dynamic context + staged snippets + working memory
6. **`assembleProviderMessages()`**: Place state preamble + clean history into the final message array

### Main agent tool-loop guards

The **main** chat tool loop in [`aiService.ts`](../atls-studio/src/services/aiService.ts) combines **telemetry** (counters on `toolLoopSteering` and round snapshots) with **conditional steering** in the state preamble — not fake user rows in chat history. Phase and soft-round constants live in [`promptMemory.ts`](../atls-studio/src/services/promptMemory.ts). **Research-round force-stop** (`TOTAL_RESEARCH_ROUND_BUDGET`, `RESEARCH_FORCE_STOP_MARGIN`, `FORCE STOP` preamble text, and `stoppedReason: research_budget`) has been **removed**; read-only rounds are still counted for snapshots and spin diagnosis.

| Mechanism | Role |
|-----------|------|
| **Read-only round counters** | Each read-only tool round increments `consecutiveReadOnlyRounds` and `totalResearchRounds`; a mutation resets the consecutive counter. Published on `toolLoopSteering` and round snapshots. **No** automatic session stop from these counts. |
| **Completion / verify steering** | When `completionBlocked` is set on `toolLoopSteering`, `buildDynamicContextBlock()` may inject verification or “continue implementation” `<<SYSTEM:…>>` lines (including stale-verify handling). |
| **Auto-verify after `task_complete`** | In **agent** and **refactor** modes, after `task_complete` with mutations and no verify yet, the loop may run `verify.build` before finishing — **not** gated on any removed force-stop margin. |
| **Spin early warning** | `diagnoseSpinning()` (round snapshots, coverage plateau flags, tool signatures, etc.) can trigger `<<SYSTEM: SPIN — …>>` lines in the preamble (e.g. **stuck in phase** cites `consecutiveReadOnlyRounds`). **Guidance only** — not a hard loop break. |
| **ASSESS (pinned-WM hygiene)** | [`evaluateAssess()`](../atls-studio/src/services/assessContext.ts) scores pinned FileViews + pinned non-FV artifacts by `tokens × (idleRounds + 2 × survivedEditsWhileIdle)` and emits a `<<ASSESS: …>>` block listing the top candidates with per-row options `release (pu)`, `compact (pc tier:sig)`, or `hold`. Fires at user-turn boundary (`round === 0`, if pinned tokens ≥ `boundaryMinTokens`) and mid-loop when CTX ≥ `midLoopCtxThreshold` or a new edit-forwarded pin appears. Single-fire per `bucket:sortedHashes` dedupe key; re-fires only on new candidates or CTX bucket climb. **Guidance only** — never halts. |
| **Pending action block** | `buildPendingActionBlock()` surfaces high-priority agent pending actions (blocked, confirmation, state changed) as a `## ACTION REQUIRED` / `## BLOCKED` section in the dynamic context. |
| **Edit-awareness** | Recent damaged edits, healthy edits, and escalated repairs produce `<<DAMAGED EDIT:…>>` / `<<RECENT EDITS:…>>` / `<<ESCALATED REPAIR:…>>` lines when BB state warrants it. |
| **Phase / soft-round budgets** | `PHASE_ROUND_BUDGET`, `TOTAL_ROUND_SOFT_BUDGET`, and `TOTAL_ROUND_ESCALATION` are evaluated in the tool loop (currently **logging**); they are **not** separate dedicated preamble lines in `buildDynamicContextBlock()` — rely on spin nudges and static cognitive guidance for consolidation pressure. |

#### ASSESS trigger model

Full treatment: [assess-context.md](./assess-context.md). Summary:

`evaluateAssess()` runs once per round in the main chat loop (skipped for `ask` / `retriever` modes) and publishes `toolLoopSteering.assessContext`. The consumer in `buildDynamicContextBlock()` emits the `<<ASSESS: …>>` block immediately after the spin circuit-breaker block, so corrective steering (spin) precedes hygiene steering (ASSESS) in the preamble. Two fire paths:

1. **User-turn boundary** (`round === 0`): surfaces any pinned content carried over from prior turns whose total tokens clear `boundaryMinTokens`. Gives the model a chance to clean house before starting a new user request.
2. **Mid-loop**: fires when `ctxPct ≥ midLoopCtxThreshold` (default `80`) **or** a new edit-forwarded pin is observed (a revision bump on a pinned view whose `lastAccessed` did not advance — "silent accumulator" from the Cognitive Core warning).

Dedupe is single-fire per `bucket:sortedCandidateHashes`. Re-fires only when the candidate set changes or CTX crosses from `mid` to `hi` (≥ 80%); descending back to `mid` with the same candidates stays quiet. Module-private sidecar state (`fvSidecar`) is session-scoped and tracks revision-changes-between-accesses to compute `survivedEditsWhileIdle`; dedupe state (`turnDedupe`) is keyed by `turnId` and resets on new user turns. Both are cleared by `resetAssessContext()` alongside `resetSpinCircuitBreaker()` on session reset. Forward-compat diagnostics (`assessFired`, `assessFiredKey`, `assessCandidateCount`) ride each `RoundSnapshot`; no read-back yet.

### State Block (dynamic context + staged + WM)

Built fresh every round by `buildStateBlock()`, which composes:

1. **`buildDynamicContextBlock()`** — orientation, steering, bulk context
2. **Staged snippets** — `getStagedBlock()` (pre-cached code context)
3. **Working memory** — `buildWorkingMemoryBlock()` (active engrams, metadata)

Components that could steer behavior are filtered through **`canSteerExecution`** from [`universalFreshness.ts`](../atls-studio/src/services/universalFreshness.ts) so superseded, stale, or suspect artifacts do not present as the default next action. See [freshness.md](./freshness.md) (universal freshness).

| Component | Source | Volatility |
|-----------|--------|------------|
| Task line + context stats | `getTaskLine()`, `getStatsLine()` | Per-round |
| Edit-awareness steering | Recent edit BB keys | Per-round |
| Context pressure hint | Stale vs active ratio | Per-round |
| Pending action block | Agent state | Per-round |
| Tool-loop steering signals | `toolLoopSteering` on `appStore` | Per-round (conditional) |
| ASSESS cleanup nudge | `toolLoopSteering.assessContext` (via `evaluateAssess`) | Per-round (conditional, single-fire per candidate set + CTX bucket) |
| Project structure tree | `projectTree` | First turn only |
| Workspace context (TOON) | Editor state, profile | Per-round |
| Selected text | IDE selection | Per-round |
| Blackboard | `_buildBlackboardBlock()` | Per-round (model writes) |
| Dormant engrams | `_buildDormantBlock()` | Per-round (compaction changes) |

### Working Memory Block

Built by `formatWorkingMemory()` via the context formatter:

1. Turn header (`<!-- WM:turn:N -->`) and delta stats
2. Safety rail warning (if compaction occurred)
3. Memory telemetry summary
4. Blackboard summary (pointer to full content in dynamic block)
5. Cognitive rules
6. Transition bridge (if subtask just advanced)
7. Staged snippet references
8. Chat context (recent turns with hash references)
9. **FILE VIEWS** — Unified file-content surface: one block per pinned FileView, sorted by `lastAccessed` desc. Each block is `=== path @h:<rev> (N lines) [pinned] === ... ===` containing skeleton rows, filled regions overlaid in file order, ephemeral `[edited L..-.. this round]` / persistent `[REMOVED was L..-..]` / `[changed: N regions pending refetch]` markers. Unpinned views are dormant — they render nothing and their constituent chunks re-surface in ACTIVE ENGRAMS under normal HPP rules.
10. **ACTIVE ENGRAMS** — Full content of materialized chunks **not covered by any pinned FileView** (search results, tool outputs, analysis, non-file artifacts, plus file-backed chunks whose view is unpinned or not yet promoted)
11. Dormant count (pointer to dormant block)
12. Archived engram list
13. Dropped manifest

### FileView / ACTIVE ENGRAMS cover set

[`contextFormatter.ts`](../atls-studio/src/services/contextFormatter.ts) ~345-367 builds two things from the `fileViews` map on every round:

- **`fileViewBlocks`** via `renderAllFileViewBlocks` — emitted into `## FILE VIEWS` above ACTIVE ENGRAMS so the model sees file-ordered views first. **Only pinned views render**; unpinned views are skipped entirely (see [engrams.md — FileView lifecycle](./engrams.md#fileview-lifecycle-pin-gated-rollout)).
- **`fileViewCoveredChunkHashes`** via `collectFileViewChunkHashes` — the set of chunk hashes owned by **pinned** views. Chunks whose hash is in this set are filtered out of ACTIVE ENGRAMS so the same bytes never appear twice. Unpinned views do **not** contribute to the cover set — their chunks remain visible in ACTIVE ENGRAMS under normal HPP dematerialization + TTL archive.

### Chunk Ordering in ACTIVE ENGRAMS

```typescript
// contextFormatter.ts ~362-374
sortedChunks = Array.from(chunks.values())
  .filter(c => c.type !== 'msg:user' && c.type !== 'msg:asst')
  .filter(c => !fileViewCoveredChunkHashes.has(c.hash))      // Pin-gated cover set
  .sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;      // Pinned first
    const aFile = FILE_TYPES.has(a.type);
    const bFile = FILE_TYPES.has(b.type);
    if (aFile !== bFile) return aFile ? -1 : 1;                // Files before artifacts
    return b.lastAccessed - a.lastAccessed;                     // Most recent first (LRU)
  });
```

Note this differs from `sortRefs` in [`hashProtocol.ts`](../atls-studio/src/services/hashProtocol.ts), which sorts by `seenAtTurn` for manifest/diagnostic purposes. Prompt ordering follows `lastAccessed`; see [`hash-protocol.md#sorting`](./hash-protocol.md).

## Stats Line

The context stats line gives the model real-time visibility into its resource usage:

```
<<CTX used:45k/200k chunks:12 pinned:3 bb:2.1k freed:8k history:6k cache:67% staged:3.2k>>
```

Threshold warnings appear at:
- **50%**: "approaching budget"
- **70%**: "consider drop/compact"
- **85%**: "CRITICAL — emergency eviction imminent"

## Modes

| Mode | Prompt | Tools | Edits |
|------|--------|-------|-------|
| **agent** | Full agent with task system | All operations | Yes |
| **designer** | Planning and research | Read-only + annotate + BB | No |
| **reviewer** | Code review | Read-only + BB | No |
| **ask** | Conversational Q&A | None | No |
| **retriever** | Subagent for research | Search, read, pin, stage | No |
| **refactor** | 4-phase refactor workflow | All operations + refactor config | Yes |

The **retriever** row is the chat **mode** preset. Separately, the batch tool can run **delegate subagents** in four roles — **retriever**, **design**, **coder**, and **tester** — via `delegate.retrieve`, `delegate.design`, `delegate.code`, and `delegate.test`. Those use a snapshot-based prompt and scoped hash-protocol view per round; see [subagents.md](./subagents.md).

Each mode uses a different combination of system prompt, tool reference, and context control block.

---

**Source**: [`aiService.ts`](../atls-studio/src/services/aiService.ts) (`buildStateBlock`, `buildDynamicContextBlock`, `assembleProviderMessages`, round loop, steering), [`appStore.ts`](../atls-studio/src/stores/appStore.ts) (`ToolLoopSteering`), [`logicalCacheMetrics.ts`](../atls-studio/src/services/logicalCacheMetrics.ts) (logical BP3/static hit model), [`contextFormatter.ts`](../atls-studio/src/services/contextFormatter.ts) (working memory formatting, FileView block + cover-set wiring), [`fileViewRender.ts`](../atls-studio/src/services/fileViewRender.ts) (pin-gated render + cover set), [`promptMemory.ts`](../atls-studio/src/services/promptMemory.ts) (stage budgets, research/phase budgets), [`chatMiddleware.ts`](../atls-studio/src/services/chatMiddleware.ts) (middleware pipeline), [`modePrompts.ts`](../atls-studio/src/prompts/modePrompts.ts) (mode-specific prompts)

## See also

- [input-compression.md](input-compression.md) — The ten-layer input compression stack, including cache-aware layout (Layer 6) and token budgets (Layer 7)
- [output-compression.md](output-compression.md) — The six axes of emission compression
- [history-compression.md](history-compression.md) — Hash-reference deflation and rolling summary compression
