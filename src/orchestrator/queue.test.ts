import { describe, expect, it } from 'vitest';
import { KeyedQueue } from './queue.js';

const defer = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('KeyedQueue', () => {
  it('serializes tasks with the same key in order', async () => {
    const q = new KeyedQueue();
    const order: number[] = [];
    q.enqueue('c1', async () => {
      await defer(20);
      order.push(1);
    });
    q.enqueue('c1', async () => {
      await defer(1);
      order.push(2);
    });
    await q.onIdle();
    expect(order).toEqual([1, 2]);
  });

  it('runs different keys concurrently', async () => {
    const q = new KeyedQueue();
    const order: string[] = [];
    q.enqueue('a', async () => {
      await defer(20);
      order.push('a');
    });
    q.enqueue('b', async () => {
      await defer(1);
      order.push('b');
    });
    await q.onIdle();
    expect(order).toEqual(['b', 'a']); // b finishes first despite enqueuing second
  });

  it('returns the task result to the caller', async () => {
    const q = new KeyedQueue();
    await expect(q.enqueue('a', async () => 42)).resolves.toBe(42);
  });

  it('isolates failures — one rejected task does not break the chain', async () => {
    const q = new KeyedQueue();
    const p1 = q.enqueue('a', async () => {
      throw new Error('boom');
    });
    const p2 = q.enqueue('a', async () => 'ok');
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
  });

  it('onIdle waits for tasks queued while draining', async () => {
    const q = new KeyedQueue();
    let done = false;
    q.enqueue('a', async () => {
      await defer(5);
      q.enqueue('a', async () => {
        await defer(5);
        done = true;
      });
    });
    await q.onIdle();
    expect(done).toBe(true);
  });
});
