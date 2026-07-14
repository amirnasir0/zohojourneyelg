import { redis } from './redis.js';

/**
 * Fixed-window counter: increments `key`, setting its TTL on first hit.
 * Returns false once `count` exceeds `limit` within the window.
 */
export async function checkAndIncr(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }
  return count <= limit;
}
