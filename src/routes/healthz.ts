import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';

const REDIS_PING_TIMEOUT_MS = 2000;
// PRD §15: alert if last sync > 30 min. Full reconcile only runs nightly, so it needs a wider window.
const INCREMENTAL_STALE_THRESHOLD_MS = 30 * 60 * 1000;
const FULL_RECONCILE_STALE_THRESHOLD_MS = 25 * 60 * 60 * 1000;

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
    const [incremental, fullReconcile] = await Promise.all([
      prisma.syncState.findUnique({ where: { key: 'incremental' } }),
      prisma.syncState.findUnique({ where: { key: 'full_reconcile' } }),
    ]);

    const isStale = (lastRunAt: Date | null | undefined, thresholdMs: number): boolean => {
      if (!lastRunAt) return true;
      return Date.now() - lastRunAt.getTime() > thresholdMs;
    };

    return reply.code(200).send({
      incremental: incremental
        ? {
            watermark: incremental.watermark,
            lastRunAt: incremental.lastRunAt,
            lastRunStatus: incremental.lastRunStatus,
            contactsProcessed: incremental.contactsProcessed,
            journeysProcessed: incremental.journeysProcessed,
            ticketsProcessed: incremental.ticketsProcessed,
            issuesCount: incremental.issuesCount,
            stale: isStale(incremental.lastRunAt, INCREMENTAL_STALE_THRESHOLD_MS),
          }
        : null,
      fullReconcile: fullReconcile
        ? {
            lastRunAt: fullReconcile.lastRunAt,
            lastRunStatus: fullReconcile.lastRunStatus,
            contactsProcessed: fullReconcile.contactsProcessed,
            journeysProcessed: fullReconcile.journeysProcessed,
            ticketsProcessed: fullReconcile.ticketsProcessed,
            stale: isStale(fullReconcile.lastRunAt, FULL_RECONCILE_STALE_THRESHOLD_MS),
          }
        : null,
    });
  });
}
