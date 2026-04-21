# Batch Executor

All model-initiated actions flow through a single tool: `batch()`. This collapses the traditional multi-tool surface into a structured execution plan with step-to-step dataflow, conditional execution, intent macros, enforcement gates, and multi-level error recovery.

## Tool Surface

```json
{
  "version": "1.0",
  "goal": "read auth module, fix the bug, verify",
  "steps": [
    {"id": "r1", "use": "read.context", "with": {"type": "smart", "file_paths": ["src/auth.ts"]}},
    {"id": "e1", "use": "change.edit", "with": {"file_path": "src/auth.ts", "line_edits": [...]}, "if": {"step_ok": "r1"}},
    {"id": "v1", "use": "verify.build", "if": {"step_ok": "e1"}}
  ],
  "refs": [{"name": "$auth_hash", "ref": "h:abc123"}],
  "policy": {"verify_after_change": true, "max_steps": 10}
}
```

### Step Structure

```typescript
interface Step {
  id: string;
  use: OperationKind;             // e.g. "read.context", "change.edit"
  with?: Record<string, unknown>; // Parameters
  in?: Record<string, RefExpr>;   // Dataflow bindings from other steps
  out?: string | string[];        // Named binding output
  if?: ConditionExpr;             // Conditional execution
  on_error?: 'stop' | 'continue' | 'rollback';
}
```

### Operation and parameter shorthands

Models may emit **short codes** for `use` and for a small set of high-frequency parameter keys to save tokens on batch payloads. **Canonical dotted names and full parameter names always work**; shorthands are optional.

| Concern | Behavior |
|--------|----------|
| **Where it applies** | Line-per-step `q` text (second field per line is the operation), and JSON `steps[]` before execution (`coerceBatchSteps`). |
| **Operations** | Map short codes → `OperationKind` via `normalizeOperationUse` in [`opShorthand.ts`](../atls-studio/src/services/batch/opShorthand.ts) (`SHORT_TO_OP` / `OP_TO_SHORT`). Examples: `sc` → `search.code`, `ce` → `change.edit`, `vb` → `verify.build`, `vk` → `verify.typecheck`. |
| **Parameters** | Aliases like `ps` → `file_paths`, `le` → `line_edits`, `sl`/`el` → `start_line` / `end_line` are merged with existing aliases in [`paramNorm.ts`](../atls-studio/src/services/batch/paramNorm.ts) (`GLOBAL_ALIASES`). The same v1 set is listed as `PARAM_SHORT` in `opShorthand.ts` for the prompt legend. |
| **After normalization** | Handlers, subagent allowlists, UI summaries, and spin detection all see **canonical** `use` strings and param keys. |
| **System prompt** | [`toolRef.ts`](../atls-studio/src/prompts/toolRef.ts) embeds `generateShorthandLegend()` into `BATCH_TOOL_REF` so the model has a compact `code=canonical` key. |
| **Token audit (Rust)** | [`tokenizer_shorthand_audit.rs`](../atls-studio/src-tauri/src/tokenizer_shorthand_audit.rs) (included from `tokenizer.rs` under `cfg(test)`) compares long vs short forms across tokenizer backends. |

Do not duplicate the full code table in this doc; **`opShorthand.ts` is the source of truth** for operation codes alongside [`families.ts`](../atls-studio/src/services/batch/families.ts) for the canonical `OperationKind` list.

## Operation Families

The authoritative list of `use` strings is [`atls-studio/src/services/batch/families.ts`](../atls-studio/src/services/batch/families.ts) (`OPERATION_FAMILIES`); the batch tool reference builds its "Operation Families" block from that file. The table below summarizes the same surface.

