import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from '../../util/logger.js';

export const TOKEN_PATH = join(process.cwd(), 'data', 'hl-token.json');
const TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/token';
/** Refresh this many ms before actual expiry to avoid racing the boundary. */
const REFRESH_SKEW_MS = 60_000;

/** Anything that can supply a bearer token to the HTTP client (OAuth or a PIT). */
export interface AccessTokenSource {
  getAccessToken(): Promise<string>;
  /** Refresh the token; static sources reject to signal "no retry possible". */
  refresh(): Promise<unknown>;
}

/**
 * A fixed Private Integration Token. No OAuth flow, no expiry/refresh — the
 * simplest way to authenticate a sandbox/demo. `refresh()` rejects so the HTTP
 * client knows a 401 can't be recovered by refreshing.
 */
export class StaticTokenProvider implements AccessTokenSource {
  constructor(private readonly token: string) {}
  async getAccessToken(): Promise<string> {
    return this.token;
  }
  async refresh(): Promise<never> {
    throw new Error('Private integration token cannot be refreshed');
  }
}

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  locationId?: string;
}

/** Where the OAuth token is persisted. File on local dev; Postgres on Fly (so it
 *  survives deploys — the machine filesystem is ephemeral). */
export interface TokenStore {
  load(): Promise<StoredToken | undefined>;
  save(token: StoredToken): Promise<void>;
}

/** Default store: a 0600 JSON file. Fine for local dev; ephemeral on Fly. */
export class FileTokenStore implements TokenStore {
  constructor(private readonly path: string = TOKEN_PATH) {}
  async load(): Promise<StoredToken | undefined> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as StoredToken;
    } catch {
      return undefined;
    }
  }
  async save(token: StoredToken): Promise<void> {
    try {
      // Restrictive perms — the refresh token is a long-lived secret.
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(this.path, JSON.stringify(token, null, 2), { mode: 0o600 });
    } catch (err) {
      logger.warn({ err }, 'failed to persist HighLevel token');
    }
  }
}

export interface TokenManagerConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenPath?: string;
  /** Override the persistence backend (defaults to a FileTokenStore). */
  store?: TokenStore;
}

type FetchLike = typeof fetch;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  locationId?: string;
}

/**
 * Manages the HighLevel OAuth token lifecycle: exchange the auth code, persist
 * the token, and transparently refresh it before expiry. `fetch` and `now` are
 * injectable so the refresh logic is unit-testable without the network.
 */
export class TokenManager implements AccessTokenSource {
  private token: StoredToken | undefined;
  private readonly store: TokenStore;
  private refreshing: Promise<StoredToken> | undefined;

  constructor(
    private readonly config: TokenManagerConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.store = config.store ?? new FileTokenStore(config.tokenPath);
  }

  /** Load a persisted token from the store, if present. */
  async load(): Promise<StoredToken | undefined> {
    this.token = await this.store.load();
    return this.token;
  }

  isAuthorized(): boolean {
    return this.token !== undefined;
  }

  /** Exchange an authorization code (from the OAuth callback) for tokens. */
  async exchangeCode(code: string): Promise<StoredToken> {
    return this.postToken({ grant_type: 'authorization_code', code });
  }

  /** A valid access token, refreshing first if it's expired/near-expiry. */
  async getAccessToken(): Promise<string> {
    if (!this.token) await this.load(); // lazy-load a persisted token on first use
    if (!this.token) {
      throw new Error('Not authorized with HighLevel. Visit /oauth/authorize to connect.');
    }
    if (this.now() >= this.token.expiresAt - REFRESH_SKEW_MS) {
      await this.refresh();
    }
    return this.token.accessToken;
  }

  /** Refresh using the stored refresh token (de-duped across concurrent callers). */
  async refresh(): Promise<StoredToken> {
    if (!this.token) throw new Error('No token to refresh.');
    if (this.refreshing) return this.refreshing;
    const refreshToken = this.token.refreshToken;
    this.refreshing = this.postToken({ grant_type: 'refresh_token', refresh_token: refreshToken })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  private async postToken(extra: Record<string, string>): Promise<StoredToken> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri,
      ...extra,
    });
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    if (!res.ok) {
      throw new Error(`HighLevel token request failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as TokenResponse;
    const token: StoredToken = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: this.now() + json.expires_in * 1000,
      locationId: json.locationId,
    };
    await this.store.save(token);
    this.token = token;
    return token;
  }
}
