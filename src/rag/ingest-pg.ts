/**
 * Embed the KB directly into Postgres/pgvector — no kb.json intermediate.
 *
 *   pnpm ingest:pg
 *
 * Reads kb/*.md → OKF-aware chunks → embeddings → kb_chunks (via Drizzle).
 * Idempotent per embed model: replaces all rows for the current model in one
 * pass, so removed/renamed chunks don't linger. Requires DATABASE_URL +
 * PGVECTOR=true and an applied schema (`pnpm db:migrate`). Local dev uses this
 * instead of the file index, so there's no json file to keep in sync.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { closePool, getDb } from '../config/db.js';
import { env } from '../config/env.js';
import { kbChunks } from '../config/schema.js';
import { chunkMarkdown } from './chunk.js';
import { createEmbedder } from './embedder.js';
import type { Chunk } from './types.js';

const KB_DIR = join(process.cwd(), 'kb');

async function main(): Promise<void> {
  if (!env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — cannot load the KB into Postgres.');
    process.exit(1);
  }
  if (!env.PGVECTOR) {
    console.log('PGVECTOR not set — the KB uses the file index; nothing to load into Postgres.');
    return;
  }

  const embedder = createEmbedder();
  const files = (await readdir(KB_DIR)).filter((f) => f.endsWith('.md')).sort();
  if (files.length === 0) {
    console.error(`No .md files found in ${KB_DIR}`);
    process.exit(1);
  }

  // Chunk every doc (OKF frontmatter parsed + provenance stamped), then embed.
  const chunks: Chunk[] = [];
  for (const file of files) {
    const content = await readFile(join(KB_DIR, file), 'utf8');
    chunks.push(...chunkMarkdown(file.replace(/\.md$/, ''), content));
  }
  const embeddings = await embedder.embedMany(chunks.map((c) => c.text));
  const dims = embeddings[0]?.length ?? 0;
  if (dims !== 384) {
    throw new Error(
      `Embeddings are ${dims}-dim but kb_chunks.embedding is vector(384). ` +
        `Update db/schema-pgvector.sql + src/config/schema.ts for ${embedder.model}.`,
    );
  }

  const db = getDb();
  await db.delete(kbChunks).where(eq(kbChunks.embedModel, embedder.model));
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const p = c.provenance;
    const row = {
      id: c.id,
      docId: c.docId,
      title: c.title,
      section: c.section ?? null,
      text: c.text,
      embedding: embeddings[i]!,
      embedModel: embedder.model,
      status: p?.status ?? null,
      verifiedBy: p?.verifiedBy ?? null,
      verifiedAt: p?.verifiedAt ?? null,
      staleAfter: p?.staleAfter ?? null,
      sourceId: p?.sourceId ?? null,
    };
    await db.insert(kbChunks).values(row).onConflictDoUpdate({ target: kbChunks.id, set: row });
  }

  const withProvenance = chunks.filter((c) => c.provenance).length;
  console.log(
    `Loaded ${chunks.length} chunks (${dims}d [${embedder.model}], ${withProvenance} with OKF ` +
      `provenance) into kb_chunks — direct embed, no kb.json.`,
  );
  await closePool();
}

void main().catch(async (err) => {
  console.error('ingest:pg failed:', err instanceof Error ? err.message : err);
  await closePool();
  process.exit(1);
});