| Family | Operations | Purpose |
|--------|-----------|----------|
| **discover** | `search.code`, `search.symbol`, `search.usage`, `search.similar`, `search.issues`, `search.patterns`, `search.memory` | Find code by query, symbol, pattern, or in-memory regions |
| **understand** | `read.context`, `read.shaped`, `read.lines`, `read.file`, `analyze.deps`, `analyze.calls`, `analyze.structure`, `analyze.impact`, `analyze.blast_radius`, `analyze.extract_plan`, `analyze.graph` | Load and comprehend code |
| **change** | `change.edit`, `change.create`, `change.delete`, `change.refactor`, `change.rollback`, `change.split_module` | Modify code with preimage verification |
| **verify** | `verify.build`, `verify.test`, `verify.lint`, `verify.typecheck` | Validate changes against toolchain |
| **session** | `session.plan`, `session.advance`, `session.status`, `session.pin`, `session.unpin`, `session.stage`, `session.unstage`, `session.compact`, `session.unload`, `session.drop`, `session.recall`, `session.stats`, `session.debug`, `session.diagnose`, `session.bb.write`, `session.bb.read`, `session.bb.delete`, `session.bb.list`, `session.rule`, `session.emit`, `session.shape`, `session.load`, `session.compact_history` | Manage memory, tasks, and session state |
| **annotate** | `annotate.note` (accepts `note` and/or `fields`; `annotate.engram` is a compatibility alias), `annotate.link`, `annotate.retype`, `annotate.split`, `annotate.merge`, `annotate.design` | Annotate, connect, and restructure engrams |
| **delegate** | `delegate.retrieve`, `delegate.design`, `delegate.code`, `delegate.test` | Dispatch cheaper sub-models (engram-first subagents; see [subagents.md](./subagents.md)) |
| **intent** | `intent.understand`, `intent.edit`, `intent.edit_multi`, `intent.investigate`, `intent.diagnose`, `intent.survey`, `intent.refactor`, `intent.create`, `intent.test`, `intent.search_replace`, `intent.extract` | Macro operations that expand to primitives |
| **system** | `system.exec`, `system.git`, `system.workspaces`, `system.help` | Shell execution, git operations, workspace management |

### `system.exec` (Windows, PTY, output)

On Windows, commands are run via a **temporary PowerShell script** (`.ps1`) so the shell can execute reliably in the PTY path. Output is captured from the terminal integration and passed through **`sanitizeExecOutput`** in [`system.ts`](../atls-studio/src/services/batch/handlers/system.ts), which strips echoed wrapper lines (including script invocation echoes), `##ATLS_*##` markers, and common PowerShell noise (e.g. `cd` error blocks) so the model sees clean stdout/stderr text.

## Dataflow

Steps wire outputs to subsequent step inputs through binding expressions:

```json
{"id": "r1", "use": "read.context", "with": {"file_paths": ["src/api.ts"]}},
{"id": "p1", "use": "session.pin", "in": {"hashes": {"from_step": "r1", "path": "refs"}}}
```

### Named ref pre-registration

The batch request envelope accepts `refs: RefRegistryHint[]` — named hash references pre-loaded into the binding map before any step runs. Steps can reference them with `{bind: "$name"}`:

```json
{
  "refs": [{"name": "$target", "ref": "h:abc123"}],
  "steps": [
    {"id": "e1", "use": "change.edit", "in": {"content_hash": {"bind": "$target"}}}
  ]
}
```

### Binding Types

| Type | Syntax | Resolves To |
|------|--------|-------------|
| **Step output** | `{from_step: "s1", path: "refs.0"}` | Output of step `s1`, dot-path navigated |
| **Literal ref** | `{ref: "h:a1b2c3"}` | Hash reference passthrough |
| **Named binding** | `{bind: "$name"}` | Output of a step with `out: "$name"`, or a pre-registered ref |
| **Literal value** | `{value: 123}` | Direct value |

### Conditions

Six condition forms, composable. Canonical names from [`types.ts`](../atls-studio/src/services/batch/types.ts) `ConditionExpr` and evaluator in [`policy.ts`](../atls-studio/src/services/batch/policy.ts) `evaluateCondition`:

```json
{"if": {"step_ok": "s1"}}              // s1 succeeded
{"if": {"step_has_refs": "s1"}}        // s1 produced non-empty refs
{"if": {"ref_exists": "h:abc123"}}     // a hash ref is present in any prior step's refs
{"if": {"not": {"step_ok": "s1"}}}     // s1 FAILED (retry logic)
{"if": {"all_steps_ok": ["s1", "r1"]}} // conjunction over named steps
{"if": {"or": [{"step_ok": "s1"}, {"step_ok": "s2"}]}} // disjunction
```

String shorthand (`if:e1.ok`, `if:e1.refs`, `if:!e1.ok`) is expanded by `expandBatchIfShorthand` in [`toon.ts`](../atls-studio/src/utils/toon.ts). The same expansion runs on JSON batch steps when `if` is a string — see [`coerceBatchSteps.ts`](../atls-studio/src/services/batch/coerceBatchSteps.ts) ~30-33.

