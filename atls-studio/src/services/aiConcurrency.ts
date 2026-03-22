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
    // Race to detect abort early, then still await runners so results[]/errors[] are fully populated.
    // Runners check abortSignal.aborted and bail quickly, so this won't block long.
    await Promise.race([Promise.all(runners), abortPromise]);
    await Promise.all(runners);
  } else {
    await Promise.all(runners);
  }

  // If aborted, return the sparse results array preserving index correspondence.
  // Slots for incomplete/aborted tasks remain undefined.
  if (abortSignal?.aborted) {
    return results as T[];
  }

  // If any task failed, throw the first error (all runners have completed at this point)
  if (errors.length > 0) {
    const firstErr = errors[0].error;
    throw firstErr instanceof Error ? firstErr : new Error(String(firstErr));
  }

  // All tasks completed successfully — no undefined slots possible
  return results as T[];
}
