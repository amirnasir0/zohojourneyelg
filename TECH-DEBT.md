# Tech Debt

## DUPLICATE_MOBILE resolution (deferred from M3)

PRD §14 edge case: "Duplicate contacts, same phone → Most-recently-modified wins; conflict logged for manual merge."

M3's sync worker currently does the non-crashing half only: if a contact upsert would violate the
`mobile_e164` unique constraint against a *different* existing contact, it catches the conflict, writes
a `SyncIssue(reason: "DUPLICATE_MOBILE")`, and skips that contact for the run (retried on the next
incremental pass, so it self-heals if the CRM data is fixed upstream).

Not implemented: automatically comparing `Modified_Time` between the conflicting contacts and
reassigning/nulling the losing contact's `mobile_e164` so the winner can take over the login key. This
needs deliberate design (what happens to the loser's existing sessions/journeys, whether reassignment is
safe without human review) rather than being folded into the M3 upsert path.

Decision: pick this up in M7 (hardening) or earlier if `sync_issues` shows `DUPLICATE_MOBILE` occurring in
practice for Elgris data.

## reference_fields cleared — pending correct API names

PRD §5's sample tenant config listed `National_Portal_No`, `Subsidy_Token`, `Consumer_No`, `DISCOM_No` as
Elgris's `reference_fields`, but none of those exist on the real Elgris Deals module (confirmed live via
`GET /crm/v8/settings/fields?module=Deals` during M3 verification — 40 real fields, no match for any of the
four concepts). `seed/elgris.tenant-config.json`'s `reference_fields` was set to `[]` so sync runs clean in
the meantime.

Decision pending: which real Deals fields (if any) actually hold these values — being resolved by matching
against the full field list; once confirmed, restore `reference_fields` with the correct
`crm_field`/`display` pairs. Until then, `/me/journeys` (M4) will show no reference fields for Elgris,
which is accurate to current CRM state, not a bug.

## M4 read-path latency: ~1s per request, target is <100ms

Live-tested `/me` (2 logical queries: session lookup in `requireAuth` + contact lookup) at a steady
**~1.05-1.1s**, cold and warm, 5 consecutive requests, no Redis involved. 10-15x over the PRD §12 target.

**Diagnosed, not guessed** — two checks, both against the real dev DB:

1. Prisma query event logging (`log: [{emit:'event', level:'query'}]`) on a single `contact.findUnique`
   shows it is not one round trip, it's **four**: `BEGIN` (~105ms) → `DEALLOCATE ALL` (~105ms) → the actual
   `SELECT` (~215ms) → `COMMIT` (~115ms). Every one of those individually costs 100ms+, which is not
   plausible as server-side execution time for a bare `BEGIN`/`COMMIT` — that's wire time, not query
   planning. `pgbouncer=true` (added in M3 to stop connection drops under sustained sync writes) makes
   Prisma wrap every single query in an explicit transaction plus a defensive `DEALLOCATE ALL`, because
   PgBouncer's transaction-pooling mode can't guarantee prepared-statement continuity across pooled
   connections. That's 4 round trips per logical query instead of 1.
2. `pg_stat_activity` during the same test showed exactly **one** backend connection
   (`application_name: pgbouncer`, alive 14+ minutes) — connections are being reused correctly, not
   re-established per request. That hypothesis is ruled out.
3. A raw TCP+TLS connect to the Neon host measured **290ms** — real network RTT from a dev laptop to
   `ap-southeast-1`, consistent with the 4-round-trips-per-query math (`/me`'s ~1.05s ≈ 2 queries × 4 round
   trips × ~130ms average).

So: not statement re-planning, not connection churn — round-trip count amplified by long-haul RTT. Every
dev-laptop measurement in this repo (M3's sync timings included) has paid this same tax; it looks
different in production only because Railway (Singapore) sits next to Neon (`ap-southeast-1`), not across
an ocean from it.

**Action item**: this must be re-measured post-deploy from Railway Singapore before drawing conclusions —
p95 latency numbers from a dev laptop are not representative. If it's still >100ms from Railway (i.e. the
4-round-trips-per-query cost itself, not the RTT, turns out to matter even at near-zero latency), the fix
is a **second, non-pooled `DATABASE_URL`** for the API's read path (the pooled+`pgbouncer=true` URL stays
in place for the sync worker's writes, which is what it was added for). Neon supports both URLs
concurrently against the same database — no migration, just a second env var and a second Prisma client
(or datasource) for reads. Not implemented; infrastructure changes are on hold pending explicit approval.

