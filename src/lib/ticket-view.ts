import type { TenantConfig } from '../config/types.js';
import { readCustomField, type DeskTicket } from './zoho-desk-client.js';

// Desk renders an empty picklist/custom-field value as the literal string
// "-None-" rather than null/omitting the key — confirmed live across
// category and custom fields. Normalize it the same way everywhere so
// nothing downstream has to special-case the string.
function normalizeValue(value: string | null | undefined): string | null {
  if (!value || value === '-None-') {
    return null;
  }
  return value;
}

// Dependency-free plain-text conversion — the app only ever renders
// description as plain text (per product decision: strip server-side, keep
// the original HTML in the raw jsonb column for anyone who needs it later).
// Not a general-purpose HTML sanitizer; Desk's description field is
// operator-authored rich text, not untrusted external HTML.
export function stripHtmlToPlainText(html: string): string {
  const withBreaks = html.replace(/<\/(p|div|li|h[1-6])>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
  const withoutTags = withBreaks.replace(/<[^>]+>/g, '');
  const decoded = withoutTags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return decoded
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
}

export interface TicketFields {
  deskTicketId: string;
  ticketNumber: string;
  subject: string;
  description: string | null;
  category: string | null;
  status: string;
  statusDisplay: string;
  ownerName: string | null;
  coOwnerName: string | null;
  priority: string | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  syncedAt: Date;
  raw: DeskTicket;
}

/**
 * Maps a full Desk ticket (from getTicket — the list endpoint doesn't carry
 * enough fields, see zoho-desk-client.ts) to the shape written to the
 * `tickets` table. Shared by sync (ticket-batch.ts) and the
 * ticket-updated webhook so both stay byte-for-byte consistent.
 */
export function mapDeskTicketToFields(ticket: DeskTicket, tenantConfig: TenantConfig): TicketFields {
  const ownerName = ticket.assignee ? `${ticket.assignee.firstName ?? ''} ${ticket.assignee.lastName ?? ''}`.trim() || null : null;
  // Confirmed live: cf_co_owner holds a plain free-text name ("GANESH"), not
  // an agent-ID reference — so no agent lookup is needed here, unlike
  // ownerName above (which resolves via the embedded assignee object).
  const coOwnerName = normalizeValue(readCustomField(ticket, 'co_owner', 'CO-OWNER'));
  const status = ticket.status;
  const statusDisplay = tenantConfig.desk.status_display_map[status] ?? status;

  return {
    deskTicketId: ticket.id,
    ticketNumber: ticket.ticketNumber,
    subject: ticket.subject,
    description: ticket.description ? stripHtmlToPlainText(ticket.description) : null,
    category: normalizeValue(ticket.category),
    status,
    statusDisplay,
    ownerName,
    coOwnerName,
    priority: normalizeValue(ticket.priority),
    closedAt: ticket.closedTime ? new Date(ticket.closedTime) : null,
    createdAt: new Date(ticket.createdTime),
    updatedAt: new Date(ticket.modifiedTime),
    syncedAt: new Date(),
    raw: ticket,
  };
}

// Desk's own Open/On Hold/Closed classification, present directly on every
// ticket (confirmed live) — used instead of a tenant-configured
// closed_statuses list, since it doesn't drift when a tenant renames or adds
// a status value.
export function isTicketClosed(ticket: Pick<DeskTicket, 'statusType'>): boolean {
  return ticket.statusType === 'Closed';
}

export interface TicketLike {
  id: string;
  ticketNumber: string;
  subject: string;
  description: string | null;
  category: string | null;
  status: string;
  statusDisplay: string;
  ownerName: string | null;
  coOwnerName: string | null;
  priority: string | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  raw: unknown;
}

export interface TicketSummary {
  id: string;
  ticket_number: string;
  subject: string;
  description: string | null;
  category: string | null;
  status: string;
  status_display: string;
  owner_name: string | null;
  co_owner_name: string | null;
  priority: string | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  is_closed: boolean;
}

export function buildTicketSummary(ticket: TicketLike): TicketSummary {
  const raw = ticket.raw as Pick<DeskTicket, 'statusType'> | null;
  return {
    id: ticket.id,
    ticket_number: ticket.ticketNumber,
    subject: ticket.subject,
    description: ticket.description,
    category: ticket.category,
    status: ticket.status,
    status_display: ticket.statusDisplay,
    owner_name: ticket.ownerName,
    co_owner_name: ticket.coOwnerName,
    priority: ticket.priority,
    closed_at: ticket.closedAt,
    created_at: ticket.createdAt,
    updated_at: ticket.updatedAt,
    is_closed: raw ? isTicketClosed(raw) : false,
  };
}
