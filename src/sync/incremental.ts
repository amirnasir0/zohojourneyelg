import type { TenantConfig } from '../config/types.js';
import { prisma } from '../lib/prisma.js';
import type { ZohoClient } from '../lib/zoho-client.js';
import { clearedCheckpoint, phaseTransitionCheckpoint, resolveRunStart } from './checkpoint.js';
import { writeContactBatch } from './contact-batch.js';
import { writeJourneyBatch } from './journey-batch.js';
import { runPagedPhase } from './paged-phase.js';

const CONTACTS_MODULE = 'Contacts';
const SYNC_KEY = 'incremental';

function uniqueFields(fields: string[]): string[] {
  return [...new Set(fields)];
}

export async function runIncrementalSync(zohoClient: ZohoClient, tenantConfig: TenantConfig): Promise<void> {
  console.log('[incremental] starting run');

  const state = await prisma.syncState.upsert({
    where: { key: SYNC_KEY },
    create: { key: SYNC_KEY },
    update: {},
  });

  const runStart = resolveRunStart(state);

  if (runStart.mode === 'resume') {
    console.log(`[incremental] resuming from page ${runStart.pagesDone + 1} of ${runStart.phase}`);
  } else {
    console.log(`[incremental] watermark from previous run: ${runStart.sinceIso ?? '(none — full historical pull)'}`);
    // Persist the run's starting checkpoint before fetching page 1, so a
    // crash before any page commits still resumes with the correct
    // sinceIso/runStartedAt instead of losing them.
    await prisma.syncState.update({
      where: { key: SYNC_KEY },
      data: phaseTransitionCheckpoint('contacts', runStart.sinceIso, runStart.runStartedAt),
    });
  }

  const { sinceIso, runStartedAt } = runStart;

  try {
    const contactFields = uniqueFields(['id', 'Modified_Time', 'Full_Name', 'Email', ...tenantConfig.zoho.contact_phone_fields]);
    const journeyFields = uniqueFields([
      'id',
      'Modified_Time',
      tenantConfig.zoho.journey_stage_field,
      tenantConfig.zoho.journey_name_field,
      tenantConfig.zoho.journey_contact_lookup_field,
      ...tenantConfig.reference_fields.map((rf) => rf.crm_field),
    ]);

    let contactsWritten = 0;
    let journeysWritten = 0;

    if (runStart.phase === 'contacts') {
      console.log('[incremental] fetching Contacts from Zoho...');
      const result = await runPagedPhase({
        syncKey: SYNC_KEY,
        zohoClient,
        phase: 'contacts',
        module: CONTACTS_MODULE,
        fields: contactFields,
        sinceIso,
        runStartedAt,
        startPageToken: runStart.pageToken,
        startPagesDone: runStart.pagesDone,
        nextPhase: 'journeys',
        writeBatch: (records, extraOps) => writeContactBatch(records, tenantConfig.zoho.contact_phone_fields, extraOps),
        logPrefix: '[incremental]',
      });
      contactsWritten = result.written;
      if (result.stoppedForShutdown) {
        console.log('[incremental] exiting cleanly after shutdown signal');
        return;
      }
    }

    console.log(`[incremental] fetching ${tenantConfig.zoho.journey_module} from Zoho...`);
    const journeyResult = await runPagedPhase({
      syncKey: SYNC_KEY,
      zohoClient,
      phase: 'journeys',
      module: tenantConfig.zoho.journey_module,
      fields: journeyFields,
      sinceIso,
      runStartedAt,
      startPageToken: runStart.phase === 'journeys' ? runStart.pageToken : undefined,
      startPagesDone: runStart.phase === 'journeys' ? runStart.pagesDone : 0,
      nextPhase: null,
      writeBatch: (records, extraOps) => writeJourneyBatch(records, tenantConfig, extraOps),
      logPrefix: '[incremental]',
    });
    journeysWritten = journeyResult.written;
    if (journeyResult.stoppedForShutdown) {
      console.log('[incremental] exiting cleanly after shutdown signal');
      return;
    }

    const issuesCount = await prisma.syncIssue.count({ where: { createdAt: { gte: runStartedAt } } });

    await prisma.syncState.update({
      where: { key: SYNC_KEY },
      data: {
        watermark: runStartedAt,
        lastRunAt: new Date(),
        lastRunStatus: 'success',
        // Reflects records written in this process's execution only — on a
        // resumed run that skipped an already-completed phase, that phase's
        // number here reads 0 even though it was genuinely processed before
        // the crash. Diagnostic for /healthz/sync, not a correctness source;
        // actual row counts are ground truth.
        contactsProcessed: contactsWritten,
        journeysProcessed: journeysWritten,
        issuesCount,
        ...clearedCheckpoint(),
      },
    });

    console.log(
      `[incremental] run complete: contacts=${contactsWritten} journeys=${journeysWritten} issues=${issuesCount} newWatermark=${runStartedAt.toISOString()}`,
    );
  } catch (err) {
    console.error('[incremental] run failed:', err);
    // Checkpoint fields are deliberately left untouched here — they were
    // already committed atomically with the last successfully written page,
    // so the next run resumes from there instead of restarting at page 1.
    await prisma.syncState.update({
      where: { key: SYNC_KEY },
      data: { lastRunAt: new Date(), lastRunStatus: 'error' },
    });
    throw err;
  }
}
