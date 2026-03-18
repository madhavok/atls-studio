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
  "policy": {"mode": "safe-mutable", "verify_after_change": true}
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

| Family | Operations | Purpose |
|--------|-----------|---------|
| **discover** | `search.code`, `search.symbol`, `search.usage`, `search.similar`, `search.issues`, `search.patterns` | Find code by query, symbol, pattern |
| **understand** | `read.context`, `read.shaped`, `read.lines`, `read.file`, `analyze.deps`, `analyze.calls`, `analyze.structure`, `analyze.impact`, `analyze.blast_radius`, `analyze.extract_plan` | Load and comprehend code |
| **change** | `change.edit`, `change.create`, `change.delete`, `change.refactor`, `change.rollback`, `change.split_match`, `change.split_module` | Modify code with preimage verification |
| **verify** | `verify.build`, `verify.test`, `verify.lint`, `verify.typecheck` | Validate changes against toolchain |
| **session** | `session.plan`, `session.advance`, `session.status`, `session.pin`, `session.unpin`, `session.compact`, `session.unload`, `session.drop`, `session.recall`, `session.stage`, `session.unstage`, `session.bb.write`, `session.bb.read`, `session.bb.delete`, `session.bb.list`, `session.rule`, `session.compact_history`, `session.stats`, `session.emit`, `session.shape`, `session.load` | Manage memory, tasks, and session state |
| **annotate** | `annotate.engram`, `annotate.note`, `annotate.link`, `annotate.retype`, `annotate.split`, `annotate.merge`, `annotate.design` | Annotate, connect, and restructure engrams |
| **delegate** | `delegate.retrieve`, `delegate.design` | Dispatch cheaper sub-models for research |
| **intent** | `intent.understand`, `intent.edit`, `intent.edit_multi`, `intent.investigate`, `intent.diagnose`, `intent.survey`, `intent.refactor`, `intent.create`, `intent.test`, `intent.search_replace`, `intent.extract` | Macro operations that expand to primitives |
| **system** | `system.exec`, `system.git`, `system.workspaces`, `system.help` | Shell execution, git operations, workspace management |

## Dataflow

Steps wire outputs to subsequent step inputs through binding expressions:

```json
{"id": "r1", "use": "read.context", "with": {"file_paths": ["src/api.ts"]}},
{"id": "p1", "use": "session.pin", "in": {"hashes": {"from_step": "r1", "path": "refs"}}}
```

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

**Source**: [`executor.ts`](../atls-studio/src/services/batch/executor.ts), [`opMap.ts`](../atls-studio/src/services/batch/opMap.ts), [`types.ts`](../atls-studio/src/services/batch/types.ts), [`intents/`](../atls-studio/src/services/batch/intents/)
