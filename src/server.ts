import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify from 'fastify';
import { loadTenantConfig } from './config/loader.js';
import { isPrismaConnectionError } from './lib/prisma-errors.js';
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

await app.register(helmet, { contentSecurityPolicy: false });

// The RN app is unaffected by any of this — CORS only governs browser
// requests, and native HTTP requests never carry an Origin header. This
// exists purely to lock down what a browser-hosted client is allowed to do,
// per PRD §13 ("strict CORS"). CORS_ORIGINS unset/empty => every browser
// origin is denied outright (the plugin is still registered so preflight
// requests get a clean, explicit deny rather than falling through).
const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

await app.register(cors, {
  origin(origin, callback) {
    if (origin && corsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
});

app.setErrorHandler((err, req, reply) => {
  req.log.error({ err }, 'unhandled request error');

  if (isPrismaConnectionError(err)) {
    reply.code(503).send({ error: 'SERVICE_UNAVAILABLE' });
    return;
  }

  const statusCode = 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;

  if (process.env.NODE_ENV !== 'production') {
    reply.code(statusCode).send({ error: err.name, message: err.message });
    return;
  }

  if (statusCode >= 400 && statusCode < 500) {
    reply.code(statusCode).send({ error: 'BAD_REQUEST' });
    return;
  }

  reply.code(500).send({ error: 'INTERNAL_ERROR' });
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
