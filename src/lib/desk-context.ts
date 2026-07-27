import type { TenantConfig } from '../config/types.js';
import { getCachedCategoryValues, setCachedCategoryValues } from './desk-categories-cache.js';
import { createZohoDeskClient, type DeskLayout, type ZohoDeskClient } from './zoho-desk-client.js';

export interface DeskContext {
  departmentId: string;
  layoutId: string;
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
 * Confirmed live 27 Jul: a field's org-wide master picklist
 * (getTicketFields/organizationFields) is a SUPERSET of what a given
 * department's layout actually shows — production had "General"/"Defects"
 * still present at the org level long after they were removed from the
 * layout's Category field. The layout's own field customization is the one
 * that matches what a real ticket-creation form (and therefore this app)
 * should offer, so category resolution always goes through here instead.
 */
function extractCategoryValues(layout: DeskLayout, categoryFieldApiName: string): string[] {
  const fields = layout.sections?.flatMap((s) => s.fields) ?? [];
  const categoryField = fields.find((f) => f.apiName === categoryFieldApiName);
  if (!categoryField) {
    throw new Error(`Zoho Desk: layout "${layout.id}" has no field with apiName "${categoryFieldApiName}" (configured as desk.category_field)`);
  }
  return categoryField.allowedValues ?? [];
}

/**
 * Startup-style resolution, mirroring validate-fields.ts's role for CRM:
 * turns tenant config's human-chosen department_name into the department ID
 * Desk's ticket-create API actually requires, finds that department's
 * ticket layout, and fetches the live category picklist FROM THAT LAYOUT
 * (not the org-wide field metadata — see extractCategoryValues) rather than
 * hardcoding it. Desk department names have been observed to carry stray
 * trailing whitespace in the admin UI, so the match trims both sides.
 * Throws (rather than returning a boolean) because unlike a single missing
 * reference field, a failure here means ticket creation cannot work at
 * all — callers decorate the app with `undefined` on catch, same as the
 * zohoClient "not configured" fallback in server.ts.
 */
export async function resolveDeskContext(deskClient: ZohoDeskClient, tenantConfig: TenantConfig): Promise<DeskContext> {
  const [departments, layouts] = await Promise.all([deskClient.getDepartments(), deskClient.getLayouts()]);

  const wantedName = tenantConfig.desk.department_name.trim();
  const department = departments.find((d) => d.name.trim() === wantedName);
  if (!department) {
    const seen = departments.map((d) => JSON.stringify(d.name)).join(', ');
    throw new Error(`Zoho Desk: no department matches configured desk.department_name "${tenantConfig.desk.department_name}" (seen: ${seen})`);
  }

  const layoutSummary = layouts.find((l) => l.departmentId === department.id);
  if (!layoutSummary) {
    throw new Error(`Zoho Desk: no ticket layout found for department "${department.name}" (id ${department.id})`);
  }

  // The list endpoint above never includes `sections` — need the
  // single-layout detail fetch for field customization/allowedValues.
  const layout = await deskClient.getLayout(layoutSummary.id);
  const categoryValues = extractCategoryValues(layout, tenantConfig.desk.category_field);

  return { departmentId: department.id, layoutId: layout.id, categoryValues };
}

/**
 * Live (Redis-cached, 60s TTL) category picklist, used instead of trusting
 * the boot-time DeskContext.categoryValues snapshot for anything
 * customer-facing — a tenant adding/removing a category in Desk shouldn't
 * require a redeploy to show up in the app. `fallback` (the boot snapshot)
 * is only used if the live fetch itself fails, so a transient Desk API
 * hiccup degrades to "slightly stale" rather than a broken ticket screen.
 */
export async function getCurrentCategoryValues(deskClient: ZohoDeskClient, tenantConfig: TenantConfig, layoutId: string, fallback: string[]): Promise<string[]> {
  const cached = await getCachedCategoryValues();
  if (cached) {
    return cached;
  }

  try {
    const layout = await deskClient.getLayout(layoutId);
    const values = extractCategoryValues(layout, tenantConfig.desk.category_field);
    await setCachedCategoryValues(values);
    return values;
  } catch (err) {
    console.error('[desk-context] live category fetch failed, falling back to boot-time snapshot', err);
    return fallback;
  }
}
