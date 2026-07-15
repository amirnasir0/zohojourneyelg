import { redis } from './redis.js';

const TTL_SECONDS = 60;
// Caching is a pure optimization, not a correctness requirement — a slow or
// flaky Redis must never make a request slower than skipping the cache
// entirely (observed live: an unprotected Redis call once blocked a request
// for 86s after a transient connection hiccup). Every op gets a hard local
// timeout and fails open (cache miss / skip-write), falling back to Postgres.
const REDIS_OP_TIMEOUT_MS = 200;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`redis op timed out after ${timeoutMs}ms`)), timeoutMs);
    promise
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

function cacheKey(contactId: string): string {
  return `cache:me:journeys:${contactId}`;
}

export async function getCachedJourneys<T>(contactId: string): Promise<T[] | null> {
  try {
    const raw = await withTimeout(redis.get(cacheKey(contactId)), REDIS_OP_TIMEOUT_MS);
    return raw ? (JSON.parse(raw) as T[]) : null;
  } catch (err) {
    console.error('[journeys-cache] get failed, falling back to DB', err);
    return null;
  }
}

export async function setCachedJourneys<T>(contactId: string, payload: T[]): Promise<void> {
  try {
    await withTimeout(redis.set(cacheKey(contactId), JSON.stringify(payload), 'EX', TTL_SECONDS), REDIS_OP_TIMEOUT_MS);
  } catch (err) {
    console.error('[journeys-cache] set failed, response served without caching', err);
  }
}

/**
 * Called from the sync write path (writeContactBatch/writeJourneyBatch)
 * after a batch commits, and will matter for M5 webhooks too. Kept tiny on
 * purpose — just a key delete — since sync is disabled right now
 * (ENABLE_SYNC=false) and this hook isn't exercised live yet.
 */
export async function invalidateJourneysCache(contactId: string): Promise<void> {
  try {
    await withTimeout(redis.del(cacheKey(contactId)), REDIS_OP_TIMEOUT_MS);
  } catch (err) {
    console.error('[journeys-cache] invalidate failed', err);
  }
}
