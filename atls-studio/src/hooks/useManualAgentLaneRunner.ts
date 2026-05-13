import { useCallback } from 'react';
import { useAppStore } from '../stores/appStore';
import { getLanePromptPrefix, useAgentLaneStore } from '../stores/agentLaneStore';
import { streamChat, type AIConfig, type AIProvider, type ChatMessage, type WorkspaceContext } from '../services/aiService';
import { persistAgentLaneMessage } from '../services/agentLanePersistence';
import { getPricingProviderForModel } from '../utils/pricingProvider';
import { isExtendedContextEnabled, modelSupportsExtendedContext } from '../utils/modelCapabilities';
import { resolveModelSettings } from '../utils/modelSettings';

interface UseManualAgentLaneRunnerOptions {
  getWorkspaceContext: () => WorkspaceContext;
}

function getApiKeyForProvider(provider: AIProvider): string {
  const settings = useAppStore.getState().settings;
  switch (provider) {
    case 'anthropic': return settings.anthropicApiKey;
    case 'openai': return settings.openaiApiKey;
    case 'openrouter': return settings.openrouterApiKey;
    case 'google': return settings.googleApiKey;
    case 'vertex': return settings.vertexAccessToken;
    case 'lmstudio': return '';
    default: return '';
  }
}

function getSelectedModelProvider(): AIProvider {
  const state = useAppStore.getState();
  return getPricingProviderForModel(state.settings.selectedModel, state.settings.selectedProvider, state.availableModels);
}

function getAIConfig(): AIConfig {
  const state = useAppStore.getState();
  const { settings } = state;
  const provider = getSelectedModelProvider();
  const anthropicBeta =
    provider === 'anthropic' &&
    isExtendedContextEnabled(
      settings.selectedModel,
      'anthropic',
      settings.extendedContextByModelId ?? {},
      settings.extendedContext,
    ) &&
    modelSupportsExtendedContext(settings.selectedModel, 'anthropic')
      ? ['context-1m-2025-08-07']
      : undefined;
  const modelSettings = resolveModelSettings(
    settings.modelOutputSpeed,
    settings.modelThinking,
    settings.selectedModel,
    provider,
    settings.maxTokens,
  );
  return {
    provider,
    model: settings.selectedModel,
    apiKey: getApiKeyForProvider(provider),
    maxTokens: settings.maxTokens,
    temperature: settings.temperature,
    projectId: settings.vertexProjectId,
    region: provider === 'vertex' ? settings.vertexRegion : undefined,
    baseUrl: provider === 'lmstudio' ? settings.lmstudioBaseUrl : undefined,
    anthropicBeta,
    ...modelSettings,
  };
}

function hasApiKey(): boolean {
  return Boolean(getApiKeyForProvider(getSelectedModelProvider()));
}

export function useManualAgentLaneRunner({ getWorkspaceContext }: UseManualAgentLaneRunnerOptions) {
  return useCallback(async (laneId: string, prompt: string) => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) return;

    const laneStore = useAgentLaneStore.getState();
    const lane = Object.values(laneStore.lanesBySession).flat().find((candidate) => candidate.id === laneId);
    if (!lane || lane.status === 'running') return;

    if (!hasApiKey()) {
      laneStore.setLaneStatus(laneId, 'failed', 'Provider required. Configure a provider before running this agent chat.');
      laneStore.appendLaneMessage(laneId, {
        role: 'system',
        content: 'Provider required. Configure a provider before running this agent chat.',
      });
      return;
    }

    const config = getAIConfig();
    const workspaceContext = getWorkspaceContext();
    const priorMessages: ChatMessage[] = lane.messages.map((message) => ({
      role: message.role === 'system' ? 'system' : message.role,
      content: message.content,
    }));
    const laneInstruction = getLanePromptPrefix(lane.role, lane.objective);
    const chatMessages: ChatMessage[] = [
      { role: 'system', content: laneInstruction },
      ...priorMessages,
      { role: 'user', content: trimmedPrompt },
    ];

    laneStore.appendLaneMessage(laneId, { role: 'user', content: trimmedPrompt });
    void persistAgentLaneMessage(lane.sessionId, lane, { role: 'user', content: trimmedPrompt });
    laneStore.setLaneStatus(laneId, 'running');
    laneStore.updateLaneTelemetry(laneId, {
      retries: lane.status === 'failed' ? lane.telemetry.retries + 1 : lane.telemetry.retries,
      rounds: lane.telemetry.rounds + 1,
    });

    let fullResponse = '';
    let lastFlushAt = 0;
    const startedAt = Date.now();

    try {
      await streamChat(config, chatMessages, {
        onToken: (token) => {
          fullResponse += token;
          const now = Date.now();
          if (now - lastFlushAt > 250) {
            laneStore.replaceLastAssistantMessage(laneId, fullResponse);
            lastFlushAt = now;
          }
        },
        onToolCall: (toolCall) => {
          laneStore.updateLaneTelemetry(laneId, { lastTool: toolCall.name });
        },
        onToolResult: (id, result) => {
          laneStore.updateLaneTelemetry(laneId, { lastTool: id });
          if (result) {
            const content = `tool ${id}: ${result.slice(0, 500)}`;
            laneStore.appendLaneMessage(laneId, {
              role: 'system',
              content,
            });
            void persistAgentLaneMessage(lane.sessionId, lane, { role: 'system', content });
          }
        },
        onUsageUpdate: (usage) => {
          laneStore.updateLaneTelemetry(laneId, {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            costCents: usage.costCents ?? lane.telemetry.costCents,
          });
        },
        onError: (error) => {
          laneStore.setLaneStatus(laneId, 'failed', error.message);
        },
        onDone: () => {
          laneStore.replaceLastAssistantMessage(laneId, fullResponse);
          if (fullResponse.trim()) {
            void persistAgentLaneMessage(lane.sessionId, lane, { role: 'assistant', content: fullResponse });
          }
          laneStore.updateLaneTelemetry(laneId, { latencyMs: Date.now() - startedAt });
        },
        onClear: () => {
          fullResponse = '';
          laneStore.replaceLastAssistantMessage(laneId, '');
        },
        onStatus: (message) => {
          if (message) {
            laneStore.appendLaneMessage(laneId, { role: 'system', content: message });
            void persistAgentLaneMessage(lane.sessionId, lane, { role: 'system', content: message });
          }
        },
      }, workspaceContext, lane.role === 'reviewer' ? 'reviewer' : 'agent');

      const finalLane = Object.values(useAgentLaneStore.getState().lanesBySession).flat().find((candidate) => candidate.id === laneId);
      if (finalLane?.status !== 'failed') {
        laneStore.setLaneStatus(laneId, fullResponse.trim() ? 'completed' : 'blocked');
      }
    } catch (error) {
      laneStore.setLaneStatus(laneId, 'failed', error instanceof Error ? error.message : String(error));
      if (!fullResponse.trim()) {
        const content = `Agent chat failed: ${error instanceof Error ? error.message : String(error)}`;
        laneStore.appendLaneMessage(laneId, { role: 'assistant', content });
        void persistAgentLaneMessage(lane.sessionId, lane, { role: 'assistant', content });
      }
    }
  }, [getWorkspaceContext]);
}
