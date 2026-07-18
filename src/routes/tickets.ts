import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../lib/auth-middleware.js';
import { createTicketForContact } from '../lib/desk-contact-bridge.js';
import { getCurrentCategoryValues } from '../lib/desk-context.js';
import { sendWithEtag } from '../lib/http-cache.js';
import { prisma } from '../lib/prisma.js';
import { getCachedTickets, invalidateTicketsCache, setCachedTickets } from '../lib/tickets-cache.js';
import { buildTicketSummary, mapDeskTicketToFields, type TicketSummary } from '../lib/ticket-view.js';

interface CreateTicketBody {
  category?: unknown;
  description?: unknown;
  force?: unknown;
}

function isOpenTicket(raw: unknown): boolean {
  const statusType = (raw as { statusType?: string } | null)?.statusType;
  return statusType !== 'Closed';
}

export async function registerTicketRoutes(app: FastifyInstance) {
  app.get('/me/tickets/categories', { preHandler: requireAuth }, async (req, reply) => {
    if (!app.deskClient || !app.deskContext) {
      return reply.code(503).send({ error: 'DESK_UNAVAILABLE' });
    }

    const categories = await getCurrentCategoryValues(app.deskClient, app.tenantConfig, app.deskContext.categoryValues);
    return sendWithEtag(req, reply, { categories, response_time_copy: app.tenantConfig.desk.response_time_copy }, 'private, no-cache');
  });

  app.post('/me/tickets', { preHandler: requireAuth }, async (req, reply) => {
    if (!app.deskClient || !app.deskContext) {
      return reply.code(503).send({ error: 'DESK_UNAVAILABLE' });
    }

    const body = (req.body ?? {}) as CreateTicketBody;
    const category = typeof body.category === 'string' ? body.category.trim() : '';
    const description = typeof body.description === 'string' ? body.description : undefined;
    const force = body.force === true;

    // Same live (cached) source GET /me/tickets/categories serves, so a
    // category the customer was just shown always validates here too — the
    // two never disagree about what's currently valid in Desk.
    const currentCategories = await getCurrentCategoryValues(app.deskClient, app.tenantConfig, app.deskContext.categoryValues);
    if (!category || !currentCategories.includes(category)) {
      return reply.code(400).send({ error: 'INVALID_BODY', message: 'category must be one of the configured Desk category values' });
    }

    // The app's create-ticket screen collects category + an optional
    // description only — no separate subject/title field (confirmed
    // against the shipped RN client's CreateTicketRequest type, which
    // doesn't declare one). The category value doubles as the ticket
    // subject, matching Desk's own required `subject` field.
    const subject = category;

    const contact = await prisma.contact.findUnique({ where: { id: req.contactId } });
    if (!contact) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }

    if (!force) {
      const candidates = await prisma.ticket.findMany({ where: { contactId: contact.id, category } });
      const existingOpen = candidates.find((t) => isOpenTicket(t.raw));
      if (existingOpen) {
        return reply.code(409).send({ error: 'DUPLICATE_TICKET', existing_ticket: buildTicketSummary(existingOpen) });
      }
    }

    const created = await createTicketForContact(app.deskClient, contact, {
      departmentId: app.deskContext.departmentId,
      subject,
      category,
      ...(description ? { description } : {}),
    });

    // The create response's shape isn't guaranteed to match a full
    // getTicket() fetch (e.g. no confirmed ?include=assignee support on
    // create) — re-fetch so the stored row is byte-for-byte consistent with
    // what sync would have written for the same ticket.
    const full = (await app.deskClient.getTicket(created.id)) ?? created;
    const fields = mapDeskTicketToFields(full, app.tenantConfig);

    const ticket = await prisma.ticket.create({
      data: {
        deskTicketId: fields.deskTicketId,
        contactId: contact.id,
        ticketNumber: fields.ticketNumber,
        subject: fields.subject,
        description: fields.description,
        category: fields.category,
        status: fields.status,
        statusDisplay: fields.statusDisplay,
        ownerName: fields.ownerName,
        coOwnerName: fields.coOwnerName,
        priority: fields.priority,
        closedAt: fields.closedAt,
        createdAt: fields.createdAt,
        updatedAt: fields.updatedAt,
        syncedAt: fields.syncedAt,
        raw: fields.raw as object,
      },
    });

    await invalidateTicketsCache(contact.id);

    // The RN client reads the created ticket directly off the response body
    // (`body as CreateTicketResponse`), not wrapped under a `ticket` key —
    // confirmed against its api/tickets.ts. Matches the 409 conflict body's
    // existing_ticket, GET /me/tickets (bare array), and GET /me/tickets/:id
    // (bare object) — every ticket endpoint returns ticket data unwrapped.
    return reply.code(201).send(buildTicketSummary(ticket));
  });

  app.get('/me/tickets', { preHandler: requireAuth }, async (req, reply) => {
    let payload = await getCachedTickets<TicketSummary>(req.contactId);

    if (!payload) {
      const tickets = await prisma.ticket.findMany({ where: { contactId: req.contactId }, orderBy: { createdAt: 'desc' } });
      payload = tickets.map((t) => buildTicketSummary(t));
      await setCachedTickets(req.contactId, payload);
    }

    return sendWithEtag(req, reply, payload, 'private, no-cache');
  });

  app.get('/me/tickets/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const ticket = await prisma.ticket.findFirst({ where: { id, contactId: req.contactId } });
    if (!ticket) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }

    return sendWithEtag(req, reply, buildTicketSummary(ticket), 'private, no-cache');
  });
}
