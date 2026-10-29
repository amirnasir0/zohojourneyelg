import type { FastifyInstance } from 'fastify';
import { extractCreatedTime, resolveDateDrivenStage } from '../sync/date-stage-resolve.js';
import { buildJourneySummary, isJourneyStage } from '../lib/journey-view.js';
import { prisma } from '../lib/prisma.js';
import { requireStaffAuth, seesAllCustomers } from '../lib/staff-auth-middleware.js';

function parseDateParam(raw: unknown): Date | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export async function registerStaffReportsRoutes(app: FastifyInstance) {
  app.get('/staff/reports', { preHandler: requireStaffAuth }, async (req, reply) => {
    const { stage_index: rawStageIndex, date_from: rawDateFrom, date_to: rawDateTo } = req.query as {
      stage_index?: unknown;
      date_from?: unknown;
      date_to?: unknown;
    };

    const stageIndex = Number(rawStageIndex);
    const validStageIndexes = new Set(app.tenantConfig.journey.stages.filter(isJourneyStage).map((s) => s.index));
    if (!Number.isInteger(stageIndex) || !validStageIndexes.has(stageIndex)) {
      return reply.code(400).send({ error: 'INVALID_REQUEST' });
    }

    const dateFrom = parseDateParam(rawDateFrom);
    const dateTo = parseDateParam(rawDateTo);
    if ((rawDateFrom !== undefined && !dateFrom) || (rawDateTo !== undefined && !dateTo)) {
      return reply.code(400).send({ error: 'INVALID_REQUEST' });
    }

    if (!seesAllCustomers(req.staffRole) && !req.staffZohoOwnerId) {
      // Same "scoped to nobody yet" pattern as GET /staff/customers.
      return reply.code(200).send([]);
    }

    const journeys = await prisma.journey.findMany({
      where: !seesAllCustomers(req.staffRole) ? { ownerZohoId: req.staffZohoOwnerId } : {},
      include: { contact: true },
    });

    const results = journeys.flatMap((journey) => {
      const summary = buildJourneySummary(journey, app.tenantConfig);
      if (!summary || summary.stage_index !== stageIndex) return [];

      const refValues = (journey.refValues ?? {}) as Record<string, unknown>;
      const createdTime = extractCreatedTime(journey.raw);
      const { timeline } = resolveDateDrivenStage(app.tenantConfig.journey.stages, refValues, createdTime);
      const stageDate = timeline.find((t) => t.index === stageIndex)?.changed_at ?? journey.syncedAt;

      if (dateFrom && stageDate < dateFrom) return [];
      if (dateTo && stageDate > dateTo) return [];

      return [
        {
          contact_id: journey.contact.id,
          full_name: journey.contact.fullName,
          mobile_e164: journey.contact.mobileE164,
          email: journey.contact.email,
          pending_customer_review: journey.contact.pendingCustomerReview,
          journey_id: journey.id,
          journey_name: journey.name,
          stage_index: stageIndex,
          stage_date: stageDate,
        },
      ];
    });

    results.sort((a, b) => (b.stage_date?.getTime() ?? 0) - (a.stage_date?.getTime() ?? 0));

    return reply.code(200).send(results);
  });
}
