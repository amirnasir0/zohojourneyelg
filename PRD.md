# PRD — Customer Journey App Backend ("JourneyOS")
**Product:** White-label customer journey tracking backend for Zoho CRM businesses
**Tenant #1:** Elgris Solar (funds initial build)
**Vendor/Owner:** Cognidom Technologies Private Limited (Webspecia)
**Version:** 2.1 | **Date:** 16 July 2026
**Frontend:** React Native (iOS & Android), config-driven branding
**Source of truth per tenant:** Zoho CRM (Contacts + journey module)

---

## 1. Objective

A **productized, tenant-configurable** Node.js backend that gives any Zoho CRM business a branded customer app: customer logs in with mobile number (WhatsApp OTP), instantly sees their project/application/case journey and its live stage. One codebase, deployed per client with zero code changes — only a tenant config pack.

Elgris Solar is tenant #1 and defines the reference implementation (24-stage solar installation journey). The same deployment serves future tenants: Incksign (DSC application journey), Hearwave/Insono (patient journey), and external Zoho CRM businesses.

**Hard rules:**
- Zoho is never called on the user's request path — backend is a fast read layer (<100ms p95)
- No client name, stage name, field name, or copy string is hardcoded — everything client-specific lives in tenant config
- The word "Elgris" appears only in seed data and `.env`

## 2. Non-Goals (v1)

- No multi-tenant shared database (one isolated deployment per client — see §4)
- No customer self-registration (customers exist in CRM, created by the business)
- No app→CRM write-back (except audit logs and Zoho Desk ticket creation, §11.4)
- No document upload (Phase 2)
- No ticket threads, replies, or attachments — Desk ticketing (§11.4) is create + track only; conversation-level features are a later phase
- No admin/manager roles in-app (customer role only)

## 3. System Architecture

```
React Native App (config-driven branding)
        │  HTTPS + JWT
        ▼
Node.js API (Fastify) — api.<tenant-domain>.com
        │
        ├── Tenant Config Layer  → branding, journey JSON, field map, templates
        ├── Redis                → OTP store, rate limits, hot cache
        ├── PostgreSQL           → mirrored contacts, journeys, stage history, sessions
        │
        ├── Interakt API         → WhatsApp OTP + stage notifications
        ├── MSG91 (fallback)     → SMS OTP
        │
        ├── Sync Worker          → Zoho CRM pull every 15 min (reconcile)
        └── Webhook endpoint     ← Zoho Workflow Rules (instant stage updates)
                │
                └── FCM / APNs   → push on stage change
```

## 4. Deployment Model: Single Codebase, Isolated Instances

- One repo: `journey-app-backend`
- Each client = separate deployment (Railway/Render project), separate Postgres + Redis, own subdomain
- Tenant config injected at deploy via seed file: `deploy.sh <tenant-config.json>`
- Rationale: full data isolation (clean DPDP story), no shared Zoho API credit blast radius, per-deployment pricing model
- Multi-tenant consolidation deferred until 10+ active clients

**Commercials (product):** ₹1.5–2L setup per deployment + ₹8–15K/month hosting & maintenance AMC.

## 5. Tenant Config Pack (the product core)

A single JSON (seeded into `tenant_config` table + secrets in env) defines an entire client:

```json
{
  "tenant": {
    "slug": "elgris",
    "display_name": "Elgris Solar",
    "logo_url": "https://cdn…/elgris-logo.png",
    "brand_colors": { "primary": "#F5A623", "secondary": "#1B2A4A" },
    "support_whatsapp": "+91XXXXXXXXXX",
    "support_email": "support@elgris.in"
  },
  "zoho": {
    "dc": "in",
    "org_id": "…",
    "journey_module": "Deals",
    "contact_phone_fields": ["Phone", "Mobile"]
  },
  "journey": {
    "label_singular": "Project",
    "label_plural": "Projects",
    "stages": [
      { "index": 1,  "crm_value": "Site Survey", "display": "Site Survey",
        "owner": "elgris", "next_copy": "Our engineer will visit your site within 3 working days. Please keep your latest electricity bill ready." },
      { "index": 14, "crm_value": "Net Meter Installation", "display": "Net Meter Installation",
        "owner": "discom", "next_copy": "DISCOM will install your net meter. This typically takes 10–15 days and is handled by the electricity board." }
      // … all 24 stages
    ]
  },
  "reference_fields": [
    { "crm_field": "National_Portal_No", "display": "National Portal Application No." },
    { "crm_field": "Subsidy_Token", "display": "Subsidy Token" },
    { "crm_field": "Consumer_No", "display": "Consumer Number" },
    { "crm_field": "DISCOM_No", "display": "DISCOM Number" }
  ],
  "notifications": {
    "otp_channel": ["whatsapp", "sms_fallback"],
    "interakt_otp_template": "otp_auth_v1",
    "stage_change_push": "🎉 Update on your {journey_label}: now at {stage}. Tap to see details.",
    "stage_change_whatsapp_template": null
  }
}
```

