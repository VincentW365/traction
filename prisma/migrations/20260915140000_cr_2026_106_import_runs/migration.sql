-- CR-2026-106 (docs/121 §D "Migration") — additive.
ALTER TYPE "IntegrationSystem" ADD VALUE IF NOT EXISTS 'PEACHTREE_CUSTOMER_LIST';

CREATE TABLE IF NOT EXISTS "import_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "system" "IntegrationSystem" NOT NULL,
  "mode" TEXT NOT NULL,
  "source_file" TEXT NOT NULL,
  "batch_id" TEXT,
  "started_at" TIMESTAMPTZ NOT NULL,
  "finished_at" TIMESTAMPTZ,
  "totals" JSONB NOT NULL,
  "exceptions_count" INTEGER NOT NULL DEFAULT 0,
  "reconciles" BOOLEAN NOT NULL DEFAULT false,
  "actor" TEXT,
  "database_label" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "import_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "import_runs_system_mode_started_at_idx" ON "import_runs"("system", "mode", "started_at");
