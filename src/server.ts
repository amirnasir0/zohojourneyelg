import Fastify from 'fastify';
import { loadTenantConfig } from './config/loader.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthzRoutes } from './routes/healthz.js';
import { startSyncScheduler } from './sync/scheduler.js';

const app = Fastify({
  logger: true,
});

const tenantConfigPath = process.env.TENANT_CONFIG_PATH;
if (!tenantConfigPath) {
  throw new Error('TENANT_CONFIG_PATH env var is required');
}
app.decorate('tenantConfig', loadTenantConfig(tenantConfigPath));

await registerHealthzRoutes(app);
await registerAuthRoutes(app);

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
