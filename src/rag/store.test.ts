import { describe, expect, it } from 'vitest';
import type { EmbeddedChunk } from './types.js';
import { VectorStore, cosineSimilarity } from './store.js';

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors and 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns 0 on mismatched or empty vectors', () => {
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('VectorStore', () => {
  const chunk = (id: string, embedding: number[]): EmbeddedChunk => ({
    id,
    docId: id,
    title: id,
    text: id,
    embedding,
  });

  it('returns the top-k most similar chunks, highest score first', () => {
    const store = new VectorStore([
      chunk('a', [1, 0, 0]),
      chunk('b', [0.9, 0.1, 0]),
      chunk('c', [0, 1, 0]),
    ]);
    const hits = store.search([1, 0, 0], 2);
    expect(hits.map((h) => h.id)).toEqual(['a', 'b']);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
  });
});
