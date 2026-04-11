/**
 * Lightweight fake swarm worker for orchestration tests: resolves or rejects by config.
 */
export type MockSwarmWorkerResult =
  | { ok: true; summary: string }
  | { ok: false; error: string };

export async function runMockSwarmWorker(
  taskId: string,
  behavior: Record<string, MockSwarmWorkerResult>,
  ms = 0,
): Promise<MockSwarmWorkerResult> {
  const b = behavior[taskId] ?? { ok: true, summary: 'default' };
  if (ms > 0) await new Promise(r => setTimeout(r, ms));
  return b;
}
