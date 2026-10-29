import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../lib/auth-middleware.js';
import { findDocumentDef, pickUploadJourney, storeDocumentUpload } from '../lib/document-upload.js';
import { buildDocumentChecklist, type DocumentStageGroupView } from '../lib/document-view.js';
import { getCachedDocuments, invalidateDocumentsCache, setCachedDocuments } from '../lib/documents-cache.js';
import { sendWithEtag } from '../lib/http-cache.js';
import { prisma } from '../lib/prisma.js';

const respondBodySchema = z
  .object({
    approved: z.boolean(),
    note: z.string().min(1).optional(),
  })
  // Approving needs no note; rejecting must always carry a reason the
  // staff member can act on — per explicit product decision.
  .refine((data) => data.approved || !!data.note, { message: 'note is required when rejecting', path: ['note'] });

export async function registerDocumentRoutes(app: FastifyInstance) {
  app.get('/me/documents', { preHandler: requireAuth }, async (req, reply) => {
    let payload = await getCachedDocuments<DocumentStageGroupView[]>(req.contactId);

    if (!payload) {
      const rows = await prisma.document.findMany({ where: { contactId: req.contactId } });
      payload = buildDocumentChecklist(app.tenantConfig, rows, false);
      await setCachedDocuments(req.contactId, payload);
    }

    return sendWithEtag(req, reply, payload, 'private, no-cache');
  });

  app.post('/me/documents/:key/respond', { preHandler: requireAuth }, async (req, reply) => {
    const { key } = req.params as { key: string };
    const parsed = respondBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_REQUEST' });
    }

    const documentRow = await prisma.document.findUnique({ where: { contactId_documentKey: { contactId: req.contactId, documentKey: key } } });
    if (!documentRow) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }
    if (documentRow.status !== 'SUBMITTED_FOR_REVIEW') {
      return reply.code(409).send({ error: 'NOT_SUBMITTED_FOR_REVIEW' });
    }

    // Rejection persists DocumentStatus.REJECTED (not UPLOADED) with the
    // required review note — staff see it as a distinct, actionable state
    // in their document list and must re-upload before it can be
    // resubmitted (see submit-for-review's missing-documents check).
    const updated = await prisma.document.update({
      where: { id: documentRow.id },
      data: {
        status: parsed.data.approved ? 'APPROVED' : 'REJECTED',
        reviewedAt: new Date(),
        ...(parsed.data.note !== undefined ? { reviewNote: parsed.data.note } : {}),
      },
    });

    // pendingCustomerReview is a stored flag (not purely computed) so the
    // app can show a badge without re-scanning every document row on each
    // read — cleared only once no SUBMITTED_FOR_REVIEW rows remain.
    const remainingPending = await prisma.document.count({ where: { contactId: req.contactId, status: 'SUBMITTED_FOR_REVIEW' } });
    if (remainingPending === 0) {
      await prisma.contact.update({ where: { id: req.contactId }, data: { pendingCustomerReview: false } });
    }

    await invalidateDocumentsCache(req.contactId);

    return reply.code(200).send({
      key: updated.documentKey,
      status: updated.status,
      reviewed_at: updated.reviewedAt,
      review_note: updated.reviewNote,
    });
  });

  // Customer self-upload — lands as PENDING_APPROVAL for a staff manager
  // to approve/reject (POST /staff/customers/:contactId/documents/:key/
  // review), the reverse of the staff-upload → customer-respond direction.
  app.post('/me/documents/:key/upload', { preHandler: requireAuth }, async (req, reply) => {
    const { key } = req.params as { key: string };

    const documentDef = findDocumentDef(app.tenantConfig, key);
    if (!documentDef) {
      return reply.code(400).send({ error: 'INVALID_DOCUMENT_KEY' });
    }

    if (!app.zohoClient) {
      return reply.code(503).send({ error: 'ZOHO_CLIENT_UNAVAILABLE' });
    }

    const contact = await prisma.contact.findUnique({ where: { id: req.contactId }, include: { journeys: true } });
    if (!contact) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }

    // An approved document is final from the customer's side — replacing
    // it would silently undo a manager's decision.
    const existing = await prisma.document.findUnique({ where: { contactId_documentKey: { contactId: contact.id, documentKey: key } } });
    if (existing?.status === 'APPROVED') {
      return reply.code(409).send({ error: 'ALREADY_APPROVED' });
    }

    const targetJourney = pickUploadJourney(contact, req.log);
    if (!targetJourney) {
      return reply.code(400).send({ error: 'NO_SALES_ORDER', message: 'no synced sales order to attach documents to yet' });
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
      status: 'PENDING_APPROVAL',
      uploadedById: null,
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
}
