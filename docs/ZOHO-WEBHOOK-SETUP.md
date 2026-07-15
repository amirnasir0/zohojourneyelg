# Zoho CRM Webhook Setup

M5 adds two endpoints that Zoho CRM calls directly on record changes, for near-instant updates instead of
waiting up to 15 minutes for the next sync pass:

- `POST /webhooks/zoho/journey-updated` — fired when a Deal's stage changes
- `POST /webhooks/zoho/contact-updated` — fired when a Contact is created or edited

Both are configured in Zoho CRM as **Workflow Rules** with a **Webhook** instant action. This doc walks
through creating both rules, using Elgris's actual seed config (`seed/elgris.tenant-config.json`) as the
worked example. If you're setting this up for a different tenant, substitute that tenant's own
`zoho.journey_module` / field names / `webhooks.*` mapping throughout.

## Prerequisites

- `WEBHOOK_SECRET` is set in the deployment's environment (a long random value — `openssl rand -hex 24`).
  This is **not** the same secret as any other credential in `.env`; it exists purely to authenticate
  inbound webhook calls.
- You know the deployed API's base URL (e.g. `https://api.elgris.in`).
- You have CRM Administrator access in Zoho (Workflow Rules require admin permissions).

## Rule 1 — Journey Stage Updated

**Setup → Automation → Workflow Rules → Create Rule**

| Field | Value |
|---|---|
| Module | `Deals` (Elgris's `zoho.journey_module`) |
| Rule name | `Journey Stage Updated → Webhook` |
| When | **Record Action** → **Edit** |
| Trigger only when specified fields are modified | ✅ checked — select **Stage** (Elgris's `zoho.journey_stage_field`) |
| Condition | None needed — leave it firing on every Stage edit |

### Instant Action → Webhook

Add a **Webhook** instant action to the rule (not Email/Task/Field Update).

| Field | Value |
|---|---|
| Name | `journey-updated` |
| URL | `https://api.elgris.in/webhooks/zoho/journey-updated?secret=<WEBHOOK_SECRET>` |
| Method | `POST` |
| **Body Type** | **`JSON`** — see warning below |
| Body | see mapping table below |

**⚠️ Body Type matters.** Zoho's Workflow Rule webhook editor can default to sending the body as
URL-encoded form parameters depending on how you add fields, especially if you paste in a URL with query
params first. This server only parses **JSON** bodies. After adding the URL, explicitly switch the body
type / content-type selector to **JSON** (usually a toggle or dropdown near the body editor) before adding
the key/value pairs below — otherwise every webhook call will fail with `400 INVALID_PAYLOAD` because the
parsed body won't contain the expected keys.

### Body — JSON key/value pairs

These key names come from `seed/elgris.tenant-config.json`'s `webhooks.journey_updated` section. If that
config changes, these keys must be updated to match (they're tenant-configurable on purpose — see
"Changing the field mapping" below).

| JSON key (our config) | Zoho merge field |
|---|---|
| `record_id` | `${Deals.Deal Id}` |
| `stage` | `${Deals.Stage}` |
| `contact_id` | `${Deals.Contact Name.id}` |
| `changed_at` | `${Deals.Modified Time}` |

Resulting body (Zoho substitutes the merge fields at send time):
```json
{
  "record_id": "${Deals.Deal Id}",
  "stage": "${Deals.Stage}",
  "contact_id": "${Deals.Contact Name.id}",
  "changed_at": "${Deals.Modified Time}"
}
```

## Rule 2 — Contact Updated

**Setup → Automation → Workflow Rules → Create Rule**

| Field | Value |
|---|---|
| Module | `Contacts` |
| Rule name | `Contact Updated → Webhook` |
| When | **Record Action** → **Create or Edit** (any field — phone numbers can change on any edit, not just a specific field) |
| Condition | None needed |

### Instant Action → Webhook

| Field | Value |
|---|---|
| Name | `contact-updated` |
| URL | `https://api.elgris.in/webhooks/zoho/contact-updated?secret=<WEBHOOK_SECRET>` |
| Method | `POST` |
| **Body Type** | **`JSON`** (same warning as above) |
| Body | `{ "record_id": "${Contacts.Contact Id}" }` |

Only the record ID is sent — the server fetches the full current Contact record from Zoho by that ID and
re-runs it through the same phone-normalization logic the sync worker uses. This is deliberate: the
contact's phone field names (`zoho.contact_phone_fields`) are dynamic tenant config, so requiring the
webhook body to carry raw field values would mean keeping two configs in sync by hand. Fetch-by-ID avoids
that entirely.

## Testing a rule

1. In the Workflow Rule list, most Zoho editions show a **Webhook Logs** or **Instant Actions → Logs**
   panel with recent delivery attempts, status codes, and response bodies — use this first to check what
   Zoho actually sent and what came back.
2. Manually edit a Deal's Stage (or a Contact) in the CRM to fire the rule, then check the server logs for
   `[webhooks]` lines.
3. Expected responses: `200 {"success":true}` on success. `401` means the secret is missing or wrong —
   re-check the URL's `?secret=` value or the body's `secret` field against the deployment's
   `WEBHOOK_SECRET`. `400 {"error":"INVALID_PAYLOAD"}` almost always means the body type is form-encoded
   instead of JSON, or a key name doesn't match `webhooks.*` in the tenant config. `503` means the
   deployment's `ZOHO_CLIENT_ID`/`ZOHO_CLIENT_SECRET`/`ZOHO_REFRESH_TOKEN` aren't configured — the webhook
   still works for records already synced locally, but can't fetch not-yet-synced ones.

## Changing the field mapping

If you rename a Zoho field, switch to a different journey module, or use different JSON key names in the
Workflow Rule body, update the matching tenant config section (no code changes needed):

```json
"webhooks": {
  "journey_updated": {
    "record_id_field": "record_id",
    "stage_field": "stage",
    "contact_id_field": "contact_id",
    "changed_at_field": "changed_at"
  },
  "contact_updated": {
    "record_id_field": "record_id"
  }
}
```

Whatever key names you put here must exactly match the JSON keys configured in the Zoho Workflow Rule's
webhook body — the server reads the payload using these names, not fixed ones.

## Secret rotation

`WEBHOOK_SECRET` is a single shared value, not per-rule. To rotate it: update the deployment's environment
variable, then update the `?secret=` query param (or body field) in **both** Workflow Rules' webhook
configs to match. There's a brief window where old and new rules could disagree if updated one at a time —
for near-zero downtime, temporarily accept either value by deploying with the new secret, updating both
Zoho rules, then removing the old value, rather than swapping all three atomically.
