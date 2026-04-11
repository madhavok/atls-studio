import type { MessagePart } from '../../stores/appStore';
import { parseTaskCompleteArgs } from '../../utils/structuredOutput';

export function isTaskCompleteCall(tc: { name: string; args?: Record<string, unknown> }): boolean {
  return tc.name === 'task_complete';
}

export function coerceStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return [value];
  return [];
}

/** Tauri v2 dialog may return a path string or `{ path: string }`. */
export function dialogSelectedPath(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (entry !== null && typeof entry === 'object' && 'path' in entry) {
    const p = (entry as { path: unknown }).path;
    if (typeof p === 'string') return p;
  }
  return null;
}

export function getTaskCompleteArgs(tc: { args?: Record<string, unknown> }): { summary: string; filesChanged: string[] } {
  const parsed = parseTaskCompleteArgs(tc.args ?? {});

  if (parsed.filesChanged.length > 0) {
    return parsed;
  }

  const legacyFilesChanged = coerceStringArray(tc.args?.files_changed ?? tc.args?.filesChanged);
  return {
    summary: parsed.summary,
    filesChanged: legacyFilesChanged,
  };
}

export function getTaskCompleteSummaryFromParts(parts: MessagePart[]): string {
  const textParts = parts
    .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => cleanStreamingContent(part.content).trim())
    .filter(Boolean);
  if (textParts.length > 0) return textParts.join('\n\n');
  const taskCompletePart = [...parts].reverse().find((part): part is Extract<MessagePart, { type: 'tool' }> => {
    return part.type === 'tool' && isTaskCompleteCall(part.toolCall);
  });
  if (!taskCompletePart) return '';
  return getTaskCompleteArgs(taskCompletePart.toolCall).summary.trim();
}

/** Clean streaming content — remove JSON tool_use artifacts that may leak into text. */
export function cleanStreamingContent(content: string): string {
  if (!content) return '';

  if (/^\s*\[->\s+.+\]\s*$/.test(content)) return content;

  const trimmed = content.trim();

  if (trimmed === '[' || trimmed === '[{' || trimmed === '[]') {
    return '';
  }
  if (trimmed.length < 80 && !/\s\w+\s/.test(trimmed)) {
    if (/^\[?\{?"?(?:type)?:?"?(?:tool_use|tool_result|text)?"?\s*,?\s*$/s.test(trimmed)) {
      return '';
    }
    if (/^\{?\s*"?(?:functionCall|functionResponse)"?\s*:?\s*\{?\s*$/s.test(trimmed)) {
      return '';
    }
  }

  if (trimmed.startsWith('[{') && trimmed.endsWith(']') && trimmed.includes('"type"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed) && parsed.every((b: unknown) => typeof b === 'object' && b !== null && 'type' in (b as object))) {
        const hasOnlyTools = parsed.every((b: { type?: string }) => b.type === 'tool_use' || b.type === 'tool_result');
        if (hasOnlyTools) return '';

        const textParts = parsed
          .filter((block: { type?: string; text?: string }) => block.type === 'text' && block.text)
          .map((block: { text: string }) => block.text);
        return textParts.length > 0 ? textParts.join('\n') : '';
      }
    } catch {
      // fall through
    }
  }

  let cleaned = content;
  cleaned = cleaned.replace(/,?\s*\{"type"\s*:\s*"tool_use"[^}]*$/s, '');
  cleaned = cleaned.replace(/\{\s*"functionCall"\s*:\s*\{[^}]*$/s, '');
  cleaned = cleaned.replace(/\{\s*"functionResponse"\s*:\s*\{[^}]*$/s, '');

  return cleaned;
}
