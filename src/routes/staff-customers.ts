import type { Contact, Journey } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TenantConfig } from '../config/types.js';
import { buildDocumentApprovals, buildDocumentChecklist } from '../lib/document-view.js';
import { findDocumentDef, pickUploadJourney, storeDocumentUpload } from '../lib/document-upload.js';
import { invalidateDocumentsCache } from '../lib/documents-cache.js';
import { buildJourneySummary, buildStageTimeline } from '../lib/journey-view.js';
import { prisma } from '../lib/prisma.js';
import { sendPushToContact } from '../lib/push-notifications.js';
import { requireManager, requireStaffAuth, seesAllCustomers } from '../lib/staff-auth-middleware.js';
import { extractCreatedTime, isDateDrivenJourney, resolveDateDrivenStage } from '../sync/date-stage-resolve.js';

type ContactWithJourneys = Contact & { journeys: Journey[] };

const reviewBodySchema = z
  .object({
    approved: z.boolean(),
    note: z.string().min(1).optional(),
  })
  // Same rule as the customer's own respond route: rejecting must always
  // carry a reason the customer can act on before re-uploading.
  .refine((data) => data.approved || !!data.note, { message: 'note is required when rejecting', path: ['note'] });

// Employees only see contacts whose journey Owner matches their own
// zoho_owner_id; admins and managers see everyone. Out-of-scope always 404s, never 403 —
// same "never confirm existence to the wrong caller" rule as customer routes.
function contactInScope(contact: ContactWithJourneys, staffRole: string, staffZohoOwnerId: string | null): boolean {
  if (seesAllCustomers(staffRole)) {
    return true;
  }
  if (!staffZohoOwnerId) {
    return false;
  }
  return contact.journeys.some((j) => j.ownerZohoId === staffZohoOwnerId);
}

function serializeCustomerSummary(contact: Contact) {
  return {
    id: contact.id,
    full_name: contact.fullName,
    mobile_e164: contact.mobileE164,
    email: contact.email,
    pending_customer_review: contact.pendingCustomerReview,
  };
}

