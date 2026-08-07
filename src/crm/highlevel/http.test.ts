import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HlApiError, HlHttp } from './http.js';
import { TokenManager } from './token-manager.js';

async function seededTokenManager(fetchImpl: typeof fetch): Promise<TokenManager> {
  const dir = await mkdtemp(join(tmpdir(), 'hlhttp-'));
  const tokenPath = join(dir, 'token.json');
  await writeFile(
    tokenPath,
    JSON.stringify({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }),
  );
  const tm = new TokenManager({ clientId: 'c', clientSecret: 's', redirectUri: 'x', tokenPath }, fetchImpl);
  await tm.load();
  return tm;
}

describe('HlHttp', () => {
  it('refreshes the token and retries once on a 401', async () => {
    let apiCalls = 0;
    const fetchImpl: typeof fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'tok2', refresh_token: 'r2', expires_in: 3600 }), {
          status: 200,
        });
      }
      apiCalls++;
      // First call 401 (stale token), second succeeds.
      return apiCalls === 1
        ? new Response('unauthorized', { status: 401 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const http = new HlHttp(await seededTokenManager(fetchImpl), fetchImpl);
    const res = await http.get<{ ok: boolean }>('/contacts/ct1');
    expect(res.ok).toBe(true);
    expect(apiCalls).toBe(2); // 401 then retry
  });

  it('throws a typed HlApiError on a non-2xx', async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response('bad request body', { status: 400 })) as typeof fetch;
    const http = new HlHttp(await seededTokenManager(fetchImpl), fetchImpl);
    await expect(http.get('/contacts/x')).rejects.toMatchObject({
      name: 'HlApiError',
      status: 400,
    });
    await expect(http.get('/contacts/x')).rejects.toBeInstanceOf(HlApiError);
  });

  it('appends query params', async () => {
    let seenUrl = '';
    const fetchImpl: typeof fetch = (async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = String(input);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const http = new HlHttp(await seededTokenManager(fetchImpl), fetchImpl);
    await http.get('/calendars/cal1/free-slots', { query: { startDate: 123, endDate: 456 } });
    expect(seenUrl).toContain('startDate=123');
    expect(seenUrl).toContain('endDate=456');
  });
});
