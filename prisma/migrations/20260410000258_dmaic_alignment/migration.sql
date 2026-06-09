-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ResourceCategory" ADD VALUE 'POWER_WASH';
ALTER TYPE "ResourceCategory" ADD VALUE 'EXTERNAL';

-- AlterEnum
ALTER TYPE "ServiceOrderStatus" ADD VALUE 'WAITING_CUSTOMER';

-- AlterTable
ALTER TABLE "service_types" ADD COLUMN     "is_external" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mobile_jack_allowed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "requires_mileage" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requires_power_wash" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stand_preferred" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "resource_operational_status" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "resource_id" UUID NOT NULL,
    "is_operational" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "set_by_user_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "resource_operational_status_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "resource_operational_status_resource_id_key" ON "resource_operational_status"("resource_id");

-- AddForeignKey
ALTER TABLE "resource_operational_status" ADD CONSTRAINT "resource_operational_status_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "work_resources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
