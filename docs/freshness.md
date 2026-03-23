# Freshness System

The freshness system ensures the model never silently reasons about stale content. It tracks file revisions, detects when knowledge is outdated, blocks unsafe operations, and attempts automatic recovery when possible.

## Why Freshness Matters

Without freshness tracking, an agent that reads a file, edits it, then reasons about the pre-edit content will produce incorrect results — wrong line numbers, patches that don't apply, diffs based on content that no longer exists. This is the single most common failure mode in agentic coding tools.

ATLS addresses this at three levels:

1. **Snapshot tracking** — Record what was read and when
2. **Freshness classification** — Know whether knowledge is still valid
3. **Preflight gating** — Block operations on suspect content, recover rebaseable content

## Snapshot Tracker

During batch execution, the `SnapshotTracker` records the content hash of every file the model reads:

```typescript
interface SnapshotIdentity {
  filePath: string;
  snapshotHash: string;
  readAt: number;
  readKind: 'canonical' | 'shaped' | 'lines' | 'cached';
  readRegions?: LineRegion[];
  shapeHash?: string;
}
```

### Awareness Levels

| Level | Acquired By | Authorizes |
|-------|-------------|------------|
| **CANONICAL** (3) | `read.context(type: full)` | Full-file edits |
| **TARGETED** (2) | `read.lines` | Edits within the read range |
| **SHAPED** (1) | `read.shaped` | Structural awareness only (no edits) |
| **NONE** (0) | — | Nothing |

Awareness never downgrades — a canonical read is not overwritten by a subsequent shaped read.

### Automatic Hash Injection

Before any `change.*` step, the executor injects `snapshot_hash` from the tracker. The Rust backend verifies this against the current file. If the file has changed, the edit is rejected with `stale_hash` rather than silently applying a bad patch.

After a successful mutation, `invalidateAndRerecord` clears the old snapshot and records the post-edit hash, so subsequent steps see fresh state.

## Freshness States

Each engram carries a freshness classification:

| State | Meaning | Source |
|-------|---------|--------|
| **fresh** | Content matches current file state | Initial read, reconciliation |
| **forwarded** | Hash updated after own edit (known lineage) | `forwardStagedHash` after edit |
| **shifted** | Same file edited in a prior step; line numbers may have moved | `reconcileSourceRevision` with `same_file_prior_edit` |
| **changed** | External change detected | Watcher event, manual trigger |
| **suspect** | Freshness uncertain | Unknown cause, timing gap |

### Freshness Causes

| Cause | Classification | Recovery |
|-------|---------------|----------|
| `hash_forward` | Rebaseable | Relocate lines via edit journal |
| `same_file_prior_edit` | Rebaseable | Relocate via journal/shape/symbol |
| `external_file_change` | Suspect | Hard stop, re-read required |
| `watcher_event` | Suspect | Hard stop, re-read required |
| `unknown` | Suspect | Hard stop, re-read required |

## Freshness Preflight

Before any mutation operation, the preflight system classifies every target. For file-backed targets it first runs a **batched** `context` request with `{ type: 'full', file_paths }` so the backend returns current content and hashes for those paths. It then calls **`refreshRoundEnd`** for the same file set (with per-path revisions derived from that result) so the context store’s `sourceRevision` metadata matches disk before relocation and gating run. Classification then proceeds:

```
Fresh          → PROCEED (no action needed)
Rebaseable     → ATTEMPT RELOCATION → if success: PROCEED, if fail: BLOCK
Suspect        → BLOCK (require re-read)
```

### Rebase Strategy Cascade

When an engram is rebaseable (from own prior edit or hash forward), the system attempts recovery through progressively less confident strategies:

| Strategy | Confidence | Method |
|----------|-----------|--------|
| **edit_journal** | High | Use recorded `lineDelta` from prior edits to shift line references |
| **shape_match** | High | Compare structural hash — if identical, content is equivalent |
| **symbol_identity** | Medium | Resolve symbol name to its current line range |
| **fingerprint_match** | Medium | Locate content snippet by fuzzy matching |
| **line_relocation** | Medium/High | Search for content in a window around expected position |
| **blocked** | None | Identity lost — cannot locate content, block the operation |

### Rebase Evidence

