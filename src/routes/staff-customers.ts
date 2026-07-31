import type { Contact, Journey } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import type { TenantConfig } from '../config/types.js';
import { buildDocumentChecklist } from '../lib/document-view.js';
import { invalidateDocumentsCache } from '../lib/documents-cache.js';
import { prisma } from '../lib/prisma.js';
import { sendPushToContact } from '../lib/push-notifications.js';
import { requireStaffAuth } from '../lib/staff-auth-middleware.js';

type ContactWithJourneys = Contact & { journeys: Journey[] };

// Employees only see contacts whose journey Owner matches their own
// zoho_owner_id; admins see everyone. Out-of-scope always 404s, never 403 —
// same "never confirm existence to the wrong caller" rule as customer routes.
function contactInScope(contact: ContactWithJourneys, staffRole: string, staffZohoOwnerId: string | null): boolean {
  if (staffRole === 'ADMIN') {
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

function findDocumentDef(
  tenantConfig: TenantConfig,
  key: string,
): { stageGroupKey: string; requiresApproval: boolean; displayName: string } | undefined {
  for (const group of tenantConfig.documents.stage_groups) {
    const doc = group.documents.find((d) => d.key === key);
    if (doc) {
      return { stageGroupKey: group.stage_group_key, requiresApproval: group.requires_approval, displayName: doc.display_name };
    }
  }
  return undefined;
}

const MAX_ATTACHMENT_NAME_LENGTH = 150;

function sanitizeFilenamePart(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9 ._-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(filename);
  return match?.[1] ? match[1].toLowerCase() : '';
}

// The Zoho attachment name is constructed server-side rather than trusting
// the client-supplied filename — staff/CRM users looking at a Sales Order's
// attachment list should be able to tell what a document is and whose it is
// at a glance ("Electricity Bill - Rekha Gaikwad (v1).pdf"), not "IMG_4821.pdf".
// The version number is always included, even for the first upload, so
// every attachment for a given document_key follows one consistent pattern
// rather than "no marker" silently meaning "there's only one." The original
// client filename is still kept as-is in the Document row's file_name
// column, for the app's own display purposes. A re-upload never overwrites
// or deletes a prior version in Zoho — see DocumentVersion.
function buildAttachmentFilename(displayName: string, contactFullName: string | null, clientFilename: string, versionNumber: number): string {
  const ext = extensionOf(clientFilename);
  const namePart = sanitizeFilenamePart(`${displayName} - ${contactFullName ?? 'Customer'}`).slice(0, MAX_ATTACHMENT_NAME_LENGTH) || 'document';
  const versioned = `${namePart} (v${versionNumber})`;
  return ext ? `${versioned}.${ext}` : versioned;
}

export async function registerStaffCustomerRoutes(app: FastifyInstance) {
  app.get('/staff/customers', { preHandler: requireStaffAuth }, async (req, reply) => {
    const { search } = req.query as { search?: unknown };
    const searchTerm = typeof search === 'string' ? search.trim() : '';

    if (req.staffRole !== 'ADMIN' && !req.staffZohoOwnerId) {
      // Employee account isn't mapped to a Zoho CRM owner yet — scoped to
      // nobody rather than erroring; an admin fixes this via PATCH /staff/users.
      return reply.code(200).send([]);
    }

    const contacts = await prisma.contact.findMany({
      where: {
        ...(req.staffRole !== 'ADMIN' ? { journeys: { some: { ownerZohoId: req.staffZohoOwnerId } } } : {}),
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

    if (contact.journeys.length === 0) {
      return reply.code(400).send({ error: 'NO_SALES_ORDER', message: 'contact has no synced sales order to attach documents to' });
    }

    let targetJourney = contact.journeys[0]!;
    if (contact.journeys.length > 1) {
      // Real ambiguity, not just a silent default — logged at WARN so it's
      // noticeable in practice, per explicit product direction. Doesn't
      // hard-fail: the most-recently-synced journey is the best available
      // guess for "the Sales Order this customer is actively working."
      targetJourney = [...contact.journeys].sort((a, b) => b.syncedAt.getTime() - a.syncedAt.getTime())[0]!;
      req.log.warn(
        { contactId: contact.id, journeyCount: contact.journeys.length, chosenJourneyId: targetJourney.id },
        '[staff-customers] contact has multiple journeys — uploading to the most recently synced one',
      );
    }

    const filePart = await req.file();
    if (!filePart) {
      return reply.code(400).send({ error: 'MISSING_FILE' });
    }
    const buffer = await filePart.toBuffer();

    // A re-upload never overwrites or deletes the previous version in
    // Zoho — each upload lands as its own distinctly-numbered attachment,
    // with the full history preserved in DocumentVersion. The Document row
    // itself still just holds "current" state (unchanged by this).
    const existingDocument = await prisma.document.findUnique({
      where: { contactId_documentKey: { contactId: contact.id, documentKey: key } },
    });
    const nextVersionNumber = existingDocument ? (await prisma.documentVersion.count({ where: { documentId: existingDocument.id } })) + 1 : 1;

    const attachmentFilename = buildAttachmentFilename(documentDef.displayName, contact.fullName, filePart.filename, nextVersionNumber);

    const uploaded = await app.zohoClient.uploadAttachment(app.tenantConfig.zoho.journey_module, targetJourney.zohoRecordId, {
      buffer,
      filename: attachmentFilename,
      contentType: filePart.mimetype,
    });

    const documentRow = await prisma.document.upsert({
      where: { contactId_documentKey: { contactId: contact.id, documentKey: key } },
      create: {
        contactId: contact.id,
        journeyId: targetJourney.id,
        documentKey: key,
        stageGroupKey: documentDef.stageGroupKey,
        fileName: filePart.filename,
        fileSize: buffer.length,
        zohoAttachmentId: uploaded.id,
        status: 'UPLOADED',
        uploadedById: req.staffId,
        uploadedAt: new Date(),
      },
      update: {
        journeyId: targetJourney.id,
        fileName: filePart.filename,
        fileSize: buffer.length,
        zohoAttachmentId: uploaded.id,
        status: 'UPLOADED',
        uploadedById: req.staffId,
        uploadedAt: new Date(),
        reviewedAt: null,
        reviewNote: null,
      },
    });

    await prisma.documentVersion.create({
      data: {
        documentId: documentRow.id,
        versionNumber: nextVersionNumber,
        fileName: filePart.filename,
        fileSize: buffer.length,
        zohoAttachmentId: uploaded.id,
        uploadedById: req.staffId,
        uploadedAt: documentRow.uploadedAt ?? new Date(),
      },
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
}
