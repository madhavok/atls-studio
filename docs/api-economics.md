# API Economics: The Caching Problem

ATLS Studio works. It produces correct multi-step agentic behavior with structured working-memory management and freshness guarantees on Claude Opus. The constraint is economic: the API pricing model penalizes exactly the runtime pattern that makes this workflow reliable.

## The Cost Structure

Anthropic API pricing (Claude Opus):

| Token Type | Cost per MTok | Relative |
|-----------|--------------|----------|
| Cached input (read) | $0.50 | 1x |
| Cached input (write) | $6.25 | 12.5x |
| Uncached input | $5.00 | 10x |
| Output | $25.00 | 50x |

In a typical 10-round ATLS tool loop:

| Region | Tokens/Round | Cost Rate | 10-Round Total |
|--------|-------------|-----------|---------------|
| System + tools (cached) | ~5k | $0.50/MTok | ~$0.025 |
| History (cached, append-only) | ~5-10k | $0.50/MTok | ~$0.05 |
| Dynamic block (uncached) | ~20-40k | $5.00/MTok | ~$1.00-2.00 |
| Output | ~2-4k | $25.00/MTok | ~$0.50-1.00 |
| **Total** | | | **~$1.58-3.08** |

The dynamic block — blackboard, staged snippets, working memory, dormant manifest, workspace context — accounts for **60-70% of input tokens** and is charged at **full uncached price** on every round.

## Why Caching Doesn't Help

Anthropic's prompt caching is prefix-based: everything before a `cache_control` breakpoint must be byte-identical between requests to get cache reads. ATLS's dynamic block changes every round by design:

| Content | Why It Changes |
|---------|---------------|
| Blackboard entries | Model writes `bb_write` mid-loop |
| Staged snippets | Active engram dedup flips pointer/content; derived entries evicted on edit |
| Dormant manifest | `compactDormantChunks` after each turn; new reads change the set |
| Active engrams (WM) | Every read/edit/search adds or modifies chunks |
| Workspace context | Stats, cache hit rate, and TOON rebuilt per round |

This content can't be placed before a breakpoint — any change would invalidate the cache for everything after it, including the history prefix that IS stable.

## The Fundamental Mismatch

```
Traditional chatbot:
  [static system ─── cached ───][growing history ── cached ──][small user msg]
  Cache hit rate: ~85%

ATLS runtime architecture:
  [static system ── cached ──][history ── cached ──][BB+staged+WM+dormant+ctx+user]
                                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                                     60-70% of tokens, full price
  Cache hit rate: ~30-40%
```

The more sophisticated the memory system, the less cacheable the prompt. A simple chatbot with a static system prompt gets 85% cache reads. An agent workflow with living working memory gets 30-40% because the interesting part — the cognitive state — is mutable.

## Logical vs provider-reported cache behavior

The UI and dev tooling expose **logical** cache expectations from [`logicalCacheMetrics.ts`](../atls-studio/src/services/logicalCacheMetrics.ts):

- **BP3 (history)**: Treats a **cache read** as likely when the conversation prefix before the last user message is unchanged except for **appending** new messages (same JSON-serialized prefix hash). A **miss** is expected after round-0 compression, in-place edits to earlier messages, or a shrinking prefix.
- **Static block**: Compared via the assembled static prompt cache key.

These are **heuristic expectations** aligned with Anthropic’s prefix rules; they help explain behavior and debug surprises. **Billing** still follows provider-reported `cache_read_input_tokens` / `cache_creation_input_tokens` from each API response. The synthetic `[Rolling Summary]` prepended to the provider message list is part of the assembled history for that model; see [prompt-assembly.md](./prompt-assembly.md) and [history-compression.md](./history-compression.md).

## The Staged Content Paradox

The Rust backend already supports a fourth breakpoint (`<<STAGED_CONTEXT_BOUNDARY>>`) for caching staged snippets. But the staged block is unstable because:

1. `getStagedBlock` checks which staged files have active engrams and substitutes content with `[content in active engram]` pointers. This dedup changes every round as active engrams shift.
2. `reconcileSourceRevision` deletes derived staged entries when source files are edited.
3. After edits, new reads add chunks, changing the active engram set and flipping the dedup decisions.

Removing the dedup to stabilize caching would actually increase costs for overlapping files (paying for content twice: once in staged, once in WM).

## What Would Fix This

Three API-level changes would make cognitive architectures economically viable:

### 1. Content-Addressable Caching

Cache individual content blocks by content hash, regardless of their position in the prompt. If engram `h:a1b2c3` (1000 tokens) appears in round N and round N+1 with identical content, charge 0.1x on round N+1 even though its neighbors changed.

ATLS already assigns stable content hashes to every block. The infrastructure for this exists on the client side — the API just doesn't support it.

### 2. More Granular Breakpoints

4 breakpoints for a system with 6+ regions of varying stability is insufficient. With per-region breakpoints, ATLS could cache:
- Stable staged content (files not being edited)
- Blackboard entries that haven't changed since last round
- Dormant manifest (changes infrequently within an edit-focused loop)

### 3. Diff-Based Pricing

Charge full price only for tokens that actually changed since the last request. If 80% of the dynamic block is identical between rounds (same engrams, same BB entries, same dormant manifest), charge 0.1x for those tokens regardless of position.

This aligns pricing with actual computational cost — the model doesn't re-process identical tokens differently based on their position.

## Current Mitigations

ATLS implements several strategies to minimize uncached costs within current API constraints:

- **Mutable content isolated in the dynamic block** — Never invalidates the cached prefix
- **History compression deferred to round 0** — Append-only within tool loops for BP3 stability
- **Staged content dedup** — Reduces staged block size when files overlap with active engrams
- **Token budgets per region** — WM ~32k, BB ~4k, staged ~4k, history ~12k
- **Model-directed working-set management** — The model is prompted to drop/compact proactively

These are mitigations, not solutions. The structural problem remains: living memory costs 10x what static memory costs, and living memory is what makes the architecture work.

---

**Source**: [`aiService.ts`](../atls-studio/src/services/aiService.ts) (cache breakpoints, prompt assembly), [`logicalCacheMetrics.ts`](../atls-studio/src/services/logicalCacheMetrics.ts) (logical hit model), [`ai_streaming.rs`](../atls-studio/src-tauri/src/ai_streaming.rs) (BP3/BP4 marker handling), [`appStore.ts`](../atls-studio/src/stores/appStore.ts) (cache metrics tracking)
