import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import { embed, embedMany, type EmbeddingModel } from 'ai';
import { env } from '../config/env.js';
import { logger } from '../util/logger.js';

/**
 * Embedding abstraction, separate from the chat provider (the two need not be
 * the same vendor). Backed by the AI SDK's `embed`/`embedMany` (cloud) or a
 * Transformers.js model running on-device (local).
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

/**
 * Local, on-device embedder via Transformers.js (ONNX). No API key or network
 * at inference — the model is downloaded from the HF hub once and cached. Uses
 * mean pooling + L2 normalization so cosine similarity behaves as expected.
 */
class LocalEmbedder implements Embedder {
  // The pipeline is loaded lazily on first use (a cold load takes a few seconds).
  private pipe: Promise<FeatureExtractionPipelineLike> | undefined;

  constructor(readonly model: string) {}

  private async extractor(): Promise<FeatureExtractionPipelineLike> {
    if (!this.pipe) {
      this.pipe = (async () => {
        const { pipeline, env: tfEnv } = await import('@xenova/transformers');
        tfEnv.allowLocalModels = false; // pull from the HF hub, then cache
        // Pin the cache dir so a Docker build can bake the model into the image
        // (set TRANSFORMERS_CACHE at build + run time); unset = library default.
        if (process.env.TRANSFORMERS_CACHE) tfEnv.cacheDir = process.env.TRANSFORMERS_CACHE;
        const t0 = Date.now();
        const p = (await pipeline('feature-extraction', this.model)) as FeatureExtractionPipelineLike;
        logger.info({ model: this.model, ms: Date.now() - t0 }, 'local embedding model loaded');
        return p;
      })();
    }
    return this.pipe;
  }

  async embed(text: string): Promise<number[]> {
    const [v] = await this.embedMany([text]);
    return v!;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.extractor();
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    return output.tolist();
  }
}

/** Minimal shape of the Transformers.js feature-extraction pipeline we use. */
interface FeatureExtractionPipelineLike {
  (
    texts: string[],
    options: { pooling: 'mean'; normalize: boolean },
  ): Promise<{ tolist(): number[][] }>;
}

/** Build the configured embedder: local (Transformers.js) or cloud (AI SDK). */
export function createEmbedder(): Embedder {
  if (env.EMBED_LOCAL) return new LocalEmbedder(env.EMBED_LOCAL_MODEL);

  switch (env.EMBED_PROVIDER) {
    case 'openai':
      return new AiSdkEmbedder(env.EMBED_MODEL, openai.textEmbeddingModel(env.EMBED_MODEL));
    case 'gemini':
      return new AiSdkEmbedder(env.EMBED_MODEL, google.textEmbeddingModel(env.EMBED_MODEL));
    default:
      throw new Error(`Unknown EMBED_PROVIDER: ${String(env.EMBED_PROVIDER)}`);
  }
}
