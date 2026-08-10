import { describe, expect, it } from 'vitest';
import { MemoryIdempotencyStore } from './idempotency.js';

describe('MemoryIdempotencyStore', () => {
  it('marks a key new once, then treats it as seen', async () => {
    const s = new MemoryIdempotencyStore();
    expect(await s.markIfNew('m1')).toBe(true);
    expect(await s.markIfNew('m1')).toBe(false);
    expect(s.has('m1')).toBe(true);
  });

  it('treats distinct keys independently', async () => {
    const s = new MemoryIdempotencyStore();
    expect(await s.markIfNew('m1')).toBe(true);
    expect(await s.markIfNew('m2')).toBe(true);
  });

  it('re-accepts a key after its TTL expires', async () => {
    const s = new MemoryIdempotencyStore(10); // 10ms TTL
    expect(await s.markIfNew('m1')).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(await s.markIfNew('m1')).toBe(true);
  });

  it('re-accepts a key after delete (failed-turn retry path)', async () => {
    const s = new MemoryIdempotencyStore();
    expect(await s.markIfNew('m1')).toBe(true);
    await s.delete('m1');
    expect(await s.markIfNew('m1')).toBe(true);
  });

  it('evicts oldest entries past the cap', async () => {
    const s = new MemoryIdempotencyStore(60_000, 2);
    await s.markIfNew('a');
    await s.markIfNew('b');
    await s.markIfNew('c'); // evicts 'a'
    expect(s.size).toBe(2);
    expect(s.has('a')).toBe(false);
    expect(s.has('c')).toBe(true);
  });
});
