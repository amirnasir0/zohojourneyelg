import Fastify from 'fastify';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisMock = new RedisMock();
vi.mock('../src/lib/redis.js', () => ({ redis: redisMock }));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    staffUser: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    staffSession: { findUnique: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../src/lib/password.js', () => ({
  hashPassword: vi.fn().mockResolvedValue('hashed-password'),
}));

vi.mock('../src/lib/staff-jwt.js', () => ({
  verifyStaffSessionToken: vi.fn(),
}));

const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/password.js');
const { verifyStaffSessionToken } = await import('../src/lib/staff-jwt.js');
const { registerStaffAdminRoutes } = await import('../src/routes/staff-admin.js');

async function buildApp() {
  const app = Fastify();
  await registerStaffAdminRoutes(app);
  return app;
}

function mockAuthAs(staffId: string, role: 'ADMIN' | 'MANAGER' | 'EMPLOYEE') {
  vi.mocked(verifyStaffSessionToken).mockResolvedValue({ sub: staffId, jti: `jti-${staffId}`, role });
  vi.mocked(prisma.staffSession.findUnique).mockResolvedValue({
    id: 'sess-1',
    staffId,
    jti: `jti-${staffId}`,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    revokedAt: null,
    createdAt: new Date(),
    staff: { id: staffId, role, active: true },
  } as never);
}

const authHeader = { authorization: 'Bearer token' };

beforeEach(async () => {
  vi.clearAllMocks();
  await redisMock.flushall();
});

