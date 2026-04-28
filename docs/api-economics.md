# API Economics: The Caching Problem

ATLS Studio works. It produces correct multi-step agentic behavior with structured working-memory management and freshness guarantees on Claude Opus and Sonnet. The constraint is economic: the API pricing model penalizes exactly the runtime pattern that makes this workflow reliable.

## The Cost Structure

Anthropic API pricing uses prompt-cache rates that depend on the cache write TTL. ATLS currently uses Anthropic's default 5-minute `cache_control: {type: "ephemeral"}` breakpoints, so the worked examples below use the 5-minute write rate:

| Token Type | Relative to Input | Sonnet 4.6 ($/MTok) | Opus 4.6 ($/MTok) |
|-----------|-------------------|-------------------|------------------|
| Cached input (read / refresh) | 0.1x | $0.30 | $0.50 |
| Cached input (write, 5-minute TTL) | 1.25x | $3.75 | $6.25 |
| Cached input (write, 1-hour TTL) | 2x | $6.00 | $10.00 |
| Uncached input | 1x | $3.00 | $5.00 |
| Output | 5x | $15.00 | $25.00 |

In a typical 10-round ATLS tool loop (Sonnet 4.6):

| Region | Tokens/Round | Cost Rate | 10-Round Total |
|--------|-------------|-----------|---------------|
| System + tools (cached) | ~6k | $0.30/MTok | ~$0.02 |
| History prefix (cached) | ~12k avg | $0.30/MTok | ~$0.04 |
| History new turns (5-min cache write) | ~3k | $3.75/MTok | ~$0.11 |
| Dynamic block (uncached) | ~30-50k | $3.00/MTok | ~$0.90-1.50 |
| Output | ~2-4k | $15.00/MTok | ~$0.30-0.60 |
| **Total** | | | **~$1.37-2.27** |

For Opus 4.6, multiply by 5/3: **~$2.28-3.78** per 10-round loop.

The dynamic block — hash manifest, blackboard, staged snippets, working memory, workspace context, steering — accounts for **55-70% of input tokens** and is charged at **full uncached price** on every round.

