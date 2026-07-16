import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../lib/auth-middleware.js';
import { sendWithEtag } from '../lib/http-cache.js';
import { buildJourneySummary, buildStageTimeline, type JourneySummary } from '../lib/journey-view.js';
import { getCachedJourneys, setCachedJourneys } from '../lib/journeys-cache.js';
import { prisma } from '../lib/prisma.js';
import { extractCreatedTime, isDateDrivenJourney, resolveDateDrivenStage } from '../sync/date-stage-resolve.js';

export async function registerMeRoutes(app: FastifyInstance) {
  app.get('/me', { preHandler: requireAuth }, async (req, reply) => {
    const contact = await prisma.contact.findUnique({ where: { id: req.contactId } });
    if (!contact) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }

    const payload = {
      id: contact.id,
      full_name: contact.fullName,
      mobile: contact.mobileE164,
      email: contact.email,
    };

    return sendWithEtag(req, reply, payload, 'private, no-cache');
  });

  app.get('/me/journeys', { preHandler: requireAuth }, async (req, reply) => {
    let payload = await getCachedJourneys<JourneySummary>(req.contactId);

    if (!payload) {
      const journeys = await prisma.journey.findMany({ where: { contactId: req.contactId } });
      payload = journeys
        .map((j) => buildJourneySummary(j, app.tenantConfig))
        .filter((s): s is JourneySummary => s !== null);
      await setCachedJourneys(req.contactId, payload);
    }

    return sendWithEtag(req, reply, payload, 'private, no-cache');
  });

  app.get('/me/journeys/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const journey = await prisma.journey.findFirst({ where: { id, contactId: req.contactId } });
    if (!journey) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }

    const summary = buildJourneySummary(journey, app.tenantConfig);
    if (!summary) {
      // "hidden"-type stage — customers must never see it. Same 404 as a
      // nonexistent/foreign journey, never a 403 that would confirm it exists.
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }

    const payload: Record<string, unknown> = { ...summary };

    if (summary.status === 'in_progress') {
      if (isDateDrivenJourney(app.tenantConfig.journey.stages)) {
        const refValues = (journey.refValues ?? {}) as Record<string, unknown>;
        const createdTime = extractCreatedTime(journey.raw);
        payload.stage_timeline = resolveDateDrivenStage(app.tenantConfig.journey.stages, refValues, createdTime).timeline;
      } else {
        const stageHistoryRows = await prisma.stageHistory.findMany({ where: { journeyId: journey.id } });
        const changedAtByStage = new Map(stageHistoryRows.map((r) => [r.toStage, r.changedAt]));
        payload.stage_timeline = buildStageTimeline(app.tenantConfig.journey.stages, summary.stage_index, changedAtByStage);
      }
    }
    // pre_journey / on_hold: no stage_timeline field — there's no live
    // journey-progress position to show a timeline against.

    return sendWithEtag(req, reply, payload, 'private, no-cache');
  });
}