export async function registerStaffCustomerRoutes(app: FastifyInstance) {
  app.get('/staff/customers', { preHandler: requireStaffAuth }, async (req, reply) => {
    const { search } = req.query as { search?: unknown };
    const searchTerm = typeof search === 'string' ? search.trim() : '';

    if (!seesAllCustomers(req.staffRole) && !req.staffZohoOwnerId) {
      // Employee account isn't mapped to a Zoho CRM owner yet — scoped to
      // nobody rather than erroring; an admin fixes this via PATCH /staff/users.
      return reply.code(200).send([]);
    }

    const contacts = await prisma.contact.findMany({
      where: {
        ...(!seesAllCustomers(req.staffRole) ? { journeys: { some: { ownerZohoId: req.staffZohoOwnerId } } } : {}),
        ...(searchTerm
          ? {
              OR: [
                { fullName: { contains: searchTerm, mode: 'insensitive' as const } },
                { mobileE164: { contains: searchTerm, mode: 'insensitive' as const } },
                { email: { contains: searchTerm, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { fullName: 'asc' },
    });

    return reply.code(200).send(contacts.map(serializeCustomerSummary));
  });

  app.get('/staff/customers/:contactId', { preHandler: requireStaffAuth }, async (req, reply) => {
    const { contactId } = req.params as { contactId: string };
    const contact = await prisma.contact.findUnique({ where: { id: contactId }, include: { journeys: true } });
    if (!contact || !contactInScope(contact, req.staffRole, req.staffZohoOwnerId)) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }

    return reply.code(200).send(serializeCustomerSummary(contact));
  });

  // Staff-scoped equivalent of GET /me/journeys/:id — same helpers, same
  // date-driven/stage-history branching, just resolved against whichever
  // journey this contact has instead of one the caller already owns.
  app.get('/staff/customers/:contactId/journey', { preHandler: requireStaffAuth }, async (req, reply) => {
    const { contactId } = req.params as { contactId: string };
    const contact = await prisma.contact.findUnique({ where: { id: contactId }, include: { journeys: true } });
    if (!contact || !contactInScope(contact, req.staffRole, req.staffZohoOwnerId)) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }

    if (contact.journeys.length === 0) {
      return reply.code(200).send({ has_journey: false });
    }

    let targetJourney = contact.journeys[0]!;
    if (contact.journeys.length > 1) {
      // Same ambiguity/resolution as the upload route — most-recently-synced
      // journey is the best guess for "the Sales Order currently active."
      targetJourney = [...contact.journeys].sort((a, b) => b.syncedAt.getTime() - a.syncedAt.getTime())[0]!;
      req.log.warn(
        { contactId: contact.id, journeyCount: contact.journeys.length, chosenJourneyId: targetJourney.id },
        '[staff-customers] contact has multiple journeys — showing the most recently synced one',
      );
    }

    const summary = buildJourneySummary(targetJourney, app.tenantConfig);
    if (!summary) {
      // "hidden"-type stage — same treatment as a nonexistent journey.
      return reply.code(200).send({ has_journey: false });
    }

    let stageTimeline: unknown[] = [];
    if (summary.status === 'in_progress') {
      if (isDateDrivenJourney(app.tenantConfig.journey.stages)) {
        const refValues = (targetJourney.refValues ?? {}) as Record<string, unknown>;
        const createdTime = extractCreatedTime(targetJourney.raw);
        stageTimeline = resolveDateDrivenStage(app.tenantConfig.journey.stages, refValues, createdTime).timeline;
      } else {
        const stageHistoryRows = await prisma.stageHistory.findMany({ where: { journeyId: targetJourney.id } });
        const changedAtByStage = new Map(stageHistoryRows.map((r) => [r.toStage, r.changedAt]));
        stageTimeline = buildStageTimeline(app.tenantConfig.journey.stages, summary.stage_index, changedAtByStage);
      }
    }

    const documentRows = await prisma.document.findMany({ where: { contactId: contact.id }, include: { reviewedBy: true } });

    return reply.code(200).send({
      has_journey: true,
      journey_name: summary.name,
      stage_index: summary.stage_index,
      total_stages: summary.total_stages,
      stage_timeline: stageTimeline,
      document_approvals: buildDocumentApprovals(app.tenantConfig, documentRows, true),
    });
  });

  app.get('/staff/customers/:contactId/documents', { preHandler: requireStaffAuth }, async (req, reply) => {
    const { contactId } = req.params as { contactId: string };
    const contact = await prisma.contact.findUnique({ where: { id: contactId }, include: { journeys: true } });
    if (!contact || !contactInScope(contact, req.staffRole, req.staffZohoOwnerId)) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }

    const rows = await prisma.document.findMany({ where: { contactId: contact.id } });
    return reply.code(200).send(buildDocumentChecklist(app.tenantConfig, rows, true));
  });

  app.post('/staff/customers/:contactId/documents/:key/upload', { preHandler: requireStaffAuth }, async (req, reply) => {
    const { contactId, key } = req.params as { contactId: string; key: string };

    const contact = await prisma.contact.findUnique({ where: { id: contactId }, include: { journeys: true } });
    if (!contact || !contactInScope(contact, req.staffRole, req.staffZohoOwnerId)) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }

    const documentDef = findDocumentDef(app.tenantConfig, key);
    if (!documentDef) {
      return reply.code(400).send({ error: 'INVALID_DOCUMENT_KEY' });
    }

    if (!app.zohoClient) {
      return reply.code(503).send({ error: 'ZOHO_CLIENT_UNAVAILABLE' });
    }

    const targetJourney = pickUploadJourney(contact, req.log);
    if (!targetJourney) {
      return reply.code(400).send({ error: 'NO_SALES_ORDER', message: 'contact has no synced sales order to attach documents to' });
    }

    const filePart = await req.file();
    if (!filePart) {
      return reply.code(400).send({ error: 'MISSING_FILE' });
    }
    const buffer = await filePart.toBuffer();

    const documentRow = await storeDocumentUpload({
      zohoClient: app.zohoClient,
      tenantConfig: app.tenantConfig,
      contact,
      journey: targetJourney,
      key,
      documentDef,
      file: { buffer, filename: filePart.filename, mimetype: filePart.mimetype },
      status: 'UPLOADED',
      uploadedById: req.staffId,
    });

    await invalidateDocumentsCache(contact.id);

    return reply.code(200).send({
      key: documentRow.documentKey,
      status: documentRow.status,
      file_name: documentRow.fileName,
      file_size: documentRow.fileSize,
      uploaded_at: documentRow.uploadedAt,
    });
  });

  app.post('/staff/customers/:contactId/documents/submit-for-review', { preHandler: requireStaffAuth }, async (req, reply) => {
    const { contactId } = req.params as { contactId: string };
    const contact = await prisma.contact.findUnique({ where: { id: contactId }, include: { journeys: true } });
    if (!contact || !contactInScope(contact, req.staffRole, req.staffZohoOwnerId)) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }

    const rows = await prisma.document.findMany({ where: { contactId: contact.id } });
    const checklist = buildDocumentChecklist(app.tenantConfig, rows, false);

    // REJECTED blocks resubmission the same as NOT_UPLOADED — a document
    // the customer sent back must be re-uploaded (which resets it to
    // UPLOADED) before the batch can go back for review.
    const missing = checklist
      .filter((group) => group.requires_approval)
      .flatMap((group) =>
        group.documents
          .filter((d) => d.status === 'NOT_UPLOADED' || d.status === 'REJECTED')
          .map((d) => ({ key: d.key, display_name: d.display_name })),
      );

    if (missing.length > 0) {
      return reply.code(400).send({ error: 'MISSING_DOCUMENTS', missing });
    }

    const requiresApprovalGroupKeys = new Set(app.tenantConfig.documents.stage_groups.filter((g) => g.requires_approval).map((g) => g.stage_group_key));
    const idsToSubmit = rows.filter((r) => r.status === 'UPLOADED' && requiresApprovalGroupKeys.has(r.stageGroupKey)).map((r) => r.id);

    await prisma.$transaction([
      prisma.document.updateMany({ where: { id: { in: idsToSubmit } }, data: { status: 'SUBMITTED_FOR_REVIEW' } }),
      prisma.contact.update({ where: { id: contact.id }, data: { pendingCustomerReview: true } }),
    ]);

    await invalidateDocumentsCache(contact.id);

    // Best-effort — sendPushToContact never throws, so a push failure
    // (no registered device, Expo API hiccup) never turns a successful
    // submit-for-review into an error response.
    void sendPushToContact(contact.id, 'Documents ready for review', 'Please review and approve your submitted documents.', {
      screen: 'documents',
    });

    return reply.code(200).send({ success: true });
  });

  // Manager queue: every customer-uploaded document still awaiting a
  // decision, oldest first so nothing sits at the bottom forever.
  app.get('/staff/approvals', { preHandler: requireManager }, async (_req, reply) => {
    const rows = await prisma.document.findMany({
      where: { status: 'PENDING_APPROVAL' },
      include: { contact: true },
      orderBy: { uploadedAt: 'asc' },
    });
    const displayNameByKey = new Map(app.tenantConfig.documents.stage_groups.flatMap((g) => g.documents.map((d) => [d.key, d.display_name] as const)));

    return reply.code(200).send(
      rows
        .filter((r) => displayNameByKey.has(r.documentKey))
        .map((r) => ({
          contact_id: r.contactId,
          customer_name: r.contact.fullName,
          mobile_e164: r.contact.mobileE164,
          key: r.documentKey,
          display_name: displayNameByKey.get(r.documentKey)!,
          file_name: r.fileName,
          file_size: r.fileSize,
          uploaded_at: r.uploadedAt,
          zoho_attachment_id: r.zohoAttachmentId,
        })),
    );
  });

  app.post('/staff/customers/:contactId/documents/:key/review', { preHandler: requireManager }, async (req, reply) => {
    const { contactId, key } = req.params as { contactId: string; key: string };
    const parsed = reviewBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_REQUEST' });
    }

    const documentRow = await prisma.document.findUnique({ where: { contactId_documentKey: { contactId, documentKey: key } } });
    if (!documentRow) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }
    if (documentRow.status !== 'PENDING_APPROVAL') {
      return reply.code(409).send({ error: 'NOT_PENDING_APPROVAL' });
    }

    const updated = await prisma.document.update({
      where: { id: documentRow.id },
      data: {
        status: parsed.data.approved ? 'APPROVED' : 'REJECTED',
        reviewedAt: new Date(),
        reviewedById: req.staffId,
        reviewNote: parsed.data.note ?? null,
      },
    });

    await invalidateDocumentsCache(contactId);

    const documentDef = findDocumentDef(app.tenantConfig, key);
    const displayName = documentDef?.displayName ?? 'Your document';
    // Best-effort, same as submit-for-review — never fails the review.
    void sendPushToContact(
      contactId,
      parsed.data.approved ? 'Document approved' : 'Document needs attention',
      parsed.data.approved ? `${displayName} has been approved.` : `${displayName} was not approved: ${parsed.data.note}`,
      { screen: 'documents' },
    );

    return reply.code(200).send({
      key: updated.documentKey,
      status: updated.status,
      reviewed_at: updated.reviewedAt,
      review_note: updated.reviewNote,
    });
  });
}
