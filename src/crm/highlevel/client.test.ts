import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SlotTakenError } from '../errors.js';
import { fakeFetch, type FakeRoute } from '../../testkit/fake-fetch.js';
import { HighLevelClient } from './client.js';
import { HlHttp } from './http.js';
import { TokenManager } from './token-manager.js';

async function seededTokenManager(fetchImpl: typeof fetch): Promise<TokenManager> {
  const dir = await mkdtemp(join(tmpdir(), 'hlc-'));
  const tokenPath = join(dir, 'token.json');
  await writeFile(
    tokenPath,
    JSON.stringify({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }),
  );
  const tm = new TokenManager({ clientId: 'c', clientSecret: 's', redirectUri: 'x', tokenPath }, fetchImpl);
  await tm.load();
  return tm;
}

async function authedHttp(routes: FakeRoute[]): Promise<HlHttp> {
  return new HlHttp(await seededTokenManager(fakeFetch(routes)), fakeFetch(routes));
}

function client(http: HlHttp): HighLevelClient {
  return new HighLevelClient(http, {
    locationId: 'loc1',
    fieldMap: { budget: 'fld_budget' },
    assignedUserId: 'user-7',
    handoverTag: 'bot-handover',
  });
}

/** An http client whose sent request bodies are captured for assertions. */
async function capturingClient(responseJson: unknown): Promise<{ client: HighLevelClient; body: () => unknown }> {
  let captured: unknown;
  const fetchImpl: typeof fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    captured = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify(responseJson), { status: 200 });
  }) as typeof fetch;
  const http = new HlHttp(await seededTokenManager(fetchImpl), fetchImpl);
  return { client: client(http), body: () => captured };
}

