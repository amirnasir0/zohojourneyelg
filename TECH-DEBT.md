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
