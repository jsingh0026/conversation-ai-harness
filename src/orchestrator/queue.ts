/**
 * Serializes async work per key. Rapid back-to-back messages in the *same*
 * conversation run one at a time and in order (so the agent never processes a
 * follow-up against stale mid-turn state), while different conversations run
 * concurrently. `onIdle()` lets callers/tests await all in-flight work.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly active = new Set<Promise<void>>();

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(key) ?? Promise.resolve();

    let settle!: (value: T) => void;
    let fail!: (err: unknown) => void;
    const result = new Promise<T>((res, rej) => {
      settle = res;
      fail = rej;
    });

    // Chain after the previous task for this key; a failure in one task must not
    // break the chain, so we swallow it here and surface it on `result` instead.
    const next = tail.then(async () => {
      try {
        settle(await task());
      } catch (err) {
        fail(err);
      }
    });

    this.tails.set(key, next);
    this.active.add(next);
    void next.finally(() => {
      this.active.delete(next);
      if (this.tails.get(key) === next) this.tails.delete(key);
    });

    return result;
  }

  /** Resolve once no work is in flight (handles tasks queued while awaiting). */
  async onIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active]);
    }
  }

  get pending(): number {
    return this.active.size;
  }
}
