import Fastify from 'fastify';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantConfig } from '../src/config/types.js';

const redisMock = new RedisMock();
vi.mock('../src/lib/redis.js', () => ({ redis: redisMock }));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    session: { findUnique: vi.fn() },
    contact: { findUnique: vi.fn() },
    ticket: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  },
}));

vi.mock('../src/lib/jwt.js', () => ({
  verifySessionToken: vi.fn(),
}));

vi.mock('../src/lib/desk-contact-bridge.js', () => ({
  createTicketForContact: vi.fn(),
}));

const { prisma } = await import('../src/lib/prisma.js');
const { verifySessionToken } = await import('../src/lib/jwt.js');
const { createTicketForContact } = await import('../src/lib/desk-contact-bridge.js');
const { registerTicketRoutes } = await import('../src/routes/tickets.js');

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
};

const deskContext = { departmentId: 'dept1', categoryValues: ['General', 'Defects'] };

const deskClient = {
  getDepartments: vi.fn(),
  getTicketFields: vi.fn(),
  getTicketsPage: vi.fn(),
  getTicket: vi.fn(),
  createTicket: vi.fn(),
  findContactByCrmId: vi.fn(),
  findContactByPhoneOrEmail: vi.fn(),
  createContact: vi.fn(),
};

async function buildApp(opts: { withDesk?: boolean } = { withDesk: true }) {
  const app = Fastify();
  app.decorate('tenantConfig', tenantConfig);
  app.decorate('deskClient', opts.withDesk ? (deskClient as never) : undefined);
  app.decorate('deskContext', opts.withDesk ? deskContext : undefined);
  await registerTicketRoutes(app);
  return app;
}

function mockTicketFields(categoryValues: string[]) {
  deskClient.getTicketFields.mockResolvedValue([
    { apiName: 'category', displayLabel: 'Category', allowedValues: categoryValues.map((value) => ({ value })) },
  ] as never);
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

const authHeader = (contactId: string) => ({ authorization: `Bearer token-${contactId}` });

beforeEach(async () => {
  vi.clearAllMocks();
  await redisMock.flushall();
  // Matches the boot-time deskContext snapshot by default — tests that
  // care about the live-vs-boot-snapshot distinction override this.
  mockTicketFields(['General', 'Defects']);
});

describe('GET /me/tickets/categories', () => {
  it('returns categories + response_time_copy when Desk is configured', async () => {
    mockAuthAs('c1');
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/me/tickets/categories', headers: authHeader('c1') });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      categories: ['General', 'Defects'],
      response_time_copy: 'Our team typically responds within 24 hours.',
    });
  });

  it('reflects a live Desk picklist change, not the frozen boot-time snapshot', async () => {
    // deskContext.categoryValues (the boot snapshot) stays ['General',
    // 'Defects'] — only the live Desk fetch reflects the "admin just edited
    // the picklist" state, proving the route doesn't read the stale value.
    mockTicketFields(['Billing', 'Installation', 'Warranty']);
    mockAuthAs('c1');
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/me/tickets/categories', headers: authHeader('c1') });

    expect(res.statusCode).toBe(200);
    expect(res.json().categories).toEqual(['Billing', 'Installation', 'Warranty']);
  });

  it('serves a second request from cache without a second live fetch', async () => {
    mockAuthAs('c1');
    const app = await buildApp();

    await app.inject({ method: 'GET', url: '/me/tickets/categories', headers: authHeader('c1') });
    await app.inject({ method: 'GET', url: '/me/tickets/categories', headers: authHeader('c1') });

    expect(deskClient.getTicketFields).toHaveBeenCalledTimes(1);
  });

  it('falls back to the boot-time snapshot if the live fetch fails', async () => {
    deskClient.getTicketFields.mockRejectedValue(new Error('Desk API unreachable'));
    mockAuthAs('c1');
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/me/tickets/categories', headers: authHeader('c1') });

    expect(res.statusCode).toBe(200);
    expect(res.json().categories).toEqual(['General', 'Defects']);
  });

  it('returns 503 when Desk is not configured', async () => {
    mockAuthAs('c1');
    const app = await buildApp({ withDesk: false });
    const res = await app.inject({ method: 'GET', url: '/me/tickets/categories', headers: authHeader('c1') });
    expect(res.statusCode).toBe(503);
  });
});

