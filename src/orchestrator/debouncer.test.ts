import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../crm/types.js';
import { ConversationDebouncer, type DebouncedBatch } from './debouncer.js';

const msg = (body: string, over: Partial<InboundMessage> = {}): InboundMessage => ({
  messageId: 'm',
  conversationId: 'c1',
  contactId: 'ct1',
  body,
  channel: 'Live_Chat',
  timestamp: '2026-08-11T00:00:00Z',
  ...over,
});

describe('ConversationDebouncer', () => {
  it('windowMs=0 flushes each message immediately (legacy behavior)', () => {
    const batches: DebouncedBatch[] = [];
    const d = new ConversationDebouncer(0, (b) => batches.push(b));
    d.add(msg('hi', { messageId: 'm1' }), 'm1');
    d.add(msg('there', { messageId: 'm2' }), 'm2');
    expect(batches).toHaveLength(2);
    expect(batches[0]!.keys).toEqual(['m1']);
  });

  describe('with timers', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('coalesces a burst into one batch and dedupes exact repeats', () => {
      const batches: DebouncedBatch[] = [];
      const d = new ConversationDebouncer(2500, (b) => batches.push(b));
      d.add(msg('hi', { messageId: 'm1' }), 'm1');
      d.add(msg('hi', { messageId: 'm2' }), 'm2');
      d.add(msg('hi', { messageId: 'm3' }), 'm3');
      expect(batches).toHaveLength(0); // still buffering
      vi.advanceTimersByTime(2500);
      expect(batches).toHaveLength(1);
      expect(batches[0]!.message.body).toBe('hi'); // deduped
      expect(batches[0]!.keys).toEqual(['m1', 'm2', 'm3']); // all keys covered
    });

    it('joins distinct lines of a split thought', () => {
      const batches: DebouncedBatch[] = [];
      const d = new ConversationDebouncer(2000, (b) => batches.push(b));
      d.add(msg('I want to', { messageId: 'a' }), 'a');
      d.add(msg('sell my house', { messageId: 'b' }), 'b');
      vi.advanceTimersByTime(2000);
      expect(batches[0]!.message.body).toBe('I want to\nsell my house');
    });

    it('separate conversations flush independently', () => {
      const batches: DebouncedBatch[] = [];
      const d = new ConversationDebouncer(1000, (b) => batches.push(b));
      d.add(msg('a', { conversationId: 'c1' }), 'k1');
      d.add(msg('b', { conversationId: 'c2' }), 'k2');
      vi.advanceTimersByTime(1000);
      expect(batches).toHaveLength(2);
      expect(new Set(batches.map((b) => b.conversationId))).toEqual(new Set(['c1', 'c2']));
    });

    it('a later message extends the quiet window', () => {
      const batches: DebouncedBatch[] = [];
      const d = new ConversationDebouncer(1000, (b) => batches.push(b));
      d.add(msg('one', { messageId: 'm1' }), 'm1');
      vi.advanceTimersByTime(600); // not yet
      d.add(msg('two', { messageId: 'm2' }), 'm2'); // resets the window
      vi.advanceTimersByTime(600); // 1200 total, but only 600 since last
      expect(batches).toHaveLength(0);
      vi.advanceTimersByTime(400); // now 1000 since last
      expect(batches).toHaveLength(1);
      expect(batches[0]!.message.body).toBe('one\ntwo');
    });
  });
});
