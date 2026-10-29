import Fastify from 'fastify';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantConfig } from '../src/config/types.js';

const redisMock = new RedisMock();
vi.mock('../src/lib/redis.js', () => ({ redis: redisMock }));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    session: { findUnique: vi.fn() },
    document: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), count: vi.fn(), upsert: vi.fn() },
    documentVersion: { count: vi.fn(), create: vi.fn() },
    contact: { update: vi.fn(), findUnique: vi.fn() },
  },
}));

vi.mock('../src/lib/jwt.js', () => ({
  verifySessionToken: vi.fn(),
}));

const { prisma } = await import('../src/lib/prisma.js');
const { verifySessionToken } = await import('../src/lib/jwt.js');
const { registerDocumentRoutes } = await import('../src/routes/documents.js');

const tenantConfig: TenantConfig = {
  tenant: {
    slug: 'elgris',
    display_name: 'Elgris Solar',
    logo_url: 'https://example.com/logo.png',
    brand_colors: { primary: '#000000', secondary: '#ffffff' },
    support_whatsapp: '+919999999999',
    support_email: 'support@example.com',
  },
  zoho: {
    dc: 'in',
    org_id: '123',
    journey_module: 'Sales_Orders',
    contact_phone_fields: ['Phone'],
    journey_stage_field: 'Stage',
    journey_name_field: 'Subject',
    journey_contact_lookup_field: 'Contact_Name',
  },
  journey: {
    label_singular: 'Project',
    label_plural: 'Projects',
    empty_state_copy: 'Your project is being set up.',
    stages: [{ type: 'journey', index: 1, crm_value: 'Sales Order', display: 'Sales Order Placed', owner: 'elgris', next_copy: 'x' }],
  },
  reference_fields: [],
  notifications: {
    otp_channel: ['whatsapp'],
    interakt_otp_template: 'otp_v1',
    stage_change_push: 'x',
    stage_change_whatsapp_template: null,
  },
  webhooks: {
    journey_updated: { record_id_field: 'record_id', stage_field: 'stage', contact_id_field: 'contact_id', changed_at_field: 'changed_at' },
    contact_updated: { record_id_field: 'record_id' },
    salesorder_updated: { record_id_field: 'record_id' },
    ticket_updated: { record_id_field: 'record_id' },
  },
  desk: {
    dc: 'in',
    org_id: '60022843030',
    department_name: 'Elgris Solar Power Systems Pvt Ltd',
    category_field: 'category',
    status_display_map: { Open: 'Open', Closed: 'Resolved' },
    response_time_copy: 'Our team typically responds within 24 hours.',
  },
  documents: {
    stage_groups: [
      {
        stage_group_key: 'documents_required',
        group_label: 'Documents Required',
        requires_approval: true,
        documents: [
          { key: 'aadhaar_card', display_name: 'Aadhaar Card' },
          { key: 'pan_card', display_name: 'PAN Card' },
        ],
      },
    ],
  },
};

const zohoClient = {
  getRecordsPage: vi.fn(),
  getRecord: vi.fn(),
  getModuleFields: vi.fn(),
  uploadAttachment: vi.fn(),
};

async function buildApp() {
  const app = Fastify();
  app.decorate('tenantConfig', tenantConfig);
  app.decorate('zohoClient', zohoClient);
  await app.register((await import('@fastify/multipart')).default);
  await registerDocumentRoutes(app);
  return app;
}

function mockAuthAs(contactId: string) {
  vi.mocked(verifySessionToken).mockResolvedValue({ sub: contactId, jti: `jti-${contactId}` });
  vi.mocked(prisma.session.findUnique).mockResolvedValue({
    id: 'sess-1',
    contactId,
    jti: `jti-${contactId}`,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    revokedAt: null,
    createdAt: new Date(),
  } as never);
}

const authHeader = { authorization: 'Bearer token-c1' };

beforeEach(async () => {
  vi.clearAllMocks();
  await redisMock.flushall();
});

