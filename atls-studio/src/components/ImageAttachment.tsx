import React, { useState } from 'react';
import type { ChatAttachment } from '../stores/attachmentStore';

interface ImageAttachmentProps {
  attachment: ChatAttachment;
  onRemove?: () => void;
}

export const ImageAttachment: React.FC<ImageAttachmentProps> = ({ attachment, onRemove }) => {
  const [showStats, setShowStats] = useState(false);
  const originalSize = attachment.metadata?.original_size;
  const compressedSize = attachment.metadata?.compressed_size;
  const hasStats = originalSize != null && compressedSize != null && originalSize > 0;
  const compressionRatio = hasStats
    ? ((1 - compressedSize! / originalSize!) * 100).toFixed(1)
    : null;

  const src = attachment.base64 && attachment.mediaType
    ? `data:${attachment.mediaType};base64,${attachment.base64}`
    : attachment.thumbnailUrl || attachment.content;

  if (!src) return null;

  return (
    <div className="relative inline-block my-1.5">
      <img
        src={src}
        alt={attachment.name}
        className="max-w-full max-h-64 rounded-lg border border-studio-border cursor-pointer"
        onClick={() => setShowStats(s => !s)}
      />
      {onRemove && (
        <button
          onClick={onRemove}
          className="absolute top-1.5 right-1.5 bg-studio-error text-white rounded-full w-5 h-5 flex items-center justify-center text-xs hover:bg-studio-error/80 transition-colors"
          aria-label="Remove image"
        >
          &times;
        </button>
      )}
      {showStats && hasStats && (
        <div className="absolute bottom-1.5 left-1.5 bg-black/75 text-white text-[10px] px-2 py-1 rounded">
          <div>{(originalSize! / 1024).toFixed(1)}KB &rarr; {(compressedSize! / 1024).toFixed(1)}KB ({compressionRatio}% saved)</div>
        </div>
      )}
    </div>
  );
};

export default ImageAttachment;
