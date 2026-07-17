# Zoho Webhook Setup (CRM + Desk)

## Deploy-day validation checklist

The handler code (payload parsing, stage resolution, `StageHistory` writes, dedupe, cache invalidation,
both fetch-by-ID fallback paths) is fully tested — but only against **simulated** deliveries (curl payloads
built by hand to match the expected shape). The Zoho-side half of the chain has not been exercised end to
end because there's been no CRM access to create the Workflow Rules. Everything below is a documented
*assumption*, not a confirmed behavior. Check off each one for real during the Railway deploy:

- [ ] **JSON body type** — confirm the Workflow Rule's webhook editor actually sends JSON, not
      URL-encoded form params (Zoho's editor can default to form-encoding depending on how fields were
      added — see the warning under Rule 1 below).
- [ ] **Merge-field substitution** — confirm `${Deals.Deal Id}`, `${Deals.Stage}`,
      `${Deals.Contact Name.id}`, `${Deals.Modified Time}` (and `${Contacts.Contact Id}`) actually resolve
      to the values/format expected — e.g. that `Contact Name.id` really is a plain string and not a
      nested object, and that `Modified Time` is a parseable timestamp.
- [ ] **Query-param secret** — confirm Zoho's webhook sender preserves a `?secret=...` query string on
      the configured URL rather than stripping or mangling it.
- [ ] **Trigger condition** — confirm "Edit action, only when Stage field is modified" actually fires
      once per real stage change (not on every unrelated field edit, not zero times, not duplicated).
- [ ] **Real delivery** — confirm an actual CRM edit reaches the deployed endpoint at all (network
      path, DNS, TLS, whatever's in front of the Railway deployment) and that the response Zoho receives
      matches what the handler actually sent.

See `TECH-DEBT.md` → "M5 Zoho-side webhook chain untested" for the standing note.

---

M5/M-journey-source add three endpoints that Zoho CRM calls directly on record changes, for near-instant
updates instead of waiting up to 15 minutes for the next sync pass, plus a fourth (M8) that Zoho **Desk**
calls on ticket changes:

- `POST /webhooks/zoho/journey-updated` — fired when a Deal's stage changes. **Inactive for Elgris** — the
  journey source of truth moved from `Deals` to `Sales_Orders` (see TECH-DEBT.md "Journey source switched
  from Deals to Sales_Orders"), so this rule shouldn't be created against the current config. Kept for any
  future tenant whose journey module actually is Deals-Stage-driven.
- `POST /webhooks/zoho/contact-updated` — fired when a Contact is created or edited
- `POST /webhooks/zoho/salesorder-updated` — fired on **any** Sales_Orders field edit; the handler diffs
  the configured date fields + Stage against what's stored locally and no-ops cleanly when nothing relevant
  changed. This is Elgris's active journey-update webhook.
- `POST /webhooks/zoho/ticket-updated` — fired on Desk ticket create/update events; same diff-before-write
  no-op pattern as `salesorder-updated`, but a different DELIVERY mechanism entirely — see Rule 4 below.

Rules 1-3 are configured in Zoho CRM as **Workflow Rules** with a **Webhook** instant action — WE define
the JSON body shape, and the tenant config's `webhooks.*` section maps our chosen key names to what the
handler reads. Rule 4 is different: this Desk org uses **event-subscription webhooks**
(Setup → Automation → **Webhooks**, not Workflows), where Zoho defines a fixed event envelope and there's no
body to configure at all — see Rule 4 for why `webhooks.ticket_updated` in tenant config is consulted
differently there. This doc walks through creating all four, using Elgris's actual seed config
(`seed/elgris.tenant-config.json`) as the worked example. If you're setting this up for a different tenant,
substitute that tenant's own `zoho.journey_module` / field names / `webhooks.*` / `desk.*` mapping
throughout Rules 1-3 — Rule 4's setup doesn't change per tenant beyond the URL and event selection.

## Prerequisites

- `WEBHOOK_SECRET` is set in the deployment's environment (a long random value — `openssl rand -hex 24`).
  This is **not** the same secret as any other credential in `.env`; it exists purely to authenticate
  inbound webhook calls.
- You know the deployed API's base URL — `https://elgris.webspecia.in` for Elgris, confirmed live (not a
  placeholder — an earlier draft of this doc used `api.elgris.in`, which was never actually the deployed
  domain; substitute your own tenant's real domain if you're setting this up elsewhere).
- You have CRM Administrator access in Zoho for Rules 1-3 (Workflow Rules require admin permissions), and
  Desk Administrator access for Rule 4 (Setup → Automation → Webhooks is a separate admin permission).

## Quick reference — Rule 4 confirmed working recipe

The distilled, verified steps for the Desk ticket webhook. Full rationale, the envelope shape, and the
handshake-tolerance design are in "Rule 4" further down — read this section first if you just need to
(re)create the subscription and confirm it's actually live.

**1. Confirm the route exists on the deployment *before* touching Zoho.** This was the actual failure the
first time through: the deployed server 404'd on `/webhooks/zoho/ticket-updated` (and every other
`/webhooks/zoho/*` route) because the running deploy predated commit `873c190` — a stale deploy, not a Zoho
config problem, and `/healthz` returning `200` does **not** rule this out (it only proves the server is up,
not which routes it has). Check the specific route first:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://elgris.webspecia.in/webhooks/zoho/ticket-updated
```

Expect `200`. If you get `404`, stop here and redeploy from current `main` (this route needs at least
commit `e90255e`, which adds the handshake-tolerance GET/HEAD handlers this check relies on) — re-run the
check after the deploy finishes before proceeding to step 2.

**2. Create the subscription** — Setup → Automation → **Webhooks** (a different left-nav item from
"Workflows" — see "Rule 4" below for why) → Add Webhook:

| Field | Value |
|---|---|
| Name | `ticket-updated` |
| URL | `https://elgris.webspecia.in/webhooks/zoho/ticket-updated?secret=<WEBHOOK_SECRET>` |
| Events | `Ticket_Add`, `Ticket_Update` |

