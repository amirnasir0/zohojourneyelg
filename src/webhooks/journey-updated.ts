import { Prisma } from '@prisma/client';
import type { TenantConfig } from '../config/types.js';
import { invalidateJourneysCache } from '../lib/journeys-cache.js';
import { prisma } from '../lib/prisma.js';
import type { ZohoClient } from '../lib/zoho-client.js';
import { writeJourneyBatch } from '../sync/journey-batch.js';
import { resolveStageIndex } from '../sync/stage-resolve.js';
import type { WebhookResult } from './types.js';

interface JourneyUpdatedPayload {
  recordId: string;
  stage: string;
  contactZohoId: string;
  changedAt: Date;
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * PRD §11.2: dedupe on (record_id, to_stage, minute-bucket). journeyId
 * already uniquely identifies the record (1:1 with zoho_record_id), so it
 * stands in for record_id here without needing to duplicate that column
 * onto StageHistory.
 */
export function computeStageHistoryDedupeKey(journeyId: string, toStage: string, changedAt: Date): string {
  const minuteBucket = Math.floor(changedAt.getTime() / 60_000);
  return `${journeyId}:${toStage}:${minuteBucket}`;
}

function extractPayload(body: unknown, mapping: TenantConfig['webhooks']['journey_updated']): JourneyUpdatedPayload | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const b = body as Record<string, unknown>;
  const recordId = b[mapping.record_id_field];
  const stage = b[mapping.stage_field];
  const contactZohoId = b[mapping.contact_id_field];
  const changedAtRaw = b[mapping.changed_at_field];

  if (typeof recordId !== 'string' || !recordId) return null;
  if (typeof stage !== 'string' || !stage) return null;
  if (typeof contactZohoId !== 'string' || !contactZohoId) return null;

  let changedAt = new Date();
  if (typeof changedAtRaw === 'string') {
    const parsed = new Date(changedAtRaw);
    if (!Number.isNaN(parsed.getTime())) {
      changedAt = parsed;
    }
  }

  return { recordId, stage, contactZohoId, changedAt };
}

async function insertStageHistory(journeyId: string, fromStage: string | null, toStage: string, changedAt: Date): Promise<void> {
  const dedupeKey = computeStageHistoryDedupeKey(journeyId, toStage, changedAt);
  try {
    await prisma.stageHistory.create({
      data: { journeyId, fromStage, toStage, changedAt, source: 'WEBHOOK', dedupeKey },
    });
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

export async function handleJourneyUpdated(body: unknown, tenantConfig: TenantConfig, zohoClient: ZohoClient | undefined): Promise<WebhookResult> {
  const payload = extractPayload(body, tenantConfig.webhooks.journey_updated);
  if (!payload) {
    return { status: 400, body: { error: 'INVALID_PAYLOAD' } };
  }

  const { recordId, stage, contactZohoId, changedAt } = payload;

  const existing = await prisma.journey.findUnique({ where: { zohoRecordId: recordId } });

  if (!existing) {
    if (!zohoClient) {
      console.error(`[webhook journey-updated] record ${recordId} not synced locally and Zoho client is unavailable (missing ZOHO_* env vars)`);
      return { status: 503, body: { error: 'ZOHO_CLIENT_UNAVAILABLE' } };
    }

    const journeyFields = uniqueFields([
      'id',
      'Modified_Time',
      tenantConfig.zoho.journey_stage_field,
      tenantConfig.zoho.journey_name_field,
      tenantConfig.zoho.journey_contact_lookup_field,
      ...tenantConfig.reference_fields.map((rf) => rf.crm_field),
    ]);

    const fetched = await zohoClient.getRecord(tenantConfig.zoho.journey_module, recordId, journeyFields);
    if (!fetched) {
      console.error(`[webhook journey-updated] Zoho record ${recordId} not found (404), contact_id=${contactZohoId} — treating as no-op`);
      return { status: 200, body: { success: true, note: 'record not found in Zoho' } };
    }

    await writeJourneyBatch([fetched], tenantConfig);
    const created = await prisma.journey.findUnique({ where: { zohoRecordId: recordId } });

    if (!created) {
      // Upsert didn't produce a row — most likely ORPHAN_JOURNEY (contact
      // not synced either) or another SyncIssue-logged skip inside
      // writeJourneyBatch. That path already logged the issue; nothing more
      // to do here.
      console.error(`[webhook journey-updated] record ${recordId} fetched but not upserted (see sync_issues), contact_id=${contactZohoId}`);
      return { status: 200, body: { success: true, note: 'journey not created, see sync_issues' } };
    }

    await insertStageHistory(created.id, null, created.stage, changedAt);
    await invalidateJourneysCache(created.contactId);
    return { status: 200, body: { success: true } };
  }

  const previousStage = existing.stage;
  const resolved = resolveStageIndex(tenantConfig.journey, stage);

  await prisma.journey.update({
    where: { id: existing.id },
    data: { stage, stageIndex: resolved.stageIndex, syncedAt: new Date() },
  });

  if (resolved.issue) {
    await prisma.syncIssue.createMany({
      data: [{ zohoRecordId: recordId, recordType: 'journey', field: tenantConfig.zoho.journey_stage_field, rawValue: stage, reason: resolved.issue }],
      skipDuplicates: true,
    });
  }

  await insertStageHistory(existing.id, previousStage, stage, changedAt);
  await invalidateJourneysCache(existing.contactId);

  return { status: 200, body: { success: true } };
}
