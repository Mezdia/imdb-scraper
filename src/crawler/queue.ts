/** Bounded-concurrency async queue with politeness delay + retries. */

export interface QueueOptions {
  concurrency: number;
  politenessMs: number;
  retries: number;
}

export async function runWithConcurrency<T>(
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
  opts: QueueOptions,
): Promise<{ ok: number; failed: number }> {
  const concurrency = Math.max(1, opts.concurrency);
  let ok = 0;
  let failed = 0;
  let cursor = 0;

  async function lane(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i] as T;
      let attempt = 0;
      for (;;) {
        try {
          if (i > 0 && opts.politenessMs > 0) {
            await sleep(opts.politenessMs + Math.random() * opts.politenessMs * 0.4);
          }
          await worker(item, i);
          ok++;
          break;
        } catch (e) {
          attempt++;
          if (attempt > opts.retries) {
            failed++;
            break;
          }
          await sleep(backoffMs(attempt));
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => lane()));
  return { ok, failed };
}

export function backoffMs(attempt: number): number {
  const base = 1000 * 2 ** Math.max(0, attempt - 1);
  return Math.min(base + Math.random() * 500, 15_000);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
