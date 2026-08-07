import { APICallError } from 'ai';
import type { ProviderName } from './types.js';

export interface LLMErrorOptions {
  cause?: unknown;
  statusCode?: number;
  provider?: ProviderName;
  retryable?: boolean;
}

/** Base class for all normalized LLM errors — uniform across providers. */
export class LLMError extends Error {
  readonly statusCode?: number;
  readonly provider?: ProviderName;
  readonly retryable: boolean;

  constructor(message: string, opts: LLMErrorOptions = {}) {
    super(message, { cause: opts.cause });
    this.name = new.target.name;
    this.statusCode = opts.statusCode;
    this.provider = opts.provider;
    this.retryable = opts.retryable ?? false;
  }
}

/** 429 / quota — retry with backoff. */
export class RateLimitError extends LLMError {
  constructor(message: string, opts: LLMErrorOptions = {}) {
    super(message, { ...opts, retryable: true });
  }
}

/** 401 / 403 — misconfiguration, do not retry. */
export class AuthError extends LLMError {
  constructor(message: string, opts: LLMErrorOptions = {}) {
    super(message, { ...opts, retryable: false });
  }
}

/** Prompt exceeded the model's context window — do not retry as-is. */
export class ContextLengthError extends LLMError {
  constructor(message: string, opts: LLMErrorOptions = {}) {
    super(message, { ...opts, retryable: false });
  }
}

/** 5xx / network blips — retry. */
export class TransientError extends LLMError {
  constructor(message: string, opts: LLMErrorOptions = {}) {
    super(message, { ...opts, retryable: true });
  }
}

/** Anything else from a provider we don't map more specifically. */
export class ProviderError extends LLMError {}

// Substrings that signal a context-window overflow, across providers:
// OpenAI ("maximum context length"), Anthropic ("prompt is too long"),
// Gemini/others ("exceeds the maximum number of tokens", "input token count").
const CONTEXT_HINTS = [
  'context length',
  'context window',
  'maximum context',
  'too many tokens',
  'prompt is too long',
  'input token count',
  'maximum number of tokens',
  'exceeds the maximum',
];

/**
 * Normalize any provider/SDK error into one of our typed errors so retry and
 * handling logic is provider-agnostic — no substring-matching scattered around.
 */
export function mapProviderError(err: unknown, provider: ProviderName): LLMError {
  if (err instanceof LLMError) return err;

  if (APICallError.isInstance(err)) {
    const status = err.statusCode;
    const opts: LLMErrorOptions = { cause: err, statusCode: status, provider };
    const message = `[${provider}] ${err.message}`;

    if (status === 401 || status === 403) return new AuthError(message, opts);
    if (status === 429) return new RateLimitError(message, opts);
    if (status === 400 && CONTEXT_HINTS.some((h) => err.message.toLowerCase().includes(h))) {
      return new ContextLengthError(message, opts);
    }
    if ((status !== undefined && status >= 500) || err.isRetryable) {
      return new TransientError(message, opts);
    }
    return new ProviderError(message, opts);
  }

  const message = err instanceof Error ? err.message : String(err);
  // Unknown shape (often a network/abort error) — treat as transient.
  return new TransientError(`[${provider}] ${message}`, { cause: err, provider });
}
