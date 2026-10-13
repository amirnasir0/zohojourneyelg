import Fastify from 'fastify';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Module-load-time env read in src/routes/auth.ts — must be set before import.
process.env.REVIEW_PHONE = '+919999999999';
process.env.REVIEW_OTP = '123456';

const redisMock = new RedisMock();
vi.mock('../src/lib/redis.js', () => ({ redis: redisMock }));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    contact: { findUnique: vi.fn(), findFirst: vi.fn() },
    session: { create: vi.fn(), updateMany: vi.fn() },
  },
}));

vi.mock('../src/lib/jwt.js', () => ({
  signSessionToken: vi.fn().mockResolvedValue('signed-token'),
  verifySessionToken: vi.fn(),
}));

vi.mock('../src/lib/otp-providers/index.js', () => ({
  sendOtp: vi.fn(),
}));

vi.mock('../src/lib/otp-store.js', () => ({
  generateOtp: vi.fn().mockReturnValue('654321'),
  storeOtp: vi.fn(),
  verifyStoredOtp: vi.fn(),
}));

const { prisma } = await import('../src/lib/prisma.js');
const { sendOtp } = await import('../src/lib/otp-providers/index.js');
const { storeOtp, verifyStoredOtp } = await import('../src/lib/otp-store.js');
const { registerAuthRoutes } = await import('../src/routes/auth.js');

async function buildApp() {
  const app = Fastify();
  await registerAuthRoutes(app);
  return app;
}

const REVIEW_ZOHO_CONTACT_ID = 'DEMO-REVIEWER-ACCOUNT';

beforeEach(async () => {
  vi.clearAllMocks();
  await redisMock.flushall();
});

describe('reviewer/demo login — POST /auth/send-otp', () => {
  it('returns success without sending a real OTP or touching rate limits', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/send-otp', payload: { mobile: '9999999999' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, channel: 'whatsapp' });
    expect(sendOtp).not.toHaveBeenCalled();
    expect(storeOtp).not.toHaveBeenCalled();
  });

  it('a different number still goes through the real send flow', async () => {
    vi.mocked(sendOtp).mockResolvedValue({ success: true, channel: 'whatsapp' });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/send-otp', payload: { mobile: '9876543210' } });

    expect(res.statusCode).toBe(200);
    expect(sendOtp).toHaveBeenCalled();
    expect(storeOtp).toHaveBeenCalled();
  });
});

describe('reviewer/demo login — POST /auth/verify-otp', () => {
  it('logs into the dedicated demo contact via the hardcoded sentinel id, not by mobile lookup', async () => {
    vi.mocked(prisma.contact.findUnique).mockResolvedValue({
      id: 'demo-contact-1',
      fullName: 'App Reviewer Demo',
      email: null,
    } as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/verify-otp', payload: { mobile: '9999999999', otp: '123456' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ token: 'signed-token', contact: { id: 'demo-contact-1', fullName: 'App Reviewer Demo' } });
    expect(prisma.contact.findUnique).toHaveBeenCalledWith({ where: { zohoContactId: REVIEW_ZOHO_CONTACT_ID } });
    // Never looked up by mobile number — would have matched a real contact instead.
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
    expect(verifyStoredOtp).not.toHaveBeenCalled();
  });

  it('fails closed to NO_ACCOUNT if the seed script has not been run yet', async () => {
    vi.mocked(prisma.contact.findUnique).mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/verify-otp', payload: { mobile: '9999999999', otp: '123456' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ token: null, status: 'NO_ACCOUNT' });
  });

  it('does not bypass with the wrong OTP for the reviewer number', async () => {
    vi.mocked(verifyStoredOtp).mockResolvedValue({ status: 'EXPIRED' });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/verify-otp', payload: { mobile: '9999999999', otp: '000000' } });

    expect(res.statusCode).toBe(410);
    expect(prisma.contact.findUnique).not.toHaveBeenCalled();
  });

  it('a different number with the review OTP value still goes through the real verify flow', async () => {
    vi.mocked(verifyStoredOtp).mockResolvedValue({ status: 'EXPIRED' });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/verify-otp', payload: { mobile: '9876543210', otp: '123456' } });

    expect(res.statusCode).toBe(410);
    expect(verifyStoredOtp).toHaveBeenCalledWith('+919876543210', '123456');
  });
});
