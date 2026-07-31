import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../lib/auth-middleware.js';
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
}
