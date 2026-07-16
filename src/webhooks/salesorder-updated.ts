import { Prisma } from '@prisma/client';
import type { TenantConfig } from '../config/types.js';
import { invalidateJourneysCache } from '../lib/journeys-cache.js';
import { prisma } from '../lib/prisma.js';
import type { ZohoClient, ZohoRecord } from '../lib/zoho-client.js';
import { extractCreatedTime, resolveDateDrivenStage } from '../sync/date-stage-resolve.js';
import { computeStageHistoryDedupeKey } from './journey-updated.js';
import { writeJourneyBatch } from '../sync/journey-batch.js';
import type { WebhookResult } from './types.js';

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

async function insertStageHistory(journeyId: string, fromStage: string | null, toStage: string, changedAt: Date): Promise<void> {
  const dedupeKey = computeStageHistoryDedupeKey(journeyId, toStage, changedAt);
  try {
    await prisma.stageHistory.create({ data: { journeyId, fromStage, toStage, changedAt, source: 'WEBHOOK', dedupeKey } });
  } catch (err) {
    if (!isUniqueConstraintError(err)) {
      throw err;
    }
    // Same (journeyId, toStage, minute-bucket) already recorded — a repeat
    // delivery, not a new transition. Idempotent no-op.
  }
}

function uniqueFields(fields: string[]): string[] {
  return [...new Set(fields)];
}

function stageDisplay(stages: TenantConfig['journey']['stages'], index: number): string {
  const stage = stages.find((s) => s.type === 'journey' && s.index === index);
  return stage && stage.type === 'journey' ? stage.display : String(index);
}

function journeyFieldsToFetch(tenantConfig: TenantConfig): string[] {
  return uniqueFields([
    'id',
    'Modified_Time',
    'Created_Time',
    tenantConfig.zoho.journey_stage_field,
    tenantConfig.zoho.journey_name_field,
    tenantConfig.zoho.journey_contact_lookup_field,
    ...tenantConfig.reference_fields.map((rf) => rf.crm_field),
  ]);
}

/**
 * Zoho Workflow Rules can't filter to "one of these 8 date fields changed" —
 * this fires on any Sales_Orders edit, most of which touch nothing we track
 * (billing address, carrier, etc). Diffs the fetched record's Stage +
 * configured date_field values against what's stored locally BEFORE writing
 * anything, so an irrelevant edit is a true no-op: no DB write, no derived
 * stage recompute, no cache bust.
 */
export async function handleSalesOrderUpdated(body: unknown, tenantConfig: TenantConfig, zohoClient: ZohoClient | undefined): Promise<WebhookResult> {
  const mapping = tenantConfig.webhooks.salesorder_updated;
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const recordId = b[mapping.record_id_field];

  if (typeof recordId !== 'string' || !recordId) {
    return { status: 400, body: { error: 'INVALID_PAYLOAD' } };
  }

  if (!zohoClient) {
    console.error(`[webhook salesorder-updated] record ${recordId}: Zoho client is unavailable (missing ZOHO_* env vars)`);
    return { status: 503, body: { error: 'ZOHO_CLIENT_UNAVAILABLE' } };
  }

  const existing = await prisma.journey.findUnique({ where: { zohoRecordId: recordId } });

  const fetched = await zohoClient.getRecord(tenantConfig.zoho.journey_module, recordId, journeyFieldsToFetch(tenantConfig));
  if (!fetched) {
    console.error(`[webhook salesorder-updated] Zoho record ${recordId} not found (404) — treating as no-op`);
    return { status: 200, body: { success: true, note: 'record not found in Zoho' } };
  }

  if (!existing) {
    // First time we've seen this record — reuse the full sync write path
    // (contact resolution, SyncIssue logging) rather than duplicating it.
    await writeJourneyBatch([fetched], tenantConfig);
    const created = await prisma.journey.findUnique({ where: { zohoRecordId: recordId } });

    if (!created) {
      console.error(`[webhook salesorder-updated] record ${recordId} fetched but not upserted (see sync_issues)`);
      return { status: 200, body: { success: true, note: 'journey not created, see sync_issues' } };
    }

    const refValues = (created.refValues ?? {}) as Record<string, unknown>;
    const { stageIndex } = resolveDateDrivenStage(tenantConfig.journey.stages, refValues, extractCreatedTime(created.raw));
    await insertStageHistory(created.id, null, stageDisplay(tenantConfig.journey.stages, stageIndex), new Date());
    await invalidateJourneysCache(created.contactId);
    return { status: 200, body: { success: true, stage_changed: true } };
  }

  const stageField = tenantConfig.zoho.journey_stage_field;
  const fetchedStageRaw = (fetched as ZohoRecord)[stageField];
  const fetchedStage = typeof fetchedStageRaw === 'string' ? fetchedStageRaw : '';

  const newRefValues: Record<string, unknown> = {};
  for (const rf of tenantConfig.reference_fields) {
    newRefValues[rf.crm_field] = fetched[rf.crm_field] ?? null;
  }

  const existingRefValues = (existing.refValues ?? {}) as Record<string, unknown>;
  const relevantFieldsChanged =
    existing.stage !== fetchedStage || tenantConfig.reference_fields.some((rf) => existingRefValues[rf.crm_field] !== newRefValues[rf.crm_field]);

  if (!relevantFieldsChanged) {
    return { status: 200, body: { success: true, stage_changed: false, note: 'no relevant fields changed' } };
  }

  const previousStageIndex = resolveDateDrivenStage(tenantConfig.journey.stages, existingRefValues, extractCreatedTime(existing.raw)).stageIndex;

  const nameRaw = fetched[tenantConfig.zoho.journey_name_field];
  const name = typeof nameRaw === 'string' ? nameRaw : existing.name;
  const newCreatedTime = extractCreatedTime(fetched);
  const { stageIndex: newStageIndex } = resolveDateDrivenStage(tenantConfig.journey.stages, newRefValues, newCreatedTime);

  const updated = await prisma.journey.update({
    where: { id: existing.id },
    data: {
      name,
      stage: fetchedStage,
      stageIndex: newStageIndex,
      refValues: newRefValues as Prisma.InputJsonValue,
      raw: fetched as Prisma.InputJsonValue,
      syncedAt: new Date(),
    },
  });

  await invalidateJourneysCache(updated.contactId);

  if (previousStageIndex !== newStageIndex) {
    const toStage = stageDisplay(tenantConfig.journey.stages, newStageIndex);
    const fromStage = stageDisplay(tenantConfig.journey.stages, previousStageIndex);
    await insertStageHistory(updated.id, fromStage, toStage, new Date());
    return { status: 200, body: { success: true, stage_changed: true } };
  }

  return { status: 200, body: { success: true, stage_changed: false } };
}
