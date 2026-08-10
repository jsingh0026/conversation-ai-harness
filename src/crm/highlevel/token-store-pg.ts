import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../config/db.js';
import { env } from '../../config/env.js';
import { hlOauthToken } from '../../config/schema.js';
import { decryptSecret, encryptSecret } from '../../util/crypto.js';
import { logger } from '../../util/logger.js';
import type { StoredToken, TokenStore } from './token-manager.js';

const ROW_ID = 'default';

/**
 * Postgres-backed OAuth token store (single row). Used on Fly so the token
 * survives deploys — the machine filesystem is ephemeral, so a file-based token
 * is wiped on every `fly deploy`. The access/refresh tokens are encrypted at
 * rest (AES-256-GCM) when TOKEN_ENCRYPTION_KEY is set, so a DB leak alone yields
 * only ciphertext; the key lives in a deploy secret, never in the DB.
 */
export class PgTokenStore implements TokenStore {
  private readonly key = env.TOKEN_ENCRYPTION_KEY;

  constructor(private readonly db: Db) {
    if (!this.key) {
      logger.warn('TOKEN_ENCRYPTION_KEY unset — OAuth token stored unencrypted in Postgres');
    }
  }

  private enc(v: string): string {
    return this.key ? encryptSecret(v, this.key) : v;
  }
  private dec(v: string): string {
    return this.key ? decryptSecret(v, this.key) : v;
  }

  async load(): Promise<StoredToken | undefined> {
    const rows = await this.db
      .select()
      .from(hlOauthToken)
      .where(eq(hlOauthToken.id, ROW_ID))
      .limit(1);
    const r = rows[0];
    if (!r) return undefined;
    return {
      accessToken: this.dec(r.accessToken),
      refreshToken: this.dec(r.refreshToken),
      expiresAt: Number(r.expiresAt),
      locationId: r.locationId ?? undefined,
    };
  }

  async save(token: StoredToken): Promise<void> {
    const row = {
      id: ROW_ID,
      accessToken: this.enc(token.accessToken),
      refreshToken: this.enc(token.refreshToken),
      expiresAt: token.expiresAt,
      locationId: token.locationId ?? null,
    };
    await this.db
      .insert(hlOauthToken)
      .values(row)
      .onConflictDoUpdate({
        target: hlOauthToken.id,
        set: {
          accessToken: row.accessToken,
          refreshToken: row.refreshToken,
          expiresAt: row.expiresAt,
          locationId: row.locationId,
          updatedAt: sql`now()`,
        },
      });
  }
}