## M5 Zoho-side webhook chain untested (deferred to Railway deploy)

Zoho-side webhook chain untested (merge-field substitution, JSON body type, query-param secret, trigger
condition, real delivery) — all doc assumptions. Validate during Railway deploy following
`docs/ZOHO-WEBHOOK-SETUP.md`; handler logic itself fully tested via simulated payloads.

## M7d kill-9 resumability test — run for real, proven (16 Jul)

The mandatory acceptance test (previously skipped in M7a) was run for real against `sync:reconcile`. To fit
a reasonable time budget without re-running the full ~34-page contacts phase, a synthetic checkpoint was
seeded directly into `SyncState('full_reconcile')` (`checkpointPhase: 'journeys', checkpointPagesDone: 0`) —
this exercises the exact same `resolveRunStart`/`runPagedPhase` code a real crash-resume would, just without
waiting through contacts first. Sequence, with a real complication along the way:

1. First `kill -9` landed while a **stray `npm run dev` process's own nightly cron reconcile** (unrelated,
   independently triggered by `0 2 * * *` firing at the same wall-clock moment) was racing the same
   checkpoint row — see the new entry below. That contamination was caught (the resume showed "page 8" when
   "page 5" was expected) and the stray process was stopped.
2. Retried clean and isolated: killed at page 12→14 committed, confirmed process genuinely dead
   (`ps` returns nothing), restarted — **`[reconcile] resuming from page 15 of journeys`**, exactly one past
   the last committed page. Pages 15–19 then committed normally, proving real continued progress, not just a
   correct log line.
3. Also exercised the SIGTERM path on the same run: sent `SIGTERM` mid-page-19, it finished that page,
   logged `received SIGTERM, finishing the in-flight page batch then exiting...`, persisted the checkpoint at
   page 20, and exited cleanly on its own (confirmed via `ps`, no orphan).

Both interruption paths (`kill -9` via durable per-page checkpoint commit, `SIGTERM` via the graceful-stop
flag) are now proven with real process kills and real log evidence, not just unit tests. `full_reconcile`'s
`SyncState` is currently left mid-flight at page 20/journeys — safe, resumable state; the next nightly cron
or a manual `npm run sync:reconcile` picks up from there automatically.

## Concurrent sync runs can race the same checkpoint row (found live, 16 Jul)

While running the kill-9 test above, a stray `npm run dev` process (left running from earlier debugging,
`ENABLE_SYNC=true`) independently fired its own nightly full-reconcile cron at `0 2 * * *` — at the exact
moment a manual `sync:reconcile` test run was also active. Both processes read and wrote
`SyncState('full_reconcile')`'s checkpoint concurrently; the manual run's resume line showed a page number
inconsistent with its own kill point, confirming the two processes had raced each other's checkpoint writes.

`node-cron`'s `noOverlap: true` (in `scheduler.ts`) only prevents *the same scheduler instance* from
double-firing — it does nothing across two separate OS processes (two `tsx` invocations, two deployments, a
stray dev server left running alongside a real one). Journey/Contact upserts are idempotent per
`zohoRecordId`/`zohoContactId` so concurrent writes don't corrupt customer data, but the checkpoint row
itself has no protection against being clobbered out of order by a second writer, and both processes waste
Zoho API calls redoing the same pages.

