import { join } from 'node:path';
import { env } from '../config/env.js';
import type { Embedder } from './embedder.js';
import type { VectorStore } from './store.js';
import type { RetrievalResult } from './types.js';
import { FileVectorIndex, MemoryVectorIndex, type VectorIndex } from './vector-index.js';

export const INDEX_PATH = join(process.cwd(), 'data', 'index', 'kb.json');

export interface RetrieveOptions {
  k?: number;
  /** Minimum cosine score to count as grounded; defaults to env RAG_SCORE_THRESHOLD. */
  threshold?: number;
}

/**
 * Embeds a query and returns the grounded top-k chunks. Retrieval is only
 * invoked when the agent decides it needs knowledge (it's a tool). The
 * threshold produces an EXPLICIT no-answer signal (`grounded: false`) rather
 * than handing back weak snippets — so the agent declines instead of inventing.
 */
export class Retriever {
  private index: VectorIndex;

  /**
   * Backed by a `VectorIndex`. Passing a path (or nothing) uses the on-disk
   * index; passing a `VectorIndex` injects any backend (pgvector, memory). The
   * embed-model compatibility check lives inside `FileVectorIndex`.
   */
  constructor(
    private readonly embedder: Embedder,
    indexPathOrIndex: string | VectorIndex = INDEX_PATH,
  ) {
    this.index =
      typeof indexPathOrIndex === 'string'
        ? new FileVectorIndex(indexPathOrIndex, embedder.model)
        : indexPathOrIndex;
  }

  /** For tests: back the retriever with an in-memory store directly. */
  useStore(store: VectorStore): void {
    this.index = new MemoryVectorIndex(store);
  }

  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrievalResult> {
    const k = opts.k ?? 5;
    const threshold = opts.threshold ?? env.RAG_SCORE_THRESHOLD;

    if ((await this.index.size()) === 0) return { query, grounded: false, chunks: [] };

    const queryEmbedding = await this.embedder.embed(query);
    const top = await this.index.search(queryEmbedding, k);
    const grounded = top.filter((c) => c.score >= threshold);

    return { query, grounded: grounded.length > 0, chunks: grounded };
  }
}