**Batch payload shape:** The agent uses **operation and parameter shorthands** in `batch` steps (line-per-step `q` or JSON) so repeated tool calls use fewer tokens; the client normalizes to canonical names before execution. The system prompt pays a small one-time legend cost; net savings grow with multi-step batches. See [batch-executor.md](./batch-executor.md#operation-and-parameter-shorthands).

## Why Caching Doesn't Help

Anthropic's prompt caching is prefix-based: everything before a `cache_control` breakpoint must be byte-identical between requests to get cache reads. ATLS's dynamic block changes every round by design:

| Content | Why It Changes |
|---------|---------------|
| Hash manifest | Every read/edit/search adds or modifies chunk refs; freshness/visibility shifts each turn |
| Blackboard entries | Model writes `bb_write` mid-loop; entries pruned by state filter |
| Staged snippets | Active engram dedup flips between pointer/content; derived entries evicted on edit |
| Working memory (engrams) | Every read/edit/search materializes new chunks; pin/unpin/compact shifts the set |
| Workspace context | Stats, cache metrics, and TOON project profile rebuilt per round |
| Steering blocks | Cognitive nudges, spin warnings, telemetry — conditional on tool-loop state |

This content can't be placed before a breakpoint — any change would invalidate the cache for everything after it, including the history prefix that IS stable.

## The Fundamental Mismatch

```
Traditional chatbot:
  [static system ─── cached ───][growing history ── cached ──][small user msg]
  Cache hit rate: ~85%

ATLS runtime architecture:
  [system+tools ── cached ──][history ── cached ──][manifest+BB+staged+WM+workspace+steering+user]
   BP-static (~6k)            BP3 (~12-24k)         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                                     30-50k tokens, full uncached price
  Cache hit rate: ~30-40%
```

The more sophisticated the memory system, the less cacheable the prompt. A simple chatbot with a static system prompt gets 85% cache reads. An agent workflow with living working memory gets 30-40% because the interesting part — the cognitive state — is mutable.

## Cache Breakpoint Architecture

ATLS uses two active cache breakpoints and has infrastructure for a third:

**BP-static (system + tools):** The Rust backend adds `cache_control: {type: "ephemeral"}` to the last tool definition in the Anthropic tools array (`build_atls_tools_for_provider`). This creates a single cacheable prefix covering the system prompt and all tool definitions (~6k tokens). Since neither changes within a session, this achieves near-100% cache reads after round 1. ATLS uses the default five-minute ephemeral TTL here, so cache creation is priced at 1.25× input; Anthropic's optional one-hour TTL would raise creation cost to 2× and is not the active cost assumption in this document.

**BP3 (conversation history):** The TypeScript prompt assembler (`assembleProviderMessages`) injects a `<<PRIOR_TURN_BOUNDARY>>` marker on the last message before the current user turn. The Rust backend strips this marker and adds `cache_control` to that message block. History compression is deferred to round 0 (between user turns), so within a tool loop the message prefix is byte-identical across rounds — Anthropic serves cache reads at 0.1×. The boundary is placed carefully: if the last prior message contains `tool_use` blocks (which Anthropic doesn't allow `cache_control` on), the marker targets the message before it.

**BP4 (staged context — prepared, not active):** The Rust backend's `strip_boundary_markers` handles a `<<STAGED_CONTEXT_BOUNDARY>>` marker, but the TypeScript side does not currently inject it. The staged block is too unstable round-to-round: `getStagedBlock` checks which staged files have active engrams and substitutes content with `[content in active engram]` pointers, and `reconcileSourceRevision` deletes derived staged entries when source files are edited. Enabling BP4 would require stabilizing the staged block's ordering and dedup decisions across consecutive rounds.

**Gemini path:** Gemini and Vertex providers skip all boundary markers. The state block is passed as a separate `dynamicContext` parameter to the Rust streaming function rather than being injected into message content.

## Logical vs Provider-Reported Cache Behavior

The UI and dev tooling expose **logical** cache expectations from [`logicalCacheMetrics.ts`](../atls-studio/src/services/logicalCacheMetrics.ts):

- **BP3 (history)**: Treats a **cache read** as likely when the conversation prefix before the last user message is unchanged except for **appending** new messages (verified by comparing JSON-serialized prefix hashes, with sub-prefix hash comparison to detect append-only growth). A **miss** is expected after round-0 compression, in-place edits to earlier messages, or a shrinking prefix.
- **BP-static**: Compared via the assembled static prompt cache key.

These are **heuristic expectations** aligned with Anthropic's prefix rules; they help explain behavior and debug surprises. **Billing** follows provider-reported `cache_read_input_tokens` / `cache_creation_input_tokens` from each API response. See [prompt-assembly.md](./prompt-assembly.md) and [history-compression.md](./history-compression.md) for assembly and rolling-window eviction.

## What Would Fix This

Three API-level changes would make cognitive architectures economically viable:

### 1. Content-Addressable Caching

Cache individual content blocks by content hash, regardless of their position in the prompt. If engram `h:a1b2c3` (1000 tokens) appears in round N and round N+1 with identical content, charge 0.1× on round N+1 even though its neighbors changed.

ATLS already assigns stable content hashes to every block. The infrastructure for this exists on the client side — the API just doesn't support it.

### 2. More Granular Breakpoints

Two active breakpoints for a system with 6+ regions of varying stability is insufficient. With per-region breakpoints, ATLS could cache:
- Stable staged content (files not being edited)
- Blackboard entries that haven't changed since last round
- Hash manifest entries for unchanged engrams
- Workspace context (changes infrequently within an edit-focused loop)

### 3. Diff-Based Pricing

Charge full price only for tokens that actually changed since the last request. If 80% of the dynamic block is identical between rounds (same engrams, same BB entries, same manifest), charge 0.1× for those tokens regardless of position.

This aligns pricing with actual computational cost — the model doesn't re-process identical tokens differently based on their position.

## Current Mitigations

ATLS implements several strategies to minimize uncached costs within current API constraints:

| Strategy | Mechanism | Effect |
|---------|-----------|--------|
| **Static system prompt** | All mutable content isolated in the dynamic block — BP-static never invalidated | ~6k cached at 0.1× vs 1× |
| **Append-only history** | Compression deferred to round 0; within tool loops the prefix is byte-identical for BP3 reads | ~12-24k cached at 0.1× vs 1× |
| **Staged content dedup** | Active engrams replace staged file content with `[content in active engram]` pointers | Avoids double-counting overlapping content |
| **Batch shorthands** | Operation codes (`ce`, `rl`, `sc`) and parameter aliases (`ps`, `sn`, `qs`) reduce tool-call output tokens | Estimate: ~20-40% reduction per batch step (not measured against baseline) |
| **Token budgets per region** | WM 38k, BB 4.8k, staged 4.5k (hard cap 64k), history 24k, workspace 7k — see [`promptMemory.ts`](../atls-studio/src/services/promptMemory.ts) | Caps worst-case dynamic block |
| **Rolling-window eviction** | Oldest tool-loop rounds beyond `ROLLING_WINDOW_ROUNDS` (20) are spliced out; durable state lives in BB / hash manifest / FileViews / `ru` rules rather than a synthesized summary | Bounds history growth across long sessions without perturbing the cache prefix |
| **Assistant-side tool_use stubbing** | `stubBatchToolUseInputs` replaces past batch tool_use inputs > 80 tokens with a compact `_stubbed` summary | Shrinks the assistant transcript the next round re-reads; see [history-compression.md](./history-compression.md) |
| **Model-directed WM management** | Prompted to drop/compact/unpin proactively; runtime steering nudges on spin detection | Keeps dynamic block within budget |
| **Reasoning recap** (infrastructure only, not wired) | `_extractRecentReasoning` / `REASONING_RECAP_MAX_CHARS=1500` in [`aiService.ts`](../atls-studio/src/services/aiService.ts) | Would inject trailing ~1500 chars of assistant reasoning after history compression. Currently has no call sites; listed for completeness. |

These are mitigations, not solutions. The structural problem remains: living memory costs 10× what static memory costs, and living memory is what makes the architecture work.

## Output-side compression

The table above addresses **input** pricing. Output tokens on Claude pricing are **5×** input, and the batch surface, UHPP reference system, and history pipeline are fundamentally an output-token compressor — the model emits shorthand op codes, recency refs, set selectors, content-as-ref substitutions, and macro intents rather than verbatim JSON tool calls with narration and repeated content.

A full inventory across six axes (lexical, semantic, temporal, spatial, computational, transcript) lives in the dedicated [output-compression.md](./output-compression.md) doc. Key examples:

- **Line-per-step `q` form** with op/param shorthands: ~70-80% fewer emitted tokens per tool call vs equivalent JSON.
- **Intent macros** (`intent.edit`, `intent.investigate`): model emits one line; client expands to 3-5 primitives.
- **Content-as-ref** (`"content": "h:XXXX:fn(name):dedent"`): model references code via UHPP instead of copying it verbatim in `change.create` / `change.refactor`.
- **Cross-step line rebase**: model writes multi-step edits in pre-batch coordinates; executor computes deltas. No "wait, L50 is now L53" reasoning text ever gets serialized.
- **Auto-inject + auto-infer**: `verify.build`, workspace names, pin migrations, impact staging are all injected by the executor, not emitted by the model.

The design principle: **every token the model emits should express intent the runtime cannot infer.** Names, paths, coordinates, narration, and repetitions are the runtime's job.

---

**Source**: [`aiService.ts`](../atls-studio/src/services/aiService.ts) (cache breakpoints, prompt assembly, boundary markers, state block construction), [`promptMemory.ts`](../atls-studio/src/services/promptMemory.ts) (token budgets per region), [`logicalCacheMetrics.ts`](../atls-studio/src/services/logicalCacheMetrics.ts) (logical cache hit model), [`ai_streaming.rs`](../atls-studio/src-tauri/src/ai_streaming.rs) (BP-static tool caching, boundary marker stripping, provider-specific message conversion), [`appStore.ts`](../atls-studio/src/stores/appStore.ts) (cache metrics tracking)
