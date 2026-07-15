import { describe, expect, it } from 'vitest';
import { ingestContactPhones } from '../src/sync/phone-ingest.js';

describe('ingestContactPhones', () => {
  it('uses the first valid field as mobile and second distinct valid field as alt', () => {
    const result = ingestContactPhones({ Phone: '9876543210', Mobile: '7012345678' }, ['Phone', 'Mobile']);
    expect(result.mobileE164).toBe('+919876543210');
    expect(result.altMobileE164).toBe('+917012345678');
    expect(result.issues).toEqual([]);
  });

  it('does not set alt when both fields normalize to the same number (dedupe)', () => {
    const result = ingestContactPhones({ Phone: '9876543210', Mobile: '09876543210' }, ['Phone', 'Mobile']);
    expect(result.mobileE164).toBe('+919876543210');
    expect(result.altMobileE164).toBeNull();
    expect(result.issues).toEqual([]);
  });

  it('logs an issue for an unparseable non-empty field but keeps evaluating later fields', () => {
    const result = ingestContactPhones({ Phone: 'not-a-number', Mobile: '9876543210' }, ['Phone', 'Mobile']);
    expect(result.mobileE164).toBe('+919876543210');
    expect(result.altMobileE164).toBeNull();
    expect(result.issues).toEqual([{ field: 'Phone', rawValue: 'not-a-number', reason: 'UNPARSEABLE_PHONE' }]);
  });

  it('does not flag empty/missing fields as issues', () => {
    const result = ingestContactPhones({ Phone: '', Mobile: '9876543210' }, ['Phone', 'Mobile']);
    expect(result.mobileE164).toBe('+919876543210');
    expect(result.issues).toEqual([]);
  });

  it('produces a NO_VALID_MOBILE issue when no field yields a valid number and skips the contact', () => {
    const result = ingestContactPhones({ Phone: '', Mobile: null }, ['Phone', 'Mobile']);
    expect(result.mobileE164).toBeNull();
    expect(result.altMobileE164).toBeNull();
    expect(result.issues).toEqual([{ field: 'Phone,Mobile', rawValue: '', reason: 'NO_VALID_MOBILE' }]);
  });

  it('reports NO_VALID_MOBILE alongside per-field issues when every field is invalid', () => {
    const result = ingestContactPhones({ Phone: 'garbage', Mobile: '12345' }, ['Phone', 'Mobile']);
    expect(result.mobileE164).toBeNull();
    expect(result.issues).toEqual([
      { field: 'Phone', rawValue: 'garbage', reason: 'UNPARSEABLE_PHONE' },
      { field: 'Mobile', rawValue: '12345', reason: 'UNPARSEABLE_PHONE' },
      { field: 'Phone,Mobile', rawValue: '', reason: 'NO_VALID_MOBILE' },
    ]);
  });
});
