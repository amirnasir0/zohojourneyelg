import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Shared-secret gate for Zoho webhook routes (no JWT here — Zoho Workflow
 * webhooks can't carry a bearer session). Accepts the secret as a query
 * param OR a JSON body field, since Zoho's Workflow webhook config UI
 * doesn't consistently support setting custom headers. Missing/mismatching
 * secret -> 401, logged.
 */
export async function verifyWebhookSecret(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const expected = process.env.WEBHOOK_SECRET;
  if (!expected) {
    req.log.error('[webhooks] WEBHOOK_SECRET not set — rejecting all webhook requests');
    reply.code(401).send({ error: 'UNAUTHORIZED' });
    return;
  }

  const query = req.query as Record<string, unknown>;
  const body = req.body as Record<string, unknown> | undefined;
  const provided = query?.secret ?? body?.secret;

  if (typeof provided !== 'string' || !safeEqual(provided, expected)) {
    req.log.warn({ url: req.url }, '[webhooks] rejected: missing or mismatching secret');
    reply.code(401).send({ error: 'UNAUTHORIZED' });
    return;
  }
}
