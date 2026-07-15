import type { FastifyInstance } from 'fastify';
import { verifyWebhookSecret } from '../lib/webhook-auth.js';
import { handleContactUpdated } from '../webhooks/contact-updated.js';
import { handleJourneyUpdated } from '../webhooks/journey-updated.js';

export async function registerWebhookRoutes(app: FastifyInstance) {
  app.post('/webhooks/zoho/journey-updated', { preHandler: verifyWebhookSecret }, async (req, reply) => {
    try {
      const result = await handleJourneyUpdated(req.body, app.tenantConfig, app.zohoClient);
      return reply.code(result.status).send(result.body);
    } catch (err) {
      req.log.error({ err }, '[webhooks] journey-updated failed');
      return reply.code(500).send({ error: 'INTERNAL_ERROR' });
    }
  });

  app.post('/webhooks/zoho/contact-updated', { preHandler: verifyWebhookSecret }, async (req, reply) => {
    try {
      const result = await handleContactUpdated(req.body, app.tenantConfig, app.zohoClient);
      return reply.code(result.status).send(result.body);
    } catch (err) {
      req.log.error({ err }, '[webhooks] contact-updated failed');
      return reply.code(500).send({ error: 'INTERNAL_ERROR' });
    }
  });
}
