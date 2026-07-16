import Fastify from 'fastify';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantConfig } from '../src/config/types.js';

process.env.WEBHOOK_SECRET = 'test-webhook-secret';

const redisMock = new RedisMock();
vi.mock('../src/lib/redis.js', () => ({ redis: redisMock }));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    journey: { findUnique: vi.fn(), update: vi.fn() },
    stageHistory: { create: vi.fn() },
  },
}));

vi.mock('../src/sync/journey-batch.js', () => ({
  writeJourneyBatch: vi.fn(),
}));

const { prisma } = await import('../src/lib/prisma.js');
const { writeJourneyBatch } = await import('../src/sync/journey-batch.js');
const { registerWebhookRoutes } = await import('../src/routes/webhooks.js');
const { Prisma } = await import('@prisma/client');

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
    stages: [
      { type: 'journey', index: 1, crm_value: 'Sales Order', date_field: 'Sales_Order', display: 'Sales Order Placed', owner: 'elgris', next_copy: 'a' },
      { type: 'journey', index: 2, crm_value: 'Construction', date_field: 'Construction_Date', display: 'Construction', owner: 'elgris', next_copy: 'b' },
      { type: 'journey', index: 3, crm_value: 'Net Metering', date_field: 'Net_Metering_Date', display: 'Net Metering', owner: 'discom', next_copy: 'c' },
    ],
  },
  reference_fields: [
    { crm_field: 'Sales_Order', display: 'Sales Order Date' },
    { crm_field: 'Construction_Date', display: 'Construction Date' },
    { crm_field: 'Net_Metering_Date', display: 'Net Metering Date' },
  ],
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
  },
};

const zohoClient = {
  getRecords: vi.fn(),
  getRecordsPage: vi.fn(),
  getRecord: vi.fn(),
  getModuleFields: vi.fn(),
};

async function buildApp() {
  const app = Fastify();
  app.decorate('tenantConfig', tenantConfig);
  app.decorate('zohoClient', zohoClient);
  await registerWebhookRoutes(app);
  return app;
}

const existingJourney = {
  id: 'j1',
  zohoRecordId: 'so1',
  contactId: 'c1',
  name: 'SO 1',
  stage: '',
  stageIndex: 1,
  refValues: { Sales_Order: '2026-01-01', Construction_Date: null, Net_Metering_Date: null },
  raw: { Created_Time: '2026-01-01T00:00:00Z' },
  syncedAt: new Date('2026-01-01T00:00:00Z'),
};

beforeEach(async () => {
  vi.clearAllMocks();
  await redisMock.flushall();
  vi.mocked(prisma.journey.findUnique).mockResolvedValue(existingJourney as never);
  vi.mocked(prisma.journey.update).mockImplementation(((args: { data: object }) => Promise.resolve({ ...existingJourney, ...args.data })) as never);
  vi.mocked(prisma.stageHistory.create).mockResolvedValue({} as never);
});

function postWebhook(body: object) {
  return async (app: ReturnType<typeof Fastify>) =>
    app.inject({ method: 'POST', url: '/webhooks/zoho/salesorder-updated?secret=test-webhook-secret', payload: body });
}

describe('salesorder-updated: irrelevant edit is a true no-op', () => {
  it('returns 200 stage_changed:false and never writes to the DB when nothing tracked changed', async () => {
    zohoClient.getRecord.mockResolvedValue({
      id: 'so1',
      Stage: '',
      Subject: 'SO 1',
      Sales_Order: '2026-01-01',
      Construction_Date: null,
      Net_Metering_Date: null,
      Contact_Name: { id: 'zc1' },
    });

    const app = await buildApp();
    const res = await postWebhook({ record_id: 'so1' })(app);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, stage_changed: false });
    expect(prisma.journey.update).not.toHaveBeenCalled();
    expect(prisma.stageHistory.create).not.toHaveBeenCalled();
  });
});

