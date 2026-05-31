import { memo, useCallback, useRef } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { processFileAttachment } from '../../utils/fileAttachments';
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore';
import type { ChatAttachment } from '../../stores/attachmentStore';

interface AgentAttachmentBarProps {
  windowId: string;
  disabled?: boolean;
}

function addProcessedAttachment(
  windowId: string,
  name: string,
  path: string,
  attachment: Awaited<ReturnType<typeof processFileAttachment>>,
): void {
  const store = useAgentRuntimeStore.getState();
  if (attachment.type === 'image') {
    const base64 = attachment.content?.split(',')[1] || '';
    const mediaType = attachment.metadata?.media_type || 'image/png';
    store.addAttachment(windowId, {
      id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      path,
      type: 'image',
      base64,
      mediaType,
      metadata: attachment.metadata,
    });
    return;
  }
  store.addAttachment(windowId, {
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    path,
    type: 'file',
    fileType: attachment.type === 'code' ? 'code' : 'unknown',
    content: attachment.content,
    metadata: attachment.metadata,
  });
}

export const AgentAttachmentBar = memo(function AgentAttachmentBar({ windowId, disabled }: AgentAttachmentBarProps) {
  const attachments = useAgentRuntimeStore((s) => s.runtimesByWindow[windowId]?.attachments ?? []);
  const removeAttachment = useAgentRuntimeStore((s) => s.removeAttachment);
  const inputRef = useRef<HTMLInputElement>(null);

  const handlePickFiles = useCallback(async () => {
    if (disabled) return;
    try {
      const selected = await openDialog({
        multiple: true,
        title: 'Attach files',
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      for (const filePath of paths) {
        const name = filePath.split(/[/\\]/).pop() || filePath;
        try {
          const attachment = await processFileAttachment(filePath, name);
          addProcessedAttachment(windowId, name, filePath, attachment);
        } catch {
          useAgentRuntimeStore.getState().addAttachment(windowId, {
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name,
            path: filePath,
            type: 'file',
          });
        }
      }
    } catch (error) {
      console.warn('[AgentAttachmentBar] File picker failed:', error);
    }
  }, [disabled, windowId]);

  if (attachments.length === 0 && disabled) return null;

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5" data-testid={`agent-attachments-${windowId}`}>
      {attachments.map((attachment: ChatAttachment) => (
        <span
          key={attachment.id}
          className="inline-flex max-w-[160px] items-center gap-1 rounded-full border border-studio-border/70 bg-studio-bg/70 px-2 py-0.5 text-[10px] text-studio-text"
        >
          <span className="truncate" title={attachment.name}>{attachment.name}</span>
          {!disabled && (
            <button
              type="button"
              aria-label={`Remove ${attachment.name}`}
              onClick={() => removeAttachment(windowId, attachment.id)}
              className="shrink-0 text-studio-muted hover:text-red-300"
            >
              ×
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <>
          <input ref={inputRef} type="file" multiple className="hidden" />
          <button
            type="button"
            onClick={() => { void handlePickFiles(); }}
            className="rounded border border-studio-border/70 px-2 py-0.5 text-[10px] uppercase tracking-wide text-studio-muted hover:border-studio-title/40 hover:text-studio-title"
          >
            Attach
          </button>
        </>
      )}
    </div>
  );
});
