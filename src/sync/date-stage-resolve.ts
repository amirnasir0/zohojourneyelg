import type { TenantConfig } from '../config/types.js';
import { isJourneyStage, type JourneyStageConfig } from '../lib/journey-view.js';

export function isDateDrivenJourney(stages: TenantConfig['journey']['stages']): boolean {
  return stages.some((s) => s.type === 'journey' && Boolean(s.date_field));
}

export function extractCreatedTime(raw: unknown): Date | null {
  const value = (raw as Record<string, unknown> | null | undefined)?.Created_Time;
  if (typeof value !== 'string') {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseFieldDate(refValues: Record<string, unknown>, dateField: string | undefined): Date | null {
  if (!dateField) {
    return null;
  }
  const raw = refValues[dateField];
  if (typeof raw !== 'string' || !raw) {
    return null;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface DateDrivenTimelineEntry {
  index: number;
  display: string;
  status: 'completed' | 'current' | 'pending';
  changed_at: Date | null;
  next_copy: string;
}

export interface DateDrivenResolveResult {
  // Never null — the lowest-index stage always has an effective date, via
  // the Created_Time fallback, so there's always a "current" stage.
  stageIndex: number;
  timeline: DateDrivenTimelineEntry[];
}

/**
 * Resolves current stage + full timeline from per-stage CRM date fields
 * instead of matching the raw Stage picklist value. Gap rule: the
 * highest-index stage with a non-null date is "current"; earlier stages
 * show their own date if they have one, else are still "completed" with no
 * date shown (a filled later date implies the earlier step happened even if
 * its own date was never recorded — never render that as a pending gap
 * behind the current stage); later stages are "pending". The lowest-index
 * stage falls back to the record's Created_Time if its own date field is
 * empty, so there's always at least one dated entry ("journey started").
 */
export function resolveDateDrivenStage(
  stages: TenantConfig['journey']['stages'],
  refValues: Record<string, unknown>,
  createdTime: Date | null,
): DateDrivenResolveResult {
  const journeyStages: JourneyStageConfig[] = stages.filter(isJourneyStage).slice().sort((a, b) => a.index - b.index);

  const dates = journeyStages.map((stage, i) => {
    const own = parseFieldDate(refValues, stage.date_field);
    return i === 0 && own === null ? createdTime : own;
  });

  let currentPos = 0;
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] !== null) {
      currentPos = i;
    }
  }

  const timeline: DateDrivenTimelineEntry[] = journeyStages.map((stage, i) => {
    let status: DateDrivenTimelineEntry['status'];
    let changedAt: Date | null;
    if (i < currentPos) {
      status = 'completed';
      changedAt = dates[i] ?? null;
    } else if (i === currentPos) {
      status = 'current';
      changedAt = dates[i] ?? null;
    } else {
      status = 'pending';
      changedAt = null;
    }
    return { index: stage.index, display: stage.display, status, changed_at: changedAt, next_copy: stage.next_copy };
  });

  return { stageIndex: journeyStages[currentPos]?.index ?? 1, timeline };
}
