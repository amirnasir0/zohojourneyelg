-- AlterEnum
ALTER TYPE "StaffRole" ADD VALUE 'MANAGER';

-- AlterEnum
ALTER TYPE "DocumentStatus" ADD VALUE 'PENDING_APPROVAL';

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "reviewed_by" TEXT;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
