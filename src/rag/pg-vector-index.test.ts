import { describe, expect, it } from 'vitest';
import type { Db } from '../config/db.js';
import { PgVectorIndex } from './pg-vector-index.js';

/** Chainable Drizzle stub — every builder method resolves to `result`. */
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
  return { select: () => chain } as unknown as Db;
}

describe('PgVectorIndex (Drizzle)', () => {
  it('maps rows to RetrievedChunk incl. OKF provenance, coercing score', async () => {
    const db = stubDb([
      {
        id: 'fees#0', docId: 'fees', title: 'Fees', section: 'Commission', text: '5%',
        status: 'stable', verifiedBy: 'human:broker', verifiedAt: '2026-06-01',
        staleAfter: '2026-12-31', sourceId: 'fee-schedule', score: '0.91',
      },
      {
        id: 'rent#0', docId: 'rent', title: 'Rentals', section: null, text: '8%',
        status: null, verifiedBy: null, verifiedAt: null, staleAfter: null, sourceId: null,
        score: '0.42',
      },
    ]);
    const out = await new PgVectorIndex(db, 'bge-small').search([0.1, 0.2, 0.3], 5);

    expect(out[0]).toMatchObject({
      docId: 'fees',
      score: 0.91,
      provenance: { status: 'stable', sourceId: 'fee-schedule', staleAfter: '2026-12-31' },
    });
    expect(out[1]!.provenance).toBeUndefined(); // no status → no provenance
    expect(out[1]!.section).toBeUndefined(); // null → undefined
  });

  it('size() returns the count', async () => {
    expect(await new PgVectorIndex(stubDb([{ n: 13 }]), 'bge-small').size()).toBe(13);
  });
});
