import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useAppStore, type ModelInfo, type ChatMode } from '../../stores/appStore';
import { fetchModels, resetStaticPromptCache, type AIProvider } from '../../services/aiService';
import {
  modelPassesFilters,
  getEffectiveContextWindow,
  getExtendedContextResolutionFromSettings,
  isExtendedContextEnabled,
  showExtendedContextToggleForModel,
} from '../../utils/modelCapabilities';
import { useSwarmStore, type AgentRole } from '../../stores/swarmStore';
import { useRefactorStore } from '../../stores/refactorStore';

// Icons
const ChevronDownIcon = () => (
  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
    <path d="M7 10l5 5 5-5z" />
  </svg>
);

const SparklesIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2L9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2z" />
  </svg>
);

const BrainIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
    <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
    <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
  </svg>
);

const LightningIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M7 2v11h3v9l7-12h-4l4-8z" />
  </svg>
);

const ChatIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
  </svg>
);

const PlusIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
  </svg>
);

const LoadingIcon = () => (
  <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
  </svg>
);

// Reviewer icon
const ReviewIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
  </svg>
);

// Swarm icon
const SwarmIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
    <circle cx="8" cy="8" r="2" />
    <circle cx="16" cy="8" r="2" />
    <circle cx="12" cy="16" r="2" />
  </svg>
);

// Refactor icon (branching / extraction metaphor)
const RefactorIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M14 4l2.29 2.29-2.88 2.88 1.42 1.42 2.88-2.88L20 10V4h-6zM5.41 20L4 18.59l7.72-7.72 1.47 1.35L5.41 20z" />
    <path d="M14.59 8L4 18.59 5.41 20 16 9.41 14.59 8z" opacity="0.5" />
  </svg>
);

// Retriever icon (search)
const SearchIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
  </svg>
);

// Mode info
const MODES: { id: ChatMode; name: string; description: string; icon: React.ReactNode }[] = [
  { id: 'agent', name: 'Agent', description: 'Full AI with ATLS tools', icon: <SparklesIcon /> },
  { id: 'designer', name: 'Designer', description: 'Agentic project planner for coding', icon: <BrainIcon /> },
  { id: 'reviewer', name: 'Reviewer', description: 'Find issues & review', icon: <ReviewIcon /> },
  { id: 'retriever', name: 'Retriever', description: 'UHPP semantic search (test)', icon: <SearchIcon /> },
  { id: 'refactor', name: 'AI Refactor', description: '4-phase refactoring agent', icon: <RefactorIcon /> },
  { id: 'ask', name: 'Ask', description: 'Simple Q&A, no tools', icon: <ChatIcon /> },
  { id: 'swarm', name: 'Swarm', description: 'Multi-agent orchestration', icon: <SwarmIcon /> },
];

// Provider colors
const PROVIDER_COLORS: Record<AIProvider, string> = {
  anthropic: 'text-orange-400',
  openai: 'text-green-400',
  google: 'text-blue-400',
  vertex: 'text-purple-400',
  lmstudio: 'text-cyan-400',
};

const PROVIDER_BADGES: Record<AIProvider, string> = {
  anthropic: 'Claude',
  openai: 'GPT',
  google: 'Google AI',
  vertex: 'Vertex AI',
  lmstudio: 'LM Studio',
};

// Default cheap models per provider
const DEFAULT_SUBAGENT_MODELS: Record<AIProvider, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o-mini',
  google: 'gemini-2.0-flash',
  vertex: 'gemini-2.0-flash',
  lmstudio: 'default',
};

