-- Checkpoint columns for interruption-resilient sync (M7a Fix 5). All
-- nullable / defaulted so existing sync_state rows (the force-written
-- 'incremental' row from the parked bootstrap) remain valid without backfill.
ALTER TABLE "sync_state" ADD COLUMN "checkpoint_phase" TEXT;
ALTER TABLE "sync_state" ADD COLUMN "checkpoint_page_token" TEXT;
ALTER TABLE "sync_state" ADD COLUMN "checkpoint_pages_done" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "sync_state" ADD COLUMN "checkpoint_since_iso" TEXT;
ALTER TABLE "sync_state" ADD COLUMN "checkpoint_run_started_at" TIMESTAMP(3);
