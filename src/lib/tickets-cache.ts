import { redis } from './redis.js';

const TTL_SECONDS = 60;
// Same fail-open contract as journeys-cache.ts — caching is a pure
// optimization, never allowed to make a request slower than skipping it.
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
  return `cache:me:tickets:${contactId}`;
}

export async function getCachedTickets<T>(contactId: string): Promise<T[] | null> {
  try {
    const raw = await withTimeout(redis.get(cacheKey(contactId)), REDIS_OP_TIMEOUT_MS);
    return raw ? (JSON.parse(raw) as T[]) : null;
  } catch (err) {
    console.error('[tickets-cache] get failed, falling back to DB', err);
    return null;
  }
}

export async function setCachedTickets<T>(contactId: string, payload: T[]): Promise<void> {
  try {
    await withTimeout(redis.set(cacheKey(contactId), JSON.stringify(payload), 'EX', TTL_SECONDS), REDIS_OP_TIMEOUT_MS);
  } catch (err) {
    console.error('[tickets-cache] set failed, response served without caching', err);
  }
}

// Called after a ticket is created, and from the ticket-updated webhook and
// ticket sync write paths whenever a contact's tickets change.
export async function invalidateTicketsCache(contactId: string): Promise<void> {
  try {
    await withTimeout(redis.del(cacheKey(contactId)), REDIS_OP_TIMEOUT_MS);
  } catch (err) {
    console.error('[tickets-cache] invalidate failed', err);
  }
}
