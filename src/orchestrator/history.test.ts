import { describe, expect, it } from 'vitest';
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
});
