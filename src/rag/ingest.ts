/**
 * Ingest the KB into a local vector index.
 *
 *   pnpm ingest
 *
 * Reads kb/*.md → heading-aware chunks → embeddings → data/index/kb.json.
 * Incremental: a per-doc content hash lets unchanged docs reuse their existing
 * embeddings, so re-ingest after editing one doc only re-embeds that doc.
 * Requires an embedding API key (EMBED_PROVIDER) in .env.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chunkMarkdown } from './chunk.js';
import { createEmbedder } from './embedder.js';
import { INDEX_PATH } from './retriever.js';
import type { EmbeddedChunk, KbIndex } from './types.js';

const KB_DIR = join(process.cwd(), 'kb');

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

async function loadExisting(): Promise<KbIndex | undefined> {
  try {
    return JSON.parse(await readFile(INDEX_PATH, 'utf8')) as KbIndex;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const files = (await readdir(KB_DIR)).filter((f) => f.endsWith('.md')).sort();
  if (files.length === 0) {
    console.error(`No .md files found in ${KB_DIR}`);
    process.exit(1);
  }

  const embedder = createEmbedder();
  const existing = await loadExisting();
  const existingByDoc = new Map<string, EmbeddedChunk[]>();
  for (const c of existing?.chunks ?? []) {
    const list = existingByDoc.get(c.docId) ?? [];
    list.push(c);
    existingByDoc.set(c.docId, list);
  }

  const finalChunks: EmbeddedChunk[] = [];
  const docs: KbIndex['docs'] = {};
  const toEmbed: { docId: string; text: string; template: EmbeddedChunk }[] = [];
  let reusedDocs = 0;

  for (const file of files) {
    const docId = file.replace(/\.md$/, '');
    const content = await readFile(join(KB_DIR, file), 'utf8');
    const hash = sha256(content);
    docs[docId] = { hash };

    const unchanged = existing?.docs[docId]?.hash === hash && existingByDoc.has(docId);
    if (unchanged) {
      finalChunks.push(...existingByDoc.get(docId)!);
      reusedDocs++;
      continue;
    }

    for (const chunk of chunkMarkdown(docId, content)) {
      toEmbed.push({ docId, text: chunk.text, template: { ...chunk, embedding: [] } });
    }
  }

  if (toEmbed.length > 0) {
    const embeddings = await embedder.embedMany(toEmbed.map((t) => t.text));
    toEmbed.forEach((t, i) => finalChunks.push({ ...t.template, embedding: embeddings[i]! }));
  }

  const dims = finalChunks[0]?.embedding.length ?? 0;
  const index: KbIndex = { embedModel: embedder.model, dims, docs, chunks: finalChunks };

  await mkdir(dirname(INDEX_PATH), { recursive: true });
  await writeFile(INDEX_PATH, JSON.stringify(index));

  console.log(
    `Ingested ${files.length} docs (${reusedDocs} reused, ${toEmbed.length} chunks embedded) → ` +
      `${finalChunks.length} chunks, ${dims}d [${embedder.model}]\n${INDEX_PATH}`,
  );
}

void main().catch((err) => {
  console.error('Ingest failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