Saving this fires Desk's URL-validation handshake. As of the handshake-tolerance fix (see "Rule 4" below),
this route always returns `200` regardless of what's sent — so **a successful save here does not yet prove
the secret is correct end-to-end**, only that the URL is reachable. Don't stop at "it saved without an
error."

**3. Confirm a real event actually processes**, not just the handshake:

```bash
curl -s https://elgris.webspecia.in/webhooks/zoho/ticket-updated \
  -X POST -H "Content-Type: application/json" \
  -d '[{"eventType":"Ticket_Update","payload":{"id":"<a real Desk ticket ID>"},"eventTime":"2026-07-17T00:00:00.000Z","orgId":"60022843030"}]' \
  "?secret=<WEBHOOK_SECRET>"
```

A genuinely processed delivery returns `{"success":true,"processed":1,"results":[{"event_type":"Ticket_Update","record_id":"...","changed":true|false}]}`.
A rejected-but-still-200'd request (wrong secret, malformed body) instead returns a top-level
`{"success":true,"note":"ignored: ..."}` with no `results` array — that's the tell, since the status code
is `200` either way. Then create or edit a real ticket in Desk and check the server logs for a
`[webhooks] ticket-updated:` line to confirm the live subscription itself is delivering, not just that the
endpoint works when called directly.

## Rule 1 — Journey Stage Updated (Deals) — inactive under the current Elgris config

