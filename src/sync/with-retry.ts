import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

const BATCH_TIMEOUT_MS = 90_000;
const MAX_BATCH_RETRIES = 2;
const CONNECTION_ERROR_CODES = new Set(['P1017', 'P1001', 'P1008', 'P1002']);

class AttemptTimeoutError extends Error {
  constructor() {
    super(`batch did not complete within ${BATCH_TIMEOUT_MS}ms`);
    this.name = 'AttemptTimeoutError';
  }
}

function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AttemptTimeoutError()), timeoutMs);
    fn()
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function isConnectionError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return CONNECTION_ERROR_CODES.has(err.code);
  }
  if (err instanceof Prisma.PrismaClientInitializationError) {
    return true;
  }
  return err instanceof AttemptTimeoutError;
}

/**
 * Batch-level retry: each attempt gets a hard timeout (a hung connection
 * otherwise waits forever with no thrown error — observed live). On a
 * connection-class failure (Neon dropped/closed the connection, or the
 * attempt just timed out), the whole Prisma connection pool is torn down
 * with $disconnect() and lazily reestablished on the next query — retrying
 * the same batch with the same broken connection doesn't help, a fresh
 * connection does. Any other error (a real constraint violation, a bug) is
 * not a connection problem and is rethrown immediately rather than blindly
 * retried.
 */
export async function withBatchRetry<T>(fn: () => Promise<T>, retries = MAX_BATCH_RETRIES): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await withTimeout(fn, BATCH_TIMEOUT_MS);
    } catch (err) {
      lastErr = err;
      if (!isConnectionError(err)) {
        throw err;
      }
      if (attempt < retries) {
        console.error(`[sync] connection error on batch (attempt ${attempt + 1}/${retries + 1}), reconnecting...`, err);
        await prisma.$disconnect().catch(() => {});
      }
    }
  }
  throw lastErr;
}
