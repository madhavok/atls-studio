# History Compression

As conversations grow through multi-round tool loops, tool results and long messages accumulate in the message history. Without compression, the history can consume the entire context budget. ATLS compresses history by replacing content with hash references, keeping the knowledge accessible without the token cost.

## How It Works

### Hash-Reference Deflation

Large tool results in conversation history are replaced with compact hash pointers:

```
Before (inline in history):
  [2000-token search result with full code snippets]

After (compressed):
  [h:a1b2c3 2000tk search results for "auth"]
  fn authenticate:15-32 | cls AuthService:34-89
```

The original content remains in working memory (as an engram) or archive. The model can recall it by hash reference at any time. The history entry now costs ~20 tokens instead of ~2000.

The wire format is **`[h:SHORT TOKENStk DESCRIPTION]`** — no arrow, no comma. The `->` and `,` were dropped because BPE tokenizers (Claude, OpenAI) encode them as punctuation-heavy sequences; spaces between fields tokenize more efficiently. See `formatChunkRef` in [`contextHash.ts`](../atls-studio/src/utils/contextHash.ts) ~155-177.

| Content Type | Threshold | Source |
|-------------|-----------|--------|
| Tool results (general) | **100 tokens** (`COMPRESSION_THRESHOLD_TOKENS`) | [`historyCompressor.ts`](../atls-studio/src/services/historyCompressor.ts) ~44 |
| `system.*` / `verify.*` results | **200 tokens** (`HIGHER_THRESHOLD` via `TOOL_COMPRESSION_OVERRIDES`) | [`historyCompressor.ts`](../atls-studio/src/services/historyCompressor.ts) ~50-57 |
| Tool text replacement in history | **100 tokens** (`HISTORY_TEXT_REPLACEMENT_THRESHOLD_TOKENS`) | same file ~59 |
| Batch `tool_use` input (assistant side) | **80 tokens** (`BATCH_INPUT_STUB_THRESHOLD`) | [`historyCompressor.ts`](../atls-studio/src/services/historyCompressor.ts) `stubBatchToolUseInputs` |
| Match-aware dynamic floor | **`floor(base * 0.6)`** when a matching engram already exists | [`historyCompressor.ts`](../atls-studio/src/services/historyCompressor.ts) ~470-479 |

The low base threshold is deliberate: the model gets **one round** to see a full result inline, then it deflates. This keeps the rolling transcript small without hiding fresh output.

## Two Compression Paths

### 1. `compressToolLoopHistory` (Between Turns)

Runs via the history compression middleware on round 0 (between user turns). This is the primary compression path.

**Rules**:
- Protects recent rounds (last N rounds are never compressed)
- Never touches messages before `priorTurnBoundary` (preserves BP3 cache prefix)
- Each compressed block is registered in working memory via `addChunk`
- HPP `dematerialize()` is called for compressed chunks (transitions materialized → referenced)
**Budget-driven compression**: If history exceeds `CONVERSATION_HISTORY_BUDGET_TOKENS` (24k), the oldest non-reference messages are compressed until under budget.

### 2. `deflateToolResults` (Immediately After Tools)

Runs right after tool execution completes, before the next round. A lighter pass than the between-turns compressor, but it **does create chunks** for results large enough to be worth pointing at:

- First, tries to match the tool_result against an existing engram (by content hash or source description) and replaces inline content with a hash pointer.
- When **no match exists** and the tool_result is **≥ 30 tokens** (`MIN_DEFLATE_TOKENS` in [`historyCompressor.ts`](../atls-studio/src/services/historyCompressor.ts) ~722), a new engram is created via `addChunk` and the history entry is replaced with a ref to it. History never carries large inline tool results — they're always written at insertion time.
- **Revision guard**: skips deflating onto engrams whose backing file revision no longer matches the current source (avoids pointing history at stale WM).
- **Assistant side**: `stubBatchToolUseInputs` runs on the latest assistant message and replaces large `tool_use.input.steps` arrays (> 80 tokens of serialized form) with a compact `_stubbed` summary — see below.
## Rolling history window

Beyond hash deflation, the compressor maintains a **verbatim window** of the most recent tool-loop rounds in history. Constants live in [`promptMemory.ts`](../atls-studio/src/services/promptMemory.ts): `ROLLING_WINDOW_ROUNDS` (20) and `ROLLING_SUMMARY_MAX_TOKENS` (1650).

When the number of **rounds** in history exceeds the window, the **oldest** round is removed from the verbatim transcript and **distilled** into structured facts by [`historyDistiller.ts`](../atls-studio/src/services/historyDistiller.ts). The distiller fills a [`RollingSummary`](../atls-studio/src/services/historyDistiller.ts) in the context store (`decisions`, `filesChanged`, `userPreferences`, `workDone`, `findings`, `errors`).

