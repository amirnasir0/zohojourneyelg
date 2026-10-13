import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizePhone } from '../lib/phone.js';
import { verifySessionToken, signSessionToken } from '../lib/jwt.js';
import { sendOtp } from '../lib/otp-providers/index.js';
import { generateOtp, storeOtp, verifyStoredOtp } from '../lib/otp-store.js';
import { prisma } from '../lib/prisma.js';
import { checkAndIncr } from '../lib/rate-limit.js';
import { REVIEW_DEMO_ZOHO_CONTACT_ID } from '../lib/review-account.js';

const MOBILE_RATE_LIMIT = 3;
const MOBILE_RATE_WINDOW_SECONDS = 15 * 60;
const IP_RATE_LIMIT = 10;
const IP_RATE_WINDOW_SECONDS = 60 * 60;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const sendOtpBodySchema = z.object({ mobile: z.string().min(1) });
const verifyOtpBodySchema = z.object({ mobile: z.string().min(1), otp: z.string().min(1) });

// TEMPORARY support/debug tool — lets UNIVERSAL_TEST_OTP log into ANY
// customer's account without their real OTP, so support can look up a real
// account's data without waiting on the customer. Hard-expires below as a
// backstop in case the env var itself is never unset. Remove this whole
// block (and the env var) once the testing window is over — do not extend
// the expiry in place of an explicit decision to keep it.
const UNIVERSAL_TEST_OTP_EXPIRY = new Date('2026-08-16T00:00:00Z');

// Play/App Store reviewer login (REVIEW_PHONE/REVIEW_OTP) — unlike
// UNIVERSAL_TEST_OTP above (which logs into ANY real customer's account and
// hard-expires), this is scoped to exactly one fixed number, logs into one
// dedicated non-real demo Contact (never resolved by mobile-number lookup —
// see review-account.ts for why), and never expires on its own: it's purely
// env-var gated, per the explicit requirement to be able to turn it off
// later without a new deploy. Both values are expected already-normalized
// E.164 (e.g. "+919999999999") — compared with strict equality against the
// already-normalized `mobile` variable below, no re-normalization needed.
const REVIEW_PHONE = process.env.REVIEW_PHONE;
const REVIEW_OTP = process.env.REVIEW_OTP;

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

    // Never sends a real OTP for the reviewer number: no Interakt WhatsApp,
    // no SMS fallback, no rate-limit bookkeeping (a reviewer retrying the
    // login flow repeatedly during a multi-day review must never get
    // rate-limited), and no write to the real OTP store at all.
    if (REVIEW_PHONE && mobile === REVIEW_PHONE) {
      return reply.code(200).send({ success: true, channel: 'whatsapp' });
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

  async function issueSessionForMobile(mobile: string) {
    const contact = await prisma.contact.findFirst({
      where: { OR: [{ mobileE164: mobile }, { altMobileE164: mobile }] },
    });

    if (!contact) {
      return { token: null, status: 'NO_ACCOUNT' as const };
    }

    const jti = randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await prisma.session.create({ data: { contactId: contact.id, jti, expiresAt } });

    const token = await signSessionToken(contact.id, jti);

    return { token, contact: { id: contact.id, fullName: contact.fullName, email: contact.email } };
  }

  // Resolved by the hardcoded sentinel zohoContactId, NEVER by mobile
  // number — REVIEW_PHONE can (and for Elgris, already does) collide with a
  // real synced customer's mobile number, so issueSessionForMobile's
  // lookup-by-mobile would log the reviewer into a real account instead of
  // the dedicated demo one. Fails closed (NO_ACCOUNT) if the seed script
  // hasn't been run yet, rather than crashing.
  async function issueSessionForReviewAccount() {
    const contact = await prisma.contact.findUnique({ where: { zohoContactId: REVIEW_DEMO_ZOHO_CONTACT_ID } });
    if (!contact) {
      return { token: null, status: 'NO_ACCOUNT' as const };
    }

    const jti = randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await prisma.session.create({ data: { contactId: contact.id, jti, expiresAt } });

    const token = await signSessionToken(contact.id, jti);

    return { token, contact: { id: contact.id, fullName: contact.fullName, email: contact.email } };
  }

  app.post('/auth/verify-otp', async (req, reply) => {
    const parsed = verifyOtpBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_REQUEST' });
    }

    const mobile = normalizePhone(parsed.data.mobile);
    if (!mobile) {
      return reply.code(400).send({ error: 'INVALID_MOBILE' });
    }

    if (REVIEW_PHONE && REVIEW_OTP && mobile === REVIEW_PHONE && parsed.data.otp === REVIEW_OTP) {
      app.log.info({ mobile }, '[review-account] reviewer login');
      return reply.code(200).send(await issueSessionForReviewAccount());
    }

    const bypassCode = process.env.UNIVERSAL_TEST_OTP;
    if (bypassCode && parsed.data.otp === bypassCode && new Date() < UNIVERSAL_TEST_OTP_EXPIRY) {
      app.log.warn({ mobile, time: new Date().toISOString() }, '[universal-test-otp] bypass used');
      return reply.code(200).send(await issueSessionForMobile(mobile));
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

    return reply.code(200).send(await issueSessionForMobile(mobile));
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
