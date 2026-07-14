import { createHash, randomInt } from 'node:crypto';
import { redis } from './redis.js';

const OTP_TTL_SECONDS = 5 * 60;
const MAX_ATTEMPTS = 3;

function otpKey(mobile: string): string {
  return `otp:${mobile}`;
}

function hashOtp(otp: string): string {
  return createHash('sha256').update(otp).digest('hex');
}

export function generateOtp(): string {
  return randomInt(100000, 1000000).toString();
}

export async function storeOtp(mobile: string, otp: string): Promise<void> {
  const key = otpKey(mobile);
  await redis.hset(key, { hash: hashOtp(otp), attempts: 0 });
  await redis.expire(key, OTP_TTL_SECONDS);
}

export type VerifyOtpResult =
  | { status: 'OK' }
  | { status: 'EXPIRED' }
  | { status: 'INVALID'; attemptsRemaining: number }
  | { status: 'LOCKED' };

export async function verifyStoredOtp(mobile: string, otp: string): Promise<VerifyOtpResult> {
  const key = otpKey(mobile);
  const data = await redis.hgetall(key);

  if (!data || !data.hash) {
    return { status: 'EXPIRED' };
  }

  if (data.hash === hashOtp(otp)) {
    await redis.del(key);
    return { status: 'OK' };
  }

  const attempts = await redis.hincrby(key, 'attempts', 1);
  if (attempts >= MAX_ATTEMPTS) {
    await redis.del(key);
    return { status: 'LOCKED' };
  }

  return { status: 'INVALID', attemptsRemaining: MAX_ATTEMPTS - attempts };
}
