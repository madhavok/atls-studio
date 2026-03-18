import type { ChunkRef } from './hashProtocol';
import { getAllRefs } from './hashProtocol';

export function getActiveRefs(): ChunkRef[] {
  return getAllRefs().filter(r => r.visibility !== 'evicted');
}