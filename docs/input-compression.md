# Input-Side Token Compression

ATLS compresses output tokens via UHPP and the six emission axes (see [output-compression.md](output-compression.md)).
But a 200k context window still fills fast when every tool result arrives as verbose JSON and every file is read in full.
This document traces the **ten-layer input compression stack** that controls what the model sees, how it's encoded, and how much of the token budget each piece consumes.

Every layer is grounded in source references below.

## Why input compression matters despite cheaper input tokens

Input tokens cost less than output tokens (often 5× less, or 50× less with prompt caching).
But input volume is *much* larger: a typical round might inject 30k input tokens to produce 500 output tokens.
At cached pricing (0.1×), those 30k tokens cost 3,000 input-equivalents — comparable to the 500 output tokens at 5× pricing (2,500 input-equivalents).
Without input compression, context fills within 10-15 rounds and the session degrades or must restart.

Input compression is therefore less about per-token cost and more about:
1. **Context budget** — keeping total prompt size under the model's window
2. **Signal density** — ensuring the model attends to relevant content, not structural noise
3. **Cache hit rate** — stable prefixes get cached at 0.1× pricing; mutations thrash the cache
4. **Round longevity** — more rounds before context pressure forces eviction of useful state

---

## The input compression stack

### Layer 1: TOON — Token-Oriented Object Notation

**Source**: [`toon.ts`](../atls-studio/src/utils/toon.ts) (`toTOON`, `compactByFile`)

TOON is a whitespace-minimal serialization format designed to produce fewer BPE tokens than JSON for the same structured data.

**Algorithm** (`toTOON`):
- **Primitives**: numbers and booleans emit as-is. `null` → `null`. `undefined` → omitted.
- **Strings**: unquoted when they contain no special characters (`/[:\s,{}[\]]/`). Quoted with `"` only when necessary. Internal quotes escaped.
- **Arrays**: `[item1,item2,item3]` — no spaces after commas.
- **Objects**: `key:val key2:val2` — space-separated pairs, no braces at top level, no quotes on keys unless required. Nested objects get braces: `{nested_key:val}`.

This eliminates the structural overhead of JSON: no `{"`, no `": "`, no trailing commas, no indentation.

**Pre-grouping** (`compactByFile`):
Before TOON serialization, array results (e.g., search hits) are grouped by file path. The function detects the file-path key (`file`, `path`, `file_path`, `source`, `f`), groups entries, and emits:
```
{path/to/file.ts:[{line:10,name:foo},{line:22,name:bar}],other/file.ts:[{...}]}
```
This eliminates repeated file paths — a single path string covers all entries in that file. Only applied when `uniqueFiles < totalEntries` (actual dedup benefit exists).

**Measured savings**: 15-30% fewer BPE tokens than equivalent JSON. Verified by Rust-side BPE tests in [`tokenizer.rs`](../atls-studio/src-tauri/src/tokenizer.rs) (`workspace_ctx_toon_fewer_tokens_than_json_bpe`, `code_search_tool_payload_toon_fewer_tokens_than_json_bpe`).

### Layer 2: Dictionary compression on tool results

**Source**: [`toolResultCompression.ts`](../atls-studio/src/utils/toolResultCompression.ts) (`encodeToolResult`, `buildKeyAbbreviations`, `applyDittoEncode`, `buildSubstringDictionary`)

After TOON serialization, tool results above a token threshold go through a **three-pass dictionary compression pipeline**:

**Pass 1 — Key abbreviation** (`buildKeyAbbreviations`):
- Scans the TOON string for repeated key:value patterns (e.g., `symbol_id:`, `signature:`, `relevance:`).
- Assigns single-character codes: tries first character of key, then coined alternatives via `proposeCoinedCodes`.
- Avoids collisions with batch shorthands (`SHORT_TO_OP`), param aliases (`PARAM_SHORT`), and reserved glyphs (`$`, `!`, `if:`, `in:`, `out:`).
- Result: `k sig=signature` in the legend, `sig:"export function foo()"` → `sig` replaces `signature` everywhere.

**Pass 2 — Ditto encoding** (`applyDittoEncode`):
- Finds row-arrays (arrays of objects with the same keys).
- For each object in a row-array, if a value is identical to the same key's value in the preceding row, replaces it with `^`.
- Result: `{kind:function,line:10,name:foo},{kind:function,line:22,name:bar}` → `{kind:function,line:10,name:foo},{kind:^,line:22,name:bar}`.
- Only applied when there's actual repetition benefit.

