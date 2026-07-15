import { describe, expect, it } from 'vitest';
import { planContactBatch } from '../src/sync/contact-batch.js';

const PHONE_FIELDS = ['Phone', 'Mobile'];

describe('planContactBatch', () => {
  it('upserts a record with a valid mobile and no conflicts', () => {
    const raw = { id: 'c1', Phone: '9876543210', Full_Name: 'A', Email: 'a@x.com' };
    const { upserts, issues } = planContactBatch([raw], PHONE_FIELDS, new Map());

    expect(upserts).toEqual([{ zohoContactId: 'c1', mobileE164: '+919876543210', altMobileE164: null, fullName: 'A', email: 'a@x.com', raw }]);
    expect(issues).toEqual([]);
  });

  it('flags a cross-batch conflict against an existing different owner and skips the upsert', () => {
    const existing = new Map([['+919876543210', 'other-contact-id']]);
    const { upserts, issues } = planContactBatch([{ id: 'c1', Phone: '9876543210' }], PHONE_FIELDS, existing);

    expect(upserts).toEqual([]);
    expect(issues).toEqual([{ zohoRecordId: 'c1', field: 'mobile_e164', rawValue: '+919876543210', reason: 'DUPLICATE_MOBILE' }]);
  });

  it('does not flag a conflict when the existing owner is the same contact (an update, not a duplicate)', () => {
    const existing = new Map([['+919876543210', 'c1']]);
    const { upserts, issues } = planContactBatch([{ id: 'c1', Phone: '9876543210' }], PHONE_FIELDS, existing);

    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.zohoContactId).toBe('c1');
    expect(issues).toEqual([]);
  });

  it('flags an in-batch conflict when two records in the same batch claim the same mobile', () => {
    const { upserts, issues } = planContactBatch(
      [
        { id: 'c1', Phone: '9876543210' },
        { id: 'c2', Phone: '9876543210' },
      ],
      PHONE_FIELDS,
      new Map(),
    );

    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.zohoContactId).toBe('c1');
    expect(issues).toEqual([{ zohoRecordId: 'c2', field: 'mobile_e164', rawValue: '+919876543210', reason: 'DUPLICATE_MOBILE' }]);
  });

  it('passes through phone-ingest issues (unparseable, no valid mobile) without upserting', () => {
    const { upserts, issues } = planContactBatch([{ id: 'c1', Phone: 'garbage', Mobile: '' }], PHONE_FIELDS, new Map());

    expect(upserts).toEqual([]);
    expect(issues).toEqual([
      { zohoRecordId: 'c1', field: 'Phone', rawValue: 'garbage', reason: 'UNPARSEABLE_PHONE' },
      { zohoRecordId: 'c1', field: 'Phone,Mobile', rawValue: '', reason: 'NO_VALID_MOBILE' },
    ]);
  });

  it('processes independent records in the same batch normally', () => {
    const { upserts, issues } = planContactBatch(
      [
        { id: 'c1', Phone: '9876543210' },
        { id: 'c2', Phone: '7012345678' },
      ],
      PHONE_FIELDS,
      new Map(),
    );

    expect(upserts.map((u) => u.zohoContactId)).toEqual(['c1', 'c2']);
    expect(issues).toEqual([]);
  });
});
