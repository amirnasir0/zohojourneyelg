import Fastify from 'fastify';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantConfig } from '../src/config/types.js';

const redisMock = new RedisMock();
vi.mock('../src/lib/redis.js', () => ({ redis: redisMock }));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    staffSession: { findUnique: vi.fn() },
    contact: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    document: { findMany: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../src/lib/staff-jwt.js', () => ({
  verifyStaffSessionToken: vi.fn(),
}));

const { prisma } = await import('../src/lib/prisma.js');
const { verifyStaffSessionToken } = await import('../src/lib/staff-jwt.js');
const { registerStaffCustomerRoutes } = await import('../src/routes/staff-customers.js');

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
    stages: [{ type: 'journey', index: 1, crm_value: 'Sales Order', display: 'Sales Order Placed', owner: 'elgris', next_copy: 'a' }],
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
      {
        stage_group_key: 'material_dispatched',
        group_label: 'Material Dispatched',
        requires_approval: false,
        documents: [],
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
  await registerStaffCustomerRoutes(app);
  return app;
}

function mockAuthAs(staffId: string, role: 'ADMIN' | 'EMPLOYEE', zohoOwnerId: string | null = null) {
  vi.mocked(verifyStaffSessionToken).mockResolvedValue({ sub: staffId, jti: `jti-${staffId}`, role });
  vi.mocked(prisma.staffSession.findUnique).mockResolvedValue({
    id: 'sess-1',
    staffId,
    jti: `jti-${staffId}`,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    revokedAt: null,
    createdAt: new Date(),
    staff: { id: staffId, role, active: true, zohoOwnerId },
  } as never);
}

const authHeader = { authorization: 'Bearer token' };

const contactOwnedByOwner1 = {
  id: 'c1',
  fullName: 'Ganesh Kumar',
  mobileE164: '+919876543210',
  email: 'ganesh@example.com',
  pendingCustomerReview: false,
  journeys: [{ id: 'j1', zohoRecordId: 'so1', ownerZohoId: 'owner-1', syncedAt: new Date('2026-01-01') }],
};

beforeEach(async () => {
  vi.clearAllMocks();
  await redisMock.flushall();
  vi.mocked(prisma.$transaction).mockImplementation((ops: unknown) => Promise.all(ops as never[]) as never);
});

describe('GET /staff/customers — role scoping', () => {
  it('scopes an EMPLOYEE to only their own owner_zoho_id', async () => {
    mockAuthAs('emp-1', 'EMPLOYEE', 'owner-1');
    vi.mocked(prisma.contact.findMany).mockResolvedValue([contactOwnedByOwner1] as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/staff/customers', headers: authHeader });

    expect(res.statusCode).toBe(200);
    expect(prisma.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ journeys: { some: { ownerZohoId: 'owner-1' } } }) }),
    );
  });

  it('returns an empty list for an EMPLOYEE with no zoho_owner_id mapped, without querying the DB', async () => {
    mockAuthAs('emp-1', 'EMPLOYEE', null);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/staff/customers', headers: authHeader });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  it('does not scope an ADMIN', async () => {
    mockAuthAs('admin-1', 'ADMIN');
    vi.mocked(prisma.contact.findMany).mockResolvedValue([contactOwnedByOwner1] as never);

    const app = await buildApp();
    await app.inject({ method: 'GET', url: '/staff/customers', headers: authHeader });

    expect(prisma.contact.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });
});

