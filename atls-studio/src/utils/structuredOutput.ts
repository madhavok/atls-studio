/**
 * Structured Output — Zod-validated schemas for tool args and AI responses.
 *
 * Provides type-safe parsing for task_complete payloads, tool arguments,
 * and extraction flows. Rejects or repairs malformed LLM output.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// task_complete payload
// ---------------------------------------------------------------------------

export const taskCompleteArgsSchema = z.object({
  summary: z.string().min(1).default('Task completed'),
  files_changed: z.array(z.string()).optional(),
  filesChanged: z.array(z.string()).optional(),
}).transform((data) => ({
  summary: data.summary.trim(),
  filesChanged: (data.files_changed ?? data.filesChanged ?? []).filter(
    (f): f is string => typeof f === 'string',
  ),
}));

export type TaskCompleteArgs = z.infer<typeof taskCompleteArgsSchema>;

/** Parse task_complete args from tool call. Returns validated result or safe default. */
export function parseTaskCompleteArgs(input: Record<string, unknown>): TaskCompleteArgs {
  const inner =
    input.params && typeof input.params === 'object'
      ? (input.params as Record<string, unknown>)
      : input;
  const result = taskCompleteArgsSchema.safeParse(inner);
  if (result.success) return result.data;
  return {
    summary: typeof inner?.summary === 'string' ? String(inner.summary).trim() : 'Task completed',
    filesChanged: Array.isArray(inner?.files_changed)
      ? inner.files_changed.filter((f): f is string => typeof f === 'string')
      : Array.isArray(inner?.filesChanged)
        ? inner.filesChanged.filter((f): f is string => typeof f === 'string')
        : [],
  };
}

// ---------------------------------------------------------------------------
// Generic tool arg validation
// ---------------------------------------------------------------------------

/**
 * Parse and validate tool args with Zod schema.
 * Returns parsed value or throws ZodError with actionable message.
 */
export function parseToolArgs<T extends z.ZodType>(input: unknown, schema: T): z.infer<T> {
  return schema.parse(input);
}

/**
 * Safe parse: returns { success, data } or { success: false, error }.
 */
export function safeParseToolArgs<T extends z.ZodType>(
  input: unknown,
  schema: T,
): { success: true; data: z.infer<T> } | { success: false; error: z.ZodError } {
  const result = schema.safeParse(input);
  if (result.success) return { success: true, data: result.data };
  return { success: false, error: result.error };
}
