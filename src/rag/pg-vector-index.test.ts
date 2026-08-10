import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { PgVectorIndex } from './pg-vector-index.js';

/** Minimal fake Pool that records the last query and returns canned rows. */
function fakePool(rows: unknown[]): { pool: Pool; last: () => { text: string; params: unknown[] } } {
  let call = { text: '', params: [] as unknown[] };
  const pool = {
    query: async (text: string, params: unknown[]) => {
      call = { text, params };
      return { rows, rowCount: rows.length };
    },
  } as unknown as Pool;
  return { pool, last: () => call };
}

describe('PgVectorIndex', () => {
  it('maps rows to RetrievedChunk and coerces score, filtering by embed model', async () => {
    const { pool, last } = fakePool([
      { id: 'fees#0', doc_id: 'fees', title: 'Fees', section: 'Commission', text: '5%', score: '0.91' },
      { id: 'rent#0', doc_id: 'rent', title: 'Rentals', section: null, text: '8%', score: '0.42' },
    ]);
    const idx = new PgVectorIndex(pool, 'bge-small');
    const out = await idx.search([0.1, 0.2, 0.3], 5);

    expect(out).toEqual([
      { id: 'fees#0', docId: 'fees', title: 'Fees', section: 'Commission', text: '5%', score: 0.91 },
      { id: 'rent#0', docId: 'rent', title: 'Rentals', section: undefined, text: '8%', score: 0.42 },
    ]);
    // vector literal + model filter + k are passed through
    expect(last().params).toEqual(['[0.1,0.2,0.3]', 'bge-small', 5]);
  });

  it('returns the count for size()', async () => {
    const { pool } = fakePool([{ n: 13 }]);
    expect(await new PgVectorIndex(pool, 'bge-small').size()).toBe(13);
  });
});
