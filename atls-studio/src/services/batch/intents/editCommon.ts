/**
 * Shared constants for the edit-intent family (intent.edit, intent.edit_multi).
 *
 * RECOVERABLE_EDIT_ERROR_CLASSES — error classes the executor may emit from a
 * failed change.edit step that are worth retrying after a fresh re-read of
 * the target range. Excludes unrecoverable classes (schema_violation,
 * permission_denied, content_too_large, malformed payloads) for which a
 * retry burns cost on a guaranteed-failing second attempt.
 *
 * Used in `if: { step_error_class_in: { step_id, classes } }` conditions on
 * the conditional retry steps emitted by the edit intents.
 */
export const RECOVERABLE_EDIT_ERROR_CLASSES = [
  'anchor_not_found',
  'stale_hash',
  'range_drifted',
  'mixed',
  'span_out_of_range',
  'anchor_mismatch_after_refresh',
] as const;
