import type { TenantConfig } from '../config/types.js';
import { getCachedCategoryValues, setCachedCategoryValues } from './desk-categories-cache.js';
import { createZohoDeskClient, type ZohoDeskClient } from './zoho-desk-client.js';

export interface DeskContext {
  departmentId: string;
  categoryValues: string[];
}

/**
 * Shared by sync entrypoints (scheduler.ts, sync-once.ts, reconcile-once.ts)
 * that need the Desk client for the tickets phase but not the full
 * department/category boot context server.ts resolves for routes — a
 * missing/misconfigured ZOHO_DESK_* just means the tickets phase is skipped,
 * same "not configured" degradation as the CRM zohoClient elsewhere.
 */
export function tryCreateDeskClient(tenantConfig: TenantConfig, logPrefix: string): ZohoDeskClient | undefined {
  try {
    return createZohoDeskClient(tenantConfig.desk.dc, tenantConfig.desk.org_id);
  } catch (err) {
    console.error(`${logPrefix} Zoho Desk client not configured — tickets phase unavailable until ZOHO_DESK_* env vars are set`, err);
    return undefined;
  }
}

/**
 * Startup-style resolution, mirroring validate-fields.ts's role for CRM:
 * turns tenant config's human-chosen department_name into the department ID
 * Desk's ticket-create API actually requires, and fetches the live category
 * picklist rather than hardcoding it. Desk department names have been
 * observed to carry stray trailing whitespace in the admin UI, so the match
 * trims both sides. Throws (rather than returning a boolean) because unlike
 * a single missing reference field, a failure here means ticket creation
 * cannot work at all — callers decorate the app with `undefined` on catch,
 * same as the zohoClient "not configured" fallback in server.ts.
 */
export async function resolveDeskContext(deskClient: ZohoDeskClient, tenantConfig: TenantConfig): Promise<DeskContext> {
  const [departments, fields] = await Promise.all([deskClient.getDepartments(), deskClient.getTicketFields()]);

  const wantedName = tenantConfig.desk.department_name.trim();
  const department = departments.find((d) => d.name.trim() === wantedName);
  if (!department) {
    const seen = departments.map((d) => JSON.stringify(d.name)).join(', ');
    throw new Error(`Zoho Desk: no department matches configured desk.department_name "${tenantConfig.desk.department_name}" (seen: ${seen})`);
  }

  const categoryField = fields.find((f) => f.apiName === tenantConfig.desk.category_field);
  if (!categoryField) {
    throw new Error(`Zoho Desk: no ticket field with apiName "${tenantConfig.desk.category_field}" (configured as desk.category_field)`);
  }

  const categoryValues = (categoryField.allowedValues ?? []).map((v) => v.value);

  return { departmentId: department.id, categoryValues };
}

/**
 * Live (Redis-cached, 60s TTL) category picklist, used instead of trusting
 * the boot-time DeskContext.categoryValues snapshot for anything
 * customer-facing — a tenant adding/removing a category in Desk shouldn't
 * require a redeploy to show up in the app. `fallback` (the boot snapshot)
 * is only used if the live fetch itself fails, so a transient Desk API
 * hiccup degrades to "slightly stale" rather than a broken ticket screen.
 */
export async function getCurrentCategoryValues(deskClient: ZohoDeskClient, tenantConfig: TenantConfig, fallback: string[]): Promise<string[]> {
  const cached = await getCachedCategoryValues();
  if (cached) {
    return cached;
  }

  try {
    const fields = await deskClient.getTicketFields();
    const categoryField = fields.find((f) => f.apiName === tenantConfig.desk.category_field);
    if (!categoryField) {
      throw new Error(`no ticket field with apiName "${tenantConfig.desk.category_field}"`);
    }
    const values = (categoryField.allowedValues ?? []).map((v) => v.value);
    await setCachedCategoryValues(values);
    return values;
  } catch (err) {
    console.error('[desk-context] live category fetch failed, falling back to boot-time snapshot', err);
    return fallback;
  }
}
