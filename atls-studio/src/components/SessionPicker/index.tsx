/**
 * SessionPicker Component
 * 
 * Modal displayed when opening a project to choose:
 * - Start a new conversation
 * - Continue from a previous session
 */

import { useState, useEffect } from 'react';
import { chatDb, type DbSession } from '../../services/chatDb';

interface SessionPickerProps {
  isOpen: boolean;
  projectPath: string;
  onNewSession: () => void;
  onLoadSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onClose: () => void;
}

export function SessionPicker({ 
  isOpen, 
  projectPath, 
  onNewSession, 
  onLoadSession, 
  onDeleteSession,
  onClose 
}: SessionPickerProps) {
  const [sessions, setSessions] = useState<DbSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Load sessions when modal opens
  useEffect(() => {
    if (!isOpen) return;
    
    // Reset selection when modal re-opens (avoid stale selection from previous project)
    setSelectedId(null);
    
    async function loadSessions() {
      setLoading(true);
      try {
        // Initialize chat DB for project
        await chatDb.init(projectPath);
        const loadedSessions = await chatDb.getSessions(20);
        setSessions(loadedSessions);
      } catch (error) {
        console.error('[SessionPicker] Failed to load sessions:', error);
        setSessions([]);
      } finally {
        setLoading(false);
      }
    }
    
    loadSessions();
  }, [isOpen, projectPath]);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return 'Unknown date';
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffDays < 0) {
      // Future date — just show the date
      return date.toLocaleDateString();
    }
    if (diffDays === 0) {
      return `Today at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    if (diffDays === 1) {
      return `Yesterday at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    if (diffDays < 7) {
      return `${diffDays} days ago`;
    }
    return date.toLocaleDateString();
  };

  const getModeIcon = (mode: string) => {
    switch (mode) {
      case 'agent': return '🤖';
      case 'designer': return '📋';
      case 'reviewer': return '👁️';
      case 'ask': return '❓';
      case 'swarm': return '🐝';
      default: return '💬';
    }
  };

  const handleContinue = () => {
    if (selectedId) {
      onLoadSession(selectedId);
    }
  };

  const handleDelete = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('Delete this conversation? This cannot be undone.')) {
      try {
        await onDeleteSession(sessionId);
        setSessions(prev => prev.filter(s => s.id !== sessionId));
        if (selectedId === sessionId) {
          setSelectedId(null);
        }
      } catch (error) {
        console.error('[SessionPicker] Failed to delete session:', error);
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-studio-surface border border-studio-border rounded-lg w-full max-w-lg max-h-[80vh] flex flex-col shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-studio-border">
          <div>
            <h2 className="text-lg font-medium text-studio-title">Welcome Back</h2>
            <p className="text-xs text-studio-muted">
              {projectPath.split(/[/\\]/).pop()}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-studio-muted hover:text-studio-text p-1"
          >
            ✕
          </button>
        </div>

        {/* New Chat Button */}
        <div className="p-4 border-b border-studio-border">
          <button
            onClick={onNewSession}
            className="w-full flex items-center gap-3 px-4 py-3 bg-studio-title/10 hover:bg-studio-title/20 border border-studio-title/30 rounded-lg transition-colors"
          >
            <span className="text-2xl">✨</span>
            <div className="text-left">
              <div className="font-medium text-studio-title">New Conversation</div>
              <div className="text-xs text-studio-muted">Start fresh with a clean context</div>
            </div>
          </button>
        </div>

        {/* Session List */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin w-6 h-6 border-2 border-studio-title border-t-transparent rounded-full" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="text-center py-8 text-studio-muted">
              <div className="text-4xl mb-2">📭</div>
              <div>No previous conversations</div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-xs text-studio-muted uppercase tracking-wide mb-2">
                Recent Conversations
              </div>
              {sessions.map((session) => (
                <div
                  key={session.id}
                  onClick={() => setSelectedId(session.id)}
                  className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                    selectedId === session.id
                      ? 'bg-studio-title/20 border border-studio-title/50'
                      : 'bg-studio-bg hover:bg-studio-border/50 border border-transparent'
                  }`}
                >
                  <span className="text-xl mt-0.5">{getModeIcon(session.mode)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-studio-text truncate">
                      {session.title}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-studio-muted">
                      <span>{formatDate(session.updated_at)}</span>
                      {session.is_swarm && (
                        <span className="px-1.5 py-0.5 bg-yellow-500/20 text-yellow-400 rounded">
                          Swarm
                        </span>
                      )}
                      {session.context_usage && (
                        <span>
                          {Math.round(session.context_usage.total_tokens / 1000)}k tokens
                          {session.context_usage.cost_cents > 0 && (
                            <span className="text-studio-accent ml-1">
                              ${(session.context_usage.cost_cents / 100).toFixed(2)}
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={(e) => handleDelete(session.id, e)}
                    className="p-1 text-studio-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Delete conversation"
                  >
                    🗑️
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {selectedId && (
          <div className="p-4 border-t border-studio-border">
            <button
              onClick={handleContinue}
              className="w-full px-4 py-2 bg-studio-title hover:bg-studio-title/80 text-studio-bg font-medium rounded-lg transition-colors"
            >
              Continue Conversation
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default SessionPicker;
