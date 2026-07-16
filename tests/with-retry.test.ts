import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $disconnect: vi.fn().mockResolvedValue(undefined) },
}));

const { withBatchRetry } = await import('../src/sync/with-retry.js');

function connectionError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('connection error', { code, clientVersion: '5.22.0' });
}

describe('withBatchRetry', () => {
  it('returns the result on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withBatchRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on a P1017 connection error and succeeds on the next attempt', async () => {
    const fn = vi.fn().mockRejectedValueOnce(connectionError('P1017')).mockResolvedValueOnce('ok');
    const result = await withBatchRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on P1001/P1008/P1002 the same as P1017', async () => {
    for (const code of ['P1001', 'P1008', 'P1002']) {
      const fn = vi.fn().mockRejectedValueOnce(connectionError(code)).mockResolvedValueOnce('ok');
      await expect(withBatchRetry(fn)).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });

  it('exhausts retries and throws the last connection error', async () => {
    const err = connectionError('P1017');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withBatchRetry(fn)).rejects.toBe(err);
    // default retries = 2 -> 3 total attempts
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respects an explicit retries count', async () => {
    const err = connectionError('P1017');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withBatchRetry(fn, 1)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-connection error (e.g. a real constraint violation)', async () => {
    const err = new Prisma.PrismaClientKnownRequestError('unique constraint failed', { code: 'P2002', clientVersion: '5.22.0' });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withBatchRetry(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry a generic application error', async () => {
    const err = new Error('boom');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withBatchRetry(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('treats a hung attempt that never resolves as a connection error via the attempt timeout', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn()
        .mockImplementationOnce(() => new Promise(() => {})) // never resolves
        .mockResolvedValueOnce('ok');
      const resultPromise = withBatchRetry(fn, 1);
      await vi.advanceTimersByTimeAsync(90_000);
      const result = await resultPromise;
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
