# Prompt Assembly: State vs Chat

ATLS constructs the LLM prompt by cleanly separating **chat** (the event log) from **session state** (current truth). State is assembled fresh each round and never persisted into the conversation transcript. This document describes how the prompt is built, what goes where, and how the caching strategy works.

## Core Principle

**Chat is a log. Everything else is state.**

- **Chat log**: user text, assistant text/reasoning, tool_use, tool_result. Append-only, compactable. "What happened."
- **Session state**: task/plan, blackboard, engram inventory, staged snippets, working memory, steering signals, workspace context. "What is true now." Assembled fresh, never in transcript.

## Prompt Structure

```
┌─────────────────────────────────────────────────────────────┐
│ CACHED: Static system block (5min TTL)           BP1+BP2   │
│   Mode prompt · Project line · Shell guide ·                │
│   Tool reference · Entry manifest · Context control ·       │
│   HPP spec · Provider reinforcement                         │
│                                     cache_control ──┤       │
├─────────────────────────────────────────────────────────────┤
│ STATE PREAMBLE (non-durable, rebuilt every round)           │
│   1. Rolling summary (distilled chat facts)                 │
│   2. Staged snippets                                        │
│   3. Dynamic context (task, stats, BB, steering, TOON)      │
│   4. Working memory (active engrams, metadata)              │
├─────────────────────────────────────────────────────────────┤
│ CACHED: Conversation history (append-only, clean)    BP3    │
│   All prior user / assistant / tool_result turns            │
│   (no state embedded — just what happened)                  │
│                            PRIOR_TURN_BOUNDARY ──┤          │
├─────────────────────────────────────────────────────────────┤
│ UNCACHED: Last user message (clean)                         │
│   User text and/or tool results — no state injected         │
└─────────────────────────────────────────────────────────────┘
```

## Cache Breakpoints (Anthropic)

Anthropic allows up to 4 cache breakpoints. ATLS uses 2:

| Breakpoint | Placement | Content | Stability |
|-----------|-----------|---------|-----------|
| **BP1+BP2** | `cache_control` on last tool definition | System prompt + all tool schemas | Static per session (5min TTL) |
| **BP3** | `<<PRIOR_TURN_BOUNDARY>>` marker on last prior turn | All conversation history before the current (last) user message | Append-only within a tool loop |

### State preamble (non-durable)

Session state — task/plan, blackboard, staged snippets, working memory, steering signals, workspace context — is assembled fresh each round by `buildStateBlock()` and placed in a **non-durable** position in the API payload. For non-Gemini providers, it is merged into a synthetic first user message (the "state preamble") that also includes the rolling summary. For Gemini, it goes via the `dynamicContext` parameter to the Rust backend. The state preamble is **never stored** in `conversationHistory`.

### Rolling summary

When the context store holds distilled facts from the [rolling history window](./history-compression.md), the rolling summary is included as part of the state preamble (merged into the first user message). It is **not** stored as a normal chat row. BP3 hashes and cache behavior are modeled by [`logicalCacheMetrics.ts`](../atls-studio/src/services/logicalCacheMetrics.ts).

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
| **Pending action block** | `buildPendingActionBlock()` surfaces high-priority agent pending actions (blocked, confirmation, state changed) as a `## ACTION REQUIRED` / `## BLOCKED` section in the dynamic context. |
| **Edit-awareness** | Recent damaged edits, healthy edits, and escalated repairs produce `<<DAMAGED EDIT:…>>` / `<<RECENT EDITS:…>>` / `<<ESCALATED REPAIR:…>>` lines when BB state warrants it. |
| **Phase / soft-round budgets** | `PHASE_ROUND_BUDGET`, `TOTAL_ROUND_SOFT_BUDGET`, and `TOTAL_ROUND_ESCALATION` are evaluated in the tool loop (currently **logging**); they are **not** separate dedicated preamble lines in `buildDynamicContextBlock()` — rely on spin nudges and static cognitive guidance for consolidation pressure. |

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
9. **ACTIVE ENGRAMS** — Full content of materialized chunks
10. Dormant count (pointer to dormant block)
11. Archived engram list
12. Dropped manifest

### Chunk Ordering in ACTIVE ENGRAMS

```typescript
sortedChunks.sort((a, b) => {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;      // Pinned first
  const aFile = FILE_TYPES.has(a.type);
  const bFile = FILE_TYPES.has(b.type);
  if (aFile !== bFile) return aFile ? -1 : 1;                // Files before artifacts
  return b.lastAccessed - a.lastAccessed;                     // Most recent first
});
```

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

**Source**: [`aiService.ts`](../atls-studio/src/services/aiService.ts) (`buildStateBlock`, `buildDynamicContextBlock`, `assembleProviderMessages`, round loop, steering), [`appStore.ts`](../atls-studio/src/stores/appStore.ts) (`ToolLoopSteering`), [`logicalCacheMetrics.ts`](../atls-studio/src/services/logicalCacheMetrics.ts) (logical BP3/static hit model), [`contextFormatter.ts`](../atls-studio/src/services/contextFormatter.ts) (working memory formatting), [`promptMemory.ts`](../atls-studio/src/services/promptMemory.ts) (stage budgets, research/phase budgets), [`chatMiddleware.ts`](../atls-studio/src/services/chatMiddleware.ts) (middleware pipeline), [`modePrompts.ts`](../atls-studio/src/prompts/modePrompts.ts) (mode-specific prompts)
