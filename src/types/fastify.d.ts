import type { TenantConfig } from '../config/types.js';
import type { DeskContext } from '../lib/desk-context.js';
import type { ZohoClient } from '../lib/zoho-client.js';
import type { ZohoDeskClient } from '../lib/zoho-desk-client.js';

declare module 'fastify' {
  interface FastifyInstance {
    tenantConfig: TenantConfig;
    // undefined when ZOHO_* env vars aren't configured — webhook handlers
    // must still work for the common case (journey already exists locally)
    // and only fail the specific request that actually needs a Zoho fetch.
    zohoClient: ZohoClient | undefined;
    // undefined when ZOHO_DESK_* env vars aren't configured, or when the
    // configured department/category field couldn't be resolved at boot —
    // ticket routes/webhook check for this and return 503 rather than crash.
    deskClient: ZohoDeskClient | undefined;
    deskContext: DeskContext | undefined;
  }
  interface FastifyRequest {
    contactId: string;
  }
}
