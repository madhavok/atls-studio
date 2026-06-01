import type { AgentRuntimeMessage } from '../stores/agentRuntimeStore';
import { useAgentRuntimeStore } from '../stores/agentRuntimeStore';
import type { AgentWindow } from '../stores/agentWindowStore';
import { useAgentWindowStore } from '../stores/agentWindowStore';
import type { StreamCallbacks } from '../services/aiService';
import type { ToolCall } from '../stores/appStore';
import {
  appendReasoningToSegments,
  appendTextToSegments,
  closeBlockById,
  upsertToolSegment,
} from '../components/AiChat/streamingHelpers';
import {
  beginAgentWindowStreamRun,
  endAgentWindowStreamRun,
  getAgentWindowStreamRefs,
} from '../services/agentWindowStreamRefs';
import {
  finalizeStreamSegmentsToParts,
  persistGridAssistantTurn,
} from '../services/agentGridMessagePersist';
import { persistContextSession } from '../services/contextSessionPartition';
import { handleDelegateToolCall, handleSubAgentProgress } from '../services/agentDelegateBridge';
import { summarizeChildResult } from '../services/delegationContext';
import { notifyBackgroundWindowComplete } from '../services/agentWindowNotifications';

function toToolCall(toolCall: Parameters<NonNullable<StreamCallbacks['onToolCall']>>[0]): ToolCall {
  return {
    id: toolCall.id,
    name: toolCall.name,
    status: toolCall.status,
    args: toolCall.args,
    result: toolCall.result,
    startTime: new Date(),
    thoughtSignature: toolCall.thoughtSignature,
    syntheticChildren: toolCall.syntheticChildren,
  };
}

