import type { AccessTokenSource } from './token-manager.js';

const BASE_URL = 'https://services.leadconnectorhq.com';
/** Default API version header; some endpoints (calendars) override it per-call. */
const DEFAULT_VERSION = '2021-07-28';

type FetchLike = typeof fetch;

export class HlApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'HlApiError';
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  version?: string;
}

/**
 * Thin HighLevel HTTP client: injects the bearer token + Version header, maps
 * non-2xx to a typed HlApiError, and retries once on a 401 after forcing a token
 * refresh. `fetch` is injectable for tests.
 */
export class HlHttp {
  constructor(
    private readonly tokens: AccessTokenSource,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = BASE_URL,
  ) {}

  get = <T>(path: string, opts?: RequestOptions): Promise<T> => this.request<T>('GET', path, opts);
  post = <T>(path: string, opts?: RequestOptions): Promise<T> => this.request<T>('POST', path, opts);
  put = <T>(path: string, opts?: RequestOptions): Promise<T> => this.request<T>('PUT', path, opts);
  delete = <T>(path: string, opts?: RequestOptions): Promise<T> =>
    this.request<T>('DELETE', path, opts);

  private async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const doFetch = async (token: string): Promise<Response> => {
      const url = new URL(this.baseUrl + path);
      for (const [k, v] of Object.entries(opts.query ?? {})) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
      return this.fetchImpl(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Version: opts.version ?? DEFAULT_VERSION,
          Accept: 'application/json',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    };

    let res = await doFetch(await this.tokens.getAccessToken());
    if (res.status === 401) {
      // Refresh once and retry (OAuth). A static token source rejects on
      // refresh(), so we skip the retry and surface the 401 below.
      try {
        await this.tokens.refresh();
        res = await doFetch(await this.tokens.getAccessToken());
      } catch {
        /* cannot refresh (e.g. private integration token) — fall through */
      }
    }

    const text = await res.text();
    if (!res.ok) {
      throw new HlApiError(`HighLevel ${method} ${path} failed (${res.status})`, res.status, text);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}
