# Prompt Assembly & Cache Strategy

ATLS constructs the LLM prompt in cache-aware layers, separating static content (cached cheaply) from dynamic cognitive state (rebuilt every round). This document describes how the prompt is built, what goes where, and how the caching strategy works.

## Prompt Structure

```
┌─────────────────────────────────────────────────────────────┐
│ CACHED: Static system block (5min TTL)           BP1+BP2   │
│   Mode prompt · Project line · Shell guide ·                │
│   Tool reference · Entry manifest · Context control ·       │
│   HPP spec · Provider reinforcement                         │
│                                     cache_control ──┤       │
├─────────────────────────────────────────────────────────────┤
│ CACHED: Prior conversation history (append-only)     BP3    │
│   Optional synthetic `[Rolling Summary]` assistant msg ·      │
│   All prior user / assistant / tool_result turns            │
│                            PRIOR_TURN_BOUNDARY ──┤          │
├─────────────────────────────────────────────────────────────┤
│ UNCACHED: Dynamic block (last user message)                 │
│   1. Staged snippets                                        │
│   2. Dynamic context (task, stats, BB, dormant, TOON)       │
│   3. Working memory (active engrams, metadata)              │
│   4. User content / tool results                            │
└─────────────────────────────────────────────────────────────┘
```

## Cache Breakpoints (Anthropic)

Anthropic allows up to 4 cache breakpoints. ATLS uses 2:

| Breakpoint | Placement | Content | Stability |
|-----------|-----------|---------|-----------|
| **BP1+BP2** | `cache_control` on last tool definition | System prompt + all tool schemas | Static per session (5min TTL) |
| **BP3** | `<<PRIOR_TURN_BOUNDARY>>` marker on last prior turn | All conversation history before the current (last) user message | Append-only **for the saved transcript** within a tool loop; see below |

### Synthetic rolling summary (not in chat UI)

When the context store holds distilled facts from the [rolling history window](./history-compression.md), [`aiService.ts`](../atls-studio/src/services/aiService.ts) **prepends** one synthetic assistant message (body starts with `[Rolling Summary]`) to the **in-memory** message list passed to the provider. That message is **not** stored as a normal chat row — the visible transcript remains append-only. BP3 hashes and cache behavior for the combined list are modeled by [`logicalCacheMetrics.ts`](../atls-studio/src/services/logicalCacheMetrics.ts) (append-only extension ⇒ logical hit; compression or edits ⇒ logical miss).

### Why Mutable Content Is Uncached

Blackboard entries, dormant engrams, staged snippets, and active working memory change every round. If they were placed before a breakpoint, every mutation would invalidate the cache, wasting the cache write cost. By isolating them in the uncached tail, the cached prefix remains stable.

### History Stability

History compression runs only at round 0 (between user turns). Within a multi-round tool loop, the **persisted** chat messages are strictly append-only — no insertions, no modifications to prior turns. The runtime may still **prepend** the synthetic `[Rolling Summary]` message when assembling the provider payload; logical BP3 hit/miss accounts for whether the effective history prefix grew only by appends. This keeps the intended cache-read behavior aligned with prefix stability rules.

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
3. **`buildDynamicContextBlock()`**: Assemble the mutable context
4. **`assembleProviderMessages()`**: Wire everything into the final message array

### Main agent tool-loop guards

The **main** chat tool loop in [`aiService.ts`](../atls-studio/src/services/aiService.ts) injects system-side nudges and stops that are separate from **delegate subagent** limits ([subagents.md](./subagents.md)). Numeric thresholds are defined in [`promptMemory.ts`](../atls-studio/src/services/promptMemory.ts):

| Mechanism | Role |
|-----------|------|
| **Research round budget** | Caps consecutive **read-only** tool rounds (`TOTAL_RESEARCH_ROUND_BUDGET` + `RESEARCH_FORCE_STOP_MARGIN` for warnings and hard stop). Agent progress can end with `research_budget` if the model does not call `task_complete` after a force-stop path. |
| **Verify gate** | In **agent** and **refactor** modes, if the model calls `task_complete` after making code changes without running any `verify.*` step, the loop blocks completion with a system message until verification runs (unless the force-stop margin is already active). |
| **Coverage plateau** | When coverage tracking shows no new files or symbols examined across multiple rounds, a system message nudges the model to summarize, act, or call `task_complete`. |
| **Read-only spin** | After several consecutive rounds without mutations (non-**ask** / non-**retriever** modes), a system message requires an edit, structured blackboard write, or explicit blocker. |
| **Phase budget** | With an active `session.plan` subtask, `PHASE_ROUND_BUDGET` limits how many rounds can stay in the same phase before nudging `session.advance` with a summary. |

### Dynamic Context Block

Built fresh every round by `buildDynamicContextBlock()`. Components that could steer behavior (blackboard lines, working-memory inclusion, staged snippets for intents, subagent pins, task lines) are filtered through **`canSteerExecution`** from [`universalFreshness.ts`](../atls-studio/src/services/universalFreshness.ts) so superseded, stale, or suspect artifacts do not present as the default next action. See [freshness.md](./freshness.md) (universal freshness).

| Component | Source | Volatility |
|-----------|--------|------------|
| Task line + context stats | `getTaskLine()`, `getStatsLine()` | Per-round |
| Edit-awareness steering | Recent edit BB keys | Per-round |
| Context pressure hint | Stale vs active ratio | Per-round |
| Pending action block | Agent state | Per-round |
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

**Source**: [`aiService.ts`](../atls-studio/src/services/aiService.ts) (prompt assembly, round loop, main agent guards), [`logicalCacheMetrics.ts`](../atls-studio/src/services/logicalCacheMetrics.ts) (logical BP3/static hit model), [`contextFormatter.ts`](../atls-studio/src/services/contextFormatter.ts) (working memory formatting), [`promptMemory.ts`](../atls-studio/src/services/promptMemory.ts) (stage budgets, research/phase budgets), [`chatMiddleware.ts`](../atls-studio/src/services/chatMiddleware.ts) (middleware pipeline), [`modePrompts.ts`](../atls-studio/src/prompts/modePrompts.ts) (mode-specific prompts)
