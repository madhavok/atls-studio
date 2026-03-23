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
| **BP3** | `<<PRIOR_TURN_BOUNDARY>>` marker on last prior turn | All conversation history before current message | Append-only within tool loop |

### Why Mutable Content Is Uncached

Blackboard entries, dormant engrams, staged snippets, and active working memory change every round. If they were placed before a breakpoint, every mutation would invalidate the cache, wasting the cache write cost. By isolating them in the uncached tail, the cached prefix remains stable.

### History Stability

History compression runs only at round 0 (between user turns). Within a multi-round tool loop, the message history is strictly append-only — no insertions, no modifications. This ensures Anthropic serves cache reads (0.1x cost) on the history prefix across all tool-loop rounds.

## Assembly Flow

### Per-Session (once)

`_buildStaticSystemPrompt()` assembles the static block, cached by key:

```
Cache key: ${mode}|${os}|${shell}|${cwd}|${atlsReady}|${provider}|${refactorConfig}|${entryManifestDepth}
```

Contents (in order):
1. Mode prompt (agent, designer, reviewer, etc.)
2. Project line (working directory)
3. Shell guide (OS-aware shell instructions)
4. Tool reference (`BATCH_TOOL_REF` or mode-specific subset)
5. Entry manifest (optional project file listing)
6. Mode-specific rules
7. Cognitive Core (`CONTEXT_CONTROL_V4`)
8. HPP spec
9. Provider reinforcement (Gemini-specific conciseness rules)

### Per-Round

Each round of the tool loop:

1. **`advanceTurn()`** (round > 0): Dematerialize prior engrams, compact dormant chunks; the hash-protocol hook also runs **`refreshRoundEnd`** here (not before round 0 — see [freshness.md](./freshness.md) round-end sweep).
2. **Middleware pipeline**:
   - History compression (round 0 only, threshold-based)
   - Context hygiene (after 20+ rounds, aggressive compression)
   - Prompt budget (prune staged if over budget)
3. **`buildDynamicContextBlock()`**: Assemble the mutable context
4. **`assembleProviderMessages()`**: Wire everything into the final message array

### Dynamic Context Block

Built fresh every round by `buildDynamicContextBlock()`:

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
- **90%**: "CRITICAL — emergency eviction imminent"

## Modes

| Mode | Prompt | Tools | Edits |
|------|--------|-------|-------|
| **agent** | Full agent with task system | All operations | Yes |
| **designer** | Planning and research | Read-only + annotate + BB | No |
| **reviewer** | Code review | Read-only + BB | No |
| **ask** | Conversational Q&A | None | No |
| **retriever** | Subagent for research | Search, read, pin, stage | No |
| **refactor** | 4-phase refactor workflow | All operations + refactor config | Yes |

Each mode uses a different combination of system prompt, tool reference, and context control block.

---

**Source**: [`aiService.ts`](../atls-studio/src/services/aiService.ts) (prompt assembly, round loop), [`contextFormatter.ts`](../atls-studio/src/services/contextFormatter.ts) (working memory formatting), [`promptMemory.ts`](../atls-studio/src/services/promptMemory.ts) (stage budgets), [`chatMiddleware.ts`](../atls-studio/src/services/chatMiddleware.ts) (middleware pipeline), [`modePrompts.ts`](../atls-studio/src/prompts/modePrompts.ts) (mode-specific prompts)
