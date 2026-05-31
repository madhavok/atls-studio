import { cleanStreamingContent, getTaskCompleteSummaryFromParts } from '../components/AiChat/aiChatPure';
import type { StreamingRefs } from '../components/AiChat/streamingHelpers';
import {
  coalesceReasoningParts,
  type MessagePart,
  type MessageSegment,
  type MessageToolCall,
} from '../stores/appStore';
import type { StreamSegment } from '../types/streamSegments';
import type { AgentRuntimeMessage } from '../stores/agentRuntimeStore';
import { chatDb } from './chatDb';

type PersistableSegment =
  | MessageSegment
  | { type: 'step-boundary'; content: '' }
  | { type: 'error'; content: string };

export function partsToPersistableSegments(parts: MessagePart[]): PersistableSegment[] {
  return parts
    .filter((part) => part.type === 'text' || part.type === 'tool' || part.type === 'reasoning' || part.type === 'step-boundary' || part.type === 'error')
    .map((part) => {
      if (part.type === 'text') return { type: 'text' as const, content: part.content };
      if (part.type === 'reasoning') return { type: 'reasoning' as const, content: part.content };
      if (part.type === 'step-boundary') return { type: 'step-boundary' as const, content: '' as const };
      if (part.type === 'error') return { type: 'error' as const, content: part.errorText };
      return { type: 'tool' as const, toolCall: part.toolCall };
    });
}

export function finalizeStreamSegmentsToParts(
  streamRefs: StreamingRefs,
  toolCallsById: Map<string, MessageToolCall>,
): { parts: MessagePart[]; segments: MessageSegment[]; content: string } {
  const finalParts: MessagePart[] = [];
  const finalSegments: MessageSegment[] = [];
  const allSegments: StreamSegment[] = [
    ...streamRefs.accumulatedSegmentsRef.current,
    ...streamRefs.streamingSegmentsRef.current,
  ];

  for (const segment of allSegments) {
    if (segment.type === 'text') {
      const cleaned = cleanStreamingContent(segment.content);
      if (cleaned) {
        finalParts.push({ type: 'text', content: cleaned });
        finalSegments.push({ type: 'text', content: cleaned });
      }
    } else if (segment.type === 'reasoning' && segment.content) {
      finalParts.push({ type: 'reasoning', content: segment.content });
    } else if (segment.type === 'tool') {
      const src = toolCallsById.get(segment.toolCall.id) ?? segment.toolCall;
      const toolPart = {
        type: 'tool' as const,
        toolCall: {
          id: src.id,
          name: src.name,
          args: src.args,
          result: src.result,
          status: (src.status === 'completed' || src.status === 'failed' ? src.status : 'completed') as 'completed' | 'failed',
          ...(src.thoughtSignature ? { thoughtSignature: src.thoughtSignature } : {}),
          ...(src.syntheticChildren?.length ? { syntheticChildren: src.syntheticChildren } : {}),
        },
      };
      finalParts.push(toolPart);
      finalSegments.push(toolPart);
    } else if (segment.type === 'step-boundary') {
      finalParts.push({ type: 'step-boundary' });
    } else if (segment.type === 'error') {
      finalParts.push({ type: 'error', errorText: segment.errorText });
    }
  }

  const coalescedParts = coalesceReasoningParts(finalParts);
  const cleanedContent = coalescedParts
    .filter((part): part is { type: 'text'; content: string } => part.type === 'text')
    .map((part) => part.content)
    .join('\n');
  const synthesizedSummary = cleanedContent ? '' : getTaskCompleteSummaryFromParts(coalescedParts);
  if (synthesizedSummary) {
    coalescedParts.unshift({ type: 'text', content: synthesizedSummary });
    finalSegments.unshift({ type: 'text', content: synthesizedSummary });
  }
  const content = cleanedContent || synthesizedSummary || '';

  return { parts: coalescedParts, segments: finalSegments, content };
}

export async function persistGridAssistantTurn(
  sessionId: string,
  message: AgentRuntimeMessage,
  parts: MessagePart[],
  content: string,
): Promise<void> {
  if (!chatDb.isInitialized() || message.role !== 'assistant') return;
  const resolvedContent = content || '*(Tool execution completed)*';
  const segmentsToSave = partsToPersistableSegments(parts);

  try {
    const existing = await chatDb.getMessages(sessionId);
    const known = existing.some((row) => row.id === message.id);
    if (!known) {
      await chatDb.addMessage(sessionId, 'assistant', resolvedContent, undefined, message.id);
    } else if (resolvedContent !== message.content) {
      await chatDb.updateMessageContent(message.id, resolvedContent);
    }
    if (segmentsToSave.length > 0) {
      await chatDb.replaceSegments(message.id, segmentsToSave);
    }
  } catch (error) {
    console.warn('[AgentGridPersist] Failed to persist assistant turn:', error);
  }
}

export async function persistGridUserMessage(sessionId: string, message: AgentRuntimeMessage): Promise<void> {
  if (!chatDb.isInitialized() || message.role !== 'user') return;
  try {
    const existing = await chatDb.getMessages(sessionId);
    if (existing.some((row) => row.id === message.id)) return;
    await chatDb.addMessage(sessionId, 'user', message.content, undefined, message.id);
  } catch (error) {
    console.warn('[AgentGridPersist] Failed to persist user message:', error);
  }
}
