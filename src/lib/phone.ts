/**
 * Normalizes an Indian mobile number to E.164 (+91XXXXXXXXXX), per PRD §8.
 * Returns null if the input cannot be normalized to a valid 10-digit
 * number starting 6-9.
 */
export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/[\s\-()]/g, '');
  digits = digits.replace(/^0/, '');
  digits = digits.replace(/^(\+91|91)/, '');

  if (!/^[6-9]\d{9}$/.test(digits)) {
    return null;
  }

  return `+91${digits}`;
}
