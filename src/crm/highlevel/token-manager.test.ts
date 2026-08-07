import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fakeFetch } from '../../testkit/fake-fetch.js';
import { TokenManager } from './token-manager.js';

async function tokenPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'hltok-')), 'token.json');
}

const config = (tokenPathValue: string) => ({
  clientId: 'cid',
  clientSecret: 'secret',
  redirectUri: 'http://localhost:3000/oauth/callback',
  tokenPath: tokenPathValue,
});

const tokenRoute = (access: string, expiresIn = 3600) => ({
  method: 'POST',
  match: /oauth\/token/,
  json: { access_token: access, refresh_token: 'refresh-1', expires_in: expiresIn, locationId: 'loc1' },
});

describe('TokenManager', () => {
  it('exchanges a code and persists a usable token', async () => {
    const now = 1_000_000;
    const tm = new TokenManager(config(await tokenPath()), fakeFetch([tokenRoute('access-1')]), () => now);
    const tok = await tm.exchangeCode('the-code');
    expect(tok.accessToken).toBe('access-1');
    expect(tok.locationId).toBe('loc1');
    expect(await tm.getAccessToken()).toBe('access-1');
  });

  it('refreshes automatically when the token is near expiry', async () => {
    let now = 1_000_000;
    const fetchImpl = fakeFetch([
      { method: 'POST', match: /oauth\/token/, json: { access_token: 'access-refreshed', refresh_token: 'refresh-2', expires_in: 3600 } },
    ]);
    const tm = new TokenManager(config(await tokenPath()), fetchImpl, () => now);
    // seed a token that's about to expire
    await tm.exchangeCode('c'); // access-refreshed, expiresAt = now + 3600s
    now += 3600_000; // jump to expiry
    expect(await tm.getAccessToken()).toBe('access-refreshed');
  });

  it('throws a clear error before authorization', async () => {
    const tm = new TokenManager(config(await tokenPath()), fakeFetch([]));
    await expect(tm.getAccessToken()).rejects.toThrow(/Not authorized/);
  });

  it('de-dupes concurrent refreshes into one token call', async () => {
    let now = 1_000_000;
    const onCall = vi.fn();
    const fetchImpl = fakeFetch([{ ...tokenRoute('a'), onCall }]);
    const tm = new TokenManager(config(await tokenPath()), fetchImpl, () => now);
    await tm.exchangeCode('c'); // 1 call
    now += 3600_000;
    await Promise.all([tm.getAccessToken(), tm.getAccessToken(), tm.getAccessToken()]);
    // 1 exchange + 1 (shared) refresh = 2 total, not 4.
    expect(onCall).toHaveBeenCalledTimes(2);
  });
});
