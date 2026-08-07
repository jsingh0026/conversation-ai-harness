import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../util/logger.js';
import type { Embedder } from './embedder.js';
import { VectorStore } from './store.js';
import type { KbIndex, RetrievalResult } from './types.js';

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
  private store: VectorStore | undefined;
  private loaded = false;

  constructor(
    private readonly embedder: Embedder,
    private readonly indexPath = INDEX_PATH,
  ) {}

  /** Load the on-disk index once (lazily). Missing index → empty store. */
  private async ensureLoaded(): Promise<VectorStore> {
    if (this.loaded && this.store) return this.store;
    try {
      const raw = await readFile(this.indexPath, 'utf8');
      const index = JSON.parse(raw) as KbIndex;
      this.store = new VectorStore(index.chunks);
      logger.info({ chunks: index.chunks.length, model: index.embedModel }, 'KB index loaded');
    } catch {
      this.store = new VectorStore([]);
      logger.warn({ indexPath: this.indexPath }, 'no KB index found — run `pnpm ingest`');
    }
    this.loaded = true;
    return this.store;
  }

  /** For tests: back the retriever with an in-memory store directly. */
  useStore(store: VectorStore): void {
    this.store = store;
    this.loaded = true;
  }

  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrievalResult> {
    const k = opts.k ?? 5;
    const threshold = opts.threshold ?? env.RAG_SCORE_THRESHOLD;
    const store = await this.ensureLoaded();

    if (store.size === 0) return { query, grounded: false, chunks: [] };

    const [queryEmbedding] = await Promise.all([this.embedder.embed(query)]);
    const top = store.search(queryEmbedding, k);
    const grounded = top.filter((c) => c.score >= threshold);

    return { query, grounded: grounded.length > 0, chunks: grounded };
  }
}
