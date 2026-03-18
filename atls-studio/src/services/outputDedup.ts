/**
 * Output Deduplication Post-Processor
 *
 * Safety net: after each model response, scans output text for verbatim code
 * blocks that match content in the hash registry. If a code block is >=80%
 * similar to a registry entry (by line overlap), replaces it with the
 * corresponding h:ref in the stored conversation history.
 *
 * This compresses output before it enters history, preventing token bloat on
 * subsequent turns. The model should use h:refs by instruction, but when it
 * doesn't, this catches it.
 */

import { useContextStore } from '../stores/contextStore';
import { estimateTokens } from '../utils/contextHash';

const CODE_BLOCK_RE = /```[\w]*\n([\s\S]*?)```/g;
const MIN_LINES_FOR_DEDUP = 4;
const SIMILARITY_THRESHOLD = 0.8;

export interface DedupResult {
  text: string;
  refsInserted: number;
  tokensSaved: number;
}

/**
 * Scan model output for verbatim code blocks matching registry content.
 * Returns modified text with h:refs replacing matched blocks, plus stats.
 */
export function deduplicateOutput(text: string): DedupResult {
  let refsInserted = 0;
  let tokensSaved = 0;

  const contextStore = useContextStore.getState();
  const chunks = contextStore.chunks;

  if (chunks.size === 0) return { text, refsInserted, tokensSaved };

  // Build a line-set index from all context chunks for fast lookup
  const chunkIndex = buildChunkIndex(chunks);

  const result = text.replace(CODE_BLOCK_RE, (fullMatch, codeContent: string) => {
    const codeLines = codeContent.trim().split('\n');
    if (codeLines.length < MIN_LINES_FOR_DEDUP) return fullMatch;

    // Try to find a matching chunk
    const match = findMatchingChunk(codeLines, chunkIndex);
    if (!match) return fullMatch;

    const { shortHash, source, lineRange } = match;
    const originalTokens = estimateTokens(codeContent);
    const refStr = lineRange
      ? `h:${shortHash}:${lineRange}`
      : `h:${shortHash}`;
    const label = source ? `[${source}]` : '';

    refsInserted++;
    tokensSaved += originalTokens - estimateTokens(refStr);

    return `\`${refStr}\`${label}`;
  });

  return { text: result, refsInserted, tokensSaved };
}

interface ChunkIndexEntry {
  shortHash: string;
  source: string | undefined;
  lines: string[];
  lineSet: Set<string>;
}

function buildChunkIndex(
  chunks: Map<string, { shortHash: string; source?: string; content: string }>
): ChunkIndexEntry[] {
  const index: ChunkIndexEntry[] = [];
  for (const [, chunk] of chunks) {
    const lines = chunk.content.split('\n');
    if (lines.length < MIN_LINES_FOR_DEDUP) continue;
    const lineSet = new Set(lines.map(l => l.trim()).filter(l => l.length > 0));
    index.push({
      shortHash: chunk.shortHash,
      source: chunk.source,
      lines,
      lineSet,
    });
  }
  return index;
}

function findMatchingChunk(
  codeLines: string[],
  index: ChunkIndexEntry[]
): { shortHash: string; source: string | undefined; lineRange: string | null } | null {
  const trimmedCode = codeLines.map(l => l.trim()).filter(l => l.length > 0);
  if (trimmedCode.length < MIN_LINES_FOR_DEDUP) return null;

  for (const entry of index) {
    // Quick check: how many lines overlap?
    let matchCount = 0;
    for (const line of trimmedCode) {
      if (entry.lineSet.has(line)) matchCount++;
    }

    const similarity = matchCount / trimmedCode.length;
    if (similarity < SIMILARITY_THRESHOLD) continue;

    // Find the matching line range in the chunk
    const lineRange = findLineRange(codeLines, entry.lines);
    return {
      shortHash: entry.shortHash,
      source: entry.source,
      lineRange,
    };
  }

  return null;
}

/**
 * Try to find the contiguous line range in `chunkLines` that matches `codeLines`.
 * Returns "start-end" or null if no contiguous match.
 */
function findLineRange(codeLines: string[], chunkLines: string[]): string | null {
  const firstCode = codeLines[0]?.trim();
  if (!firstCode) return null;

  for (let i = 0; i < chunkLines.length; i++) {
    if (chunkLines[i].trim() !== firstCode) continue;

    // Check if the remaining lines match
    let matches = true;
    const matchEnd = Math.min(codeLines.length, chunkLines.length - i);
    for (let j = 1; j < matchEnd; j++) {
      if (codeLines[j]?.trim() !== chunkLines[i + j]?.trim()) {
        matches = false;
        break;
      }
    }

    if (matches && matchEnd >= MIN_LINES_FOR_DEDUP) {
      const start = i + 1; // 1-indexed
      const end = i + matchEnd;
      if (start === 1 && end === chunkLines.length) return null; // full file, no need for range
      return `${start}-${end}`;
    }
  }

  return null;
}
