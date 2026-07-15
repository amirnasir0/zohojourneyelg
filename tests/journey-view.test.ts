import { describe, expect, it } from 'vitest';
import { buildJourneySummary, buildStageTimeline } from '../src/lib/journey-view.js';
import type { TenantConfig } from '../src/config/types.js';

function journeyStage(index: number, crmValue: string) {
  return {
    type: 'journey' as const,
    index,
    crm_value: crmValue,
    display: crmValue,
    owner: 'elgris',
    next_copy: `next copy for ${crmValue}`,
  };
}

// 24 contiguous journey stages, matching PRD's reference 24-stage journey.
const fullJourneyStages = Array.from({ length: 24 }, (_, i) => journeyStage(i + 1, `Stage ${i + 1}`));

const baseTenantConfig: TenantConfig = {
  tenant: {
    slug: 'elgris',
    display_name: 'Elgris Solar',
    logo_url: 'https://example.com/logo.png',
    brand_colors: { primary: '#000000', secondary: '#ffffff' },
    support_whatsapp: '+919999999999',
    support_email: 'support@example.com',
  },
  zoho: {
    dc: 'in',
    org_id: '123',
    journey_module: 'Deals',
    contact_phone_fields: ['Phone'],
    journey_stage_field: 'Stage',
    journey_name_field: 'Deal_Name',
    journey_contact_lookup_field: 'Contact_Name',
  },
  journey: {
    label_singular: 'Project',
    label_plural: 'Projects',
    stages: [
      ...fullJourneyStages,
      { type: 'pre_journey', crm_value: 'Need Proposal', display: 'Need Proposal' },
      { type: 'on_hold', crm_value: 'Hold', display: 'On Hold' },
      { type: 'hidden', crm_value: 'Closed Lost', display: 'Closed Lost' },
    ],
  },
  reference_fields: [],
  notifications: {
    otp_channel: ['whatsapp'],
    interakt_otp_template: 'otp_v1',
    stage_change_push: 'x',
    stage_change_whatsapp_template: null,
  },
  webhooks: {
    journey_updated: { record_id_field: 'record_id', stage_field: 'stage', contact_id_field: 'contact_id', changed_at_field: 'changed_at' },
    contact_updated: { record_id_field: 'record_id' },
  },
};

function journeyRow(stage: string) {
  return { id: 'j1', name: 'Deal 1', stage, refValues: {}, syncedAt: new Date('2026-01-01T00:00:00Z') };
}

describe('buildStageTimeline', () => {
  it('derives 13 completed, 1 current, 10 pending for stage_index 14 of 24', () => {
    const timeline = buildStageTimeline(baseTenantConfig.journey.stages, 14, new Map());

    expect(timeline).toHaveLength(24);
    const completed = timeline.filter((t) => t.status === 'completed');
    const current = timeline.filter((t) => t.status === 'current');
    const pending = timeline.filter((t) => t.status === 'pending');

    expect(completed).toHaveLength(13);
    expect(current).toHaveLength(1);
    expect(current[0]?.index).toBe(14);
    expect(pending).toHaveLength(10);
  });

  it('marks every entry pending when stage_index is null', () => {
    const timeline = buildStageTimeline(baseTenantConfig.journey.stages, null, new Map());
    expect(timeline.every((t) => t.status === 'pending')).toBe(true);
  });

  it('only includes journey-type stages, never pre_journey/on_hold/hidden', () => {
    const timeline = buildStageTimeline(baseTenantConfig.journey.stages, 1, new Map());
    expect(timeline).toHaveLength(24);
    expect(timeline.some((t) => t.display === 'Need Proposal' || t.display === 'On Hold' || t.display === 'Closed Lost')).toBe(false);
  });

  it('reads changed_at from the provided map, else null', () => {
    const changedAt = new Date('2026-02-01T00:00:00Z');
    const timeline = buildStageTimeline(baseTenantConfig.journey.stages, 2, new Map([['Stage 1', changedAt]]));
    expect(timeline[0]?.changed_at).toBe(changedAt);
    expect(timeline[1]?.changed_at).toBeNull();
  });
});

describe('buildJourneySummary', () => {
  it('computes progress_pct for a normal in-progress journey stage', () => {
    const summary = buildJourneySummary(journeyRow('Stage 12'), baseTenantConfig);
    expect(summary).toMatchObject({ stage_index: 12, total_stages: 24, progress_pct: 50, status: 'in_progress' });
    expect(summary?.stage_unrecognized).toBeUndefined();
  });

  it('is null-safe: progress_pct is null when the stage is unrecognized (not in config at all)', () => {
    const summary = buildJourneySummary(journeyRow('Some Renamed Stage'), baseTenantConfig);
    expect(summary).toMatchObject({ stage_index: null, progress_pct: null, status: 'in_progress', stage_unrecognized: true });
  });

  it('clamps progress_pct to 100 rather than exceeding it', () => {
    // total_stages counts journey-type stages only (24 here); a stage index
    // beyond that range would otherwise compute > 100%.
    const stages = [...baseTenantConfig.journey.stages, journeyStage(30, 'Stage 30')];
    const config = { ...baseTenantConfig, journey: { ...baseTenantConfig.journey, stages } };
    const summary = buildJourneySummary(journeyRow('Stage 30'), config);
    expect(summary?.progress_pct).toBe(100);
  });

  it('clamps progress_pct to a minimum of 0', () => {
    const stages = [...baseTenantConfig.journey.stages, { ...journeyStage(-1, 'Stage -1') }];
    const config = { ...baseTenantConfig, journey: { ...baseTenantConfig.journey, stages } };
    const summary = buildJourneySummary(journeyRow('Stage -1'), config);
    expect(summary?.progress_pct).toBe(0);
  });

  it('shapes a pre_journey stage with status pre_journey, null progress_pct, no timeline data needed', () => {
    const summary = buildJourneySummary(journeyRow('Need Proposal'), baseTenantConfig);
    expect(summary).toMatchObject({ stage_index: null, progress_pct: null, status: 'pre_journey' });
    expect(summary?.stage_unrecognized).toBeUndefined();
  });

  it('shapes an on_hold stage with status on_hold and a null last_known_stage_index', () => {
    const summary = buildJourneySummary(journeyRow('Hold'), baseTenantConfig);
    expect(summary).toMatchObject({ stage_index: null, progress_pct: null, status: 'on_hold', last_known_stage_index: null });
  });

  it('returns null for a hidden-type stage (caller treats this as not-found)', () => {
    const summary = buildJourneySummary(journeyRow('Closed Lost'), baseTenantConfig);
    expect(summary).toBeNull();
  });
});
