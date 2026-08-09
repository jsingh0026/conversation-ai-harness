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

  it('falls back across field aliases (id/message/contact_id)', () => {
    const result = normalizeWebhook({ id: 'm2', conversationId: 'c1', contact_id: 'ct1', message: 'yo' });
    if ('skip' in result) throw new Error('should not skip');
    expect(result.idempotencyKey).toBe('m2');
    expect(result.message.body).toBe('yo');
    expect(result.message.contactId).toBe('ct1');
  });

  it('synthesizes a message id when none is provided (HighLevel workflow ping)', () => {
    const result = normalizeWebhook({ contactId: 'ct1', body: 'hello' });
    if ('skip' in result) throw new Error('should not skip');
    expect(result.message.messageId).toMatch(/^gen_/);
    // conversationId defaults to the contact id.
    expect(result.message.conversationId).toBe('ct1');
  });

  it('dedupes identical contact+body within the same window to one id', () => {
    const a = normalizeWebhook({ contactId: 'ct1', body: 'hi' });
    const b = normalizeWebhook({ contactId: 'ct1', body: 'hi' });
    if ('skip' in a || 'skip' in b) throw new Error('should not skip');
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
  });

  it.each([
    [{ conversationId: 'c', messageId: 'm', body: 'x' }, 'missing contactId'],
    [{ messageId: 'm', conversationId: 'c', contactId: 'ct', body: '   ' }, 'empty body'],
  ])('skips invalid payload (%#)', (raw, reason) => {
    const result = normalizeWebhook(raw);
    expect(result).toEqual({ skip: reason });
  });
});
