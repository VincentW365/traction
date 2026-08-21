-- CR-2026-092 — two corrections the previous migration's blanket conversion could not make.
--
-- That migration turned every FORCES_CUSTOM_BENCHMARK mapping into ADDITIVE_STANDARD,
-- which is right for twenty-odd real services (a tune-up, a cooling service, an
-- alignment) that were only ever "custom" because the old model had nowhere else to
-- put them. Two rows need a different answer, and the seed could not supply it because
-- it is create-if-missing and these already existed.

-- Machine-shop work is performed by a third party. It has a catalogue duration, but
-- that duration describes someone else's work, and no catalogue standard can describe
-- what a technician here should be measured against. This is the one service where
-- CUSTOM_ONLY is the honest answer rather than a shrug.
UPDATE "kpi_service_components" c
SET "contribution_mode" = 'CUSTOM_ONLY',
    "duration_source"   = 'NO_DURATION',
    "notes" = COALESCE(c."notes", '') ||
      ' CR-2026-092: external third-party work — elapsed time is outside the technician''s control.'
FROM "service_types" s
WHERE s."id" = c."service_type_id"
  AND s."code" = 'MSHOP-01'
  AND c."is_active" = true;

-- DISC-01 has never appeared on a work order in the entire history, while BRK-02 is
-- the code the shop actually books. Both remain valid aliases for the same Front
-- Brakes component so historical lines stay resolvable; marking the unused one
-- superseded keeps it out of new bookings without rewriting anything.
UPDATE "kpi_service_components" c
SET "is_superseded_code" = true
FROM "service_types" s
WHERE s."id" = c."service_type_id"
  AND s."code" = 'DISC-01'
  AND c."is_active" = true;
