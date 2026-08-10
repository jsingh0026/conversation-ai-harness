import { index, pgTable, text, timestamp, vector } from 'drizzle-orm/pg-core';

/**
 * Drizzle schema — the typed source of truth for our two Postgres tables. The
 * runtime queries (idempotency, KB vector search, ingest) are written against
 * these definitions. DDL that Drizzle can't express (the `vector` extension) is
 * applied by the SQL files in `db/` via `pnpm db:migrate`; keep the two in sync.
 */

/** Webhook idempotency with a processing lease (see PgIdempotencyStore). */
export const processedMessages = pgTable('processed_messages', {
  messageId: text('message_id').primaryKey(),
  conversationId: text('conversation_id'),
  status: text('status').notNull().default('processing'), // 'processing' | 'done'
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
});

/** KB vector store (pgvector). Embedding dim matches the embed model (bge-small = 384). */
export const kbChunks = pgTable(
  'kb_chunks',
  {
    id: text('id').primaryKey(), // `${docId}#${index}`
    docId: text('doc_id').notNull(),
    title: text('title').notNull(),
    section: text('section'),
    text: text('text').notNull(),
    embedding: vector('embedding', { dimensions: 384 }).notNull(),
    embedModel: text('embed_model').notNull(),
    // OKF provenance (nullable; plain-markdown docs have none)
    status: text('status'),
    verifiedBy: text('verified_by'),
    verifiedAt: text('verified_at'),
    staleAfter: text('stale_after'),
    sourceId: text('source_id'),
  },
  (t) => ({
    embeddingHnsw: index('kb_chunks_embedding_hnsw').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
    embedModel: index('kb_chunks_embed_model').on(t.embedModel),
  }),
);
