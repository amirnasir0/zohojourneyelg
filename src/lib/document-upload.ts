import { randomUUID } from 'node:crypto';
import type { Contact, Document, Journey } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type { TenantConfig } from '../config/types.js';
import type { ZohoClient } from './zoho-client.js';
import { prisma } from './prisma.js';

// Shared by the staff upload route (staff-customers.ts) and the customer
// upload route (documents.ts) — both land the file in Zoho as a Sales Order
// attachment and keep the same Document/DocumentVersion bookkeeping; they
// differ only in who's uploading and which status the row lands in.

export interface DocumentDef {
  stageGroupKey: string;
  requiresApproval: boolean;
  displayName: string;
}

export function findDocumentDef(tenantConfig: TenantConfig, key: string): DocumentDef | undefined {
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

/**
 * Picks the journey (Sales Order) an upload attaches to. Real ambiguity
 * when there's more than one, not just a silent default — logged at WARN so
 * it's noticeable in practice, per explicit product direction. Doesn't
 * hard-fail: the most-recently-synced journey is the best available guess
 * for "the Sales Order this customer is actively working."
 */
export function pickUploadJourney(contact: Contact & { journeys: Journey[] }, log: FastifyBaseLogger): Journey | undefined {
  if (contact.journeys.length <= 1) {
    return contact.journeys[0];
  }
  const targetJourney = [...contact.journeys].sort((a, b) => b.syncedAt.getTime() - a.syncedAt.getTime())[0]!;
  log.warn(
    { contactId: contact.id, journeyCount: contact.journeys.length, chosenJourneyId: targetJourney.id },
    '[document-upload] contact has multiple journeys — uploading to the most recently synced one',
  );
  return targetJourney;
}

export interface StoreUploadInput {
  zohoClient: ZohoClient;
  tenantConfig: TenantConfig;
  contact: Contact;
  journey: Journey;
  key: string;
  documentDef: DocumentDef;
  file: { buffer: Buffer; filename: string; mimetype: string };
  status: 'UPLOADED' | 'PENDING_APPROVAL';
  // null for a customer's own upload — uploaded_by is a staff FK.
  uploadedById: string | null;
}

export async function storeDocumentUpload(input: StoreUploadInput): Promise<Document> {
  const { zohoClient, tenantConfig, contact, journey, key, documentDef, file, status, uploadedById } = input;

  // A re-upload never overwrites or deletes the previous version in
  // Zoho — each upload lands as its own distinctly-numbered attachment,
  // with the full history preserved in DocumentVersion. The Document row
  // itself still just holds "current" state (unchanged by this).
  const existingDocument = await prisma.document.findUnique({
    where: { contactId_documentKey: { contactId: contact.id, documentKey: key } },
  });
  const nextVersionNumber = existingDocument ? (await prisma.documentVersion.count({ where: { documentId: existingDocument.id } })) + 1 : 1;

  const attachmentFilename = buildAttachmentFilename(documentDef.displayName, contact.fullName, file.filename, nextVersionNumber);

  // Reviewer/demo account: never reaches Zoho at all (same safety rule as
  // tickets.ts) — the row gets a synthetic attachment id instead.
  const uploaded = contact.isDemo
    ? { id: `DEMO-ATTACHMENT-${randomUUID()}` }
    : await zohoClient.uploadAttachment(tenantConfig.zoho.journey_module, journey.zohoRecordId, {
        buffer: file.buffer,
        filename: attachmentFilename,
        contentType: file.mimetype,
      });

  const documentRow = await prisma.document.upsert({
    where: { contactId_documentKey: { contactId: contact.id, documentKey: key } },
    create: {
      contactId: contact.id,
      journeyId: journey.id,
      documentKey: key,
      stageGroupKey: documentDef.stageGroupKey,
      fileName: file.filename,
      fileSize: file.buffer.length,
      zohoAttachmentId: uploaded.id,
      status,
      uploadedById,
      uploadedAt: new Date(),
    },
    update: {
      journeyId: journey.id,
      fileName: file.filename,
      fileSize: file.buffer.length,
      zohoAttachmentId: uploaded.id,
      status,
      uploadedById,
      uploadedAt: new Date(),
      reviewedAt: null,
      reviewNote: null,
      reviewedById: null,
    },
  });

  await prisma.documentVersion.create({
    data: {
      documentId: documentRow.id,
      versionNumber: nextVersionNumber,
      fileName: file.filename,
      fileSize: file.buffer.length,
      zohoAttachmentId: uploaded.id,
      uploadedById,
      uploadedAt: documentRow.uploadedAt ?? new Date(),
    },
  });

  return documentRow;
}