export function buildAgentWindowStreamCallbacks(ctx: {
  window: AgentWindow;
  windowId: string;
  startedAt: number;
  fullResponseRef: { current: string };
  runErroredRef: { current: boolean };
  persistMessage: (sessionId: string, message: AgentRuntimeMessage) => void;
  persistAssistantTurn?: (sessionId: string, message: AgentRuntimeMessage, parts: import('../stores/appStore').MessagePart[], content: string) => void;
}): StreamCallbacks {
  const { window, windowId, startedAt, fullResponseRef, runErroredRef, persistMessage, persistAssistantTurn } = ctx;
  const runtimeStore = () => useAgentRuntimeStore.getState();
  const streamRefs = beginAgentWindowStreamRun(windowId);
  const toolCallsById = new Map<string, ToolCall>();
  let activeTextId: string | null = null;
  let activeReasoningId: string | null = null;

  return {
    onToken: (token) => {
      fullResponseRef.current += token;
      appendTextToSegments(streamRefs, token, activeTextId || undefined);
      runtimeStore().setStreamingText(windowId, fullResponseRef.current);
      runtimeStore().replaceLastAssistantMessage(windowId, fullResponseRef.current);
    },
    onTextStart: (id) => { activeTextId = id; },
    onTextEnd: (id) => { closeBlockById(streamRefs, id, 'text'); activeTextId = null; },
    onReasoningStart: (id) => { activeReasoningId = id; },
    onReasoningDelta: (delta) => {
      appendReasoningToSegments(streamRefs, delta, activeReasoningId || undefined);
      const reasoning = streamRefs.streamingSegmentsRef.current
        .filter((segment) => segment.type === 'reasoning')
        .map((segment) => (segment.type === 'reasoning' ? segment.content : ''))
        .join('');
      runtimeStore().setStreamingReasoning(windowId, reasoning);
    },
    onReasoningEnd: (id) => { closeBlockById(streamRefs, id, 'reasoning'); activeReasoningId = null; },
    onToolInputStart: (toolCallId, toolName) => {
      upsertToolSegment(streamRefs, { id: toolCallId, name: toolName, status: 'pending', startTime: new Date() });
    },
    onToolInputDelta: () => {},
    onToolInputAvailable: (toolCallId, toolName, input, thoughtSignature) => {
      upsertToolSegment(streamRefs, {
        id: toolCallId,
        name: toolName,
        status: 'running',
        args: input,
        startTime: new Date(),
        thoughtSignature,
      });
    },
    onStepStart: () => {
      if (activeTextId) {
        closeBlockById(streamRefs, activeTextId, 'text');
        activeTextId = null;
      }
      if (activeReasoningId) {
        closeBlockById(streamRefs, activeReasoningId, 'reasoning');
        activeReasoningId = null;
      }
      streamRefs.segmentsRevisionRef.current++;
    },
    onStepEnd: () => {
      streamRefs.streamingSegmentsRef.current.push({ type: 'step-boundary' });
      streamRefs.segmentsRevisionRef.current++;
      void persistContextSession(window.sessionId, { toDb: true }).catch((error) => {
        console.warn('[AgentWindowStream] checkpoint persist failed:', error);
      });
    },
    onStreamError: (errorText) => {
      streamRefs.streamingSegmentsRef.current.push({ type: 'error', errorText });
      streamRefs.segmentsRevisionRef.current++;
    },
    onToolCall: (toolCall) => {
      const mapped = toToolCall(toolCall);
      toolCallsById.set(mapped.id, mapped);
      upsertToolSegment(streamRefs, mapped);
      runtimeStore().addToolCall(windowId, mapped);
      runtimeStore().updateTelemetry(windowId, { lastTool: toolCall.name });
      handleDelegateToolCall(window.parentSessionId, toolCall);
      toolCall.syntheticChildren?.forEach((child) => handleDelegateToolCall(window.parentSessionId, child));
    },
    onToolResult: (id, result) => {
      runtimeStore().updateTelemetry(windowId, { lastTool: id });
      const existing = toolCallsById.get(id);
      if (!existing) return;
      const updated = {
        ...existing,
        result,
        status: 'completed' as const,
        endTime: new Date(),
      };
      toolCallsById.set(id, updated);
      upsertToolSegment(streamRefs, updated);
      runtimeStore().addToolCall(windowId, updated);
    },
    onUsageUpdate: (usage) => {
      runtimeStore().updateTelemetry(windowId, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        costCents: usage.costCents ?? 0,
      });
    },
    onSubagentProgress: (stepId, progress) => {
      handleSubAgentProgress(window.parentSessionId, stepId, progress);
    },
    onError: (error) => {
      runErroredRef.current = true;
      const controller = runtimeStore().runtimesByWindow[windowId]?.abortController;
      runtimeStore().finishRun(windowId, controller?.signal.aborted ? 'cancelled' : 'failed', error.message);
      useAgentWindowStore.getState().setWindowStatus(windowId, controller?.signal.aborted ? 'paused' : 'failed');
      endAgentWindowStreamRun(windowId);
    },
    onDone: () => {
      if (runErroredRef.current) return;
      const latest = runtimeStore().runtimesByWindow[windowId];
      const { parts, segments, content } = finalizeStreamSegmentsToParts(streamRefs, toolCallsById);
      const hasStructuredTurn = parts.some((part) => part.type === 'tool' || part.type === 'reasoning' || part.type === 'error' || part.type === 'step-boundary');
      const resolvedContent = content || fullResponseRef.current.trim();
      let finalMessage: AgentRuntimeMessage | null = null;
      if (resolvedContent || hasStructuredTurn) {
        finalMessage = runtimeStore().finalizeLastAssistantMessage(
          windowId,
          resolvedContent || '*(Tool execution completed)*',
          parts.length > 0 ? parts : undefined,
          segments.length > 0 ? segments : undefined,
        );
        if (finalMessage) {
          if (persistAssistantTurn) {
            void persistAssistantTurn(window.sessionId, finalMessage, parts, resolvedContent || finalMessage.content);
          } else {
            void persistMessage(window.sessionId, finalMessage);
          }
        }
      } else if (fullResponseRef.current.trim()) {
        finalMessage = latest?.messages[latest.messages.length - 1] ?? null;
        if (finalMessage?.role === 'assistant') void persistMessage(window.sessionId, finalMessage);
      }
      const hadToolActivity = (latest?.toolCalls.length ?? 0) > 0
        || (latest?.messages.some((message) => message.toolName) ?? false);
      const controller = latest?.abortController;
      const finalStatus = controller?.signal.aborted
        ? 'cancelled'
        : (fullResponseRef.current.trim() || hadToolActivity) ? 'completed' : 'failed';
      runtimeStore().updateTelemetry(windowId, { latencyMs: Date.now() - startedAt });
      runtimeStore().finishRun(windowId, finalStatus);
      endAgentWindowStreamRun(windowId);
      useAgentWindowStore.getState().setWindowStatus(
        windowId,
        finalStatus === 'completed' ? 'completed' : finalStatus === 'cancelled' ? 'paused' : 'failed',
      );
      notifyBackgroundWindowComplete(windowId, finalStatus);
      const completed = runtimeStore().runtimesByWindow[windowId];
      if (window.role && completed) {
        runtimeStore().appendParentEvent({
          parentSessionId: window.parentSessionId,
          childWindowId: windowId,
          title: window.title,
          role: window.role,
          status: finalStatus,
          summary: summarizeChildResult(completed.messages),
        });
      }
    },
    onStreamId: (streamId) => runtimeStore().addStreamId(windowId, streamId),
    onClear: () => {
      fullResponseRef.current = '';
      for (const seg of streamRefs.streamingSegmentsRef.current) {
        if (seg.type === 'text' || seg.type === 'reasoning') {
          streamRefs.accumulatedSegmentsRef.current.push({ ...seg, state: 'done' as const });
        } else if (seg.type === 'tool') {
          const status = seg.toolCall.status;
          if (status === 'completed' || status === 'failed') {
            streamRefs.accumulatedSegmentsRef.current.push(seg);
          }
        } else {
          streamRefs.accumulatedSegmentsRef.current.push(seg);
        }
      }
      streamRefs.streamingSegmentsRef.current = streamRefs.streamingSegmentsRef.current.filter(
        (segment) => segment.type === 'tool'
          && segment.toolCall.status !== 'completed'
          && segment.toolCall.status !== 'failed',
      );
      streamRefs.segmentsRevisionRef.current++;
      runtimeStore().setStreamingText(windowId, '');
      runtimeStore().setStreamingReasoning(windowId, '');
    },
    onStatus: (message) => {
      const segments = streamRefs.streamingSegmentsRef.current;
      const idx = segments.findIndex((segment) => segment.type === 'status');
      if (message) {
        if (idx >= 0) {
          (segments[idx] as { type: 'status'; message: string }).message = message;
        } else {
          segments.push({ type: 'status', message });
        }
        streamRefs.segmentsRevisionRef.current++;
        runtimeStore().appendMessage(windowId, { role: 'system', content: message });
      } else if (idx >= 0) {
        segments.splice(idx, 1);
        streamRefs.segmentsRevisionRef.current++;
      }
    },
  };
}
