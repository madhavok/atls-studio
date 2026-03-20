/**
 * Tool Token Metrics
 *
 * Analyzes chat messages to produce per-tool token usage breakdowns.
 * Helps identify which tool returns consume the most context budget.
 */

import type { Message } from '../stores/appStore';
import { getMessageParts } from '../stores/appStore';
import type { DbSegment } from '../services/chatDb';
import { estimateTokens } from './contextHash';

export interface ToolTokenEntry {
  toolName: string;
  callCount: number;
  totalArgTokens: number;
  totalResultTokens: number;
  totalTokens: number;
  avgResultTokens: number;
  maxResultTokens: number;
  maxResultCallId: string;
}

export interface ToolTokenReport {
  entries: ToolTokenEntry[];
  grandTotalArgTokens: number;
  grandTotalResultTokens: number;
  grandTotalTokens: number;
  totalToolCalls: number;
  textSegmentTokens: number;
  userMessageTokens: number;
}

interface RawToolCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  syntheticParentName?: string;
}

function resolveToolName(tc: RawToolCall): string {
  if (tc.syntheticParentName?.trim()) return tc.syntheticParentName.trim();
  const syntheticTool = tc.args && typeof tc.args === 'object'
    ? (tc.args as Record<string, unknown>).tool_name
    : undefined;

  if (tc.name === 'batch' && typeof syntheticTool === 'string' && syntheticTool.trim()) {
    return syntheticTool.trim();
  }

  return tc.name || 'unknown';
}

