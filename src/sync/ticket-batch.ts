import { Prisma } from '@prisma/client';
import type { TenantConfig } from '../config/types.js';
import { invalidateTicketsCache } from '../lib/tickets-cache.js';
import { prisma } from '../lib/prisma.js';
import { mapDeskTicketToFields, type TicketFields } from '../lib/ticket-view.js';
import type { DeskTicket } from '../lib/zoho-desk-client.js';
import { withBatchRetry } from './with-retry.js';

export interface TicketBatchIssue {
  deskTicketId: string;
  field: string;
  rawValue: string;
  reason: string;
}

export interface TicketUpsertItem extends TicketFields {
  contactId: string;
}

export interface TicketBatchPlan {
  upserts: TicketUpsertItem[];
  issues: TicketBatchIssue[];
}

/**
 * Pure planning step: given full Desk tickets (post getTicket() detail
 * fetch — see ticket-phase.ts) and a map of deskContactId -> local
 * contact.id, resolves the contact link and decides what to upsert. A
 * ticket whose Desk contact isn't bridged to any local contact is logged as
 * an issue and skipped — the ticket module only tracks tickets belonging to
 * known app contacts (PRD §11.4), never creates orphan rows.
 */
export function planTicketBatch(
  tickets: DeskTicket[],
  tenantConfig: TenantConfig,
  contactIdByDeskContactId: ReadonlyMap<string, string>,
): TicketBatchPlan {
  const issues: TicketBatchIssue[] = [];
  const upserts: TicketUpsertItem[] = [];

  for (const ticket of tickets) {
    const contactId = contactIdByDeskContactId.get(ticket.contactId);
    if (!contactId) {
      issues.push({ deskTicketId: ticket.id, field: 'contactId', rawValue: ticket.contactId, reason: 'ORPHAN_TICKET' });
      continue;
    }
    upserts.push({ ...mapDeskTicketToFields(ticket, tenantConfig), contactId });
  }

  return { upserts, issues };
}

export interface TicketBatchResult {
  written: number;
  issues: number;
}

/**
 * Writes one batch of already-fetched full tickets: one bulk read to
 * resolve deskContactId -> local contact.id, then a single $transaction
 * covering the upserts, the issue createMany, AND any extraOps the caller
 * supplies (checkpoint update) — same shape as writeJourneyBatch.
 */
export async function writeTicketBatch(
  tickets: DeskTicket[],
  tenantConfig: TenantConfig,
  extraOps: Prisma.PrismaPromise<unknown>[] = [],
): Promise<TicketBatchResult> {
  const candidateDeskContactIds = new Set(tickets.map((t) => t.contactId));

  const contacts =
    candidateDeskContactIds.size > 0
      ? await withBatchRetry(() =>
          prisma.contact.findMany({
            where: { deskContactId: { in: [...candidateDeskContactIds] } },
            select: { id: true, deskContactId: true },
          }),
        )
      : [];
  const contactIdByDeskContactId = new Map(
    contacts.filter((c): c is typeof c & { deskContactId: string } => c.deskContactId !== null).map((c) => [c.deskContactId, c.id]),
  );

  const { upserts, issues } = planTicketBatch(tickets, tenantConfig, contactIdByDeskContactId);

  if (upserts.length > 0 || issues.length > 0 || extraOps.length > 0) {
    const upsertOps = upserts.map((item) =>
      prisma.ticket.upsert({
        where: { deskTicketId: item.deskTicketId },
        create: {
          deskTicketId: item.deskTicketId,
          contactId: item.contactId,
          ticketNumber: item.ticketNumber,
          subject: item.subject,
          description: item.description,
          category: item.category,
          status: item.status,
          statusDisplay: item.statusDisplay,
          ownerName: item.ownerName,
          coOwnerName: item.coOwnerName,
          priority: item.priority,
          closedAt: item.closedAt,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          syncedAt: item.syncedAt,
          raw: item.raw as unknown as Prisma.InputJsonValue,
        },
        update: {
          contactId: item.contactId,
          ticketNumber: item.ticketNumber,
          subject: item.subject,
          description: item.description,
          category: item.category,
          status: item.status,
          statusDisplay: item.statusDisplay,
          ownerName: item.ownerName,
          coOwnerName: item.coOwnerName,
          priority: item.priority,
          closedAt: item.closedAt,
          updatedAt: item.updatedAt,
          syncedAt: item.syncedAt,
          raw: item.raw as unknown as Prisma.InputJsonValue,
        },
      }),
    );

    const issueOps: Prisma.PrismaPromise<unknown>[] =
      issues.length > 0
        ? [
            prisma.syncIssue.createMany({
              data: issues.map((i) => ({ zohoRecordId: i.deskTicketId, recordType: 'ticket', field: i.field, rawValue: i.rawValue, reason: i.reason })),
              skipDuplicates: true,
            }),
          ]
        : [];

    await withBatchRetry(() => prisma.$transaction([...upsertOps, ...issueOps, ...extraOps]));

    const affectedContactIds = new Set(upserts.map((item) => item.contactId));
    await Promise.all([...affectedContactIds].map((id) => invalidateTicketsCache(id)));
  }

  return { written: upserts.length, issues: issues.length };
}
