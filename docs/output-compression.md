# Output-Token Compression

The single largest per-round cost on Claude-family pricing is **output tokens** (5× input rate). ATLS's batch surface, UHPP reference system, and history pipeline are fundamentally an output-token compression stack — they compress what the *model* must emit, not just what the prompt contains.

This doc is a cross-cutting inventory. Each mechanism has a home file; this page organizes them by the axis along which they shrink model emission and links back to authoritative sources.

For the input-side story (caching, breakpoints, provider-reported accounting), see [api-economics.md](./api-economics.md). For the structural view of the batch tool itself, see [batch-executor.md](./batch-executor.md).

---

## The thesis

A naive tool-calling agent emits, per round:
1. A free-form reasoning paragraph.
2. A JSON tool call with fully-qualified tool name, fully-named params, and content copied from earlier in the conversation.
3. One tool call per atomic action, with narration between them.

ATLS attacks all three. The result is that a typical ATLS round emits something closer to a **shorthand trace of intent** than a tool-call log:

```
r1 rc ps:src/auth.ts
e1 ce f:h:$last le:[{line:42,action:replace,content:"..."}] if:r1.ok
v1 vb if:e1.ok
```

Three primitive steps, one tool envelope, ~40 tokens — versus hundreds for the equivalent JSON trio with narration. The compression stacks across six axes.

---

## Axis 1: Lexical (wire format)

Tokens saved per tool call by writing less characters on the wire.

| # | Mechanism | Lives in | Effect |
|---|-----------|----------|--------|
| L1 | **Single `batch()` tool envelope** | [services/batch/executor.ts](../atls-studio/src/services/batch/executor.ts), tool schema | One tool_use per round instead of N |
| L2 | **Line-per-step `q` format** (`id op k:v …`) | [utils/toon.ts](../atls-studio/src/utils/toon.ts) `parseBatchLines` | ~70%+ vs JSON for multi-step batches |
| L3 | **Operation shorthands** (`ce`, `sc`, `vb`, `rl`, …) | [services/batch/opShorthand.ts](../atls-studio/src/services/batch/opShorthand.ts) (`SHORT_TO_OP`, 76 codes) | 1-3 tokens per op vs dotted name |
| L4 | **Parameter shorthands** (`ps`, `le`, `sl`, `el`, `sn`, `qs`, `sf`, `ff`) | [services/batch/paramNorm.ts](../atls-studio/src/services/batch/paramNorm.ts) `GLOBAL_ALIASES` + [opShorthand.ts](../atls-studio/src/services/batch/opShorthand.ts) `PARAM_SHORT` | 1-3 tokens per high-frequency key |
| L5 | **`in:` dataflow shorthand** (`in:r1.refs`) | [toon.ts](../atls-studio/src/utils/toon.ts) `expandDataflow` | Avoids nested JSON `{from_step,path}` |
| L6 | **`if:` condition shorthand** (`if:e1.ok`, `!.refs`, `if:e1.refs`) | [toon.ts](../atls-studio/src/utils/toon.ts) `expandBatchIfShorthand`; [coerceBatchSteps.ts](../atls-studio/src/services/batch/coerceBatchSteps.ts) applies the same expansion to JSON `if` strings | Avoids `{step_ok: "e1"}` structure |
| L7 | **TOON serialization** for nested values | [toon.ts](../atls-studio/src/utils/toon.ts) `toTOON` (booleans `1/0`, unquoted strings, minimal braces) | ~40-60% vs JSON (per file header) |
| L8 | **`compactByFile`** | [toon.ts](../atls-studio/src/utils/toon.ts) | Strips repeated `file`/`path` keys from arrays; only activates when dedup actually saves tokens |
| L9 | **Bare hash-ref tokens** in `q` lines | [toon.ts](../atls-studio/src/utils/toon.ts) `parseBatchLines` accumulates `h:XXXX` tokens into `hashes` | `h:abc123` in a token instead of `"hashes":["h:abc123"]` |

---

## Axis 2: Semantic (higher-level intent in fewer emissions)

Tokens saved by letting the model express *what it wants* rather than *how to achieve it*.

