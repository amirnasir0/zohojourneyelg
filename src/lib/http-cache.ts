import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Payload-hash ETag, fine at this data scale (per-request SHA-256 of a small
 * JSON body is well under a millisecond). Honors If-None-Match with a 304
 * (empty body) so repeat opens cost ~0 bytes, per PRD §10.
 */
export function sendWithEtag(req: FastifyRequest, reply: FastifyReply, payload: unknown, cacheControl: string): unknown {
  const body = JSON.stringify(payload);
  const etag = `"${createHash('sha256').update(body).digest('hex')}"`;

  reply.header('ETag', etag);
  reply.header('Cache-Control', cacheControl);

  if (req.headers['if-none-match'] === etag) {
    return reply.code(304).send();
  }

  return reply.code(200).send(payload);
}
