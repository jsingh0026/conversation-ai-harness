/** A unit of KB text produced by the chunker. */
export interface Chunk {
  /** Stable id: `${docId}#${index}`. */
  id: string;
  docId: string;
  title: string;
  section?: string;
  text: string;
}

export interface EmbeddedChunk extends Chunk {
  embedding: number[];
}

/** A chunk returned from retrieval, with its similarity score. */
export interface RetrievedChunk {
  id: string;
  docId: string;
  title: string;
  section?: string;
  text: string;
  score: number;
}

/**
 * The outcome of a retrieval. `grounded` is the explicit signal the agent uses:
 * when false (nothing cleared the score threshold), the agent must decline or
 * hand over rather than answer — never invent.
 */
export interface RetrievalResult {
  query: string;
  grounded: boolean;
  chunks: RetrievedChunk[];
}

/** The on-disk index artifact produced by `pnpm ingest`. */
export interface KbIndex {
  embedModel: string;
  dims: number;
  /** Per-source content hash, so re-ingest can skip unchanged docs. */
  docs: Record<string, { hash: string }>;
  chunks: EmbeddedChunk[];
}
