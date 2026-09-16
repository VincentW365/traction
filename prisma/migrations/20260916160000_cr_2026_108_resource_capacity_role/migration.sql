-- CR-2026-108 Stage 5B — canonical resource registry: capacity role, capabilities,
-- and the explicit bridge to the legacy WorkBay table.
--
-- ADDITIVE ONLY. Nothing is dropped or renamed, no existing row changes meaning,
-- and — critically — NO resource becomes production capacity because of this
-- migration. Every existing row lands on UNVERIFIED, which derives ZERO capacity.
-- That is the point: the Service Centre has physically expanded, so the inventory
-- is known-stale, and the safe default after a migration is "counts for nothing"
-- rather than "counts for something nobody has checked".
--
-- UNVERIFIED is deliberately distinct from SUPPORT_EQUIPMENT. A newly discovered
-- expansion bay that nobody has classified is not a jack; it is simply unconfirmed.
-- Both contribute zero, but only one of them is a statement of fact.
--
-- Production booking is unaffected: it remains FIXED on
-- booking_max_concurrent_appointments, and nothing here is read by the live engine.
--
-- ROLLBACK: drop the column, the table and the FK. No behaviour depends on them
-- until reconciliation populates them and RESOURCE_AWARE is separately activated.

CREATE TYPE "ResourceCapacityRole" AS ENUM (
  'UNVERIFIED',
  'PRIMARY_SERVICE_POSITION',
  'OVERFLOW_SERVICE_POSITION',
  'SUPPORT_EQUIPMENT',
  'PLACEHOLDER'
);

ALTER TABLE "work_resources"
  ADD COLUMN IF NOT EXISTS "capacity_role" "ResourceCapacityRole" NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN IF NOT EXISTS "legacy_bay_id" UUID;

-- One-to-one where linked: a legacy bay may be superseded by at most one resource.
CREATE UNIQUE INDEX IF NOT EXISTS "work_resources_legacy_bay_id_key"
  ON "work_resources" ("legacy_bay_id");

ALTER TABLE "work_resources"
  ADD CONSTRAINT "work_resources_legacy_bay_id_fkey"
  FOREIGN KEY ("legacy_bay_id") REFERENCES "work_bays" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Capabilities: what work a physical resource can satisfy. Reuses the vocabulary
-- ServiceType.requiredBayType already speaks, so the catalogue and the registry
-- finally agree. A capability NEVER implies a capacity unit.
CREATE TABLE IF NOT EXISTS "work_resource_capabilities" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "resource_id" UUID NOT NULL,
  "capability"  TEXT NOT NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_resource_capabilities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "work_resource_capabilities_resource_id_capability_key"
  ON "work_resource_capabilities" ("resource_id", "capability");
CREATE INDEX IF NOT EXISTS "work_resource_capabilities_capability_idx"
  ON "work_resource_capabilities" ("capability");

ALTER TABLE "work_resource_capabilities"
  ADD CONSTRAINT "work_resource_capabilities_resource_id_fkey"
  FOREIGN KEY ("resource_id") REFERENCES "work_resources" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
