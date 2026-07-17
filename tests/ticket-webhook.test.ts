import Fastify from 'fastify';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantConfig } from '../src/config/types.js';
import type { DeskTicket } from '../src/lib/zoho-desk-client.js';

process.env.WEBHOOK_SECRET = 'test-webhook-secret';

const redisMock = new RedisMock();
vi.mock('../src/lib/redis.js', () => ({ redis: redisMock }));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    ticket: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    contact: { findUnique: vi.fn() },
  },
}));

const { prisma } = await import('../src/lib/prisma.js');
const { registerWebhookRoutes } = await import('../src/routes/webhooks.js');

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

async function buildApp() {
  const app = Fastify();
  app.decorate('tenantConfig', tenantConfig);
  app.decorate('zohoClient', undefined);
  app.decorate('deskClient', deskClient);
  await registerWebhookRoutes(app);
  return app;
}

function makeTicket(overrides: Partial<DeskTicket> = {}): DeskTicket {
  return {
    id: 't1',
    ticketNumber: '1001',
    subject: 'Panels not working',
    description: null,
    status: 'Open',
    statusType: 'Open',
    category: 'Defects',
    priority: null,
    closedTime: null,
    departmentId: 'dept1',
    contactId: 'dc1',
    assigneeId: null,
    assignee: null,
    createdTime: '2026-07-17T09:41:54.000Z',
    modifiedTime: '2026-07-17T09:42:05.000Z',
    ...overrides,
  };
}

const existingTicketRow = {
  id: 'ticket-row-1',
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
  createdAt: new Date('2026-07-17T09:41:54.000Z'),
  updatedAt: new Date('2026-07-17T09:42:05.000Z'),
  syncedAt: new Date('2026-07-17T09:42:05.000Z'),
  raw: makeTicket(),
};

beforeEach(async () => {
  vi.clearAllMocks();
  await redisMock.flushall();
});

// Real Desk event-subscription envelope shape (confirmed against Zoho's own
// docs, desk.zoho.com/support/WebhookDocument.do#EventsSupported): a
// delivery is a JSON ARRAY of { eventType, payload: { id, ... } } objects.
function deskEvent(eventType: string, ticketId: string | undefined): Record<string, unknown> {
  return { eventType, payload: ticketId === undefined ? {} : { id: ticketId }, eventTime: '2026-07-17T09:42:05.000Z', orgId: '60022843030' };
}

function postWebhook(events: unknown) {
  return async (app: ReturnType<typeof Fastify>) =>
    app.inject({ method: 'POST', url: '/webhooks/zoho/ticket-updated?secret=test-webhook-secret', payload: events });
}

describe('ticket-updated: payload validation and auth', () => {
  it('returns 400 when the body is not an array or object (e.g. a bare JSON null)', async () => {
    const app = await buildApp();
    const res = await postWebhook(null)(app);
    expect(res.statusCode).toBe(400);
  });

  it('rejects with 401 when the secret is wrong', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/zoho/ticket-updated?secret=wrong',
      payload: [deskEvent('Ticket_Update', 't1')],
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('ticket-updated: Desk client unavailable', () => {
  it('returns 503 when deskClient is undefined', async () => {
    const app = Fastify();
    app.decorate('tenantConfig', tenantConfig);
    app.decorate('zohoClient', undefined);
    app.decorate('deskClient', undefined);
    await registerWebhookRoutes(app);

    const res = await postWebhook([deskEvent('Ticket_Update', 't1')])(app);
    expect(res.statusCode).toBe(503);
  });
});

describe('ticket-updated: event-type and payload shape handling', () => {
  it('accepts a single event object (not wrapped in an array) the same way', async () => {
    deskClient.getTicket.mockResolvedValue(makeTicket());
    vi.mocked(prisma.ticket.findUnique).mockResolvedValue(existingTicketRow as never);

    const app = await buildApp();
    const res = await postWebhook(deskEvent('Ticket_Update', 't1'))(app);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, processed: 1 });
  });

  it('ignores an event type it does not handle (e.g. Ticket_Delete) without erroring', async () => {
    const app = await buildApp();
    const res = await postWebhook([deskEvent('Ticket_Delete', 't1')])(app);

    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ event_type: 'Ticket_Delete', ignored: true });
    expect(deskClient.getTicket).not.toHaveBeenCalled();
  });

  it('no-ops that one event when payload.id is missing, without failing the whole delivery', async () => {
    const app = await buildApp();
    const res = await postWebhook([deskEvent('Ticket_Update', undefined)])(app);

    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ event_type: 'Ticket_Update', note: 'missing payload.id' });
  });

  it('processes Ticket_Add the same way as Ticket_Update', async () => {
    deskClient.getTicket.mockResolvedValue(makeTicket());
    vi.mocked(prisma.ticket.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.contact.findUnique).mockResolvedValue({ id: 'c1', deskContactId: 'dc1' } as never);
    vi.mocked(prisma.ticket.create).mockResolvedValue({} as never);

    const app = await buildApp();
    const res = await postWebhook([deskEvent('Ticket_Add', 't1')])(app);

    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ changed: true });
    expect(prisma.ticket.create).toHaveBeenCalled();
  });

  it('processes every event in a batched delivery and reports one result per event', async () => {
    deskClient.getTicket.mockImplementation((id: string) => Promise.resolve(makeTicket({ id })));
    vi.mocked(prisma.ticket.findUnique).mockImplementation(((args: { where: { deskTicketId?: string } }) =>
      Promise.resolve(args.where.deskTicketId === 't1' ? existingTicketRow : null)) as never);
    vi.mocked(prisma.contact.findUnique).mockResolvedValue({ id: 'c2', deskContactId: 'dc1' } as never);
    vi.mocked(prisma.ticket.create).mockResolvedValue({} as never);

    const app = await buildApp();
    const res = await postWebhook([deskEvent('Ticket_Update', 't1'), deskEvent('Ticket_Add', 't2')])(app);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.processed).toBe(2);
    expect(body.results).toHaveLength(2);
    expect(deskClient.getTicket).toHaveBeenCalledTimes(2);
  });
});

