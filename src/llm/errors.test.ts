import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  AuthError,
  ContextLengthError,
  LLMError,
  ProviderError,
  RateLimitError,
  TransientError,
  mapProviderError,
} from './errors.js';

function apiError(statusCode: number, message = 'boom', isRetryable = false): APICallError {
  return new APICallError({
    message,
    url: 'https://api.test/v1',
    requestBodyValues: {},
    statusCode,
    isRetryable,
  });
}

describe('mapProviderError', () => {
  it('passes through existing LLMErrors', () => {
    const e = new RateLimitError('x');
    expect(mapProviderError(e, 'claude')).toBe(e);
  });

  it('maps 401/403 to AuthError (not retryable)', () => {
    expect(mapProviderError(apiError(401), 'openai')).toBeInstanceOf(AuthError);
    const e = mapProviderError(apiError(403), 'openai');
    expect(e.retryable).toBe(false);
  });

  it('maps 429 to RateLimitError (retryable)', () => {
    const e = mapProviderError(apiError(429), 'gemini');
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e.retryable).toBe(true);
  });

  it('maps 400 context-length messages to ContextLengthError', () => {
    const e = mapProviderError(apiError(400, 'maximum context length exceeded'), 'claude');
    expect(e).toBeInstanceOf(ContextLengthError);
  });

  it('maps 5xx to TransientError', () => {
    expect(mapProviderError(apiError(503), 'claude')).toBeInstanceOf(TransientError);
  });

  it('honors isRetryable for other 4xx', () => {
    expect(mapProviderError(apiError(408, 'timeout', true), 'openai')).toBeInstanceOf(TransientError);
  });

  it('maps a plain 400 to ProviderError', () => {
    expect(mapProviderError(apiError(400, 'bad request'), 'openai')).toBeInstanceOf(ProviderError);
  });

  it('maps unknown/network errors to TransientError', () => {
    const e = mapProviderError(new Error('ECONNRESET'), 'gemini');
    expect(e).toBeInstanceOf(TransientError);
    expect(e).toBeInstanceOf(LLMError);
  });
});
