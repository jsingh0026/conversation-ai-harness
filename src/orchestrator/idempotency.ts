/**
 * Dedupes webhook deliveries by message id. HighLevel can deliver the same
 * inbound message more than once; the first delivery to `markIfNew` wins and
 * subsequent duplicates are dropped. Bounded + TTL'd so memory can't grow
 * unbounded in a long-running process.
 */
export class IdempotencyStore {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly max = 10_000,
  ) {}

  /** Record the key if unseen; returns true when it's new (i.e. process it). */
  markIfNew(key: string): boolean {
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

  /** Forget a key so a redelivery can be reprocessed (used when a turn fails). */
  delete(key: string): void {
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
