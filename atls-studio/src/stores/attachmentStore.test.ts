import { beforeEach, describe, expect, it } from 'vitest';
import {
  consumeInternalDragPayload,
  setInternalDragPayload,
  useAttachmentStore,
} from './attachmentStore';

describe('attachmentStore', () => {
  beforeEach(() => {
    useAttachmentStore.getState().clearAttachments();
    useAttachmentStore.setState({ isInternalDragActive: false });
  });

  it('setInternalDragPayload is consumed once', () => {
    setInternalDragPayload([{ path: '/a.ts', name: 'a.ts', type: 'ts' }]);
    expect(consumeInternalDragPayload()).toEqual([{ path: '/a.ts', name: 'a.ts', type: 'ts' }]);
    expect(consumeInternalDragPayload()).toBeNull();
  });

  it('addFileAttachment and getFileAttachments', () => {
    useAttachmentStore.getState().addFileAttachment('f.ts', '/f.ts', 'content', 'code');
    const files = useAttachmentStore.getState().getFileAttachments();
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe('f.ts');
    expect(files[0]?.content).toBe('content');
  });

  it('addImageFromDataUrl parses data URL', () => {
    useAttachmentStore.getState().addImageFromDataUrl('pic', 'data:image/png;base64,QUFB');
    const imgs = useAttachmentStore.getState().getImageAttachments();
    expect(imgs).toHaveLength(1);
    expect(imgs[0]?.mediaType).toBe('image/png');
    expect(imgs[0]?.base64).toBe('QUFB');
  });

  it('addImageFromDataUrl ignores non-matching strings', () => {
    useAttachmentStore.getState().addImageFromDataUrl('bad', 'not-a-data-url');
    expect(useAttachmentStore.getState().getImageAttachments()).toHaveLength(0);
  });

  it('setInternalDragActive toggles flag', () => {
    useAttachmentStore.getState().setInternalDragActive(true);
    expect(useAttachmentStore.getState().isInternalDragActive).toBe(true);
    useAttachmentStore.getState().setInternalDragActive(false);
    expect(useAttachmentStore.getState().isInternalDragActive).toBe(false);
  });

  it('addImageAttachment builds thumbnail and stores metadata', () => {
    useAttachmentStore.getState().addImageAttachment('x.png', '/x.png', 'QUFB', 'image/png', { width: 10, height: 12 });
    const imgs = useAttachmentStore.getState().getImageAttachments();
    expect(imgs[0]?.thumbnailUrl).toBe('data:image/png;base64,QUFB');
    expect(imgs[0]?.metadata).toEqual({ width: 10, height: 12 });
  });

  it('removeAttachment filters by id', () => {
    useAttachmentStore.getState().addFileAttachment('a.ts', '/a.ts');
    const id = useAttachmentStore.getState().getFileAttachments()[0]?.id;
    expect(id).toBeDefined();
    useAttachmentStore.getState().removeAttachment(id!);
    expect(useAttachmentStore.getState().attachments).toHaveLength(0);
  });
});
