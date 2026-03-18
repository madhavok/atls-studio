import type { ShapeOp } from './uhppTypes';

export function applyShape(content: string, shape: ShapeOp): string {
  if (shape === 'dedent') return dedent(content);
  if (shape === 'fold' || shape === 'sig' || shape === 'nocomment' || shape === 'imports' || shape === 'exports') {
    return content;
  }
  if (typeof shape === 'object' && 'head' in shape) {
    return content.split('\n').slice(0, shape.head).join('\n');
  }
  if (typeof shape === 'object' && 'tail' in shape) {
    const arr = content.split('\n');
    return arr.slice(-shape.tail).join('\n');
  }
  return content;
}

export function dedent(content: string): string {
  const lines = content.split('\n');
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const indent = line.length - line.trimStart().length;
    minIndent = Math.min(minIndent, indent);
  }
  if (minIndent === 0 || minIndent === Infinity) return content;
  return lines
    .map((l) => (l.length >= minIndent ? l.slice(minIndent) : l.trim()))
    .join('\n');
}
