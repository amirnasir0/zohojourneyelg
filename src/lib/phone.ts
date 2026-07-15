/**
 * Normalizes an Indian mobile number to E.164 (+91XXXXXXXXXX), per PRD §8.
 * Returns null if the input cannot be normalized to a valid 10-digit
 * number starting 6-9.
 */
export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/[\s\-()]/g, '');

  if (digits.startsWith('+91')) {
    digits = digits.slice(3);
  } else if (digits.length === 13 && digits.startsWith('091')) {
    digits = digits.slice(3);
  } else if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  // else: leave as-is. A bare 10-digit number is never prefix-stripped, even
  // if it happens to start with "91" (e.g. 9158500015 is a complete, valid
  // number, not a 91-country-code-prefixed 8-digit one).

  if (!/^[6-9]\d{9}$/.test(digits)) {
    return null;
  }

  return `+91${digits}`;
}
