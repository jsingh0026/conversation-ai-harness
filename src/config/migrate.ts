/**
 * Apply the Postgres schema.
 *
 *   pnpm db:migrate
 *
 * Reads db/schema.sql and runs it against DATABASE_URL. The DDL is idempotent
 * (CREATE ... IF NOT EXISTS), so this is safe to re-run on every deploy.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from './env.js';
import { closePool, getPool } from './db.js';

async function main(): Promise<void> {
  if (!env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — nothing to migrate.');
    process.exit(1);
  }
  const pool = getPool();
  const core = await readFile(join(process.cwd(), 'db', 'schema.sql'), 'utf8');
  await pool.query(core);
  console.log('Core schema applied (processed_messages).');

  if (env.PGVECTOR) {
    const vec = await readFile(join(process.cwd(), 'db', 'schema-pgvector.sql'), 'utf8');
    await pool.query(vec);
    console.log('pgvector schema applied (vector extension, kb_chunks).');
  } else {
    console.log('PGVECTOR not set — skipping the pgvector KB schema (KB uses the file index).');
  }
  await closePool();
}

void main().catch(async (err) => {
  console.error('Migration failed:', err instanceof Error ? err.message : err);
  await closePool();
  process.exit(1);
});
