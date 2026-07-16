import { describe, expect, it } from 'vitest';
import { extractCreatedTime, isDateDrivenJourney, resolveDateDrivenStage } from '../src/sync/date-stage-resolve.js';
import type { TenantConfig } from '../src/config/types.js';

type Stage = TenantConfig['journey']['stages'][number];

function dateStage(index: number, dateField: string): Stage {
  return {
    type: 'journey',
    index,
    crm_value: `crm-${index}`,
    date_field: dateField,
    display: `Stage ${index}`,
    owner: 'elgris',
    next_copy: `next copy ${index}`,
  };
}

const threeStages: Stage[] = [dateStage(1, 'D1'), dateStage(2, 'D2'), dateStage(3, 'D3')];
const valueMatchedStage: Stage = {
  type: 'journey',
  index: 1,
  crm_value: 'Site Survey',
  display: 'Site Survey',
  owner: 'elgris',
  next_copy: 'x',
};

describe('isDateDrivenJourney', () => {
  it('is true when any journey-type stage has a date_field', () => {
    expect(isDateDrivenJourney(threeStages)).toBe(true);
  });

  it('is false when no stage has a date_field (value-matched tenants unaffected)', () => {
    expect(isDateDrivenJourney([valueMatchedStage])).toBe(false);
  });

  it('is false for an empty stage list', () => {
    expect(isDateDrivenJourney([])).toBe(false);
  });
});

describe('extractCreatedTime', () => {
  it('parses a valid Created_Time string', () => {
    const result = extractCreatedTime({ Created_Time: '2026-05-01T10:00:00+05:30' });
    expect(result).toEqual(new Date('2026-05-01T10:00:00+05:30'));
  });

  it('returns null when Created_Time is missing', () => {
    expect(extractCreatedTime({})).toBeNull();
  });

  it('returns null for null/undefined raw', () => {
    expect(extractCreatedTime(null)).toBeNull();
    expect(extractCreatedTime(undefined)).toBeNull();
  });

  it('returns null for an unparseable Created_Time value', () => {
    expect(extractCreatedTime({ Created_Time: 'not-a-date' })).toBeNull();
  });
});

describe('resolveDateDrivenStage', () => {
  it('resolves the highest-filled-date stage as current when all dates are filled in order', () => {
    const refValues = { D1: '2026-01-01', D2: '2026-01-05', D3: '2026-01-10' };
    const { stageIndex, timeline } = resolveDateDrivenStage(threeStages, refValues, null);

    expect(stageIndex).toBe(3);
    expect(timeline).toEqual([
      { index: 1, display: 'Stage 1', status: 'completed', changed_at: new Date('2026-01-01'), next_copy: 'next copy 1' },
      { index: 2, display: 'Stage 2', status: 'completed', changed_at: new Date('2026-01-05'), next_copy: 'next copy 2' },
      { index: 3, display: 'Stage 3', status: 'current', changed_at: new Date('2026-01-10'), next_copy: 'next copy 3' },
    ]);
  });

  it('gap rule: a later date filled with an earlier one blank still marks the earlier stage completed, with no date shown', () => {
    // D2 (Construction-equivalent) never got its own date recorded, but D3
    // (Net Metering-equivalent) did — assume D2 happened too, don't show it
    // as a pending gap behind the current stage.
    const refValues = { D1: '2026-01-01', D2: null, D3: '2026-01-10' };
    const { stageIndex, timeline } = resolveDateDrivenStage(threeStages, refValues, null);

    expect(stageIndex).toBe(3);
    expect(timeline[0]).toMatchObject({ status: 'completed', changed_at: new Date('2026-01-01') });
    expect(timeline[1]).toMatchObject({ status: 'completed', changed_at: null });
    expect(timeline[2]).toMatchObject({ status: 'current', changed_at: new Date('2026-01-10') });
  });

  it('stages after the current (highest-filled) one are pending with no date', () => {
    const refValues = { D1: '2026-01-01', D2: null, D3: null };
    const { stageIndex, timeline } = resolveDateDrivenStage(threeStages, refValues, null);

    expect(stageIndex).toBe(1);
    expect(timeline[0]).toMatchObject({ status: 'current', changed_at: new Date('2026-01-01') });
    expect(timeline[1]).toMatchObject({ status: 'pending', changed_at: null });
    expect(timeline[2]).toMatchObject({ status: 'pending', changed_at: null });
  });

  it('zero dates filled falls back to Created_Time on the first stage — "journey started"', () => {
    const createdTime = new Date('2025-12-25T00:00:00Z');
    const refValues = { D1: null, D2: null, D3: null };
    const { stageIndex, timeline } = resolveDateDrivenStage(threeStages, refValues, createdTime);

    expect(stageIndex).toBe(1);
    expect(timeline[0]).toMatchObject({ status: 'current', changed_at: createdTime });
    expect(timeline[1]).toMatchObject({ status: 'pending', changed_at: null });
  });

  it('prefers the first stage\'s own date field over the Created_Time fallback when both are present', () => {
    const createdTime = new Date('2025-12-25T00:00:00Z');
    const refValues = { D1: '2026-01-01', D2: null, D3: null };
    const { timeline } = resolveDateDrivenStage(threeStages, refValues, createdTime);

    expect(timeline[0]?.changed_at).toEqual(new Date('2026-01-01'));
  });

  it('still resolves to stage 1 with no date when zero dates filled and no Created_Time fallback available', () => {
    const { stageIndex, timeline } = resolveDateDrivenStage(threeStages, { D1: null, D2: null, D3: null }, null);
    expect(stageIndex).toBe(1);
    expect(timeline[0]).toMatchObject({ status: 'current', changed_at: null });
  });

  it('ignores an unparseable date value the same as a missing one', () => {
    const refValues = { D1: 'not-a-real-date', D2: '2026-01-05', D3: null };
    const { stageIndex } = resolveDateDrivenStage(threeStages, refValues, null);
    expect(stageIndex).toBe(2);
  });

  it('sorts stages by index regardless of input order', () => {
    const shuffled = [threeStages[2]!, threeStages[0]!, threeStages[1]!];
    const refValues = { D1: '2026-01-01', D2: null, D3: null };
    const { timeline } = resolveDateDrivenStage(shuffled, refValues, null);
    expect(timeline.map((t) => t.index)).toEqual([1, 2, 3]);
  });

  it('excludes non-journey-type stages from the timeline', () => {
    const stages: Stage[] = [...threeStages, { type: 'hidden', crm_value: 'x', display: 'Hidden' }];
    const { timeline } = resolveDateDrivenStage(stages, { D1: '2026-01-01', D2: null, D3: null }, null);
    expect(timeline).toHaveLength(3);
  });
});
