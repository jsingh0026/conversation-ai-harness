import { readFile } from 'node:fs/promises';
import { logger } from '../util/logger.js';
import { VectorStore } from './store.js';
import type { KbIndex, RetrievedChunk } from './types.js';

/**
 * Backend-agnostic vector search seam. The `Retriever` depends only on this, so
 * the KB can live in the on-disk index (`FileVectorIndex`), directly in memory
 * (`MemoryVectorIndex`, for tests), or in Postgres/pgvector (`PgVectorIndex`)
 * without any caller changing. All methods are async so a network-backed store
 * fits the same shape as the in-memory one.
 */
export interface VectorIndex {
  /** Number of usable chunks; 0 means "no grounding available". */
  size(): Promise<number>;
  /** Top-k chunks by cosine similarity to the query embedding, highest first. */
  search(queryEmbedding: number[], k: number): Promise<RetrievedChunk[]>;
}

/** Wraps an in-memory VectorStore (used by tests and by FileVectorIndex). */
export class MemoryVectorIndex implements VectorIndex {
  constructor(private readonly store: VectorStore) {}
  async size(): Promise<number> {
    return this.store.size;
  }
  async search(queryEmbedding: number[], k: number): Promise<RetrievedChunk[]> {
    return this.store.search(queryEmbedding, k);
  }
}

/**
 * Loads the on-disk index (`pnpm ingest` output) once, lazily. A missing index
 * is NOT cached, so an ingest-after-boot is picked up without a restart. An
 * index built with a different embed model is rejected — scoring a query vector
 * against another embedding space yields silent garbage.
 */
export class FileVectorIndex implements VectorIndex {
  private store: VectorStore | undefined;
  private loaded = false;

  constructor(
    private readonly indexPath: string,
    private readonly embedModel: string,
  ) {}

  private async ensureLoaded(): Promise<VectorStore> {
    if (this.loaded && this.store) return this.store;

    let raw: string;
    try {
      raw = await readFile(this.indexPath, 'utf8');
    } catch {
      logger.warn({ indexPath: this.indexPath }, 'no KB index found — run `pnpm ingest`');
      return new VectorStore([]); // not cached: retry next call
    }

    const index = JSON.parse(raw) as KbIndex;
    if (index.embedModel !== this.embedModel) {
      logger.error(
        { indexModel: index.embedModel, queryModel: this.embedModel },
        'KB index embed model differs from the query embedder — re-run `pnpm ingest`; retrieval disabled',
      );
      this.store = new VectorStore([]);
    } else {
      this.store = new VectorStore(index.chunks);
      logger.info({ chunks: index.chunks.length, model: index.embedModel }, 'KB index loaded');
    }
    this.loaded = true;
    return this.store;
  }

  async size(): Promise<number> {
    return (await this.ensureLoaded()).size;
  }
  async search(queryEmbedding: number[], k: number): Promise<RetrievedChunk[]> {
    return (await this.ensureLoaded()).search(queryEmbedding, k);
  }
}
