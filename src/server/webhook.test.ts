import { describe, expect, it } from 'vitest';
import { normalizeWebhook } from './webhook.js';

describe('normalizeWebhook', () => {
  it('normalizes a well-formed inbound message', () => {
    const result = normalizeWebhook({
      messageId: 'm1',
      conversationId: 'c1',
      contactId: 'ct1',
      body: '  hi there ',
      messageType: 'SMS',
    });
    expect('skip' in result).toBe(false);
    if ('skip' in result) return;
    expect(result.idempotencyKey).toBe('m1');
    expect(result.message.body).toBe('hi there');
    expect(result.message.channel).toBe('SMS');
  });

  it('falls back across field aliases (id/message)', () => {
    const result = normalizeWebhook({ id: 'm2', conversationId: 'c1', contactId: 'ct1', message: 'yo' });
    if ('skip' in result) throw new Error('should not skip');
    expect(result.idempotencyKey).toBe('m2');
    expect(result.message.body).toBe('yo');
  });

  it.each([
    [{ conversationId: 'c', contactId: 'ct', body: 'x' }, 'missing messageId'],
    [{ messageId: 'm', contactId: 'ct', body: 'x' }, 'missing conversationId'],
    [{ messageId: 'm', conversationId: 'c', body: '   ' }, 'missing contactId'],
    [{ messageId: 'm', conversationId: 'c', contactId: 'ct', body: '   ' }, 'empty body'],
  ])('skips invalid payload (%#)', (raw, reason) => {
    const result = normalizeWebhook(raw);
    expect(result).toEqual({ skip: reason });
  });
});
