import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from './prisma.js';
import { verifyStaffSessionToken } from './staff-jwt.js';

/**
 * Mirrors requireAuth (auth-middleware.ts) exactly — bearer parse, verify,
 * session lookup, revoked check — but against StaffSession/StaffUser
 * instead of Session/Contact, and additionally rejects a deactivated staff
 * account even if their session/JWT hasn't otherwise expired (an admin
 * setting `active: false` should take effect immediately, not just block
 * future logins).
 */
export async function requireStaffAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'UNAUTHORIZED' });
    return;
  }

  let payload;
  try {
    payload = await verifyStaffSessionToken(authHeader.slice('Bearer '.length));
  } catch {
    reply.code(401).send({ error: 'UNAUTHORIZED' });
    return;
  }

  const session = await prisma.staffSession.findUnique({ where: { jti: payload.jti }, include: { staff: true } });
  if (!session || session.revokedAt || !session.staff.active) {
    reply.code(401).send({ error: 'UNAUTHORIZED' });
    return;
  }

  req.staffId = session.staffId;
  req.staffRole = session.staff.role;
}

/**
 * Role gate for admin-only routes (user management). Unlike customer
 * resource-scoping (which always 404s, never 403 — see auth-middleware.ts),
 * this is a genuine "you lack this role" case: 403 doesn't leak anything a
 * staff member shouldn't already know (that admin-only endpoints exist).
 */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireStaffAuth(req, reply);
  if (reply.sent) {
    return;
  }
  if (req.staffRole !== 'ADMIN') {
    reply.code(403).send({ error: 'FORBIDDEN' });
  }
}