### `session.plan` and `session.advance`

- **`session.advance`** only works when a task plan is active. Call **`session.plan`** first. Otherwise: `task_advance: ERROR no active plan — call session.plan first`.

### `session.pin` and `from_step`

- **`session.pin`** needs a non-empty **`hashes`** (or **`refs`**) array after bindings resolve.
- If you wire `in.hashes` from a prior step and that step **failed** or produced **no `refs`**, pin will error with `missing hashes param`. Use conditions (`if: { step_has_refs: "r1" }`) or a fallback step.

### Freshness: `search.issues` / `search.patterns` (`stale_policy`)

- These ops may pass **`"stale_policy": "refresh_first"`**. When set, if freshness preflight blocks, the client runs an extra `refreshRoundEnd` for the file paths and retries once before failing.

### Discover steps: structured `content`

For **`search.symbol`** and **`search.usage`**, successful handlers attach **`content`** with parallel arrays **`file_paths`**, **`lines`**, and **`end_lines`** (one entry per unique file in result order) so later steps can bind targeted reads without re-parsing the formatted blob. **`search.code`** uses the same shape. Implementation: [`query.ts`](../atls-studio/src/services/batch/handlers/query.ts).

## Execution Policy

The optional `policy` field on the batch request controls execution behavior:

```typescript
interface ExecutionPolicy {
  mode?: 'readonly' | 'mutable' | 'safe-mutable';  // Gating mode; normalized by chat-layer policy
  verify_after_change?: boolean;                   // Auto-inject verify.build after change.* steps
  auto_stage_refs?: boolean;                       // Auto-stage refs from results
  rollback_on_failure?: boolean;                   // Auto-rollback on change.* failure
  max_steps?: number;                              // Hard cap on steps (ceiling MAX_BATCH_POLICY_STEPS=100)
  stop_on_verify_failure?: boolean;                // Halt batch on verify failure
  refactor_validation_mode?: 'strict';             // Flags edits adding extends/implements/#include/using
  auto_reread_after_mutation?: boolean;            // Re-record snapshot hashes after change steps (default true)
  compact_context_on_verify_success?: boolean;     // Compact non-pinned context after passing static verify
}
```

`mode` is enforced by `isStepAllowed` in [`policy.ts`](../atls-studio/src/services/batch/policy.ts): `readonly` blocks all mutating ops; `mutable` (default) and `safe-mutable` allow them. The chat layer's `normalizeBatchPolicyForExecution` forces `readonly` in ask mode and `mutable` elsewhere — the model-supplied `mode` is advisory. `max_steps` is clamped to `[1, MAX_BATCH_POLICY_STEPS=100]`.

## Execution Flow

### 1. Validation

`validateBatchSteps` checks all steps upfront — valid `use` strings, well-formed params. On failure, the **entire batch returns early** with an error result; no steps execute.

### 2. Intent expansion and lookahead

`resolveIntents()` expands `intent.*` steps into primitive sequences. The expansion also produces **lookahead steps** — speculative reads for likely next targets. Lookahead is only appended when `isPressured()` returns false; under token pressure it is dropped.

### 3. Snapshot seeding

A fresh `SnapshotTracker` is initialized and seeded from the persistent awareness cache (`getAwarenessCache()`). Every previously read file's hash and line ranges carry forward, so edits can target files read in prior batches without re-reading.

### 4. Step loop (sequential)

**a. Enforcement gates** — evaluated in order; first failure skips or halts:

| Gate | Condition | Effect |
|------|-----------|--------|
| **`max_steps`** | `policy.max_steps` exceeded | Halt batch |
| **Swarm restriction** | `isBlockedForSwarm(step.use)` — blocks `session.plan`/`session.advance` for swarm sub-agents | Skip |
| **Policy mode** | `isStepAllowed` — blocks mutating ops when `mode === 'readonly'` | Skip |
| **File claims** | `change.*` targeting file outside agent's `fileClaims` | Reject (`file_claim_violation`) |

**b. Condition evaluation** — `evaluateCondition(step.if, stepOutputs)`:

| Form | Evaluates |
|------|-----------|
| `step_ok` | Prior step succeeded |
| `step_has_refs` | Prior step produced non-empty refs |
| `ref_exists` | A given `h:` hash prefix appears in any prior step's refs |
| `not` | Negation of inner expression |
| `all_steps_ok` | Conjunction over a named list of step IDs |
| `or` | Disjunction over a list of condition expressions |

