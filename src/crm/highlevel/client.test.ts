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
