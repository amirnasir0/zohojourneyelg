import type { FastifyInstance } from 'fastify';
import { verifyWebhookSecret } from '../lib/webhook-auth.js';
import { handleContactUpdated } from '../webhooks/contact-updated.js';
import { handleJourneyUpdated } from '../webhooks/journey-updated.js';
import { handleSalesOrderUpdated } from '../webhooks/salesorder-updated.js';

export async function registerWebhookRoutes(app: FastifyInstance) {
  // Deals-Stage-driven — kept for tenants configured that way, but inactive
  // for Elgris under the current Sales_Orders-based journey config. See
  // docs/ZOHO-WEBHOOK-SETUP.md.
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

  // Date-driven journey source (Elgris's Sales_Orders) — see
  // src/webhooks/salesorder-updated.ts.
  app.post('/webhooks/zoho/salesorder-updated', { preHandler: verifyWebhookSecret }, async (req, reply) => {
    try {
      const result = await handleSalesOrderUpdated(req.body, app.tenantConfig, app.zohoClient);
      return reply.code(result.status).send(result.body);
    } catch (err) {
      req.log.error({ err }, '[webhooks] salesorder-updated failed');
      return reply.code(500).send({ error: 'INTERNAL_ERROR' });
    }
  });
}
