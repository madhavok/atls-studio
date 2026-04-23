// Type definitions for file signature and image compression

/** Matches `read_file_signatures` (chat_attachments.rs) */
export interface FileSignatureResult {
  signatures: string;
  language: string;
  lines: number;
}

/** Matches `compress_and_read_image` + `compress_image_bytes` (chat_attachments.rs) */
export interface CompressedImageResult {
  /** Raw base64 payload (no `data:` prefix) */
  data: string;
  media_type: string;
  /** Original bytes on disk (file path variant) or decoded byte length (bytes variant) */
  original_size: number;
  /** Re-encoded byte length after resize */
  compressed_size: number;
  /** Full data URL — prefer building from `data` + `media_type` if both present */
  base64?: string;
  /** Pre-resize dimensions */
  original_dimensions?: { width: number; height: number };
  /** Post-resize dimensions (actual dimensions of the compressed payload) */
  compressed_dimensions?: { width: number; height: number };
}

export type FileType = 'code' | 'image' | 'unknown';

export interface FileAttachment {
  type: FileType;
  name: string;
  path: string;
  content?: string; // For signature or base64 data
  metadata?: {
    language?: string;
    source_lines?: number;
    original_size?: number;
    compressed_size?: number;
    media_type?: string;
    /** Width × height of the compressed payload (images only) — used for token estimation */
    width?: number;
    height?: number;
  };
}

// Supported code file extensions
const CODE_EXTENSIONS = [
  'rs', 'ts', 'tsx', 'js', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp',
  'cs', 'go', 'swift', 'kt', 'rb', 'php', 'scala', 'sh', 'bash'
];

// Supported image extensions
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];

export function detectFileType(fileName: string): FileType {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (!ext) return 'unknown';
  
  if (CODE_EXTENSIONS.includes(ext)) return 'code';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  return 'unknown';
}
