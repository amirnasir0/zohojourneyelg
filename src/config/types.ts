import type { z } from 'zod';
import type { tenantConfigSchema } from './schema.js';

export type TenantConfig = z.infer<typeof tenantConfigSchema>;