function buildReport(toolCalls: RawToolCall[], textTokens: number, userTokens: number): ToolTokenReport {
  const map = new Map<string, {
    callCount: number;
    totalArgTokens: number;
    totalResultTokens: number;
    maxResultTokens: number;
    maxResultCallId: string;
  }>();

  let grandArgs = 0;
  let grandResults = 0;

  for (const tc of toolCalls) {
    const argStr = tc.args ? JSON.stringify(tc.args) : '';
    const argTokens = estimateTokens(argStr);
    const resultTokens = estimateTokens(tc.result ?? '');

    grandArgs += argTokens;
    grandResults += resultTokens;

    const resolvedName = resolveToolName(tc);
    const existing = map.get(resolvedName);

    if (existing) {
      existing.callCount++;
      existing.totalArgTokens += argTokens;
      existing.totalResultTokens += resultTokens;
      if (resultTokens > existing.maxResultTokens) {
        existing.maxResultTokens = resultTokens;
        existing.maxResultCallId = tc.id;
      }
    } else {
      map.set(resolvedName, {
        callCount: 1,
        totalArgTokens: argTokens,
        totalResultTokens: resultTokens,
        maxResultTokens: resultTokens,
        maxResultCallId: tc.id,
      });
    }
  }

  const entries: ToolTokenEntry[] = Array.from(map.entries())
    .map(([toolName, d]) => ({
      toolName,
      callCount: d.callCount,
      totalArgTokens: d.totalArgTokens,
      totalResultTokens: d.totalResultTokens,
      totalTokens: d.totalArgTokens + d.totalResultTokens,
      avgResultTokens: d.callCount > 0 ? Math.round(d.totalResultTokens / d.callCount) : 0,
      maxResultTokens: d.maxResultTokens,
      maxResultCallId: d.maxResultCallId,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    entries,
    grandTotalArgTokens: grandArgs,
    grandTotalResultTokens: grandResults,
    grandTotalTokens: grandArgs + grandResults,
    totalToolCalls: toolCalls.length,
    textSegmentTokens: textTokens,
    userMessageTokens: userTokens,
  };
}

function extractToolCalls(messages: Message[]): { tools: RawToolCall[]; textTokens: number; userTokens: number } {
  const tools: RawToolCall[] = [];
  let textTokens = 0;
  let userTokens = 0;

  for (const msg of messages) {
    if (msg.role === 'user') {
      userTokens += estimateTokens(msg.content);
      continue;
    }

    const parts = getMessageParts(msg);
    if (parts.length > 0) {
      for (const part of parts) {
        if (part.type === 'text') {
          textTokens += estimateTokens(part.content);
        } else if (part.type === 'tool') {
          const tc = part.toolCall;
          const syntheticChildren = Array.isArray((tc as { syntheticChildren?: unknown[] }).syntheticChildren)
            ? ((tc as { syntheticChildren?: unknown[] }).syntheticChildren as Array<Record<string, unknown>>)
            : [];
          for (const child of syntheticChildren) {
            const childName = typeof child.name === 'string' ? child.name.trim() : '';
            if (!childName) continue;
            tools.push({
              id: typeof child.id === 'string' ? child.id : `${tc.id}:${childName}`,
              name: childName,
              args: child.args && typeof child.args === 'object' ? (child.args as Record<string, unknown>) : undefined,
              result: typeof child.result === 'string' ? child.result : undefined,
              syntheticParentName: childName,
            });
          }
          if (syntheticChildren.length === 0) {
            tools.push({ id: tc.id, name: tc.name, args: tc.args, result: tc.result });
          }
        }
      }
    } else {
      textTokens += estimateTokens(msg.content);
    }
  }

  return { tools, textTokens, userTokens };
}

export function analyzeToolTokens(messages: Message[]): ToolTokenReport {
  const { tools, textTokens, userTokens } = extractToolCalls(messages);
  return buildReport(tools, textTokens, userTokens);
}

interface DbMessageLike {
  id: string;
  role: string;
  content: string;
}

export function analyzeDbSegments(
  dbMessages: DbMessageLike[],
  segmentsByMessage: Map<string, DbSegment[]>,
): ToolTokenReport {
  const tools: RawToolCall[] = [];
  let textTokens = 0;
  let userTokens = 0;

  for (const msg of dbMessages) {
    if (msg.role === 'user') {
      userTokens += estimateTokens(msg.content);
      continue;
    }

    const segs = segmentsByMessage.get(msg.id);
    if (segs && segs.length > 0) {
      for (const seg of segs) {
        if (seg.type === 'text') {
          textTokens += estimateTokens(seg.content);
        } else {
          let parsedArgs: Record<string, unknown> | undefined;
          let syntheticChildren: Array<Record<string, unknown>> | undefined;
          if (seg.tool_args) {
            const raw = JSON.parse(seg.tool_args);
            if (raw && Array.isArray(raw.__syntheticChildren)) {
              syntheticChildren = raw.__syntheticChildren;
              const { __syntheticChildren: _, ...rest } = raw;
              parsedArgs = Object.keys(rest).length > 0 ? rest : undefined;
            } else {
              parsedArgs = raw;
            }
          }
          if (syntheticChildren && syntheticChildren.length > 0) {
            for (const child of syntheticChildren) {
              const childName = typeof child.name === 'string' ? child.name.trim() : '';
              if (!childName) continue;
              tools.push({
                id: typeof child.id === 'string' ? child.id : `${seg.id}:${childName}`,
                name: childName,
                args: child.args && typeof child.args === 'object' ? (child.args as Record<string, unknown>) : undefined,
                result: typeof child.result === 'string' ? child.result : undefined,
                syntheticParentName: childName,
              });
            }
          } else {
            tools.push({
              id: String(seg.id),
              name: seg.tool_name ?? '',
              args: parsedArgs,
              result: seg.tool_result ?? undefined,
            });
          }
        }
      }
    } else {
      textTokens += estimateTokens(msg.content);
    }
  }

  return buildReport(tools, textTokens, userTokens);
}

export function mergeReports(reports: ToolTokenReport[]): ToolTokenReport {
  const mergedMap = new Map<string, {
    callCount: number;
    totalArgTokens: number;
    totalResultTokens: number;
    maxResultTokens: number;
    maxResultCallId: string;
  }>();

  let grandArgs = 0;
  let grandResults = 0;
  let totalCalls = 0;
  let textTokens = 0;
  let userTokens = 0;

  for (const report of reports) {
    grandArgs += report.grandTotalArgTokens;
    grandResults += report.grandTotalResultTokens;
    totalCalls += report.totalToolCalls;
    textTokens += report.textSegmentTokens;
    userTokens += report.userMessageTokens;

    for (const entry of report.entries) {
      const existing = mergedMap.get(entry.toolName);
      if (existing) {
        existing.callCount += entry.callCount;
        existing.totalArgTokens += entry.totalArgTokens;
        existing.totalResultTokens += entry.totalResultTokens;
        if (entry.maxResultTokens > existing.maxResultTokens) {
          existing.maxResultTokens = entry.maxResultTokens;
          existing.maxResultCallId = entry.maxResultCallId;
        }
      } else {
        mergedMap.set(entry.toolName, {
          callCount: entry.callCount,
          totalArgTokens: entry.totalArgTokens,
          totalResultTokens: entry.totalResultTokens,
          maxResultTokens: entry.maxResultTokens,
          maxResultCallId: entry.maxResultCallId,
        });
      }
    }
  }

  const entries: ToolTokenEntry[] = Array.from(mergedMap.entries())
    .map(([toolName, d]) => ({
      toolName,
      callCount: d.callCount,
      totalArgTokens: d.totalArgTokens,
      totalResultTokens: d.totalResultTokens,
      totalTokens: d.totalArgTokens + d.totalResultTokens,
      avgResultTokens: d.callCount > 0 ? Math.round(d.totalResultTokens / d.callCount) : 0,
      maxResultTokens: d.maxResultTokens,
      maxResultCallId: d.maxResultCallId,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    entries,
    grandTotalArgTokens: grandArgs,
    grandTotalResultTokens: grandResults,
    grandTotalTokens: grandArgs + grandResults,
    totalToolCalls: totalCalls,
    textSegmentTokens: textTokens,
    userMessageTokens: userTokens,
  };
}

export function formatToolDisplayName(name: string): string {
  if (name === 'batch') return 'batch (no step detail)';
  return name.startsWith('functions.') ? name.slice('functions.'.length) : name;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
