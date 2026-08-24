-- CreateEnum
CREATE TYPE "NotificationReason" AS ENUM ('SERVICE_DUE', 'QUEUE_CHECKED_IN', 'QUEUE_WORK_STARTED', 'QUEUE_UPDATE', 'PICKUP_READY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ServiceDueContactStatus" AS ENUM ('NOT_CONTACTED', 'CONTACTED', 'BOOKED', 'DEFERRED', 'DO_NOT_CONTACT');

-- AlterTable
ALTER TABLE "maintenance_recommendations" ADD COLUMN     "contact_status" "ServiceDueContactStatus" NOT NULL DEFAULT 'NOT_CONTACTED',
ADD COLUMN     "last_contact_log_id" UUID,
ADD COLUMN     "last_contacted_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "notification_logs" ADD COLUMN     "body" TEXT,
ADD COLUMN     "client_request_id" TEXT,
ADD COLUMN     "customer_id" UUID,
ADD COLUMN     "generated_body" TEXT,
ADD COLUMN     "intended_recipient" TEXT,
ADD COLUMN     "reason" "NotificationReason",
ADD COLUMN     "simulated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "subject" TEXT,
ADD COLUMN     "test_routed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "vehicle_id" UUID;

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "reason" "NotificationReason" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_key_key" ON "notification_templates"("key");

-- CreateIndex
CREATE INDEX "notification_templates_reason_idx" ON "notification_templates"("reason");

-- CreateIndex
CREATE UNIQUE INDEX "notification_logs_client_request_id_key" ON "notification_logs"("client_request_id");

-- CreateIndex
CREATE INDEX "notification_logs_customer_id_idx" ON "notification_logs"("customer_id");

-- CreateIndex
CREATE INDEX "notification_logs_vehicle_id_idx" ON "notification_logs"("vehicle_id");

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

