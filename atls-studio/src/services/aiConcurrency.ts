export async function executeWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
  abortSignal?: AbortSignal
): Promise<T[]> {
  const results: (T | undefined)[] = new Array(tasks.length);
  const errors: { index: number; error: unknown }[] = [];
  let currentIndex = 0;

  // Resolve immediately when abort fires so we stop waiting for in-flight tasks
  const abortPromise = abortSignal
    ? new Promise<'aborted'>((resolve) => {
        if (abortSignal.aborted) { resolve('aborted'); return; }
        abortSignal.addEventListener('abort', () => resolve('aborted'), { once: true });
      })
    : null;

  async function runNext(): Promise<void> {
    const index = currentIndex++;
    if (index >= tasks.length) return;
    if (abortSignal?.aborted) return;

    try {
      if (abortPromise) {
        const outcome = await Promise.race([tasks[index]().then(r => ({ r })), abortPromise]);
        if (outcome === 'aborted') return;
        results[index] = (outcome as { r: T }).r;
      } else {
        results[index] = await tasks[index]();
      }
    } catch (err) {
      // Record the error but don't stop other runners
      errors.push({ index, error: err });
      return;
    }

    if (abortSignal?.aborted) return;
    await runNext();
  }
  
  const runners = Array(Math.min(limit, tasks.length))
    .fill(null)
    .map(() => runNext());
  
  if (abortPromise) {
    await Promise.race([Promise.all(runners), abortPromise]);
  } else {
    await Promise.all(runners);
  }

  // If any task failed, throw the first error (after all runners complete)
  if (errors.length > 0) {
    const firstErr = errors[0].error;
    throw firstErr instanceof Error ? firstErr : new Error(String(firstErr));
  }

  // Filter out undefined slots from aborted tasks
  return results.filter((r): r is T => r !== undefined);
}