| # | Mechanism | Lives in | Effect |
|---|-----------|----------|--------|
| S1 | **Intent macros** (`intent.edit`, `intent.investigate`, `intent.search_replace`, `intent.refactor`, …) | [services/batch/intents/*.ts](../atls-studio/src/services/batch/intents/) | One line expands client-side to 3-5 primitive steps |
| S2 | **Skip-satisfied sub-steps inside intents** | [intents/*](../atls-studio/src/services/batch/intents/) | Staged/pinned targets skip re-read; BB-cached results skip re-search |
| S3 | **Lookahead dropped under pressure** | [executor.ts](../atls-studio/src/services/batch/executor.ts) + `isPressured()` from [promptMemory.ts](../atls-studio/src/services/promptMemory.ts) | Speculative reads injected client-side and silently discarded when budget is tight — model never knew about them |
| S4 | **Named bindings (`out: "$name"`, `{bind: "$name"}`)** | [executor.ts](../atls-studio/src/services/batch/executor.ts), [types.ts](../atls-studio/src/services/batch/types.ts) | Reuse a value across steps without re-emitting it |
| S5 | **Named ref pre-registration (`refs: [{name: "$target", ref: "h:..."}]`)** | [executor.ts](../atls-studio/src/services/batch/executor.ts) | Emit a hash once per batch envelope |
| S6 | **Structured `content` parallel arrays on search results** (`file_paths` / `lines` / `end_lines`) | [services/batch/handlers/query.ts](../atls-studio/src/services/batch/handlers/query.ts) | Next step binds to the array; model never re-parses or re-emits hit lists |

---

## Axis 3: Temporal (don't re-emit what the runtime already has)

Tokens saved by referring to recency rather than re-pasting identifiers.

| # | Mechanism | Lives in | Effect |
|---|-----------|----------|--------|
| T1 | **Recency refs** (`h:$last`, `h:$last-N`) | [utils/hashResolver.ts](../atls-studio/src/utils/hashResolver.ts), [contextStore.ts](../atls-studio/src/stores/contextStore.ts) | "The thing I just touched" in 7 chars, no hash copy-paste |
| T2 | **Operation-scoped recency** (`h:$last_edit`, `h:$last_read`, `h:$last_stage`) | Same | Separate recency stacks per origin |
| T3 | **Rollback recency** — `h:$last_edit-N` resolves from the edit stack specifically | [docs/hash-protocol.md](./hash-protocol.md) | Safer restore target than global `$last` |

---

## Axis 4: Spatial (address groups and views compactly)

Tokens saved by selecting sets and views instead of enumerating members.

| # | Mechanism | Lives in | Effect |
|---|-----------|----------|--------|
| SP1 | **Set selectors** (`h:@pinned`, `h:@dormant`, `h:@dematerialized`, `h:@edited`, `h:@latest:N`, `h:@file=*.ts`, `h:@type=search`, `h:@ws:frontend`, `h:@sub:subtask1`) | [contextStore.ts](../atls-studio/src/stores/contextStore.ts) `queryBySetSelector`, [services/uhppExpansion.ts](../atls-studio/src/services/uhppExpansion.ts) | One token for a dynamic N-hash list |
| SP2 | **Set boolean operations** (`+` union, `&` intersect, `-` difference) | [utils/hashResolver.ts](../atls-studio/src/utils/hashResolver.ts) | Compose selectors without listing hashes |
| SP3 | **UHPP shapes** (`:sig`, `:fold`, `:dedent`, `:imports`, `:exports`, `:head(N)`, `:tail(N)`, `:grep(pat)`) | [utils/uhppTypes.ts](../atls-studio/src/utils/uhppTypes.ts), [src-tauri/src/hash_resolver.rs](../atls-studio/src-tauri/src/hash_resolver.rs), [src-tauri/src/shape_ops.rs](../atls-studio/src-tauri/src/shape_ops.rs) | Structural view selected with one modifier |
| SP4 | **Symbol extraction** (`:fn(name)`, `:cls(Name)`, `:sym(Name)`, `:fn(name#2)`) | Same | Address a symbol by name without coordinates |
| SP5 | **Meta modifiers** (`:tokens`, `:meta`, `:lang`, `:source`) | Same | Zero-content metadata retrieval |
| SP6 | **Content-as-ref inline resolution** — `"content": "h:XXXX:fn(name):dedent"` resolves to extracted content at execution time | [src-tauri/src/hash_resolver.rs](../atls-studio/src-tauri/src/hash_resolver.rs), [services/batch/executor.ts](../atls-studio/src/services/batch/executor.ts) | Model references code instead of copying it verbatim — large savings on `change.create` / `change.refactor` |
| SP7 | **Line-range refs** (`h:XXXX:15-50`, `h:XXXX:45-`) | UHPP | Slice without a separate read |

---

## Axis 5: Computational (don't emit reasoning the executor can do)

Tokens saved by moving arithmetic, injection, and coordination out of the model emission path.

| # | Mechanism | Lives in | Effect |
|---|-----------|----------|--------|
| C1 | **Intra-step line rebase** (`rebaseIntraStepSnapshotLineEdits`) | [executor.ts](../atls-studio/src/services/batch/executor.ts) | All `line_edits` in one step use pre-edit coordinates; executor computes cumulative deltas. Model never emits "wait, L50 is now L53" reasoning text |
| C2 | **Cross-step line rebase** (`rebaseSubsequentSteps`, `buildPerFileDeltaMap`) | [executor.ts](../atls-studio/src/services/batch/executor.ts) | Same guarantee across steps in a batch |
| C3 | **`edits_resolved` chaining** | [batch/handlers/change.ts](../atls-studio/src/services/batch/handlers/change.ts), [prompts/editDiscipline.ts](../atls-studio/src/prompts/editDiscipline.ts) ("use for chaining, not mental math") | Subsequent steps consume resolved coordinates; no re-statement of spans |
| C4 | **Sequential `line_edits` semantics** | [src-tauri/src/lib.rs](../atls-studio/src-tauri/src/lib.rs) (`apply_line_edits`) | Apply in array order with running deltas; matches the model's natural reading order — no mental reordering serialized |
| C5 | **Auto-workspace inference** (`inferWorkspaceFromPaths`) | [executor.ts](../atls-studio/src/services/batch/executor.ts) | `verify.*` steps auto-resolve workspace from edited paths; model omits `workspace:` |
| C6 | **Auto-verify injection** (policy `verify_after_change`) | [services/batch/policy.ts](../atls-studio/src/services/batch/policy.ts) `getAutoVerifySteps` | Executor appends `verify.build`; model doesn't emit it |
| C7 | **Auto pin migration on edit** | [batch/handlers/change.ts](../atls-studio/src/services/batch/handlers/change.ts) `registerEditHashes` | Edited chunk auto-pins new hash, unpins old; no trailing `session.pin` |
| C8 | **Auto-stage impacted ranges** (`runImpactAutoStage`) | [executor.ts](../atls-studio/src/services/batch/executor.ts) | Impacted symbols staged for the next turn without a `session.stage` emit |
| C9 | **`__auto_stage_repeat` injection** | [executor.ts](../atls-studio/src/services/batch/executor.ts) | After ≥2 reads of the same file, executor auto-stages — even if `auto_stage_refs: false` |
| C10 | **Auto-rollback infrastructure** (`on_error: 'rollback'` + shadow versions) | [executor.ts](../atls-studio/src/services/batch/executor.ts), [src-tauri/src/chat_db_commands.rs](../atls-studio/src-tauri/src/chat_db_commands.rs) | Executor has restore data; model doesn't spell it out |
| C11 | **Snapshot hash injection before edits** (`injectSnapshotHashes`) | [executor.ts](../atls-studio/src/services/batch/executor.ts) | Model doesn't emit `snapshot_hash` on every edit entry; tracker provides it |
| C12 | **Own-write suppression** (`registerOwnWrite`) | [hooks/useAtls.ts](../atls-studio/src/hooks/useAtls.ts), [contextStore.ts](../atls-studio/src/stores/contextStore.ts) | Prevents false "external change" churn that would force re-reads and re-emissions |

---

## Axis 6: Transcript (compress the past so the future can be shorter)

Tokens saved by shrinking the history the model reads, so the next emission sees less and repeats less.

| # | Mechanism | Lives in | Effect |
|---|-----------|----------|--------|
| TR1 | **`deflateToolResults`** — inline tool results replaced with `[h:XXXX …]` pointers when a matching engram exists | [services/historyCompressor.ts](../atls-studio/src/services/historyCompressor.ts) | Avoids duplicate content between history and WM |
| TR2 | **`compressToolLoopHistory`** — tool results over `COMPRESSION_THRESHOLD_TOKENS` (100 base; 200 for `system.*`/`verify.*`) deflated to pointers and registered as chunks | [historyCompressor.ts](../atls-studio/src/services/historyCompressor.ts) | Large multipliers: a 2000-token result becomes a ~20-token pointer |
| TR3 | **`stubBatchToolUseInputs`** — past batch tool_use inputs > 80 tokens replaced with `_stubbed` summaries | [historyCompressor.ts](../atls-studio/src/services/historyCompressor.ts) `stubBatchToolUseInputs` | Compresses the *assistant* side: past batch payloads shrink to short stubs in the transcript the model re-reads |
| TR4 | **Rolling window + distillation** — rounds beyond `ROLLING_WINDOW_ROUNDS` (20) distilled to `RollingSummary` (capped at `ROLLING_SUMMARY_MAX_TOKENS` = 1650) | [historyCompressor.ts](../atls-studio/src/services/historyCompressor.ts), [historyDistiller.ts](../atls-studio/src/services/historyDistiller.ts) | Bounds verbatim history; summary carries `decisions / filesChanged / userPreferences / workDone / findings / errors` |
| TR5 | **`countSubstantiveRounds`** excludes synthetic auto-continue messages from round counting | [historyCompressor.ts](../atls-studio/src/services/historyCompressor.ts) | Rolling window ages out real rounds, not artifacts |
| TR6 | **Emergency compression path** in `compressToolLoopHistory` (skips protected rounds) | [historyCompressor.ts](../atls-studio/src/services/historyCompressor.ts) | Aggressive deflation when under pressure |
| TR7 | **Context hygiene middleware** at `COMPACT_HISTORY_TOKEN_THRESHOLD` (18k) / `COMPACT_HISTORY_TURN_THRESHOLD` (20 rounds) | [services/chatMiddleware.ts](../atls-studio/src/services/chatMiddleware.ts), [promptMemory.ts](../atls-studio/src/services/promptMemory.ts) | Safety net for extremely long sessions |
| TR8 | **`formatResult` size caps** (`FORMAT_RESULT_MAX_DEFAULT=80000`, `FORMAT_RESULT_MAX_SEARCH=120000`, `FORMAT_RESULT_MAX_GIT=100000`) | [utils/toon.ts](../atls-studio/src/utils/toon.ts) | Bounds handler output size entering the transcript |

---

## Axis 7: Prompt-level discipline

Direct pressure on the model to emit less text per turn.

| # | Mechanism | Lives in | Effect |
|---|-----------|----------|--------|
| P1 | **Provider override: one-sentence-max between tools** | [prompts/providerOverrides.ts](../atls-studio/src/prompts/providerOverrides.ts) "Between tool calls: ONE sentence max. No narration." | Suppresses inter-tool prose |
| P2 | **Edit discipline: dense, not terse** | [prompts/editDiscipline.ts](../atls-studio/src/prompts/editDiscipline.ts) | Cuts filler/preamble at the prompt level |
| P3 | **Subagent output prompts** — research routes to `h:bb:design:research` rather than free-form text | [prompts/subagentPrompts.ts](../atls-studio/src/prompts/subagentPrompts.ts) | Structured artifact instead of prose |
| P4 | **Per-role subagent output cap** (`SUBAGENT_MAX_OUTPUT_TOKENS_BY_ROLE`) | [promptMemory.ts](../atls-studio/src/services/promptMemory.ts) | Hard ceiling on sub-model emission |
| P5 | **Delegate result caps** (`DELEGATE_FINDINGS_TOTAL_CAP=5200`, `DELEGATE_BB_PER_KEY_CAP=2800`, `DELEGATE_FINAL_TEXT_CAP=2000`) | [services/batch/handlers/delegate.ts](../atls-studio/src/services/batch/handlers/delegate.ts) | Bounds what delegate subagents can emit back to the caller |

---

## Aggregate effect

No single mechanism is a knockout. Shorthand table alone saves ~5-10% per batch; intent macros alone save a few tool calls per turn; history deflation alone only matters at round 5+. The architecture compounds:

- A 4-step batch using shorthand `q` form ≈ **75-80%** less emission than the equivalent JSON-array tool calls.
- A 10-round session with deflation + rolling summary holds verbatim history **bounded** at ~24k tokens regardless of how much was read.
- A `change.refactor` using `content-as-ref` and `h:$last_edit` with `edits_resolved` chaining can complete in **< 100 output tokens** for what would otherwise be a 2000-token emit.

The design principle: **every token the model emits should express intent the runtime cannot infer.** Everything else — names, paths, coordinates, narration, repetitions — is the runtime's job.

---

## Not currently wired

For completeness, mechanisms that exist in the codebase but are not active in the emission path:

| Mechanism | Location | Status |
|-----------|----------|--------|
| **Reasoning recap** (`_extractRecentReasoning`, `REASONING_RECAP_MAX_CHARS=1500`) | [aiService.ts](../atls-studio/src/services/aiService.ts) ~3647 | Defined, no call sites. Would inject trailing ~1500 chars of assistant reasoning after history compression. |
| **Subagent idle-rounds stopping** (`subagentToolResultIndicatesProgress`, `subagentToolResultIndicatesExploration`) | [services/subagentProgress.ts](../atls-studio/src/services/subagentProgress.ts) | Helpers exported and tested; not wired into `checkStopConditions` in [subagentService.ts](../atls-studio/src/services/subagentService.ts). |

---

## See also

- [api-economics.md](./api-economics.md) — input-side caching and the economic mismatch
- [batch-executor.md](./batch-executor.md) — the batch surface itself
- [hash-protocol.md](./hash-protocol.md) — UHPP reference syntax (Axes 3, 4)
- [history-compression.md](./history-compression.md) — transcript compression (Axis 6)
- [prompt-assembly.md](./prompt-assembly.md) — where state, history, and summary attach in the payload
