import type { EmbeddedChunk, RetrievedChunk } from './types.js';

/** Cosine similarity of two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Flat in-memory vector store. For a 10–20 doc KB, a linear cosine scan over
 * embeddings loaded into memory is sub-millisecond and needs zero infra. The
 * same interface can be backed by pgvector later without touching callers.
 */
export class VectorStore {
  constructor(private readonly chunks: EmbeddedChunk[] = []) {}

  get size(): number {
    return this.chunks.length;
  }

  /** Top-k chunks by cosine similarity to the query embedding, highest first. */
  search(queryEmbedding: number[], k: number): RetrievedChunk[] {
    return this.chunks
      .map((c) => ({
        id: c.id,
        docId: c.docId,
        title: c.title,
        section: c.section,
        text: c.text,
        score: cosineSimilarity(queryEmbedding, c.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}
