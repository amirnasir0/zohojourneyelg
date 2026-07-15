import { describe, expect, it } from 'vitest';
import { resolveStageIndex } from '../src/sync/stage-resolve.js';

const journeyConfig = {
  label_singular: 'Project',
  label_plural: 'Projects',
  stages: [
    { index: 1, crm_value: 'Site Survey', display: 'Site Survey', owner: 'elgris', next_copy: 'x' },
    { index: 14, crm_value: 'Net Meter Installation', display: 'Net Meter Installation', owner: 'discom', next_copy: 'x' },
  ],
};

describe('resolveStageIndex', () => {
  it('resolves a known stage to its configured index', () => {
    expect(resolveStageIndex(journeyConfig, 'Site Survey')).toEqual({ stageIndex: 1 });
    expect(resolveStageIndex(journeyConfig, 'Net Meter Installation')).toEqual({ stageIndex: 14 });
  });

  it('flags an unknown stage without crashing', () => {
    expect(resolveStageIndex(journeyConfig, 'Some Renamed Stage')).toEqual({ stageIndex: null, issue: 'UNKNOWN_STAGE' });
  });
});