function SubAgentModelSelector({ models, inline }: { models: ModelInfo[]; inline?: boolean }) {
  const { settings, setSettings } = useAppStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const isDisabled = settings.subagentModel === 'none';
  const currentProvider = (settings.subagentProvider || settings.selectedProvider) as AIProvider;
  const currentModel = isDisabled ? 'none' : (settings.subagentModel || DEFAULT_SUBAGENT_MODELS[currentProvider] || 'auto');
  const displayName = isDisabled ? 'None' : currentModel === 'auto' ? 'Auto' : currentModel.split('/').pop()?.replace(/^(claude-|gpt-|gemini-)/, '') || currentModel;

  const groupedModels: Record<string, ModelInfo[]> = {};
  for (const m of models) {
    if (!groupedModels[m.provider]) groupedModels[m.provider] = [];
    groupedModels[m.provider].push(m);
  }

  return (
    <>
      {inline && <span className="text-studio-border">|</span>}
      <div className="relative" ref={ref}>
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 px-2 py-1 rounded hover:bg-studio-surface transition-colors text-studio-text text-xs"
          title="SubAgent model for retriever/design dispatch"
        >
          <span className="text-teal-400">SA:</span>
          <span className="truncate max-w-[140px]" title={isDisabled ? 'SubAgent disabled' : (currentModel === 'auto' ? 'Auto (cheapest from provider)' : (models.find(m => m.id === currentModel)?.name || currentModel))}>{displayName}</span>
          <ChevronDownIcon />
        </button>

        {open && (
          <div className="absolute bottom-full left-0 mb-1 w-56 bg-studio-surface border border-studio-border rounded-lg shadow-xl z-50 max-h-64 overflow-y-auto scrollbar-thin">
            <div className="px-3 py-2 border-b border-studio-border/50">
              <div className="text-[10px] text-studio-muted uppercase tracking-wide">SubAgent Model</div>
              <div className="text-[10px] text-studio-muted">Cheap model for retriever/design dispatch</div>
            </div>

            {/* None — disable subagent */}
            <button
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-studio-accent/10 transition-colors ${
                isDisabled ? 'bg-studio-accent/15 text-studio-accent' : 'text-studio-text'
              }`}
              onClick={() => {
                setSettings({ subagentModel: 'none', subagentProvider: '' });
                setOpen(false);
              }}
            >
              None (disabled)
            </button>

            {/* Auto option */}
            <button
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-studio-accent/10 transition-colors ${
                !isDisabled && !settings.subagentModel ? 'bg-studio-accent/15 text-studio-accent' : 'text-studio-text'
              }`}
              onClick={() => {
                setSettings({ subagentModel: '', subagentProvider: '' });
                setOpen(false);
              }}
            >
              Auto (cheapest from main provider)
            </button>

            {/* Models grouped by provider */}
            {Object.entries(groupedModels).map(([provider, providerModels]) => (
              <div key={provider}>
                <div className="px-3 py-1 text-[10px] text-studio-muted uppercase tracking-wide bg-studio-bg/50">
                  {PROVIDER_BADGES[provider as AIProvider] || provider}
                </div>
                {providerModels.map((m) => (
                  <button
                    key={m.id}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-studio-accent/10 transition-colors ${
                      settings.subagentModel === m.id ? 'bg-studio-accent/15 text-studio-accent' : 'text-studio-text'
                    }`}
                    onClick={() => {
                      setSettings({ subagentModel: m.id, subagentProvider: m.provider });
                      setOpen(false);
                    }}
                  >
                    <span className={PROVIDER_COLORS[m.provider as AIProvider]}>{m.name || m.id}</span>
                    {m.contextWindow && (
                      <span className="text-studio-muted ml-1">({(m.contextWindow / 1000).toFixed(0)}K)</span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export function ModelModeSelector() {
  const {
    settings,
    availableModels,
    setAvailableModels,
    modelsLoading,
    setModelsLoading,
    chatMode,
    setChatMode,
    selectedAgent,
    setSelectedAgent,
    customAgents,
    addCustomAgent,
  } = useAppStore();

  const {
    agentConfigs,
    setAgentConfig,
    orchestratorModel,
    orchestratorProvider,
    setOrchestratorModel,
  } = useSwarmStore();

  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [newAgent, setNewAgent] = useState({ name: '', description: '', systemPrompt: '' });
  const [swarmConfigOpen, setSwarmConfigOpen] = useState(false);
  const [refactorConfigOpen, setRefactorConfigOpen] = useState(false);

  const refactorConfig = useRefactorStore((s) => s.config);
  const setRefactorConfig = useRefactorStore((s) => s.setConfig);
  const resetRefactorConfig = useRefactorStore((s) => s.resetConfig);

  const modelRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<HTMLDivElement>(null);
  const agentRef = useRef<HTMLDivElement>(null);
  const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close menus on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
      if (modeRef.current && !modeRef.current.contains(e.target as Node)) {
        setModeMenuOpen(false);
      }
      if (agentRef.current && !agentRef.current.contains(e.target as Node)) {
        setAgentMenuOpen(false);
        setShowAddAgent(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Auto-fetch models on mount and when API keys change
  const fetchAllModels = useCallback(async () => {
    console.log('[ModelModeSelector] Fetching models...', {
      anthropicKey: settings.anthropicApiKey ? '***' + settings.anthropicApiKey.slice(-4) : 'none',
      openaiKey: settings.openaiApiKey ? '***' + settings.openaiApiKey.slice(-4) : 'none',
      googleKey: settings.googleApiKey ? '***' + settings.googleApiKey.slice(-4) : 'none',
    });
    
    setModelsLoading(true);

    const disabled = settings.disabledProviders ?? [];
    const providers = [
      { provider: 'anthropic' as const, key: settings.anthropicApiKey },
      { provider: 'openai' as const, key: settings.openaiApiKey },
      { provider: 'google' as const, key: settings.googleApiKey },
      { provider: 'vertex' as const, key: settings.vertexAccessToken, projectId: settings.vertexProjectId },
      { provider: 'lmstudio' as const, key: settings.lmstudioBaseUrl },
    ]
      .filter(({ provider }) => !disabled.includes(provider))
      .filter(({ provider, key }) => {
        if (!key) return false;
        if (provider === 'lmstudio' && key === 'http://localhost:1234') return false;
        return true;
      }) as { provider: AIProvider; key: string; projectId?: string }[];

    const results = await Promise.allSettled(
      providers.map(async ({ provider, key, projectId }) => {
        const models = await fetchModels(provider, key, projectId);
        console.log(`[ModelModeSelector] ${provider}: got ${models.length} models`);
        return models.map(m => ({ ...m, provider }));
      })
    );

    const allModels: ModelInfo[] = results.flatMap(r =>
      r.status === 'fulfilled' ? r.value : []
    );

    console.log('[ModelModeSelector] Total models:', allModels.length, allModels.map(m => m.id));
    
    if (allModels.length === 0) {
      console.log('[ModelModeSelector] No models loaded - configure a provider in settings');
    }
    setAvailableModels(allModels);
    setModelsLoading(false);
  }, [settings.disabledProviders, settings.anthropicApiKey, settings.openaiApiKey, settings.googleApiKey, settings.vertexAccessToken, settings.vertexProjectId, settings.lmstudioBaseUrl, setAvailableModels, setModelsLoading]);

  // Debounce model fetching to avoid rapid API calls when settings change
  useEffect(() => {
    // Clear any pending fetch
    if (fetchDebounceRef.current) {
      clearTimeout(fetchDebounceRef.current);
    }
    
    // Debounce by 500ms to avoid rapid re-fetches
    fetchDebounceRef.current = setTimeout(() => {
      fetchAllModels();
    }, 500);
    
    return () => {
      if (fetchDebounceRef.current) {
        clearTimeout(fetchDebounceRef.current);
      }
    };
  }, [fetchAllModels]);

  // Get current model info
  const currentModel = availableModels.find(m => m.id === settings.selectedModel);
  const currentModelName = currentModel?.name || settings.selectedModel.split('-').slice(0, 2).join(' ');
  const currentProvider = currentModel?.provider || settings.selectedProvider;

  // Get current custom agent (if any)
  const currentAgent = customAgents.find(a => a.id === selectedAgent);

  // Filter and group models by provider (includes tool-capable filter)
  const showReasoning = settings.modelFilters?.showReasoning ?? true;
  const showFast = settings.modelFilters?.showFast ?? true;
  const showHighContext = settings.modelFilters?.showHighContext ?? true;
  const showToolCapableOnly = settings.modelFilters?.showToolCapableOnly ?? true;
  const filters = { showReasoning, showFast, showHighContext, showToolCapableOnly };
  const filteredModels = useMemo(
    () => availableModels.filter((m) => modelPassesFilters(m, filters)),
    [availableModels, showReasoning, showFast, showHighContext, showToolCapableOnly]
  );
  const modelsByProvider = filteredModels.reduce((acc, model) => {
    if (!acc[model.provider]) acc[model.provider] = [];
    acc[model.provider].push(model);
    return acc;
  }, {} as Record<AIProvider, ModelInfo[]>);

  const handleSelectModel = (model: ModelInfo) => {
    useAppStore.getState().setSettings({
      selectedModel: model.id,
      selectedProvider: model.provider,
    });
    setModelMenuOpen(false);
  };

  const handleAddAgent = () => {
    if (newAgent.name && newAgent.systemPrompt) {
      addCustomAgent({
        name: newAgent.name,
        description: newAgent.description || 'Custom agent',
        systemPrompt: newAgent.systemPrompt,
        icon: '🤖',
      });
      setNewAgent({ name: '', description: '', systemPrompt: '' });
      setShowAddAgent(false);
    }
  };

  const hasAnyApiKey = settings.anthropicApiKey || settings.openaiApiKey || settings.googleApiKey || settings.vertexAccessToken || settings.lmstudioBaseUrl;

  const extendedResolution = getExtendedContextResolutionFromSettings(settings);
  const effectiveCtx = currentModel && getEffectiveContextWindow(
    currentModel.id,
    currentModel.provider,
    currentModel.contextWindow,
    extendedResolution
  );
  const contextLabel = effectiveCtx && effectiveCtx > 0
    ? (effectiveCtx >= 1000000 ? `${(effectiveCtx / 1000000).toFixed(1)}M` : `${(effectiveCtx / 1000).toFixed(0)}K`)
    : null;

  return (
    <div className="flex flex-col gap-1 px-2 py-1.5 bg-studio-bg/50 border-t border-studio-border text-xs">
      {/* Row 1: Model | Mode | Agent (when agent mode) + Context */}
      <div className="flex items-center gap-1 flex-wrap">
      {/* Model Selector */}
      <div ref={modelRef} className="relative">
        <button
          onClick={() => setModelMenuOpen(!modelMenuOpen)}
          disabled={!hasAnyApiKey}
          className={`flex items-center gap-1.5 px-2 py-1 rounded transition-colors ${
            hasAnyApiKey 
              ? 'hover:bg-studio-surface text-studio-text' 
              : 'text-studio-muted cursor-not-allowed'
          }`}
          title={hasAnyApiKey ? 'Select model' : 'Configure a provider in settings'}
        >
          {modelsLoading ? (
            <LoadingIcon />
          ) : (
            <span className={`text-[10px] font-medium px-1 py-0.5 rounded ${PROVIDER_COLORS[currentProvider]} bg-current/10`}>
              {PROVIDER_BADGES[currentProvider]}
            </span>
          )}
          {currentModel?.isReasoning && <BrainIcon />}
          {currentModel?.isFast && <LightningIcon />}
          <span className="min-w-0 max-w-[160px] truncate" title={currentModel?.name || settings.selectedModel}>{currentModelName}</span>
          <ChevronDownIcon />
        </button>

        {modelMenuOpen && (
          <div className="absolute bottom-full left-0 mb-1 w-64 max-h-80 overflow-y-auto bg-studio-surface border border-studio-border rounded-lg shadow-xl z-50">
            {Object.entries(modelsByProvider).map(([provider, models]) => {
              const prov = provider as AIProvider;
              return (
              <div key={provider}>
                <div
                  className={`px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${PROVIDER_COLORS[prov]} bg-studio-bg/50`}
                >
                  <span>{PROVIDER_BADGES[prov]}</span>
                </div>
                {models.map(model => {
                  const effectiveCtx = getEffectiveContextWindow(
                    model.id,
                    model.provider,
                    model.contextWindow,
                    extendedResolution
                  );
                  const show1mToggle = showExtendedContextToggleForModel(
                    model.id,
                    model.provider,
                    model.contextWindow
                  );
                  const extendedOn = isExtendedContextEnabled(
                    model.id,
                    prov,
                    settings.extendedContextByModelId ?? {},
                    settings.extendedContext
                  );
                  return (
                  <div
                    key={model.id}
                    className={`flex items-stretch w-full gap-0 border-b border-studio-border/50 last:border-b-0 ${
                      model.id === settings.selectedModel ? 'bg-studio-accent/10 text-studio-accent' : ''
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleSelectModel(model)}
                      className="flex-1 min-w-0 px-3 py-2 text-left hover:bg-studio-accent/20 transition-colors flex items-center justify-between gap-1"
                    >
                      <span className="flex items-center gap-1.5 min-w-0">
                        {model.isReasoning && <BrainIcon />}
                        {model.isFast && <LightningIcon />}
                        <span className="truncate">{model.name}</span>
                      </span>
                      {effectiveCtx != null && effectiveCtx > 0 && (
                        <span className="text-[10px] text-studio-muted shrink-0">
                          {effectiveCtx >= 1000000
                            ? `${(effectiveCtx / 1000000).toFixed(1)}M`
                            : `${(effectiveCtx / 1000).toFixed(0)}K`}
                        </span>
                      )}
                    </button>
                    {show1mToggle && (
                      <label
                        className="flex items-center gap-1 px-2 py-2 shrink-0 cursor-pointer border-l border-studio-border/50 bg-studio-bg/30 text-studio-muted hover:text-studio-text"
                        onClick={(e) => e.stopPropagation()}
                        title="Use 1M context (when model supports it)"
                      >
                        <input
                          type="checkbox"
                          checked={extendedOn}
                          onChange={(e) => {
                            useAppStore.getState().setSettings({
                              extendedContextByModelId: {
                                ...settings.extendedContextByModelId,
                                [model.id]: e.target.checked,
                              },
                            });
                          }}
                          className="rounded border-studio-border"
                        />
                        <span className="text-[10px]">1M</span>
                      </label>
                    )}
                  </div>
                );
                })}
              </div>
            );
            })}
            {filteredModels.length === 0 && (
              <div className="px-3 py-4 text-center text-studio-muted">
                No models available. Configure a provider in settings.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Entry Manifest depth selector (next to model selector) */}
      {chatMode !== 'ask' && chatMode !== 'swarm' && (() => {
        const depth = settings.entryManifestDepth ?? 'sigs';
        const setDepth = (d: 'off' | 'paths' | 'sigs') => {
          useAppStore.getState().setSettings({ entryManifestDepth: d });
          resetStaticPromptCache();
        };
        const levels = [
          { id: 'off' as const, label: 'Off', title: 'Entry manifest OFF — saves context budget' },
          { id: 'paths' as const, label: 'Paths', title: 'Entry manifest: file paths only (~50-100 tokens)' },
          { id: 'sigs' as const, label: 'Sigs', title: 'Entry manifest: full signatures (~200tk/file)' },
        ];
        return (
          <>
            <span className="text-studio-border">|</span>
            <div className="flex items-center gap-1" title="Entry manifest depth">
              <span className="text-[10px] text-studio-muted">EM</span>
              <div className="flex rounded overflow-hidden border border-studio-border/60">
                {levels.map(l => (
                  <button
                    key={l.id}
                    onClick={() => setDepth(l.id)}
                    title={l.title}
                    className={`px-1.5 py-0.5 text-[9px] font-medium transition-colors ${
                      depth === l.id
                        ? l.id === 'sigs' ? 'bg-emerald-500/80 text-white'
                          : l.id === 'paths' ? 'bg-amber-500/80 text-white'
                          : 'bg-studio-border text-studio-text'
                        : 'bg-studio-surface/30 text-studio-muted hover:bg-studio-surface'
                    }`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        );
      })()}

      {/* Swarm Configuration (only in swarm mode) */}
      {chatMode === 'swarm' && (
        <>
          <span className="text-studio-border">|</span>
          <button
            onClick={() => setSwarmConfigOpen(true)}
            className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-studio-surface transition-colors text-studio-text"
            title="Configure swarm agents"
          >
            <span>⚙️</span>
            <span>Config</span>
          </button>

          {/* Swarm Config Modal - Centered */}
          {swarmConfigOpen && (
            <div 
              className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
              onClick={(e) => {
                if (e.target === e.currentTarget) setSwarmConfigOpen(false);
              }}
            >
              <div className="bg-studio-surface border border-studio-border rounded-lg shadow-xl w-96 max-h-[80vh] overflow-hidden flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-studio-border bg-studio-bg">
                  <div>
                    <div className="text-sm font-medium text-studio-title">🐝 Swarm Configuration</div>
                    <div className="text-xs text-studio-muted">Assign models to agent roles</div>
                  </div>
                  <button
                    onClick={() => setSwarmConfigOpen(false)}
                    className="p-1 hover:bg-studio-border rounded text-studio-muted hover:text-studio-text"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                    </svg>
                  </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto">
                  {/* Orchestrator */}
                  <div className="px-4 py-3 border-b border-studio-border bg-yellow-500/5">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-yellow-400">🎯 Orchestrator</span>
                      <span className="text-xs text-studio-muted">Plans & coordinates</span>
                    </div>
                    <select
                      value={`${orchestratorProvider}:${orchestratorModel}`}
                      onChange={(e) => {
                        const [provider, model] = e.target.value.split(':');
                        setOrchestratorModel(model, provider as AIProvider);
                      }}
                      className="w-full px-3 py-2 bg-studio-bg border border-studio-border rounded text-sm"
                    >
                      {availableModels.map(m => (
                        <option key={m.id} value={`${m.provider}:${m.id}`}>
                          {PROVIDER_BADGES[m.provider]} - {m.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Agent Roles */}
                  {agentConfigs.filter(c => c.role !== 'orchestrator').map(config => {
                    const roleIcons: Record<AgentRole, string> = {
                      orchestrator: '🎯',
                      coder: '💻',
                      debugger: '🔧',
                      reviewer: '👁️',
                      tester: '🧪',
                      documenter: '📝',
                    };
                    const roleDescriptions: Record<AgentRole, string> = {
                      orchestrator: 'Plans & coordinates',
                      coder: 'Writes code',
                      debugger: 'Fixes bugs',
                      reviewer: 'Reviews code',
                      tester: 'Writes tests',
                      documenter: 'Writes docs',
                    };

                    return (
                      <div key={config.role} className="px-4 py-3 border-b border-studio-border last:border-b-0">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-medium text-studio-text capitalize">
                            {roleIcons[config.role]} {config.role}
                          </span>
                          <span className="text-xs text-studio-muted">{roleDescriptions[config.role]}</span>
                        </div>
                        <select
                          value={`${config.provider}:${config.model}`}
                          onChange={(e) => {
                            const [provider, model] = e.target.value.split(':');
                            setAgentConfig(config.role, { model, provider: provider as AIProvider });
                          }}
                          className="w-full px-3 py-2 bg-studio-bg border border-studio-border rounded text-sm"
                        >
                          {availableModels.map(m => (
                            <option key={m.id} value={`${m.provider}:${m.id}`}>
                              {PROVIDER_BADGES[m.provider]} - {m.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>

                {/* Footer */}
                <div className="px-4 py-3 border-t border-studio-border bg-studio-bg/50">
                  <div className="text-xs text-studio-muted mb-3">
                    💡 Tip: Use powerful models (Opus/GPT-4) for orchestrator, faster models for workers
                  </div>
                  <button
                    onClick={() => setSwarmConfigOpen(false)}
                    className="w-full px-4 py-2 bg-studio-accent-bright text-studio-bg rounded text-sm font-medium hover:bg-studio-accent"
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Refactor Configuration (only in refactor mode) */}
      {chatMode === 'refactor' && (
        <>
          <span className="text-studio-border">|</span>
          <button
            onClick={() => setRefactorConfigOpen(true)}
            className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-studio-surface transition-colors text-studio-text"
            title="Configure refactoring thresholds"
          >
            <span>⚙️</span>
            <span>Config</span>
          </button>

          {/* Refactor Config Modal */}
          {refactorConfigOpen && (
            <div
              className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
              onClick={(e) => {
                if (e.target === e.currentTarget) setRefactorConfigOpen(false);
              }}
            >
              <div className="bg-studio-surface border border-studio-border rounded-lg shadow-xl w-[440px] max-h-[80vh] overflow-hidden flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-studio-border bg-studio-bg">
                  <div>
                    <div className="text-sm font-medium text-studio-title">🔄 AI Refactor Configuration</div>
                    <div className="text-xs text-studio-muted">Thresholds and safety settings</div>
                  </div>
                  <button
                    onClick={() => setRefactorConfigOpen(false)}
                    className="p-1 hover:bg-studio-border rounded text-studio-muted hover:text-studio-text"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                    </svg>
                  </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  {/* File Size Targets */}
                  <div>
                    <div className="text-xs font-semibold text-studio-title uppercase tracking-wider mb-2">File Size Targets</div>
                    <div className="grid grid-cols-3 gap-3">
                      <label className="block">
                        <span className="text-[10px] text-studio-muted">Max Lines</span>
                        <input
                          type="number"
                          value={refactorConfig.maxFileLines}
                          onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setRefactorConfig({ maxFileLines: v }); }}
                          className="w-full mt-0.5 px-2 py-1.5 bg-studio-bg border border-studio-border rounded text-sm"
                        />
                      </label>
                      <label className="block">
                        <span className="text-[10px] text-studio-muted">Target Lines</span>
                        <input
                          type="number"
                          value={refactorConfig.targetFileLines}
                          onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setRefactorConfig({ targetFileLines: v }); }}
                          className="w-full mt-0.5 px-2 py-1.5 bg-studio-bg border border-studio-border rounded text-sm"
                        />
                      </label>
                      <label className="block">
                        <span className="text-[10px] text-studio-muted">Max Method</span>
                        <input
                          type="number"
                          value={refactorConfig.maxMethodLines}
                          onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setRefactorConfig({ maxMethodLines: v }); }}
                          className="w-full mt-0.5 px-2 py-1.5 bg-studio-bg border border-studio-border rounded text-sm"
                        />
                      </label>
                    </div>
                  </div>

                  {/* Complexity Thresholds */}
                  <div>
                    <div className="text-xs font-semibold text-studio-title uppercase tracking-wider mb-2">Complexity Thresholds</div>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="block">
                        <span className="text-[10px] text-studio-muted">Min Complexity to Extract</span>
                        <input
                          type="number"
                          value={refactorConfig.minComplexityForExtraction}
                          onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setRefactorConfig({ minComplexityForExtraction: v }); }}
                          className="w-full mt-0.5 px-2 py-1.5 bg-studio-bg border border-studio-border rounded text-sm"
                        />
                      </label>
                      <label className="block">
                        <span className="text-[10px] text-studio-muted">High Priority Threshold</span>
                        <input
                          type="number"
                          value={refactorConfig.highComplexityThreshold}
                          onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setRefactorConfig({ highComplexityThreshold: v }); }}
                          className="w-full mt-0.5 px-2 py-1.5 bg-studio-bg border border-studio-border rounded text-sm"
                        />
                      </label>
                    </div>
                  </div>

                  {/* Strategy Thresholds */}
                  <div>
                    <div className="text-xs font-semibold text-studio-title uppercase tracking-wider mb-2">Strategy Auto-Select</div>
                    <div className="space-y-2">
                      <div className="p-2 bg-studio-bg/50 rounded border border-studio-border">
                        <div className="text-xs font-medium text-green-400 mb-1">Feature Extraction (low risk)</div>
                        <div className="grid grid-cols-3 gap-2">
                          <label className="block">
                            <span className="text-[10px] text-studio-muted">Max Lines</span>
                            <input type="number" value={refactorConfig.featureExtractionMaxLines}
                              onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setRefactorConfig({ featureExtractionMaxLines: v }); }}
                              className="w-full mt-0.5 px-2 py-1 bg-studio-bg border border-studio-border rounded text-xs" />
                          </label>
                          <label className="block">
                            <span className="text-[10px] text-studio-muted">Max Complexity</span>
                            <input type="number" value={refactorConfig.featureExtractionMaxComplexity}
                              onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setRefactorConfig({ featureExtractionMaxComplexity: v }); }}
                              className="w-full mt-0.5 px-2 py-1 bg-studio-bg border border-studio-border rounded text-xs" />
                          </label>
                          <label className="block">
                            <span className="text-[10px] text-studio-muted">Max Dependents</span>
                            <input type="number" value={refactorConfig.featureExtractionMaxDependents}
                              onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setRefactorConfig({ featureExtractionMaxDependents: v }); }}
                              className="w-full mt-0.5 px-2 py-1 bg-studio-bg border border-studio-border rounded text-xs" />
                          </label>
                        </div>
                      </div>
                      <div className="p-2 bg-studio-bg/50 rounded border border-studio-border">
                        <div className="text-xs font-medium text-yellow-400 mb-1">Layer Extraction (medium risk)</div>
                        <div className="grid grid-cols-3 gap-2">
                          <label className="block">
                            <span className="text-[10px] text-studio-muted">Max Lines</span>
                            <input type="number" value={refactorConfig.layerExtractionMaxLines}
                              onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setRefactorConfig({ layerExtractionMaxLines: v }); }}
                              className="w-full mt-0.5 px-2 py-1 bg-studio-bg border border-studio-border rounded text-xs" />
                          </label>
                          <label className="block">
                            <span className="text-[10px] text-studio-muted">Max Complexity</span>
                            <input type="number" value={refactorConfig.layerExtractionMaxComplexity}
                              onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setRefactorConfig({ layerExtractionMaxComplexity: v }); }}
                              className="w-full mt-0.5 px-2 py-1 bg-studio-bg border border-studio-border rounded text-xs" />
                          </label>
                          <label className="block">
                            <span className="text-[10px] text-studio-muted">Max Dependents</span>
                            <input type="number" value={refactorConfig.layerExtractionMaxDependents}
                              onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setRefactorConfig({ layerExtractionMaxDependents: v }); }}
                              className="w-full mt-0.5 px-2 py-1 bg-studio-bg border border-studio-border rounded text-xs" />
                          </label>
                        </div>
                      </div>
                      <div className="p-2 bg-studio-bg/50 rounded border border-studio-border">
                        <div className="text-xs font-medium text-red-400">Multi-Phase (high risk)</div>
                        <div className="text-[10px] text-studio-muted mt-0.5">Anything above layer thresholds — extracted in safe increments</div>
                      </div>
                    </div>
                  </div>

                  {/* Safety Settings */}
                  <div>
                    <div className="text-xs font-semibold text-studio-title uppercase tracking-wider mb-2">Safety Settings</div>
                    <div className="space-y-1.5">
                      {([
                        ['requirePlanReview', 'Review edit plan before applying'],
                        ['verifyAfterEach', 'Verify (typecheck + test) after each extraction'],
                        ['commitAfterSuccess', 'Commit atomically after success'],
                        ['rollbackOnFailure', 'Hash-based rollback on verification failure'],
                        ['requireReviewForPublicAPI', 'Require confirmation for public API changes'],
                      ] as [keyof typeof refactorConfig, string][]).map(([key, label]) => (
                        <label key={key} className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={refactorConfig[key] as boolean}
                            onChange={(e) => setRefactorConfig({ [key]: e.target.checked })}
                            className="rounded border-studio-border bg-studio-bg text-studio-accent"
                          />
                          <span className="text-xs text-studio-text">{label}</span>
                        </label>
                      ))}
                      <label className="flex items-center gap-2 mt-2">
                        <span className="text-[10px] text-studio-muted">Max dependents for auto-approve:</span>
                        <input
                          type="number"
                          value={refactorConfig.maxDependentsForAutomatic}
                          onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setRefactorConfig({ maxDependentsForAutomatic: v }); }}
                          className="w-16 px-2 py-1 bg-studio-bg border border-studio-border rounded text-xs"
                        />
                      </label>
                    </div>
                  </div>
                </div>

                {/* Footer */}
                <div className="px-4 py-3 border-t border-studio-border bg-studio-bg/50 flex items-center gap-2">
                  <button
                    onClick={resetRefactorConfig}
                    className="px-3 py-1.5 text-xs text-studio-muted hover:text-studio-text bg-studio-surface rounded border border-studio-border"
                  >
                    Reset Defaults
                  </button>
                  <div className="flex-1" />
                  <button
                    onClick={() => setRefactorConfigOpen(false)}
                    className="px-4 py-2 bg-studio-accent-bright text-studio-bg rounded text-sm font-medium hover:bg-studio-accent"
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      <span className="text-studio-border">|</span>

      {/* Mode (Agent) Selector — next to context window */}
      <div ref={modeRef} className="relative">
        <button
          onClick={() => setModeMenuOpen(!modeMenuOpen)}
          className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-studio-surface transition-colors text-studio-text"
        >
          {MODES.find(m => m.id === chatMode)?.icon}
          <span className="truncate max-w-[80px]">{MODES.find(m => m.id === chatMode)?.name}</span>
          <ChevronDownIcon />
        </button>

        {modeMenuOpen && (
          <div className="absolute bottom-full right-0 mb-1 w-48 bg-studio-surface border border-studio-border rounded-lg shadow-xl z-50">
            {MODES.map(mode => (
              <button
                key={mode.id}
                onClick={() => {
                  setChatMode(mode.id);
                  setModeMenuOpen(false);
                }}
                className={`w-full px-3 py-2 text-left hover:bg-studio-accent/20 transition-colors flex items-center gap-2 ${
                  mode.id === chatMode ? 'bg-studio-accent/10 text-studio-accent' : ''
                }`}
              >
                {mode.icon}
                <div>
                  <div className="font-medium">{mode.name}</div>
                  <div className="text-[10px] text-studio-muted">{mode.description}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Custom Agent dropdown + Context */}
      {chatMode === 'agent' && (customAgents.length > 0 || agentMenuOpen) && (
        <>
          <span className="text-studio-border">|</span>
          <div ref={agentRef} className="relative">
            <button
              onClick={() => setAgentMenuOpen(!agentMenuOpen)}
              className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-studio-surface transition-colors text-studio-text"
              title="Custom instructions"
            >
              {currentAgent ? (
                <>
                  <span>{currentAgent.icon}</span>
                  <span className="truncate max-w-[100px]">{currentAgent.name}</span>
                </>
              ) : (
                <>
                  <PlusIcon />
                  <span className="text-studio-muted">Custom</span>
                </>
              )}
              <ChevronDownIcon />
            </button>

            {agentMenuOpen && (
              <div className="absolute bottom-full right-0 mb-1 w-56 bg-studio-surface border border-studio-border rounded-lg shadow-xl z-50 max-h-80 overflow-y-auto">
                {currentAgent && (
                  <button
                    onClick={() => { setSelectedAgent(''); setAgentMenuOpen(false); }}
                    className="w-full px-3 py-2 text-left hover:bg-studio-accent/20 transition-colors flex items-center gap-2 text-studio-muted border-b border-studio-border"
                  >
                    <span>✕</span>
                    <span>Use default (no custom)</span>
                  </button>
                )}
                {customAgents.length > 0 && customAgents.map(agent => (
                  <button
                    key={agent.id}
                    onClick={() => { setSelectedAgent(agent.id); setAgentMenuOpen(false); }}
                    className={`w-full px-3 py-2 text-left hover:bg-studio-accent/20 transition-colors flex items-center gap-2 ${agent.id === selectedAgent ? 'bg-studio-accent/10 text-studio-accent' : ''}`}
                  >
                    <span>{agent.icon}</span>
                    <div className="min-w-0">
                      <div className="font-medium truncate">{agent.name}</div>
                      <div className="text-[10px] text-studio-muted truncate">{agent.description}</div>
                    </div>
                  </button>
                ))}
                <div className={customAgents.length > 0 ? 'border-t border-studio-border' : ''}>
                  {!showAddAgent ? (
                    <button
                      onClick={() => setShowAddAgent(true)}
                      className="w-full px-3 py-2 text-left hover:bg-studio-accent/20 transition-colors flex items-center gap-2 text-studio-accent"
                    >
                      <PlusIcon />
                      <span>Add Custom Instructions</span>
                    </button>
                  ) : (
                    <div className="p-3 space-y-2">
                      <input
                        type="text"
                        placeholder="Name (e.g., 'TypeScript Expert')"
                        value={newAgent.name}
                        onChange={(e) => setNewAgent(prev => ({ ...prev, name: e.target.value }))}
                        className="w-full px-2 py-1 bg-studio-bg border border-studio-border rounded text-xs"
                      />
                      <input
                        type="text"
                        placeholder="Description (optional)"
                        value={newAgent.description}
                        onChange={(e) => setNewAgent(prev => ({ ...prev, description: e.target.value }))}
                        className="w-full px-2 py-1 bg-studio-bg border border-studio-border rounded text-xs"
                      />
                      <textarea
                        placeholder="Custom instructions to add to system prompt..."
                        value={newAgent.systemPrompt}
                        onChange={(e) => setNewAgent(prev => ({ ...prev, systemPrompt: e.target.value }))}
                        className="w-full px-2 py-1 bg-studio-bg border border-studio-border rounded text-xs h-20 resize-none"
                      />
                      <div className="flex gap-2">
                        <button onClick={() => { setShowAddAgent(false); if (customAgents.length === 0) setAgentMenuOpen(false); }} className="flex-1 px-2 py-1 text-studio-muted hover:text-studio-text">Cancel</button>
                        <button onClick={handleAddAgent} disabled={!newAgent.name || !newAgent.systemPrompt} className="flex-1 px-2 py-1 bg-studio-accent-bright text-studio-bg rounded disabled:opacity-50">Add</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}
      {contextLabel && (
        <span className="text-[10px] text-studio-muted">{contextLabel} context</span>
      )}
      </div>

      {/* Row 2: SubAgent in selection box (agent/designer mode) */}
      {(chatMode === 'agent' || chatMode === 'designer') && (
        <div className="border border-studio-border/60 rounded px-2 py-1 bg-studio-surface/30 flex items-center">
          <SubAgentModelSelector models={availableModels} inline={false} />
        </div>
      )}
    </div>
  );
}
