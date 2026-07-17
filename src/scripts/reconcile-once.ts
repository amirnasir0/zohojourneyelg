import { loadTenantConfig } from '../config/loader.js';
import { tryCreateDeskClient } from '../lib/desk-context.js';
import { createZohoClient } from '../lib/zoho-client.js';
import { prisma } from '../lib/prisma.js';
import { runFullReconcile } from '../sync/reconcile.js';
import { requestShutdown } from '../sync/paged-phase.js';
import { validateZohoFieldMapping } from '../sync/validate-fields.js';

let shuttingDown = false;

function handleShutdownSignal(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[sync:reconcile] received ${signal}, finishing the in-flight page batch then exiting...`);
  requestShutdown();
}

process.on('SIGINT', handleShutdownSignal);
process.on('SIGTERM', handleShutdownSignal);

async function main(): Promise<void> {
  console.log('[sync:reconcile] starting');

  const configPath = process.env.TENANT_CONFIG_PATH;
  if (!configPath) {
    throw new Error('TENANT_CONFIG_PATH env var is required');
  }

  const tenantConfig = loadTenantConfig(configPath);
  console.log(`[sync:reconcile] tenant config loaded: slug=${tenantConfig.tenant.slug} dc=${tenantConfig.zoho.dc} journey_module=${tenantConfig.zoho.journey_module}`);

  const zohoClient = createZohoClient(tenantConfig.zoho.dc);

  console.log('[sync:reconcile] validating Zoho field mapping...');
  const fieldsOk = await validateZohoFieldMapping(zohoClient, tenantConfig);
  if (!fieldsOk) {
    throw new Error('tenant config field mapping is invalid (see [zoho-config] error above)');
  }
  console.log('[sync:reconcile] field mapping OK');

  const deskClient = tryCreateDeskClient(tenantConfig, '[sync:reconcile]');

  await runFullReconcile(zohoClient, tenantConfig, deskClient);

  const [contacts, journeys, tickets, issues, state] = await Promise.all([
    prisma.contact.count(),
    prisma.journey.count(),
    prisma.ticket.count(),
    prisma.syncIssue.count(),
    prisma.syncState.findUnique({ where: { key: 'full_reconcile' } }),
  ]);

  console.log('[sync:reconcile] final row counts:');
  console.log(`  Contact:    ${contacts}`);
  console.log(`  Journey:    ${journeys}`);
  console.log(`  Ticket:     ${tickets}`);
  console.log(`  SyncIssue:  ${issues}`);
  console.log('[sync:reconcile] SyncState(full_reconcile):', JSON.stringify(state, null, 2));
  console.log(shuttingDown ? '[sync:reconcile] stopped early for graceful shutdown (checkpoint persisted, rerun to continue)' : '[sync:reconcile] full reconcile complete');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[sync:reconcile] FAILED:', err);
    process.exit(1);
  });
