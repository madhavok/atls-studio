# Metrics — billing grade vs estimated

ATLS Studio surfaces two families of numbers in the chat footer and the ATLS
Internals panel. Treat them as separate tiers:

- **BILLED** — authoritative provider usage (`StreamChunk::Usage`) fed into
  `calculateCostBreakdown` and `costStore.recordUsage`. Safe to reconcile
  against an invoice.
- **ESTIMATED** — BPE heuristics, compounding models, and derived "$ saved"
  counters. Directional signal; never a bill.

The `BILLED:` / `EST:` tooltip prefix in the UI comes from
[`src/components/AiChat/metricsLabels.ts`](../atls-studio/src/components/AiChat/metricsLabels.ts).

## Tier 1 — BILLED (provider-authoritative)

| Metric | Unit | Source | Reset | Notes |
|---|---|---|---|---|
| `chatCostCents` | cents | `costStore.recordUsage` | `resetChat` / new session | Sum of per-round `calculateCost(...)` over main + subagent rounds in this conversation. |
| `sessionCostCents` | cents | `costStore.recordUsage` | `resetSession` | Since app launch. Swarm workers excluded when `affectMainChatMetrics=false`. |
| `todayTotalCents` | cents | `costStore.dailyUsage[date=today]` | daily roll | Persisted to `localStorage` (`atls-cost-data`). |
| `sessionInputTokens` / `sessionOutputTokens` | tokens | provider `Usage` chunks | `resetSession` | Sum across all recorded rounds; each tool-loop round is its own API request. |
| `cacheMetrics.sessionCacheReads` / `...Writes` / `...Uncached` | tokens | provider `Usage` chunks | `resetSession` | Anthropic non-overlap; OpenAI / Gemini overlap with `inputTokens`. |
| `RoundSnapshot.costCents` / `inputCostCents` / `outputCostCents` | cents | `calculateCostBreakdown` per round | snapshot list cap | Drives `CostIOSection` charts. |
| `RoundSnapshot.cacheSavingsCents` | cents | `noCacheCost − actualCost` per round | snapshot list cap | Provider-specific cache semantics; 0 when no cache tokens reported. |
| `CostIOSection.totalCacheSavings` | cents | sum of `cacheSavingsCents` across main rounds | chart refresh | Shown as "Cache savings (billed)". |

Pricing table lives in [`src/stores/costStore.ts`](../atls-studio/src/stores/costStore.ts)
as `PRICING`, updated Feb 2026.

## Tier 2 — ESTIMATED (ATLS-side heuristics)

| Metric | Unit | Source | Reset | Notes |
|---|---|---|---|---|
| `usedTokens` (context bar) | tokens | `RoundSnapshot.estimatedTotalPromptTokens` or `wmTokens + totalOverheadTokens` fallback | per snapshot | FileView-aware (see `contextStore.getPromptTokens`). |
| `wmTokens` | tokens | `contextStore.getPromptTokens()` | — | Sums non-chat chunks not covered by any **pinned** FileView, plus every **pinned** live FileView block's rendered token cost. Unpinned views are dormant — they contribute 0 tokens and their constituent chunks re-surface in ACTIVE ENGRAMS under normal HPP rules. |
| `totalOverheadTokens` | tokens | `setPromptMetrics` composes from static components | `resetChat` | Mode + tools + shell guide + native + primer + ctx control + entry manifest. Excludes dynamic workspace block. |
| `compressionSavings` | tokens | `historyCompressor.addCompressionSavings` | `resetChat` | Monotonic session counter. Sum of tool-result deflation + assistant stubbing. |
| `rollingSavings` | tokens | `addRollingSavings` | `resetChat` | Monotonic session counter. Tokens removed by rolling-summary fold-in. |
| `freedTokens` | tokens | `contextStore` compaction / eviction | `resetSession` | Monotonic session counter. |
| `inputCompressionSavings` | tokens | `formatResult → toolResultCompression` when toggle on | `resetChat` | One-time per-tool-result encoder savings. |
| `cumulativeInputSaved` | tokens | `recordRound` **delta** over all four counters above | `resetChat` | One-time tokens never sent. Does NOT double-count across rounds — see "Bug we fixed" below. |
| `recurringInputSaved` | tokens | `recordRound` sum of `compressionSavings + rollingSavings` each round | `resetChat` | Compounding view assuming each round re-sends everything at full input rate. Ignores prompt caching. |
| `cumulativeCostCents` | cents (est.) | `calculateCostBreakdown` on cumulative savings blended by session cache-read share | — | Uses the same formula chat/session totals use, so the blended $ tracks the actual billing mix. |
| `fileViewCount` / `fileViewRenderedTokens` / `fileViewCoveredChunkTokens` | count / tokens | `captureInternalsSnapshot` | per snapshot | `rendered − coveredChunks` is the first-touch premium vs reuse savings. |
| `fileViewReuseCount`, `autoHealShiftedCount`, `autoRefetchCount`, `autoRefetchSkippedByCap`, `staleReadRounds` | count | FileView lifecycle callbacks | `resetChat` | Observability only. `staleReadRounds` target is zero — non-zero is a bug. |