**c. Binding resolution** — `resolveInBindings` resolves `in` references from prior step outputs and named bindings, then merges with `with` params.

**d. Snapshot injection** — before `change.*` steps, `injectSnapshotHashes` adds `snapshot_hash` from the tracker for:
- Single-file edits (`file` / `file_path`)
- Per-entry `line_edits` array items with file paths
- `creates` entries (overwrite detection)
- `restore` entries in rollback steps

The Rust backend verifies each hash — stale files are rejected with `stale_hash`.

**e. Intra-step line rebase** — all `line_edits` in a single `change.edit` use **snapshot (pre-edit) coordinates**: the line numbers as they appear in the file *before any edit in the step applies*. `rebaseIntraStepSnapshotLineEdits` converts these to sequential coordinates for the Rust backend by computing cumulative positional deltas. The model never manually computes shifted line numbers within a step.

**f. Read-range edit gate** — the executor checks that targeted lines fall within ranges previously read (tracked by `SnapshotTracker`). Edits outside read ranges are rejected with `edit_outside_read_range`. `registerOwnWrite` exempts lines the agent wrote in the current batch, closing the TOCTOU gap for edit-then-re-edit patterns.

**g. Handler dispatch** — operation dispatched via `opMap`. Own-writes are pre-registered before dispatch so re-edits pass the read-range gate.

**h. Post-step processing:**

| Phase | What happens |
|-------|-------------|
| **Snapshot tracking** | `recordSnapshotFromOutput` updates the tracker with new file hashes and line ranges from read/edit results. |
| **Cross-step rebase** | `rebaseSubsequentSteps` adjusts line numbers in all later steps targeting the same file by the net line delta. |
| **Context refresh** | `refreshContextAfterEdit` re-reads edited files, installs fresh engrams, and triggers hash forwarding (old engram compacted, new one pinned). |
| **Impact auto-stage** | `runImpactAutoStage` identifies affected symbols and stages impacted file ranges for the model's next turn. |
| **Auto-stage on repeat reads** | After ≥2 reads of the same file in one batch, the executor injects a `${stepId}__auto_stage_repeat` step to stage the file for the next round — even when `policy.auto_stage_refs` is false (see [`executor.ts`](../atls-studio/src/services/batch/executor.ts) ~1849). |
| **Verify artifacts** | `buildVerifyArtifact` collects all edited files and current hashes for verify handlers. |
| **Workspace inference** | `inferWorkspaceFromPaths` derives workspace for `verify.*` steps without an explicit workspace. |
| **Spin detection** | Dry-run preview counting, `spinBreaker` pattern tracking. |
| **Named outputs** | Steps with `out` register their output for later `{bind: "$name"}` references. |

**i. Error handling / interruption** — certain results halt the batch (see below). `on_error` per step controls continue/stop/rollback.

### 5. Post-execution

Collects all refs, verify results, and BB refs. Returns `UnifiedBatchResult` with per-step results, overall ok status, and timing.

## `line_edits` Coordinate Model

### Intra-step (within one `change.edit`)

All `line_edits` entries use **snapshot coordinates** — the line numbers from the file before any edit in the step. The executor converts these to sequential coordinates via `rebaseIntraStepSnapshotLineEdits`, computing cumulative positional deltas from each edit's net line change (inserts add lines, deletes remove them). The model always uses original file line numbers, even when multiple edits in the same step insert or delete lines.

### Cross-step (separate `change.edit` steps, same file)

`rebaseSubsequentSteps` runs after each completed edit and adjusts numeric line targets in all later steps for the same file. This uses `buildPerFileDeltaMap` to compute net deltas and `applyDeltasToLineEdits` to shift coordinates. Model-authored steps can use pre-batch coordinates.

### Spans, responses, and reads