**Substantive round counting.** `countSubstantiveRounds` in [`historyCompressor.ts`](../atls-studio/src/services/historyCompressor.ts) ~107 excludes rounds triggered by synthetic auto-continue prompts (e.g. "Your response was truncated", "Continue working.") from the window count, so system-injected continuations don't push real work out of the verbatim transcript.

### Rolling summary in the state preamble

The distilled summary is **not** appended as a normal chat UI message. When building the provider request, [`aiService.ts`](../atls-studio/src/services/aiService.ts) includes the rolling summary as part of the **state preamble** — a synthetic first user message in the assembled payload that also carries session state (task/plan, BB, WM, steering signals). The summary is merged into this preamble via `conversationHistory.unshift(formatSummaryMessage(...))` and then combined with the state block by `assembleProviderMessages()`. The visible transcript stays append-only for user/assistant turns; BP3 still treats the history prefix as stable for caching **within** a tool loop (see [`prompt-assembly.md`](prompt-assembly.md)).

### Interaction with compression

- The rolling summary message is **not** compressed into a hash pointer, so distilled facts are not replaced by stale pointers. A targeted cleanup path in `compressToolLoopHistory` also removes any orphaned assistant messages that happen to be compressed refs containing `[Rolling Summary]` text ([`historyCompressor.ts`](../atls-studio/src/services/historyCompressor.ts) ~255-275).
- When compressed history would leave **orphaned** hash pointers that referenced the rolling summary, those pointers are **removed** to avoid incoherent references.

```mermaid
flowchart LR
  verbatim[Verbatim_history_window]
  distill[historyDistiller]
  rsStore[rollingSummary_in_contextStore]
  apiHist[Provider_message_list]
  persist[Snapshot_format_v5_on_disk]
  verbatim -->|rounds_age_out| distill
  distill --> rsStore
  rsStore --> apiHist
  rsStore --> persist
```

Distilled state is persisted with the memory snapshot as **snapshot format v5** (`rollingSummary` on [`PersistedMemorySnapshot`](../atls-studio/src/services/chatDb.ts)).

## Digest Format

Compressed entries include an edit-ready digest when available:

```typescript
function formatChunkRef(shortHash, tokens, source?, description?, digest?): string {
  const header = description
    ? `[h:${shortHash} ${tokens}tk ${description}]`
    : `[h:${shortHash} ${tokens}tk${source ? ` ${source}` : ''}]`;
  if (digest) return `${header}\n${digest}`;
  return header;
}
```

The digest provides structural context — function names, line ranges, class declarations — so the model can decide whether to recall the full content without spending tokens to see it.

## Cache Interaction

History compression is deliberately deferred to round 0 to maintain cache stability:

- **Within a tool loop** (rounds 1, 2, 3...): The **saved chat transcript** is strictly append-only. No compression, no mutation of prior messages. This ensures the BP3 cache prefix stays byte-identical for that transcript, giving cache reads at 0.1x cost. The API may still **prepend** the synthetic `[Rolling Summary]` message (see above); logical BP3 hit/miss is modeled in [`logicalCacheMetrics.ts`](../atls-studio/src/services/logicalCacheMetrics.ts) — see [`prompt-assembly.md`](prompt-assembly.md).
- **Between user turns** (round 0): Compression runs, potentially modifying old messages. This invalidates the BP3 cache, but a new cache write happens at the start of the next tool loop.

## Stubbing assistant-side batch tool_use

Compression traditionally targets tool *results* (the user-role messages). `stubBatchToolUseInputs` in [`historyCompressor.ts`](../atls-studio/src/services/historyCompressor.ts) ~669 attacks the **assistant** side:

- Scans the most recent assistant message for `tool_use` blocks with `name === 'batch'`.
- If the serialized `input` exceeds `BATCH_INPUT_STUB_THRESHOLD = 80` tokens, replaces `input.steps` with a compact `_stubbed` summary produced by `formatBatchToolUseStubSummary`.
- Called from [`aiService.ts`](../atls-studio/src/services/aiService.ts) immediately after the assistant message is pushed, **before** `deflateToolResults` processes the paired tool_result blocks.

This matters because a large `batch` payload (say, 20 steps with inline content) can dominate the transcript the next round will re-read. After stubbing, the model sees the shape of what it did without re-reading the full step list.

## Retention-op compaction (ephemeral output)

Retention ops (`session.pin`, `session.unpin`, `session.drop`, `session.unload`, `session.compact`, `session.bb.delete`) mutate state that the model reads back through the next round's hash manifest. The manifest is authoritative; emitting a tool_result echo is duplicate signal and — worse — a stable shape the model will re-emit verbatim next round (template calcification). The compactor's job is to ensure retention output is **ephemeral by design**: visible during the round, absent from persisted history on success.

`compactRetentionOps` in [`historyCompressor.ts`](../atls-studio/src/services/historyCompressor.ts) runs **between** `stubBatchToolUseInputs` and `deflateToolResults` at turn-finalize.

