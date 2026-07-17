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
 * Pure check, reusable outside the preHandler flow below — see
 * routes/webhooks.ts's ticket-updated registration for why: Desk's
 * webhook-URL handshake needs a 200 even when the secret is missing or
 * wrong, so that route checks this directly instead of using
 * verifyWebhookSecret (which always 401s on a bad secret, correct for the
 * other three CRM-Workflow-driven webhooks but not for Desk's handshake).
 */
export function isValidWebhookSecret(req: FastifyRequest): boolean {
  const expected = process.env.WEBHOOK_SECRET;
  if (!expected) {
    return false;
  }

  const query = req.query as Record<string, unknown>;
  const body = req.body as Record<string, unknown> | undefined;
  const provided = query?.secret ?? body?.secret;

  return typeof provided === 'string' && safeEqual(provided, expected);
}

/**
 * Shared-secret gate for Zoho webhook routes (no JWT here — Zoho Workflow
 * webhooks can't carry a bearer session). Accepts the secret as a query
 * param OR a JSON body field, since Zoho's Workflow webhook config UI
 * doesn't consistently support setting custom headers. Missing/mismatching
 * secret -> 401, logged.
 */
export async function verifyWebhookSecret(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (isValidWebhookSecret(req)) {
    return;
  }

  if (!process.env.WEBHOOK_SECRET) {
    req.log.error('[webhooks] WEBHOOK_SECRET not set — rejecting all webhook requests');
  } else {
    req.log.warn({ url: req.url }, '[webhooks] rejected: missing or mismatching secret');
  }
  reply.code(401).send({ error: 'UNAUTHORIZED' });
}