describe('GET /staff/customers/:contactId — scoping is a 404, not 403', () => {
  it('404s when an EMPLOYEE requests a customer outside their owner scope', async () => {
    mockAuthAs('emp-2', 'EMPLOYEE', 'owner-2');
    vi.mocked(prisma.contact.findUnique).mockResolvedValue(contactOwnedByOwner1 as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/staff/customers/c1', headers: authHeader });

    expect(res.statusCode).toBe(404);
  });

  it('200s when the EMPLOYEE owns the customer', async () => {
    mockAuthAs('emp-1', 'EMPLOYEE', 'owner-1');
    vi.mocked(prisma.contact.findUnique).mockResolvedValue(contactOwnedByOwner1 as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/staff/customers/c1', headers: authHeader });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'c1', full_name: 'Ganesh Kumar' });
  });

  it('404s for a nonexistent contact', async () => {
    mockAuthAs('admin-1', 'ADMIN');
    vi.mocked(prisma.contact.findUnique).mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/staff/customers/nope', headers: authHeader });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /staff/customers/:contactId/documents/:key/upload', () => {
  function uploadForm(filename = 'aadhaar.pdf', content = 'test file content') {
    const form = new FormData();
    form.append('file', new Blob([content], { type: 'application/pdf' }), filename);
    return form;
  }

  it('uploads to Zoho and upserts the Document row', async () => {
    mockAuthAs('emp-1', 'EMPLOYEE', 'owner-1');
    vi.mocked(prisma.contact.findUnique).mockResolvedValue(contactOwnedByOwner1 as never);
    vi.mocked(zohoClient.uploadAttachment).mockResolvedValue({ id: 'zoho-att-1' });
    vi.mocked(prisma.document.upsert).mockResolvedValue({
      documentKey: 'aadhaar_card',
      status: 'UPLOADED',
      fileName: 'aadhaar.pdf',
      fileSize: 17,
      uploadedAt: new Date(),
    } as never);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/staff/customers/c1/documents/aadhaar_card/upload',
      headers: authHeader,
      payload: uploadForm(),
    });

    expect(res.statusCode).toBe(200);
    expect(zohoClient.uploadAttachment).toHaveBeenCalledWith('Sales_Orders', 'so1', expect.objectContaining({ filename: 'aadhaar.pdf' }));
    expect(prisma.document.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { contactId_documentKey: { contactId: 'c1', documentKey: 'aadhaar_card' } },
        create: expect.objectContaining({ zohoAttachmentId: 'zoho-att-1', status: 'UPLOADED', uploadedById: 'emp-1' }),
      }),
    );
  });

  it('rejects an unconfigured document key with 400', async () => {
    mockAuthAs('emp-1', 'EMPLOYEE', 'owner-1');
    vi.mocked(prisma.contact.findUnique).mockResolvedValue(contactOwnedByOwner1 as never);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/staff/customers/c1/documents/not_a_real_key/upload',
      headers: authHeader,
      payload: uploadForm(),
    });

    expect(res.statusCode).toBe(400);
    expect(zohoClient.uploadAttachment).not.toHaveBeenCalled();
  });

  it('logs at WARN and uploads to the most recently synced journey when a contact has more than one', async () => {
    mockAuthAs('emp-1', 'EMPLOYEE', 'owner-1');
    const multiJourneyContact = {
      ...contactOwnedByOwner1,
      journeys: [
        { id: 'j-old', zohoRecordId: 'so-old', ownerZohoId: 'owner-1', syncedAt: new Date('2026-01-01') },
        { id: 'j-new', zohoRecordId: 'so-new', ownerZohoId: 'owner-1', syncedAt: new Date('2026-06-01') },
      ],
    };
    vi.mocked(prisma.contact.findUnique).mockResolvedValue(multiJourneyContact as never);
    vi.mocked(zohoClient.uploadAttachment).mockResolvedValue({ id: 'zoho-att-2' });
    vi.mocked(prisma.document.upsert).mockResolvedValue({} as never);

    const app = await buildApp();
    const warnSpy = vi.fn();
    app.addHook('onRequest', (req, _reply, done) => {
      req.log.warn = warnSpy;
      done();
    });

    const res = await app.inject({
      method: 'POST',
      url: '/staff/customers/c1/documents/aadhaar_card/upload',
      headers: authHeader,
      payload: uploadForm(),
    });

    expect(res.statusCode).toBe(200);
    expect(zohoClient.uploadAttachment).toHaveBeenCalledWith('Sales_Orders', 'so-new', expect.anything());
    expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ chosenJourneyId: 'j-new' }), expect.stringContaining('multiple journeys'));
  });

  it('returns 400 when the contact has zero journeys to attach to', async () => {
    // Only an ADMIN can reach this branch — an EMPLOYEE's scope check itself
    // requires a journey with a matching owner, so a zero-journey contact is
    // unreachable (404) for any EMPLOYEE before this validation runs.
    mockAuthAs('admin-1', 'ADMIN');
    vi.mocked(prisma.contact.findUnique).mockResolvedValue({ ...contactOwnedByOwner1, journeys: [] } as never);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/staff/customers/c1/documents/aadhaar_card/upload',
      headers: authHeader,
      payload: uploadForm(),
    });

    expect(res.statusCode).toBe(400);
    expect(zohoClient.uploadAttachment).not.toHaveBeenCalled();
  });
});

describe('POST /staff/customers/:contactId/documents/submit-for-review', () => {
  it('400s listing missing documents when a requires_approval group is incomplete', async () => {
    mockAuthAs('emp-1', 'EMPLOYEE', 'owner-1');
    vi.mocked(prisma.contact.findUnique).mockResolvedValue(contactOwnedByOwner1 as never);
    vi.mocked(prisma.document.findMany).mockResolvedValue([
      { documentKey: 'aadhaar_card', stageGroupKey: 'documents_required', status: 'UPLOADED', fileName: 'a.pdf', fileSize: 1, zohoAttachmentId: 'z1', uploadedById: 'emp-1', uploadedAt: new Date(), reviewedAt: null, reviewNote: null },
    ] as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/staff/customers/c1/documents/submit-for-review', headers: authHeader });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'MISSING_DOCUMENTS', missing: [{ key: 'pan_card', display_name: 'PAN Card' }] });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('flips UPLOADED documents to SUBMITTED_FOR_REVIEW and sets pending_customer_review once complete', async () => {
    mockAuthAs('emp-1', 'EMPLOYEE', 'owner-1');
    vi.mocked(prisma.contact.findUnique).mockResolvedValue(contactOwnedByOwner1 as never);
    vi.mocked(prisma.document.findMany).mockResolvedValue([
      { id: 'd1', documentKey: 'aadhaar_card', stageGroupKey: 'documents_required', status: 'UPLOADED', fileName: 'a.pdf', fileSize: 1, zohoAttachmentId: 'z1', uploadedById: 'emp-1', uploadedAt: new Date(), reviewedAt: null, reviewNote: null },
      { id: 'd2', documentKey: 'pan_card', stageGroupKey: 'documents_required', status: 'UPLOADED', fileName: 'p.pdf', fileSize: 1, zohoAttachmentId: 'z2', uploadedById: 'emp-1', uploadedAt: new Date(), reviewedAt: null, reviewNote: null },
    ] as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/staff/customers/c1/documents/submit-for-review', headers: authHeader });

    expect(res.statusCode).toBe(200);
    expect(prisma.document.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['d1', 'd2'] } }, data: { status: 'SUBMITTED_FOR_REVIEW' } });
    expect(prisma.contact.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { pendingCustomerReview: true } });
  });
});
