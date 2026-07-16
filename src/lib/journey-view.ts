import type { TenantConfig } from '../config/types.js';
import { extractCreatedTime, isDateDrivenJourney, resolveDateDrivenStage } from '../sync/date-stage-resolve.js';
import { isJourneyStage, resolveStageIndex, type JourneyStageConfig } from '../sync/stage-resolve.js';

export { isJourneyStage, type JourneyStageConfig };

export interface JourneyLike {
  id: string;
  name: string;
  stage: string;
  refValues: unknown;
  raw: unknown;
  syncedAt: Date;
}

export type JourneyListStatus = 'in_progress' | 'pre_journey' | 'on_hold';

export interface JourneySummary {
  id: string;
  name: string;
  stage: string;
  stage_index: number | null;
  total_stages: number;
  progress_pct: number | null;
  ref_values: Record<string, unknown>;
  updated_at: Date;
  status: JourneyListStatus;
  stage_unrecognized?: true;
  last_known_stage_index?: number | null;
}

function buildRefValues(refValues: unknown, tenantConfig: TenantConfig): Record<string, unknown> {
  const raw = (refValues ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const rf of tenantConfig.reference_fields) {
    out[rf.display] = raw[rf.crm_field] ?? null;
  }
  return out;
}

/**
 * Re-resolves the journey's raw stage against the CURRENT tenant config
 * (not the stage_index already stored on the row) so a config update takes
 * effect immediately on read, without needing a re-sync.
 *
 * Returns null for "hidden" stages — customers must never see e.g. Closed
 * Lost. The caller filters these out of /me/journeys and 404s
 * /me/journeys/:id, exactly like an authorization-scoping miss (never a 403
 * that would confirm the record's existence).
 */
export function buildJourneySummary(journey: JourneyLike, tenantConfig: TenantConfig): JourneySummary | null {
  const totalStages = tenantConfig.journey.stages.filter((s) => s.type === 'journey').length;

  const base = {
    id: journey.id,
    name: journey.name,
    stage: journey.stage,
    total_stages: totalStages,
    ref_values: buildRefValues(journey.refValues, tenantConfig),
    updated_at: journey.syncedAt,
  };

  // Date-driven journeys have no pre_journey/on_hold/hidden concept — every
  // record that reaches this module (e.g. a Sales Order) is inherently "in
  // progress" toward installation, so the Stage picklist isn't consulted for
  // status at all (see date-stage-resolve.ts for why: it's barely populated
  // in practice for Elgris's Sales_Orders).
  if (isDateDrivenJourney(tenantConfig.journey.stages)) {
    const refValues = (journey.refValues ?? {}) as Record<string, unknown>;
    const createdTime = extractCreatedTime(journey.raw);
    const { stageIndex } = resolveDateDrivenStage(tenantConfig.journey.stages, refValues, createdTime);
    const rawPct = totalStages > 0 ? Math.round((stageIndex / totalStages) * 100) : 0;
    const progressPct = Math.min(100, Math.max(0, rawPct));
    return { ...base, stage_index: stageIndex, progress_pct: progressPct, status: 'in_progress' };
  }

  const resolved = resolveStageIndex(tenantConfig.journey, journey.stage);

  if (resolved.type === 'hidden') {
    return null;
  }

  if (resolved.type === 'pre_journey') {
    return { ...base, stage_index: null, progress_pct: null, status: 'pre_journey' };
  }

  if (resolved.type === 'on_hold') {
    // StageHistory isn't populated until M5 (webhooks) — no way to derive a
    // last-known journey position yet, so this is always null for now.
    return { ...base, stage_index: null, progress_pct: null, status: 'on_hold', last_known_stage_index: null };
  }

  if (resolved.type === 'journey') {
    const stageIndex = resolved.stageIndex as number;
    const rawPct = totalStages > 0 ? Math.round((stageIndex / totalStages) * 100) : 0;
    const progressPct = Math.min(100, Math.max(0, rawPct));
    return { ...base, stage_index: stageIndex, progress_pct: progressPct, status: 'in_progress' };
  }

  // resolved.type === null: the raw value doesn't match any configured
  // stage at all. Treated as visible (unlike "hidden"), per spec.
  return { ...base, stage_index: null, progress_pct: null, status: 'in_progress', stage_unrecognized: true };
}

export type StageTimelineStatus = 'completed' | 'current' | 'pending';

export interface StageTimelineEntry {
  index: number;
  display: string;
  status: StageTimelineStatus;
  changed_at: Date | null;
  next_copy: string;
}

/**
 * Builds the customer-facing timeline from "journey"-type stages only —
 * pre_journey/on_hold/hidden stages never appear as timeline rows, they're
 * not part of the installation sequence.
 */
export function buildStageTimeline(
  stages: TenantConfig['journey']['stages'],
  stageIndex: number | null,
  changedAtByStage: ReadonlyMap<string, Date>,
): StageTimelineEntry[] {
  const journeyStages = stages.filter(isJourneyStage);

  return journeyStages.map((stage) => {
    let status: StageTimelineStatus = 'pending';
    if (stageIndex != null) {
      if (stage.index < stageIndex) status = 'completed';
      else if (stage.index === stageIndex) status = 'current';
    }
    return {
      index: stage.index,
      display: stage.display,
      status,
      changed_at: changedAtByStage.get(stage.crm_value) ?? null,
      next_copy: stage.next_copy,
    };
  });
}
