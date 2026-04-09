/**
 * Pure helpers for classifying subagent batch tool output (idle vs progress).
 * Summaries come from batch handlers and/or formatBatchResult — keep markers aligned.
 */

function looksLikeToolError(content: string): boolean {
  const t = content.trimStart();
  return t.startsWith('ERROR') || /^Error:/i.test(t) || content.includes('BLOCKED');
}

/**
 * True when the round produced substantive work (pins, BB, edits, verify, exec, staging, etc.).
 */
export function subagentToolResultIndicatesProgress(content: string): boolean {
  const c = content;
  if (looksLikeToolError(c)) return false;

  if (
    c.includes('change.')
    || c.includes('session.pin')
    || c.includes('session.stage')
    || c.includes('session.bb.write')
    || c.includes('verify.')
    || c.includes('system.exec')
    || c.includes('analyze.')
  ) {
    return true;
  }

  if (c.includes('pin:') || c.includes('bb_write:')) return true;

  if (
    c.includes('staged [')
    || c.includes('staged lines:')
    || /:\s*staged\s/.test(c)
  ) {
    return true;
  }

  if (c.includes('[OK]') && /\bunstaged\b/.test(c)) return true;

  if (
    /\(change\./.test(c)
    || /\(verify\./.test(c)
    || /\(system\.exec\)/.test(c)
    || /\(session\.pin\)/.test(c)
    || /\(session\.stage\)/.test(c)
    || /\(session\.bb\.write\)/.test(c)
    || /\(analyze\./.test(c)
    || /\(read\./.test(c)
    || /\(search\./.test(c)
    || /\(intent\./.test(c)
  ) {
    return true;
  }

  return false;
}

/**
 * True when the round did successful discover/understand work (read/search/intent/analyze)
 * so the idle counter should not advance during exploration before pin/BB.
 */
export function subagentToolResultIndicatesExploration(content: string): boolean {
  const c = content;
  if (looksLikeToolError(c)) return false;
  if (!c.includes('[OK]')) return false;
  return /\((read\.|search\.|intent\.|analyze\.)/.test(c)
    || /\b(read\.|search\.|intent\.|analyze\.)/.test(c);
}
