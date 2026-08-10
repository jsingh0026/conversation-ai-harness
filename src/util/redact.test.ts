import { describe, expect, it } from 'vitest';
import type { Trace } from '../trace/types.js';
import { redactDeep, redactPii, redactTrace } from './redact.js';

describe('redactPii', () => {
  it('masks an email but keeps first char + domain for correlation', () => {
    expect(redactPii('contact jane.doe@gmail.com please')).toBe('contact j***@gmail.com please');
  });

  it('masks an email interpolated into a message', () => {
    expect(redactPii('OTP failed for alex@example.co.uk')).toBe('OTP failed for a***@example.co.uk');
  });

  it('masks phone numbers keeping the last two digits', () => {
    expect(redactPii('call +14155550123 now')).toContain('***23');
    expect(redactPii('call 415-555-0123 now')).toContain('***23');
  });

  it('masks phones formatted with Unicode dashes/spaces (models emit these)', () => {
    // U+2011 non-breaking hyphen + U+00A0 no-break space, as gpt-oss tends to output
    expect(redactPii('reach us at (555) 012‑8899.')).toContain('***99');
    expect(redactPii('phone: 415 555–0123')).toContain('***23');
  });

  it('leaves non-PII text untouched', () => {
    expect(redactPii('commission is 5% for sellers')).toBe('commission is 5% for sellers');
  });

  it('is bounded: skips very long strings', () => {
    const big = 'x'.repeat(9000) + ' a@b.com';
    expect(redactPii(big)).toBe(big); // over the length guard → returned as-is
  });
});

describe('redactDeep', () => {
  it('masks strings anywhere in a nested structure, keeping shape', () => {
    const out = redactDeep({ email: 'a@b.com', nested: { list: ['x@y.com', 42] } });
    expect(out).toEqual({ email: 'a***@b.com', nested: { list: ['x***@y.com', 42] } });
  });
});

describe('redactTrace', () => {
  it('masks input, reply, system, and tool step i/o', () => {
    const trace: Trace = {
      turnId: 't1',
      conversationId: 'c1',
      contactId: 'ct1',
      startedAt: '2026-08-10T00:00:00Z',
      latencyMs: 100,
      input: "I'm jane@x.com",
      system: 'You are helping ct1',
      decision: 'skill:update_contact_field',
      steps: [
        {
          type: 'tool',
          name: 'update_contact_field',
          input: { email: 'jane@x.com' },
          output: { updated: true },
          latencyMs: 10,
          ok: true,
        },
      ],
      tokens: { inputTokens: 1, outputTokens: 1 },
      reply: 'Saved, jane@x.com',
    };
    const red = redactTrace(trace);
    expect(red.input).toBe("I'm j***@x.com");
    expect(red.reply).toBe('Saved, j***@x.com');
    expect((red.steps[0] as { input: { email: string } }).input.email).toBe('j***@x.com');
    // original untouched
    expect(trace.input).toBe("I'm jane@x.com");
  });
});