**Do not create this rule for Elgris right now** — `zoho.journey_module` is `Sales_Orders`, not `Deals`, so
this rule's trigger (a Deals Stage edit) has no relationship to what the app displays as a journey. Left
here for reference and for any future tenant whose journey source genuinely is Deals-Stage-driven. Elgris's
active rule is **Rule 3**, below.

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
| URL | `https://elgris.webspecia.in/webhooks/zoho/journey-updated?secret=<WEBHOOK_SECRET>` |
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
| URL | `https://elgris.webspecia.in/webhooks/zoho/contact-updated?secret=<WEBHOOK_SECRET>` |
| Method | `POST` |
| **Body Type** | **`JSON`** (same warning as above) |
| Body | `{ "record_id": "${Contacts.Contact Id}" }` |

Only the record ID is sent — the server fetches the full current Contact record from Zoho by that ID and
re-runs it through the same phone-normalization logic the sync worker uses. This is deliberate: the
contact's phone field names (`zoho.contact_phone_fields`) are dynamic tenant config, so requiring the
webhook body to carry raw field values would mean keeping two configs in sync by hand. Fetch-by-ID avoids
that entirely.

## Rule 3 — Sales Order Updated (Elgris's active journey-update rule)

**Setup → Automation → Workflow Rules → Create Rule**

