import type { TenantConfig } from '../config/types.js';
import { prisma } from '../lib/prisma.js';
import type { ZohoClient } from '../lib/zoho-client.js';
import { clearedCheckpoint, phaseTransitionCheckpoint, resolveRunStart } from './checkpoint.js';
import { writeContactBatch } from './contact-batch.js';
import { writeJourneyBatch } from './journey-batch.js';
import { runPagedPhase } from './paged-phase.js';

const CONTACTS_MODULE = 'Contacts';
const SYNC_KEY = 'full_reconcile';

function uniqueFields(fields: string[]): string[] {
  return [...new Set(fields)];
}

export async function runFullReconcile(zohoClient: ZohoClient, tenantConfig: TenantConfig): Promise<void> {
  console.log('[reconcile] starting run (full pull, no watermark)');

  const state = await prisma.syncState.upsert({
    where: { key: SYNC_KEY },
    create: { key: SYNC_KEY },
    update: {},
  });

  const runStart = resolveRunStart(state);

  if (runStart.mode === 'resume') {
    console.log(`[reconcile] resuming from page ${runStart.pagesDone + 1} of ${runStart.phase}`);
  } else {
    await prisma.syncState.update({
      where: { key: SYNC_KEY },
      data: phaseTransitionCheckpoint('contacts', undefined, runStart.runStartedAt),
    });
  }

  const { runStartedAt } = runStart;

  try {
    const contactFields = uniqueFields(['id', 'Modified_Time', 'Full_Name', 'Email', ...tenantConfig.zoho.contact_phone_fields]);
    const journeyFields = uniqueFields([
      'id',
      'Modified_Time',
      // Fallback "journey started" timestamp for date-driven stage
      // resolution (see date-stage-resolve.ts) when a journey's own first
      // milestone date field is still empty. Harmless/unused otherwise.
      'Created_Time',
      tenantConfig.zoho.journey_stage_field,
      tenantConfig.zoho.journey_name_field,
      tenantConfig.zoho.journey_contact_lookup_field,
      ...tenantConfig.reference_fields.map((rf) => rf.crm_field),
    ]);

    const zohoContactIds: string[] = [];
    const zohoJourneyIds: string[] = [];

    let contactsDone = 0;
    let journeysDone = 0;

    if (runStart.phase === 'contacts') {
      console.log('[reconcile] fetching Contacts from Zoho...');
      const result = await runPagedPhase({
        syncKey: SYNC_KEY,
        zohoClient,
        phase: 'contacts',
        module: CONTACTS_MODULE,
        fields: contactFields,
        sinceIso: undefined,
        runStartedAt,
        startPageToken: runStart.pageToken,
        startPagesDone: runStart.pagesDone,
        nextPhase: 'journeys',
        writeBatch: (records, extraOps) => writeContactBatch(records, tenantConfig.zoho.contact_phone_fields, extraOps),
        onPageRecords: (records) => zohoContactIds.push(...records.map((r) => String(r.id))),
        logPrefix: '[reconcile]',
      });
      contactsDone = result.written;
      if (result.stoppedForShutdown) {
        console.log('[reconcile] exiting cleanly after shutdown signal');
        return;
      }
    }

    console.log(`[reconcile] fetching ${tenantConfig.zoho.journey_module} from Zoho...`);
    const journeyResult = await runPagedPhase({
      syncKey: SYNC_KEY,
      zohoClient,
      phase: 'journeys',
      module: tenantConfig.zoho.journey_module,
      fields: journeyFields,
      sinceIso: undefined,
      runStartedAt,
      startPageToken: runStart.phase === 'journeys' ? runStart.pageToken : undefined,
      startPagesDone: runStart.phase === 'journeys' ? runStart.pagesDone : 0,
      nextPhase: null,
      writeBatch: (records, extraOps) => writeJourneyBatch(records, tenantConfig, extraOps),
      onPageRecords: (records) => zohoJourneyIds.push(...records.map((r) => String(r.id))),
      logPrefix: '[reconcile]',
    });
    journeysDone = journeyResult.written;
    if (journeyResult.stoppedForShutdown) {
      console.log('[reconcile] exiting cleanly after shutdown signal');
      return;
    }

    // Cleanup (deleting local rows absent from Zoho) only runs when this
    // invocation executed BOTH phases start-to-finish without a resume —
    // a resumed run's onPageRecords only saw the pages fetched THIS
    // invocation, so its ID list would be missing every page committed
    // before the interruption, which would make a deleteMany wrongly
    // remove still-valid rows. Skipping cleanup on a resumed pass is safe:
    // it just waits for the next uninterrupted full reconcile.
    const isCleanPass = runStart.mode === 'fresh';

    if (isCleanPass) {
      if (zohoContactIds.length > 0) {
        const { count } = await prisma.contact.deleteMany({ where: { zohoContactId: { notIn: zohoContactIds } } });
        console.log(`[reconcile] contact cleanup: removed ${count} local row(s) not present in Zoho`);
      } else {
        console.error('[reconcile] Zoho returned zero contacts, skipping contact cleanup to avoid wiping local data');
      }

      if (zohoJourneyIds.length > 0) {
        const { count } = await prisma.journey.deleteMany({ where: { zohoRecordId: { notIn: zohoJourneyIds } } });
        console.log(`[reconcile] journey cleanup: removed ${count} local row(s) not present in Zoho`);
      } else {
        console.error('[reconcile] Zoho returned zero journey records, skipping journey cleanup to avoid wiping local data');
      }
    } else {
      console.log('[reconcile] run included a resume — skipping cleanup this pass (deferred to next uninterrupted full reconcile) to avoid deleting rows fetched before the interruption');
    }

    await prisma.syncState.update({
      where: { key: SYNC_KEY },
      data: {
        lastRunAt: new Date(),
        lastRunStatus: 'success',
        contactsProcessed: contactsDone,
        journeysProcessed: journeysDone,
        ...clearedCheckpoint(),
      },
    });

    console.log(`[reconcile] run complete: contacts=${contactsDone} journeys=${journeysDone}`);
  } catch (err) {
    console.error('[reconcile] run failed:', err);
    // Checkpoint left untouched — see incremental.ts for the same reasoning.
    await prisma.syncState.update({
      where: { key: SYNC_KEY },
      data: { lastRunAt: new Date(), lastRunStatus: 'error' },
    });
    throw err;
  }
}
