-- CR-2026-098b — zero out long-standing cosmetic drift between the migration
-- chain and schema.prisma, so `migrate diff` runs clean on fresh and existing
-- databases alike. All four items verified harmless on 2026-08-24:
--   * KpiPackageComponent: declared in schema (planned enum), never created by
--     any migration, referenced by no table.
--   * two indexes created by older migrations that schema.prisma no longer
--     declares.
--   * a column default schema.prisma does not declare.
DO $$ BEGIN
  CREATE TYPE "KpiPackageComponent" AS ENUM ('GENERAL_SERVICE', 'FRONT_BRAKES', 'SPARK_PLUGS');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DROP INDEX IF EXISTS "kpi_service_components_contribution_mode_idx";
DROP INDEX IF EXISTS "work_order_kpi_snapshots_benchmark_source_idx";
ALTER TABLE "inspection_photos" ALTER COLUMN "updated_at" DROP DEFAULT;
