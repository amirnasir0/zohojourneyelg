import { describe, expect, it } from 'vitest';
import { isRetryableNetworkError, networkBackoffDelayMs } from '../src/lib/zoho-http.js';

function errWithCode(code: string): Error {
  const err = new Error(`${code} happened`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function errWithCauseCode(code: string): Error {
  return new Error('fetch failed', { cause: errWithCode(code) });
}

describe('isRetryableNetworkError', () => {
  it('treats ECONNRESET, ETIMEDOUT, EAI_AGAIN, ENOTFOUND, ECONNREFUSED as retryable', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED']) {
      expect(isRetryableNetworkError(errWithCode(code))).toBe(true);
    }
  });

  it('reads the code off err.cause too, matching undici fetch-failure shape', () => {
    expect(isRetryableNetworkError(errWithCauseCode('ECONNRESET'))).toBe(true);
  });

  it('treats a socket hang up message as retryable even without an errno code', () => {
    expect(isRetryableNetworkError(new Error('socket hang up'))).toBe(true);
  });

  it('treats AbortSignal.timeout()-style TimeoutError/AbortError as retryable', () => {
    const timeoutErr = new Error('timed out');
    timeoutErr.name = 'TimeoutError';
    expect(isRetryableNetworkError(timeoutErr)).toBe(true);

    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    expect(isRetryableNetworkError(abortErr)).toBe(true);
  });

  it('does not retry an unrelated error', () => {
    expect(isRetryableNetworkError(new Error('unexpected token in JSON'))).toBe(false);
  });

  it('does not retry a non-Error value', () => {
    expect(isRetryableNetworkError('nope')).toBe(false);
    expect(isRetryableNetworkError(null)).toBe(false);
  });
});

describe('networkBackoffDelayMs', () => {
  it('doubles from a 2s base, capped at 30s, across 5 attempts', () => {
    expect(networkBackoffDelayMs(0)).toBe(2_000);
    expect(networkBackoffDelayMs(1)).toBe(4_000);
    expect(networkBackoffDelayMs(2)).toBe(8_000);
    expect(networkBackoffDelayMs(3)).toBe(16_000);
    expect(networkBackoffDelayMs(4)).toBe(30_000);
  });

  it('stays capped at 30s beyond attempt 4', () => {
    expect(networkBackoffDelayMs(5)).toBe(30_000);
    expect(networkBackoffDelayMs(10)).toBe(30_000);
  });
});
