import RedisMock from 'ioredis-mock';
import { describe, expect, it, vi } from 'vitest';
import type { TenantConfig } from '../src/config/types.js';

vi.mock('../src/lib/redis.js', () => ({ redis: new RedisMock() }));

const { planJourneyBatch } = await import('../src/sync/journey-batch.js');

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
    contact_phone_fields: ['Phone', 'Mobile'],
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
  reference_fields: [{ crm_field: 'National_Portal_No', display: 'National Portal No.' }],
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

describe('planJourneyBatch', () => {
  it('upserts a journey with a known stage and resolved contact', () => {
    const contactIds = new Map([['zc1', 'local-contact-1']]);
    const { upserts, issues } = planJourneyBatch(
      [{ id: 'd1', Stage: 'Site Survey', Deal_Name: 'Deal 1', Contact_Name: { id: 'zc1' }, National_Portal_No: 'NP-1' }],
      tenantConfig,
      contactIds,
    );

    expect(issues).toEqual([]);
    expect(upserts).toEqual([
      {
        zohoRecordId: 'd1',
        contactId: 'local-contact-1',
        name: 'Deal 1',
        stage: 'Site Survey',
        stageIndex: 1,
        refValues: { National_Portal_No: 'NP-1' },
        raw: { id: 'd1', Stage: 'Site Survey', Deal_Name: 'Deal 1', Contact_Name: { id: 'zc1' }, National_Portal_No: 'NP-1' },
      },
    ]);
  });

  it('resolves an unknown stage to null index but still upserts, logging UNKNOWN_STAGE', () => {
    const contactIds = new Map([['zc1', 'local-contact-1']]);
    const { upserts, issues } = planJourneyBatch([{ id: 'd1', Stage: 'Closed Won', Contact_Name: { id: 'zc1' } }], tenantConfig, contactIds);

    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.stageIndex).toBeNull();
    expect(issues).toEqual([{ zohoRecordId: 'd1', field: 'Stage', rawValue: 'Closed Won', reason: 'UNKNOWN_STAGE' }]);
  });

  it('logs MISSING_STAGE when the stage field is absent, but still upserts if a contact resolves', () => {
    const contactIds = new Map([['zc1', 'local-contact-1']]);
    const { upserts, issues } = planJourneyBatch([{ id: 'd1', Contact_Name: { id: 'zc1' } }], tenantConfig, contactIds);

    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.stageIndex).toBeNull();
    expect(issues).toEqual([{ zohoRecordId: 'd1', field: 'Stage', rawValue: '', reason: 'MISSING_STAGE' }]);
  });

  it('skips the upsert and logs ORPHAN_JOURNEY when the linked contact is not in the resolved map', () => {
    const { upserts, issues } = planJourneyBatch([{ id: 'd1', Stage: 'Site Survey', Contact_Name: { id: 'zc-missing' } }], tenantConfig, new Map());

    expect(upserts).toEqual([]);
    expect(issues).toEqual([{ zohoRecordId: 'd1', field: 'Contact_Name', rawValue: 'zc-missing', reason: 'ORPHAN_JOURNEY' }]);
  });

  it('skips the upsert and logs ORPHAN_JOURNEY when the contact lookup field itself is empty', () => {
    const { upserts, issues } = planJourneyBatch([{ id: 'd1', Stage: 'Site Survey', Contact_Name: null }], tenantConfig, new Map());

    expect(upserts).toEqual([]);
    expect(issues).toEqual([{ zohoRecordId: 'd1', field: 'Contact_Name', rawValue: '', reason: 'ORPHAN_JOURNEY' }]);
  });
});

describe('planJourneyBatch — date-driven mode', () => {
  const dateDrivenConfig: TenantConfig = {
    ...tenantConfig,
    journey: {
      ...tenantConfig.journey,
      stages: [
        { type: 'journey', index: 1, crm_value: 'Sales Order', date_field: 'Sales_Order', display: 'Sales Order', owner: 'elgris', next_copy: 'x' },
        { type: 'journey', index: 2, crm_value: 'Construction', date_field: 'Construction_Date', display: 'Construction', owner: 'elgris', next_copy: 'y' },
      ],
    },
    reference_fields: [
      { crm_field: 'Sales_Order', display: 'Sales Order Date' },
      { crm_field: 'Construction_Date', display: 'Construction Date' },
    ],
  };

  it('computes stageIndex from date fields, ignoring a blank Stage value with no MISSING_STAGE issue', () => {
    const contactIds = new Map([['zc1', 'local-contact-1']]);
    const { upserts, issues } = planJourneyBatch(
      [{ id: 'so1', Contact_Name: { id: 'zc1' }, Construction_Date: '2026-03-01' }],
      dateDrivenConfig,
      contactIds,
    );

    expect(issues).toEqual([]);
    expect(upserts[0]?.stageIndex).toBe(2);
    expect(upserts[0]?.stage).toBe('');
  });

  it('does not log UNKNOWN_STAGE even when the raw Stage value matches nothing configured', () => {
    const contactIds = new Map([['zc1', 'local-contact-1']]);
    const { issues } = planJourneyBatch(
      [{ id: 'so1', Stage: 'stage', Contact_Name: { id: 'zc1' } }],
      dateDrivenConfig,
      contactIds,
    );
    expect(issues).toEqual([]);
  });

  it('still logs ORPHAN_JOURNEY when the contact does not resolve, same as value-matched mode', () => {
    const { upserts, issues } = planJourneyBatch(
      [{ id: 'so1', Contact_Name: { id: 'zc-missing' } }],
      dateDrivenConfig,
      new Map(),
    );
    expect(upserts).toEqual([]);
    expect(issues).toEqual([{ zohoRecordId: 'so1', field: 'Contact_Name', rawValue: 'zc-missing', reason: 'ORPHAN_JOURNEY' }]);
  });
});
