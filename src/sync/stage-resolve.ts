import type { TenantConfig } from '../config/types.js';

export type StageType = TenantConfig['journey']['stages'][number]['type'];

export interface StageResolveResult {
  stageIndex: number | null;
  // null means the raw CRM value doesn't match ANY configured stage, of any
  // type. A match on a pre_journey/on_hold/hidden stage is still a *known*
  // stage — just not a journey-progress one — so it does NOT produce an
  // UNKNOWN_STAGE issue below.
  type: StageType | null;
  issue?: string;
}

/**
 * Resolves a raw CRM stage value against the tenant config's stage list.
 * Only "journey"-type stages carry a numeric index (used for timeline
 * position / progress_pct); other recognized types resolve to a null index
 * with their type set. A value matching no configured stage at all resolves
 * to a null index AND null type, with an UNKNOWN_STAGE issue — the caller
 * stores the raw stage as-is and logs it so it surfaces for a config fix,
 * never a crash.
 */
export function resolveStageIndex(journeyConfig: TenantConfig['journey'], stageValue: string): StageResolveResult {
  const stage = journeyConfig.stages.find((s) => s.crm_value === stageValue);
  if (!stage) {
    return { stageIndex: null, type: null, issue: 'UNKNOWN_STAGE' };
  }
  if (stage.type === 'journey') {
    return { stageIndex: stage.index, type: 'journey' };
  }
  return { stageIndex: null, type: stage.type };
}

export type JourneyStageConfig = Extract<TenantConfig['journey']['stages'][number], { type: 'journey' }>;

export function isJourneyStage(stage: TenantConfig['journey']['stages'][number]): stage is JourneyStageConfig {
  return stage.type === 'journey';
}