**Pass 3 — Substring dictionary** (`buildSubstringDictionary`):
- Iteratively finds the **boundary-aligned substring** that saves the most tokens if replaced by a short code.
- `findBestBoundaryAlignedSubstring`: scans all start positions that are word/path boundaries, tries candidate lengths (8-64 chars), scores by `occurrences × tokenCost(substring) - tokenCost(code) - legendCost`.
- Assigns `~1`, `~2`, ... `~N` codes (tilde + number). Up to 30 entries.
- Each iteration removes the best substring, re-scans. Stops when no candidate saves tokens.
- Result: `s ~1=atls-studio/src/services` in the legend.

**Legend format**: emitted as a `<<dict ... >>` block prepended to the result:
```
<<dict
 k sig=signature
 k lin=line
 s ~1=atls-studio/src/services
 d ^
>>
```
The `d ^` line declares ditto encoding is active. The model's prompt includes decoding instructions.

**Measured savings**: 20-40% additional reduction on top of TOON for structured results with repetitive keys and paths.

### Layer 3: Shaped reads — progressive disclosure

**Source**: [`shape_ops.rs`](../atls-studio/src-tauri/src/shape_ops.rs) (`apply_shape`), [`hash_resolver.rs`](../atls-studio/src-tauri/src/hash_resolver.rs) (`apply_shape_to_content`)

`rs shape:sig` produces a **signature skeleton**: ~5-10% of the full file, showing imports, type signatures, function signatures, and fold markers `{ ... } [A-B]` for collapsed bodies.

The Rust `apply_shape` function dispatches on shape type:
- **sig**: extract signatures via tree-sitter (language-aware), emit bodies as fold markers with line ranges
- **fold**: collapse blocks above a depth threshold
- **grep(pattern)**: filter to matching lines with context
- **dedent**: strip common leading whitespace
- **nocomment**: remove comments
- **exclude(pattern)**: remove matching lines
- **highlight(lines)**: annotate specific lines
- **refs**: extract only references/imports
- **concept**: semantic summary (headings for markdown, signatures for code)

The skeleton is the model's **first impression** of any file. Fold markers like `[42-56]` are direct arguments to `rl sl:42 el:56` — no arithmetic needed. This means the model reads 50-200 tokens to understand a 2000-token file, then surgically expands only the 50-line function it needs.

### Layer 4: FileView — incremental file access

**Source**: [`fileView.ts`](../atls-studio/src/services/fileView.ts) (`getFileSkeleton`), [`fileViewStore.ts`](../atls-studio/src/services/fileViewStore.ts), [`fileViewRender.ts`](../atls-studio/src/services/fileViewRender.ts)

Each file gets **one FileView** that persists across rounds. The view accumulates slices:
1. `rs shape:sig` → skeleton appears with fold markers
2. `rl sl:42 el:56` → those lines fill into the view at their source position
3. Further `rl` calls merge into the same view

The model never re-reads content it already has. The FileView auto-heals across edits: shifted regions rebase, changed regions refetch, removed regions display `[REMOVED]` markers.

`getFileSkeleton` builds the skeleton with an LRU cache keyed by `(path, sourceRevision)`. It tries `sig` shape first, falls back to `fold` if over the token budget (default `SKELETON_TOKEN_BUDGET_DEFAULT = 1500` tokens), then stitches imports at the head.

The FileView fence carries two hashes:
```
=== path h:<RET> cite:@h:<CITE> (N lines) [pinned] ===
```
- `h:<RET>` for retention operations (pin/unpin/drop)
- `cite:@h:<CITE>` for edit operations (content_hash)

### Layer 5: History compression — temporal dedup

**Source**: [`historyCompressor.ts`](../atls-studio/src/services/historyCompressor.ts) (`compressToolLoopHistory`), [`chatMiddleware.ts`](../atls-studio/src/services/chatMiddleware.ts) (`historyCompressionMiddleware`)

Between rounds, `compressToolLoopHistory` replaces tool results with hash pointers:
```
[-> h:abc123, 1094tk | msg:asst]
```
The substance survives as a retrievable chunk; the verbatim text collapses to ~12 tokens of reference.

