import { describe, expect, it } from 'vitest';
import { clearedCheckpoint, nextPageCheckpoint, phaseTransitionCheckpoint, resolveRunStart, type CheckpointState } from '../src/sync/checkpoint.js';

const NOW = new Date('2026-07-16T12:00:00Z');
const fixedNow = () => NOW;

function baseState(overrides: Partial<CheckpointState> = {}): CheckpointState {
  return {
    checkpointPhase: null,
    checkpointPageToken: null,
    checkpointPagesDone: 0,
    checkpointSinceIso: null,
    checkpointRunStartedAt: null,
    watermark: null,
    ...overrides,
  };
}

describe('resolveRunStart', () => {
  it('starts fresh at page 1 of contacts when there is no checkpoint and no watermark (full historical pull)', () => {
    const result = resolveRunStart(baseState(), fixedNow);
    expect(result).toEqual({ mode: 'fresh', phase: 'contacts', pageToken: undefined, pagesDone: 0, sinceIso: undefined, runStartedAt: NOW });
  });

  it('starts fresh using the existing watermark as sinceIso', () => {
    const watermark = new Date('2026-07-15T13:10:36.147Z');
    const result = resolveRunStart(baseState({ watermark }), fixedNow);
    expect(result.mode).toBe('fresh');
    expect(result.sinceIso).toBe(watermark.toISOString());
  });

  it('resumes from the checkpointed phase, page cursor, and original run metadata — never restarting at page 1', () => {
    const runStartedAt = new Date('2026-07-16T10:00:00Z');
    const state = baseState({
      checkpointPhase: 'journeys',
      checkpointPageToken: 'tok-42',
      checkpointPagesDone: 17,
      checkpointSinceIso: '2026-07-01T00:00:00.000Z',
      checkpointRunStartedAt: runStartedAt,
    });

    const result = resolveRunStart(state, fixedNow);

    expect(result).toEqual({
      mode: 'resume',
      phase: 'journeys',
      pageToken: 'tok-42',
      pagesDone: 17,
      sinceIso: '2026-07-01T00:00:00.000Z',
      runStartedAt,
    });
  });

  it('resumes correctly at the very first page (no pageToken yet) when a checkpoint exists but no page has committed', () => {
    const runStartedAt = new Date('2026-07-16T10:00:00Z');
    const state = baseState({ checkpointPhase: 'contacts', checkpointPagesDone: 0, checkpointRunStartedAt: runStartedAt });

    const result = resolveRunStart(state, fixedNow);

    expect(result.mode).toBe('resume');
    expect(result.phase).toBe('contacts');
    expect(result.pagesDone).toBe(0);
    expect(result.pageToken).toBeUndefined();
  });

  it('ignores a garbage checkpointPhase value and falls back to a fresh run', () => {
    const state = baseState({ checkpointPhase: 'not-a-real-phase' });
    const result = resolveRunStart(state, fixedNow);
    expect(result.mode).toBe('fresh');
  });
});

describe('checkpoint column builders', () => {
  const runStartedAt = new Date('2026-07-16T10:00:00Z');

  it('nextPageCheckpoint advances pagesDone and stores the next page token', () => {
    expect(nextPageCheckpoint('contacts', 5, 'tok-6', '2026-07-01T00:00:00.000Z', runStartedAt)).toEqual({
      checkpointPhase: 'contacts',
      checkpointPageToken: 'tok-6',
      checkpointPagesDone: 5,
      checkpointSinceIso: '2026-07-01T00:00:00.000Z',
      checkpointRunStartedAt: runStartedAt,
    });
  });

  it('nextPageCheckpoint nulls the page token on the last page of a phase (no next token from Zoho)', () => {
    const result = nextPageCheckpoint('contacts', 33, undefined, undefined, runStartedAt);
    expect(result.checkpointPageToken).toBeNull();
    expect(result.checkpointSinceIso).toBeNull();
  });

  it('phaseTransitionCheckpoint resets the page cursor for the next phase', () => {
    expect(phaseTransitionCheckpoint('journeys', '2026-07-01T00:00:00.000Z', runStartedAt)).toEqual({
      checkpointPhase: 'journeys',
      checkpointPageToken: null,
      checkpointPagesDone: 0,
      checkpointSinceIso: '2026-07-01T00:00:00.000Z',
      checkpointRunStartedAt: runStartedAt,
    });
  });

  it('clearedCheckpoint nulls every checkpoint column', () => {
    expect(clearedCheckpoint()).toEqual({
      checkpointPhase: null,
      checkpointPageToken: null,
      checkpointPagesDone: 0,
      checkpointSinceIso: null,
      checkpointRunStartedAt: null,
    });
  });
});
