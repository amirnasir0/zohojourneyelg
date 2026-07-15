import type { TenantConfig } from '../config/types.js';

declare module 'fastify' {
  interface FastifyInstance {
    tenantConfig: TenantConfig;
  }
  interface FastifyRequest {
    contactId: string;
  }
}
