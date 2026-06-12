-- CreateEnum
CREATE TYPE "ScheduleHoldStatus" AS ENUM ('ACTIVE', 'CONVERTED', 'RELEASED');

-- CreateTable
CREATE TABLE "schedule_holds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID NOT NULL,
    "scheduled_start_at" TIMESTAMPTZ NOT NULL,
    "scheduled_end_at" TIMESTAMPTZ NOT NULL,
    "status" "ScheduleHoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "label" TEXT,
    "notes" TEXT,
    "converted_appointment_id" UUID,
    "expires_at" TIMESTAMPTZ,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "schedule_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "schedule_holds_converted_appointment_id_key" ON "schedule_holds"("converted_appointment_id");

-- CreateIndex
CREATE INDEX "schedule_holds_site_id_scheduled_start_at_idx" ON "schedule_holds"("site_id", "scheduled_start_at");

-- CreateIndex
CREATE INDEX "schedule_holds_status_idx" ON "schedule_holds"("status");

-- AddForeignKey
ALTER TABLE "schedule_holds" ADD CONSTRAINT "schedule_holds_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
