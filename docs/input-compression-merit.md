# Input-Side Dictionary Compression — Merit Assessment

Evaluation of a proposed "read-file dictionary + ditto-mark compression" extension against what ATLS Studio already ships. Scope: tabular tool results (`search`, `issues`, `tree`, `deps`) only.

**Verdict**: partial merit, narrow scope. The core intuition is correct and already partially implemented. The specific extension is worth a measured, tokenizer-gated spike — not a shipped feature, and not the top-ROI lever given ATLS's cost structure.

---

## 1. Proposal restated

Build a read-time compressor that (a) scans ingested tabular content for frequent alphanumeric substrings, (b) emits an inline schema/dictionary key, (c) replaces substrings with short codes, and (d) uses a `"` (ditto mark) to denote "same as the field above." Claimed effect: reduce 10–20 tokens of repeated column content to 1 token, lowering ingested context cost.

## 2. What ATLS already does that overlaps

The proposal's two mechanical primitives — columnar dedup and content-level dedup — are already implemented, in different forms:

| Proposal primitive | Existing mechanism | Source |
|---|---|---|
| Ditto mark for repeated column values | `compactByFile` — strips the dominant file-path column from arrays-of-objects, grouping rows under a shared key. Only activates when dedup actually saves tokens (`fileValues.size >= withKey` gate). | [atls-studio/src/utils/toon.ts](../atls-studio/src/utils/toon.ts) `compactByFile` ~102-168 |
| Compact serialization vs JSON | `toTOON` — booleans `1/0`, unquoted strings where safe, minimal braces. ~40–60% vs JSON per the L7 entry in output-compression. | [atls-studio/src/utils/toon.ts](../atls-studio/src/utils/toon.ts) `toTOON` ~25-57 |
| "Content is the same as something I already ingested" | Content-addressed engrams + `deflateToolResults` / `compressToolLoopHistory`: past tool results replaced with `[h:XXXX …]` pointers when an engram already carries the content. The runtime does the ditto, not the model. | [docs/engrams.md](./engrams.md), [docs/history-compression.md](./history-compression.md), axes TR1 + TR2 in [docs/output-compression.md](./output-compression.md) |
| Wire-format shorthands | Op codes (`ce`, `rl`, `sc`), param aliases (`ps`, `sn`, `qs`), bare hash-ref tokens, `in:`/`if:` shorthands — axes L1–L9 in [docs/output-compression.md](./output-compression.md). | [docs/output-compression.md](./output-compression.md) |

The pattern ATLS uses consistently: **the runtime resolves references; the model never decodes custom encodings.** That choice is deliberate (see § 5, "model decode cost").

## 3. What's genuinely new in the proposal

Three pieces have no equivalent in ATLS today:

1. **Per-result learned dictionary** of arbitrary frequent substrings — not limited to the dominant file/path column that `compactByFile` targets.
2. **Intra-cell** ditto (`"` meaning "same as field above" within a row-object cell) rather than row-grouping dedup.
3. **Inline legend** emitted alongside the payload so the model decodes from the prompt itself, with no runtime lookup table.

Everything else in the proposal maps onto an existing mechanism.

## 4. Why TurboQuant is not the right analogy

