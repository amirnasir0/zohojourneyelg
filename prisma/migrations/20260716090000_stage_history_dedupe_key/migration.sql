-- StageHistory has never been written to (M3 never populated it), so this is
-- safe to add as NOT NULL directly with no backfill.
ALTER TABLE "stage_history" ADD COLUMN "dedupe_key" TEXT NOT NULL;
CREATE UNIQUE INDEX "stage_history_dedupe_key_key" ON "stage_history"("dedupe_key");
