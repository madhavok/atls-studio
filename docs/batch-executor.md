# Batch Executor

All model-initiated actions flow through a single tool: `batch()`. This collapses the traditional multi-tool surface into a structured execution plan with step-to-step dataflow, conditional execution, intent macros, and multi-level error recovery.

## Tool Surface

```json
{
  "version": "1.0",
  "goal": "read auth module, fix the bug, verify",
  "steps": [
    {"id": "r1", "use": "read.context", "with": {"type": "smart", "file_paths": ["src/auth.ts"]}},
    {"id": "e1", "use": "change.edit", "with": {"file_path": "src/auth.ts", "line_edits": [...]}, "if": {"step_ok": "r1"}},
    {"id": "v1", "use": "verify.typecheck", "if": {"step_ok": "e1"}}
  ],
  "policy": {"verify_after_change": true}
}
```

### Step Structure

```typescript
interface Step {
  id: string;
  use: OperationKind;          // e.g. "read.context", "change.edit"
  with?: Record<string, unknown>; // Parameters
  in?: Record<string, RefExpr>;   // Dataflow bindings from other steps
  out?: string | string[];        // Named binding output
  if?: ConditionExpr;             // Conditional execution
  on_error?: 'stop' | 'continue' | 'rollback';
}
```

## Operation Families

The authoritative list of `use` strings is [`atls-studio/src/services/batch/families.ts`](../atls-studio/src/services/batch/families.ts) (`OPERATION_FAMILIES`); the batch tool reference builds its “Operation Families” block from that file. The table below summarizes the same surface.

| Family | Operations | Purpose |
|--------|-----------|---------|
| **discover** | `search.code`, `search.symbol`, `search.usage`, `search.similar`, `search.issues`, `search.patterns`, `search.memory` | Find code by query, symbol, pattern, or in-memory regions |
| **understand** | `read.context`, `read.shaped`, `read.lines`, `read.file`, `analyze.deps`, `analyze.calls`, `analyze.structure`, `analyze.impact`, `analyze.blast_radius`, `analyze.extract_plan` | Load and comprehend code |
| **change** | `change.edit`, `change.create`, `change.delete`, `change.refactor`, `change.rollback`, `change.split_module` | Modify code with preimage verification |
| **verify** | `verify.build`, `verify.test`, `verify.lint`, `verify.typecheck` | Validate changes against toolchain |
| **session** | `session.plan`, `session.advance`, `session.status`, `session.pin`, `session.unpin`, `session.compact`, `session.unload`, `session.drop`, `session.recall`, `session.stage`, `session.unstage`, `session.bb.write`, `session.bb.read`, `session.bb.delete`, `session.bb.list`, `session.rule`, `session.compact_history`, `session.stats`, `session.debug`, `session.emit`, `session.shape`, `session.load` | Manage memory, tasks, and session state |
| **annotate** | `annotate.engram`, `annotate.note`, `annotate.link`, `annotate.retype`, `annotate.split`, `annotate.merge`, `annotate.design` | Annotate, connect, and restructure engrams |
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

### `session.plan` and `session.advance`

- **`session.advance`** only works when a task plan is active. Call **`session.plan`** first (or use another step that establishes the plan). Otherwise you will see: `task_advance: ERROR no active plan — call session.plan first`.

### `session.pin` and `from_step`

- **`session.pin`** needs a non-empty **`hashes`** (or **`refs`**) array after bindings resolve.
- If you wire `in.hashes` from a prior step (e.g. `{ "from_step": "r1", "path": "refs" }`) and that step **failed** or produced **no `refs`**, pin will error with `missing hashes param`. Use conditions (`if: { step_has_refs: "r1" }`) or a fallback step so pin does not run on empty output.

### Freshness: `search.issues` / `search.patterns` (`stale_policy`)

- Tool calls that map to `find_issues` / `detect_patterns` may pass **`"stale_policy": "refresh_first"`** (client-side). When set, if the first freshness preflight blocks, the client runs an extra **`refreshRoundEnd`** for the request’s `file_paths` and retries preflight once before failing. This is optional; default remains strict.

### Discover steps: structured `content` (`file_paths` / `lines` / `end_lines`)

For **`search.symbol`** and **`search.usage`**, successful handlers attach **`content`** with parallel arrays **`file_paths`**, **`lines`**, and **`end_lines`** (one entry per unique file in result order) so later steps can bind targeted reads without re-parsing the formatted blob. **`search.code`** uses the same shape when it emits path/line metadata. Implementation: [`query.ts`](../atls-studio/src/services/batch/handlers/query.ts).

### Binding Types

