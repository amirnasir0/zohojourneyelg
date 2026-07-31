import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyPassword } from '../lib/password.js';
import { prisma } from '../lib/prisma.js';
import { checkAndIncr } from '../lib/rate-limit.js';
import { signStaffSessionToken, STAFF_JWT_TTL_SECONDS, verifyStaffSessionToken } from '../lib/staff-jwt.js';

const EMAIL_RATE_LIMIT = 5;
const EMAIL_RATE_WINDOW_SECONDS = 15 * 60;
const IP_RATE_LIMIT = 20;
const IP_RATE_WINDOW_SECONDS = 60 * 60;

const loginBodySchema = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function registerStaffAuthRoutes(app: FastifyInstance) {
  app.post('/staff/auth/login', async (req, reply) => {
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_REQUEST' });
    }

    const email = parsed.data.email.toLowerCase();

    const [emailOk, ipOk] = await Promise.all([
      checkAndIncr(`ratelimit:staff-login:email:${email}`, EMAIL_RATE_LIMIT, EMAIL_RATE_WINDOW_SECONDS),
      checkAndIncr(`ratelimit:staff-login:ip:${req.ip}`, IP_RATE_LIMIT, IP_RATE_WINDOW_SECONDS),
    ]);
    if (!emailOk || !ipOk) {
      return reply.code(429).send({ error: 'RATE_LIMITED' });
    }

    const staff = await prisma.staffUser.findUnique({ where: { email } });
    // Deliberately identical response whether the email doesn't exist, the
    // account is deactivated, or the password is wrong — same
    // "never reveal account existence" principle as customer OTP verify.
    if (!staff || !staff.active) {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    }

    const passwordOk = await verifyPassword(parsed.data.password, staff.passwordHash);
    if (!passwordOk) {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    }

    const jti = randomUUID();
    const expiresAt = new Date(Date.now() + STAFF_JWT_TTL_SECONDS * 1000);
    await prisma.staffSession.create({ data: { staffId: staff.id, jti, expiresAt } });
    const token = await signStaffSessionToken(staff.id, jti, staff.role);

    return reply.code(200).send({
      token,
      staff: { id: staff.id, email: staff.email, role: staff.role, full_name: staff.fullName },
    });
  });

  app.post('/staff/auth/logout', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }

    let payload;
    try {
      payload = await verifyStaffSessionToken(authHeader.slice('Bearer '.length));
    } catch {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }

    await prisma.staffSession.updateMany({
      where: { jti: payload.jti, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return reply.code(200).send({ success: true });
  });
}
