import type { TenantConfig } from '../config/types.js';
import type { ZohoDeskClient } from './zoho-desk-client.js';

export interface DeskContext {
  departmentId: string;
  categoryValues: string[];
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
