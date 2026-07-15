import type { TenantConfig } from '../config/types.js';
import type { ZohoClient } from '../lib/zoho-client.js';

/**
 * Startup-style check: confirms every journey/reference field name configured
 * in the tenant config actually exists on the Zoho module. Logs a clear error
 * (never throws) if something's missing, so a config typo shows up immediately
 * instead of silently producing null stage_index / missing ref_values forever.
 */
export async function validateZohoFieldMapping(zohoClient: ZohoClient, tenantConfig: TenantConfig): Promise<boolean> {
  const fields = await zohoClient.getModuleFields(tenantConfig.zoho.journey_module);
  const apiNames = new Set(fields.map((f) => f.api_name));

  const required = [
    tenantConfig.zoho.journey_stage_field,
    tenantConfig.zoho.journey_name_field,
    tenantConfig.zoho.journey_contact_lookup_field,
    ...tenantConfig.reference_fields.map((rf) => rf.crm_field),
  ];

  const missing = required.filter((name) => !apiNames.has(name));

  if (missing.length > 0) {
    console.error(
      `[zoho-config] tenant config references fields that do not exist on Zoho module "${tenantConfig.zoho.journey_module}": ${missing.join(', ')}`,
    );
    return false;
  }

  return true;
}