const ticketRow = {
  id: 'ticket-1',
  deskTicketId: 't1',
  contactId: 'c1',
  ticketNumber: '1001',
  subject: 'Panels not working',
  description: null,
  category: 'Defects',
  status: 'Open',
  statusDisplay: 'Open',
  ownerName: null,
  coOwnerName: null,
  priority: null,
  closedAt: null,
  createdAt: new Date('2026-07-17T00:00:00Z'),
  updatedAt: new Date('2026-07-17T00:00:00Z'),
  syncedAt: new Date('2026-07-17T00:00:00Z'),
  raw: { statusType: 'Open' },
};

describe('POST /me/tickets', () => {
  it('returns 503 when Desk is not configured', async () => {
    mockAuthAs('c1');
    const app = await buildApp({ withDesk: false });
    const res = await app.inject({ method: 'POST', url: '/me/tickets', headers: authHeader('c1'), payload: { category: 'Defects' } });
    expect(res.statusCode).toBe(503);
  });

  it('returns 400 when category is not one of the configured values', async () => {
    mockAuthAs('c1');
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/me/tickets', headers: authHeader('c1'), payload: { category: 'Not A Category' } });
    expect(res.statusCode).toBe(400);
  });

  it('validates category against the live Desk list, not the frozen boot snapshot', async () => {
    // 'Warranty' isn't in deskContext's boot-time snapshot (['General',
    // 'Defects']) but is a category an admin just added in Desk — must be
    // accepted, proving validation reads the same live source the
    // categories screen does, not the stale one.
    mockTicketFields(['General', 'Defects', 'Warranty']);
    mockAuthAs('c1');
    vi.mocked(prisma.contact.findUnique).mockResolvedValue({ id: 'c1', deskContactId: 'dc1' } as never);
    vi.mocked(prisma.ticket.findMany).mockResolvedValue([]);
    vi.mocked(createTicketForContact).mockResolvedValue({ id: 't1' } as never);
    deskClient.getTicket.mockResolvedValue({
      id: 't1',
      ticketNumber: '1001',
      subject: 'Warranty',
      description: null,
      status: 'Open',
      statusType: 'Open',
      category: 'Warranty',
      priority: null,
      departmentId: 'dept1',
      contactId: 'dc1',
      assigneeId: null,
      assignee: null,
      createdTime: '2026-07-17T00:00:00Z',
      modifiedTime: '2026-07-17T00:00:00Z',
    });
    vi.mocked(prisma.ticket.create).mockResolvedValue({ ...ticketRow, category: 'Warranty' } as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/me/tickets', headers: authHeader('c1'), payload: { category: 'Warranty' } });

    expect(res.statusCode).toBe(201);
  });

  it('returns 400 when category is missing entirely', async () => {
    mockAuthAs('c1');
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/me/tickets', headers: authHeader('c1'), payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('creates a ticket end-to-end and busts the tickets cache', async () => {
    mockAuthAs('c1');
    vi.mocked(prisma.contact.findUnique).mockResolvedValue({ id: 'c1', deskContactId: null } as never);
    vi.mocked(prisma.ticket.findMany).mockResolvedValue([]);
    vi.mocked(createTicketForContact).mockResolvedValue({ id: 't1' } as never);
    deskClient.getTicket.mockResolvedValue({
      id: 't1',
      ticketNumber: '1001',
      subject: 'Panels not working',
      description: null,
      status: 'Open',
      statusType: 'Open',
      category: 'Defects',
      priority: null,
      departmentId: 'dept1',
      contactId: 'dc1',
      assigneeId: null,
      assignee: null,
      createdTime: '2026-07-17T00:00:00Z',
      modifiedTime: '2026-07-17T00:00:00Z',
    });
    vi.mocked(prisma.ticket.create).mockResolvedValue(ticketRow as never);
    await redisMock.set('cache:me:tickets:c1', JSON.stringify([{ id: 'stale' }]));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/me/tickets',
      headers: authHeader('c1'),
      payload: { category: 'Defects' },
    });

    expect(res.statusCode).toBe(201);
    // Unwrapped — the RN client reads the created ticket directly off the
    // response body, not nested under a "ticket" key.
    expect(res.json()).toMatchObject({ id: 'ticket-1', subject: 'Panels not working', category: 'Defects' });
    // No client-supplied subject (the app's create screen only collects
    // category + description) — category doubles as the ticket subject.
    expect(createTicketForContact).toHaveBeenCalledWith(
      deskClient,
      expect.objectContaining({ id: 'c1' }),
      expect.objectContaining({ departmentId: 'dept1', subject: 'Defects', category: 'Defects' }),
    );

    const cached = await redisMock.get('cache:me:tickets:c1');
    expect(cached).toBeNull();
  });

  it('returns 409 with the existing open ticket when a duplicate exists in the same category', async () => {
    mockAuthAs('c1');
    vi.mocked(prisma.contact.findUnique).mockResolvedValue({ id: 'c1', deskContactId: 'dc1' } as never);
    vi.mocked(prisma.ticket.findMany).mockResolvedValue([ticketRow] as never);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/me/tickets',
      headers: authHeader('c1'),
      payload: { category: 'Defects' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().existing_ticket).toMatchObject({ id: 'ticket-1' });
    expect(createTicketForContact).not.toHaveBeenCalled();
  });

  it('bypasses the duplicate guard when force:true is set', async () => {
    mockAuthAs('c1');
    vi.mocked(prisma.contact.findUnique).mockResolvedValue({ id: 'c1', deskContactId: 'dc1' } as never);
    vi.mocked(prisma.ticket.findMany).mockResolvedValue([ticketRow] as never);
    vi.mocked(createTicketForContact).mockResolvedValue({ id: 't2' } as never);
    deskClient.getTicket.mockResolvedValue({
      id: 't2',
      ticketNumber: '1002',
      subject: 'Second issue',
      description: null,
      status: 'Open',
      statusType: 'Open',
      category: 'Defects',
      priority: null,
      departmentId: 'dept1',
      contactId: 'dc1',
      assigneeId: null,
      assignee: null,
      createdTime: '2026-07-17T00:00:00Z',
      modifiedTime: '2026-07-17T00:00:00Z',
    });
    vi.mocked(prisma.ticket.create).mockResolvedValue({ ...ticketRow, id: 'ticket-2', deskTicketId: 't2' } as never);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/me/tickets',
      headers: authHeader('c1'),
      payload: { category: 'Defects', force: true },
    });

    expect(res.statusCode).toBe(201);
    expect(createTicketForContact).toHaveBeenCalled();
  });
});

