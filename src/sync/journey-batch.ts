import { Prisma } from '@prisma/client';
import type { TenantConfig } from '../config/types.js';
import { invalidateJourneysCache } from '../lib/journeys-cache.js';
import { prisma } from '../lib/prisma.js';
import type { ZohoRecord } from '../lib/zoho-client.js';
import { resolveStageIndex } from './stage-resolve.js';
import { withBatchRetry } from './with-retry.js';

export interface JourneyBatchIssue {
  zohoRecordId: string;
  field: string;
  rawValue: string;
  reason: string;
}

export interface JourneyUpsertItem {
  zohoRecordId: string;
  contactId: string;
  name: string;
  stage: string;
  stageIndex: number | null;
  refValues: Record<string, unknown>;
  raw: ZohoRecord;
}

export interface JourneyBatchPlan {
  upserts: JourneyUpsertItem[];
  issues: JourneyBatchIssue[];
}

interface ZohoLookup {
  id?: string;
}

/**
 * Pure planning step for a batch write: given raw journey records and a map
 * of zohoContactId -> local contact.id (fetched by the caller in one bulk
 * query), resolves stage + contact link and decides what to upsert.
 */
export function planJourneyBatch(
  rawRecords: ZohoRecord[],
  tenantConfig: TenantConfig,
  contactIdByZohoId: ReadonlyMap<string, string>,
): JourneyBatchPlan {
  const issues: JourneyBatchIssue[] = [];
  const upserts: JourneyUpsertItem[] = [];

  for (const raw of rawRecords) {
    const zohoRecordId = String(raw.id);
    const stageValueRaw = raw[tenantConfig.zoho.journey_stage_field];
    const stageValue = typeof stageValueRaw === 'string' ? stageValueRaw : null;

    let stageIndex: number | null = null;

    if (!stageValue) {
      issues.push({ zohoRecordId, field: tenantConfig.zoho.journey_stage_field, rawValue: '', reason: 'MISSING_STAGE' });
    } else {
      const resolved = resolveStageIndex(tenantConfig.journey, stageValue);
      stageIndex = resolved.stageIndex;
      if (resolved.issue) {
        issues.push({ zohoRecordId, field: tenantConfig.zoho.journey_stage_field, rawValue: stageValue, reason: resolved.issue });
      }
    }

    const lookup = raw[tenantConfig.zoho.journey_contact_lookup_field] as ZohoLookup | null | undefined;
    const zohoContactId = lookup?.id;
    const contactId = zohoContactId ? contactIdByZohoId.get(zohoContactId) : undefined;

    if (!contactId) {
      issues.push({ zohoRecordId, field: tenantConfig.zoho.journey_contact_lookup_field, rawValue: zohoContactId ?? '', reason: 'ORPHAN_JOURNEY' });
      continue;
    }

    const refValues: Record<string, unknown> = {};
    for (const rf of tenantConfig.reference_fields) {
      refValues[rf.crm_field] = raw[rf.crm_field] ?? null;
    }

    const nameRaw = raw[tenantConfig.zoho.journey_name_field];
    const name = typeof nameRaw === 'string' ? nameRaw : '';

    upserts.push({ zohoRecordId, contactId, name, stage: stageValue ?? '', stageIndex, refValues, raw });
  }

  return { upserts, issues };
}

export interface JourneyBatchResult {
  written: number;
  issues: number;
}

interface ZohoLookupField {
  id?: string;
}

/**
 * Writes one batch (~200 records): one bulk read to resolve
 * zohoContactId -> local contact.id for every contact referenced in this
 * batch, then a single $transaction covering the upserts, the issue
 * createMany, AND any extraOps the caller supplies (e.g. a SyncState
 * checkpoint update) so the checkpoint commits atomically with the data.
 */
export async function writeJourneyBatch(
  rawRecords: ZohoRecord[],
  tenantConfig: TenantConfig,
  extraOps: Prisma.PrismaPromise<unknown>[] = [],
): Promise<JourneyBatchResult> {
  const lookupField = tenantConfig.zoho.journey_contact_lookup_field;
  const candidateContactIds = new Set<string>();
  for (const raw of rawRecords) {
    const lookup = raw[lookupField] as ZohoLookupField | null | undefined;
    if (lookup?.id) candidateContactIds.add(lookup.id);
  }

  const contacts =
    candidateContactIds.size > 0
      ? await withBatchRetry(() =>
          prisma.contact.findMany({
            where: { zohoContactId: { in: [...candidateContactIds] } },
            select: { id: true, zohoContactId: true },
          }),
        )
      : [];
  const contactIdByZohoId = new Map(contacts.map((c) => [c.zohoContactId, c.id]));

  const { upserts, issues } = planJourneyBatch(rawRecords, tenantConfig, contactIdByZohoId);

  if (upserts.length > 0 || issues.length > 0 || extraOps.length > 0) {
    const upsertOps = upserts.map((item) =>
      prisma.journey.upsert({
        where: { zohoRecordId: item.zohoRecordId },
        create: {
          zohoRecordId: item.zohoRecordId,
          contactId: item.contactId,
          name: item.name,
          stage: item.stage,
          stageIndex: item.stageIndex,
          refValues: item.refValues as Prisma.InputJsonValue,
          raw: item.raw as Prisma.InputJsonValue,
          syncedAt: new Date(),
        },
        update: {
          contactId: item.contactId,
          name: item.name,
          stage: item.stage,
          stageIndex: item.stageIndex,
          refValues: item.refValues as Prisma.InputJsonValue,
          raw: item.raw as Prisma.InputJsonValue,
          syncedAt: new Date(),
        },
      }),
    );
    const issueOps: Prisma.PrismaPromise<unknown>[] =
      issues.length > 0
        ? [
            prisma.syncIssue.createMany({
              data: issues.map((i) => ({ zohoRecordId: i.zohoRecordId, recordType: 'journey', field: i.field, rawValue: i.rawValue, reason: i.reason })),
              skipDuplicates: true,
            }),
          ]
        : [];

    await withBatchRetry(() => prisma.$transaction([...upsertOps, ...issueOps, ...extraOps]));

    const affectedContactIds = new Set(upserts.map((item) => item.contactId));
    await Promise.all([...affectedContactIds].map((id) => invalidateJourneysCache(id)));
  }

  return { written: upserts.length, issues: issues.length };
}
