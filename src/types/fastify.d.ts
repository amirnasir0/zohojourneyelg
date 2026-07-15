import type { TenantConfig } from '../config/types.js';
import type { ZohoClient } from '../lib/zoho-client.js';

declare module 'fastify' {
  interface FastifyInstance {
    tenantConfig: TenantConfig;
    // undefined when ZOHO_* env vars aren't configured — webhook handlers
    // must still work for the common case (journey already exists locally)
    // and only fail the specific request that actually needs a Zoho fetch.
    zohoClient: ZohoClient | undefined;
  }
  interface FastifyRequest {
    contactId: string;
  }
}
