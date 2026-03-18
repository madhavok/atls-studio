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

Before any mutation operation, the preflight system classifies every target:

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
| Round end | `refreshRoundEnd` sweeps all file-backed chunks against current revisions |
| File watcher | External changes trigger `markEngramsSuspect` |

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

**Source**: [`snapshotTracker.ts`](../atls-studio/src/services/batch/snapshotTracker.ts), [`freshnessPreflight.ts`](../atls-studio/src/services/freshnessPreflight.ts), [`freshnessJournal.ts`](../atls-studio/src/services/freshnessJournal.ts), [`contextStore.ts`](../atls-studio/src/stores/contextStore.ts) (reconciliation)
