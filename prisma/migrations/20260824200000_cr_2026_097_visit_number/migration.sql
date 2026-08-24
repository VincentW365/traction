-- CR-2026-097 — human-readable visit identity.
-- Additive column + backfill; no rows are deleted or rewritten beyond the new column.

ALTER TABLE "service_visits" ADD COLUMN "visit_number" TEXT;

-- Ticketed visits: the ticket reference IS the visit identity (one number per
-- visit, not two competing ones). Legacy tickets fall back to ticket_number.
UPDATE "service_visits" sv
SET "visit_number" = COALESCE(qt."ticket_reference", qt."ticket_number")
FROM "queue_tickets" qt
WHERE qt."service_visit_id" = sv."id";

-- Ticketless visits (pre-platform historical imports): V-yymmdd-NNN assigned in
-- visit-date order. Deterministic (ordered by timestamp then id) and collision-free
-- with ticket-based numbers, which always start with a location code (e.g. B01-).
WITH numbered AS (
  SELECT
    "id",
    'V-' || to_char(COALESCE("checked_in_at", "arrival_at", "created_at"), 'YYMMDD') || '-' ||
    lpad(
      (row_number() OVER (
        PARTITION BY date_trunc('day', COALESCE("checked_in_at", "arrival_at", "created_at"))
        ORDER BY COALESCE("checked_in_at", "arrival_at", "created_at"), "id"
      ))::text, 3, '0'
    ) AS vn
  FROM "service_visits"
  WHERE "visit_number" IS NULL
)
UPDATE "service_visits" sv
SET "visit_number" = n.vn
FROM numbered n
WHERE sv."id" = n."id";

CREATE UNIQUE INDEX "service_visits_visit_number_key" ON "service_visits"("visit_number");
