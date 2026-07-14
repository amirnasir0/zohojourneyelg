import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../src/lib/phone.js';

describe('normalizePhone', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['+919876543210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['(98) 765-432 10', '+919876543210'],
    ['0919876543210', '+919876543210'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([
    ['5876543210', 'starts with 5, not 6-9'],
    ['987654321', 'too short (9 digits)'],
    ['98765432100', 'too long (11 digits)'],
    ['98765abcde', 'non-numeric garbage'],
    ['', 'empty string'],
  ])('rejects %s (%s)', (input) => {
    expect(normalizePhone(input)).toBeNull();
  });
});
