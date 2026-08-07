import { createEmbedder } from './embedder.js';
import { Retriever } from './retriever.js';
import { createSearchKbTool } from './search-kb.tool.js';
import type { AgentTool } from '../orchestrator/agent-tool.js';

export type { Chunk, EmbeddedChunk, RetrievedChunk, RetrievalResult, KbIndex } from './types.js';
export { chunkMarkdown } from './chunk.js';
export { cosineSimilarity, VectorStore } from './store.js';
export { createEmbedder, type Embedder } from './embedder.js';
export { Retriever, INDEX_PATH } from './retriever.js';
export { createSearchKbTool } from './search-kb.tool.js';

/** Build the retrieval tool wired to the configured embedder + on-disk index. */
export function createKnowledgeTool(): AgentTool {
  return createSearchKbTool(new Retriever(createEmbedder()));
}