**Key insight: the journey is data, not code.** Incksign's DSC journey or Hearwave's patient journey = a different JSON, same binary. Stage logic must never contain hardcoded comparisons like `if stage === "Net Meter Installation"`.

### `GET /config` (public, cached)
App calls this at launch → receives branding, journey labels, stage list with copy, support contacts. This is what makes the RN app reusable: rendering is driven entirely by the API. Per-client RN work = theme file + icons + store listing.

## 6. Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Node.js 20 LTS | — |
| Framework | Fastify | throughput + built-in schema validation |
| DB | PostgreSQL 16 + Prisma | relational mirror, migrations |
| Cache/OTP | Redis (managed) | TTL-native OTP, rate limits |
| Auth | JWT RS256, 90-day expiry | infrequent app opens |
| Hosting | Railway / Render, Mumbai/Singapore region | low latency to India |
| Push | FCM (covers APNs) | one SDK, both platforms |
| WhatsApp | Interakt Template API | reuse existing Desk-OTP module |
| Monitoring | Pino + Sentry | per-deployment observability |

## 7. Data Model (PostgreSQL, per deployment)

### tenant_config
Single-row table holding the config JSON (§5) + version + updated_at. Secrets (Zoho refresh token, Interakt key) stay in env, not DB.

### contacts
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| zoho_contact_id | text unique | |
| mobile_e164 | text unique, indexed | normalized `+91XXXXXXXXXX` — login key |
| full_name / email | text | |
| desk_contact_id | text unique, nullable | Zoho Desk contact, lazily resolved on first ticket action (§11.4) |
| raw | jsonb | full CRM payload |
| synced_at | timestamptz | |

### tickets  *(Zoho Desk, create + track only — see §11.4)*
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| desk_ticket_id | text unique | |
| contact_id | uuid FK | |
| ticket_number | text | Desk's human-facing ticket number |
| subject | text | = category value at creation time |
| description | text, nullable | |
| category | text | raw Desk value |
| status | text | raw Desk value |
| status_display | text | resolved via tenant's `desk.status_display_map`, unmapped values pass through as-is |
| owner_name / co_owner_name | text, nullable | |
| priority | text, nullable | |
| created_at / updated_at | timestamptz | Zoho Desk's own ticket timestamps |
| raw | jsonb | full Desk payload |
| synced_at | timestamptz | our own last-sync bookkeeping, distinct from created_at/updated_at above |

### journeys  *(generic — "deals" for Elgris, "applications" for Incksign)*
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| zoho_record_id | text unique | |
| contact_id | uuid FK | |
| name | text | |
| stage | text | current CRM stage value |
| stage_index | int | resolved via journey JSON |
| ref_values | jsonb | values for tenant's reference_fields |
| raw | jsonb | |
| synced_at | timestamptz | |

### stage_history
deal/journey FK, from_stage, to_stage, changed_at, source (webhook/sync). Powers the timeline UI and future ETA analytics.

### otp_attempts, sessions, device_tokens
As before: OTP audit, JWT revocation (`jti`), FCM tokens.

## 8. Phone Normalization (critical spec)

One function, applied to CRM ingest AND login input, per tenant's `contact_phone_fields`:
1. Strip spaces/dashes/parentheses
2. Remove leading `0`; remove leading `91`/`+91`
3. Must be 10 digits starting 6–9, else reject
4. Store/compare as `+91` + 10 digits

Login = single indexed equality query. Never live-search Zoho with variants.
*(v1 assumes India. Country-code strategy becomes a tenant config field when a non-Indian tenant appears.)*

## 9. Authentication Flow

### 9.1 `POST /auth/send-otp` — `{ "mobile": "9876543210" }`
1. Normalize → E.164
2. Rate limits (Redis): max 3 OTP/mobile/15 min, 10/IP/hour → `429`
3. Crypto-random 6-digit OTP → `otp:{mobile}` hashed, TTL 5 min
4. Send via tenant's Interakt OTP template; on failure → MSG91 SMS fallback
5. `200 { success, channel }` — never reveals whether number exists in CRM

