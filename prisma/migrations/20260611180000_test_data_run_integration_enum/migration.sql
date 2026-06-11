-- CR-2026-020 (T-a) — Test Data Sandbox: enum value only.
-- Split out from the table migration so the new enum value is committed in its
-- own transaction before any later migration could use it (safest shape for an
-- ALTER TYPE ... ADD VALUE on PostgreSQL). ADDITIVE ONLY; no data change.
-- NOTE: NOT applied during T-a review; applied only when approved.

-- AlterEnum
ALTER TYPE "IntegrationSystem" ADD VALUE 'TEST_DATA_RUN';
