// Type definitions for file signature and image compression

export interface FileSignatureResult {
  signature: string;
  language: string;
  source_lines: number;
}

export interface CompressedImageResult {
  data: string; // base64 encoded
  media_type: string;
  original_size: number;
  compressed_size: number;
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
