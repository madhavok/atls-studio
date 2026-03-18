export interface DigestSymbol {
  name: string;
  kind: 'fn' | 'type' | 'const' | 'class' | 'interface' | 'method';
  line?: number;
}

export function formatSymbolDigestWithLines(symbols: DigestSymbol[], maxSymbols = 8): string {
  const lines = symbols.slice(0, maxSymbols).map(symbol => {
    const lineSuffix = typeof symbol.line === 'number' ? `:${symbol.line}` : '';
    return `${symbol.kind} ${symbol.name}${lineSuffix}`;
  });
  return lines.join('\n');
}

export function generateDigest(content: string, maxLines = 12): string {
  const lines = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, maxLines);
  return lines.join('\n');
}

export function generateEditReadyDigest(content: string, maxLines = 20): string {
  const lines = content
    .split(/\r?\n/)
    .map(line => line.replace(/\t/g, '  ').trimEnd())
    .filter(Boolean)
    .slice(0, maxLines);
  return lines.join('\n');
}
