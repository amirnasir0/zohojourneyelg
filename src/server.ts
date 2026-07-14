import Fastify from 'fastify';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { registerHealthzRoutes } from './routes/healthz.js';

const app = Fastify({
  logger: true,
});

await registerHealthzRoutes(app);

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
