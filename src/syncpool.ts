// Bounded worker pool for fan-out secret pushes.
//
// N workers pull tasks off a shared cursor; failures are collected (don't
// abort siblings); an overall timeout aborts everything via AbortSignal.

import type { SecretTask } from "./envfile";

export type SyncResult = { failed: string[]; ok: number };

export async function runPool(
  tasks: SecretTask[],
  workers: number,
  timeoutMs: number,
  fn: (t: SecretTask, signal: AbortSignal) => Promise<void>,
): Promise<SyncResult> {
  const n = Math.max(1, workers);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const failed: string[] = [];
  let ok = 0;
  let cursor = 0;

  const worker = async () => {
    while (!ctrl.signal.aborted) {
      const idx = cursor++;
      if (idx >= tasks.length) return;
      const t = tasks[idx];
      try {
        await fn(t, ctrl.signal);
        ok++;
      } catch (e) {
        console.error(`WARNING: skipping ${t.key}: ${(e as Error).message}`);
        failed.push(t.key);
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: n }, () => worker()));
  } finally {
    clearTimeout(timer);
  }

  return { ok, failed };
}
