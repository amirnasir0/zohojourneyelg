-- Dedupe SyncIssue on (zoho_record_id, field, reason) so skipDuplicates can
-- collapse repeat occurrences of the same problem into one row instead of
-- one row per sync run. The 13,592 pre-existing rows (mostly duplicates from
-- three failed full-historical-pull attempts) were purged before this
-- migration ran, since a unique index can't be created over data that
-- already violates it.
CREATE UNIQUE INDEX "sync_issues_zoho_record_id_field_reason_key" ON "sync_issues"("zoho_record_id", "field", "reason");
