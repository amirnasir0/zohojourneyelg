import Fastify from 'fastify';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisMock = new RedisMock();
vi.mock('../src/lib/redis.js', () => ({ redis: redisMock }));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    staffUser: { findUnique: vi.fn() },
    staffSession: { create: vi.fn(), updateMany: vi.fn() },
  },
}));

vi.mock('../src/lib/password.js', () => ({
  verifyPassword: vi.fn(),
}));

vi.mock('../src/lib/staff-jwt.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/staff-jwt.js')>('../src/lib/staff-jwt.js');
  return {
    ...actual,
    signStaffSessionToken: vi.fn().mockResolvedValue('signed.staff.token'),
    verifyStaffSessionToken: vi.fn(),
  };
});

const { prisma } = await import('../src/lib/prisma.js');
const { verifyPassword } = await import('../src/lib/password.js');
const { verifyStaffSessionToken } = await import('../src/lib/staff-jwt.js');
const { registerStaffAuthRoutes } = await import('../src/routes/staff-auth.js');

const staffRow = {
  id: 'staff-1',
  email: 'admin@webspecia.in',
  passwordHash: 'hashed',
  role: 'ADMIN',
  zohoOwnerId: null,
  fullName: 'Webspecia Admin',
  active: true,
  createdAt: new Date(),
};

async function buildApp() {
  const app = Fastify();
  await registerStaffAuthRoutes(app);
  return app;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await redisMock.flushall();
});

describe('POST /staff/auth/login', () => {
  it('returns a token + staff profile on correct credentials', async () => {
    vi.mocked(prisma.staffUser.findUnique).mockResolvedValue(staffRow as never);
    vi.mocked(verifyPassword).mockResolvedValue(true);
    vi.mocked(prisma.staffSession.create).mockResolvedValue({} as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/staff/auth/login', payload: { email: 'admin@webspecia.in', password: 'cognidom' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ token: 'signed.staff.token', staff: { id: 'staff-1', role: 'ADMIN' } });
    expect(prisma.staffSession.create).toHaveBeenCalledWith({ data: expect.objectContaining({ staffId: 'staff-1' }) });
  });

  it('returns 401 for a wrong password, without revealing which part was wrong', async () => {
    vi.mocked(prisma.staffUser.findUnique).mockResolvedValue(staffRow as never);
    vi.mocked(verifyPassword).mockResolvedValue(false);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/staff/auth/login', payload: { email: 'admin@webspecia.in', password: 'wrong' } });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'INVALID_CREDENTIALS' });
  });

  it('returns 401 (same code as wrong password) when the email does not exist', async () => {
    vi.mocked(prisma.staffUser.findUnique).mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/staff/auth/login', payload: { email: 'nobody@webspecia.in', password: 'x' } });

    expect(res.statusCode).toBe(401);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('returns 401 for a deactivated staff account, even with the correct password', async () => {
    vi.mocked(prisma.staffUser.findUnique).mockResolvedValue({ ...staffRow, active: false } as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/staff/auth/login', payload: { email: 'admin@webspecia.in', password: 'cognidom' } });

    expect(res.statusCode).toBe(401);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('returns 400 on a malformed body', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/staff/auth/login', payload: { email: 'not-an-email' } });
    expect(res.statusCode).toBe(400);
  });

  it('rate-limits repeated attempts for the same email', async () => {
    vi.mocked(prisma.staffUser.findUnique).mockResolvedValue(staffRow as never);
    vi.mocked(verifyPassword).mockResolvedValue(false);

    const app = await buildApp();
    let last;
    for (let i = 0; i < 6; i++) {
      last = await app.inject({ method: 'POST', url: '/staff/auth/login', payload: { email: 'admin@webspecia.in', password: 'wrong' } });
    }
    expect(last?.statusCode).toBe(429);
  });
});

describe('POST /staff/auth/logout', () => {
  it('revokes the session by jti', async () => {
    vi.mocked(verifyStaffSessionToken).mockResolvedValue({ sub: 'staff-1', jti: 'jti-1', role: 'ADMIN' });
    vi.mocked(prisma.staffSession.updateMany).mockResolvedValue({ count: 1 } as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/staff/auth/logout', headers: { authorization: 'Bearer token' } });

    expect(res.statusCode).toBe(200);
    expect(prisma.staffSession.updateMany).toHaveBeenCalledWith({
      where: { jti: 'jti-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('returns 401 without a bearer header', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/staff/auth/logout' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for an invalid token', async () => {
    vi.mocked(verifyStaffSessionToken).mockRejectedValue(new Error('bad token'));
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/staff/auth/logout', headers: { authorization: 'Bearer bad' } });
    expect(res.statusCode).toBe(401);
  });
});