describe('ticket-updated: ticket not found in Desk', () => {
  it('no-ops with 200 when getTicket returns null', async () => {
    deskClient.getTicket.mockResolvedValue(null);
    const app = await buildApp();
    const res = await postWebhook([deskEvent('Ticket_Update', 't1')])(app);
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ note: 'ticket not found in Zoho Desk' });
  });
});

describe('ticket-updated: new ticket for a known contact', () => {
  it('creates a local ticket row when the Desk contact is bridged', async () => {
    deskClient.getTicket.mockResolvedValue(makeTicket());
    vi.mocked(prisma.ticket.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.contact.findUnique).mockResolvedValue({ id: 'c1', deskContactId: 'dc1' } as never);
    vi.mocked(prisma.ticket.create).mockResolvedValue({} as never);

    const app = await buildApp();
    const res = await postWebhook([deskEvent('Ticket_Update', 't1')])(app);

    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ changed: true });
    expect(prisma.ticket.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ deskTicketId: 't1', contactId: 'c1', subject: 'Panels not working' }),
    });
  });

  it('no-ops with 200 when the Desk contact is not bridged to any local contact', async () => {
    deskClient.getTicket.mockResolvedValue(makeTicket());
    vi.mocked(prisma.ticket.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.contact.findUnique).mockResolvedValue(null as never);

    const app = await buildApp();
    const res = await postWebhook([deskEvent('Ticket_Update', 't1')])(app);

    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ note: 'ticket belongs to an unknown contact, not tracked' });
    expect(prisma.ticket.create).not.toHaveBeenCalled();
  });
});

describe('ticket-updated: existing ticket diffing', () => {
  it('no-ops with changed:false when nothing tracked actually changed', async () => {
    deskClient.getTicket.mockResolvedValue(makeTicket());
    vi.mocked(prisma.ticket.findUnique).mockResolvedValue(existingTicketRow as never);

    const app = await buildApp();
    const res = await postWebhook([deskEvent('Ticket_Update', 't1')])(app);

    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ changed: false });
    expect(prisma.ticket.update).not.toHaveBeenCalled();
  });

  it('updates the row and busts the tickets cache when the status changes', async () => {
    await redisMock.set('cache:me:tickets:c1', JSON.stringify([{ id: 'ticket-row-1' }]));
    deskClient.getTicket.mockResolvedValue(makeTicket({ status: 'Closed', statusType: 'Closed' }));
    vi.mocked(prisma.ticket.findUnique).mockResolvedValue(existingTicketRow as never);
    vi.mocked(prisma.ticket.update).mockResolvedValue({} as never);

    const app = await buildApp();
    const res = await postWebhook([deskEvent('Ticket_Update', 't1')])(app);

    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ changed: true });
    expect(prisma.ticket.update).toHaveBeenCalledWith({
      where: { id: 'ticket-row-1' },
      data: expect.objectContaining({ status: 'Closed', statusDisplay: 'Resolved' }),
    });

    const cached = await redisMock.get('cache:me:tickets:c1');
    expect(cached).toBeNull();
  });

  it('sets closedAt from Desk\'s closedTime when the ticket closes', async () => {
    deskClient.getTicket.mockResolvedValue(makeTicket({ status: 'Closed', statusType: 'Closed', closedTime: '2026-07-17T13:54:20.000Z' }));
    vi.mocked(prisma.ticket.findUnique).mockResolvedValue(existingTicketRow as never);
    vi.mocked(prisma.ticket.update).mockResolvedValue({} as never);

    const app = await buildApp();
    const res = await postWebhook([deskEvent('Ticket_Update', 't1')])(app);

    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ changed: true });
    expect(prisma.ticket.update).toHaveBeenCalledWith({
      where: { id: 'ticket-row-1' },
      data: expect.objectContaining({ closedAt: new Date('2026-07-17T13:54:20.000Z') }),
    });
  });

  it('clears closedAt back to null when a closed ticket is reopened', async () => {
    const closedRow = { ...existingTicketRow, status: 'Closed', statusDisplay: 'Resolved', closedAt: new Date('2026-07-17T13:54:20.000Z') };
    deskClient.getTicket.mockResolvedValue(makeTicket({ status: 'Open', statusType: 'Open', closedTime: null }));
    vi.mocked(prisma.ticket.findUnique).mockResolvedValue(closedRow as never);
    vi.mocked(prisma.ticket.update).mockResolvedValue({} as never);

    const app = await buildApp();
    const res = await postWebhook([deskEvent('Ticket_Update', 't1')])(app);

    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ changed: true });
    expect(prisma.ticket.update).toHaveBeenCalledWith({
      where: { id: 'ticket-row-1' },
      data: expect.objectContaining({ status: 'Open', closedAt: null }),
    });
  });
});