Each recovery records its evidence:

```typescript
interface RebindOutcome {
  classification: 'fresh' | 'rebaseable' | 'suspect';
  strategy: RebaseStrategy;
  confidence: 'high' | 'medium' | 'low' | 'none';
  factors: RebaseEvidence[];
  linesBefore?: string;
  linesAfter?: string;
  sourceRevision?: string;
  observedRevision?: string;
}
```

Evidence factors include: `revision_match`, `journal_line_delta`, `shape_hash_match`, `shape_hash_mismatch`, `symbol_identity`, `fingerprint_unique`, `content_window_match`, `exact_line_match`, `missing_content`, `identity_lost`.

This data is attached to the engram and available for the model to reason about — it can see the confidence level of its own knowledge.

## Reconciliation

When files change, `reconcileSourceRevision` sweeps all memory regions:

| Chunk State | Action |
|-------------|--------|
| Active latest (non-compacted) | Update `sourceRevision` to current |
| Snapshot (`viewKind: 'snapshot'`) | Preserve regardless (intentionally frozen) |
| Derived with stale revision | Evict from chunks and archive |
| Dormant (compacted, unpinned, stale) | Archive if >1000 tokens, drop if smaller |
| Staged (non-snapshot, non-derived) | Update revision metadata |
| Staged derived with stale revision | Delete from staged |

### Reconciliation Triggers

| Trigger | Source |
|---------|--------|
| File read | `context.ts` handler calls `reconcileSourceRevision` after read |
| Edit completion | `executor.ts` calls `forwardStagedHash` after successful edit |
| Round end | `refreshRoundEnd` sweeps file-backed **working** and **archived** chunks and **staged snippets** (latest view) against current revisions — see below |
| File watcher | External changes trigger `markEngramsSuspect` |

### Round-end revision sweep (`refreshRoundEnd`)

`refreshRoundEnd` gathers normalized source paths from every **latest** file-backed engram in working memory and **archived** chunks, plus **staged snippet** sources (skipping `viewKind: 'snapshot'`). It resolves **current** content hashes for those paths in bulk via the Tauri command **`get_current_revisions`** (registered at app startup from [`useAtls.ts`](../atls-studio/src/hooks/useAtls.ts) as `setBulkRevisionResolver` — one IPC round-trip for the whole path set). For each path it calls **`reconcileSourceRevision`**. Paths that cannot be resolved are passed to **`markEngramsSuspect`**.

The hash-protocol **`advanceTurn`** hook invokes `refreshRoundEnd` (via [`aiService.ts`](../atls-studio/src/services/aiService.ts) `setRoundRefreshHook`). In the main chat tool loop, **`advanceTurn` runs only when `round > 0`**, so the **first** round of a user turn does **not** run this sweep before the model step; reconciliation for restored sessions is therefore **deferred** until the next round boundary, preflight, or other triggers (see [session-persistence.md](./session-persistence.md)).

Other call sites: **`refreshRoundEnd()`** with no path filter after intelligence refresh ([`useAtls.ts`](../atls-studio/src/hooks/useAtls.ts)), and **preflight** with explicit paths after a `context` full pass ([`freshnessPreflight.ts`](../atls-studio/src/services/freshnessPreflight.ts)).

## Recent Revision Tracking

The system tracks recent edits via `recordRevisionAdvance` with a 10-second TTL:

```typescript
const recentRevisionAdvances = new Map<string, {
  cause: FreshnessCause;
  sessionId?: string;
  at: number;
}>();
```

When `reconcileSourceRevision` runs, it consumes this record to determine whether the change was from the model's own edit (`same_file_prior_edit`) or external (`external_file_change`). Own edits are rebaseable; external changes are suspect.

---

## Sequential `line_edits` (Top-Down Application)

`apply_line_edits` in the Rust backend applies edits **in array order**. Each edit resolves its `line` / `anchor` against the *current* file content **after all prior edits in the same array**.

- **Why**: Models reason sequentially (“insert at L10, then L50 is now L53”). The old bottom-up / snapshot-resolved-all-lines model fought that mental model and could target wrong lines.
- **Prompts**: `src/prompts/toolRef.ts` and `src/prompts/cognitiveCore.ts` document sequential semantics for the model.
- **Validation**: The TS `change.edit` path no longer sorts, merges, or rejects “overlapping” explicit line edits — those heuristics assumed a single coordinate frame. Overlaps in *original* line numbers can be valid when edits are sequential.

