import type { FastifyInstance } from 'fastify';
import { isValidWebhookSecret, verifyWebhookSecret } from '../lib/webhook-auth.js';
import { handleContactUpdated } from '../webhooks/contact-updated.js';
import { handleJourneyUpdated } from '../webhooks/journey-updated.js';
import { handleSalesOrderUpdated } from '../webhooks/salesorder-updated.js';
import { handleTicketUpdated } from '../webhooks/ticket-updated.js';

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

  // Fired from Desk's event-subscription webhook (Setup → Automation →
  // Webhooks — see src/webhooks/ticket-updated.ts and
  // docs/ZOHO-WEBHOOK-SETUP.md's Rule 4). Desk's webhook-URL validator sends
  // a handshake request when the URL is entered/saved and requires an
  // immediate 200 — a 401 (bad/missing secret) or 400 (unrecognized body,
  // which the handshake's probe payload will be) gets reported back to the
  // admin as "invalid URL," even though the webhook itself is fine. So this
  // route deliberately never returns a non-200 for a secret mismatch or an
  // unrecognized payload shape — those are silent no-ops — while still
  // requiring BOTH to be valid before touching the DB. A genuine processing
  // failure once both checks pass (Desk client not configured) still 503s
  // normally: that's a real operational problem, not a handshake probe.
  const ticketUpdatedNoOp = (note: string) => ({ status: 200, body: { success: true, note } });

  app.get('/webhooks/zoho/ticket-updated', async (_req, reply) => reply.code(200).send({ success: true }));
  app.head('/webhooks/zoho/ticket-updated', async (_req, reply) => reply.code(200).send());

  app.post('/webhooks/zoho/ticket-updated', async (req, reply) => {
    if (!isValidWebhookSecret(req)) {
      req.log.info({ url: req.url }, '[webhooks] ticket-updated: probe or invalid-secret request, replying 200 no-op');
      const { status, body } = ticketUpdatedNoOp('ignored: invalid or missing secret');
      return reply.code(status).send(body);
    }

    try {
      const result = await handleTicketUpdated(req.body, app.tenantConfig, app.deskClient);
      if (result.status === 400) {
        // Secret was valid but the body isn't a recognizable Desk event
        // envelope — almost certainly the handshake's probe payload rather
        // than a real delivery, since real deliveries always match the
        // documented envelope. Same never-4xx-this-route treatment.
        req.log.info({ url: req.url }, '[webhooks] ticket-updated: unrecognized payload shape, replying 200 no-op');
        const { status, body } = ticketUpdatedNoOp('ignored: unrecognized payload shape');
        return reply.code(status).send(body);
      }
      return reply.code(result.status).send(result.body);
    } catch (err) {
      req.log.error({ err }, '[webhooks] ticket-updated failed');
      return reply.code(500).send({ error: 'INTERNAL_ERROR' });
    }
  });
}
