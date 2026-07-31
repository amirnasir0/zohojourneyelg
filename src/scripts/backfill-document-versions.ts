import { prisma } from '../lib/prisma.js';

// One-time backfill for Document rows created before DocumentVersion
// existed (M9 versioning follow-up, 31 July 2026) — every Document with a
// zoho_attachment_id should have at least one corresponding
// DocumentVersion row, since the upload route's re-upload version
// numbering (COUNT(*) + 1) depends on that invariant already holding.
// Safe to re-run: only touches Documents with zero existing versions, so
// it's a no-op once caught up.
async function main() {
  const documents = await prisma.document.findMany({
    where: { zohoAttachmentId: { not: null }, versions: { none: {} } },
  });

  for (const doc of documents) {
    await prisma.documentVersion.create({
      data: {
        documentId: doc.id,
        versionNumber: 1,
        fileName: doc.fileName ?? 'unknown',
        fileSize: doc.fileSize ?? 0,
        zohoAttachmentId: doc.zohoAttachmentId!,
        uploadedById: doc.uploadedById,
        uploadedAt: doc.uploadedAt ?? new Date(),
      },
    });
    console.log(`[backfill-document-versions] backfilled v1 for document ${doc.id} (${doc.documentKey})`);
  }

  console.log(`[backfill-document-versions] done — ${documents.length} document(s) backfilled`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
