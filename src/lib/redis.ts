import { Redis } from 'ioredis';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

const RETRY_STEP_MS = 500;
const MAX_RETRY_DELAY_MS = 10_000;

export const redis = new Redis(redisUrl, {
  connectTimeout: 2000,
  maxRetriesPerRequest: 1,
  // Explicit, capped backoff for the CONNECTION itself (distinct from
  // maxRetriesPerRequest, which only bounds how long an individual queued
  // command waits through reconnect cycles). ioredis's default retryStrategy
  // caps at 2000ms — observed live, that wasn't conservative enough: a
  // transient client-side connect error (EADDRNOTAVAIL) put the connection
  // into a reconnect loop that never recovered for the rest of the process's
  // lifetime (confirmed twice — /healthz stuck reporting the redis component
  // down until a manual restart). Always returning a number (never null)
  // means it keeps retrying forever rather than giving up; the wider cap
  // reduces reconnect-attempt frequency, giving transient local network
  // conditions (laptop sleep/wake, wifi handoff, ephemeral port churn from
  // rapid reconnects) more room to clear between attempts.
  retryStrategy(times) {
    return Math.min(times * RETRY_STEP_MS, MAX_RETRY_DELAY_MS);
  },
});

// rediss:// implies TLS automatically in ioredis, so a reconnect re-runs the
// full TLS handshake same as the initial connect — no extra config needed
// for that specifically. These listeners exist so a reconnect loop is
// actually visible in logs instead of silent until /healthz notices.
redis.on('error', (err) => {
  console.error('[redis] connection error:', err.message);
});

redis.on('reconnecting', (delay: number) => {
  console.warn(`[redis] reconnecting in ${delay}ms`);
});

redis.on('connect', () => {
  console.log('[redis] connected');
});
