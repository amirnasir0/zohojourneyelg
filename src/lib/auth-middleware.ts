import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifySessionToken } from './jwt.js';
import { prisma } from './prisma.js';

/**
 * Reusable Fastify preHandler for /me/* routes: verifies the RS256 JWT,
 * confirms the session (by jti) exists and hasn't been revoked, and attaches
 * contactId to the request. Every downstream query scopes on this value —
 * a resource that exists but belongs to someone else must still 404, never
 * 403 (never confirms existence to the wrong caller).
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'UNAUTHORIZED' });
    return;
  }

  let payload;
  try {
    payload = await verifySessionToken(authHeader.slice('Bearer '.length));
  } catch {
    reply.code(401).send({ error: 'UNAUTHORIZED' });
    return;
  }

  const session = await prisma.session.findUnique({ where: { jti: payload.jti } });
  if (!session || session.revokedAt) {
    reply.code(401).send({ error: 'UNAUTHORIZED' });
    return;
  }

  req.contactId = session.contactId;
}
