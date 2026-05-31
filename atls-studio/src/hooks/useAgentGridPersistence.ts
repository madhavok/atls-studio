import { useCallback, useEffect, useRef } from 'react';
import { useAgentRuntimeStore } from '../stores/agentRuntimeStore';
import { useAgentWindowStore } from '../stores/agentWindowStore';
import type { Message } from '../stores/appStore';
import { chatDb } from '../services/chatDb';
import { flushAllCachedContextPartitions } from '../services/contextSessionPartition';
import { persistGridAssistantTurn, persistGridUserMessage } from '../services/agentGridMessagePersist';

const GRID_SAVE_DEBOUNCE_MS = 1500;

function runtimeMessagesToPersisted(sessionId: string): Message[] {
  const runtimes = useAgentRuntimeStore.getState().runtimesByWindow;
  const messages: Message[] = [];
  for (const runtime of Object.values(runtimes)) {
    if (runtime.sessionId !== sessionId) continue;
    for (const message of runtime.messages) {
      if (message.role === 'system') continue;
      messages.push({
        id: message.id,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        parts: message.parts,
        segments: message.segments,
      });
    }
  }
  return messages;
}

export function useAgentGridPersistence(): { flushGridPersistence: () => Promise<void> } {
  const dirtySessionsRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushSession = useCallback(async (sessionId: string) => {
    if (!chatDb.isInitialized()) return;
    const messages = runtimeMessagesToPersisted(sessionId);
    for (const message of messages) {
      if (message.role === 'user') {
        await persistGridUserMessage(sessionId, {
          id: message.id,
          role: 'user',
          content: message.content,
          timestamp: message.timestamp,
        });
      } else {
        await persistGridAssistantTurn(
          sessionId,
          {
            id: message.id,
            role: 'assistant',
            content: message.content,
            timestamp: message.timestamp,
            parts: message.parts,
            segments: message.segments,
          },
          message.parts ?? [],
          message.content,
        );
      }
    }
  }, []);

  const flushGridPersistence = useCallback(async () => {
    const sessions = [...dirtySessionsRef.current];
    dirtySessionsRef.current.clear();
    await Promise.all(sessions.map((sessionId) => flushSession(sessionId)));
    await flushAllCachedContextPartitions();
  }, [flushSession]);

  const scheduleSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flushGridPersistence();
    }, GRID_SAVE_DEBOUNCE_MS);
  }, [flushGridPersistence]);

  useEffect(() => {
    const unsubRuntime = useAgentRuntimeStore.subscribe((state, prev) => {
      if (state.runtimesByWindow === prev.runtimesByWindow) return;
      for (const runtime of Object.values(state.runtimesByWindow)) {
        dirtySessionsRef.current.add(runtime.sessionId);
      }
      scheduleSave();
    });
    const unsubWindows = useAgentWindowStore.subscribe((state, prev) => {
      if (state.windowsByParent === prev.windowsByParent) return;
      for (const windows of Object.values(state.windowsByParent)) {
        for (const window of windows) {
          dirtySessionsRef.current.add(window.sessionId);
        }
      }
      scheduleSave();
    });
    return () => {
      unsubRuntime();
      unsubWindows();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [scheduleSave]);

  useEffect(() => {
    const onBeforeUnload = () => { void flushGridPersistence(); };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [flushGridPersistence]);

  return { flushGridPersistence };
}
