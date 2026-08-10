import type { Pool } from 'pg';
import type { RetrievedChunk } from './types.js';
import type { VectorIndex } from './vector-index.js';

/** Serialize a JS number[] into a pgvector literal: `[0.1,0.2,...]`. */
function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

/**
 * pgvector-backed KB. Cosine distance (`<=>`) with an HNSW index gives ANN
 * search that stays fast as the KB grows; `score = 1 - distance` recovers the
 * cosine similarity the threshold logic expects. Rows are filtered by
 * embed_model so a re-ingest under a new model never mixes embedding spaces.
 */
export class PgVectorIndex implements VectorIndex {
  constructor(
    private readonly pool: Pool,
    private readonly embedModel: string,
  ) {}

  async size(): Promise<number> {
    const res = await this.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM kb_chunks WHERE embed_model = $1',
      [this.embedModel],
    );
    return res.rows[0]?.n ?? 0;
  }

  async search(queryEmbedding: number[], k: number): Promise<RetrievedChunk[]> {
    const vec = toVectorLiteral(queryEmbedding);
    const res = await this.pool.query<{
      id: string;
      doc_id: string;
      title: string;
      section: string | null;
      text: string;
      score: string;
      status: string | null;
      verified_by: string | null;
      verified_at: string | null;
      stale_after: string | null;
      source_id: string | null;
    }>(
      `SELECT id, doc_id, title, section, text,
              status, verified_by, verified_at, stale_after, source_id,
              1 - (embedding <=> $1::vector) AS score
         FROM kb_chunks
        WHERE embed_model = $2
        ORDER BY embedding <=> $1::vector
        LIMIT $3`,
      [vec, this.embedModel, k],
    );
    return res.rows.map((r) => ({
      id: r.id,
      docId: r.doc_id,
      title: r.title,
      section: r.section ?? undefined,
      text: r.text,
      score: Number(r.score),
      provenance: r.status
        ? {
            status: r.status as 'draft' | 'stable' | 'deprecated',
            verifiedBy: r.verified_by ?? undefined,
            verifiedAt: r.verified_at ?? undefined,
            staleAfter: r.stale_after ?? undefined,
            sourceId: r.source_id ?? undefined,
          }
        : undefined,
    }));
  }
}
