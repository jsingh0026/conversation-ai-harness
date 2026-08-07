import { LLMError } from './errors.js';

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  onRetry?: (attempt: number, delayMs: number, err: LLMError) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Retry a call with exponential backoff + jitter, but only for errors our
 * mapping marked `retryable` (rate-limit / transient). Auth and
 * context-length errors fail fast.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const baseMs = opts.baseMs ?? 250;
  const maxMs = opts.maxMs ?? 8_000;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof LLMError && err.retryable;
      if (!retryable || attempt >= retries) throw err;

      const backoff = Math.min(maxMs, baseMs * 2 ** attempt);
      const delay = backoff / 2 + Math.floor(Math.random() * (backoff / 2));
      opts.onRetry?.(attempt + 1, delay, err);
      await sleep(delay);
      attempt++;
    }
  }
}
