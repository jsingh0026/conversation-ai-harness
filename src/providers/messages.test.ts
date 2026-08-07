import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LlmMessage } from '../llm/types.js';
import { toModelMessages, toToolSet } from './messages.js';

describe('toModelMessages', () => {
  it('maps a user message', () => {
    expect(toModelMessages([{ role: 'user', content: 'hi' }])).toEqual([
      { role: 'user', content: 'hi' },
    ]);
  });

  it('maps a plain assistant message', () => {
    expect(toModelMessages([{ role: 'assistant', content: 'hello' }])).toEqual([
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('maps an assistant tool-call turn to SDK parts', () => {
    const msgs: LlmMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'search', args: { q: 'x' } }] },
    ];
    const out = toModelMessages(msgs);
    expect(out[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'search', input: { q: 'x' } }],
    });
  });

  it('includes assistant text before tool calls when present', () => {
    const out = toModelMessages([
      { role: 'assistant', content: 'let me check', toolCalls: [{ id: 't1', name: 'search', args: {} }] },
    ]);
    expect(out[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me check' },
        { type: 'tool-call', toolCallId: 't1', toolName: 'search', input: {} },
      ],
    });
  });

  it('maps a tool-result turn', () => {
    const out = toModelMessages([
      { role: 'tool', toolResults: [{ toolCallId: 't1', name: 'search', result: { hits: 2 } }] },
    ]);
    expect(out[0]).toEqual({
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 't1', toolName: 'search', output: { type: 'json', value: { hits: 2 } } },
      ],
    });
  });
});

describe('toToolSet', () => {
  it('returns undefined for no tools', () => {
    expect(toToolSet(undefined)).toBeUndefined();
    expect(toToolSet([])).toBeUndefined();
  });

  it('builds a tool set keyed by name', () => {
    const set = toToolSet([
      { name: 'search', description: 'search kb', parameters: z.object({ q: z.string() }) },
    ]);
    expect(Object.keys(set ?? {})).toEqual(['search']);
    expect(set?.['search']?.description).toBe('search kb');
  });
});
