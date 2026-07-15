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

export async function runFullReconcile(zohoClient: ZohoClient, tenantConfig: TenantConfig): Promise<void> {
  console.log('[reconcile] starting run (full pull, no watermark)');

  try {
    const contactFields = uniqueFields(['id', 'Modified_Time', 'Full_Name', 'Email', ...tenantConfig.zoho.contact_phone_fields]);
    console.log('[reconcile] fetching Contacts from Zoho...');
    const allContacts = await zohoClient.getRecords(CONTACTS_MODULE, { fields: contactFields });
    console.log(`[reconcile] ${allContacts.length} contact record(s) to process`);

    const contactChunks = chunk(allContacts, BATCH_SIZE);
    let contactsDone = 0;
    for (let i = 0; i < contactChunks.length; i++) {
      const batch = contactChunks[i];
      if (!batch) continue;
      const { written } = await writeContactBatch(batch, tenantConfig.zoho.contact_phone_fields);
      contactsDone += written;
      console.log(`[reconcile] contacts batch ${i + 1}/${contactChunks.length} done (${written} written, ${contactsDone} total)`);
    }

    const zohoContactIds = allContacts.map((c) => String(c.id));
    if (zohoContactIds.length > 0) {
      const { count } = await prisma.contact.deleteMany({ where: { zohoContactId: { notIn: zohoContactIds } } });
      console.log(`[reconcile] contact cleanup: removed ${count} local row(s) not present in Zoho`);
    } else {
      console.error('[reconcile] Zoho returned zero contacts, skipping contact cleanup to avoid wiping local data');
    }

    const journeyFields = uniqueFields([
      'id',
      'Modified_Time',
      tenantConfig.zoho.journey_stage_field,
      tenantConfig.zoho.journey_name_field,
      tenantConfig.zoho.journey_contact_lookup_field,
      ...tenantConfig.reference_fields.map((rf) => rf.crm_field),
    ]);
    console.log(`[reconcile] fetching ${tenantConfig.zoho.journey_module} from Zoho...`);
    const allJourneys = await zohoClient.getRecords(tenantConfig.zoho.journey_module, { fields: journeyFields });
    console.log(`[reconcile] ${allJourneys.length} journey record(s) to process`);

    const journeyChunks = chunk(allJourneys, BATCH_SIZE);
    let journeysDone = 0;
    for (let i = 0; i < journeyChunks.length; i++) {
      const batch = journeyChunks[i];
      if (!batch) continue;
      const { written } = await writeJourneyBatch(batch, tenantConfig);
      journeysDone += written;
      console.log(`[reconcile] journeys batch ${i + 1}/${journeyChunks.length} done (${written} written, ${journeysDone} total)`);
    }

    const zohoJourneyIds = allJourneys.map((j) => String(j.id));
    if (zohoJourneyIds.length > 0) {
      const { count } = await prisma.journey.deleteMany({ where: { zohoRecordId: { notIn: zohoJourneyIds } } });
      console.log(`[reconcile] journey cleanup: removed ${count} local row(s) not present in Zoho`);
    } else {
      console.error('[reconcile] Zoho returned zero journey records, skipping journey cleanup to avoid wiping local data');
    }

    await prisma.syncState.upsert({
      where: { key: 'full_reconcile' },
      create: {
        key: 'full_reconcile',
        lastRunAt: new Date(),
        lastRunStatus: 'success',
        contactsProcessed: contactsDone,
        journeysProcessed: journeysDone,
      },
      update: {
        lastRunAt: new Date(),
        lastRunStatus: 'success',
        contactsProcessed: contactsDone,
        journeysProcessed: journeysDone,
      },
    });

    console.log(`[reconcile] run complete: contacts=${contactsDone} journeys=${journeysDone}`);
  } catch (err) {
    console.error('[reconcile] run failed:', err);
    await prisma.syncState.upsert({
      where: { key: 'full_reconcile' },
      create: { key: 'full_reconcile', lastRunAt: new Date(), lastRunStatus: 'error' },
      update: { lastRunAt: new Date(), lastRunStatus: 'error' },
    });
    throw err;
  }
}
