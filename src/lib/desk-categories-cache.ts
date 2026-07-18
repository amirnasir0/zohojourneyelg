import { redis } from './redis.js';

const TTL_SECONDS = 60;
// Same fail-open contract as journeys-cache.ts/tickets-cache.ts — caching
// is a pure optimization, never allowed to make a request slower than
// skipping it. Single global key (not per-contact) — the category picklist
// is tenant-wide, not customer-specific.
const REDIS_OP_TIMEOUT_MS = 200;
const CACHE_KEY = 'cache:desk:categories';

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

export async function getCachedCategoryValues(): Promise<string[] | null> {
  try {
    const raw = await withTimeout(redis.get(CACHE_KEY), REDIS_OP_TIMEOUT_MS);
    return raw ? (JSON.parse(raw) as string[]) : null;
  } catch (err) {
    console.error('[desk-categories-cache] get failed, falling back to a live fetch', err);
    return null;
  }
}

export async function setCachedCategoryValues(values: string[]): Promise<void> {
  try {
    await withTimeout(redis.set(CACHE_KEY, JSON.stringify(values), 'EX', TTL_SECONDS), REDIS_OP_TIMEOUT_MS);
  } catch (err) {
    console.error('[desk-categories-cache] set failed, response served without caching', err);
  }
}