### 9.2 `POST /auth/verify-otp` — `{ mobile, otp }`
1. Missing/expired key → `410 OTP_EXPIRED`
2. Wrong OTP → attempts++; 3 wrong → delete key, `423 LOCKED`
3. Correct → lookup `contacts.mobile_e164`
   - Found → JWT `{ sub, jti }` + session row → `200 { token, contact }`
   - Not found → `200 { token: null, status: "NO_ACCOUNT" }` (app shows tenant's support contact; no JWT issued)

### 9.3 JWT rules
RS256, 90-day expiry, `jti` validated against sessions (server-side revoke). `POST /auth/logout` revokes.

## 10. Customer APIs (JWT, served from local DB, <100ms p95)

| Method | Path | Purpose |
|---|---|---|
| GET | /config | Branding + journey definition (public, cached, ETag) |
| GET | /me | Contact profile |
| GET | /me/journeys | List with stage, stage_index, progress %, ref values — one call renders home screen |
| GET | /me/journeys/:id | Full detail + stage_timeline (completed/current/pending, timestamps, per-stage `next_copy`) |
| GET | /me/tickets/categories | Zoho Desk Category picklist values (cached, refreshed on sync) |
| POST | /me/tickets | Create a support ticket — `{ category, description? }`; see duplicate-guard below |
| GET | /me/tickets | List, newest first |
| GET | /me/tickets/:id | Detail |
| POST | /me/device-token | Register FCM token |
| POST | /auth/send-otp, /auth/verify-otp, /auth/logout | Auth |
| POST | /webhooks/zoho/journey-updated, /webhooks/zoho/contact-updated, /webhooks/zoho/ticket-updated | Zoho → backend (secret-validated) |
| GET | /healthz, /healthz/sync | Probes |

**Payloads are screen-shaped, not entity-shaped** — home screen renders in one round trip. ETag/If-None-Match on all `/me/*` GETs so repeat opens cost ~0 bytes.

**Authorization:** every journey/ticket query scoped `WHERE contact_id = jwt.sub`; foreign IDs return `404`.

**Ticket duplicate guard:** `POST /me/tickets` checks the local mirror for an existing ticket in the same category whose status isn't in the tenant's `desk.closed_statuses` list. If found, returns `409 { existing_ticket }` instead of creating a second one — the app decides whether to show the existing ticket or let the customer force a new one (`force: true` in the body bypasses the guard).

## 11. Zoho CRM Sync

### 11.1 Background worker
- Every 15 min: pull Contacts + journey module records modified since last sync (Zoho CRM v8, `Modified_Time` criteria, 200/page batches)
- Upsert; normalize phones; resolve `stage_index` via journey JSON — **unknown stage values are logged + surfaced as-is, never crash**
- Nightly full reconcile (catches deletes/merges; removes orphans → DPDP deletion compliance)
- OAuth refresh centralized with mutex; module + phone fields read from tenant config

### 11.2 Instant updates — Zoho Workflow → Webhook
- Workflow Rule on stage change → `POST /webhooks/zoho/journey-updated` with shared secret param (validated; reject otherwise)
- Handler: update journey row, insert stage_history, bust Redis cache, fire push
- Idempotent (dedupe on record_id + to_stage + minute bucket)
- Second rule for Contact create/phone change

### 11.3 Push on stage change
Template from tenant config with `{stage}` / `{journey_label}` interpolation. Optional WhatsApp mirror via Interakt utility template (per-tenant toggle, per-message cost — client decision).

### 11.4 Zoho Desk Ticketing (create + track)

Scope is deliberately narrow: a customer can open a support ticket and see its status. No threads, replies, or attachments — that's a later phase (§18).

- **Separate OAuth credential** from the CRM one (`ZOHO_DESK_REFRESH_TOKEN`), same accounts.zoho.\<dc\> token endpoint and mutex/refresh/retry pattern as CRM, but its own scope (`Desk.tickets.ALL,Desk.contacts.ALL,Desk.basic.READ,Desk.settings.READ`) and its own per-DC API base (`desk.zoho.in` etc.) — Desk's API requires an `orgId` header on every request, unlike CRM v8.
- **Department resolution:** tenant config names a department (`desk.department_name`); resolved to its Desk-side ID once at boot/config-validation via the departments API and cached in-process — never re-resolved per request.
- **Category field:** tenant config names the ticket field (`desk.category_field`, e.g. `"Category"`); its picklist values are fetched via Desk's field-metadata API and cached, refreshed on each sync pass. Ticket subject = the chosen category value; there's no separate free-text subject field in v1.
- **Status display:** `desk.status_display_map` translates Desk's internal status values to customer-facing labels; an unmapped status passes through as-is rather than erroring (same "never crash on an unrecognized value" principle as journey stages, §11.1). `desk.closed_statuses` lists which raw values count as "closed" for the duplicate-ticket guard (§10).
- **Contact bridge:** `contacts.desk_contact_id` is resolved lazily, on a customer's first ticket action — search Desk contacts by CRM reference first, then normalized phone/email; if none found, create a Desk contact from our contact data and cache the resulting ID. Zoho is never called on a customer's read path (§1's hard rule); ticket creation is the one write-path exception, same footing as the existing CRM webhook-driven writes.
- **Sync:** tickets fold into the same 15-min incremental + nightly full-reconcile worker as contacts/journeys, scoped to tickets belonging to already-known local contacts.
- **Instant updates:** a Desk Workflow (Desk's own automation UI, separate from CRM's Workflow Rules) posts to `POST /webhooks/zoho/ticket-updated` on ticket field changes, same secret-validated / fetch-by-ID / diff-before-write pattern as the CRM webhooks.

## 12. Performance Targets

| Metric | Target |
|---|---|
| p95, /me/journeys | < 100 ms |
| OTP delivery | < 10 s |
| Stage change → visible in app | < 30 s (webhook) |
| Sync fallback freshness | ≤ 15 min |
| API instance | always-on (no serverless cold starts) |

## 13. Security & Compliance

- HTTPS only (iOS ATS-compliant); strict CORS; Helmet
- OTP hashed in Redis, never logged plaintext
- Rate limits on auth routes (per-mobile + per-IP)
- Webhook shared-secret validation
- JWT revocation via sessions
- DPDP Act 2023: in-region hosting (Mumbai), minimal PII mirroring (only app-needed fields), nightly orphan cleanup honors CRM deletions
- Per-client isolated DB = clean data-isolation answer in sales conversations
- Secrets in env/secret manager only

## 14. Error Handling & Edge Cases

| Case | Behavior |
|---|---|
| Verified number, no CRM contact | `NO_ACCOUNT` + tenant support contact |
| Contact with zero journeys | Empty state with tenant-configurable copy |
| Interakt down | MSG91 fallback + ops alert |
| Zoho API credits exhausted | Sync pauses + alert; app unaffected (serves from DB) |
| Duplicate contacts, same phone | Most-recently-modified wins; conflict logged for manual merge |
| Stage renamed in CRM | Unknown value logged, displayed as-is; fix = config update, not deploy |
| Tenant config invalid | Deploy-time schema validation (Zod) — bad config fails the deploy, never runtime |

## 15. Ops & DevOps

- Envs: local Docker (PG+Redis) → staging (test records) → prod per tenant
- CI: lint + tests + Prisma migrate (GitHub Actions)
- `deploy.sh <tenant-config.json>` — validates config, provisions, seeds, deploys. Target: **new tenant live in ≤2 days** (the sales claim)
- `/healthz/sync` alerts if last sync > 30 min
- Internal ops mini-dashboard (Phase 1.5): sync health, webhook failures, OTP delivery rate, DAU per deployment

## 16. Milestones (Elgris = tenant #1)

| # | Deliverable | Duration |
|---|---|---|
| M1 | Scaffold, DB schema, **tenant config layer + Zod validation**, phone normalization, deploy pipeline | 3 days |
| M2 | OTP auth (Interakt + MSG91 fallback) + JWT sessions | 2 days |
| M3 | Zoho sync worker (config-driven module + fields) + nightly reconcile | 2–3 days |
| M4 | Customer read APIs incl. `/config`, ETag caching, auth scoping | 2 days |
| M5 | Zoho webhooks + stage history | 1–2 days |
| M6 | Push notifications (FCM/APNs) | 1–2 days |
| M7 | Hardening: rate limits, monitoring, load test, UAT with RN app, `deploy.sh` dry-run as tenant #2 simulation | 2 days |
| | **Total** | **~13–16 working days** |

*(vs ~11–15 days for a hardcoded build — the product layer costs ~1–2 extra days once.)*

## 17. Tenant #1 Prerequisites (Elgris)

- Zoho CRM server-based OAuth client; scopes: contacts.READ, deals.READ, settings.READ
- Approved Interakt authentication-category OTP template
- Final ordered list of 24 stages with per-stage `owner` + `next_copy` text (workshop with Elgris)
- Reference field API names confirmed (National Portal No., Subsidy Token, Consumer No., DISCOM No.)
- Subdomain DNS (`api.…`), Firebase project, Apple Developer + Play Console accounts (under Elgris)
- Zoho Workflow Rules (URLs supplied by Webspecia after M5)

## 18. Product Roadmap (post-Elgris)

| Phase | Item |
|---|---|
| 1.5 | Ops dashboard; sales one-pager + demo video (Vently Air case-study format) |
| 2 | Tenant #2: Incksign (DSC journey — Lead module blueprint already exists) or Hearwave (patient journey) |
| 2 | Stage ETA intelligence (median days/stage from stage_history), documents vault (read-only CRM attachments), WhatsApp deep-link support button |
| 2+ | Desk ticket threads, replies, and attachments (create + track shipped in current scope, §11.4) |
| 3 | Document upload, post-completion "My System"-style retention tab |
| Later | Multi-tenant consolidation at 10+ clients; Zoho Marketplace / partner white-label channel |
