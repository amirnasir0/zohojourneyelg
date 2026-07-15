import type { TenantConfig } from '../config/types.js';
import { prisma } from '../lib/prisma.js';
import type { ZohoClient } from '../lib/zoho-client.js';
import { chunk } from './chunk.js';
import { writeContactBatch } from './contact-batch.js';
import { writeJourneyBatch } from './journey-batch.js';

const CONTACTS_MODULE = 'Contacts';
const BATCH_SIZE = 200;

function uniqueFields(fields: string[]): string[] {
  return [...new Set(fields)];
}

export async function runIncrementalSync(zohoClient: ZohoClient, tenantConfig: TenantConfig): Promise<void> {
  console.log('[incremental] starting run');

  const state = await prisma.syncState.upsert({
    where: { key: 'incremental' },
    create: { key: 'incremental' },
    update: {},
  });

  const sinceIso = state.watermark ? state.watermark.toISOString() : undefined;
  const sinceOpt = sinceIso ? { sinceIso } : {};
  const runStartedAt = new Date();

  console.log(`[incremental] watermark from previous run: ${sinceIso ?? '(none — full historical pull)'}`);

  try {
    const contactFields = uniqueFields(['id', 'Modified_Time', 'Full_Name', 'Email', ...tenantConfig.zoho.contact_phone_fields]);
    console.log('[incremental] fetching Contacts from Zoho...');
    const contactRecords = await zohoClient.getRecords(CONTACTS_MODULE, { fields: contactFields, ...sinceOpt });
    console.log(`[incremental] ${contactRecords.length} contact record(s) to process`);

    const contactChunks = chunk(contactRecords, BATCH_SIZE);
    let contactsWritten = 0;
    for (let i = 0; i < contactChunks.length; i++) {
      const batch = contactChunks[i];
      if (!batch) continue;
      const { written } = await writeContactBatch(batch, tenantConfig.zoho.contact_phone_fields);
      contactsWritten += written;
      console.log(`[incremental] contacts batch ${i + 1}/${contactChunks.length} done (${written} written, ${contactsWritten} total)`);
    }

    const journeyFields = uniqueFields([
      'id',
      'Modified_Time',
      tenantConfig.zoho.journey_stage_field,
      tenantConfig.zoho.journey_name_field,
      tenantConfig.zoho.journey_contact_lookup_field,
      ...tenantConfig.reference_fields.map((rf) => rf.crm_field),
    ]);
    console.log(`[incremental] fetching ${tenantConfig.zoho.journey_module} from Zoho...`);
    const journeyRecords = await zohoClient.getRecords(tenantConfig.zoho.journey_module, { fields: journeyFields, ...sinceOpt });
    console.log(`[incremental] ${journeyRecords.length} journey record(s) to process`);

    const journeyChunks = chunk(journeyRecords, BATCH_SIZE);
    let journeysWritten = 0;
    for (let i = 0; i < journeyChunks.length; i++) {
      const batch = journeyChunks[i];
      if (!batch) continue;
      const { written } = await writeJourneyBatch(batch, tenantConfig);
      journeysWritten += written;
      console.log(`[incremental] journeys batch ${i + 1}/${journeyChunks.length} done (${written} written, ${journeysWritten} total)`);
    }

    const issuesCount = await prisma.syncIssue.count({ where: { createdAt: { gte: runStartedAt } } });

    await prisma.syncState.update({
      where: { key: 'incremental' },
      data: {
        watermark: runStartedAt,
        lastRunAt: new Date(),
        lastRunStatus: 'success',
        contactsProcessed: contactsWritten,
        journeysProcessed: journeysWritten,
        issuesCount,
      },
    });

    console.log(
      `[incremental] run complete: contacts=${contactsWritten} journeys=${journeysWritten} issues=${issuesCount} newWatermark=${runStartedAt.toISOString()}`,
    );
  } catch (err) {
    console.error('[incremental] run failed:', err);
    await prisma.syncState.update({
      where: { key: 'incremental' },
      data: { lastRunAt: new Date(), lastRunStatus: 'error' },
    });
    throw err;
  }
}
