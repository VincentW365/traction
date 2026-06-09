-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "loyalty_number" TEXT;

-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN     "drivetrain" TEXT,
ADD COLUMN     "engine_no" TEXT,
ADD COLUMN     "fuel_type" TEXT,
ADD COLUMN     "transmission" TEXT;
