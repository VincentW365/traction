-- CreateEnum
CREATE TYPE "VehicleServiceClass" AS ENUM ('SEDAN_CLASS', 'SUV_LIGHT', 'SUV_HEAVY', 'PICKUP', 'VAN', 'TRUCK', 'UNKNOWN_REQUIRES_REVIEW');

-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN     "service_class" "VehicleServiceClass";
