import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';

const REDIS_PING_TIMEOUT_MS = 2000;

function pingWithTimeout(timeoutMs: number): Promise<unknown> {
  return Promise.race([
    redis.ping(),
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('redis ping timed out')), timeoutMs);
    }),
  ]);
}

export async function registerHealthzRoutes(app: FastifyInstance) {
  app.get('/healthz', async (_req, reply) => {
    try {
      await pingWithTimeout(REDIS_PING_TIMEOUT_MS);
    } catch (err) {
      app.log.error({ err }, 'healthz: redis check failed');
      return reply.code(503).send({ status: 'error', component: 'redis' });
    }

    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      app.log.error({ err }, 'healthz: database check failed');
      return reply.code(503).send({ status: 'error', component: 'database' });
    }

    return reply.code(200).send({ status: 'ok' });
  });

  app.get('/healthz/sync', async (_req, reply) => {
    const status = await prisma.syncStatus.findFirst();
    return reply.code(200).send({ lastSyncAt: status?.lastSuccessAt ?? null });
  });
}
