import { describe, expect, it } from 'vitest';
import { IdempotencyStore } from './idempotency.js';

describe('IdempotencyStore', () => {
  it('marks a key new once, then treats it as seen', () => {
    const s = new IdempotencyStore();
    expect(s.markIfNew('m1')).toBe(true);
    expect(s.markIfNew('m1')).toBe(false);
    expect(s.has('m1')).toBe(true);
  });

  it('treats distinct keys independently', () => {
    const s = new IdempotencyStore();
    expect(s.markIfNew('m1')).toBe(true);
    expect(s.markIfNew('m2')).toBe(true);
  });

  it('re-accepts a key after its TTL expires', async () => {
    const s = new IdempotencyStore(10); // 10ms TTL
    expect(s.markIfNew('m1')).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.markIfNew('m1')).toBe(true);
  });

  it('evicts oldest entries past the cap', () => {
    const s = new IdempotencyStore(60_000, 2);
    s.markIfNew('a');
    s.markIfNew('b');
    s.markIfNew('c'); // evicts 'a'
    expect(s.size).toBe(2);
    expect(s.has('a')).toBe(false);
    expect(s.has('c')).toBe(true);
  });
});
