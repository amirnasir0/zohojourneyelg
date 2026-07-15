import { normalizePhone } from '../lib/phone.js';

export interface PhoneIngestIssue {
  field: string;
  rawValue: string;
  reason: string;
}

export interface PhoneIngestResult {
  mobileE164: string | null;
  altMobileE164: string | null;
  issues: PhoneIngestIssue[];
}

/**
 * Walks contact_phone_fields in tenant-config order. First valid number becomes
 * mobile_e164; the first later field with a *distinct* valid number becomes
 * alt_mobile_e164. Non-empty values that fail normalization are logged as issues
 * but never abort ingest — later fields are still evaluated.
 */
export function ingestContactPhones(raw: Record<string, unknown>, phoneFields: string[]): PhoneIngestResult {
  const issues: PhoneIngestIssue[] = [];
  const validNumbers: string[] = [];

  for (const field of phoneFields) {
    const rawValue = raw[field];
    if (rawValue === null || rawValue === undefined || rawValue === '') {
      continue;
    }

    const strValue = String(rawValue);
    const normalized = normalizePhone(strValue);

    if (!normalized) {
      issues.push({ field, rawValue: strValue, reason: 'UNPARSEABLE_PHONE' });
      continue;
    }

    if (!validNumbers.includes(normalized)) {
      validNumbers.push(normalized);
    }
  }

  if (validNumbers.length === 0) {
    issues.push({ field: phoneFields.join(','), rawValue: '', reason: 'NO_VALID_MOBILE' });
  }

  return {
    mobileE164: validNumbers[0] ?? null,
    altMobileE164: validNumbers[1] ?? null,
    issues,
  };
}
