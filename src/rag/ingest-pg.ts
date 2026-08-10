/**
 * Load the on-disk KB index into Postgres/pgvector.
 *
 *   pnpm ingest        # build data/index/kb.json (local embeddings)
 *   pnpm ingest:pg     # load kb.json → kb_chunks
 *
 * Reuses the embeddings already computed by `pnpm ingest` (no re-embedding).
 * Idempotent per embed model: it replaces all rows for the index's model in one
 * transaction, so removed/renamed chunks don't linger. Requires DATABASE_URL and
 * an applied schema (`pnpm db:migrate`).
 */
import { readFile } from 'node:fs/promises';
import { env } from '../config/env.js';
import { closePool, getPool } from '../config/db.js';
import { INDEX_PATH } from './retriever.js';
import type { KbIndex } from './types.js';

async function main(): Promise<void> {
  if (!env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — cannot load the KB into Postgres.');
    process.exit(1);
  }
  if (!env.PGVECTOR) {
    console.log('PGVECTOR not set — the KB uses the file index; nothing to load into Postgres.');
    return;
  }

  let index: KbIndex;
  try {
    index = JSON.parse(await readFile(INDEX_PATH, 'utf8')) as KbIndex;
  } catch {
    console.error(`No index at ${INDEX_PATH}. Run \`pnpm ingest\` first.`);
    process.exit(1);
  }

  if (index.dims !== 384) {
    throw new Error(
      `Index is ${index.dims}-dim but kb_chunks.embedding is vector(384). ` +
        `Update db/schema.sql to match the embed model (${index.embedModel}).`,
    );
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Replace this model's rows wholesale so deletions/renames are reflected.
    await client.query('DELETE FROM kb_chunks WHERE embed_model = $1', [index.embedModel]);
    for (const c of index.chunks) {
      await client.query(
        `INSERT INTO kb_chunks (id, doc_id, title, section, text, embedding, embed_model)
              VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
         ON CONFLICT (id) DO UPDATE
              SET doc_id = EXCLUDED.doc_id, title = EXCLUDED.title, section = EXCLUDED.section,
                  text = EXCLUDED.text, embedding = EXCLUDED.embedding, embed_model = EXCLUDED.embed_model`,
        [c.id, c.docId, c.title, c.section ?? null, c.text, `[${c.embedding.join(',')}]`, index.embedModel],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log(
    `Loaded ${index.chunks.length} chunks (${index.dims}d [${index.embedModel}]) into kb_chunks.`,
  );
  await closePool();
}

void main().catch(async (err) => {
  console.error('ingest:pg failed:', err instanceof Error ? err.message : err);
  await closePool();
  process.exit(1);
});
