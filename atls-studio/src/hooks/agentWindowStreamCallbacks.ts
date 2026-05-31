import type { AgentRuntimeMessage } from '../stores/agentRuntimeStore';
import { useAgentRuntimeStore } from '../stores/agentRuntimeStore';
import type { AgentWindow } from '../stores/agentWindowStore';
import { useAgentWindowStore } from '../stores/agentWindowStore';
import type { StreamCallbacks } from '../services/aiService';
import { handleDelegateToolCall, handleSubAgentProgress } from '../services/agentDelegateBridge';
import { summarizeChildResult } from '../services/delegationContext';
import { notifyBackgroundWindowComplete } from '../services/agentWindowNotifications';

export function buildAgentWindowStreamCallbacks(ctx: {
  window: AgentWindow;
  windowId: string;
  startedAt: number;
  fullResponseRef: { current: string };
  runErroredRef: { current: boolean };
  persistMessage: (sessionId: string, message: AgentRuntimeMessage) => void;
}): StreamCallbacks {
  const { window, windowId, startedAt, fullResponseRef, runErroredRef, persistMessage } = ctx;
  const runtimeStore = () => useAgentRuntimeStore.getState();

  return {
    onToken: (token) => {
      fullResponseRef.current += token;
      runtimeStore().setStreamingText(windowId, fullResponseRef.current);
      runtimeStore().replaceLastAssistantMessage(windowId, fullResponseRef.current);
    },
    onToolCall: (toolCall) => {
      runtimeStore().addToolCall(windowId, toolCall);
      runtimeStore().updateTelemetry(windowId, { lastTool: toolCall.name });
      handleDelegateToolCall(window.parentSessionId, toolCall);
      toolCall.syntheticChildren?.forEach((child) => handleDelegateToolCall(window.parentSessionId, child));
    },
    onToolResult: (id, result) => {
      runtimeStore().updateTelemetry(windowId, { lastTool: id });
      const systemMessage = runtimeStore().appendMessage(windowId, {
        role: 'system',
        toolName: id,
        content: result.slice(0, 800),
      });
      if (systemMessage) void persistMessage(window.sessionId, systemMessage);
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
    },
    onDone: () => {
      if (runErroredRef.current) return;
      const latest = runtimeStore().runtimesByWindow[windowId];
      if (fullResponseRef.current.trim()) {
        const finalMessage = latest?.messages[latest.messages.length - 1];
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
      runtimeStore().setStreamingText(windowId, '');
    },
    onStatus: (message) => {
      if (!message) return;
      runtimeStore().appendMessage(windowId, { role: 'system', content: message });
    },
  };
}
