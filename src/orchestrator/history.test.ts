import { describe, expect, it, vi } from 'vitest';
import { ConversationStore } from './history.js';

const u = (content: string) => ({ role: 'user' as const, content });

describe('ConversationStore', () => {
  it('keeps and returns appended messages', () => {
    const s = new ConversationStore();
    s.append('c1', u('hi'), { role: 'assistant', content: 'hello' });
    expect(s.get('c1')).toHaveLength(2);
  });

  it('bounds history to the last N messages', () => {
    const s = new ConversationStore(2);
    s.append('c1', u('a'), u('b'), u('c'));
    expect(s.get('c1').map((m) => ('content' in m ? m.content : ''))).toEqual(['b', 'c']);
  });

  it('keeps context when messages are within the idle window', () => {
    let now = 1_000_000;
    const s = new ConversationStore(40, 30 * 60 * 1000, () => now);
    s.append('c1', u('earlier'));
    now += 5 * 60 * 1000; // 5 min later — a refresh / active chat
    expect(s.get('c1')).toHaveLength(1);
  });

  it('resets context after the idle window (a fresh chat later)', () => {
    let now = 1_000_000;
    const s = new ConversationStore(40, 30 * 60 * 1000, () => now);
    s.append('c1', u('yesterday'));
    now += 31 * 60 * 1000; // past the 30-min window
    expect(s.get('c1')).toHaveLength(0); // stale context dropped
  });

  it('resets are per-conversation', () => {
    let now = 1_000_000;
    const s = new ConversationStore(40, 30 * 60 * 1000, () => now);
    s.append('c1', u('old'));
    now += 31 * 60 * 1000;
    s.append('c2', u('fresh'));
    expect(s.get('c1')).toHaveLength(0);
    expect(s.get('c2')).toHaveLength(1);
  });

  it('sweep evicts conversations that go idle and never return', () => {
    let now = 1_000_000;
    const s = new ConversationStore(40, 30 * 60 * 1000, () => now);
    s.append('c1', u('one-off'));
    s.append('c2', u('also idle'));
    now += 31 * 60 * 1000; // both past the idle window, but neither is re-accessed
    expect(s.size()).toBe(2); // lazy get() never fired — they'd linger forever
    expect(s.sweep()).toBe(2); // the sweep frees them
    expect(s.size()).toBe(0);
  });

  it('sweep keeps still-active conversations', () => {
    let now = 1_000_000;
    const s = new ConversationStore(40, 30 * 60 * 1000, () => now);
    s.append('c1', u('idle'));
    now += 31 * 60 * 1000;
    s.append('c2', u('active')); // touched just now
    expect(s.sweep()).toBe(1); // only c1 is stale
    expect(s.size()).toBe(1);
    expect(s.get('c2')).toHaveLength(1);
  });

  it('startSweeper runs sweeps on an interval and stop() halts them', () => {
    vi.useFakeTimers();
    try {
      let removed = 0;
      const s = new ConversationStore(40, 1000);
      s.append('c1', u('x'));
      const stop = s.startSweeper(500, (n) => (removed += n));
      vi.advanceTimersByTime(1600); // past idle window → a tick evicts c1
      expect(removed).toBe(1);
      expect(s.size()).toBe(0);
      stop();
      s.append('c2', u('y'));
      vi.advanceTimersByTime(5000); // no more sweeps after stop()
      expect(s.size()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
