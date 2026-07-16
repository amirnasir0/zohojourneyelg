import { z } from 'zod';

const brandColorsSchema = z.object({
  primary: z.string().min(1),
  secondary: z.string().min(1),
});

const tenantSchema = z.object({
  slug: z.string().min(1),
  display_name: z.string().min(1),
  logo_url: z.string().url(),
  brand_colors: brandColorsSchema,
  support_whatsapp: z.string().min(1),
  support_email: z.string().email(),
});

const zohoSchema = z.object({
  dc: z.string().min(1),
  org_id: z.string().min(1),
  journey_module: z.string().min(1),
  contact_phone_fields: z.array(z.string().min(1)).min(1),
  journey_stage_field: z.string().min(1),
  journey_name_field: z.string().min(1),
  journey_contact_lookup_field: z.string().min(1),
});

// Elgris's Deals pipeline mixes sales stages, installation-journey stages, and
// terminal states. Only "journey" stages render in the customer timeline and
// count toward total_stages; the others (pre_journey/on_hold/hidden) are
// display-shaped differently by the API (see src/lib/journey-view.ts).
const nonJourneyStageFields = {
  crm_value: z.string().min(1),
  index: z.number().int().positive().optional(),
  display: z.string().min(1).optional(),
  owner: z.string().min(1).optional(),
  next_copy: z.string().min(1).optional(),
  // Flags a type assignment as a guess pending tenant confirmation — not read
  // by app code, just a marker for humans editing the config.
  _review: z.boolean().optional(),
};

const journeyStageSchema = z.object({
  type: z.literal('journey'),
  crm_value: z.string().min(1),
  index: z.number().int().positive(),
  display: z.string().min(1),
  owner: z.string().min(1),
  next_copy: z.string().min(1),
  _review: z.boolean().optional(),
  // When set, this stage's timeline position/completion is derived from a
  // CRM date field's presence/value instead of matching crm_value against
  // the raw stage picklist. If ANY journey-type stage in a tenant's config
  // sets this, the whole journey resolves in date-driven mode — see
  // src/sync/date-stage-resolve.ts. Exists because some CRM modules (Elgris's
  // Sales_Orders) barely populate their Stage picklist in practice but do
  // reliably fill in per-milestone date fields.
  date_field: z.string().min(1).optional(),
});

const preJourneyStageSchema = z.object({ type: z.literal('pre_journey'), ...nonJourneyStageFields });
const onHoldStageSchema = z.object({ type: z.literal('on_hold'), ...nonJourneyStageFields });
const hiddenStageSchema = z.object({ type: z.literal('hidden'), ...nonJourneyStageFields });

const stageSchema = z.discriminatedUnion('type', [journeyStageSchema, preJourneyStageSchema, onHoldStageSchema, hiddenStageSchema]);

const journeySchema = z.object({
  label_singular: z.string().min(1),
  label_plural: z.string().min(1),
  stages: z.array(stageSchema).min(1),
  // Shown by the app when a verified customer has zero journeys — PRD §14
  // "Contact with zero journeys → Empty state with tenant-configurable copy".
  // Combined client-side with /config's tenant.support_whatsapp/support_email.
  empty_state_copy: z.string().min(1),
});

const referenceFieldSchema = z.object({
  crm_field: z.string().min(1),
  display: z.string().min(1),
});

const notificationsSchema = z.object({
  otp_channel: z.array(z.string().min(1)).min(1),
  interakt_otp_template: z.string().min(1),
  stage_change_push: z.string().min(1),
  stage_change_whatsapp_template: z.string().nullable(),
});

// Zoho Workflow webhook JSON bodies are configured by whoever sets up the
// Workflow Rule on the Zoho side (see docs/ZOHO-WEBHOOK-SETUP.md) — the exact
// key names are their choice, not ours, so they're tenant config rather than
// hardcoded in the handler (per CLAUDE.md: no hardcoded tenant values).
const journeyUpdatedWebhookSchema = z.object({
  record_id_field: z.string().min(1),
  stage_field: z.string().min(1),
  contact_id_field: z.string().min(1),
  changed_at_field: z.string().min(1),
});

// Deliberately minimal — just enough for the handler to fetch the full
// record by ID and reuse the same write path as sync, rather than requiring
// the Workflow Rule to carry every field name in its body (fragile: those
// field names are themselves dynamic tenant config). Shared by any
// "notify me this record changed, I'll fetch the rest" webhook mapping.
const recordIdOnlyWebhookSchema = z.object({
  record_id_field: z.string().min(1),
});

const webhooksSchema = z.object({
  journey_updated: journeyUpdatedWebhookSchema,
  contact_updated: recordIdOnlyWebhookSchema,
  // Fires on ANY Sales_Orders field edit (Zoho Workflow Rules can't filter to
  // "one of these 8 date fields changed") — the handler diffs the configured
  // date_field values + Stage against what's stored locally and no-ops
  // cleanly when nothing relevant changed. See src/webhooks/salesorder-updated.ts.
  salesorder_updated: recordIdOnlyWebhookSchema,
});

export const tenantConfigSchema = z.object({
  tenant: tenantSchema,
  zoho: zohoSchema,
  journey: journeySchema,
  reference_fields: z.array(referenceFieldSchema),
  notifications: notificationsSchema,
  webhooks: webhooksSchema,
});
