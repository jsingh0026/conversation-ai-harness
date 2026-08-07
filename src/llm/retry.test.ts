import { describe, expect, it, vi } from 'vitest';
import { AuthError, TransientError } from './errors.js';
import { withRetry } from './retry.js';

describe('withRetry', () => {
  it('returns on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries retryable errors up to the limit then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TransientError('blip'))
      .mockResolvedValue('ok');
    await expect(withRetry(fn, { baseMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new AuthError('nope'));
    await expect(withRetry(fn, { baseMs: 1 })).rejects.toBeInstanceOf(AuthError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after exhausting retries', async () => {
    const fn = vi.fn().mockRejectedValue(new TransientError('always'));
    await expect(withRetry(fn, { retries: 2, baseMs: 1 })).rejects.toBeInstanceOf(TransientError);
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
