import React from 'react';
import type { ChatAttachment } from '../stores/attachmentStore';

interface SignatureViewProps {
  attachment: ChatAttachment;
  onExpand?: () => void;
}

export const SignatureView: React.FC<SignatureViewProps> = ({ attachment, onExpand }) => {
  const language = attachment.metadata?.language || 'text';
  const sourceLines = attachment.metadata?.source_lines;

  return (
    <div className="border rounded-lg p-3 bg-studio-surface/50 border-studio-border my-1.5">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-studio-accent/15 text-studio-accent">
            {language}
          </span>
          <span className="text-xs text-studio-muted truncate max-w-[200px]" title={attachment.path}>
            {attachment.name}
          </span>
          {sourceLines != null && (
            <span className="text-xs text-studio-muted">
              {sourceLines} lines
            </span>
          )}
        </div>
        {onExpand && (
          <button
            onClick={onExpand}
            className="text-xs text-studio-accent hover:text-studio-accent-bright transition-colors"
          >
            View Full
          </button>
        )}
      </div>
      <pre className="text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto text-studio-text leading-relaxed">
        <code>{attachment.content}</code>
      </pre>
    </div>
  );
};

export default SignatureView;
