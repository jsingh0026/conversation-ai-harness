import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SlotTakenError } from '../errors.js';
import { fakeFetch, type FakeRoute } from '../../testkit/fake-fetch.js';
import { HighLevelClient } from './client.js';
import { HlHttp } from './http.js';
import { TokenManager } from './token-manager.js';

async function authedHttp(routes: FakeRoute[]): Promise<HlHttp> {
  const dir = await mkdtemp(join(tmpdir(), 'hlc-'));
  const tokenPath = join(dir, 'token.json');
  await writeFile(
    tokenPath,
    JSON.stringify({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }),
  );
  const tm = new TokenManager(
    { clientId: 'c', clientSecret: 's', redirectUri: 'x', tokenPath },
    fakeFetch(routes),
  );
  await tm.load();
  return new HlHttp(tm, fakeFetch(routes));
}

function client(routes: FakeRoute[], http: HlHttp): HighLevelClient {
  return new HighLevelClient(http, { locationId: 'loc1', fieldMap: { budget: 'fld_budget' } });
}

describe('HighLevelClient', () => {
  it('sends a message and returns the message id', async () => {
    const routes: FakeRoute[] = [
      { method: 'POST', match: /conversations\/messages/, json: { messageId: 'm1' } },
    ];
    const http = await authedHttp(routes);
    const res = await client(routes, http).sendMessage({
      conversationId: 'c1',
      contactId: 'ct1',
      channel: 'SMS',
      body: 'hi',
    });
    expect(res.messageId).toBe('m1');
  });

  it('routes standard vs custom fields on update', async () => {
    let captured: unknown;
    const routes: FakeRoute[] = [
      {
        method: 'PUT',
        match: /contacts\/ct1/,
        json: { contact: { id: 'ct1', firstName: 'Ada', customFields: [{ id: 'fld_budget', value: 500000 }] } },
      },
    ];
    // Capture the request body via a custom fetch.
    const capturingFetch: typeof fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      captured = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(JSON.stringify(routes[0]!.json), { status: 200 });
    }) as typeof fetch;
    const dir = await mkdtemp(join(tmpdir(), 'hlc-'));
    const tokenPath = join(dir, 'token.json');
    await writeFile(tokenPath, JSON.stringify({ accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }));
    const tm = new TokenManager({ clientId: 'c', clientSecret: 's', redirectUri: 'x', tokenPath }, capturingFetch);
    await tm.load();
    const c = new HighLevelClient(new HlHttp(tm, capturingFetch), { locationId: 'loc1', fieldMap: { budget: 'fld_budget' } });

    await c.updateContactFields('ct1', { name: 'Ada Lovelace', budget: 500000 });
    expect(captured).toMatchObject({
      firstName: 'Ada',
      lastName: 'Lovelace',
      customFields: [{ id: 'fld_budget', value: 500000 }],
    });
  });

  it('books an appointment', async () => {
    const routes: FakeRoute[] = [
      { method: 'POST', match: /events\/appointments/, json: { id: 'appt1' } },
    ];
    const http = await authedHttp(routes);
    const appt = await client(routes, http).createAppointment({
      calendarId: 'cal1',
      contactId: 'ct1',
      startTime: '2026-08-09T15:00:00.000Z',
      endTime: '2026-08-09T15:30:00.000Z',
    });
    expect(appt).toMatchObject({ id: 'appt1', status: 'booked' });
  });

  it('maps a slot conflict to SlotTakenError', async () => {
    const routes: FakeRoute[] = [
      { method: 'POST', match: /events\/appointments/, status: 422, text: 'The selected slot is not available' },
    ];
    const http = await authedHttp(routes);
    await expect(
      client(routes, http).createAppointment({
        calendarId: 'cal1',
        contactId: 'ct1',
        startTime: '2026-08-09T15:00:00.000Z',
        endTime: '2026-08-09T15:30:00.000Z',
      }),
    ).rejects.toBeInstanceOf(SlotTakenError);
  });

  it('parses free slots from the calendar endpoint', async () => {
    const routes: FakeRoute[] = [
      {
        method: 'GET',
        match: /free-slots/,
        json: { '2026-08-09': { slots: ['2026-08-09T15:00:00.000Z'] } },
      },
    ];
    const http = await authedHttp(routes);
    const slots = await client(routes, http).getFreeSlots(
      'cal1',
      '2026-08-09T00:00:00.000Z',
      '2026-08-10T00:00:00.000Z',
    );
    expect(slots).toHaveLength(1);
    expect(slots[0]!.startTime).toBe('2026-08-09T15:00:00.000Z');
  });
});
