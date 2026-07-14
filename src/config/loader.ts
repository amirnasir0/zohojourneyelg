import { readFileSync } from 'node:fs';
import { tenantConfigSchema } from './schema.js';
import type { TenantConfig } from './types.js';

export function loadTenantConfig(path: string): TenantConfig {
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw);
  return tenantConfigSchema.parse(parsed);
}
