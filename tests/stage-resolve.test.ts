import { describe, expect, it } from 'vitest';
import { resolveStageIndex } from '../src/sync/stage-resolve.js';

const journeyConfig = {
  label_singular: 'Project',
  label_plural: 'Projects',
  stages: [
    { type: 'journey' as const, index: 1, crm_value: 'Site Survey', display: 'Site Survey', owner: 'elgris', next_copy: 'x' },
    { type: 'journey' as const, index: 14, crm_value: 'Net Meter Installation', display: 'Net Meter Installation', owner: 'discom', next_copy: 'x' },
    { type: 'pre_journey' as const, crm_value: 'Need Proposal', display: 'Need Proposal' },
    { type: 'on_hold' as const, crm_value: 'Hold', display: 'On Hold' },
    { type: 'hidden' as const, crm_value: 'Closed Lost', display: 'Closed Lost' },
  ],
};

describe('resolveStageIndex', () => {
  it('resolves a known journey stage to its configured index and type', () => {
    expect(resolveStageIndex(journeyConfig, 'Site Survey')).toEqual({ stageIndex: 1, type: 'journey' });
    expect(resolveStageIndex(journeyConfig, 'Net Meter Installation')).toEqual({ stageIndex: 14, type: 'journey' });
  });

  it('resolves a non-journey stage to a null index but a known type, no issue', () => {
    expect(resolveStageIndex(journeyConfig, 'Need Proposal')).toEqual({ stageIndex: null, type: 'pre_journey' });
    expect(resolveStageIndex(journeyConfig, 'Hold')).toEqual({ stageIndex: null, type: 'on_hold' });
    expect(resolveStageIndex(journeyConfig, 'Closed Lost')).toEqual({ stageIndex: null, type: 'hidden' });
  });

  it('flags a truly unrecognized stage (matches nothing) without crashing', () => {
    expect(resolveStageIndex(journeyConfig, 'Some Renamed Stage')).toEqual({ stageIndex: null, type: null, issue: 'UNKNOWN_STAGE' });
  });
});
