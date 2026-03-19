import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore, type Settings as SettingsType, type AIProvider } from '../../stores/appStore';
import { fetchModels } from '../../services/aiService';
import { CloseIcon, RefreshIcon } from '../icons';

// Icons

const EyeIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
  </svg>
);

const EyeOffIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z" />
  </svg>
);


const CheckIcon = () => (
  <svg className="w-4 h-4 text-studio-success" viewBox="0 0 24 24" fill="currentColor">
    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
  </svg>
);

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
}

export function Settings({ isOpen, onClose }: SettingsProps) {
  const { settings, setSettings, setAvailableModels, setModelsLoading } = useAppStore();
  
  const [localSettings, setLocalSettings] = useState<SettingsType>({ ...settings });
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = useState<'ai' | 'models' | 'chat' | 'about'>('ai');
  const [testingProvider, setTestingProvider] = useState<AIProvider | null>(null);
  const [testResults, setTestResults] = useState<Record<AIProvider, 'success' | 'error' | null>>({
    anthropic: null,
    openai: null,
    google: null,
    vertex: null,
    lmstudio: null,
  });

  // Load settings on open
  useEffect(() => {
    if (isOpen) {
      setLocalSettings({ ...settings });
      setTestResults({ anthropic: null, openai: null, google: null, vertex: null, lmstudio: null });
    }
  }, [settings, isOpen]);

  const toggleShowKey = (key: string) => {
    setShowKeys(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const isProviderEnabled = (provider: AIProvider) =>
    !localSettings.disabledProviders?.includes(provider);
  const toggleProviderEnabled = (provider: AIProvider) => {
    const disabled = localSettings.disabledProviders ?? [];
    const next = disabled.includes(provider)
      ? disabled.filter(p => p !== provider)
      : [...disabled, provider];
    setLocalSettings(prev => ({ ...prev, disabledProviders: next }));
  };

  // Reset test result when credentials change so auto-test can re-fire
  const prevCreds = useRef({ a: '', o: '', g: '', vt: '', vp: '', vr: '', lm: '' });
  useEffect(() => {
    const cur = {
      a: localSettings.anthropicApiKey,
      o: localSettings.openaiApiKey,
      g: localSettings.googleApiKey,
      vt: localSettings.vertexAccessToken,
      vp: localSettings.vertexProjectId,
      vr: localSettings.vertexRegion,
      lm: localSettings.lmstudioBaseUrl,
    };
    const prev = prevCreds.current;
    const resets: Partial<Record<AIProvider, null>> = {};
    if (cur.a !== prev.a) resets.anthropic = null;
    if (cur.o !== prev.o) resets.openai = null;
    if (cur.g !== prev.g) resets.google = null;
    if (cur.vt !== prev.vt || cur.vp !== prev.vp || cur.vr !== prev.vr) resets.vertex = null;
    if (cur.lm !== prev.lm) resets.lmstudio = null;
    if (Object.keys(resets).length > 0) {
      setTestResults(r => ({ ...r, ...resets }));
    }
    prevCreds.current = cur;
  }, [
    localSettings.anthropicApiKey,
    localSettings.openaiApiKey,
    localSettings.googleApiKey,
    localSettings.vertexAccessToken,
    localSettings.vertexProjectId,
    localSettings.vertexRegion,
    localSettings.lmstudioBaseUrl,
  ]);

  // Debounced auto-test: fire when credentials look complete
  const autoTestTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    if (!isOpen) return;

    const providers = [
      { provider: 'anthropic' as const, ready: localSettings.anthropicApiKey.length > 10 },
      { provider: 'openai' as const, ready: localSettings.openaiApiKey.length > 10 },
      { provider: 'google' as const, ready: localSettings.googleApiKey.length > 10 },
      { provider: 'vertex' as const, ready: localSettings.vertexAccessToken.length > 10 && localSettings.vertexProjectId.length > 1 },
      { provider: 'lmstudio' as const, ready: localSettings.lmstudioBaseUrl.length > 5 },
    ].filter(p => isProviderEnabled(p.provider)) as { provider: AIProvider; ready: boolean }[];

    for (const { provider, ready } of providers) {
      clearTimeout(autoTestTimers.current[provider]);

      if (ready && testResults[provider] === null && testingProvider !== provider) {
        autoTestTimers.current[provider] = setTimeout(() => {
          testApiKeyRef.current(provider);
        }, 800);
      }
    }

    return () => {
      Object.values(autoTestTimers.current).forEach(clearTimeout);
    };
  }, [
    isOpen,
    localSettings.disabledProviders,
    localSettings.anthropicApiKey,
    localSettings.openaiApiKey,
    localSettings.googleApiKey,
    localSettings.vertexAccessToken,
    localSettings.vertexProjectId,
    localSettings.vertexRegion,
    localSettings.lmstudioBaseUrl,
    testResults,
    testingProvider,
  ]);

  // Test API key by fetching models
  const testApiKey = useCallback(async (provider: AIProvider) => {
    const keyMap: Record<AIProvider, string> = {
      anthropic: localSettings.anthropicApiKey,
      openai: localSettings.openaiApiKey,
      google: localSettings.googleApiKey,
      vertex: localSettings.vertexAccessToken,
      lmstudio: localSettings.lmstudioBaseUrl,
    };
    
    const key = keyMap[provider];
    if (!key) return;

    setTestingProvider(provider);
    try {
      const models = await fetchModels(provider, key, localSettings.vertexProjectId, localSettings.vertexRegion);
      if (models.length > 0) {
        setTestResults(prev => ({ ...prev, [provider]: 'success' }));
      } else {
        setTestResults(prev => ({ ...prev, [provider]: 'error' }));
      }
    } catch {
      setTestResults(prev => ({ ...prev, [provider]: 'error' }));
    } finally {
      setTestingProvider(null);
    }
  }, [localSettings]);

  const testApiKeyRef = useRef(testApiKey);
  testApiKeyRef.current = testApiKey;

  // Refresh all models in the store (only enabled providers)
  const refreshAllModels = useCallback(async () => {
    setModelsLoading(true);
    const allModels: any[] = [];

    const providers = [
      { provider: 'anthropic' as const, key: localSettings.anthropicApiKey },
      { provider: 'openai' as const, key: localSettings.openaiApiKey },
      { provider: 'google' as const, key: localSettings.googleApiKey },
      { provider: 'vertex' as const, key: localSettings.vertexAccessToken },
      { provider: 'lmstudio' as const, key: localSettings.lmstudioBaseUrl },
    ].filter(p => isProviderEnabled(p.provider)) as { provider: AIProvider; key: string }[];

    for (const { provider, key } of providers) {
      if (key) {
        try {
          const models = await fetchModels(provider, key, localSettings.vertexProjectId, localSettings.vertexRegion);
          allModels.push(...models.map(m => ({ ...m, provider })));
        } catch (e) {
          console.error(`Failed to fetch ${provider} models:`, e);
        }
      }
    }

    // If no keys/ no models and Anthropic enabled, add anthropic defaults
    if (allModels.length === 0 && isProviderEnabled('anthropic')) {
      const defaults = await fetchModels('anthropic', '', undefined);
      allModels.push(...defaults.map(m => ({ ...m, provider: 'anthropic' as AIProvider })));
    }

    setAvailableModels(allModels);
    setModelsLoading(false);
  }, [localSettings, setAvailableModels, setModelsLoading]);

  const handleSave = async () => {
    console.log('[Settings] Saving settings...', {
      anthropicKey: localSettings.anthropicApiKey ? '***' + localSettings.anthropicApiKey.slice(-4) : 'none',
      openaiKey: localSettings.openaiApiKey ? '***' + localSettings.openaiApiKey.slice(-4) : 'none',
    });
    setSettings(localSettings);
    // Refresh models with new API keys
    await refreshAllModels();
    console.log('[Settings] Models refreshed');
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-studio-surface border border-studio-border rounded-lg shadow-2xl w-[550px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-studio-border">
          <h2 className="text-lg font-semibold text-studio-title flex items-center gap-2">
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
            </svg>
            Settings
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-studio-border rounded transition-colors">
            <CloseIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-studio-border">
          {(['ai', 'models', 'chat', 'about'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm capitalize transition-colors ${
                activeTab === tab
                  ? 'text-studio-accent border-b-2 border-studio-accent'
                  : 'text-studio-muted hover:text-studio-text'
              }`}
            >
              {tab === 'ai' ? 'Providers' : tab === 'models' ? 'Models' : tab}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 scrollbar-thin">
          {activeTab === 'ai' && (
            <div className="space-y-4">
              <p className="text-sm text-studio-muted mb-4">
                Configure your AI providers. Credentials are stored locally and never sent to our servers.
              </p>

              {/* Anthropic */}
              <div className={`p-3 bg-studio-bg/50 rounded-lg ${!isProviderEnabled('anthropic') ? 'opacity-60' : ''}`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">Anthropic</span>
                    <span className="text-xs text-studio-muted">Claude models</span>
                    <button
                      onClick={() => toggleProviderEnabled('anthropic')}
                      className={`w-10 h-5 rounded-full transition-colors flex-shrink-0 ${
                        isProviderEnabled('anthropic') ? 'bg-studio-accent' : 'bg-studio-border'
                      }`}
                      title={isProviderEnabled('anthropic') ? 'Disable provider' : 'Enable provider'}
                    >
                      <div className={`w-4 h-4 bg-white rounded-full shadow transition-transform m-0.5 ${
                        isProviderEnabled('anthropic') ? 'translate-x-5' : 'translate-x-0'
                      }`} />
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    {testResults.anthropic === 'success' && <CheckIcon />}
                    {testResults.anthropic === 'error' && <span className="text-xs text-studio-error">Invalid</span>}
                    <button
                      onClick={() => testApiKey('anthropic')}
                      disabled={!localSettings.anthropicApiKey || testingProvider === 'anthropic'}
                      className={`p-1.5 rounded transition-colors ${
                        localSettings.anthropicApiKey 
                          ? 'text-studio-accent hover:bg-studio-accent/20' 
                          : 'text-studio-muted/50'
                      } disabled:cursor-not-allowed`}
                      title="Test API key"
                    >
                      {testingProvider === 'anthropic' ? (
                        <div className="w-4 h-4 border-2 border-studio-accent border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <RefreshIcon />
                      )}
                    </button>
                  </div>
                </div>
                <div className="relative">
                  <input
                    type={showKeys.anthropic ? 'text' : 'password'}
                    value={localSettings.anthropicApiKey}
                    onChange={(e) => setLocalSettings(prev => ({ ...prev, anthropicApiKey: e.target.value }))}
                    placeholder="sk-ant-..."
                    className="w-full px-3 py-2 pr-10 bg-studio-bg border border-studio-border rounded focus:outline-none focus:border-studio-accent font-mono text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => toggleShowKey('anthropic')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-studio-muted hover:text-studio-text"
                  >
                    {showKeys.anthropic ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
                <p className="text-xs text-studio-muted mt-1">Get key: console.anthropic.com</p>
              </div>

              {/* OpenAI */}
              <div className={`p-3 bg-studio-bg/50 rounded-lg ${!isProviderEnabled('openai') ? 'opacity-60' : ''}`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">OpenAI</span>
                    <span className="text-xs text-studio-muted">GPT-4, o1 models</span>
                    <button
                      onClick={() => toggleProviderEnabled('openai')}
                      className={`w-10 h-5 rounded-full transition-colors flex-shrink-0 ${
                        isProviderEnabled('openai') ? 'bg-studio-accent' : 'bg-studio-border'
                      }`}
                      title={isProviderEnabled('openai') ? 'Disable provider' : 'Enable provider'}
                    >
                      <div className={`w-4 h-4 bg-white rounded-full shadow transition-transform m-0.5 ${
                        isProviderEnabled('openai') ? 'translate-x-5' : 'translate-x-0'
                      }`} />
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    {testResults.openai === 'success' && <CheckIcon />}
                    {testResults.openai === 'error' && <span className="text-xs text-studio-error">Invalid</span>}
                    <button
                      onClick={() => testApiKey('openai')}
                      disabled={!localSettings.openaiApiKey || testingProvider === 'openai'}
                      className={`p-1.5 rounded transition-colors ${
                        localSettings.openaiApiKey 
                          ? 'text-studio-accent hover:bg-studio-accent/20' 
                          : 'text-studio-muted/50'
                      } disabled:cursor-not-allowed`}
                      title="Test API key"
                    >
                      {testingProvider === 'openai' ? (
                        <div className="w-4 h-4 border-2 border-studio-accent border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <RefreshIcon />
                      )}
                    </button>
                  </div>
                </div>
                <div className="relative">
                  <input
                    type={showKeys.openai ? 'text' : 'password'}
                    value={localSettings.openaiApiKey}
                    onChange={(e) => setLocalSettings(prev => ({ ...prev, openaiApiKey: e.target.value }))}
                    placeholder="sk-..."
                    className="w-full px-3 py-2 pr-10 bg-studio-bg border border-studio-border rounded focus:outline-none focus:border-studio-accent font-mono text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => toggleShowKey('openai')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-studio-muted hover:text-studio-text"
                  >
                    {showKeys.openai ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
                <p className="text-xs text-studio-muted mt-1">Get key: platform.openai.com</p>
              </div>

              {/* Google AI */}
              <div className={`p-3 bg-studio-bg/50 rounded-lg ${!isProviderEnabled('google') ? 'opacity-60' : ''}`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">Google AI</span>
                    <span className="text-xs text-studio-muted">Gemini models</span>
                    <button
                      onClick={() => toggleProviderEnabled('google')}
                      className={`w-10 h-5 rounded-full transition-colors flex-shrink-0 ${
                        isProviderEnabled('google') ? 'bg-studio-accent' : 'bg-studio-border'
                      }`}
                      title={isProviderEnabled('google') ? 'Disable provider' : 'Enable provider'}
                    >
                      <div className={`w-4 h-4 bg-white rounded-full shadow transition-transform m-0.5 ${
                        isProviderEnabled('google') ? 'translate-x-5' : 'translate-x-0'
                      }`} />
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    {testResults.google === 'success' && <CheckIcon />}
                    {testResults.google === 'error' && <span className="text-xs text-studio-error">Invalid</span>}
                    <button
                      onClick={() => testApiKey('google')}
                      disabled={!localSettings.googleApiKey || testingProvider === 'google'}
                      className={`p-1.5 rounded transition-colors ${
                        localSettings.googleApiKey 
                          ? 'text-studio-accent hover:bg-studio-accent/20' 
                          : 'text-studio-muted/50'
                      } disabled:cursor-not-allowed`}
                      title="Test API key"
                    >
                      {testingProvider === 'google' ? (
                        <div className="w-4 h-4 border-2 border-studio-accent border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <RefreshIcon />
                      )}
                    </button>
                  </div>
                </div>
                <div className="relative">
                  <input
                    type={showKeys.google ? 'text' : 'password'}
                    value={localSettings.googleApiKey}
                    onChange={(e) => setLocalSettings(prev => ({ ...prev, googleApiKey: e.target.value }))}
                    placeholder="AIza..."
                    className="w-full px-3 py-2 pr-10 bg-studio-bg border border-studio-border rounded focus:outline-none focus:border-studio-accent font-mono text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => toggleShowKey('google')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-studio-muted hover:text-studio-text"
                  >
                    {showKeys.google ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
                <p className="text-xs text-studio-muted mt-1">Get key: aistudio.google.com</p>
              </div>

              {/* Vertex AI */}
              <div className={`p-3 bg-studio-bg/50 rounded-lg ${!isProviderEnabled('vertex') ? 'opacity-60' : ''}`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">Vertex AI</span>
                    <span className="text-xs text-studio-muted">Google Cloud</span>
                    <button
                      onClick={() => toggleProviderEnabled('vertex')}
                      className={`w-10 h-5 rounded-full transition-colors flex-shrink-0 ${
                        isProviderEnabled('vertex') ? 'bg-studio-accent' : 'bg-studio-border'
                      }`}
                      title={isProviderEnabled('vertex') ? 'Disable provider' : 'Enable provider'}
                    >
                      <div className={`w-4 h-4 bg-white rounded-full shadow transition-transform m-0.5 ${
                        isProviderEnabled('vertex') ? 'translate-x-5' : 'translate-x-0'
                      }`} />
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    {testResults.vertex === 'success' && <CheckIcon />}
                    {testResults.vertex === 'error' && <span className="text-xs text-studio-error">Invalid</span>}
                    <button
                      onClick={() => testApiKey('vertex')}
                      disabled={!localSettings.vertexAccessToken || !localSettings.vertexProjectId || testingProvider === 'vertex'}
                      className={`p-1.5 rounded transition-colors ${
                        localSettings.vertexAccessToken && localSettings.vertexProjectId
                          ? 'text-studio-accent hover:bg-studio-accent/20' 
                          : 'text-studio-muted/50'
                      } disabled:cursor-not-allowed`}
                      title="Test connection"
                    >
                      {testingProvider === 'vertex' ? (
                        <div className="w-4 h-4 border-2 border-studio-accent border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <RefreshIcon />
                      )}
                    </button>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="relative">
                    <input
                      type={showKeys.vertex ? 'text' : 'password'}
                      value={localSettings.vertexAccessToken}
                      onChange={(e) => setLocalSettings(prev => ({ ...prev, vertexAccessToken: e.target.value }))}
                      placeholder="Access Token"
                      className="w-full px-3 py-2 pr-10 bg-studio-bg border border-studio-border rounded focus:outline-none focus:border-studio-accent font-mono text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => toggleShowKey('vertex')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-studio-muted hover:text-studio-text"
                    >
                      {showKeys.vertex ? <EyeOffIcon /> : <EyeIcon />}
                    </button>
                  </div>
                  <input
                    type="text"
                    value={localSettings.vertexProjectId}
                    onChange={(e) => setLocalSettings(prev => ({ ...prev, vertexProjectId: e.target.value }))}
                    placeholder="Project ID"
                    className="w-full px-3 py-2 bg-studio-bg border border-studio-border rounded focus:outline-none focus:border-studio-accent text-sm"
                  />
                  <select
                    value={localSettings.vertexRegion || 'us-central1'}
                    onChange={(e) => setLocalSettings(prev => ({ ...prev, vertexRegion: e.target.value }))}
                    className="w-full px-3 py-2 bg-studio-bg border border-studio-border rounded focus:outline-none focus:border-studio-accent text-sm"
                  >
                    <option value="global">global</option>
                    <option value="us-central1">us-central1 (Iowa)</option>
                    <option value="us-east4">us-east4 (Virginia)</option>
                    <option value="us-west1">us-west1 (Oregon)</option>
                    <option value="us-west4">us-west4 (Las Vegas)</option>
                    <option value="us-east1">us-east1 (South Carolina)</option>
                    <option value="us-south1">us-south1 (Dallas)</option>
                    <option value="europe-west1">europe-west1 (Belgium)</option>
                    <option value="europe-west2">europe-west2 (London)</option>
                    <option value="europe-west3">europe-west3 (Frankfurt)</option>
                    <option value="europe-west4">europe-west4 (Netherlands)</option>
                    <option value="asia-east1">asia-east1 (Taiwan)</option>
                    <option value="asia-northeast1">asia-northeast1 (Tokyo)</option>
                    <option value="asia-southeast1">asia-southeast1 (Singapore)</option>
                    <option value="australia-southeast1">australia-southeast1 (Sydney)</option>
                    <option value="me-central1">me-central1 (Doha)</option>
                    <option value="me-central2">me-central2 (Dammam)</option>
                  </select>
                </div>
                <p className="text-xs text-studio-muted mt-1">Use gcloud auth print-access-token</p>
              </div>

              {/* LM Studio */}
              <div className={`p-3 bg-studio-bg/50 rounded-lg ${!isProviderEnabled('lmstudio') ? 'opacity-60' : ''}`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">LM Studio</span>
                    <span className="text-xs text-studio-muted">Local models</span>
                    <button
                      onClick={() => toggleProviderEnabled('lmstudio')}
                      className={`w-10 h-5 rounded-full transition-colors flex-shrink-0 ${
                        isProviderEnabled('lmstudio') ? 'bg-studio-accent' : 'bg-studio-border'
                      }`}
                      title={isProviderEnabled('lmstudio') ? 'Disable provider' : 'Enable provider'}
                    >
                      <div className={`w-4 h-4 bg-white rounded-full shadow transition-transform m-0.5 ${
                        isProviderEnabled('lmstudio') ? 'translate-x-5' : 'translate-x-0'
                      }`} />
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    {testResults.lmstudio === 'success' && <CheckIcon />}
                    {testResults.lmstudio === 'error' && <span className="text-xs text-studio-error">Unreachable</span>}
                    <button
                      onClick={() => testApiKey('lmstudio')}
                      disabled={!localSettings.lmstudioBaseUrl || testingProvider === 'lmstudio'}
                      className={`p-1.5 rounded transition-colors ${
                        localSettings.lmstudioBaseUrl
                          ? 'text-studio-accent hover:bg-studio-accent/20'
                          : 'text-studio-muted/50'
                      } disabled:cursor-not-allowed`}
                      title="Test connection"
                    >
                      {testingProvider === 'lmstudio' ? (
                        <div className="w-4 h-4 border-2 border-studio-accent border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <RefreshIcon />
                      )}
                    </button>
                  </div>
                </div>
                <div className="relative">
                  <input
                    type="text"
                    value={localSettings.lmstudioBaseUrl}
                    onChange={(e) => setLocalSettings(prev => ({ ...prev, lmstudioBaseUrl: e.target.value }))}
                    placeholder="http://localhost:1234"
                    className="w-full px-3 py-2 bg-studio-bg border border-studio-border rounded focus:outline-none focus:border-studio-accent font-mono text-sm"
                  />
                </div>
                <p className="text-xs text-studio-muted mt-1">Base URL for your LM Studio server (default: http://localhost:1234)</p>
              </div>
            </div>
          )}

          {activeTab === 'models' && (
            <div className="space-y-4">
              <p className="text-sm text-studio-muted mb-4">
                Filter which model types appear in the model selector. Uncheck to hide.
              </p>
              <div className="space-y-3">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={localSettings.modelFilters?.showToolCapableOnly ?? true}
                    onChange={(e) => setLocalSettings(prev => ({
                      ...prev,
                      modelFilters: { ...(prev.modelFilters ?? { showReasoning: true, showFast: true, showHighContext: true, showToolCapableOnly: true }), showToolCapableOnly: e.target.checked },
                    }))}
                    className="w-4 h-4 rounded border-studio-border accent-studio-accent"
                  />
                  <span className="text-sm">Only show tool-capable models</span>
                </label>
                <p className="text-xs text-studio-muted ml-7">Hide models that don&apos;t support function calling (Agent, Designer modes)</p>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={localSettings.modelFilters?.showReasoning ?? true}
                    onChange={(e) => setLocalSettings(prev => ({
                      ...prev,
                      modelFilters: { ...(prev.modelFilters ?? { showReasoning: true, showFast: true, showHighContext: true, showToolCapableOnly: true }), showReasoning: e.target.checked },
                    }))}
                    className="w-4 h-4 rounded border-studio-border accent-studio-accent"
                  />
                  <span className="text-sm">Show reasoning models</span>
                </label>
                <p className="text-xs text-studio-muted ml-7">o1, o3, Claude 4.5+ thinking, Gemini 2.0+ thought</p>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={localSettings.modelFilters?.showFast ?? true}
                    onChange={(e) => setLocalSettings(prev => ({
                      ...prev,
                      modelFilters: { ...(prev.modelFilters ?? { showReasoning: true, showFast: true, showHighContext: true, showToolCapableOnly: true }), showFast: e.target.checked },
                    }))}
                    className="w-4 h-4 rounded border-studio-border accent-studio-accent"
                  />
                  <span className="text-sm">Show fast models</span>
                </label>
                <p className="text-xs text-studio-muted ml-7">Flash, Haiku, Mini variants</p>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={localSettings.modelFilters?.showHighContext ?? true}
                    onChange={(e) => setLocalSettings(prev => ({
                      ...prev,
                      modelFilters: { ...(prev.modelFilters ?? { showReasoning: true, showFast: true, showHighContext: true, showToolCapableOnly: true }), showHighContext: e.target.checked },
                    }))}
                    className="w-4 h-4 rounded border-studio-border accent-studio-accent"
                  />
                  <span className="text-sm">Show high-context models</span>
                </label>
                <p className="text-xs text-studio-muted ml-7">128K+ context window</p>
              </div>
            </div>
          )}

          {activeTab === 'chat' && (
            <div className="space-y-6">
              {/* Max Tokens */}
              <div>
                <label className="block text-sm font-medium mb-2">Max Tokens</label>
                <input
                  type="number"
                  value={localSettings.maxTokens}
                  onChange={(e) => setLocalSettings(prev => ({ ...prev, maxTokens: parseInt(e.target.value) || 4096 }))}
                  min={256}
                  max={32000}
                  step={256}
                  className="w-full px-3 py-2 bg-studio-bg border border-studio-border rounded focus:outline-none focus:border-studio-accent"
                />
                <p className="text-xs text-studio-muted mt-1">Maximum response length (256 - 32000)</p>
              </div>

              {/* Temperature */}
              <div>
                <label className="block text-sm font-medium mb-2">Temperature: {localSettings.temperature}</label>
                <input
                  type="range"
                  value={localSettings.temperature}
                  onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) setLocalSettings(prev => ({ ...prev, temperature: v })); }}
                  min={0}
                  max={1}
                  step={0.1}
                  className="w-full accent-studio-accent"
                />
                <div className="flex justify-between text-xs text-studio-muted mt-1">
                  <span>Precise (0)</span>
                  <span>Creative (1)</span>
                </div>
              </div>

              {/* Max Iterations */}
              <div>
                <label className="block text-sm font-medium mb-2">
                  Max Iterations: {localSettings.maxIterations === 0 ? 'Unlimited' : localSettings.maxIterations}
                </label>
                <input
                  type="range"
                  value={localSettings.maxIterations}
                  onChange={(e) => setLocalSettings(prev => ({ ...prev, maxIterations: parseInt(e.target.value) }))}
                  min={0}
                  max={50}
                  step={1}
                  className="w-full accent-studio-accent"
                />
                <div className="flex justify-between text-xs text-studio-muted mt-1">
                  <span>Unlimited (0)</span>
                  <span>50</span>
                </div>
                <p className="text-xs text-studio-muted mt-1">
                  Auto-continue limit per user message. 0 = unlimited (like Cursor).
                </p>
              </div>

              {/* Font Size */}
              <div>
                <label className="block text-sm font-medium mb-2">Editor Font Size</label>
                <input
                  type="number"
                  value={localSettings.fontSize}
                  onChange={(e) => setLocalSettings(prev => ({ ...prev, fontSize: parseInt(e.target.value) || 13 }))}
                  min={10}
                  max={24}
                  className="w-full px-3 py-2 bg-studio-bg border border-studio-border rounded focus:outline-none focus:border-studio-accent"
                />
              </div>

              {/* Auto Save */}
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-medium">Auto Save</span>
                  <p className="text-xs text-studio-muted">Automatically save files</p>
                </div>
                <button
                  onClick={() => setLocalSettings(prev => ({ ...prev, autoSave: !prev.autoSave }))}
                  className={`w-12 h-6 rounded-full transition-colors ${
                    localSettings.autoSave ? 'bg-studio-accent' : 'bg-studio-border'
                  }`}
                >
                  <div className={`w-5 h-5 bg-white rounded-full shadow transition-transform ${
                    localSettings.autoSave ? 'translate-x-6' : 'translate-x-0.5'
                  }`} />
                </button>
              </div>
            </div>
          )}

          {activeTab === 'about' && (
            <div className="space-y-4 text-center py-8">
              <div className="text-4xl font-bold text-studio-accent">ATLS Studio</div>
              <p className="text-studio-muted">AI-First IDE powered by ATLS</p>
              <p className="text-sm text-studio-muted">Version 0.1.0</p>
              <div className="pt-4 border-t border-studio-border mt-6">
                <p className="text-xs text-studio-muted">
                  Built with Tauri, React, and Monaco Editor
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-studio-border flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-studio-muted hover:text-studio-text transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm bg-studio-accent-bright text-studio-bg rounded hover:bg-studio-accent transition-colors"
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
