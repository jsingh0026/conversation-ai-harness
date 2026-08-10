-- Conversation AI Harness — pgvector KB schema (opt-in).
-- Applied by `pnpm db:migrate` ONLY when PGVECTOR=true, because it needs the
-- `vector` extension. Fly's unmanaged Postgres image does not ship pgvector; use
-- a pgvector-capable Postgres (or Fly Managed Postgres) to enable this. Without
-- it, the KB uses the baked on-disk index (db/schema.sql still applies).

CREATE EXTENSION IF NOT EXISTS vector;

-- KB vector store. Dimension is fixed to the embed model in use
-- (Xenova/bge-small-en-v1.5 → 384). Changing models means a new migration.
CREATE TABLE IF NOT EXISTS kb_chunks (
  id          TEXT PRIMARY KEY,          -- `${docId}#${index}`
  doc_id      TEXT        NOT NULL,
  title       TEXT        NOT NULL,
  section     TEXT,
  text        TEXT        NOT NULL,
  embedding   vector(384) NOT NULL,
  embed_model TEXT        NOT NULL       -- guards against mixing embedding spaces
);

-- Approximate nearest-neighbour index for cosine distance (`<=>`).
CREATE INDEX IF NOT EXISTS kb_chunks_embedding_hnsw
  ON kb_chunks USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS kb_chunks_embed_model ON kb_chunks (embed_model);
