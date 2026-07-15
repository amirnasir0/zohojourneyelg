import type { TenantConfig } from '../config/types.js';

export interface StageResolveResult {
  stageIndex: number | null;
  issue?: string;
}

/**
 * Resolves a raw CRM stage value to the tenant config's stage index. Unknown
 * values (renamed/added stages not yet reflected in config) resolve to a null
 * index rather than throwing — the caller stores the raw stage as-is and logs
 * a SyncIssue so it surfaces for a config fix, never a crash.
 */
export function resolveStageIndex(journeyConfig: TenantConfig['journey'], stageValue: string): StageResolveResult {
  const stage = journeyConfig.stages.find((s) => s.crm_value === stageValue);
  if (!stage) {
    return { stageIndex: null, issue: 'UNKNOWN_STAGE' };
  }
  return { stageIndex: stage.index };
}
