-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "desk_contact_id" TEXT;

-- CreateTable
CREATE TABLE "tickets" (
    "id" TEXT NOT NULL,
    "desk_ticket_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "ticket_number" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "status" TEXT NOT NULL,
    "status_display" TEXT NOT NULL,
    "owner_name" TEXT,
    "co_owner_name" TEXT,
    "priority" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "raw" JSONB NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contacts_desk_contact_id_key" ON "contacts"("desk_contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_desk_ticket_id_key" ON "tickets"("desk_ticket_id");

-- CreateIndex
CREATE INDEX "tickets_contact_id_idx" ON "tickets"("contact_id");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