---

## Cross-Step Line Rebase (Batch Executor)

When a batch contains **multiple steps** that edit the same file with **numeric** `line` fields, the model typically authored later steps against the **pre-batch** file. After step *N* runs, line numbers in steps *N+1…* must be shifted by the net effect of completed edits.

- **`computePositionalDeltas`** (`executor.ts`): Walks `line_edits` in order, tracks a **running cumulative line delta**, and records each edit’s effect at its **original-file** line (`originalLine = sequentialLine - cumulativeDelta` before applying that edit’s delta). This produces a list `{ line, delta }` in original coordinates.
- **`rebaseSubsequentSteps`**: For each future `change.*` step on the same file, adds to each explicit `line` the sum of `delta` where `d.line < targetLine` (same “BUG5” rule as before).

Anchor/symbol edits (`line <= 0`) are skipped — they resolve at apply time on the backend.

---

## Post-Edit Context Refresh (`refreshContextAfterEdit`)

After a successful `change.*`, the executor keeps the UI / next-round context aligned with disk:

1. **Full-file engrams**: Resolve `h:NEW` via `batch_resolve_hash_refs` and `addChunk` with `origin: 'edit-refresh'`.
2. **Staged snippets**:
   - **Shaped**: Re-resolve `h:NEW:{shapeSpec}`.
   - **Line-range**: `getFreshnessJournal` → `lineDelta` → `applyLineDelta` on the line spec, then `resolve_hash_ref` with `h:NEW:lines`.
   - **Full-file staged** (no lines/shape): Resolve `h:NEW` only.

**Order**: `registerOwnWrite` and **synchronous** `rebaseStagedLineNumbers` (from journal) run **before** the async `refreshContextAfterEdit` so the next model sees correct line refs.

---

## Own-Write Suppression (`intel:file_change`)

Successful edits register paths as **own writes** so the file watcher does not emit spurious `intel:file_change` events for ATLS’s own writes. That avoids false “external change” / suspect freshness and races with git restore (external writes still flow normally).

---

## Source Files (Quick Reference)

| Concern | Primary files |
|--------|----------------|
| Snapshot tracking + injection | [`snapshotTracker.ts`](../atls-studio/src/services/batch/snapshotTracker.ts), [`executor.ts`](../atls-studio/src/services/batch/executor.ts) |
| `line_edits` apply (Rust) | [`lib.rs`](../atls-studio/src-tauri/src/lib.rs) (`apply_line_edits`) |
| `line_edits` dispatch (no TS overlap/coalesce) | [`change.ts`](../atls-studio/src/services/batch/handlers/change.ts) |
| Cross-step rebase | [`executor.ts`](../atls-studio/src/services/batch/executor.ts) (`computePositionalDeltas`, `rebaseSubsequentSteps`) |
| Post-edit refresh + staged rebase | [`executor.ts`](../atls-studio/src/services/batch/executor.ts) (`refreshContextAfterEdit`, `rebaseStagedLineNumbers` hook) |
| Freshness preflight / journal | [`freshnessPreflight.ts`](../atls-studio/src/services/freshnessPreflight.ts), [`freshnessJournal.ts`](../atls-studio/src/services/freshnessJournal.ts) |
| Round-end sweep + bulk revisions | [`contextStore.ts`](../atls-studio/src/stores/contextStore.ts) (`refreshRoundEnd`), [`useAtls.ts`](../atls-studio/src/hooks/useAtls.ts) (`setBulkRevisionResolver` → `get_current_revisions`) |
| Reconciliation | [`contextStore.ts`](../atls-studio/src/stores/contextStore.ts) |

---

**Source**: [`snapshotTracker.ts`](../atls-studio/src/services/batch/snapshotTracker.ts), [`freshnessPreflight.ts`](../atls-studio/src/services/freshnessPreflight.ts), [`freshnessJournal.ts`](../atls-studio/src/services/freshnessJournal.ts), [`contextStore.ts`](../atls-studio/src/stores/contextStore.ts) (reconciliation)