| Surface | Before compaction | After compaction |
|---|---|---|
| `tool_use` step args | `{id:"u1", use:"session.unpin", with:{hashes:["h:abc123","h:def456","h:7890ab"]}}` | `{id:"u1", use:"session.unpin"}` — no `with`, no `in`, no markers |
| `tool_result` OK line | `[OK] u1 (session.unpin): unpin: 3 chunks unpinned (19ms)` | *(line removed entirely)* |
| `tool_result` FAIL line | `[FAIL] u1 (session.unpin): unpin: ERROR no matching refs…` | *(unchanged — FAIL text is the model's only diagnostic signal)* |
| `[ATLS]` footer | `[ATLS] 3 steps: 3 pass | ok` | *(unchanged — keeps true step count)* |
| Non-retention lines | *(unchanged)* | *(unchanged — `deflateToolResults` handles their payloads)* |

**Rules:**

- Only `[OK]` retention lines are removed. `[FAIL]` lines stay verbatim — failure means the model targeted something not in the manifest, and it needs to know.
- All retention tool_use args are stripped (including `with.scope` for scope-based drops) — the manifest carries every effect.
- `step.in` dataflow references are also dropped.
- Idempotence is tracked via a module-scoped `WeakSet<object>`, not a serialized flag — no `_compacted: true` leaks to the API (that was the prior spin surface).
- Runs **pre-BP3** so the compacted form is what lands in the cacheable prefix — no retroactive rewrite.

**Handler defense (zero-match surfaces as FAIL):** The handlers for `pin/unpin/drop/unload/compact/bb.delete` in [`session.ts`](../atls-studio/src/services/batch/handlers/session.ts) and `bb.delete` in [`blackboard.ts`](../atls-studio/src/services/batch/handlers/blackboard.ts) err loudly when args resolve to zero targets. Previously a no-op retention call returned `ok('no matching chunks')` which compaction hid as a successful receipt. Now a retention call with no resolvable targets returns `[FAIL]` with an explicit message pointing at the manifest — visible to the model, not compacted away.

**Why this shape:** The model templates whatever stable structure it sees in prior tool_use. The pre-Nov-2026 compaction left `{n:3, _compacted:true}` behind, which the model re-emitted verbatim as a "valid" call; the runtime processed it as a no-op and returned another receipt, and the model spun. The fix is not to dress up the receipt — it's to not write one at all. The manifest is the receipt.

**Measured savings** (scripted 20-round retention-heavy session, sub-threshold batches): **35.5%** input-token reduction versus no compaction, up from ~20% under the prior collapse-to-`ok` shape. See [`historyCompressor.retention.measurement.test.ts`](../atls-studio/src/services/historyCompressor.retention.measurement.test.ts).

**Interaction with auto-pin on read:** under `autoPinReads: true` (default; see [auto-pin-on-read.md](auto-pin-on-read.md)), reads don't emit explicit `pi`, so retention output is already rarer. When the model does emit release ops (`pu`/`pc`/`dro`), this compaction keeps them out of persisted history. The two features compound: fewer emissions, and the ones that happen don't leave receipts.

## Emergency compression

`compressToolLoopHistory` accepts an optional `emergency` flag. When set, it compresses **even protected rounds** — normally the last N rounds are preserved verbatim, but under pressure the safety net is lowered. Used by `chatMiddleware` when token pressure crosses hard caps mid-loop.

## Context Hygiene Middleware

After 20+ rounds, the context hygiene middleware performs aggressive compression:

- Threshold: `COMPACT_HISTORY_TOKEN_THRESHOLD = 18000` tokens
- Trigger: `roundCount >= COMPACT_HISTORY_TURN_THRESHOLD = 20` rounds
- Action: Same as `compressToolLoopHistory` but runs at any round, not just round 0

Both constants live in [`promptMemory.ts`](../atls-studio/src/services/promptMemory.ts) ~36-37. This is a safety net for extremely long sessions where the model hasn't called `session.compact_history` itself.

## Model-Initiated Compression

The model can explicitly trigger compression via `session.compact_history`:

```json
{"id": "ch", "use": "session.compact_history"}
```

The tool reference surfaces the `ch` shorthand; the Cognitive Core doesn't carry a specific threshold quote — the model is expected to call it when it observes sustained history growth (typically past the hygiene threshold above).

---

**Source**: [`historyCompressor.ts`](../atls-studio/src/services/historyCompressor.ts), [`historyDistiller.ts`](../atls-studio/src/services/historyDistiller.ts), [`chatMiddleware.ts`](../atls-studio/src/services/chatMiddleware.ts), [`contextHash.ts`](../atls-studio/src/utils/contextHash.ts) (`formatChunkRef`), [`promptMemory.ts`](../atls-studio/src/services/promptMemory.ts) (thresholds)