The middleware runs at the start of each round (after round 0), compressing results from prior turns. Phase 2 cache optimization ensures the compressed portion falls in the cache-stable prefix, getting 0.1× pricing instead of 1.25× for cache writes.

Additional compression paths:
- **`deflateToolResults`**: runs immediately after tool execution, before the next model call
- **Rolling summary**: older history beyond the protected window gets a rolling summary in the state preamble
- **Retention-op compaction**: `pi`, `pu`, `dro` calls have their arguments stripped after execution (ephemeral output)
- **Emergency compression**: when provider reports token overshoot, aggressive compression kicks in

See [history-compression.md](history-compression.md) for the full compression taxonomy.

### Layer 6: Cache-aware prompt layout

**Source**: [`chatMiddleware.ts`](../atls-studio/src/services/chatMiddleware.ts), [`aiService.ts`](../atls-studio/src/services/aiService.ts) (`assembleProviderMessages`), [`logicalCacheMetrics.ts`](../atls-studio/src/services/logicalCacheMetrics.ts)

The prompt is structured so the **static prefix** (system prompt, cognitive core, batch tool reference, workspace context) stays stable across rounds, hitting Anthropic's prompt cache at 0.1× pricing.

Cache breakpoints (`cache_control: {type: "ephemeral"}`) mark where the static prefix ends and dynamic content begins. The layout:
1. Static system prompt (stable across session) → cached
2. Batch tool reference and shorthands → cached
3. Dynamic state block (working memory, BB, manifest) → not cached, changes every round
4. Chat history (compressed older turns → cached; recent turns → not cached)

History compression (Layer 5) directly improves cache hit rate: compressed turns produce identical content across rounds, so they stay in the cached prefix.

See [prompt-assembly.md](prompt-assembly.md) for the full assembly flow and breakpoint model.

### Layer 7: Token budgets — admission control

**Source**: [`promptMemory.ts`](../atls-studio/src/services/promptMemory.ts) (`reconcileBudgets`, budget constants)

Hard token budgets gate every layer of the prompt:

| Layer | Budget | Constant |
|---|---|---|
| Conversation history | 24,000 | `CONVERSATION_HISTORY_BUDGET_TOKENS` |
| Working memory | 38,000 | `WM_BUDGET_TOKENS` |
| Workspace context | 7,000 | `WORKSPACE_CONTEXT_BUDGET_TOKENS` |
| Blackboard | 4,800 | `BLACKBOARD_BUDGET_TOKENS` |
| Staged snippets | 4,500 | `STAGED_BUDGET_TOKENS` |
| Staged anchors | 1,400 | `STAGED_ANCHOR_BUDGET_TOKENS` |

`reconcileBudgets` takes current measured sizes for all layers and produces relief actions when the total exceeds the model's context window. Relief is allocated proportionally — the most-over-budget layer gets the most pressure. Relief actions cascade through the middleware chain: staged snippets get pruned, then history compressed harder, then FileViews compacted.

Subagent budgets are separate: `SUBAGENT_TOKEN_BUDGET_DEFAULT = 200_000` with role-specific overrides and a pin cap of `SUBAGENT_PIN_BUDGET_CAP = 64_000`.

### Layer 8: Materialization control (HPP)

**Source**: [`hashProtocol.ts`](../atls-studio/src/services/hashProtocol.ts) (`materialize`, `dematerialize`, `shouldMaterialize`)

The Hash Presence Protocol (HPP) decides whether a chunk renders as **full content** or as a **compact digest line**:
- First time seen → **materialize** (full content injected into WM)
- Seen in prior turn, unchanged → **reference** (one-line digest: `h:ref + type + source + tokens`)
- Idle for N turns → **archive** → **evict**

This prevents the same search result or file skeleton from appearing in full on every round. After the first materialization, the model works from hash references, and can `rec` (recall) if it needs the content again.

The eviction heap (min-heap by `seenAtTurn`) ensures oldest-unseen content gets pruned first. The manifest at round top indexes every hash with pin state, visibility, type, source, tokens, and freshness.

### Layer 9: Workspace context — first-turn TOON

**Source**: [`aiService.ts`](../atls-studio/src/services/aiService.ts) (`buildWorkspaceTOON`, `buildContextTOON`)

