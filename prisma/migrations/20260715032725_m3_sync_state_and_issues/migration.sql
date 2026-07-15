/*
  Warnings:

  - You are about to drop the `sync_status` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterTable
ALTER TABLE "journeys" ALTER COLUMN "stage_index" DROP NOT NULL;

-- DropTable
DROP TABLE "sync_status";

-- CreateTable
CREATE TABLE "sync_state" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "watermark" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "last_run_status" TEXT,
    "contacts_processed" INTEGER NOT NULL DEFAULT 0,
    "journeys_processed" INTEGER NOT NULL DEFAULT 0,
    "issues_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_issues" (
    "id" TEXT NOT NULL,
    "zoho_record_id" TEXT,
    "record_type" TEXT NOT NULL,
    "field" TEXT,
    "raw_value" TEXT,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sync_state_key_key" ON "sync_state"("key");

-- CreateIndex
CREATE INDEX "sync_issues_record_type_created_at_idx" ON "sync_issues"("record_type", "created_at");