- **Inclusive 1-based spans**: `line` and `end_line` are inclusive. Single-line: `end_line` equals `line`. `replace_body` resolves brace-delimited bodies (Rust) and reports in `edits_resolved`.
- **`replace_body` intra-step caveat**: because `replace_body` resolves at apply time on the backend, the executor cannot pre-compute its line delta for `rebaseIntraStepSnapshotLineEdits`. Use `replace_body` as the **sole `le` entry** in its step — mixing it with other numeric edits in the same step can produce incorrect downstream line shifts (see [`executor.ts`](../atls-studio/src/services/batch/executor.ts) ~184-192).
- **Chaining**: Successful edits return **`edits_resolved`** (per edit: resolved line, action, lines affected). Use these values for subsequent steps — not manual arithmetic.
- **Failures**: When exact apply fails but a fuzzy candidate exists, the response includes **`suggestion`** (line, confidence, tier, preview).
- **Reads**: **`read.lines`** requires **`start_line`** and **`end_line` together** for explicit line ranges (not `lines` / hash slice). See [`context.ts`](../atls-studio/src/services/batch/handlers/context.ts).

### `q` line directives

The line-per-step `q` parser in [`toon.ts`](../atls-studio/src/utils/toon.ts) `parseBatchLines` recognizes a few non-step directives:

| Prefix | Meaning |
|--------|---------|
| `#` | Comment; ignored |
| `--` | Comment; ignored |
| `@policy ` | Policy directive; currently skipped (reserved for future inline policy override) |

All other lines are tokenized as steps.

## Intent System

Intents are macros expanded to primitive steps before the main loop. The executor never dispatches `intent.*` directly.

### Expansion and Lookahead

`resolveIntents()` returns two arrays:
- **`expanded`**: Primitive steps that replace the intent (always appended).
- **`lookahead`**: Speculative steps (e.g. reading a related file). Only appended when `isPressured()` returns false — under token pressure, lookahead is dropped to conserve context.

### Example: `intent.edit`

Expands to:

1. `read.context` (skip if file already read/staged)
2. `change.edit` (the actual edit)
3. `read.lines` (conditional: only if edit fails — retry read)
4. `change.edit` (conditional: retry with fresh content)
5. `verify.build` (optional, if `verify: true`)

The retry pair uses conditions:

```json
{"id": "retry_read", "use": "read.lines", "if": {"not": {"step_ok": "edit1"}}},
{"id": "retry_edit", "use": "change.edit", "if": {"not": {"step_ok": "edit1"}}}
```

### Intent Properties

- **Skip satisfied steps**: Staged files skip re-read, pinned files skip re-pin, BB-cached results skip re-search
- **Composable**: `intent.understand` + `intent.edit` in one batch — edit reuses understand's refs via `from_step`
- **Force override**: `force: true` bypasses all state checks and emits all steps
- **Read-only intents**: `intent.diagnose` and `intent.test` prepare context but never mutate

## Error Recovery

### Per-Step: `on_error`

| Value | Behavior |
|-------|----------|
| `continue` (default) | Log error, proceed to next step |
| `stop` | Halt batch, return results so far |
| `rollback` | Inject `change.rollback` step with prior change's restore data |

### Handler-Level Retry

The change handler detects specific failure classes and retries:

| Error | Recovery |
|-------|----------|
| `stale_hash` | Refresh content hashes, re-attempt edit |
| `anchor_not_found` | Refresh, re-resolve anchors |
| `range_drifted` | Refresh exact-span targets |
| `span_out_of_range` | Refresh line numbers |

### Batch Interruption

Certain step results halt the batch for model decision:

| State | Meaning |
|-------|----------|
| `preview` | Dry-run result, model must confirm |
| `paused` | Operation paused on error |
| `rollback` | Rollback occurred, model must decide next |
| `action_required` | Manual intervention needed |
| `confirm-needed` | Destructive operation, awaiting confirmation |

## Concurrency

Within a batch, steps execute **sequentially** (dataflow dependencies require it). At the AI tool-loop level, up to 3 batch tool calls can execute in parallel (`MAX_CONCURRENT_TOOLS = 3`).

---
**Source**: [`executor.ts`](../atls-studio/src/services/batch/executor.ts), [`opMap.ts`](../atls-studio/src/services/batch/opMap.ts), [`types.ts`](../atls-studio/src/services/batch/types.ts), [`families.ts`](../atls-studio/src/services/batch/families.ts), [`handlers/query.ts`](../atls-studio/src/services/batch/handlers/query.ts), [`handlers/change.ts`](../atls-studio/src/services/batch/handlers/change.ts), [`handlers/system.ts`](../atls-studio/src/services/batch/handlers/system.ts), [`intents/`](../atls-studio/src/services/batch/intents/), [`opShorthand.ts`](../atls-studio/src/services/batch/opShorthand.ts), [`paramNorm.ts`](../atls-studio/src/services/batch/paramNorm.ts)
