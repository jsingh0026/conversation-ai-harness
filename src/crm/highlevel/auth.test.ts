import { describe, expect, it } from 'vitest';
import { fakeFetch } from '../../testkit/fake-fetch.js';
import { HlHttp } from './http.js';
import { StaticTokenProvider } from './token-manager.js';

describe('StaticTokenProvider (private integration token)', () => {
  it('supplies the fixed token as the bearer', async () => {
    let seenAuth = '';
    const fetchImpl: typeof fetch = (async (_i: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenAuth = String((init?.headers as Record<string, string>).Authorization);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const http = new HlHttp(new StaticTokenProvider('pit-abc'), fetchImpl);
    await http.get('/contacts/x');
    expect(seenAuth).toBe('Bearer pit-abc');
  });

  it('does not retry a 401 (a static token cannot be refreshed) and surfaces it', async () => {
    let calls = 0;
    const fetchImpl = fakeFetch([{ method: 'GET', match: /contacts/, status: 401, text: 'nope', onCall: () => calls++ }]);
    const http = new HlHttp(new StaticTokenProvider('pit-abc'), fetchImpl);
    await expect(http.get('/contacts/x')).rejects.toMatchObject({ name: 'HlApiError', status: 401 });
    expect(calls).toBe(1); // no refresh-retry
  });
});
