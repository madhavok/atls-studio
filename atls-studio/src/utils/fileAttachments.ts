// Utility functions for processing file attachments
import { invoke } from '@tauri-apps/api/core';
import type { FileSignatureResult, CompressedImageResult, FileAttachment, FileType } from '../types/attachments';
import { detectFileType } from '../types/attachments';

/**
 * Process a dropped file based on its type
 * - Code files: extract signature (90-95% token savings)
 * - Images: compress (70-90% token savings)
 * - Others: read as text (fallback)
 */
export async function processFileAttachment(filePath: string, fileName: string): Promise<FileAttachment> {
  const fileType = detectFileType(fileName);
  
  try {
    switch (fileType) {
      case 'code':
        return await processCodeFile(filePath, fileName);
      
      case 'image':
        return await processImageFile(filePath, fileName);
      
      default:
        // Fallback: treat as text file
        return await processFallbackFile(filePath, fileName);
    }
  } catch (error) {
    console.error(`Failed to process ${fileName}:`, error);
    // Fallback on error
    return await processFallbackFile(filePath, fileName);
  }
}

async function processCodeFile(filePath: string, fileName: string): Promise<FileAttachment> {
  const result = await invoke<FileSignatureResult>('read_file_signatures', { path: filePath });

  return {
    type: 'code',
    name: fileName,
    path: filePath,
    content: result.signatures,
    metadata: {
      language: result.language,
      source_lines: result.lines,
    },
  };
}

async function processImageFile(filePath: string, fileName: string): Promise<FileAttachment> {
  const result = await invoke<CompressedImageResult>('compress_and_read_image', { path: filePath });
  const content = result.base64
    ?? `data:${result.media_type};base64,${result.data}`;

  return {
    type: 'image',
    name: fileName,
    path: filePath,
    content,
    metadata: {
      media_type: result.media_type,
      original_size: result.original_size,
      compressed_size: result.compressed_size,
    },
  };
}

async function processFallbackFile(filePath: string, fileName: string): Promise<FileAttachment> {
  // Use existing read_file_as_base64 for unknown types
  const result = await invoke<{ data: string; media_type: string }>('read_file_as_base64', { path: filePath });
  
  return {
    type: 'unknown',
    name: fileName,
    path: filePath,
    content: `data:${result.media_type};base64,${result.data}`
  };
}

/**
 * Format file attachment for LLM context.
 * Accepts both FileAttachment (from processFileAttachment) and ChatAttachment (from store).
 * ChatAttachment uses `fileType` instead of `type` for the semantic kind.
 */
export function formatAttachmentForLLM(attachment: {
  name: string;
  type?: string;
  fileType?: string;
  content?: string;
  metadata?: { language?: string; source_lines?: number; original_size?: number; compressed_size?: number };
}): string {
  const kind = attachment.fileType || attachment.type;
  switch (kind) {
    case 'code':
      return `File: ${attachment.name} (${attachment.metadata?.language}, ${attachment.metadata?.source_lines} lines)\n\`\`\`${attachment.metadata?.language}\n${attachment.content}\n\`\`\``;

    case 'image': {
      const savings = attachment.metadata?.original_size && attachment.metadata?.compressed_size
        ? Math.round((1 - attachment.metadata.compressed_size / attachment.metadata.original_size) * 100)
        : 0;
      return `Image: ${attachment.name}${savings > 0 ? ` (compressed ${savings}% from ${Math.round(attachment.metadata!.original_size! / 1024)}KB to ${Math.round(attachment.metadata!.compressed_size! / 1024)}KB)` : ''}`;
    }

    default:
      return `File: ${attachment.name}`;
  }
}
