import { getDb } from '../config/db.js';
import { isPgVectorEnabled } from '../config/env.js';
import { logger } from '../util/logger.js';
import { createEmbedder } from './embedder.js';
import { PgVectorIndex } from './pg-vector-index.js';
import { Retriever } from './retriever.js';
import { createSearchKbTool } from './search-kb.tool.js';
import type { AgentTool } from '../orchestrator/agent-tool.js';

export type { Chunk, EmbeddedChunk, RetrievedChunk, RetrievalResult, KbIndex } from './types.js';
export { chunkMarkdown } from './chunk.js';
export { cosineSimilarity, VectorStore } from './store.js';
export { createEmbedder, type Embedder } from './embedder.js';
export { Retriever, INDEX_PATH } from './retriever.js';
export { createSearchKbTool } from './search-kb.tool.js';
export type { VectorIndex } from './vector-index.js';

/**
 * Build the retrieval tool wired to the configured embedder. The KB lives in
 * Postgres/pgvector when DATABASE_URL is set, otherwise the on-disk index.
 */
export function createKnowledgeTool(): AgentTool {
  const embedder = createEmbedder();
  if (isPgVectorEnabled) {
    logger.info({ backend: 'pgvector' }, 'KB vector store selected');
    return createSearchKbTool(new Retriever(embedder, new PgVectorIndex(getDb(), embedder.model)));
  }
  logger.info({ backend: 'file' }, 'KB vector store selected');
  return createSearchKbTool(new Retriever(embedder));
}
