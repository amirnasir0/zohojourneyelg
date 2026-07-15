import type { TenantConfig } from '../config/types.js';
import type { ZohoClient } from '../lib/zoho-client.js';
import { writeContactBatch } from '../sync/contact-batch.js';
import type { WebhookResult } from './types.js';

/**
 * Deliberately minimal payload contract — only the record id. Fetching the
 * full record by ID and reusing writeContactBatch (same phone
 * re-normalization + SyncIssue logging as sync) means the webhook body
 * doesn't need to track contact_phone_fields, which is itself dynamic
 * tenant config. Keeping the two in sync on the Zoho side would be fragile.
 */
export async function handleContactUpdated(body: unknown, tenantConfig: TenantConfig, zohoClient: ZohoClient | undefined): Promise<WebhookResult> {
  const mapping = tenantConfig.webhooks.contact_updated;
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const recordId = b[mapping.record_id_field];

  if (typeof recordId !== 'string' || !recordId) {
    return { status: 400, body: { error: 'INVALID_PAYLOAD' } };
  }

  if (!zohoClient) {
    console.error(`[webhook contact-updated] record ${recordId}: Zoho client is unavailable (missing ZOHO_* env vars)`);
    return { status: 503, body: { error: 'ZOHO_CLIENT_UNAVAILABLE' } };
  }

  const contactFields = [...new Set(['id', 'Modified_Time', 'Full_Name', 'Email', ...tenantConfig.zoho.contact_phone_fields])];
  const fetched = await zohoClient.getRecord('Contacts', recordId, contactFields);

  if (!fetched) {
    console.error(`[webhook contact-updated] Zoho record ${recordId} not found (404) — treating as no-op`);
    return { status: 200, body: { success: true, note: 'record not found in Zoho' } };
  }

  await writeContactBatch([fetched], tenantConfig.zoho.contact_phone_fields);

  return { status: 200, body: { success: true } };
}