On the first turn, workspace metadata (project structure, languages, dependencies, active file) is serialized via TOON into a `Ctx:{...}` block injected into the system prompt. On subsequent turns, a minimal version is used (active file only) since the full context is cached.

The workspace TOON uses `compactByFile` grouping and path deduplication, keeping the full project profile under the `WORKSPACE_CONTEXT_BUDGET_TOKENS` (7,000 token) ceiling.

### Layer 10: UHPP content references

**Source**: [`hash_resolver.rs`](../atls-studio/src-tauri/src/hash_resolver.rs), [`lib.rs`](../atls-studio/src-tauri/src/lib.rs)

UHPP hash pointers (`h:XXXX`) replace inline content throughout the prompt. Instead of pasting 50 lines of code, the model writes `h:abc123:15-30` and the runtime resolves it. This works in:
- Edit parameters (`f:h:XXXX:L-M`)
- Create content (`content:"h:XXXX:fn(name):dedent"`)
- Extract/refactor operations (`from:"h:XXXX"`)
- Cross-references in findings and BB entries

Each hash pointer is ~6 tokens. The content it replaces can be hundreds or thousands of tokens. The model learns to think in references rather than copying content.

---

## Aggregate effect

The ten layers compose multiplicatively:

| Layer | Mechanism | Typical reduction |
|---|---|---|
| TOON | Format elimination | 15-30% vs JSON |
| Dictionary compression | Key/value/substring dedup | 20-40% on tool results |
| Shaped reads | Progressive disclosure | 90-95% (sig is 5-10% of file) |
| FileView | No re-reads | ~100% on revisits |
| History compression | Hash-pointer deflation | 80-95% on prior-turn results |
| Cache-aware layout | Prefix stability | 10-12× cost reduction (cache hits) |
| Token budgets | Admission control | Hard ceiling per layer |
| Materialization (HPP) | Digest after first view | ~90% on repeat chunks |
| Workspace TOON | Grouped + minimal on repeat | 30-50% vs naive |
| UHPP content refs | Pointer vs inline | 95%+ per reference |

A representative 40-round session processes ~2M tokens of raw content but presents ~200k tokens to the model across all rounds, with ~80% of input tokens hitting prompt cache at 0.1× pricing.

## Relationship to the output-compression thesis

The whitepaper argues that output compression is the higher-leverage axis because output tokens cost 5× more per token.
Input compression is the **complementary** axis: it preserves context budget so the model can run more rounds,
and improves cache hit rate so the input tokens that do get sent cost less.

The two stacks reinforce each other:
- UHPP (output) produces hash references → HPP (input) uses those references to skip re-materialization
- Batch surface (output) reduces emissions → history compression (input) has less to compress
- Shaped reads (input) provide fold markers → the model emits precise `rl` calls instead of `rf type:full` (output)

Neither stack alone is sufficient. Together they keep a 200k-window session productive for 40+ rounds at practical cost.

---

## See also

- [output-compression.md](output-compression.md) — The six axes of emission compression
- [prompt-assembly.md](prompt-assembly.md) — Cache breakpoints, prompt structure, and assembly flow
- [history-compression.md](history-compression.md) — Hash-reference deflation, rolling summary, and retention-op compaction
- [whitepaper.md](whitepaper.md) — Section 3.4: The complementary input stack
- [input-compression-merit.md](input-compression-merit.md) — Merit assessment of input-side dictionary compression proposal

**Source**: [`toon.ts`](../atls-studio/src/utils/toon.ts), [`toolResultCompression.ts`](../atls-studio/src/utils/toolResultCompression.ts), [`shape_ops.rs`](../atls-studio/src-tauri/src/shape_ops.rs), [`fileView.ts`](../atls-studio/src/services/fileView.ts), [`fileViewStore.ts`](../atls-studio/src/services/fileViewStore.ts), [`historyCompressor.ts`](../atls-studio/src/services/historyCompressor.ts), [`chatMiddleware.ts`](../atls-studio/src/services/chatMiddleware.ts), [`promptMemory.ts`](../atls-studio/src/services/promptMemory.ts), [`hashProtocol.ts`](../atls-studio/src/services/hashProtocol.ts), [`aiService.ts`](../atls-studio/src/services/aiService.ts), [`hash_resolver.rs`](../atls-studio/src-tauri/src/hash_resolver.rs), [`tokenizer.rs`](../atls-studio/src-tauri/src/tokenizer.rs)
