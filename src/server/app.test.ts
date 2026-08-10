import { describe, expect, it } from 'vitest';
import { MockCrmClient } from '../crm/mock.js';
import {
  ConversationStore,
  MemoryIdempotencyStore,
  KeyedQueue,
  Orchestrator,
  type OrchestratorStack,
} from '../orchestrator/index.js';
import { StubProvider, textResult } from '../testkit/stub-provider.js';
import { buildApp } from './app.js';

// Default to '' (open) so tests don't inherit an ambient HL_WEBHOOK_SECRET from .env.
function harness(results = [textResult('hello back')], webhookSecret = '', debounceMs = 0) {
  const crm = new MockCrmClient();
  const provider = new StubProvider(results);
  const history = new ConversationStore();
  const stack: OrchestratorStack = {
    orchestrator: new Orchestrator({ provider, crm, history }),
    queue: new KeyedQueue(),
    idempotency: new MemoryIdempotencyStore(),
    history,
  };
  return { crm, stack, app: buildApp({ crm, stack, webhookSecret, debounceMs }) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const inbound = (over: Record<string, unknown> = {}) => ({
  messageId: 'm1',
  conversationId: 'c1',
  contactId: 'ct1',
  body: 'hi',
  messageType: 'SMS',
  ...over,
});

describe('POST /webhook', () => {
  it('accepts an inbound message and sends a reply through the CRM', async () => {
    const { crm, stack, app } = harness();
    const res = await app.inject({ method: 'POST', url: '/webhook', payload: inbound() });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ accepted: true, messageId: 'm1' });

    await stack.queue.onIdle();
    expect(crm.lastSent()?.body).toBe('hello back');
  });

  it('drops duplicate deliveries (idempotency)', async () => {
    const { crm, stack, app } = harness([textResult('first')]);
    const first = await app.inject({ method: 'POST', url: '/webhook', payload: inbound() });
    const dup = await app.inject({ method: 'POST', url: '/webhook', payload: inbound() });

    expect(first.statusCode).toBe(202);
    expect(dup.statusCode).toBe(200);
    expect(dup.json()).toEqual({ duplicate: true });

    await stack.queue.onIdle();
    expect(crm.sent).toHaveLength(1);
  });

  it('rejects a webhook without the configured shared secret', async () => {
    const { crm, stack, app } = harness([textResult('x')], 'topsecret');
    const res = await app.inject({ method: 'POST', url: '/webhook', payload: inbound() });
    expect(res.statusCode).toBe(401);
    await stack.queue.onIdle();
    expect(crm.sent).toHaveLength(0);
  });

  it('accepts a webhook carrying the correct secret header', async () => {
    const { crm, stack, app } = harness([textResult('ok')], 'topsecret');
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'x-webhook-secret': 'topsecret' },
      payload: inbound(),
    });
    expect(res.statusCode).toBe(202);
    await stack.queue.onIdle();
    expect(crm.lastSent()?.body).toBe('ok');
  });

  it('ignores non-actionable payloads without processing', async () => {
    const { crm, stack, app } = harness();
    const res = await app.inject({ method: 'POST', url: '/webhook', payload: inbound({ body: '' }) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ignored: 'empty body' });
    await stack.queue.onIdle();
    expect(crm.sent).toHaveLength(0);
  });

  it('coalesces a rapid burst of distinct messages into ONE reply (debounce)', async () => {
    const { crm, stack, app } = harness([textResult('one answer')], '', 40);
    // three distinct messageIds (all pass idempotency), sent in a burst
    for (const id of ['m1', 'm2', 'm3']) {
      const res = await app.inject({
        method: 'POST',
        url: '/webhook',
        payload: inbound({ messageId: id, body: 'hi' }),
      });
      expect(res.statusCode).toBe(202);
    }
    await sleep(80); // let the debounce window settle
    await stack.queue.onIdle();
    expect(crm.sent).toHaveLength(1); // one coalesced reply, not three
    expect(crm.lastSent()?.body).toBe('one answer');
  });

  it('debounce + idempotency: a redelivered id in a burst is not double-counted', async () => {
    const { crm, stack, app } = harness([textResult('answer')], '', 40);
    const send = (id: string) =>
      app.inject({ method: 'POST', url: '/webhook', payload: inbound({ messageId: id, body: 'hi' }) });
    const a = await send('m1');
    const b = await send('m1'); // exact redelivery — idempotency should drop it
    const c = await send('m2');
    expect(a.statusCode).toBe(202);
    expect(b.json()).toEqual({ duplicate: true });
    expect(c.statusCode).toBe(202);
    await sleep(80);
    await stack.queue.onIdle();
    expect(crm.sent).toHaveLength(1); // still one reply
  });

  it('health reports the wired CRM + provider', async () => {
    const { app } = harness();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toMatchObject({ status: 'ok', crm: 'mock' });
  });
});
