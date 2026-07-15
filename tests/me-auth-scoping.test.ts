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
    journey: { findFirst: vi.fn(), findMany: vi.fn() },
    stageHistory: { findMany: vi.fn() },
  },
}));

vi.mock('../src/lib/jwt.js', () => ({
  verifySessionToken: vi.fn(),
}));

const { prisma } = await import('../src/lib/prisma.js');
const { verifySessionToken } = await import('../src/lib/jwt.js');
const { registerMeRoutes } = await import('../src/routes/me.js');

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
    stages: [
      { type: 'journey', index: 1, crm_value: 'Site Survey', display: 'Site Survey', owner: 'elgris', next_copy: 'x' },
      { type: 'pre_journey', crm_value: 'Need Proposal', display: 'Need Proposal' },
      { type: 'hidden', crm_value: 'Closed Lost', display: 'Closed Lost' },
    ],
  },
  reference_fields: [],
  notifications: {
    otp_channel: ['whatsapp'],
    interakt_otp_template: 'otp_v1',
    stage_change_push: 'x',
    stage_change_whatsapp_template: null,
  },
};

async function buildApp() {
  const app = Fastify();
  app.decorate('tenantConfig', tenantConfig);
  await registerMeRoutes(app);
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

beforeEach(async () => {
  vi.clearAllMocks();
  await redisMock.flushall();
});

describe('GET /me/journeys/:id authorization scoping', () => {
  it('returns 404 when the journey belongs to a different contact, and the query is scoped by contactId', async () => {
    mockAuthAs('contact-a');
    vi.mocked(prisma.journey.findFirst).mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/me/journeys/journey-belonging-to-b',
      headers: { authorization: 'Bearer token-a' },
    });

    expect(res.statusCode).toBe(404);
    expect(prisma.journey.findFirst).toHaveBeenCalledWith({
      where: { id: 'journey-belonging-to-b', contactId: 'contact-a' },
    });
  });

  it('returns 404 (never 403) for a hidden-type stage, same as a nonexistent journey', async () => {
    mockAuthAs('contact-a');
    vi.mocked(prisma.journey.findFirst).mockResolvedValue({
      id: 'j1',
      name: 'Deal 1',
      stage: 'Closed Lost',
      stageIndex: null,
      refValues: {},
      syncedAt: new Date(),
    } as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/me/journeys/j1', headers: { authorization: 'Bearer token-a' } });

    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with stage_timeline for a matched journey-type stage', async () => {
    mockAuthAs('contact-a');
    vi.mocked(prisma.journey.findFirst).mockResolvedValue({
      id: 'j1',
      name: 'Deal 1',
      stage: 'Site Survey',
      stageIndex: 1,
      refValues: {},
      syncedAt: new Date(),
    } as never);
    vi.mocked(prisma.stageHistory.findMany).mockResolvedValue([]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/me/journeys/j1', headers: { authorization: 'Bearer token-a' } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('in_progress');
    expect(body.stage_timeline).toHaveLength(1);
  });
});

describe('GET /me/journeys list shaping', () => {
  it('excludes hidden-type journeys entirely from the list', async () => {
    mockAuthAs('contact-a');
    vi.mocked(prisma.journey.findMany).mockResolvedValue([
      { id: 'j1', name: 'Visible', stage: 'Site Survey', stageIndex: 1, refValues: {}, syncedAt: new Date() },
      { id: 'j2', name: 'Hidden Deal', stage: 'Closed Lost', stageIndex: null, refValues: {}, syncedAt: new Date() },
    ] as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/me/journeys', headers: { authorization: 'Bearer token-a' } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('j1');
  });

  it('includes a pre_journey stage with the pre_journey shape (null progress_pct, no stage_index)', async () => {
    mockAuthAs('contact-a');
    vi.mocked(prisma.journey.findMany).mockResolvedValue([
      { id: 'j3', name: 'Pipeline Deal', stage: 'Need Proposal', stageIndex: null, refValues: {}, syncedAt: new Date() },
    ] as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/me/journeys', headers: { authorization: 'Bearer token-a' } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual([
      expect.objectContaining({
        id: 'j3',
        stage_index: null,
        progress_pct: null,
        status: 'pre_journey',
      }),
    ]);
  });
});

describe('auth failures', () => {
  it('returns 401 with no Authorization header', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/me/journeys/j1' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when the session is revoked', async () => {
    vi.mocked(verifySessionToken).mockResolvedValue({ sub: 'contact-a', jti: 'jti-a' });
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      id: 'sess-1',
      contactId: 'contact-a',
      jti: 'jti-a',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      revokedAt: new Date(),
      createdAt: new Date(),
    } as never);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/me/journeys/j1', headers: { authorization: 'Bearer token-a' } });
    expect(res.statusCode).toBe(401);
  });
});
