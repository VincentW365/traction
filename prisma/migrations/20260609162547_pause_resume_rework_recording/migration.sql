-- CreateEnum
CREATE TYPE "PauseReason" AS ENUM ('WAITING_TECH', 'WAITING_BAY', 'CUSTOMER_AUTHORIZATION', 'EXTERNAL_MACHINE_SHOP', 'BREAK_OR_END_OF_DAY', 'OTHER');

-- AlterEnum
ALTER TYPE "ServiceOrderStatus" ADD VALUE 'PAUSED';

-- CreateTable
CREATE TABLE "service_order_pauses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "service_order_id" UUID NOT NULL,
    "reason_code" "PauseReason" NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,
    "paused_by_user_id" UUID,
    "resumed_by_user_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_order_pauses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order_reworks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "service_order_id" UUID NOT NULL,
    "reason_code" TEXT NOT NULL,
    "description" TEXT,
    "rework_count" INTEGER NOT NULL DEFAULT 1,
    "opened_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opened_by_user_id" UUID,
    "closed_at" TIMESTAMPTZ,
    "closed_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_order_reworks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_order_pauses_service_order_id_idx" ON "service_order_pauses"("service_order_id");

-- CreateIndex
CREATE INDEX "service_order_reworks_service_order_id_idx" ON "service_order_reworks"("service_order_id");

-- AddForeignKey
ALTER TABLE "service_order_pauses" ADD CONSTRAINT "service_order_pauses_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_reworks" ADD CONSTRAINT "service_order_reworks_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