describe('HighLevelClient', () => {
  it('sends a message with the right type/contact/body and returns the id', async () => {
    const { client: c, body } = await capturingClient({ messageId: 'm1' });
    const res = await c.sendMessage({ conversationId: 'c1', contactId: 'ct1', channel: 'SMS', body: 'hi' });
    expect(res.messageId).toBe('m1');
    expect(body()).toEqual({ type: 'SMS', contactId: 'ct1', message: 'hi' });
  });

  it('routes standard vs custom fields on update', async () => {
    const { client: c, body } = await capturingClient({
      contact: { id: 'ct1', firstName: 'Ada' },
    });
    await c.updateContactFields('ct1', { name: 'Ada Lovelace', budget: 500000 });
    expect(body()).toMatchObject({
      firstName: 'Ada',
      lastName: 'Lovelace',
      customFields: [{ id: 'fld_budget', value: 500000 }],
    });
  });

  it('clears the guest placeholder surname when only a first name is given', async () => {
    const { client: c, body } = await capturingClient({
      contact: { id: 'ct1', firstName: 'Jay' },
    });
    // Guest arrived as "Jay Visitor bnbny"; they tell us just "Jay".
    // HighLevel ignores an empty-string field, so the surname must be nulled to clear it.
    await c.updateContactFields('ct1', { name: 'Jay' });
    expect(body()).toMatchObject({ firstName: 'Jay', lastName: null });
  });

  it('re-resolves an orphaned contact id (GHL email-merge) and retries the update', async () => {
    const survivor = { id: 'SURV', firstName: 'Jaspreet', email: 'jaspreet@example.com' };
    let searchUrl = '';
    const http = await authedHttp([
      { method: 'PUT', match: /\/contacts\/DEAD$/, status: 400, json: { message: 'Contact not found for id:DEAD', error: 'Bad Request', statusCode: 400 } },
      { method: 'GET', match: /\/contacts\/\?/, json: { contacts: [survivor] }, onCall: (u) => (searchUrl = u) },
      { method: 'PUT', match: /\/contacts\/SURV$/, json: { contact: survivor } },
    ]);
    const out = await client(http).updateContactFields('DEAD', {
      name: 'Jaspreet',
      email: 'jaspreet@example.com',
    });
    expect(out.id).toBe('SURV'); // wrote to the surviving contact, not the dead id
    expect(searchUrl).toContain('query=jaspreet%40example.com'); // re-found by email
  });

  it('caches the remap so later calls in the turn skip the dead id', async () => {
    const survivor = { id: 'SURV', email: 'jaspreet@example.com' };
    let deadPuts = 0;
    let searches = 0;
    const http = await authedHttp([
      { method: 'PUT', match: /\/contacts\/DEAD$/, status: 400, json: { message: 'Contact not found for id:DEAD' }, onCall: () => (deadPuts += 1) },
      { method: 'GET', match: /\/contacts\/\?/, json: { contacts: [survivor] }, onCall: () => (searches += 1) },
      { method: 'PUT', match: /\/contacts\/SURV$/, json: { contact: survivor } },
    ]);
    const c = client(http);
    await c.updateContactFields('DEAD', { email: 'jaspreet@example.com' }); // heals + caches
    await c.updateContactFields('DEAD', { budget: 500000 }); // goes straight to SURV
    expect(deadPuts).toBe(1); // only the first attempt hit the dead id
    expect(searches).toBe(1); // searched once, then reused the cached remap
  });

  it('rethrows the not-found error when no surviving contact can be found', async () => {
    const http = await authedHttp([
      { method: 'PUT', match: /\/contacts\/DEAD$/, status: 400, json: { message: 'Contact not found for id:DEAD' } },
      { method: 'GET', match: /\/contacts\/\?/, json: { contacts: [] } }, // search finds nothing
    ]);
    await expect(
      client(http).updateContactFields('DEAD', { email: 'nobody@example.com' }),
    ).rejects.toThrow(/PUT \/contacts\/DEAD failed \(400\)/);
  });

  it('books an appointment, sending the required assignedUserId', async () => {
    const { client: c, body } = await capturingClient({ id: 'appt1' });
    const appt = await c.createAppointment({
      calendarId: 'cal1',
      contactId: 'ct1',
      startTime: '2026-08-09T15:00:00.000Z',
      endTime: '2026-08-09T15:30:00.000Z',
    });
    expect(appt).toMatchObject({ id: 'appt1', status: 'booked' });
    expect(body()).toMatchObject({
      calendarId: 'cal1',
      locationId: 'loc1',
      contactId: 'ct1',
      assignedUserId: 'user-7',
    });
  });

  it('maps a slot conflict to SlotTakenError', async () => {
    const routes: FakeRoute[] = [
      { method: 'POST', match: /events\/appointments/, status: 409, text: 'slot is taken' },
    ];
    const http = await authedHttp(routes);
    await expect(
      client(http).createAppointment({
        calendarId: 'cal1',
        contactId: 'ct1',
        startTime: '2026-08-09T15:00:00.000Z',
        endTime: '2026-08-09T15:30:00.000Z',
      }),
    ).rejects.toBeInstanceOf(SlotTakenError);
  });

  it('rehydrates bot-off state from the handover tag on a cold cache (survives restart)', async () => {
    let calls = 0;
    const routes: FakeRoute[] = [
      {
        method: 'GET',
        match: /contacts\//,
        json: { contact: { id: 'ct1', tags: ['bot-handover'] } },
        onCall: () => {
          calls++;
        },
      },
    ];
    const http = await authedHttp(routes);
    const c = client(http);
    // First check: no in-memory flag → reads the tag → disabled.
    expect(await c.isBotEnabled('ct1')).toBe(false);
    // Second check: served from cache, no extra contact lookup.
    expect(await c.isBotEnabled('ct1')).toBe(false);
    expect(calls).toBe(1);
  });

  it('defaults a fresh conversation (no handover tag) to enabled', async () => {
    const routes: FakeRoute[] = [
      { method: 'GET', match: /contacts\//, json: { contact: { id: 'ct2', tags: [] } } },
    ];
    const http = await authedHttp(routes);
    expect(await client(http).isBotEnabled('ct2')).toBe(true);
  });

  it('assumes bot enabled if the handover-tag lookup fails (no silent mute)', async () => {
    const routes: FakeRoute[] = [
      { method: 'GET', match: /contacts\//, status: 500, text: 'boom' },
    ];
    const http = await authedHttp(routes);
    expect(await client(http).isBotEnabled('ct3')).toBe(true);
  });

  it('preserves the slot timezone offset from the calendar endpoint', async () => {
    const routes: FakeRoute[] = [
      { method: 'GET', match: /free-slots/, json: { '2026-08-09': { slots: ['2026-08-09T09:00:00-04:00'] } } },
    ];
    const http = await authedHttp(routes);
    const slots = await client(http).getFreeSlots(
      'cal1',
      '2026-08-09T00:00:00.000Z',
      '2026-08-10T00:00:00.000Z',
    );
    expect(slots).toHaveLength(1);
    // Wall-clock + offset preserved (not flattened to Z).
    expect(slots[0]!.startTime).toBe('2026-08-09T09:00:00-04:00');
    expect(slots[0]!.endTime).toBe('2026-08-09T09:30:00-04:00');
  });
});
