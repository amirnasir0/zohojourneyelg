import { loadTenantConfig } from '../config/loader.js';
import { createZohoClient } from '../lib/zoho-client.js';
import { prisma } from '../lib/prisma.js';
import { runIncrementalSync } from '../sync/incremental.js';
import { validateZohoFieldMapping } from '../sync/validate-fields.js';

async function main(): Promise<void> {
  console.log('[sync:once] starting');

  const configPath = process.env.TENANT_CONFIG_PATH;
  if (!configPath) {
    throw new Error('TENANT_CONFIG_PATH env var is required');
  }

  const tenantConfig = loadTenantConfig(configPath);
  console.log(`[sync:once] tenant config loaded: slug=${tenantConfig.tenant.slug} dc=${tenantConfig.zoho.dc} journey_module=${tenantConfig.zoho.journey_module}`);

  const zohoClient = createZohoClient(tenantConfig.zoho.dc);

  console.log('[sync:once] validating Zoho field mapping...');
  const fieldsOk = await validateZohoFieldMapping(zohoClient, tenantConfig);
  if (!fieldsOk) {
    throw new Error('tenant config field mapping is invalid (see [zoho-config] error above)');
  }
  console.log('[sync:once] field mapping OK');

  await runIncrementalSync(zohoClient, tenantConfig);

  const [contacts, journeys, issues, state] = await Promise.all([
    prisma.contact.count(),
    prisma.journey.count(),
    prisma.syncIssue.count(),
    prisma.syncState.findUnique({ where: { key: 'incremental' } }),
  ]);

  console.log('[sync:once] final row counts:');
  console.log(`  Contact:    ${contacts}`);
  console.log(`  Journey:    ${journeys}`);
  console.log(`  SyncIssue:  ${issues}`);
  console.log('[sync:once] SyncState(incremental):', JSON.stringify(state, null, 2));
  console.log('[sync:once] incremental sync complete');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[sync:once] FAILED:', err);
    process.exit(1);
  });
