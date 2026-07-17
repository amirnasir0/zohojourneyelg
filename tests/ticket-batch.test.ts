import RedisMock from 'ioredis-mock';
import { describe, expect, it, vi } from 'vitest';
import type { TenantConfig } from '../src/config/types.js';
import type { DeskTicket } from '../src/lib/zoho-desk-client.js';

vi.mock('../src/lib/redis.js', () => ({ redis: new RedisMock() }));

const { planTicketBatch } = await import('../src/sync/ticket-batch.js');

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

function makeTicket(overrides: Partial<DeskTicket> = {}): DeskTicket {
  return {
    id: 't1',
    ticketNumber: '1001',
    subject: 'Panels not working',
    description: '<div style="direction: ltr">Customer reported <b>issue</b> with panels.</div>',
    status: 'Open',
    statusType: 'Open',
    category: 'Defects',
    priority: null,
    closedTime: null,
    departmentId: 'dept1',
    contactId: 'dc1',
    assigneeId: 'agent1',
    assignee: { id: 'agent1', firstName: 'SITE SUPERVISOR-', lastName: 'ELGRIS' },
    cf: { cf_co_owner: 'GANESH' },
    customFields: { 'CO-OWNER': 'GANESH' },
    createdTime: '2026-07-17T09:41:54.000Z',
    modifiedTime: '2026-07-17T09:42:05.000Z',
    ...overrides,
  };
}

describe('planTicketBatch', () => {
  it('upserts a ticket for a known desk contact, mapping fields via mapDeskTicketToFields', () => {
    const contactIds = new Map([['dc1', 'local-contact-1']]);
    const { upserts, issues } = planTicketBatch([makeTicket()], tenantConfig, contactIds);

    expect(issues).toEqual([]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      contactId: 'local-contact-1',
      deskTicketId: 't1',
      ticketNumber: '1001',
      subject: 'Panels not working',
      description: 'Customer reported issue with panels.',
      category: 'Defects',
      status: 'Open',
      statusDisplay: 'Open',
      ownerName: 'SITE SUPERVISOR- ELGRIS',
      coOwnerName: 'GANESH',
      priority: null,
    });
  });

  it('translates status through status_display_map', () => {
    const contactIds = new Map([['dc1', 'local-contact-1']]);
    const { upserts } = planTicketBatch([makeTicket({ status: 'Closed', statusType: 'Closed' })], tenantConfig, contactIds);
    expect(upserts[0]?.statusDisplay).toBe('Resolved');
  });

  it('passes through an unmapped status as-is', () => {
    const contactIds = new Map([['dc1', 'local-contact-1']]);
    const { upserts } = planTicketBatch([makeTicket({ status: 'Escalated', statusType: 'Open' })], tenantConfig, contactIds);
    expect(upserts[0]?.statusDisplay).toBe('Escalated');
  });

  it('normalizes "-None-" category/priority to null', () => {
    const contactIds = new Map([['dc1', 'local-contact-1']]);
    const { upserts } = planTicketBatch([makeTicket({ category: '-None-', priority: '-None-' })], tenantConfig, contactIds);
    expect(upserts[0]?.category).toBeNull();
    expect(upserts[0]?.priority).toBeNull();
  });

  it('falls back to customFields[displayLabel] for co-owner when cf is absent', () => {
    const contactIds = new Map([['dc1', 'local-contact-1']]);
    const { cf, ...ticketWithoutCf } = makeTicket();
    const { upserts } = planTicketBatch([ticketWithoutCf as DeskTicket], tenantConfig, contactIds);
    expect(upserts[0]?.coOwnerName).toBe('GANESH');
  });

  it('skips the upsert and logs ORPHAN_TICKET when the Desk contact is not bridged to any local contact', () => {
    const { upserts, issues } = planTicketBatch([makeTicket({ contactId: 'unknown-desk-contact' })], tenantConfig, new Map());

    expect(upserts).toEqual([]);
    expect(issues).toEqual([{ deskTicketId: 't1', field: 'contactId', rawValue: 'unknown-desk-contact', reason: 'ORPHAN_TICKET' }]);
  });

  it('leaves closedAt null for an open ticket', () => {
    const contactIds = new Map([['dc1', 'local-contact-1']]);
    const { upserts } = planTicketBatch([makeTicket({ closedTime: null })], tenantConfig, contactIds);
    expect(upserts[0]?.closedAt).toBeNull();
  });

  it('maps closedAt from Desk\'s closedTime for a closed ticket', () => {
    const contactIds = new Map([['dc1', 'local-contact-1']]);
    const { upserts } = planTicketBatch(
      [makeTicket({ status: 'Closed', statusType: 'Closed', closedTime: '2026-07-17T13:54:20.000Z' })],
      tenantConfig,
      contactIds,
    );
    expect(upserts[0]?.closedAt).toEqual(new Date('2026-07-17T13:54:20.000Z'));
  });
});
