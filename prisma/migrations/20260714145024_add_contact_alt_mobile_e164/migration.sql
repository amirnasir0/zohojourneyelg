-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "alt_mobile_e164" TEXT;

-- CreateIndex
CREATE INDEX "contacts_alt_mobile_e164_idx" ON "contacts"("alt_mobile_e164");
