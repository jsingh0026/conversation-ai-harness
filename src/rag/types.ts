/**
 * Trust/freshness metadata carried from a doc's OKF frontmatter (Open Knowledge
 * Format). Optional — plain markdown docs simply have none (always usable). Lets
 * grounding be provenance-aware (skip deprecated/stale) and lets the trace show
 * *why* a source is trustworthy, not just its similarity score.
 */
export interface Provenance {
  status: 'draft' | 'stable' | 'deprecated';
  verifiedBy?: string;
  verifiedAt?: string;
  /** YYYY-MM-DD; past this the content is treated as stale. */
  staleAfter?: string;
  /** Citation key from the doc's `sources`. */
  sourceId?: string;
}

/** A unit of KB text produced by the chunker. */
export interface Chunk {
  /** Stable id: `${docId}#${index}`. */
  id: string;
  docId: string;
  title: string;
  section?: string;
  text: string;
  provenance?: Provenance;
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
  provenance?: Provenance;
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
  /** Why not grounded, when relevant: 'stale' = matched only deprecated/expired docs. */
  reason?: 'stale';
}

/** The on-disk index artifact produced by `pnpm ingest`. */
export interface KbIndex {
  embedModel: string;
  dims: number;
  /** Per-source content hash, so re-ingest can skip unchanged docs. */
  docs: Record<string, { hash: string }>;
  chunks: EmbeddedChunk[];
}
