import type { ToolCall, ToolCallStatus, MessageToolCall } from '../../stores/appStore';
import { FAMILY_ICONS } from '../../services/batch/families';
import { normalizeOperationUse } from '../../services/batch/opShorthand';
import { parseBatchStepLines as parseBatchStepLinesUtil, indexStepLinesById } from '../../utils/batchLineParsing';

type RenderToolStatus = ToolCall['status'] | ToolCallStatus | MessageToolCall['status'];

export type ToolCallLike = {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  status: RenderToolStatus;
  thoughtSignature?: string;
  /** Per-step rows from batch execution (authoritative after tool completes). */
  syntheticChildren?: Array<{
    id: string;
    name: string;
    args?: Record<string, unknown>;
    result?: string;
    status?: string;
  }>;
};

export type BatchStepCall = {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  status: ToolCall['status'];
  thoughtSignature?: string;
};

/** Map UI child row id → batch step id used by delegate onSubagentProgress */
export function batchStepSubagentLookupKey(childCall: BatchStepCall): string {
  const a = childCall.args as Record<string, unknown> | undefined;
  if (a && typeof a.step_id === 'string' && a.step_id.trim()) return a.step_id.trim();
  const id = childCall.id;
  const sep = '::';
  const idx = id.indexOf(sep);
  if (idx >= 0) return id.slice(idx + sep.length);
  if (id.startsWith('batch:')) {
    const parts = id.split(':');
    if (parts.length >= 4) return parts[2];
  }
  return id;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function formatLabelSegment(segment: string): string {
  return segment
    .split(/[_-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function getFriendlyToolName(toolName: string): string {
  if (toolName === 'batch') return '\u26A1 ATLS';
  if (toolName === 'task_complete') return '\u2705 Task Complete';

  if (toolName.includes('.')) {
    const [family, action] = toolName.split('.', 2);
    const icon = FAMILY_ICONS[family] || '\uD83D\uDD27';
    const label = [family, action]
      .filter(Boolean)
      .map(formatLabelSegment)
      .join(' ');
    return `${icon} ${label}`;
  }

  return `\uD83D\uDD27 ${toolName}`;
}

export function getToolDetail(toolName: string, params: Record<string, unknown>): string {
  if (params.file_paths && Array.isArray(params.file_paths) && params.file_paths[0]) {
    return String(params.file_paths[0]);
  }
  if (params.file_path) {
    return String(params.file_path);
  }
  if (params.file || params.path) {
    return String(params.file || params.path);
  }
  if (params.symbol_names && Array.isArray(params.symbol_names)) {
    return params.symbol_names.map((s) => String(s)).join(', ');
  }
  if (params.queries && Array.isArray(params.queries) && params.queries[0]) {
    return String(params.queries[0]);
  }
  if (params.query) {
    return String(params.query);
  }
  if (params.operation) {
    return String(params.operation);
  }
  if (params.action) {
    return String(params.action);
  }
  return '';
}

export function getBatchSteps(args?: Record<string, unknown>): Array<{ id: string; use: string; with: Record<string, unknown> }> {
  const steps = Array.isArray(args?.steps) ? args.steps : [];
  return steps.map((step, index) => {
    const record = asRecord(step) || {};
    const withParams = asRecord(record.with) || {};
    const useRaw = typeof record.use === 'string' && record.use.trim()
      ? record.use.trim()
      : '';
    const use = useRaw
      ? String(normalizeOperationUse(useRaw.toLowerCase()))
      : `step.${index + 1}`;
    const id = typeof record.id === 'string' && record.id.trim()
      ? record.id
      : `step-${index + 1}`;
    return { id, use, with: withParams };
  });
}

export function truncateToolResult(result: string, maxLen: number = 240): string {
  if (!result) return '';
  const normalized = result.trim();
  if (normalized.length <= maxLen) return normalized;
  const headLength = Math.max(120, Math.floor(maxLen * 0.65));
  const head = normalized.slice(0, headLength).trimEnd();
  const omitted = Math.max(0, normalized.length - maxLen);
  const tailBudget = Math.max(40, maxLen - head.length - 24);
  const tail = omitted > 0 ? normalized.slice(-tailBudget).trimStart() : '';
  return tail
    ? `${head}\n…[truncated ${omitted} chars]…\n${tail}`
    : head;
}

export function isBatchCall(call: { name: string; args?: Record<string, unknown> }): boolean {
  return call.name === 'batch';
}

export function mapSyntheticStepStatus(raw: string | undefined): ToolCall['status'] {
  if (raw === 'failed') return 'failed';
  if (raw === 'running') return 'running';
  if (raw === 'pending') return 'pending';
  return 'completed';
}

export function expandBatchToolCall(toolCall: ToolCallLike): BatchStepCall[] {
  if (!isBatchCall(toolCall)) {
    return [];
  }

  const synth = toolCall.syntheticChildren;
  if (synth && synth.length > 0) {
    return synth.map((child) => ({
      id: child.id,
      name: String(normalizeOperationUse(String(child.name || '').trim().toLowerCase())),
      args: child.args,
      result: child.result,
      status: mapSyntheticStepStatus(child.status),
      thoughtSignature: toolCall.thoughtSignature,
    }));
  }

  const batchArgs = toolCall.args || {};
  const steps = getBatchSteps(batchArgs);
  if (steps.length === 0) {
    return [];
  }

  const parsedLines = parseBatchStepLinesUtil(toolCall.result);
  const lineById = indexStepLinesById(parsedLines);
  const completedCount = parsedLines.length;
  const runningIndex = Math.min(completedCount, Math.max(steps.length - 1, 0));

  return steps.map((step, index) => {
    const line = lineById.get(step.id);
    let status: ToolCall['status'] = 'pending';
    let result = line?.text;

    if (line) {
      status = line.failed ? 'failed' : 'completed';
    } else if (toolCall.status === 'running') {
      status = index === runningIndex ? 'running' : index < runningIndex ? 'completed' : 'pending';
    } else if (toolCall.status === 'pending' || toolCall.status === 'input-streaming' || toolCall.status === 'input-available') {
      status = 'pending';
    } else if (toolCall.status === 'completed') {
      status = 'completed';
    } else if (toolCall.status === 'failed') {
      status = 'failed';
      result = result || 'Not executed because the ATLS batch stopped before this step.';
    }

    return {
      id: `${toolCall.id}::${step.id}`,
      name: normalizeOperationUse(step.use),
      args: step.with,
      result,
      status,
      thoughtSignature: toolCall.thoughtSignature,
    };
  });
}

export function getBatchDisplayDetail(params: Record<string, unknown>): string {
  const goal = typeof params.goal === 'string' ? params.goal.trim() : '';
  if (goal) return goal;
  const steps = getBatchSteps(params);
  const firstStep = steps[0];
  if (!firstStep) return '';
  return getToolDetail(firstStep.use, firstStep.with) || firstStep.use || `${steps.length} steps`;
}

export function getToolDisplayInfo(call: { name: string; args?: Record<string, unknown> }) {
  const args = call.args || {};
  const toolName = (args.tool as string) || call.name;
  const params = (args.params as Record<string, unknown>) || args;

  const friendly = getFriendlyToolName(toolName);
  const detail = toolName === 'batch'
    ? getBatchDisplayDetail(params)
    : getToolDetail(toolName, params);

  return { friendly, detail, fullName: detail ? `${friendly}: ${detail}` : friendly };
}

export type StatusMarkerPart = string | { type: 'status'; status: string; step?: string; next?: string };

/** Parse status markers like «st:working|step:1/3» for inline badge rendering. */
export function parseStatusMarkers(text: string): StatusMarkerPart[] {
  const parts: StatusMarkerPart[] = [];
  const regex = /«([^»]+)»/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const markerContent = match[1];
    const parsed: { type: 'status'; status: string; step?: string; next?: string } = { type: 'status', status: '' };

    markerContent.split('|').forEach((pair) => {
      const [key, value] = pair.split(':').map((s) => s.trim());
      if (key === 'st') parsed.status = value;
      else if (key === 'step') parsed.step = value;
      else if (key === 'next') parsed.next = value;
    });

    parts.push(parsed);
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}