describe('GET /me/tickets', () => {
  it('lists a contact\'s tickets, newest first, and caches the result', async () => {
    mockAuthAs('c1');
    vi.mocked(prisma.ticket.findMany).mockResolvedValue([ticketRow] as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/me/tickets', headers: authHeader('c1') });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([expect.objectContaining({ id: 'ticket-1' })]);
    expect(prisma.ticket.findMany).toHaveBeenCalledWith({ where: { contactId: 'c1' }, orderBy: { createdAt: 'desc' } });
  });
});

describe('GET /me/tickets/:id authorization scoping', () => {
  it('returns 404 when the ticket belongs to a different contact', async () => {
    mockAuthAs('contact-a');
    vi.mocked(prisma.ticket.findFirst).mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/me/tickets/ticket-belonging-to-b', headers: authHeader('contact-a') });

    expect(res.statusCode).toBe(404);
    expect(prisma.ticket.findFirst).toHaveBeenCalledWith({ where: { id: 'ticket-belonging-to-b', contactId: 'contact-a' } });
  });

  it('returns 200 with the ticket detail for a matched owner', async () => {
    mockAuthAs('c1');
    vi.mocked(prisma.ticket.findFirst).mockResolvedValue(ticketRow as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/me/tickets/ticket-1', headers: authHeader('c1') });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'ticket-1', subject: 'Panels not working', closed_at: null });
  });

  it('surfaces closed_at when the underlying ticket is closed', async () => {
    mockAuthAs('c1');
    const closedRow = {
      ...ticketRow,
      status: 'Closed',
      statusDisplay: 'Resolved',
      closedAt: new Date('2026-07-17T13:54:20.000Z'),
      raw: { statusType: 'Closed' },
    };
    vi.mocked(prisma.ticket.findFirst).mockResolvedValue(closedRow as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/me/tickets/ticket-1', headers: authHeader('c1') });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ closed_at: '2026-07-17T13:54:20.000Z', is_closed: true });
  });
});
