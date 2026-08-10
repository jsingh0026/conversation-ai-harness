import { describe, expect, it } from 'vitest';
import type { Db } from '../config/db.js';
import { PgIdempotencyStore } from './pg-idempotency.js';

/**
 * A chainable Drizzle stub: every builder method returns the same thenable that
 * resolves to `result`. Lets us assert our logic (row-count → boolean, mapping)
 * without a live Postgres — the SQL itself is Drizzle's responsibility.
 */
function stubDb(result: unknown[]): Db {
  const chain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result);
        return () => chain;
      },
    },
  );
  return { insert: () => chain, update: () => chain, delete: () => chain, select: () => chain } as unknown as Db;
}

describe('PgIdempotencyStore (Drizzle)', () => {
  it('claims a new/reclaimable key (a returned row) → true', async () => {
    expect(await new PgIdempotencyStore(stubDb([{ id: 'm1' }])).markIfNew('m1', 'c1')).toBe(true);
  });

  it('treats no returned row as a duplicate / in-flight delivery → false', async () => {
    expect(await new PgIdempotencyStore(stubDb([])).markIfNew('m1')).toBe(false);
  });

  it('markDone and delete resolve without throwing', async () => {
    const s = new PgIdempotencyStore(stubDb([]));
    await expect(s.markDone('m1')).resolves.toBeUndefined();
    await expect(s.delete('m1')).resolves.toBeUndefined();
  });

  it('prune returns the number of rows removed', async () => {
    expect(await new PgIdempotencyStore(stubDb([{ id: 'a' }, { id: 'b' }])).prune()).toBe(2);
  });
});