| Type | Syntax | Resolves To |
|------|--------|-------------|
| **Step output** | `{from_step: "s1", path: "refs.0"}` | Output of step `s1`, dot-path navigated |
| **Literal ref** | `{ref: "h:a1b2c3"}` | Hash reference passthrough |
| **Named binding** | `{bind: "$name"}` | Output of a step with `out: "$name"` |
| **Literal value** | `{value: 123}` | Direct value |

### Conditions

```json
{"if": {"step_ok": "s1"}}           // Run only if s1 succeeded
{"if": {"step_has_refs": "s1"}}     // Run only if s1 produced refs
{"if": {"not": {"step_ok": "s1"}}}  // Run only if s1 FAILED (for retry logic)
```

## Execution Flow

1. **Intent expansion**: `intent.*` steps are expanded into primitive steps via `resolveIntents()`
2. **Snapshot seeding**: `SnapshotTracker` initialized from awareness cache
3. **Step loop** (sequential):
   - Evaluate condition (`if`) — skip if false
   - Resolve `in` bindings from prior step outputs
   - Merge `with` params + resolved bindings
   - Inject `snapshot_hash` for `change.*` steps (from tracker)
   - Dispatch to handler via `opMap`
   - Record output, update snapshot tracker
   - Handle `on_error` / interruption
4. **Post-execution**: Forward staged hashes, record tool calls

### Snapshot Injection

Before any `change.*` step, the executor injects `snapshot_hash` from the `SnapshotTracker`:

```typescript
function injectSnapshotHashes(params, tracker) {
  const targetFile = params.file ?? params.file_path;
  if (targetFile && !params.snapshot_hash) {
    const trackedHash = tracker.getHash(targetFile);
    if (trackedHash) params.snapshot_hash = trackedHash;
  }
}
```

The Rust backend verifies this hash against the current file — if the file changed, the edit is rejected with `stale_hash`.

### `line_edits` order and multi-step batches

- **Within one `change.edit`**: `line_edits` apply **sequentially in array order** (top-down). Each edit’s `line` / `anchor` targets the file **after** prior edits in the same array. See **Sequential `line_edits`** in [freshness.md](./freshness.md).
- **Across steps**: If a later step edits the same file with numeric `line` values, the executor **rebases** those lines using cumulative deltas from the completed step (model-authored steps usually assume pre-batch coordinates). See **Cross-step line rebase** in [freshness.md](./freshness.md).

### `line_edits` spans, responses, and paired reads

- **Inclusive 1-based spans**: Each edit uses **`line`** and **`end_line`** as **inclusive** line numbers. A single-line edit sets `end_line` equal to `line` (omitting `end_line` may default to `line` where the schema allows). Multi-line replace/delete/move spans use both ends; `replace_body` resolves a brace-delimited body in Rust and reports what was applied in **`edits_resolved`**.
- **Chaining**: Successful edits return **`edits_resolved`** (per edit: resolved line, action, lines affected). Use these values for the next step instead of manual line math. Model-facing summaries also live in [`toolRef.ts`](../atls-studio/src/prompts/toolRef.ts) and [`editDiscipline.ts`](../atls-studio/src/prompts/editDiscipline.ts).
- **Failures**: When an exact apply fails but a fuzzy candidate exists, the response may include a **`suggestion`** (line, confidence, tier, preview) for recovery.
- **Reads**: **`read.lines`** requires **`start_line`** and **`end_line` together** when using explicit line ranges (not `lines` / hash slice). See [`context.ts`](../atls-studio/src/services/batch/handlers/context.ts).

## Intent System

Intents are macros that expand to primitive steps before the main loop. The executor never dispatches `intent.*` directly.

### Example: `intent.edit`

Expands to:

1. `read.context` (skip if file already read/staged)
2. `change.edit` (the actual edit)
3. `read.lines` (conditional: only if edit fails)
4. `change.edit` (conditional: retry with fresh content)
5. `verify.typecheck` (optional, if `verify: true`)

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
|-------|---------|
| `preview` | Dry-run result, model must confirm |
| `paused` | Operation paused on error |
| `rollback` | Rollback occurred, model must decide next |
| `action_required` | Manual intervention needed |
| `confirm-needed` | Destructive operation, awaiting confirmation |

## Concurrency

Within a batch, steps execute **sequentially** (dataflow dependencies require it). At the AI tool-loop level, up to 3 batch tool calls can execute in parallel (`MAX_CONCURRENT_TOOLS = 3`).

---

**Source**: [`executor.ts`](../atls-studio/src/services/batch/executor.ts), [`opMap.ts`](../atls-studio/src/services/batch/opMap.ts), [`types.ts`](../atls-studio/src/services/batch/types.ts), [`handlers/query.ts`](../atls-studio/src/services/batch/handlers/query.ts), [`handlers/change.ts`](../atls-studio/src/services/batch/handlers/change.ts), [`intents/`](../atls-studio/src/services/batch/intents/)
