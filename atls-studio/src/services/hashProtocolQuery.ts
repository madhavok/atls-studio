import type { ChunkRef } from './hashProtocol';
import { collectRefsWhere } from './hashProtocol';

export function getActiveRefs(): ChunkRef[] {
  return collectRefsWhere(r => r.visibility !== 'evicted');
}