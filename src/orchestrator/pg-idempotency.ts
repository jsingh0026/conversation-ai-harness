import { eq, sql } from 'drizzle-orm';
import type { Db } from '../config/db.js';
import { processedMessages } from '../config/schema.js';
import type { IdempotencyStore } from './idempotency.js';

/**
 * Durable, cross-instance webhook dedup with a processing lease (Drizzle over
 * Postgres). A single `INSERT ... ON CONFLICT` is the atomic claim: a returned
 * row means this delivery won the race (process it); no row means a recent
 * duplicate / in-flight turn (drop it). This closes the crash-mid-turn gap —
 * without the lease, a process that died after claiming would leave the key
 * permanently "seen" and HighLevel's retry would be lost. Reclaim rules:
 *   - a `done` row past the dedup TTL  → genuine repeat, reprocess
 *   - a `processing` row past the lease → the previous attempt died, reprocess
 */
export class PgIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly db: Db,
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly leaseMs = 2 * 60 * 1000,
  ) {}

  async markIfNew(key: string, conversationId?: string): Promise<boolean> {
    const rows = await this.db
      .insert(processedMessages)
      .values({ messageId: key, conversationId: conversationId ?? null, status: 'processing' })
      .onConflictDoUpdate({
        target: processedMessages.messageId,
        set: { status: 'processing', conversationId: conversationId ?? null, processedAt: sql`now()` },
        setWhere: sql`(${processedMessages.status} = 'done'
                        AND ${processedMessages.processedAt} < now() - ${this.ttlMs} * interval '1 millisecond')
                     OR (${processedMessages.status} = 'processing'
                        AND ${processedMessages.processedAt} < now() - ${this.leaseMs} * interval '1 millisecond')`,
      })
      .returning({ id: processedMessages.messageId });
    return rows.length > 0;
  }

  async markDone(key: string): Promise<void> {
    // Close the lease and restart the dedup TTL from completion time.
    await this.db
      .update(processedMessages)
      .set({ status: 'done', processedAt: sql`now()` })
      .where(eq(processedMessages.messageId, key));
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(processedMessages).where(eq(processedMessages.messageId, key));
  }

  /** Prune completed rows past the TTL. Call periodically; safe to run concurrently. */
  async prune(): Promise<number> {
    const rows = await this.db
      .delete(processedMessages)
      .where(
        sql`${processedMessages.status} = 'done'
            AND ${processedMessages.processedAt} < now() - ${this.ttlMs} * interval '1 millisecond'`,
      )
      .returning({ id: processedMessages.messageId });
    return rows.length;
  }
}