| Field | Value |
|---|---|
| Module | `Sales_Orders` (Elgris's `zoho.journey_module`) |
| Rule name | `Sales Order Updated → Webhook` |
| When | **Record Action** → **Edit** |
| Trigger only when specified fields are modified | ❌ leave unchecked — fire on **any** field edit |
| Condition | None needed |

Unlike Rule 1's old design, this one deliberately does **not** try to trigger only on the 7 process-date
fields — Zoho Workflow Rules can't express "any of these 7 fields changed" as a single trigger condition,
and listing all 7 individually is fragile against future field additions. Instead, the rule fires on every
edit and the handler (`src/webhooks/salesorder-updated.ts`) fetches the full record and diffs it against
what's stored locally, no-opping cleanly (no DB write, no cache bust) when nothing relevant changed. Most
deliveries — billing address edits, carrier changes, etc. — will be no-ops, and that's expected, not a bug.

### Instant Action → Webhook

| Field | Value |
|---|---|
| Name | `salesorder-updated` |
| URL | `https://elgris.webspecia.in/webhooks/zoho/salesorder-updated?secret=<WEBHOOK_SECRET>` |
| Method | `POST` |
| **Body Type** | **`JSON`** (same warning as Rule 1/2) |
| Body | `{ "record_id": "${Sales_Orders.Sales Order Id}" }` |

Much simpler payload than the old Deals rule — just the record ID, same pattern as Rule 2's Contact Updated.
The handler fetches the current Stage + all configured date fields from Zoho directly, so the webhook body
never needs to carry field values (which are dynamic tenant config, `journey.stages[].date_field`) — nothing
to keep in sync by hand if a stage's date field is renamed or a new stage is added later.

## Rule 4 — Ticket Add/Update (Zoho Desk event-subscription webhook)

**This is a fundamentally different mechanism from Rules 1-3, not just a different admin screen.** Rules
1-3 are Workflow Rules with a Webhook instant action, where WE choose the JSON body and Zoho substitutes
merge fields into it at send time. This Desk org has no equivalent "Workflow → Webhook action" for tickets
in active use; instead it uses Desk's **event-subscription webhooks** — you subscribe a URL to specific
event types, and Zoho POSTs its own fixed event envelope, with no body to configure at all.

**Setup → Automation → Webhooks → Add Webhook** (this is a *different* left-nav item from "Workflows" —
don't look under Workflows for this one)

| Field | Value |
|---|---|
| Name | `ticket-updated` |
| URL | `https://elgris.webspecia.in/webhooks/zoho/ticket-updated?secret=<WEBHOOK_SECRET>` |
| Events | Check **Ticket_Add** and **Ticket_Update** (leave every other event type — Ticket_Delete,
  Contact_Add, etc. — unchecked; the handler ignores any event type it doesn't recognize, but there's no
  reason to have Desk send events nobody reads) |

There is no Body Type / JSON key mapping step here — unlike Rules 1-3, Desk defines the payload shape
itself and it isn't configurable. This also means `webhooks.ticket_updated.record_id_field` in tenant
config is **not consulted** for this webhook (see "Changing the field mapping" below) — it stays in the
schema only because Rules 1-3 still need their own mapping keys.

### What Zoho actually sends

Confirmed against Zoho's own docs (`desk.zoho.com/support/WebhookDocument.do#EventsSupported`), not
guessed: a delivery is a **JSON array of events** — Desk batches multiple events into one HTTP call — each
shaped:

```json
[
  {
    "eventType": "Ticket_Update",
    "payload": { "id": "119514000017429001", "subject": "...", "...": "..." },
    "prevState": { "...": "..." },
    "eventTime": "2026-07-17T13:54:20.000Z",
    "orgId": "60022843030"
  }
]
```

`payload` is Desk's serialization of the ticket at event time — the handler does **not** parse fields out
of it directly. It only reads `payload.id`, then calls `GET /tickets/{id}?include=assignee` (the same
fetch-by-ID + diff-before-write path sync and every other webhook in this app already use) and maps the
result through the same `mapDeskTicketToFields()` sync uses. This sidesteps needing to separately verify
that Desk's webhook-event ticket serialization matches its REST GET shape field-for-field — one source of
truth for "what does a ticket look like," regardless of which one triggered the fetch.

The handler accepts either a JSON array (the documented/expected shape) or a single bare event object (a
defensive fallback, in case a Desk config ever delivers one event un-batched). Anything else (a string, a
number, `null`) isn't a recognizable event — see "Handshake tolerance" below for what actually happens to
those. Each event in a batch is processed independently and reported in the response's `results` array; one
event failing to resolve (unknown contact, ticket not found) doesn't block the others in the same delivery.

### Handshake tolerance — this route never returns a non-200

Desk's webhook-URL validator sends a request the moment the URL is entered/saved in
**Setup → Automation → Webhooks** and requires an immediate `200` — if it gets anything else (a `401` for a
missing/wrong secret, a `400` for a body it doesn't recognize as a real event), Desk reports the URL itself
as invalid, which is misleading: the webhook is fine, it just correctly rejected a request that wasn't a
real ticket event.

So `POST /webhooks/zoho/ticket-updated` deliberately **never returns a non-200** for a secret mismatch or an
unrecognized payload — both cases are silent `200` no-ops (`{"success":true,"note":"ignored: ..."}`), not
errors. `GET` and `HEAD` on the same path also always return `200`, in case the handshake uses one of those
instead of `POST`. This doesn't weaken the actual security check: a request still has to pass both the
secret check AND look like a real Desk event *before anything gets written to the local mirror* — the
handshake tolerance only changes the HTTP status code returned for a rejected request, not whether it's
rejected. A genuine processing failure once both checks pass (`ZOHO_DESK_*` not configured) still returns a
real `503` — that's an operational problem worth surfacing, not a handshake probe.

Practical effect: you cannot tell from the HTTP status alone whether a POST to this endpoint actually did
anything. Check the server logs (`[webhooks] ticket-updated:` lines) or the response body's `note` /
`results` field if you need to confirm a specific delivery was processed rather than silently ignored.

### Two Desk-specific quirks worth knowing before debugging this webhook

- Desk's own web UI refers to tickets as **"Cases"** in its URLs (e.g. a ticket's `webUrl` looks like
  `.../ShowHomePage.do#Cases/dv/<id>`), even though every API path, field name, and the `module=tickets`
  param on the field-metadata endpoint all say **"tickets"**. This is a UI-only rename — don't go looking
  for a `/cases` endpoint if you see "Cases" somewhere in the Desk admin UI or a webUrl.
- The ticket-list endpoint (used by sync, not this webhook) does **not** support a `fields=` selector the
  way CRM's v8 API does — it 422s with `Extra query parameter 'fields' is present`. Related fields are
  embedded instead via `?include=contacts` (plural) or `?include=assignee` (singular) — each works only as
  a single value, not comma-combined (`?include=assignee,contacts` 422s too). This webhook's single-ticket
  fetch isn't affected (it always returns the full object), but it's the reason sync has to do a follow-up
  `getTicket()` per changed ticket instead of getting everything from one list call.

## Testing a rule

1. **Rules 1-3 (CRM Workflow Rules):** most Zoho editions show a **Webhook Logs** or **Instant Actions →
   Logs** panel on the rule with recent delivery attempts, status codes, and response bodies — check what
   Zoho actually sent and what came back. Manually edit a Deal's Stage (or a Contact, or a Sales Order) in
   the CRM to fire the rule, then check the server logs for `[webhooks]` lines.
2. **Rule 4 (Desk event-subscription webhook):** the Webhooks list under Setup → Automation shows delivery
   history per subscribed webhook, same idea. Manually create or edit a test ticket in Desk to fire it.
3. Expected responses differ by rule:
   - **Rules 1-3:** `200 {"success":true}` on success. `401` means the secret is missing or wrong — re-check
     the URL's `?secret=` value or the body's `secret` field against the deployment's `WEBHOOK_SECRET`.
     `400 {"error":"INVALID_PAYLOAD"}` almost always means the body type is form-encoded instead of JSON, or
     a key name doesn't match `webhooks.*` in the tenant config. `503` means
     `ZOHO_CLIENT_ID`/`ZOHO_CLIENT_SECRET`/`ZOHO_REFRESH_TOKEN` aren't configured.
   - **Rule 4:** always `200`, even for a bad secret or a malformed body — see "Handshake tolerance" above.
     A real, successfully-processed delivery looks like `200 {"success":true,"processed":N,"results":[...]}`
     with each result showing `changed:true`/`changed:false`/a `note` explaining why it was skipped. A
     rejected-but-still-200'd request shows `{"success":true,"note":"ignored: ..."}` at the top level
     instead — check the `note` (or the server's `[webhooks] ticket-updated:` log lines) to tell the two
     apart, since the status code can't. `503` still means genuine trouble:
     `ZOHO_DESK_CLIENT_ID`/`ZOHO_DESK_CLIENT_SECRET`/`ZOHO_DESK_REFRESH_TOKEN` aren't configured — this is
     the one failure mode Rule 4 still reports honestly, since it only happens after the secret and payload
     have both already checked out.

## Changing the field mapping

This applies to **Rules 1-3 only**. If you rename a Zoho field, switch to a different journey module, or
use different JSON key names in the Workflow Rule body, update the matching tenant config section (no code
changes needed):

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
  },
  "salesorder_updated": {
    "record_id_field": "record_id"
  },
  "ticket_updated": {
    "record_id_field": "record_id"
  }
}
```

Whatever key names you put here must exactly match the JSON keys configured in the Zoho Workflow Rule's
webhook body — the server reads the payload using these names, not fixed ones. **`ticket_updated` is the
one exception** — Rule 4's Desk event-subscription payload isn't tenant-configurable (Zoho fixes the
envelope shape), so `record_id_field` there is vestigial: it stays in the schema for consistency with the
other three, but `src/webhooks/ticket-updated.ts` always reads the ticket ID from the fixed `payload.id`
path regardless of what this key says.

## Secret rotation

`WEBHOOK_SECRET` is a single shared value, not per-rule. To rotate it: update the deployment's environment
variable, then update the `?secret=` query param in **all active** Workflow Rules' AND Rule 4's Desk
webhook subscription to match — Rule 4 only checks the query param (no body `secret` fallback, since Desk
owns the body shape), so don't forget it specifically. There's a brief window where old and new rules could
disagree if updated one at a time — for near-zero downtime, temporarily accept either value by deploying
with the new secret, updating all Zoho rules, then removing the old value, rather than swapping them all
atomically.
