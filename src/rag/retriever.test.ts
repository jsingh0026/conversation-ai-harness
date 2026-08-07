import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeEmbedder } from '../testkit/fake-embedder.js';
import { Retriever } from './retriever.js';
import { VectorStore } from './store.js';
import type { EmbeddedChunk, KbIndex } from './types.js';

async function seededRetriever(threshold = 0.3) {
  const embedder = new FakeEmbedder();
  const texts = [
    { id: 'fees#0', text: 'Our seller commission is five percent of the sale price.' },
    { id: 'rent#0', text: 'We manage rental properties for an eight percent monthly fee.' },
    { id: 'hours#0', text: 'Our office is open Monday to Friday nine to six.' },
  ];
  const embeddings = await embedder.embedMany(texts.map((t) => t.text));
  const chunks: EmbeddedChunk[] = texts.map((t, i) => ({
    id: t.id,
    docId: t.id,
    title: t.id,
    text: t.text,
    embedding: embeddings[i]!,
  }));
  const retriever = new Retriever(embedder);
  retriever.useStore(new VectorStore(chunks));
  return { retriever, threshold };
}

describe('Retriever', () => {
  it('grounds an answer when a chunk clears the threshold', async () => {
    const { retriever, threshold } = await seededRetriever();
    const result = await retriever.retrieve('what is your seller commission price', { threshold });
    expect(result.grounded).toBe(true);
    expect(result.chunks[0]?.text).toContain('commission');
    expect(result.chunks.every((c) => c.score >= threshold)).toBe(true);
  });

  it('returns an explicit no-answer when nothing clears the threshold', async () => {
    const { retriever, threshold } = await seededRetriever();
    const result = await retriever.retrieve('completely unrelated zebra astrophysics', { threshold });
    expect(result.grounded).toBe(false);
    expect(result.chunks).toHaveLength(0);
  });

  it('is not grounded when the index is empty', async () => {
    const retriever = new Retriever(new FakeEmbedder());
    retriever.useStore(new VectorStore([]));
    const result = await retriever.retrieve('anything');
    expect(result.grounded).toBe(false);
  });

  it('disables retrieval when the on-disk index was built with a different embed model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kbidx-'));
    const path = join(dir, 'kb.json');
    const index: KbIndex = {
      embedModel: 'some-other-model', // ≠ FakeEmbedder's model
      dims: 3,
      docs: {},
      chunks: [{ id: 'a#0', docId: 'a', title: 'a', text: 'commission fees', embedding: [1, 0, 0] }],
    };
    await writeFile(path, JSON.stringify(index));

    const retriever = new Retriever(new FakeEmbedder(), path);
    const result = await retriever.retrieve('commission fees');
    // Model mismatch → store treated as unusable → no grounding (not garbage scores).
    expect(result.grounded).toBe(false);
  });
});