describe('role gating', () => {
  it('returns 401 without a bearer token', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/staff/users' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for an authenticated EMPLOYEE (not ADMIN)', async () => {
    mockAuthAs('emp-1', 'EMPLOYEE');
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/staff/users', headers: authHeader });
    expect(res.statusCode).toBe(403);
  });

  it('returns 401 when the staff account is deactivated', async () => {
    vi.mocked(verifyStaffSessionToken).mockResolvedValue({ sub: 'admin-1', jti: 'jti-admin-1', role: 'ADMIN' });
    vi.mocked(prisma.staffSession.findUnique).mockResolvedValue({
      id: 'sess-1',
      staffId: 'admin-1',
      jti: 'jti-admin-1',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      revokedAt: null,
      createdAt: new Date(),
      staff: { id: 'admin-1', role: 'ADMIN', active: false },
    } as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/staff/users', headers: authHeader });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /staff/users', () => {
  it('creates a new staff user as ADMIN', async () => {
    mockAuthAs('admin-1', 'ADMIN');
    vi.mocked(prisma.staffUser.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.staffUser.create).mockResolvedValue({
      id: 'new-staff',
      email: 'employee@webspecia.in',
      role: 'EMPLOYEE',
      fullName: 'New Employee',
      zohoOwnerId: '12345',
      active: true,
      createdAt: new Date(),
    } as never);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/staff/users',
      headers: authHeader,
      payload: { email: 'Employee@Webspecia.in', password: 'a-real-password', role: 'EMPLOYEE', full_name: 'New Employee', zoho_owner_id: '12345' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: 'new-staff', email: 'employee@webspecia.in', role: 'EMPLOYEE', zoho_owner_id: '12345' });
    expect(hashPassword).toHaveBeenCalledWith('a-real-password');
    expect(prisma.staffUser.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: 'employee@webspecia.in', passwordHash: 'hashed-password', role: 'EMPLOYEE' }),
    });
  });

  it('returns 409 when the email is already taken', async () => {
    mockAuthAs('admin-1', 'ADMIN');
    vi.mocked(prisma.staffUser.findUnique).mockResolvedValue({ id: 'existing' } as never);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/staff/users',
      headers: authHeader,
      payload: { email: 'taken@webspecia.in', password: 'a-real-password', role: 'EMPLOYEE' },
    });

    expect(res.statusCode).toBe(409);
    expect(prisma.staffUser.create).not.toHaveBeenCalled();
  });

  it('returns 400 for a short password', async () => {
    mockAuthAs('admin-1', 'ADMIN');
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/staff/users',
      headers: authHeader,
      payload: { email: 'x@webspecia.in', password: 'short', role: 'EMPLOYEE' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /staff/users', () => {
  it('lists all staff users as ADMIN', async () => {
    mockAuthAs('admin-1', 'ADMIN');
    vi.mocked(prisma.staffUser.findMany).mockResolvedValue([
      { id: 'admin-1', email: 'admin@webspecia.in', role: 'ADMIN', fullName: null, zohoOwnerId: null, active: true, createdAt: new Date() },
    ] as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/staff/users', headers: authHeader });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([expect.objectContaining({ id: 'admin-1', role: 'ADMIN' })]);
  });
});

describe('PATCH /staff/users/:id', () => {
  it('updates role/active/zoho_owner_id as ADMIN', async () => {
    mockAuthAs('admin-1', 'ADMIN');
    vi.mocked(prisma.staffUser.findUnique).mockResolvedValue({ id: 'emp-1' } as never);
    vi.mocked(prisma.staffUser.update).mockResolvedValue({
      id: 'emp-1',
      email: 'emp@webspecia.in',
      role: 'ADMIN',
      fullName: 'Emp',
      zohoOwnerId: '999',
      active: false,
      createdAt: new Date(),
    } as never);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/staff/users/emp-1',
      headers: authHeader,
      payload: { role: 'ADMIN', active: false, zoho_owner_id: '999' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'emp-1', role: 'ADMIN', active: false, zoho_owner_id: '999' });
    expect(prisma.staffUser.update).toHaveBeenCalledWith({
      where: { id: 'emp-1' },
      data: { role: 'ADMIN', active: false, zohoOwnerId: '999' },
    });
  });

  it('returns 404 for a nonexistent staff id', async () => {
    mockAuthAs('admin-1', 'ADMIN');
    vi.mocked(prisma.staffUser.findUnique).mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({ method: 'PATCH', url: '/staff/users/nope', headers: authHeader, payload: { active: false } });
    expect(res.statusCode).toBe(404);
  });

  it('ignores email/password fields even if sent (not part of this endpoint)', async () => {
    mockAuthAs('admin-1', 'ADMIN');
    vi.mocked(prisma.staffUser.findUnique).mockResolvedValue({ id: 'emp-1' } as never);
    vi.mocked(prisma.staffUser.update).mockResolvedValue({
      id: 'emp-1',
      email: 'emp@webspecia.in',
      role: 'EMPLOYEE',
      fullName: null,
      zohoOwnerId: null,
      active: true,
      createdAt: new Date(),
    } as never);

    const app = await buildApp();
    await app.inject({
      method: 'PATCH',
      url: '/staff/users/emp-1',
      headers: authHeader,
      payload: { email: 'new@webspecia.in', password: 'ignored', active: true },
    });

    expect(prisma.staffUser.update).toHaveBeenCalledWith({ where: { id: 'emp-1' }, data: { active: true } });
  });
});

describe('POST /staff/users/:id/password', () => {
  it('re-hashes the new password and revokes every live session for that account', async () => {
    mockAuthAs('admin-1', 'ADMIN');
    vi.mocked(prisma.staffUser.findUnique).mockResolvedValue({ id: 'emp-1' } as never);
    vi.mocked(prisma.$transaction).mockResolvedValue([] as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/staff/users/emp-1/password', headers: authHeader, payload: { password: 'brand-new-pass' } });

    expect(res.statusCode).toBe(200);
    expect(hashPassword).toHaveBeenCalledWith('brand-new-pass');
    expect(prisma.staffUser.update).toHaveBeenCalledWith({ where: { id: 'emp-1' }, data: { passwordHash: 'hashed-password' } });
    expect(prisma.staffSession.updateMany).toHaveBeenCalledWith({ where: { staffId: 'emp-1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
  });

  it('rejects a password shorter than 8 characters', async () => {
    mockAuthAs('admin-1', 'ADMIN');
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/staff/users/emp-1/password', headers: authHeader, payload: { password: 'short' } });
    expect(res.statusCode).toBe(400);
  });

  it('404s for an unknown staff id', async () => {
    mockAuthAs('admin-1', 'ADMIN');
    vi.mocked(prisma.staffUser.findUnique).mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/staff/users/nope/password', headers: authHeader, payload: { password: 'brand-new-pass' } });
    expect(res.statusCode).toBe(404);
  });

  it('is admin-only — a MANAGER gets 403', async () => {
    mockAuthAs('mgr-1', 'MANAGER');
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/staff/users/emp-1/password', headers: authHeader, payload: { password: 'brand-new-pass' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('MANAGER role', () => {
  it('can be assigned when creating a staff user', async () => {
    mockAuthAs('admin-1', 'ADMIN');
    vi.mocked(prisma.staffUser.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.staffUser.create).mockResolvedValue({
      id: 'mgr-1',
      email: 'manager@webspecia.in',
      role: 'MANAGER',
      fullName: null,
      zohoOwnerId: null,
      active: true,
      createdAt: new Date(),
    } as never);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/staff/users',
      headers: authHeader,
      payload: { email: 'manager@webspecia.in', password: 'a-real-password', role: 'MANAGER' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe('MANAGER');
  });
});
