import { Prisma } from '@prisma/client';
import type { TenantConfig } from '../config/types.js';
import { prisma } from '../lib/prisma.js';
import { invalidateTicketsCache } from '../lib/tickets-cache.js';
import { mapDeskTicketToFields } from '../lib/ticket-view.js';
import type { ZohoDeskClient } from '../lib/zoho-desk-client.js';
import type { WebhookResult } from './types.js';

interface ComparableTicketFields {
  subject: string;
  description: string | null;
  category: string | null;
  status: string;
  statusDisplay: string;
  ownerName: string | null;
  coOwnerName: string | null;
  priority: string | null;
  closedAt: Date | null;
}

function fieldsChanged(existing: ComparableTicketFields, incoming: ComparableTicketFields): boolean {
  return (
    existing.subject !== incoming.subject ||
    existing.description !== incoming.description ||
    existing.category !== incoming.category ||
    existing.status !== incoming.status ||
    existing.statusDisplay !== incoming.statusDisplay ||
    existing.ownerName !== incoming.ownerName ||
    existing.coOwnerName !== incoming.coOwnerName ||
    existing.priority !== incoming.priority ||
    existing.closedAt?.getTime() !== incoming.closedAt?.getTime()
  );
}

// Desk's event-subscription webhooks (Setup → Automation → Webhooks) send a
// fixed envelope Zoho defines, unlike the CRM Workflow-Rule webhooks
// elsewhere in this app (journey-updated, contact-updated,
// salesorder-updated), where WE choose the JSON body shape via tenant
// config. Confirmed against Zoho's docs
// (desk.zoho.com/support/WebhookDocument.do#EventsSupported): a delivery is
// a JSON ARRAY of events — Desk batches multiple events into one delivery —
// each shaped `{ eventType, payload, prevState?, eventTime, orgId }`, with
// the ticket ID at `payload.id`. tenantConfig.webhooks.ticket_updated's
// record_id_field is intentionally NOT consulted here — there's no tenant
// choice to make about an envelope shape Zoho itself fixes; that config key
// stays in the schema only because the other three webhooks still need it.
interface DeskWebhookEvent {
  eventType?: unknown;
  payload?: ({ id?: unknown } & Record<string, unknown>) | undefined;
}

const HANDLED_EVENT_TYPES = new Set(['Ticket_Add', 'Ticket_Update']);

function parseEvents(body: unknown): DeskWebhookEvent[] | null {
  if (Array.isArray(body)) {
    return body as DeskWebhookEvent[];
  }
  if (typeof body === 'object' && body !== null) {
    return [body as DeskWebhookEvent];
  }
  return null;
}

/**
 * Handles one event from the batch. Always re-fetches the ticket by ID via
 * getTicket() rather than trusting the embedded event payload — keeps this
 * on the exact same fetch-by-ID + diff-before-write path as sync and every
 * other webhook in this app, and sidesteps needing to separately confirm
 * that Desk's webhook-event ticket serialization matches the REST
 * getTicket() shape mapDeskTicketToFields() already parses (one source of
 * truth for "what does a ticket look like" either way). No ticket-history
 * table exists (out of scope, per product decision) — idempotency here is
 * purely diff-then-no-op, not a dedupe-key insert like stage_history.
 */
async function processTicketEvent(event: DeskWebhookEvent, tenantConfig: TenantConfig, deskClient: ZohoDeskClient): Promise<Record<string, unknown>> {
  const eventType = typeof event.eventType === 'string' ? event.eventType : null;

  if (!eventType || !HANDLED_EVENT_TYPES.has(eventType)) {
    return { event_type: eventType, ignored: true };
  }

  const recordId = typeof event.payload?.id === 'string' ? event.payload.id : null;
  if (!recordId) {
    console.error(`[webhook ticket-updated] ${eventType} event missing payload.id — skipping`);
    return { event_type: eventType, note: 'missing payload.id' };
  }

  const fetched = await deskClient.getTicket(recordId);
  if (!fetched) {
    console.error(`[webhook ticket-updated] Zoho Desk ticket ${recordId} not found (404) — treating as no-op`);
    return { event_type: eventType, record_id: recordId, note: 'ticket not found in Zoho Desk' };
  }

  const incoming = mapDeskTicketToFields(fetched, tenantConfig);
  const existing = await prisma.ticket.findUnique({ where: { deskTicketId: recordId } });

  if (!existing) {
    // Tickets only track known app contacts (PRD §11.4) — a ticket for a
    // Desk contact we've never bridged to a local Contact is a true no-op,
    // not an error; it simply isn't ours to track.
    const contact = await prisma.contact.findUnique({ where: { deskContactId: fetched.contactId } });
    if (!contact) {
      return { event_type: eventType, record_id: recordId, note: 'ticket belongs to an unknown contact, not tracked' };
    }

    await prisma.ticket.create({
      data: {
        deskTicketId: incoming.deskTicketId,
        contactId: contact.id,
        ticketNumber: incoming.ticketNumber,
        subject: incoming.subject,
        description: incoming.description,
        category: incoming.category,
        status: incoming.status,
        statusDisplay: incoming.statusDisplay,
        ownerName: incoming.ownerName,
        coOwnerName: incoming.coOwnerName,
        priority: incoming.priority,
        closedAt: incoming.closedAt,
        createdAt: incoming.createdAt,
        updatedAt: incoming.updatedAt,
        syncedAt: incoming.syncedAt,
        raw: incoming.raw as unknown as Prisma.InputJsonValue,
      },
    });
    await invalidateTicketsCache(contact.id);
    return { event_type: eventType, record_id: recordId, changed: true };
  }

  if (!fieldsChanged(existing, incoming)) {
    return { event_type: eventType, record_id: recordId, changed: false };
  }

  await prisma.ticket.update({
    where: { id: existing.id },
    data: {
      ticketNumber: incoming.ticketNumber,
      subject: incoming.subject,
      description: incoming.description,
      category: incoming.category,
      status: incoming.status,
      statusDisplay: incoming.statusDisplay,
      ownerName: incoming.ownerName,
      coOwnerName: incoming.coOwnerName,
      priority: incoming.priority,
      closedAt: incoming.closedAt,
      updatedAt: incoming.updatedAt,
      syncedAt: incoming.syncedAt,
      raw: incoming.raw as unknown as Prisma.InputJsonValue,
    },
  });

  await invalidateTicketsCache(existing.contactId);
  return { event_type: eventType, record_id: recordId, changed: true };
}

export async function handleTicketUpdated(body: unknown, tenantConfig: TenantConfig, deskClient: ZohoDeskClient | undefined): Promise<WebhookResult> {
  const events = parseEvents(body);
  if (!events) {
    return { status: 400, body: { error: 'INVALID_PAYLOAD' } };
  }

  if (!deskClient) {
    console.error('[webhook ticket-updated] Zoho Desk client is unavailable (missing ZOHO_DESK_* env vars)');
    return { status: 503, body: { error: 'DESK_CLIENT_UNAVAILABLE' } };
  }

  const results: Record<string, unknown>[] = [];
  for (const event of events) {
    results.push(await processTicketEvent(event, tenantConfig, deskClient));
  }

  return { status: 200, body: { success: true, processed: results.length, results } };
}
