import { writeFileSync } from 'node:fs';
import { loadTenantConfig } from '../config/loader.js';
import { createZohoClient } from '../lib/zoho-client.js';
import { prisma } from '../lib/prisma.js';

const OUTPUT_PATH = 'outputs/orphan-contact-phone-report.csv';
const CONTACT_PHONE_REASONS = ['NO_VALID_MOBILE', 'UNPARSEABLE_PHONE', 'DUPLICATE_MOBILE'];

function csvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

async function main(): Promise<void> {
  console.log('[export-orphan-contact-report] starting');

  const configPath = process.env.TENANT_CONFIG_PATH;
  if (!configPath) {
    throw new Error('TENANT_CONFIG_PATH env var is required');
  }
  const tenantConfig = loadTenantConfig(configPath);
  const zohoClient = createZohoClient(tenantConfig.zoho.dc);

  const issues = await prisma.syncIssue.findMany({
    where: { recordType: 'contact', reason: { in: CONTACT_PHONE_REASONS } },
    select: { zohoRecordId: true, rawValue: true, reason: true },
    orderBy: [{ zohoRecordId: 'asc' }, { reason: 'asc' }],
  });
  console.log(`[export-orphan-contact-report] ${issues.length} contact phone-quality issue(s) found`);

  const distinctIds = [...new Set(issues.map((i) => i.zohoRecordId).filter((id): id is string => Boolean(id)))];
  console.log(`[export-orphan-contact-report] fetching current name for ${distinctIds.length} distinct contact(s) from Zoho...`);

  const nameById = new Map<string, string>();
  for (const [i, id] of distinctIds.entries()) {
    try {
      const record = await zohoClient.getRecord('Contacts', id, ['Full_Name']);
      const name = typeof record?.Full_Name === 'string' ? record.Full_Name : '';
      nameById.set(id, name);
    } catch (err) {
      console.error(`[export-orphan-contact-report] could not fetch name for contact ${id}, leaving blank:`, err);
      nameById.set(id, '');
    }
    if ((i + 1) % 25 === 0) {
      console.log(`[export-orphan-contact-report] ${i + 1}/${distinctIds.length} names fetched`);
    }
  }

  const header = ['zoho_contact_id', 'contact_name', 'raw_phone_value', 'reason'];
  const rows = issues.map((issue) => {
    const id = issue.zohoRecordId ?? '';
    return [id, nameById.get(id) ?? '', issue.rawValue ?? '', issue.reason].map(csvField).join(',');
  });

  writeFileSync(OUTPUT_PATH, [header.join(','), ...rows].join('\n') + '\n', 'utf-8');
  console.log(`[export-orphan-contact-report] wrote ${rows.length} row(s) to ${OUTPUT_PATH}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[export-orphan-contact-report] FAILED:', err);
    process.exit(1);
  });
