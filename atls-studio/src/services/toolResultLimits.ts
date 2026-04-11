/**
 * Per-tool result size cap when attaching tool_result blocks to the model (chars).
 * Prevents token budget blowouts from huge batch output.
 */
export const TOOL_RESULT_CHAR_LIMIT = 400000;

export function truncateToolResult(result: string): string {
  if (result.length <= TOOL_RESULT_CHAR_LIMIT) return result;
  return result.substring(0, TOOL_RESULT_CHAR_LIMIT) + '\n[truncated]';
}
