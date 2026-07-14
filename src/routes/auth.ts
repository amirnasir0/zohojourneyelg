import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizePhone } from '../lib/phone.js';
import { verifySessionToken, signSessionToken } from '../lib/jwt.js';
import { sendOtp } from '../lib/otp-providers/index.js';
import { generateOtp, storeOtp, verifyStoredOtp } from '../lib/otp-store.js';
import { prisma } from '../lib/prisma.js';
import { checkAndIncr } from '../lib/rate-limit.js';

const MOBILE_RATE_LIMIT = 3;
const MOBILE_RATE_WINDOW_SECONDS = 15 * 60;
const IP_RATE_LIMIT = 10;
const IP_RATE_WINDOW_SECONDS = 60 * 60;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const sendOtpBodySchema = z.object({ mobile: z.string().min(1) });
const verifyOtpBodySchema = z.object({ mobile: z.string().min(1), otp: z.string().min(1) });

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post('/auth/send-otp', async (req, reply) => {
    const parsed = sendOtpBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_REQUEST' });
    }

    const mobile = normalizePhone(parsed.data.mobile);
    if (!mobile) {
      return reply.code(400).send({ error: 'INVALID_MOBILE' });
    }

    const [mobileOk, ipOk] = await Promise.all([
      checkAndIncr(`ratelimit:otp:mobile:${mobile}`, MOBILE_RATE_LIMIT, MOBILE_RATE_WINDOW_SECONDS),
      checkAndIncr(`ratelimit:otp:ip:${req.ip}`, IP_RATE_LIMIT, IP_RATE_WINDOW_SECONDS),
    ]);

    if (!mobileOk || !ipOk) {
      return reply.code(429).send({ error: 'RATE_LIMITED' });
    }

    const otp = generateOtp();
    await storeOtp(mobile, otp);

    if (process.env.NODE_ENV === 'development') {
      app.log.info(`[dev-otp] ${mobile} -> ${otp}`);
    }

    const result = await sendOtp(app.tenantConfig, mobile, otp);
    if (!result.success) {
      app.log.error({ mobile }, 'send-otp: all delivery channels failed');
      return reply.code(502).send({ error: 'SEND_FAILED' });
    }

    return reply.code(200).send({ success: true, channel: result.channel });
  });

  app.post('/auth/verify-otp', async (req, reply) => {
    const parsed = verifyOtpBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_REQUEST' });
    }

    const mobile = normalizePhone(parsed.data.mobile);
    if (!mobile) {
      return reply.code(400).send({ error: 'INVALID_MOBILE' });
    }

    const result = await verifyStoredOtp(mobile, parsed.data.otp);

    if (result.status === 'EXPIRED') {
      return reply.code(410).send({ error: 'OTP_EXPIRED' });
    }
    if (result.status === 'LOCKED') {
      return reply.code(423).send({ error: 'LOCKED' });
    }
    if (result.status === 'INVALID') {
      return reply.code(401).send({ error: 'INVALID_OTP', attempts_remaining: result.attemptsRemaining });
    }

    const contact = await prisma.contact.findFirst({
      where: { OR: [{ mobileE164: mobile }, { altMobileE164: mobile }] },
    });

    if (!contact) {
      return reply.code(200).send({ token: null, status: 'NO_ACCOUNT' });
    }

    const jti = randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await prisma.session.create({ data: { contactId: contact.id, jti, expiresAt } });

    const token = await signSessionToken(contact.id, jti);

    return reply.code(200).send({
      token,
      contact: { id: contact.id, fullName: contact.fullName, email: contact.email },
    });
  });

  app.post('/auth/logout', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }

    let payload;
    try {
      payload = await verifySessionToken(authHeader.slice('Bearer '.length));
    } catch {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }

    await prisma.session.updateMany({
      where: { jti: payload.jti, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return reply.code(200).send({ success: true });
  });
}
