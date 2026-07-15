import { describe, expect, it } from 'vitest';
import { chunk } from '../src/sync/chunk.js';

describe('chunk', () => {
  it('splits an array into groups of the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns one chunk when size >= array length', () => {
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it('returns an empty array for empty input', () => {
    expect(chunk([], 5)).toEqual([]);
  });

  it('divides evenly with no remainder', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it('produces batches matching Zoho page-size scale (200)', () => {
    const items = Array.from({ length: 6449 }, (_, i) => i);
    const result = chunk(items, 200);
    expect(result).toHaveLength(33);
    expect(result[0]).toHaveLength(200);
    expect(result.at(-1)).toHaveLength(49);
    expect(result.flat()).toHaveLength(6449);
  });
});
