import { Pool } from 'pg';
import { env } from './env.js';
import { logger } from '../util/logger.js';

/**
 * Lazily-created shared Postgres pool. Only constructed when DATABASE_URL is set
 * (see `isDbEnabled`), so the DB-less local/demo path never loads a driver or
 * opens a connection. Fly's internal Postgres is reached over the private
 * network without TLS; external URLs carrying `sslmode=require` opt into TLS.
 */
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!env.DATABASE_URL) {
    throw new Error('getPool() called without DATABASE_URL — DB backend is disabled');
  }
  if (!pool) {
    const requireSsl = /sslmode=require/.test(env.DATABASE_URL);
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 5,
      ssl: requireSsl ? { rejectUnauthorized: false } : undefined,
    });
    pool.on('error', (err) => logger.error({ err }, 'idle pg client error'));
    logger.info('Postgres pool created');
  }
  return pool;
}

/** Close the pool on shutdown (no-op if never created). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
