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
    syncIssue: { createMany: vi.fn() },
  },
}));

const { prisma } = await import('../src/lib/prisma.js');
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
    journey_module: 'Deals',
    contact_phone_fields: ['Phone'],
    journey_stage_field: 'Stage',
    journey_name_field: 'Deal_Name',
    journey_contact_lookup_field: 'Contact_Name',
  },
  journey: {
    label_singular: 'Project',
    label_plural: 'Projects',
    empty_state_copy: 'Your project is being set up.',
    stages: [
      { type: 'journey', index: 1, crm_value: 'Site Survey', display: 'Site Survey', owner: 'elgris', next_copy: 'x' },
      { type: 'journey', index: 2, crm_value: 'Design & Quotation', display: 'Design & Quotation', owner: 'elgris', next_copy: 'y' },
    ],
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
  },
};

async function buildApp() {
  const app = Fastify();
  app.decorate('tenantConfig', tenantConfig);
  app.decorate('zohoClient', undefined);
  await registerWebhookRoutes(app);
  return app;
}

const validPayload = {
  record_id: 'd1',
  stage: 'Design & Quotation',
  contact_id: 'zc1',
  changed_at: '2026-07-16T10:00:00Z',
};

const existingJourney = {
  id: 'j1',
  zohoRecordId: 'd1',
  contactId: 'c1',
  name: 'Deal 1',
  stage: 'Site Survey',
  stageIndex: 1,
  refValues: {},
  raw: {},
  syncedAt: new Date('2026-07-01T00:00:00Z'),
};

beforeEach(async () => {
  vi.clearAllMocks();
  await redisMock.flushall();
  vi.mocked(prisma.journey.findUnique).mockResolvedValue(existingJourney as never);
  vi.mocked(prisma.journey.update).mockResolvedValue(existingJourney as never);
  vi.mocked(prisma.stageHistory.create).mockResolvedValue({} as never);
  vi.mocked(prisma.syncIssue.createMany).mockResolvedValue({ count: 1 } as never);
});

describe('webhook secret validation', () => {
  it('rejects with 401 when no secret is provided', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/webhooks/zoho/journey-updated', payload: validPayload });
    expect(res.statusCode).toBe(401);
  });

  it('rejects with 401 when the query param secret is wrong', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/webhooks/zoho/journey-updated?secret=wrong', payload: validPayload });
    expect(res.statusCode).toBe(401);
  });

  it('rejects with 401 when the body field secret is wrong', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/webhooks/zoho/journey-updated', payload: { ...validPayload, secret: 'wrong' } });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a correct secret via query param', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/webhooks/zoho/journey-updated?secret=test-webhook-secret', payload: validPayload });
    expect(res.statusCode).toBe(200);
  });

  it('accepts a correct secret via body field', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/webhooks/zoho/journey-updated', payload: { ...validPayload, secret: 'test-webhook-secret' } });
    expect(res.statusCode).toBe(200);
  });
});

describe('journey-updated stage-change happy path', () => {
  it('updates the journey, writes StageHistory, and busts the journeys cache for that contact', async () => {
    await redisMock.set('cache:me:journeys:c1', JSON.stringify([{ id: 'j1' }]));

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/webhooks/zoho/journey-updated?secret=test-webhook-secret', payload: validPayload });

    expect(res.statusCode).toBe(200);
    expect(prisma.journey.update).toHaveBeenCalledWith({
      where: { id: 'j1' },
      data: { stage: 'Design & Quotation', stageIndex: 2, syncedAt: expect.any(Date) },
    });
    expect(prisma.stageHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        journeyId: 'j1',
        fromStage: 'Site Survey',
        toStage: 'Design & Quotation',
        source: 'WEBHOOK',
        dedupeKey: expect.stringContaining('j1:Design & Quotation:'),
      }),
    });
    expect(prisma.syncIssue.createMany).not.toHaveBeenCalled();

    const cached = await redisMock.get('cache:me:journeys:c1');
    expect(cached).toBeNull();
  });
});

describe('duplicate delivery idempotency', () => {
  it('does not fail or duplicate on a repeat delivery within the same minute bucket', async () => {
    const dupError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`dedupe_key`)', {
      code: 'P2002',
      clientVersion: '5.22.0',
    });

    vi.mocked(prisma.stageHistory.create).mockResolvedValueOnce({} as never).mockRejectedValueOnce(dupError);

    const app = await buildApp();

    const first = await app.inject({ method: 'POST', url: '/webhooks/zoho/journey-updated?secret=test-webhook-secret', payload: validPayload });
    const second = await app.inject({ method: 'POST', url: '/webhooks/zoho/journey-updated?secret=test-webhook-secret', payload: validPayload });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(prisma.stageHistory.create).toHaveBeenCalledTimes(2);
  });

  it('rethrows and 500s on a genuine (non-duplicate) database error', async () => {
    vi.mocked(prisma.stageHistory.create).mockRejectedValueOnce(new Error('connection lost'));

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/webhooks/zoho/journey-updated?secret=test-webhook-secret', payload: validPayload });

    expect(res.statusCode).toBe(500);
  });
});

describe('unknown-stage value handling', () => {
  it('resolves stageIndex to null, logs a SyncIssue, and still returns 200 without crashing', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/zoho/journey-updated?secret=test-webhook-secret',
      payload: { ...validPayload, stage: 'Some Renamed Zoho Stage' },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.journey.update).toHaveBeenCalledWith({
      where: { id: 'j1' },
      data: { stage: 'Some Renamed Zoho Stage', stageIndex: null, syncedAt: expect.any(Date) },
    });
    expect(prisma.syncIssue.createMany).toHaveBeenCalledWith({
      data: [{ zohoRecordId: 'd1', recordType: 'journey', field: 'Stage', rawValue: 'Some Renamed Zoho Stage', reason: 'UNKNOWN_STAGE' }],
      skipDuplicates: true,
    });
    expect(prisma.stageHistory.create).toHaveBeenCalled();
  });
});

describe('payload validation', () => {
  it('returns 400 when a required field is missing', async () => {
    const app = await buildApp();
    const { stage: _stage, ...incomplete } = validPayload;
    const res = await app.inject({ method: 'POST', url: '/webhooks/zoho/journey-updated?secret=test-webhook-secret', payload: incomplete });
    expect(res.statusCode).toBe(400);
  });
});
