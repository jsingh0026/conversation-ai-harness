/**
 * Dedupes webhook deliveries by message id. HighLevel can deliver the same
 * inbound message more than once; the first delivery to `markIfNew` wins and
 * later duplicates are dropped. Async so a Postgres-backed implementation
 * (`PgIdempotencyStore`) fits the same shape — see `src/orchestrator/pg-idempotency.ts`.
 */
export interface IdempotencyStore {
  /**
   * Claim the key for processing; resolves true when this caller won the claim
   * (i.e. process it), false for a duplicate/in-flight delivery. The claim is a
   * lease — see `markDone`/`delete` for how it's resolved.
   */
  markIfNew(key: string, conversationId?: string): Promise<boolean>;
  /** Mark a claimed key as successfully processed (closes the lease). */
  markDone(key: string): Promise<void>;
  /** Forget a key so a redelivery can be reprocessed (used when a turn fails). */
  delete(key: string): Promise<void>;
}

/**
 * In-memory dedup: bounded + TTL'd so memory can't grow unbounded in a
 * long-running process. Correct for a single always-on instance; use
 * `PgIdempotencyStore` when running more than one instance or when a restart
 * must not reopen the dedup window.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly max = 10_000,
  ) {}

  async markIfNew(key: string): Promise<boolean> {
    const now = Date.now();
    const at = this.seen.get(key);
    if (at !== undefined && now - at < this.ttlMs) return false;

    // Drop any expired entry for this key first, so re-adding it doesn't grow
    // the map and trigger an unnecessary eviction of an unrelated valid entry.
    this.seen.delete(key);
    if (this.seen.size >= this.max) {
      // Evict the oldest inserted key (Map preserves insertion order).
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.set(key, now);
    return true;
  }

  async markDone(): Promise<void> {
    // No-op: in-memory state is volatile, so a crash clears the whole map and a
    // redelivery reprocesses anyway. The lease only matters for the durable
    // (Postgres) store, where a claimed row survives a restart. See
    // PgIdempotencyStore.markDone.
  }

  async delete(key: string): Promise<void> {
    this.seen.delete(key);
  }

  has(key: string): boolean {
    const at = this.seen.get(key);
    return at !== undefined && Date.now() - at < this.ttlMs;
  }

  get size(): number {
    return this.seen.size;
  }
}