[TurboQuant](https://research.google/blog/turboquant-redefining-ai-efficiency-with-extreme-compression/) quantizes floating-point vectors (embeddings / activations / weights) inside the model's compute graph. It reduces bits-per-parameter, not tokens-per-prompt. It does not compress input text and offers no technique that transfers to prompt-level string coding. Unrelated problem.

## 5. Risks

### 5.1 Tokenizer reality

Byte savings ≠ token savings. Models consume BPE / SentencePiece tokens, not characters. A custom scheme that shortens visual length can easily produce longer token counts — `"` adjacent to punctuation may merge into awkward multi-byte tokens on Anthropic / OpenAI tokenizers, short dictionary codes like `$a1` may split 1:2 tokens, and uppercase-digit alternations often fragment. Any such compressor must be validated against the **actual provider tokenizer** on representative payloads, not byte length.

### 5.2 Cache thrash

Per-round learned dictionaries are content-dependent, therefore unstable round-to-round. ATLS's input-pricing structure (see [docs/api-economics.md](./api-economics.md) cost table) is:

- Cached input (read): 0.1×
- Uncached input: 1×
- Cache write: 1.25×

A dictionary that shifts between rounds invalidates every byte after its first occurrence in the cacheable prefix. If the compressor landed anywhere near BP-static or BP3, net cost goes **up**, not down. Any spike must confine the emission to the uncached dynamic block (tool-result payload) and produce a fresh legend per result, never per session.

### 5.3 Asymmetric pricing — wrong axis

Output is **5× input**. ATLS's thesis, explicit in [README.md](../README.md) ~11 and [docs/output-compression.md](./output-compression.md), is that emission dominates cost. Input-side dictionary coding targets the cheaper side of the ledger. The same engineering effort spent on wiring one of the "Not currently wired" items in [docs/output-compression.md](./output-compression.md) (reasoning recap, subagent idle-rounds stopping) or on one of the API-level fixes in [docs/api-economics.md](./api-economics.md) § "What Would Fix This" (content-addressable caching) pays better.

### 5.4 Model decode cost

If the model must mentally decompress the payload before reasoning, two failure modes appear:

- **Correctness drift**: the model mis-resolves a code, silently hallucinating a path or identifier. This is worst-case — partial correctness hides until a tool call produces wrong coordinates.
- **Emission inflation**: the model re-emits the decoded form in its next tool call at 5× pricing, wiping out the 1× input "saving."

ATLS's content-addressed reference pattern (`h:XXXX` resolved by the runtime in [atls-studio/src/services/batch/executor.ts](../atls-studio/src/services/batch/executor.ts)) sidesteps both by keeping the model out of the decode loop.

### 5.5 Hashing / freshness coupling

Engram hashes are computed over raw content by [atls-studio/src/utils/contextHash.ts](../atls-studio/src/utils/contextHash.ts) `hashContentSync` ~78-90. Shape operations (`:fn(name)`, `:grep(pat)`, `:sig`, `:dedent`) in [atls-studio/src-tauri/src/shape_ops.rs](../atls-studio/src-tauri/src/shape_ops.rs) also operate on raw text, as does cross-step line rebase in [atls-studio/src/services/batch/executor.ts](../atls-studio/src/services/batch/executor.ts). Any compressor must therefore encode **only at the serialization boundary** (at `formatResult` time in [atls-studio/src/utils/toon.ts](../atls-studio/src/utils/toon.ts) ~187), never inside the stored engram — otherwise it breaks freshness checks, shape ops, symbol extraction, and line-rebase.

## 6. Where it could pay — the scoped target

Large tabular tool results only:

| Engram type | Why a fit |
|---|---|
| `search` | FTS / grep payloads routinely hit the `FORMAT_RESULT_MAX_SEARCH = 120000`-char cap in [atls-studio/src/utils/toon.ts](../atls-studio/src/utils/toon.ts) ~178 and carry high columnar redundancy beyond `file`/`path` (line prefixes, import boilerplate, repeated identifiers). |
| `issues` | Detector output from [atls-engine.md](./atls-engine.md): repeated rule names, severities, category tags per row. |
| `tree` | Directory listings: repeated parent path prefixes within each subtree. |
| `deps` | Import/export graphs: repeated module identifiers on both ends of each edge. |

All four land in the **uncached dynamic block** so prompt caching does not already solve the problem, and all four are natural extensions of the `compactByFile` pattern that ships today. See the `ChunkType` table in [docs/engrams.md](./engrams.md).

File-read engrams (`file`, `smart`, `raw`) are explicitly **out of scope**: they participate in shape ops, line rebase, and edit pipelines that require raw text (see § 5.5).

## 7. If a spike were done, these gates apply

A go/no-go experiment, not a feature. Required gates before any ship:

1. **Tokenizer-verified savings**. Measure against the actual Anthropic / OpenAI tokenizer on a captured corpus of real `search`/`issues`/`tree`/`deps` payloads. Auto-disable per-result when encoded tokens ≥ raw tokens. Ship threshold ≥ 15% savings on the corpus median.
2. **Serialization-boundary only**. Encode inside `formatResult` in [atls-studio/src/utils/toon.ts](../atls-studio/src/utils/toon.ts) ~187. Stored engram content and `hashContentSync` inputs remain raw.
3. **Inline legend**. Decoder dictionary emitted with each payload; no runtime state required to decode, no cross-round dictionary reuse.
4. **No cacheable-region emission**. Never inside BP-static or BP3 regions. Tool-result payloads only.
5. **Paired golden-case eval** (user rule 13). Same batch, compressed vs raw result; downstream model `tool_use` must match byte-for-byte on the eval set. Any divergence = kill.
6. **Telemetry** (user rule 15). Structured metrics: `tokens_saved_pct`, `decode_divergence_count`, `encoder_disabled_count`, per engram type.
7. **Kill criteria**. Any correctness regression in the eval set, or median tokens-saved < 10% on the corpus, stops the spike. Not shipped by default; gated behind a feature flag (user rule 19).

## 8. Recommendation — Updated

**Status: Spike complete. Shipped.**

The dictionary compression spike described in §7 has been implemented in [`toolResultCompression.ts`](../atls-studio/src/utils/toolResultCompression.ts) and is active in production. All seven validation gates from §7 are satisfied:

1. **Tokenizer-verified savings** — compression auto-disables per-result when encoded tokens ≥ raw tokens, with a minimum 10% threshold.
2. **Serialization-boundary only** — encoding runs inside `formatResult` in `toon.ts`; stored engram content and hash inputs remain raw.
3. **Inline legend** — each compressed payload carries its own `<<dict ... >>` block; no cross-round dictionary state.
4. **No cacheable-region emission** — compression targets tool-result payloads only.
5. **Feature flag** — gated behind settings toggle (`enableToolResultCompression`), default on.
6. **Telemetry** — structured metrics track tokens saved per result.
7. **Kill criteria** — auto-disable when savings fall below threshold.

The broader input compression stack — TOON serialization, shaped reads, FileView merging, history deflation, cache-aware layout, token budgets, materialization control, workspace minimization, and redundant-read blocking — is documented in [docs/input-compression.md](./input-compression.md). Together these ten layers achieve roughly 20–25% input cost reduction beyond caching alone.

The original "higher-ROI work" items from the prior recommendation remain valid targets for further optimization:
---

## See also

- [docs/output-compression.md](./output-compression.md) — six-axis output-token compression inventory (axes L7, L8, L9, TR1, TR2 are the closest existing neighbors)
- [docs/api-economics.md](./api-economics.md) — input/output cost asymmetry, cache breakpoint architecture
- [docs/engrams.md](./engrams.md) — `ChunkType` table, content-addressed engram model
- [docs/history-compression.md](./history-compression.md) — runtime-level "same as above" via hash-ref deflation
