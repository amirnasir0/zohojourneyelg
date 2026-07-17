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
    existing.priority !== incoming.priority
  );
}

/**
 * Same record-id-only contract as salesorder-updated.ts, fired from a Desk
 * automation (a separate UI from CRM Workflow Rules — see
 * docs/ZOHO-WEBHOOK-SETUP.md) on ticket field changes. No ticket-history
 * table exists (out of scope, per product decision) — idempotency here is
 * purely "diff before write, no-op if nothing changed," not a dedupe-key
 * insert like stage_history.
 */
export async function handleTicketUpdated(body: unknown, tenantConfig: TenantConfig, deskClient: ZohoDeskClient | undefined): Promise<WebhookResult> {
  const mapping = tenantConfig.webhooks.ticket_updated;
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const recordId = b[mapping.record_id_field];

  if (typeof recordId !== 'string' || !recordId) {
    return { status: 400, body: { error: 'INVALID_PAYLOAD' } };
  }

  if (!deskClient) {
    console.error(`[webhook ticket-updated] record ${recordId}: Zoho Desk client is unavailable (missing ZOHO_DESK_* env vars)`);
    return { status: 503, body: { error: 'DESK_CLIENT_UNAVAILABLE' } };
  }

  const fetched = await deskClient.getTicket(recordId);
  if (!fetched) {
    console.error(`[webhook ticket-updated] Zoho Desk ticket ${recordId} not found (404) — treating as no-op`);
    return { status: 200, body: { success: true, note: 'ticket not found in Zoho Desk' } };
  }

  const incoming = mapDeskTicketToFields(fetched, tenantConfig);

  const existing = await prisma.ticket.findUnique({ where: { deskTicketId: recordId } });

  if (!existing) {
    // Tickets only track known app contacts (PRD §11.4) — a ticket for a
    // Desk contact we've never bridged to a local Contact is a true no-op,
    // not an error; it simply isn't ours to track.
    const contact = await prisma.contact.findUnique({ where: { deskContactId: fetched.contactId } });
    if (!contact) {
      return { status: 200, body: { success: true, note: 'ticket belongs to an unknown contact, not tracked' } };
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
        createdAt: incoming.createdAt,
        updatedAt: incoming.updatedAt,
        syncedAt: incoming.syncedAt,
        raw: incoming.raw as unknown as Prisma.InputJsonValue,
      },
    });
    await invalidateTicketsCache(contact.id);
    return { status: 200, body: { success: true, changed: true } };
  }

  if (!fieldsChanged(existing, incoming)) {
    return { status: 200, body: { success: true, changed: false } };
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
      updatedAt: incoming.updatedAt,
      syncedAt: incoming.syncedAt,
      raw: incoming.raw as unknown as Prisma.InputJsonValue,
    },
  });

  await invalidateTicketsCache(existing.contactId);
  return { status: 200, body: { success: true, changed: true } };
}
