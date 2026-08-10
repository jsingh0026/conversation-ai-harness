import type { Pool } from 'pg';
import type { IdempotencyStore } from './idempotency.js';

/**
 * Durable, cross-instance webhook dedup with a processing lease. A claim inserts
 * (or reclaims) a `processing` row; success flips it to `done`. This closes the
 * crash-mid-turn gap: without a lease, a process that dies after claiming would
 * leave the key permanently "seen", so HighLevel's retry would be dropped and
 * the customer never answered. Reclaim rules:
 *   - a `done` row past the dedup TTL  → genuine repeat, reprocess
 *   - a `processing` row past the lease → the previous attempt died, reprocess
 * Both TTL and lease are short enough to recover quickly, long enough that a
 * healthy in-flight turn (or a real duplicate burst) is still deduped.
 */
export class PgIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly pool: Pool,
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly leaseMs = 2 * 60 * 1000,
  ) {}

  async markIfNew(key: string, conversationId?: string): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO processed_messages (message_id, conversation_id, status, processed_at)
            VALUES ($1, $2, 'processing', now())
       ON CONFLICT (message_id) DO UPDATE
              SET status = 'processing',
                  conversation_id = EXCLUDED.conversation_id,
                  processed_at = now()
            WHERE (processed_messages.status = 'done'
                   AND processed_messages.processed_at < now() - ($3 * interval '1 millisecond'))
               OR (processed_messages.status = 'processing'
                   AND processed_messages.processed_at < now() - ($4 * interval '1 millisecond'))
        RETURNING message_id`,
      [key, conversationId ?? null, this.ttlMs, this.leaseMs],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async markDone(key: string): Promise<void> {
    // Close the lease and restart the dedup TTL from completion time.
    await this.pool.query(
      `UPDATE processed_messages SET status = 'done', processed_at = now() WHERE message_id = $1`,
      [key],
    );
  }

  async delete(key: string): Promise<void> {
    await this.pool.query('DELETE FROM processed_messages WHERE message_id = $1', [key]);
  }

  /** Prune completed rows past the TTL. Call periodically; safe to run concurrently. */
  async prune(): Promise<number> {
    const res = await this.pool.query(
      `DELETE FROM processed_messages
             WHERE status = 'done' AND processed_at < now() - ($1 * interval '1 millisecond')`,
      [this.ttlMs],
    );
    return res.rowCount ?? 0;
  }
}
