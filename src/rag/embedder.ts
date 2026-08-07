import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import { embed, embedMany, type EmbeddingModel } from 'ai';
import { env } from '../config/env.js';

/**
 * Embedding abstraction, separate from the chat provider (the two need not be
 * the same vendor). Backed by the AI SDK's `embed`/`embedMany`.
 */
export interface Embedder {
  readonly model: string;
  embed(text: string): Promise<number[]>;
  embedMany(texts: string[]): Promise<number[][]>;
}

class AiSdkEmbedder implements Embedder {
  constructor(
    readonly model: string,
    private readonly handle: EmbeddingModel,
  ) {}

  async embed(text: string): Promise<number[]> {
    const { embedding } = await embed({ model: this.handle, value: text });
    return embedding;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const { embeddings } = await embedMany({ model: this.handle, values: texts });
    return embeddings;
  }
}

/** Build the configured embedder (EMBED_PROVIDER + EMBED_MODEL). */
export function createEmbedder(): Embedder {
  switch (env.EMBED_PROVIDER) {
    case 'openai':
      return new AiSdkEmbedder(env.EMBED_MODEL, openai.textEmbeddingModel(env.EMBED_MODEL));
    case 'gemini':
      return new AiSdkEmbedder(env.EMBED_MODEL, google.textEmbeddingModel(env.EMBED_MODEL));
    default:
      throw new Error(`Unknown EMBED_PROVIDER: ${String(env.EMBED_PROVIDER)}`);
  }
}
