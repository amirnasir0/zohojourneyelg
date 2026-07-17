import { loadTenantConfig } from '../config/loader.js';
import { tryCreateDeskClient } from '../lib/desk-context.js';
import { createZohoClient } from '../lib/zoho-client.js';
import { prisma } from '../lib/prisma.js';
import { runIncrementalSync } from '../sync/incremental.js';
import { requestShutdown } from '../sync/paged-phase.js';
import { validateZohoFieldMapping } from '../sync/validate-fields.js';

let shuttingDown = false;

// SIGKILL (kill -9) can't be caught by any process — this handler exists for
// an orderly Ctrl-C or a deploy-triggered SIGTERM, not for the mandatory
// kill-9 resumability test. That test is proven by the per-page checkpoint
// being committed atomically with its data, not by signal handling: even
// with zero chance to clean up, the last committed page's checkpoint is
// already durable in Postgres.
function handleShutdownSignal(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[sync:once] received ${signal}, finishing the in-flight page batch then exiting...`);
  requestShutdown();
}

process.on('SIGINT', handleShutdownSignal);
process.on('SIGTERM', handleShutdownSignal);

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

  const deskClient = tryCreateDeskClient(tenantConfig, '[sync:once]');

  await runIncrementalSync(zohoClient, tenantConfig, deskClient);

  const [contacts, journeys, tickets, issues, state] = await Promise.all([
    prisma.contact.count(),
    prisma.journey.count(),
    prisma.ticket.count(),
    prisma.syncIssue.count(),
    prisma.syncState.findUnique({ where: { key: 'incremental' } }),
  ]);

  console.log('[sync:once] final row counts:');
  console.log(`  Contact:    ${contacts}`);
  console.log(`  Journey:    ${journeys}`);
  console.log(`  Ticket:     ${tickets}`);
  console.log(`  SyncIssue:  ${issues}`);
  console.log('[sync:once] SyncState(incremental):', JSON.stringify(state, null, 2));
  console.log(shuttingDown ? '[sync:once] stopped early for graceful shutdown (checkpoint persisted, rerun to continue)' : '[sync:once] incremental sync complete');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[sync:once] FAILED:', err);
    process.exit(1);
  });
