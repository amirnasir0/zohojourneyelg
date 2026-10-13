import { prisma } from '../lib/prisma.js';
import { REVIEW_DEMO_ZOHO_CONTACT_ID } from '../lib/review-account.js';

// Play/App Store reviewer demo account — run once manually (never
// boot-triggered, mirrors seed-staff-admin.ts's safety model), safe to
// re-run (every write here is an upsert keyed on a fixed sentinel id).
// Populates one contact with a project, a few tickets, and documents in a
// mix of states, so a reviewer can see every screen without touching any
// real customer data. The reviewer logs in via REVIEW_PHONE/REVIEW_OTP
// (src/routes/auth.ts) — see review-account.ts for why this is resolved by
// a hardcoded sentinel id, never by mobile number.
//
// This contact is excluded from every Zoho sync's cleanup pass
// (Contact.isDemo — see reconcile.ts) and from every Zoho/Desk-writing
// customer route (tickets.ts) — nothing here ever reaches Zoho CRM, Zoho
// Desk, or Interakt WhatsApp.

const DEMO_JOURNEY_ZOHO_RECORD_ID = 'DEMO-SALES-ORDER-1';
const DEMO_TICKET_1_DESK_ID = 'DEMO-TICKET-1';
const DEMO_TICKET_2_DESK_ID = 'DEMO-TICKET-2';

