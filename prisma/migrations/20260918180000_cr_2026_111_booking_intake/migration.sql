-- CR-2026-111 — customer booking becomes the intake layer for the Job Sheet.
--
-- ADDITIVE ONLY. Two changes, neither of which alters an existing row's meaning.
--
-- 1. service_types.sedan_duration_minutes / suv_duration_minutes
--
--    Planned minutes that depend on the vehicle. NULL on both — which is every
--    existing row — means `base_duration_minutes` applies to everything, exactly
--    as today.
--
--    Added for General Servicing, whose 90/120 split management already approved
--    in `kpi_benchmarks`. Deliberately NOT read from that table at runtime: a KPI
--    benchmark is what a technician is measured against afterwards; a scheduling
--    duration is what a customer is promised beforehand. Wiring one to the other
--    would mean a change to how staff are rated silently moved every customer's
--    appointment.
--
-- 2. booking_intakes
--
--    What the customer said when booking, in their own words. Deliberately small:
--    name, phone, email, plate, make, model, year and VIN have canonical homes on
--    customers and vehicles, and mileage has one on appointments. Copying any of
--    them here would create a second version of the truth that drifts the first
--    time somebody corrects a phone number.
--
--    What has no home today is the category the customer picked, the symptoms
--    they ticked, and the sentence they wrote — which is real diagnostic context
--    and is currently lost between the booking page and the Job Sheet.
--
-- ROLLBACK: drop the table and the two columns. Nothing outside the booking and
-- Job Sheet read paths references either.

ALTER TABLE "service_types"
  ADD COLUMN IF NOT EXISTS "sedan_duration_minutes" INTEGER,
  ADD COLUMN IF NOT EXISTS "suv_duration_minutes"   INTEGER;

CREATE TABLE IF NOT EXISTS "booking_intakes" (
  "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
  "appointment_id"      UUID NOT NULL,
  "category"            TEXT NOT NULL,
  "customer_concern"    TEXT,
  "symptoms"            TEXT[] NOT NULL DEFAULT '{}',
  "additional_comments" TEXT,
  "source_channel"      TEXT NOT NULL DEFAULT 'CUSTOMER_SELF_SERVICE',
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "booking_intakes_pkey" PRIMARY KEY ("id")
);

-- One intake per appointment: a second would be a second answer to "what did the
-- customer ask for", and nothing would say which one was true.
CREATE UNIQUE INDEX IF NOT EXISTS "booking_intakes_appointment_id_key"
  ON "booking_intakes" ("appointment_id");
CREATE INDEX IF NOT EXISTS "booking_intakes_category_idx"
  ON "booking_intakes" ("category");

ALTER TABLE "booking_intakes"
  ADD CONSTRAINT "booking_intakes_appointment_id_fkey"
  FOREIGN KEY ("appointment_id") REFERENCES "appointments" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
