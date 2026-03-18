/**
 * Attachment Store
 * 
 * Manages pending file and image attachments for the AI chat.
 * Files are added via drag-and-drop, clipboard paste, file picker,
 * or the explorer context menu. On send, file contents are loaded
 * into contextStore as hash-chunks; images are passed directly
 * as base64 multimodal content blocks.
 */

import { create } from 'zustand';

// --- Internal drag payload (shared between FileExplorer and AiChat) ---
// WebView2 on Windows blocks HTML5 dataTransfer for drag-and-drop,
// so we use a module-level variable as a side-channel.
export interface DragPayloadItem {
  path: string;
  name: string;
  type: string;
}

let _internalDragPayload: DragPayloadItem[] | null = null;

export function setInternalDragPayload(items: DragPayloadItem[]) {
  _internalDragPayload = items;
}

export function consumeInternalDragPayload(): DragPayloadItem[] | null {
  const payload = _internalDragPayload;
  _internalDragPayload = null;
  return payload;
}

export interface AttachmentMetadata {
  language?: string;
  source_lines?: number;
  original_size?: number;
  compressed_size?: number;
}

export interface ChatAttachment {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'image';
  /** Semantic file kind from processFileAttachment ('code' | 'image' | 'unknown') */
  fileType?: 'code' | 'image' | 'unknown';
  /** Text content -- signature for code files, loaded lazily for others */
  content?: string;
  /** Base64-encoded data (images only) */
  base64?: string;
  /** MIME type (images only, e.g. image/png) */
  mediaType?: string;
  /** Data URL for thumbnail preview (images only) */
  thumbnailUrl?: string;
  /** Signature/compression metadata from processFileAttachment */
  metadata?: AttachmentMetadata;
}

interface AttachmentStoreState {
  attachments: ChatAttachment[];
  /** True while an internal drag from the file explorer is in progress */
  isInternalDragActive: boolean;
  setInternalDragActive: (active: boolean) => void;
  addFileAttachment: (name: string, path: string, content?: string, fileType?: ChatAttachment['fileType'], metadata?: AttachmentMetadata) => void;
  addImageAttachment: (name: string, path: string, base64: string, mediaType: string, metadata?: AttachmentMetadata) => void;
  addImageFromDataUrl: (name: string, dataUrl: string) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  getFileAttachments: () => ChatAttachment[];
  getImageAttachments: () => ChatAttachment[];
}

export const useAttachmentStore = create<AttachmentStoreState>((set, get) => ({
  attachments: [],
  isInternalDragActive: false,
  setInternalDragActive: (active) => set({ isInternalDragActive: active }),

  addFileAttachment: (name, path, content, fileType, metadata) => {
    const id = crypto.randomUUID();
    set(state => ({
      attachments: [...state.attachments, { id, name, path, type: 'file', content, fileType, metadata }],
    }));
  },

  addImageAttachment: (name, path, base64, mediaType, metadata) => {
    const id = crypto.randomUUID();
    const thumbnailUrl = `data:${mediaType};base64,${base64}`;
    set(state => ({
      attachments: [...state.attachments, {
        id, name, path, type: 'image', base64, mediaType, thumbnailUrl, fileType: 'image' as const, metadata,
      }],
    }));
  },

  addImageFromDataUrl: (name, dataUrl) => {
    const id = crypto.randomUUID();
    // Parse data URL: data:<mediaType>;base64,<data>
    const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (!match) return;
    const mediaType = match[1];
    const base64 = match[2];
    set(state => ({
      attachments: [...state.attachments, {
        id, name, path: '', type: 'image', base64, mediaType, thumbnailUrl: dataUrl,
      }],
    }));
  },

  removeAttachment: (id) => {
    set(state => ({
      attachments: state.attachments.filter(a => a.id !== id),
    }));
  },

  clearAttachments: () => set({ attachments: [] }),

  getFileAttachments: () => get().attachments.filter(a => a.type === 'file'),
  getImageAttachments: () => get().attachments.filter(a => a.type === 'image'),
}));
