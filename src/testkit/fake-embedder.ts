import type { Embedder } from '../rag/embedder.js';

/**
 * Deterministic, network-free embedder for tests. Hashes tokens into a
 * fixed-dimension bag-of-words vector, so cosine similarity reflects token
 * overlap — enough to exercise retrieval ranking and the grounding threshold
 * without calling a real embedding API.
 */
export class FakeEmbedder implements Embedder {
  readonly model = 'fake-embedder';

  constructor(private readonly dims = 64) {}

  async embed(text: string): Promise<number[]> {
    return this.vec(text);
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vec(t));
  }

  private vec(text: string): number[] {
    const v = new Array<number>(this.dims).fill(0);
    for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let h = 0;
      for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) >>> 0;
      v[h % this.dims]! += 1;
    }
    return v;
  }
}
