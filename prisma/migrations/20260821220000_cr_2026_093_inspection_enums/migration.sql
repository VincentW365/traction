-- CR-2026-093 — enum additions, split into their own migration.
--
-- Postgres refuses to USE a new enum value in the transaction that added it, and
-- Prisma runs each migration file in one transaction. The values therefore have to be
-- committed here before the next migration can set a default or write a row with them.

CREATE TYPE "InspectionKind" AS ENUM ('VEHICLE_INSPECTION', 'PRE_INSPECTION');

CREATE TYPE "InspectionPhotoCategory" AS ENUM (
  'FRONT', 'REAR', 'DRIVER_SIDE', 'PASSENGER_SIDE', 'INTERIOR',
  'DASHBOARD_ODOMETER', 'EXISTING_DAMAGE', 'WHEEL_TIRE', 'OTHER'
);

CREATE TYPE "NoPhotoReason" AS ENUM (
  'CAMERA_UNAVAILABLE', 'CUSTOMER_DECLINED', 'IMAGE_NOT_REQUIRED', 'OTHER'
);

-- The honest default for a freshly created checklist item.
ALTER TYPE "InspectionItemResult" ADD VALUE IF NOT EXISTS 'NOT_INSPECTED' BEFORE 'OK';

-- Deliberately not carried out, as opposed to CANCELLED (the record was a mistake).
ALTER TYPE "InspectionStatus" ADD VALUE IF NOT EXISTS 'SKIPPED' BEFORE 'CANCELLED';
