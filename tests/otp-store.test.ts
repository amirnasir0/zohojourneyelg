import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClient = new RedisMock();

vi.mock('../src/lib/redis.js', () => ({ redis: mockClient }));

const { storeOtp, verifyStoredOtp } = await import('../src/lib/otp-store.js');

const MOBILE = '+919876543210';

describe('verifyStoredOtp', () => {
  beforeEach(async () => {
    await mockClient.flushall();
  });

  it('returns EXPIRED when no OTP was stored', async () => {
    expect(await verifyStoredOtp(MOBILE, '123456')).toEqual({ status: 'EXPIRED' });
  });

  it('returns OK for the correct OTP and consumes it', async () => {
    await storeOtp(MOBILE, '123456');
    expect(await verifyStoredOtp(MOBILE, '123456')).toEqual({ status: 'OK' });
    expect(await verifyStoredOtp(MOBILE, '123456')).toEqual({ status: 'EXPIRED' });
  });

  it('returns INVALID with attempts_remaining on wrong OTP', async () => {
    await storeOtp(MOBILE, '123456');
    expect(await verifyStoredOtp(MOBILE, '000000')).toEqual({ status: 'INVALID', attemptsRemaining: 2 });
    expect(await verifyStoredOtp(MOBILE, '000000')).toEqual({ status: 'INVALID', attemptsRemaining: 1 });
  });

  it('locks after 3 wrong attempts and deletes the OTP', async () => {
    await storeOtp(MOBILE, '123456');
    expect(await verifyStoredOtp(MOBILE, '000000')).toEqual({ status: 'INVALID', attemptsRemaining: 2 });
    expect(await verifyStoredOtp(MOBILE, '000000')).toEqual({ status: 'INVALID', attemptsRemaining: 1 });
    expect(await verifyStoredOtp(MOBILE, '000000')).toEqual({ status: 'LOCKED' });

    // key was deleted on lockout — even the correct OTP now reads as expired
    expect(await verifyStoredOtp(MOBILE, '123456')).toEqual({ status: 'EXPIRED' });
  });
});
