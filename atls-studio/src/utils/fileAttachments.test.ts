import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const { formatAttachmentForLLM, processFileAttachment, processImageBytes } = await import('./fileAttachments');

describe('formatAttachmentForLLM', () => {
  it('formats code attachment with fence and language', () => {
    const s = formatAttachmentForLLM({
      name: 'a.ts',
      type: 'code',
      content: 'export const x = 1;',
      metadata: { language: 'typescript', source_lines: 42 },
    });
    expect(s).toContain('File: a.ts (typescript, 42 lines)');
    expect(s).toContain('```typescript');
    expect(s).toContain('export const x = 1;');
  });

  it('formats image attachment with compression hint when sizes present', () => {
    const s = formatAttachmentForLLM({
      name: 'pic.png',
      fileType: 'image',
      metadata: { original_size: 100_000, compressed_size: 25_000 },
    });
    expect(s).toContain('Image: pic.png');
    expect(s).toMatch(/compressed \d+%/);
  });

  it('falls back to simple line for unknown kind', () => {
    expect(formatAttachmentForLLM({ name: 'x.bin' })).toBe('File: x.bin');
  });
});

describe('processFileAttachment', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('uses read_file_signatures for code files', async () => {
    invokeMock.mockResolvedValueOnce({
      signatures: 'fn main()',
      language: 'rust',
      lines: 3,
    });
    const att = await processFileAttachment('/p/main.rs', 'main.rs');
    expect(invokeMock).toHaveBeenCalledWith('read_file_signatures', { path: '/p/main.rs' });
    expect(att.type).toBe('code');
    expect(att.content).toBe('fn main()');
    expect(att.metadata?.language).toBe('rust');
  });

  it('uses compress_and_read_image for images', async () => {
    invokeMock.mockResolvedValueOnce({
      data: 'AAA',
      media_type: 'image/png',
      original_size: 1000,
      compressed_size: 100,
    });
    const att = await processFileAttachment('/p/x.png', 'x.png');
    expect(invokeMock).toHaveBeenCalledWith('compress_and_read_image', { path: '/p/x.png' });
    expect(att.type).toBe('image');
    expect(att.content).toContain('image/png');
  });

  it('falls back to read_file_as_base64 for unknown extension', async () => {
    invokeMock.mockResolvedValueOnce({ data: 'QQ==', media_type: 'application/octet-stream' });
    const att = await processFileAttachment('/p/readme.xyz', 'readme.xyz');
    expect(invokeMock).toHaveBeenCalledWith('read_file_as_base64', { path: '/p/readme.xyz' });
    expect(att.type).toBe('unknown');
  });

  it('on error in code path uses read_file_as_base64', async () => {
    const logErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    invokeMock.mockRejectedValueOnce(new Error('sig fail'));
    invokeMock.mockResolvedValueOnce({ data: 'QQ==', media_type: 'text/plain' });
    const att = await processFileAttachment('/p/a.ts', 'a.ts');
    expect(att.type).toBe('unknown');
    expect(invokeMock).toHaveBeenCalledWith('read_file_as_base64', { path: '/p/a.ts' });
    logErr.mockRestore();
  });

  it('image path carries compressed dimensions into metadata', async () => {
    invokeMock.mockResolvedValueOnce({
      data: 'AAA',
      media_type: 'image/jpeg',
      original_size: 2_000_000,
      compressed_size: 50_000,
      compressed_dimensions: { width: 1568, height: 882 },
    });
    const att = await processFileAttachment('/p/big.png', 'big.png');
    expect(att.type).toBe('image');
    expect(att.metadata?.width).toBe(1568);
    expect(att.metadata?.height).toBe(882);
  });
});

describe('processImageBytes', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('invokes compress_image_bytes with the decoded base64 payload', async () => {
    invokeMock.mockResolvedValueOnce({
      data: 'CCCC',
      media_type: 'image/jpeg',
      original_size: 3_000_000,
      compressed_size: 60_000,
      compressed_dimensions: { width: 1568, height: 1048 },
    });
    const att = await processImageBytes('paste.png', 'data:image/png;base64,SGVsbG8=', 'image/png');
    expect(invokeMock).toHaveBeenCalledWith('compress_image_bytes', { dataBase64: 'SGVsbG8=' });
    expect(att.type).toBe('image');
    expect(att.metadata?.media_type).toBe('image/jpeg');
    expect(att.metadata?.width).toBe(1568);
    expect(att.content).toContain('data:image/jpeg;base64,');
  });

  it('passes SVG data URLs through without invoking Rust', async () => {
    const svgDataUrl = 'data:image/svg+xml;base64,PHN2Zy8+';
    const att = await processImageBytes('icon.svg', svgDataUrl, 'image/svg+xml');
    expect(invokeMock).not.toHaveBeenCalled();
    expect(att.type).toBe('image');
    expect(att.content).toBe(svgDataUrl);
    expect(att.metadata?.media_type).toBe('image/svg+xml');
  });

  it('propagates Rust errors so callers can toast+fallback', async () => {
    invokeMock.mockRejectedValueOnce(new Error('unsupported codec'));
    await expect(processImageBytes('photo.heic', 'data:image/heic;base64,QUJD', 'image/heic'))
      .rejects.toThrow('unsupported codec');
  });
});
