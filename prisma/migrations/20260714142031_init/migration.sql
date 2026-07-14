-- CreateTable
CREATE TABLE "sync_status" (
    "id" TEXT NOT NULL,
    "last_success_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_status_pkey" PRIMARY KEY ("id")
);
