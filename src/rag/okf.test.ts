import { describe, expect, it } from 'vitest';
import { parseOkf } from './okf.js';

describe('parseOkf', () => {
  it('strips frontmatter and extracts provenance', () => {
    const doc = `---
type: policy
status: stable
stale_after: 2026-12-31
verified:
  - { by: human:broker, at: 2026-06-01T09:00:00Z }
sources:
  - id: fee-schedule
---
# Fees
Sellers pay 5%.`;
    const { body, provenance } = parseOkf(doc);
    expect(body.startsWith('# Fees')).toBe(true);
    expect(body).not.toContain('type: policy'); // frontmatter never embedded
    expect(provenance).toMatchObject({
      status: 'stable',
      staleAfter: '2026-12-31',
      verifiedBy: 'human:broker',
      verifiedAt: '2026-06-01',
      sourceId: 'fee-schedule',
    });
  });

  it('returns no provenance for plain markdown', () => {
    const { body, provenance } = parseOkf('# Plain\nno frontmatter here');
    expect(body).toContain('# Plain');
    expect(provenance).toBeUndefined();
  });

  it('defaults status to stable when frontmatter present but status omitted', () => {
    expect(parseOkf('---\ntype: policy\n---\n# X').provenance?.status).toBe('stable');
  });

  it('reads a deprecated status', () => {
    expect(parseOkf('---\nstatus: deprecated\n---\n# X').provenance?.status).toBe('deprecated');
  });

  it('strips malformed frontmatter without crashing (no provenance)', () => {
    const { body, provenance } = parseOkf('---\n: : bad yaml :\n---\n# Body');
    expect(body).toContain('# Body');
    expect(provenance).toBeUndefined();
  });
});
