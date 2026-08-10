import { cosineDistance, eq, sql } from 'drizzle-orm';
import type { Db } from '../config/db.js';
import { kbChunks } from '../config/schema.js';
import type { RetrievedChunk } from './types.js';
import type { VectorIndex } from './vector-index.js';

/**
 * pgvector-backed KB via Drizzle. Cosine distance (`<=>`) with an HNSW index
 * gives ANN search that stays fast as the KB grows; `score = 1 - distance`
 * recovers the cosine similarity the threshold logic expects. Rows are filtered
 * by embed_model so a re-ingest under a new model never mixes embedding spaces.
 * OKF provenance columns ride along on each row.
 */
export class PgVectorIndex implements VectorIndex {
  constructor(
    private readonly db: Db,
    private readonly embedModel: string,
  ) {}

  async size(): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(kbChunks)
      .where(eq(kbChunks.embedModel, this.embedModel));
    return row?.n ?? 0;
  }

  async search(queryEmbedding: number[], k: number): Promise<RetrievedChunk[]> {
    const distance = cosineDistance(kbChunks.embedding, queryEmbedding);
    const rows = await this.db
      .select({
        id: kbChunks.id,
        docId: kbChunks.docId,
        title: kbChunks.title,
        section: kbChunks.section,
        text: kbChunks.text,
        status: kbChunks.status,
        verifiedBy: kbChunks.verifiedBy,
        verifiedAt: kbChunks.verifiedAt,
        staleAfter: kbChunks.staleAfter,
        sourceId: kbChunks.sourceId,
        score: sql<number>`1 - (${distance})`,
      })
      .from(kbChunks)
      .where(eq(kbChunks.embedModel, this.embedModel))
      .orderBy(distance) // ascending distance = most similar first
      .limit(k);

    return rows.map((r) => ({
      id: r.id,
      docId: r.docId,
      title: r.title,
      section: r.section ?? undefined,
      text: r.text,
      score: Number(r.score),
      provenance: r.status
        ? {
            status: r.status as 'draft' | 'stable' | 'deprecated',
            verifiedBy: r.verifiedBy ?? undefined,
            verifiedAt: r.verifiedAt ?? undefined,
            staleAfter: r.staleAfter ?? undefined,
            sourceId: r.sourceId ?? undefined,
          }
        : undefined,
    }));
  }
}
