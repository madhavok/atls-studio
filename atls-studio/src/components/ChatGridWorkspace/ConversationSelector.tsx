import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { ChatSession } from '../../stores/appStore';
import { chatDb, type DbSession } from '../../services/chatDb';
import { activateAgentParentSession } from '../../services/activateAgentWindow';

interface ConversationSelectorProps {
  projectPath: string | null;
  chatSessions: ChatSession[];
  activeParentSessionId: string | null;
  onCreateSession: () => void;
}

function formatSessionLabel(title: string, updatedAt?: Date | string): string {
  if (!updatedAt) return title;
  const date = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return title;
  return `${title} · ${date.toLocaleDateString()}`;
}

export const ConversationSelector = memo(function ConversationSelector({
  projectPath,
  chatSessions,
  activeParentSessionId,
  onCreateSession,
}: ConversationSelectorProps) {
  const [dbSessions, setDbSessions] = useState<DbSession[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!projectPath || !chatDb.isInitialized()) {
      setDbSessions([]);
      return;
    }
    let cancelled = false;
    void chatDb.getSessions(30).then((sessions) => {
      if (!cancelled) setDbSessions(sessions);
    }).catch(() => {
      if (!cancelled) setDbSessions([]);
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath, chatSessions.length]);

  const options = useMemo(() => {
    const byId = new Map<string, { id: string; title: string; updatedAt?: Date | string }>();
    for (const session of chatSessions) {
      byId.set(session.id, { id: session.id, title: session.title, updatedAt: session.updatedAt });
    }
    for (const session of dbSessions) {
      if (!byId.has(session.id)) {
        byId.set(session.id, { id: session.id, title: session.title, updatedAt: session.updated_at });
      }
    }
    return Array.from(byId.values()).sort((a, b) => {
      const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return bTime - aTime;
    });
  }, [chatSessions, dbSessions]);

  const activeTitle = options.find((option) => option.id === activeParentSessionId)?.title
    ?? chatSessions.find((session) => session.id === activeParentSessionId)?.title
    ?? 'Select conversation';

  const handleSelect = useCallback((sessionId: string, title: string) => {
    void activateAgentParentSession(sessionId, title, projectPath);
    setOpen(false);
  }, [projectPath]);

  return (
    <div className="relative" data-testid="conversation-selector">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Switch parent conversation"
        onClick={() => setOpen((current) => !current)}
        className="max-w-[220px] truncate rounded-lg border border-studio-border/70 bg-studio-bg/60 px-2 py-1.5 text-left text-[10px] text-studio-text hover:border-studio-title/40"
      >
        <span className="block truncate font-mono uppercase tracking-[0.12em] text-studio-muted">Conversation</span>
        <span className="block truncate text-studio-title">{activeTitle}</span>
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close conversation list"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="listbox"
            aria-label="Parent conversations"
            className="absolute left-0 top-full z-50 mt-1 max-h-64 w-72 overflow-y-auto rounded-lg border border-studio-border bg-studio-surface shadow-xl"
          >
            {options.length === 0 ? (
              <div className="px-3 py-2 text-[10px] text-studio-muted">No saved conversations yet.</div>
            ) : options.map((option) => (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={option.id === activeParentSessionId}
                onClick={() => handleSelect(option.id, option.title)}
                className={`block w-full px-3 py-2 text-left text-[11px] hover:bg-studio-title/10 ${
                  option.id === activeParentSessionId ? 'bg-studio-title/10 text-studio-title' : 'text-studio-text'
                }`}
              >
                {formatSessionLabel(option.title, option.updatedAt)}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onCreateSession();
              }}
              className="block w-full border-t border-studio-border px-3 py-2 text-left text-[10px] uppercase tracking-wide text-studio-title hover:bg-studio-title/10"
            >
              New parent session
            </button>
          </div>
        </>
      )}
    </div>
  );
});
