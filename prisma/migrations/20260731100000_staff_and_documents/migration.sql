-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('ADMIN', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('NOT_UPLOADED', 'UPLOADED', 'SUBMITTED_FOR_REVIEW', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "pending_customer_review" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "journeys" ADD COLUMN     "owner_zoho_id" TEXT;

-- CreateIndex
CREATE INDEX "journeys_owner_zoho_id_idx" ON "journeys"("owner_zoho_id");

-- CreateTable
CREATE TABLE "staff_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL,
    "zoho_owner_id" TEXT,
    "full_name" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_users_email_key" ON "staff_users"("email");

-- CreateTable
CREATE TABLE "staff_sessions" (
    "id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_sessions_jti_key" ON "staff_sessions"("jti");

-- AddForeignKey
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "journey_id" TEXT,
    "document_key" TEXT NOT NULL,
    "stage_group_key" TEXT NOT NULL,
    "file_name" TEXT,
    "file_size" INTEGER,
    "zoho_attachment_id" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'NOT_UPLOADED',
    "uploaded_by" TEXT,
    "uploaded_at" TIMESTAMP(3),
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "documents_contact_id_document_key_key" ON "documents"("contact_id", "document_key");

-- CreateIndex
CREATE INDEX "documents_contact_id_idx" ON "documents"("contact_id");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_journey_id_fkey" FOREIGN KEY ("journey_id") REFERENCES "journeys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
