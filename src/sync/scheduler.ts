import { schedule } from 'node-cron';
import type { TenantConfig } from '../config/types.js';
import { createZohoClient } from '../lib/zoho-client.js';
import { runIncrementalSync } from './incremental.js';
import { runFullReconcile } from './reconcile.js';
import { validateZohoFieldMapping } from './validate-fields.js';

/**
 * Same-process scheduler for now (single always-on instance). Gated by
 * ENABLE_SYNC so the API can boot in tests/local dev without cron firing, and
 * so a future split into a dedicated worker process just means setting this
 * to false on the API side.
 */
export function startSyncScheduler(tenantConfig: TenantConfig): void {
  if (process.env.ENABLE_SYNC === 'false') {
    console.log('[sync] ENABLE_SYNC=false, scheduler not started');
    return;
  }

  let zohoClient;
  try {
    zohoClient = createZohoClient(tenantConfig.zoho.dc);
  } catch (err) {
    console.error('[sync] scheduler not started: Zoho client could not be configured', err);
    return;
  }

  validateZohoFieldMapping(zohoClient, tenantConfig).catch((err) => {
    console.error('[sync] field mapping validation failed to run', err);
  });

  schedule(
    '*/15 * * * *',
    async () => {
      try {
        await runIncrementalSync(zohoClient, tenantConfig);
      } catch (err) {
        console.error('[sync] incremental sync failed', err);
      }
    },
    { noOverlap: true, name: 'incremental-sync' },
  );

  schedule(
    '0 2 * * *',
    async () => {
      try {
        await runFullReconcile(zohoClient, tenantConfig);
      } catch (err) {
        console.error('[sync] full reconcile failed', err);
      }
    },
    { noOverlap: true, name: 'full-reconcile' },
  );

  console.log('[sync] scheduler started: incremental every 15min, full reconcile nightly at 02:00');
}
