/**
 * Chat Transport — decouples streaming source from consumer.
 *
 * Wraps Tauri invoke + event listeners into a ReadableStream-based contract.
 * Enables testability (mock transports), future protocol swaps, and cleaner
 * separation between "how we get chunks" and "what we do with them".
 *
 * Pattern inspired by Vercel AI SDK v5 ChatTransport.
 */

import { type UnlistenFn } from '@tauri-apps/api/event';
import { safeListen } from '../utils/tauri';
import type { StreamChunk } from '../stores/appStore';

export interface StreamParams {
  streamId: string;
  /** Fire-and-forget invoke that starts the backend stream. */
  invoke: () => Promise<void>;
  /** When aborted, stream closes and listener is removed. */
  abortSignal?: AbortSignal;
}

/**
 * Creates a ReadableStream of StreamChunks from Tauri events.
 * Registers listener for chat-chunk-{streamId}, starts invoke, pipes events to stream.
 * Stream closes on 'done', 'error', or abortSignal.
 */
export async function createTauriChatStream(
  params: StreamParams,
): Promise<ReadableStream<StreamChunk>> {
  const { streamId, invoke, abortSignal } = params;

  if (abortSignal?.aborted) {
    return new ReadableStream<StreamChunk>({ start(c) { c.close(); } });
  }

  let unlisten: UnlistenFn | null = null;
  let streamController: ReadableStreamDefaultController<StreamChunk> | null = null;

  const closeStream = () => {
    if (streamController) {
      try {
        streamController.close();
      } catch {
        /* already closed */
      }
      streamController = null;
    }
    unlisten?.();
    unlisten = null;
  };

  const stream = new ReadableStream<StreamChunk>({
    start(controller) {
      streamController = controller;
    },
    cancel() {
      closeStream();
    },
  });

  unlisten = await safeListen<StreamChunk>(`chat-chunk-${streamId}`, (event) => {
    const chunk = event.payload;
    if (!streamController) return;
    try {
      streamController.enqueue(chunk);
      if (chunk.type === 'done' || chunk.type === 'error') {
        closeStream();
      }
    } catch (e) {
      if (streamController) {
        streamController.error(e);
        streamController = null;
      }
      unlisten?.();
      unlisten = null;
    }
  });

  if (abortSignal) {
    abortSignal.addEventListener(
      'abort',
      () => {
        closeStream();
      },
      { once: true },
    );
  }

  invoke().catch((err) => {
    if (streamController) {
      streamController.error(err);
      streamController = null;
    }
    unlisten?.();
    unlisten = null;
  });

  return stream;
}
