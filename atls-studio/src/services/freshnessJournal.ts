export type RebaseStrategy =
  | 'edit_journal'
  | 'shape_match'
  | 'symbol_identity'
  | 'fingerprint_match'
  | 'line_relocation'
  | 'content_match'
  | 'fresh'
  | 'blocked';
export type RebaseConfidence = 'high' | 'medium' | 'low' | 'none';
export type RebaseClassification = 'fresh' | 'rebaseable' | 'suspect';
export type RebaseEvidence =
  | 'revision_match'
  | 'journal_line_delta'
  | 'shape_hash_match'
  | 'shape_hash_mismatch'
  | 'symbol_identity'
  | 'fingerprint_unique'
  | 'content_window_match'
  | 'exact_line_match'
  | 'missing_content'
  | 'identity_lost'
  | 'suspect_content_verified'
  | 'suspect_promoted';

export interface RebindOutcome {
  classification: RebaseClassification;
  strategy: RebaseStrategy;
  confidence: RebaseConfidence;
  factors: RebaseEvidence[];
  linesBefore?: string;
  linesAfter?: string;
  sourceRevision?: string;
  observedRevision?: string;
  at: number;
}

export interface FreshnessJournalEntry {
  source: string;
  previousRevision?: string;
  currentRevision: string;
  lineDelta?: number;
  recordedAt: number;
}

const MAX_JOURNAL_ENTRIES = 128;
const journal = new Map<string, FreshnessJournalEntry>();

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

export function recordFreshnessJournal(entry: FreshnessJournalEntry): void {
  const key = normalizePath(entry.source);
  journal.set(key, entry);
  if (journal.size <= MAX_JOURNAL_ENTRIES) return;
  const oldestKey = journal.keys().next().value;
  if (oldestKey) journal.delete(oldestKey);
}

export function getFreshnessJournal(source: string): FreshnessJournalEntry | undefined {
  return journal.get(normalizePath(source));
}

export function clearFreshnessJournal(source?: string): void {
  if (!source) {
    journal.clear();
    return;
  }
  journal.delete(normalizePath(source));
}

export function serializeJournal(): Array<[string, FreshnessJournalEntry]> {
  return Array.from(journal.entries());
}

export function restoreJournal(entries: Array<[string, FreshnessJournalEntry]>): void {
  journal.clear();
  for (const [key, entry] of entries) {
    journal.set(key, entry);
  }
}
