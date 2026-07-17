import { schedule } from 'node-cron';
import type { TenantConfig } from '../config/types.js';
import { tryCreateDeskClient } from '../lib/desk-context.js';
import { createZohoClient } from '../lib/zoho-client.js';
import { runIncrementalSync } from './incremental.js';
import { runFullReconcile } from './reconcile.js';
import { validateZohoFieldMapping } from './validate-fields.js';

export type StopScheduler = () => Promise<void>;

/**
 * Same-process scheduler for now (single always-on instance). Gated by
 * ENABLE_SYNC so the API can boot in tests/local dev without cron firing, and
 * so a future split into a dedicated worker process just means setting this
 * to false on the API side. Returns a stop function so the server's graceful
 * shutdown can stop cron from firing again before closing everything else —
 * a no-op when the scheduler was never started.
 */
export function startSyncScheduler(tenantConfig: TenantConfig): StopScheduler {
  const noop: StopScheduler = async () => {};

  if (process.env.ENABLE_SYNC === 'false') {
    console.log('[sync] sync scheduler disabled via ENABLE_SYNC');
    return noop;
  }

  let zohoClient;
  try {
    zohoClient = createZohoClient(tenantConfig.zoho.dc);
  } catch (err) {
    console.error('[sync] scheduler not started: Zoho client could not be configured', err);
    return noop;
  }

  validateZohoFieldMapping(zohoClient, tenantConfig).catch((err) => {
    console.error('[sync] field mapping validation failed to run', err);
  });

  const deskClient = tryCreateDeskClient(tenantConfig, '[sync]');

  const incrementalTask = schedule(
    '*/15 * * * *',
    async () => {
      try {
        await runIncrementalSync(zohoClient, tenantConfig, deskClient);
      } catch (err) {
        console.error('[sync] incremental sync failed', err);
      }
    },
    { noOverlap: true, name: 'incremental-sync' },
  );

  const reconcileTask = schedule(
    '0 2 * * *',
    async () => {
      try {
        await runFullReconcile(zohoClient, tenantConfig, deskClient);
      } catch (err) {
        console.error('[sync] full reconcile failed', err);
      }
    },
    { noOverlap: true, name: 'full-reconcile' },
  );

  console.log('[sync] scheduler started: incremental every 15min, full reconcile nightly at 02:00');

  return async () => {
    await Promise.all([incrementalTask.stop(), reconcileTask.stop()]);
    console.log('[sync] scheduler stopped');
  };
}
