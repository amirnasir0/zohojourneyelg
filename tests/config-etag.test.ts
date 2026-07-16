import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { TenantConfig } from '../src/config/types.js';
import { registerConfigRoutes } from '../src/routes/config.js';

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
    stages: [{ type: 'journey', index: 1, crm_value: 'Site Survey', display: 'Site Survey', owner: 'elgris', next_copy: 'x' }],
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
  },
};

async function buildApp() {
  const app = Fastify();
  app.decorate('tenantConfig', tenantConfig);
  await registerConfigRoutes(app);
  return app;
}

describe('GET /config ETag/304 behavior', () => {
  it('returns 200 with an ETag and Cache-Control on first request', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/config' });

    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBeTruthy();
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.json().tenant.display_name).toBe('Elgris Solar');
  });

  it('returns 304 with an empty body when If-None-Match matches the current ETag', async () => {
    const app = await buildApp();
    const first = await app.inject({ method: 'GET', url: '/config' });
    const etag = first.headers.etag as string;

    const second = await app.inject({ method: 'GET', url: '/config', headers: { 'if-none-match': etag } });

    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
  });

  it('returns 200 again when If-None-Match does not match', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/config', headers: { 'if-none-match': '"stale-etag"' } });
    expect(res.statusCode).toBe(200);
  });
});