## The bug we fixed — `cumulativeInputSaved`

Before the 2026-04 metrics pass, `recordRound` summed the cumulative
counters each round:

```ts
// Old: triangular over-count.
const perRoundSavings =
  compressionSavings + rollingSavings + freedTokens;
cumulativeInputSaved += perRoundSavings;
```

Because all three inputs are monotonic session counters, `freedTokens = 100`
once made `cumulativeInputSaved` grow by 100 **every subsequent round**. An
N-round session showed roughly `N × trueSavings`, pushing the green "saved"
chip and its "~$X saved" estimate absurdly high after a few dozen rounds.

The new shape keeps a `_lastRoundSavingsSnapshot` on the appStore and sums
non-negative deltas only:

```ts
const deltaCompression = max(0, compressionSavings − prev.compressionSavings);
const deltaRolling     = max(0, rollingSavings     − prev.rollingSavings);
const deltaFreed       = max(0, freedTokens        − prev.freedTokens);
const deltaInputComp   = max(0, inputCompressionSavings − prev.inputCompressionSavings);
cumulativeInputSaved += deltaCompression + deltaRolling + deltaFreed + deltaInputComp;
```

The old "savings multiply across rounds" narrative lives on as the opt-in
`recurringInputSaved` number (shown with a `· recur …` tooltip). Useful
signal, not invoice math.

## Other accounting fixes in the same pass

- `contextStore.getPromptTokens()` now matches what `formatTaggedContext`
  actually emits: chunks covered by a **pinned** FileView are suppressed
  and every **pinned** live FileView block's rendered tokens (skeleton
  rows not overlaid + fill bodies + fullBody + chrome) are added. Unpinned
  views are dormant — they render nothing, charge 0 tokens, and their
  constituent chunks participate normally in ACTIVE ENGRAMS under HPP
  dematerialization + TTL archive rules (see [engrams.md](./engrams.md)
  `Active ──(unpin)──► Dormant ──(age/evict)──► Archived`).
  ([`src/services/fileViewTokens.ts`](../atls-studio/src/services/fileViewTokens.ts),
   [`src/services/fileViewRender.ts`](../atls-studio/src/services/fileViewRender.ts))
- `~$ saved via cache` used a one-multiplier heuristic that drifted from
  `calculateCostBreakdown`. It is now computed per round as
  `calculateCostBreakdown(noCache) − calculateCostBreakdown(actual)` and the
  UI aggregates those deltas into a single "Cache savings (billed)" line.
- `cumulativeCostCents` (the "$ value" beside `cumulativeInputSaved`) now
  blends the session cache-read share into its input cost, so it reflects
  what those tokens would have actually cost (cache-heavy sessions used to
  be over-valued by 10×).
- `inputCompressionSavings` (from the `compressToolResults` toggle) is now
  rolled into `cumulativeInputSaved` and surfaced on its own line inside
  `ContextMetrics`. Previously a dead counter.

## Where the numbers show up in the UI

- **Chat footer** (`ContextUsageBar`): chunks / overhead, used/max, session
  in / out, chat | session | today cost. Tooltips prefix `BILLED:` or `EST:`.
- **`ContextMetrics` compact row**: `overhead`, `saved:<cumulative>`,
  `r:<rounds>`, `eff:<%>`, `cache:<hitRate>`, `bp3:hit/miss`.
- **`ContextMetrics` expanded**: overhead breakdown bar, per-round savings
  line including `input-comp` and `freed`, est. cumulative + recurring +
  `~$` value, FileView row (`rendered … chunks …`, `reuse`, `heal`,
  optional red `stale`), cache performance + billed cache savings, budget
  split vs model max.
- **Internals → Cost & I/O** (`CostIOSection`): per-round I/O stacked bars,
  cost line + dashed "Cache Saved" line when applicable, 10 stat cards
  including `Cache savings (billed)`.

## Tests

See [`src/utils/__tests__/metricsInvariants.test.ts`](../atls-studio/src/utils/__tests__/metricsInvariants.test.ts).
12 invariants: delta math (4), FileView parity (2), cache savings math (3),
view summarizer (3). Tauri is mocked via the same pattern as
`toolResultCompression.wiring.test.ts`.
