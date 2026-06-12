-- CreateEnum
CREATE TYPE "DriveSide" AS ENUM ('RHD', 'LHD');

-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN     "drive_side" "DriveSide";