describe('salesorder-updated: date change derives a new stage and writes StageHistory', () => {
  it('moves stage_index forward when a later date field gets filled in', async () => {
    zohoClient.getRecord.mockResolvedValue({
      id: 'so1',
      Stage: '',
      Subject: 'SO 1',
      Sales_Order: '2026-01-01',
      Construction_Date: '2026-02-01',
      Net_Metering_Date: null,
      Contact_Name: { id: 'zc1' },
    });

    const app = await buildApp();
    const res = await postWebhook({ record_id: 'so1' })(app);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, stage_changed: true });

    expect(prisma.journey.update).toHaveBeenCalledWith({
      where: { id: 'j1' },
      data: expect.objectContaining({
        stageIndex: 2,
        refValues: { Sales_Order: '2026-01-01', Construction_Date: '2026-02-01', Net_Metering_Date: null },
      }),
    });

    expect(prisma.stageHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        journeyId: 'j1',
        fromStage: 'Sales Order Placed',
        toStage: 'Construction',
        source: 'WEBHOOK',
      }),
    });
  });

  it('busts the contact journeys cache when the stage changes', async () => {
    await redisMock.set('cache:me:journeys:c1', JSON.stringify([{ id: 'j1' }]));
    zohoClient.getRecord.mockResolvedValue({
      id: 'so1',
      Stage: '',
      Subject: 'SO 1',
      Sales_Order: '2026-01-01',
      Construction_Date: '2026-02-01',
      Net_Metering_Date: null,
      Contact_Name: { id: 'zc1' },
    });

    const app = await buildApp();
    await postWebhook({ record_id: 'so1' })(app);

    const cached = await redisMock.get('cache:me:journeys:c1');
    expect(cached).toBeNull();
  });
});

describe('salesorder-updated: duplicate delivery idempotency', () => {
  it('does not fail or duplicate on a repeat delivery within the same minute bucket', async () => {
    const dupError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`dedupe_key`)', {
      code: 'P2002',
      clientVersion: '5.22.0',
    });
    vi.mocked(prisma.stageHistory.create).mockResolvedValueOnce({} as never).mockRejectedValueOnce(dupError);

    zohoClient.getRecord.mockResolvedValue({
      id: 'so1',
      Stage: '',
      Subject: 'SO 1',
      Sales_Order: '2026-01-01',
      Construction_Date: '2026-02-01',
      Net_Metering_Date: null,
      Contact_Name: { id: 'zc1' },
    });

    const app = await buildApp();
    const first = await postWebhook({ record_id: 'so1' })(app);
    const second = await postWebhook({ record_id: 'so1' })(app);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(prisma.stageHistory.create).toHaveBeenCalledTimes(2);
  });

  it('rethrows and 500s on a genuine (non-duplicate) database error', async () => {
    vi.mocked(prisma.stageHistory.create).mockRejectedValueOnce(new Error('connection lost'));
    zohoClient.getRecord.mockResolvedValue({
      id: 'so1',
      Stage: '',
      Subject: 'SO 1',
      Sales_Order: '2026-01-01',
      Construction_Date: '2026-02-01',
      Net_Metering_Date: null,
      Contact_Name: { id: 'zc1' },
    });

    const app = await buildApp();
    const res = await postWebhook({ record_id: 'so1' })(app);
    expect(res.statusCode).toBe(500);
  });
});

describe('salesorder-updated: record not yet synced locally', () => {
  it('fetches and creates the journey via writeJourneyBatch, then writes an initial StageHistory row', async () => {
    vi.mocked(prisma.journey.findUnique).mockResolvedValueOnce(null as never).mockResolvedValueOnce({
      ...existingJourney,
      id: 'j2',
      contactId: 'c2',
    } as never);
    vi.mocked(writeJourneyBatch).mockResolvedValue({ written: 1, issues: 0 });

    zohoClient.getRecord.mockResolvedValue({
      id: 'so1',
      Stage: '',
      Subject: 'SO 1',
      Sales_Order: '2026-01-01',
      Construction_Date: null,
      Net_Metering_Date: null,
      Contact_Name: { id: 'zc1' },
    });

    const app = await buildApp();
    const res = await postWebhook({ record_id: 'so1' })(app);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, stage_changed: true });
    expect(writeJourneyBatch).toHaveBeenCalled();
    expect(prisma.stageHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ journeyId: 'j2', fromStage: null, source: 'WEBHOOK' }),
    });
  });
});

describe('salesorder-updated: payload validation', () => {
  it('returns 400 when record_id is missing', async () => {
    const app = await buildApp();
    const res = await postWebhook({})(app);
    expect(res.statusCode).toBe(400);
  });

  it('rejects with 401 when the secret is wrong', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/webhooks/zoho/salesorder-updated?secret=wrong', payload: { record_id: 'so1' } });
    expect(res.statusCode).toBe(401);
  });
});
