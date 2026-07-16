import type { FastifyInstance } from 'fastify';
import { sendWithEtag } from '../lib/http-cache.js';
import { isJourneyStage } from '../lib/journey-view.js';

export async function registerConfigRoutes(app: FastifyInstance) {
  app.get('/config', async (req, reply) => {
    const { tenant, journey } = app.tenantConfig;

    const payload = {
      tenant: {
        display_name: tenant.display_name,
        logo_url: tenant.logo_url,
        brand_colors: tenant.brand_colors,
        support_whatsapp: tenant.support_whatsapp,
        support_email: tenant.support_email,
      },
      journey: {
        label_singular: journey.label_singular,
        label_plural: journey.label_plural,
        empty_state_copy: journey.empty_state_copy,
        stages: journey.stages
          .filter(isJourneyStage)
          .map((s) => ({ index: s.index, display: s.display, owner: s.owner, next_copy: s.next_copy })),
      },
    };

    return sendWithEtag(req, reply, payload, 'public, max-age=300');
  });
}
