export interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

export interface ProviderTotals {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  requestCount: number;
}

export function createEmptyTotals(): ProviderTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
    requestCount: 0,
  };
}

export function accumulateTotals(target: ProviderTotals, usage: UsageRecord): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.estimatedCost += usage.estimatedCost;
  target.requestCount += 1;
}

export function sumUsageTotals(records: UsageRecord[]): ProviderTotals {
  return records.reduce<ProviderTotals>((totals, record) => {
    accumulateTotals(totals, record);
    return totals;
  }, createEmptyTotals());
}

export function createProviderTotalsRecord<TProvider extends string>(providers: TProvider[]): Record<TProvider, ProviderTotals> {
  return providers.reduce((acc, provider) => {
    acc[provider] = createEmptyTotals();
    return acc;
  }, {} as Record<TProvider, ProviderTotals>);
}

export function groupUsageByProvider<TProvider extends string>(
  records: Array<UsageRecord & { provider: TProvider }>,
  providers: TProvider[],
): Record<TProvider, ProviderTotals> {
  return records.reduce((acc, record) => {
    if (!acc[record.provider]) {
      acc[record.provider] = createEmptyTotals();
    }
    accumulateTotals(acc[record.provider], record);
    return acc;
  }, createProviderTotalsRecord(providers));
}
