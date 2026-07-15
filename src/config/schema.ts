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

const stageSchema = z.object({
  index: z.number().int().positive(),
  crm_value: z.string().min(1),
  display: z.string().min(1),
  owner: z.string().min(1),
  next_copy: z.string().min(1),
});

const journeySchema = z.object({
  label_singular: z.string().min(1),
  label_plural: z.string().min(1),
  stages: z.array(stageSchema).min(1),
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

export const tenantConfigSchema = z.object({
  tenant: tenantSchema,
  zoho: zohoSchema,
  journey: journeySchema,
  reference_fields: z.array(referenceFieldSchema),
  notifications: notificationsSchema,
});
