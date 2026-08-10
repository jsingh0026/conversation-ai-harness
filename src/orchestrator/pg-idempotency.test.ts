import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { PgIdempotencyStore } from './pg-idempotency.js';

function fakePool(rowCount: number): { pool: Pool; last: () => { text: string; params: unknown[] } } {
  let call = { text: '', params: [] as unknown[] };
  const pool = {
    query: async (text: string, params: unknown[]) => {
      call = { text, params };
      return { rows: [], rowCount };
    },
  } as unknown as Pool;
  return { pool, last: () => call };
}

describe('PgIdempotencyStore', () => {
  it('claims via INSERT with a processing lease, passing ttl + lease', async () => {
    const { pool, last } = fakePool(1);
    const store = new PgIdempotencyStore(pool, 600_000, 120_000);
    expect(await store.markIfNew('m1', 'conv1')).toBe(true);
    expect(last().text).toMatch(/INSERT INTO processed_messages/);
    expect(last().text).toMatch(/'processing'/);
    expect(last().params).toEqual(['m1', 'conv1', 600_000, 120_000]);
  });

  it('treats no returned row as a duplicate/in-flight delivery (skip it)', async () => {
    const { pool } = fakePool(0);
    expect(await new PgIdempotencyStore(pool).markIfNew('m1')).toBe(false);
  });

  it('passes null conversationId when omitted', async () => {
    const { pool, last } = fakePool(1);
    await new PgIdempotencyStore(pool).markIfNew('m1');
    expect(last().params[1]).toBeNull();
  });

  it('markDone flips the row to done (closes the lease)', async () => {
    const { pool, last } = fakePool(1);
    await new PgIdempotencyStore(pool).markDone('m1');
    expect(last().text).toMatch(/UPDATE processed_messages SET status = 'done'/);
    expect(last().params).toEqual(['m1']);
  });

  it('deletes a key on the failed-turn retry path', async () => {
    const { pool, last } = fakePool(1);
    await new PgIdempotencyStore(pool).delete('m1');
    expect(last().text).toMatch(/DELETE FROM processed_messages/);
    expect(last().params).toEqual(['m1']);
  });
});