describe('GET /me/documents', () => {
  it('returns the checklist without internal fields (no zoho_attachment_id/uploaded_by)', async () => {
    mockAuthAs('c1');
    vi.mocked(prisma.document.findMany).mockResolvedValue([
      { documentKey: 'aadhaar_card', status: 'UPLOADED', fileName: 'a.pdf', fileSize: 1, zohoAttachmentId: 'z1', uploadedById: 'staff-1', uploadedAt: new Date(), reviewedAt: null, reviewNote: null },
    ] as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/me/documents', headers: authHeader });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const doc = body[0].documents.find((d: { key: string }) => d.key === 'aadhaar_card');
    expect(doc.status).toBe('UPLOADED');
    expect(doc.zoho_attachment_id).toBeUndefined();
    expect(doc.uploaded_by).toBeUndefined();
  });

  it('401s without a bearer token', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/me/documents' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /me/documents/:key/respond', () => {
  const submittedRow = {
    id: 'd1',
    documentKey: 'aadhaar_card',
    stageGroupKey: 'documents_required',
    status: 'SUBMITTED_FOR_REVIEW',
    reviewedAt: null,
    reviewNote: null,
  };

  it('approves: sets APPROVED and clears pendingCustomerReview once nothing else is pending', async () => {
    mockAuthAs('c1');
    vi.mocked(prisma.document.findUnique).mockResolvedValue(submittedRow as never);
    vi.mocked(prisma.document.update).mockResolvedValue({ ...submittedRow, status: 'APPROVED', reviewedAt: new Date(), reviewNote: null } as never);
    vi.mocked(prisma.document.count).mockResolvedValue(0);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/me/documents/aadhaar_card/respond', headers: authHeader, payload: { approved: true } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ key: 'aadhaar_card', status: 'APPROVED' });
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: expect.objectContaining({ status: 'APPROVED' }),
    });
    expect(prisma.contact.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { pendingCustomerReview: false } });
  });

  it('rejects: persists REJECTED (a distinct, actionable state) and stores the note', async () => {
    mockAuthAs('c1');
    vi.mocked(prisma.document.findUnique).mockResolvedValue(submittedRow as never);
    vi.mocked(prisma.document.update).mockResolvedValue({ ...submittedRow, status: 'REJECTED', reviewedAt: new Date(), reviewNote: 'blurry photo' } as never);
    vi.mocked(prisma.document.count).mockResolvedValue(1);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/me/documents/aadhaar_card/respond',
      headers: authHeader,
      payload: { approved: false, note: 'blurry photo' },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.document.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: expect.objectContaining({ status: 'REJECTED', reviewNote: 'blurry photo' }),
    });
  });

  it('does not clear pendingCustomerReview while other documents are still SUBMITTED_FOR_REVIEW', async () => {
    mockAuthAs('c1');
    vi.mocked(prisma.document.findUnique).mockResolvedValue(submittedRow as never);
    vi.mocked(prisma.document.update).mockResolvedValue({ ...submittedRow, status: 'APPROVED' } as never);
    vi.mocked(prisma.document.count).mockResolvedValue(1);

    const app = await buildApp();
    await app.inject({ method: 'POST', url: '/me/documents/aadhaar_card/respond', headers: authHeader, payload: { approved: true } });

    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  it('409s when the document is not currently SUBMITTED_FOR_REVIEW', async () => {
    mockAuthAs('c1');
    vi.mocked(prisma.document.findUnique).mockResolvedValue({ ...submittedRow, status: 'APPROVED' } as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/me/documents/aadhaar_card/respond', headers: authHeader, payload: { approved: true } });

    expect(res.statusCode).toBe(409);
    expect(prisma.document.update).not.toHaveBeenCalled();
  });

  it('404s for an unknown document key', async () => {
    mockAuthAs('c1');
    vi.mocked(prisma.document.findUnique).mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/me/documents/not_real/respond', headers: authHeader, payload: { approved: true } });

    expect(res.statusCode).toBe(404);
  });

  it('400s on an invalid body', async () => {
    mockAuthAs('c1');
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/me/documents/aadhaar_card/respond', headers: authHeader, payload: { approved: 'yes' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /me/documents/:key/upload', () => {
  function uploadForm() {
    const form = new FormData();
    form.append('file', new Blob(['scan'], { type: 'image/jpeg' }), 'IMG_1.jpg');
    return form;
  }

  const contact = {
    id: 'c1',
    fullName: 'Ganesh Kumar',
    isDemo: false,
    journeys: [{ id: 'j1', zohoRecordId: 'so1', syncedAt: new Date('2026-01-01') }],
  };

  beforeEach(() => {
    vi.mocked(prisma.contact.findUnique).mockResolvedValue(contact as never);
    vi.mocked(prisma.document.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.documentVersion.count).mockResolvedValue(0);
    vi.mocked(prisma.documentVersion.create).mockResolvedValue({} as never);
    vi.mocked(prisma.document.upsert).mockResolvedValue({ id: 'doc-1', documentKey: 'aadhaar_card', status: 'PENDING_APPROVAL', uploadedAt: new Date() } as never);
    vi.mocked(zohoClient.uploadAttachment).mockResolvedValue({ id: 'zoho-att-1' });
  });

  it('attaches the file to the Sales Order and lands it as PENDING_APPROVAL with no staff uploader', async () => {
    mockAuthAs('c1');
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/me/documents/aadhaar_card/upload', headers: authHeader, payload: uploadForm() });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('PENDING_APPROVAL');
    expect(zohoClient.uploadAttachment).toHaveBeenCalledWith('Sales_Orders', 'so1', expect.objectContaining({ filename: 'Aadhaar Card - Ganesh Kumar (v1).jpg' }));
    expect(prisma.document.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ status: 'PENDING_APPROVAL', uploadedById: null, contactId: 'c1' }) }),
    );
  });

  it('409s instead of replacing an already-approved document', async () => {
    mockAuthAs('c1');
    vi.mocked(prisma.document.findUnique).mockResolvedValue({ id: 'doc-1', status: 'APPROVED' } as never);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/me/documents/aadhaar_card/upload', headers: authHeader, payload: uploadForm() });

    expect(res.statusCode).toBe(409);
    expect(zohoClient.uploadAttachment).not.toHaveBeenCalled();
  });

  it('never calls Zoho for the reviewer/demo account', async () => {
    mockAuthAs('c1');
    vi.mocked(prisma.contact.findUnique).mockResolvedValue({ ...contact, isDemo: true } as never);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/me/documents/aadhaar_card/upload', headers: authHeader, payload: uploadForm() });

    expect(res.statusCode).toBe(200);
    expect(zohoClient.uploadAttachment).not.toHaveBeenCalled();
  });

  it('rejects an unconfigured document key', async () => {
    mockAuthAs('c1');
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/me/documents/not_a_doc/upload', headers: authHeader, payload: uploadForm() });
    expect(res.statusCode).toBe(400);
  });
});
