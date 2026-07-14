import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClient = new RedisMock();

vi.mock('../src/lib/redis.js', () => ({ redis: mockClient }));

const { checkAndIncr } = await import('../src/lib/rate-limit.js');

describe('checkAndIncr', () => {
  beforeEach(async () => {
    await mockClient.flushall();
  });

  it('allows requests up to the limit within the window', async () => {
    const key = 'ratelimit:test:mobile';
    expect(await checkAndIncr(key, 3, 900)).toBe(true);
    expect(await checkAndIncr(key, 3, 900)).toBe(true);
    expect(await checkAndIncr(key, 3, 900)).toBe(true);
  });

  it('blocks once the limit is exceeded within the window', async () => {
    const key = 'ratelimit:test:mobile';
    await checkAndIncr(key, 3, 900);
    await checkAndIncr(key, 3, 900);
    await checkAndIncr(key, 3, 900);
    expect(await checkAndIncr(key, 3, 900)).toBe(false);
  });

  it('tracks separate keys independently (per-mobile vs per-IP)', async () => {
    expect(await checkAndIncr('ratelimit:mobile:a', 1, 900)).toBe(true);
    expect(await checkAndIncr('ratelimit:mobile:a', 1, 900)).toBe(false);
    expect(await checkAndIncr('ratelimit:ip:b', 1, 900)).toBe(true);
  });
});
