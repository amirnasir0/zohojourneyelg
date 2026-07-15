import Fastify from 'fastify';
import { loadTenantConfig } from './config/loader.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { createZohoClient } from './lib/zoho-client.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerHealthzRoutes } from './routes/healthz.js';
import { registerMeRoutes } from './routes/me.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { startSyncScheduler } from './sync/scheduler.js';

const app = Fastify({
  logger: true,
});

const tenantConfigPath = process.env.TENANT_CONFIG_PATH;
if (!tenantConfigPath) {
  throw new Error('TENANT_CONFIG_PATH env var is required');
}
app.decorate('tenantConfig', loadTenantConfig(tenantConfigPath));

// Webhooks must work independently of ENABLE_SYNC — the scheduler being
// disabled shouldn't stop instant stage-change/contact updates from Zoho.
// Only the Zoho client itself is optional (missing creds -> the specific
// webhook requests that need a single-record fetch fail with 503; the common
// case of a journey that already exists locally still works).
try {
  app.decorate('zohoClient', createZohoClient(app.tenantConfig.zoho.dc));
} catch (err) {
  app.log.warn({ err }, '[webhooks] Zoho client not configured — fetch-by-id fallback unavailable until ZOHO_* env vars are set');
  app.decorate('zohoClient', undefined);
}

await registerHealthzRoutes(app);
await registerAuthRoutes(app);
await registerConfigRoutes(app);
await registerMeRoutes(app);
await registerWebhookRoutes(app);

startSyncScheduler(app.tenantConfig);

app.addHook('onClose', async () => {
  await prisma.$disconnect();
  redis.disconnect();
});

const port = Number(process.env.PORT ?? 3000);

app
  .listen({ port, host: '0.0.0.0' })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
