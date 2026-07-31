import { redis } from './redis.js';

const TTL_SECONDS = 60;
// Same fail-open contract as tickets-cache.ts/journeys-cache.ts — caching is
// a pure optimization, never allowed to make a request slower than skipping it.
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
  return `cache:me:documents:${contactId}`;
}

export async function getCachedDocuments<T>(contactId: string): Promise<T | null> {
  try {
    const raw = await withTimeout(redis.get(cacheKey(contactId)), REDIS_OP_TIMEOUT_MS);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (err) {
    console.error('[documents-cache] get failed, falling back to DB', err);
    return null;
  }
}

export async function setCachedDocuments<T>(contactId: string, payload: T): Promise<void> {
  try {
    await withTimeout(redis.set(cacheKey(contactId), JSON.stringify(payload), 'EX', TTL_SECONDS), REDIS_OP_TIMEOUT_MS);
  } catch (err) {
    console.error('[documents-cache] set failed, response served without caching', err);
  }
}

// Called from the staff upload/submit-for-review routes and the customer
// respond route whenever a contact's documents change.
export async function invalidateDocumentsCache(contactId: string): Promise<void> {
  try {
    await withTimeout(redis.del(cacheKey(contactId)), REDIS_OP_TIMEOUT_MS);
  } catch (err) {
    console.error('[documents-cache] invalidate failed', err);
  }
}
