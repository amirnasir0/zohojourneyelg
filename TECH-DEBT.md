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

## Sync bootstrap force-completed 15 Jul

The first-ever historical backfill (`sync:once`, no prior watermark) never ran to a clean finish — three
attempts across the day hit Neon connection drops (`P1017`) partway through the journeys phase, each time
after fully completing the contacts phase (6,799/6,799). Root causes found and fixed along the way: Zoho
pagination capped at 2,000 records (switched to `page_token`), a stray concurrent `tsx watch` server
double-running the sync via cron, no timeout on Zoho/DB calls (added 30s fetch timeout + 20s per-attempt
retry timeout), and Neon's direct endpoint vs. pooled+`pgbouncer=true`. The last attempt got to
5,900/6,449 journeys before a genuine (not hung) `P1017` during a `SyncIssue.create()` call.

Rather than keep re-running the full ~13k-record bootstrap, `SyncState('incremental')` was force-written
with `watermark = now`, `lastRunStatus = "ok"`, and the actual current table counts
(Contact=6,532, Journey=5,900, SyncIssue=13,592) so the 15-min incremental cron can start running normally
against real deltas instead of re-attempting the full historical pull every cycle.

The ~549 missing journeys (6,449 fetched from Zoho vs. 5,900 landed) are expected to be healed by the
nightly full reconcile (`0 2 * * *`), which does a complete re-pull independent of watermark — confirmed it
shares the same pooler/timeout/retry fixes as incremental, and its delete-guards are structured so a
partial failure (mid-loop) never reaches either `deleteMany` call, only a clean full pass does.

**Action item**: verify `Journey` count ≈ 6,449 after the first successful reconcile run (check
`SyncState('full_reconcile').lastRunStatus === 'success'` and `journeysProcessed`, or just re-count the
table). If reconcile also can't complete in one pass, that's a signal the Neon connection issue needs a
real fix (e.g. batched/bulk writes to cut round-trips) rather than more retries.

## Sync work parked 15 Jul

Bootstrap incomplete (~549 journeys missing) + write-path fixes (pooler params, batched writes, SyncIssue
dedupe+purge, P1017 reconnect) pending — must complete before production deploy. Nightly reconcile will
heal the gap once fixes land.

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