async function main() {
  const contact = await prisma.contact.upsert({
    where: { zohoContactId: REVIEW_DEMO_ZOHO_CONTACT_ID },
    create: {
      zohoContactId: REVIEW_DEMO_ZOHO_CONTACT_ID,
      // Reserved/invalid-looking pattern (normalizePhone requires a real
      // number to start 6-9) — just satisfies the unique/non-null column,
      // never actually used for login lookup (see issueSessionForReviewAccount).
      mobileE164: '+910000000001',
      fullName: 'App Reviewer Demo',
      email: null,
      raw: { note: 'Play/App Store reviewer demo account — not a real customer' },
      syncedAt: new Date(),
      pendingCustomerReview: true,
      isDemo: true,
    },
    update: {
      fullName: 'App Reviewer Demo',
      isDemo: true,
      pendingCustomerReview: true,
    },
  });
  console.log(`[seed-review-account] contact ready: ${contact.id}`);

  // A project roughly mid-progress: stages 1-6 dated (completed/current),
  // 7-11 still pending — a representative, demonstrable state rather than
  // "just started" or "fully done".
  const now = new Date();
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

  const refValues = {
    Sales_Order: daysAgo(60),
    Disbursement_Date: daysAgo(50),
    Accounts_Approval: daysAgo(45),
    Material_Dispatch_Date: daysAgo(30),
    Construction_Date: daysAgo(15),
    Bond_Completion: daysAgo(5),
    Release_Order_Date: null,
    Net_Metering_Date: null,
    Disbursement_Date_2: null,
    Subsidy_Redeem_Date: null,
    Subsidy_Received_Date: null,
  };

  const journey = await prisma.journey.upsert({
    where: { zohoRecordId: DEMO_JOURNEY_ZOHO_RECORD_ID },
    create: {
      zohoRecordId: DEMO_JOURNEY_ZOHO_RECORD_ID,
      contactId: contact.id,
      name: 'Rooftop Solar — 5kWp System',
      stage: '',
      stageIndex: null,
      refValues,
      raw: { id: DEMO_JOURNEY_ZOHO_RECORD_ID, Subject: 'Rooftop Solar — 5kWp System', Created_Time: daysAgo(60), ...refValues },
      syncedAt: now,
      ownerZohoId: null,
    },
    update: {
      refValues,
      raw: { id: DEMO_JOURNEY_ZOHO_RECORD_ID, Subject: 'Rooftop Solar — 5kWp System', Created_Time: daysAgo(60), ...refValues },
      syncedAt: now,
    },
  });
  console.log(`[seed-review-account] journey ready: ${journey.id}`);

  // A few tickets — one open, one resolved.
  await prisma.ticket.upsert({
    where: { deskTicketId: DEMO_TICKET_1_DESK_ID },
    create: {
      deskTicketId: DEMO_TICKET_1_DESK_ID,
      contactId: contact.id,
      ticketNumber: 'DEMO-1001',
      subject: 'Panel Issue',
      description: 'One panel appears to have a visible crack after yesterday’s storm.',
      category: 'Panel Issue',
      status: 'Open',
      statusDisplay: 'Open',
      ownerName: 'Support Team',
      coOwnerName: null,
      priority: 'Normal',
      closedAt: null,
      createdAt: new Date(daysAgo(2)),
      updatedAt: new Date(daysAgo(1)),
      syncedAt: now,
      raw: { statusType: 'Open' },
    },
    update: {
      updatedAt: new Date(daysAgo(1)),
      syncedAt: now,
    },
  });

  await prisma.ticket.upsert({
    where: { deskTicketId: DEMO_TICKET_2_DESK_ID },
    create: {
      deskTicketId: DEMO_TICKET_2_DESK_ID,
      contactId: contact.id,
      ticketNumber: 'DEMO-1000',
      subject: 'Subsidy Query',
      description: 'Asked about expected timeline for the subsidy disbursement.',
      category: 'Subsidy Query',
      status: 'Closed',
      statusDisplay: 'Resolved',
      ownerName: 'Support Team',
      coOwnerName: null,
      priority: 'Low',
      closedAt: new Date(daysAgo(20)),
      createdAt: new Date(daysAgo(25)),
      updatedAt: new Date(daysAgo(20)),
      syncedAt: now,
      raw: { statusType: 'Closed' },
    },
    update: {
      syncedAt: now,
    },
  });
  console.log('[seed-review-account] tickets ready: DEMO-1001 (Open), DEMO-1000 (Resolved)');

  // Documents across a mix of states — including one SUBMITTED_FOR_REVIEW,
  // so the reviewer can exercise the approve/reject screen. zohoAttachmentId
  // is deliberately left null on every row: none of these ever touched a
  // real Zoho Attachment, unlike a real staff upload.
  const documents: Array<{ key: string; stageGroupKey: string; fileName: string; status: 'UPLOADED' | 'SUBMITTED_FOR_REVIEW' | 'APPROVED' }> = [
    { key: 'electricity_bill', stageGroupKey: 'documents_required', fileName: 'Electricity Bill.pdf', status: 'APPROVED' },
    { key: 'aadhaar_card', stageGroupKey: 'documents_required', fileName: 'Aadhaar Card.pdf', status: 'APPROVED' },
    { key: 'pan_card', stageGroupKey: 'documents_required', fileName: 'PAN Card.pdf', status: 'SUBMITTED_FOR_REVIEW' },
    { key: 'bank_details', stageGroupKey: 'documents_required', fileName: 'Bank Details.pdf', status: 'UPLOADED' },
    { key: 'draft_sales_order', stageGroupKey: 'sales_order_draft', fileName: 'Draft Sales Order.pdf', status: 'UPLOADED' },
  ];

  for (const doc of documents) {
    const isReviewed = doc.status === 'APPROVED';
    await prisma.document.upsert({
      where: { contactId_documentKey: { contactId: contact.id, documentKey: doc.key } },
      create: {
        contactId: contact.id,
        journeyId: journey.id,
        documentKey: doc.key,
        stageGroupKey: doc.stageGroupKey,
        fileName: doc.fileName,
        fileSize: 123456,
        zohoAttachmentId: null,
        status: doc.status,
        uploadedById: null,
        uploadedAt: new Date(daysAgo(10)),
        reviewedAt: isReviewed ? new Date(daysAgo(8)) : null,
        reviewNote: null,
      },
      update: {
        status: doc.status,
        reviewedAt: isReviewed ? new Date(daysAgo(8)) : null,
      },
    });
  }
  console.log(`[seed-review-account] ${documents.length} document(s) ready (quotation_copy/agreement_copy/bank_sanction_letter/loan_disbursement_proof left NOT_UPLOADED on purpose)`);

  console.log('[seed-review-account] done.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