**Action item**: before relying on this in a real multi-instance or redeploy scenario, add a cross-process
lock for sync runs (e.g. a Postgres advisory lock keyed on the sync `key`, held for the run's duration) so a
second concurrent invocation fails fast instead of racing. Not urgent for a single always-on deployment with
disciplined process hygiene (don't leave stray dev servers running with `ENABLE_SYNC=true`), but worth
fixing before any deploy topology where two instances could plausibly run simultaneously (e.g. a rolling
deploy with overlap).

## 395 orphaned journeys from unresolvable contact phone data

The M7a full bootstrap run (16 Jul) is the first sync pass ever to complete cleanly end to end, and it
surfaced real Zoho-side data-quality debt that earlier partial/crashed runs never got far enough to see:
395 journey (Deals) records reference a contact whose phone data couldn't be resolved into a valid
`mobile_e164`, so the contact itself was never synced locally (per the existing DUPLICATE_MOBILE/
UNPARSEABLE_PHONE/NO_VALID_MOBILE skip pattern from M3) — and because a journey requires its contact to
exist locally first, every journey pointing at one of those ~258 skipped contacts gets logged as
`SyncIssue(reason: "ORPHAN_JOURNEY")` and dropped for the run instead of crashing.

This is the sync worker behaving correctly (skip-and-log, not crash-and-lose-everything-else), but it's a
real product problem: those Elgris customers currently have no visible journey in the app because their CRM
contact record has an unparseable or missing phone number. Self-heals automatically once the underlying
Zoho contact record is fixed (next incremental/reconcile pass will pick it up) — no code changes needed on
our side, this is a CRM data-hygiene issue.

**Action item**: sent to Elgris as a CSV action list (`outputs/orphan-contact-phone-report.csv`, generated
16 Jul) — zoho contact ID, contact name (fetched live from Zoho since skipped contacts are never written
locally), raw phone value, and reason, one row per contact-side phone issue. Re-run the export after Elgris
fixes a batch to confirm the orphan count drops.

## M7b npm audit: accepted with note, pending a deliberate Fastify v5 migration

`npm audit` reports 10 advisories (1 critical, 6 high, 3 moderate) against the installed dependency tree.
Assessed each against actual reachability (not just presence in `node_modules`) rather than upgrading blind:

- **Dev-tooling only, zero production exposure**: the critical one (`vitest`) and 4 of the moderates/highs
  (`@vitest/mocker`, `vite`, `vite-node`, `esbuild`) are all pulled in transitively by `vitest`, a
  devDependency that never runs or ships in production. Accepted with note, no action needed now.
- **Fastify chain, present in the runtime dependency tree** — assessed per-advisory against how this
  codebase actually uses Fastify (no route ever registers a `schema:` option — all validation is Zod; no
  route reads `request.protocol`/`request.host`; no route sends a stream response):
  - `request.protocol`/`request.host` spoofing via `X-Forwarded-*` (moderate) — not reachable, unused.
  - `sendWebStream` unbounded-memory DoS (low) — not reachable, unused.
  - `@fastify/ajv-compiler` / `fast-json-stringify` / `fast-uri` URI-parsing bugs (high, path
    traversal + host confusion) — not reachable; Fastify's native ajv/serializer path is never invoked
    since every route validates via Zod instead of a route `schema`.
  - **Content-Type header tab-character body-validation bypass (high, GHSA-jx2c-rxcm-jvmq)** — genuinely
    reachable: every JSON POST route (`/auth/send-otp`, `/auth/verify-otp`, `/webhooks/zoho/*`) goes through
    Fastify's built-in body parser, exactly where this bug lives.

**Why not fixed now**: none of the Fastify-chain advisories have a minor/patch fix — the fix for the
reachable one landed in Fastify 5.7.2, meaning the only path is a major-version bump (v4→v5) touching the
core framework, every plugin (`@fastify/helmet`, `@fastify/cors`), and potentially route/plugin API surface.
Explicitly out of scope for a hardening pass — no major upgrades without deliberate, separate approval.

**Action item**: plan a dedicated Fastify v5 migration post-launch (own PR, full regression pass, plugin
version bumps for `@fastify/helmet`/`@fastify/cors` in lockstep). Until then, the Content-Type bypass is the
one concretely-open item — low urgency since exploiting it requires crafting a malformed Content-Type header
specifically to smuggle a body past validation, on routes that are already OTP-rate-limited or
secret-gated.

## Interakt WhatsApp OTP delivery — fixed and live-confirmed (16 Jul)

M7b's fail-closed fix to `interakt.ts`/`msg91.ts` (no more stub-faking OTP-send success outside
`NODE_ENV=development`) surfaced that **WhatsApp OTP delivery via Interakt had never actually worked** for
Elgris — masked until then because the old stub path faked `success:true` any time `NODE_ENV=development`,
and the app had apparently only ever been exercised in that mode. Two distinct, real bugs found via live
tests against `+919760341277` (`NODE_ENV=production` so nothing could stub-fake a result):

1. **Template name typo** — `seed/elgris.tenant-config.json`'s `notifications.interakt_otp_template` was
   `"Otp_varify"` (capital O); Interakt returned `400 {"result":false,"message":"No approved template found
   with name 'Otp_varify' and language 'en'..."}`. Fixed: corrected to `"otp_varify"` (lowercase), matching
   the value already present — unused — in `.env`'s `INTERAKT_OTP_TEMPLATE`.

2. **Missing button variable value** — after the name fix, Interakt returned a *different* `400`:
   `{"result":false,"message":"Missing variable values for template's button at index 0, expected number of
   values are 1"}`. The `otp_varify` template has a "Copy Code" button component (standard for
   authentication-category WhatsApp templates) requiring its own variable value, separate from the body
   placeholder. Per Interakt's own docs (send-whatsapp-authentication-template), authentication templates need
   the *same* OTP in both `template.bodyValues` and `template.buttonValues: {"0": [otp]}` — `interakt.ts` was
   only sending `bodyValues`. Fixed by adding the matching `buttonValues` field.

Both fixes verified with a real live send: `200 {"success":true,"channel":"whatsapp"}`, no errors in the
server log, and **confirmed received on the actual device** (not just a 200 response — the operator
independently confirmed the WhatsApp message arrived). OTP delivery via WhatsApp is now genuinely working
for Elgris, not just reporting success.

MSG91 SMS fallback remains unconfigured (`MSG91_API_KEY` unset in `.env`) — fine as a fallback gap for now
since the primary WhatsApp channel works, but worth configuring before relying on the fallback path for
customers without WhatsApp.

## Journey source switched from Deals to Sales_Orders (16 Jul) — real installation stages found

M7d's disposition review found that 0 of 6,061 Deals ever matched any of the 5 configured "journey" stages —
the real installation-journey data was never on Deals at all. Confirmed live (via the app's own Zoho
credentials, not the MCP Zoho connector — that one turned out to be authenticated to a different org,
Webspecia's own internal CRM, not Elgris's; see the investigation in this session's history if the org
mismatch recurs): Elgris's `Sales_Orders` module has a `Stage` picklist with the real 6-value pipeline
(Material Dispatch, Construction, Net Metering, Disbursement, Subsidy Redeem, Subsidy Received) plus a
"Process Dates" section of per-milestone date fields. But `Stage` itself is populated on only 3 of 1,075
scanned Sales Orders (0.3%) — so progress is now derived from **which date fields are filled**, not from
`Stage` (see `src/sync/date-stage-resolve.ts`). `zoho.journey_module` is now `Sales_Orders`,
`journey_name_field` is `Subject` (not `Deal_Name`, which is a lookup object on this module, not text).

**Excluded date fields, pending Elgris confirmation**: `Sanction_Date`, `Application_Submission`,
`Accounts_Approval`, `Release_Order_Date`, `Documents_Upload_Date`, `Disbursement_Date_2`,
`Sales_Order_closed_date` all exist on the module but aren't in the configured 8-stage sequence.
`Sanction_Date` and `Application_Submission` look customer-meaningful for a subsidy journey in particular —
flagged for Elgris to confirm; adding any of them later is a config-only change (add a stage entry with a
`date_field`), no code change needed.

**Stage order is a placeholder** ("my logic, revise later" per explicit instruction) — Sales Order → Material
Dispatch → Construction → Net Metering → Bond Completion → Disbursement → Subsidy Redeem → Subsidy Received.
Not confirmed against Elgris's actual process. Same for all `next_copy`/`owner` text on the new stages.

**Action item — Option B, dual-source, logged as a fast-follow candidate, not built**: switching
`journey_module` exclusively to `Sales_Orders` means a contact with a Closed Won Deal but no Sales Order yet
sees the empty state (now updated to "Your project is being set up..." rather than a cold "no journeys" —
see below), not a pre-sales pipeline view. If Elgris wants pre-sales Deal-pipeline visibility to coexist with
the post-sale Sales_Orders installation timeline, that needs a `source_module`-style discriminator on
`journeys` (today's schema/sync assumes one module feeds one journey type) plus a decision for what happens
when a contact has both. Not scoped or built — Option A (Sales_Orders exclusive) was chosen for now since the
Deals-based progress bar was already showing nothing meaningful for any customer (per the 0/6,061 finding
above).

**Known gap — webhooks still target Deals**: `docs/ZOHO-WEBHOOK-SETUP.md`'s two Workflow Rules were configured
for the `Deals` module's `Stage` field changes. They're now mismatched with the actual journey source
(`Sales_Orders`) — instant push-on-stage-change won't fire for the real installation pipeline until the
Workflow Rules are recreated against `Sales_Orders`. The 15-min incremental sync remains the fallback, so
this degrades to "up to 15 min delay" rather than "broken," but it's a real gap, not yet addressed — out of
scope for this change, which was config/sync/read-path only.

**Stray Sales Order data quality**: `Stage`'s picklist has a stray lowercase `"stage"` value (bad data entry
in at least one real record, not a real workflow status) — needs no code handling, the date-driven design
doesn't depend on `Stage` being clean. Worth a future data-hygiene pass with Elgris, same pattern as the
orphan-contact-phone CSV.
