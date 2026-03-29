/**
 * Shared logging for Vitest: JSON vs TOON (or related serializers) token deltas.
 * Uses the same `estimateTokens` heuristic as production token metrics.
 */
import { estimateTokens } from './contextHash';
import { formatResult, serializeForTokenEstimate, toTOON } from './toon';

export interface TokenDeltaResult {
  jsonChars: number;
  altChars: number;
  jsonTok: number;
  altTok: number;
  deltaTok: number;
  pctSaved: string;
}

/**
 * Log and return token delta between two serialized strings (e.g. JSON.stringify vs TOON).
 * `altLabel` names the second column (TOON, formatResult, serializeMessageContent, etc.).
 */
export function logTokenDelta(
  label: string,
  jsonSerialized: string,
  altSerialized: string,
  altLabel = 'TOON',
): TokenDeltaResult {
  const jsonTok = estimateTokens(jsonSerialized);
  const altTok = estimateTokens(altSerialized);
  const deltaTok = jsonTok - altTok;
  const pctSaved = jsonTok === 0 ? '0.0' : ((deltaTok / jsonTok) * 100).toFixed(1);

  console.log(
    `[TOON delta] ${label} | JSON: ${jsonSerialized.length} ch / ${jsonTok} tok | ${altLabel}: ${altSerialized.length} ch / ${altTok} tok | Δ ${deltaTok} tok (${pctSaved}%)`,
  );

  return {
    jsonChars: jsonSerialized.length,
    altChars: altSerialized.length,
    jsonTok,
    altTok,
    deltaTok,
    pctSaved,
  };
}

/** JSON.stringify(value) vs toTOON(value). */
export function logObjectJsonVsToon(label: string, value: unknown): TokenDeltaResult {
  return logTokenDelta(label, JSON.stringify(value), toTOON(value), 'toTOON');
}

/** JSON.stringify vs formatResult (compact + cap). */
export function logObjectJsonVsFormatResult(label: string, value: unknown): TokenDeltaResult {
  return logTokenDelta(label, JSON.stringify(value), formatResult(value), 'formatResult');
}

/** JSON.stringify vs serializeForTokenEstimate (history / metrics path). */
export function logObjectJsonVsSerializeForTokenEstimate(label: string, value: unknown): TokenDeltaResult {
  return logTokenDelta(label, JSON.stringify(value), serializeForTokenEstimate(value), 'serializeForTokenEstimate');
}
