-- CR-2026-118 §5 — the lobby screen shows licence plates, and how it does so is
-- management's to configure rather than a redeploy.
--
--   display_board_show_plates  TRUE   show the registration on every row
--   display_board_plate_mask   FALSE  show only the last characters (privacy option
--                                     the directive asked to have ready)
--   display_board_ready_hours  4      a "Ready" car drops off the screen after this
--                                     long — one collected without the visit being
--                                     closed must not hold a row all day
--
-- Idempotent: inserts nothing where a row already governs the key, per site.

INSERT INTO "business_rule_configs" ("id", "site_id", "rule_key", "value_json", "notes")
SELECT gen_random_uuid(), s."id", r.rule_key, r.value_json::jsonb, r.notes
FROM "sites" s
CROSS JOIN (
  VALUES
    ('display_board_show_plates', 'true',  'CR-2026-118: show the vehicle registration on the waiting-room display so customers recognise their car.'),
    ('display_board_plate_mask',  'false', 'CR-2026-118: when true, only the last characters of each registration are shown on the waiting-room display.'),
    ('display_board_ready_hours', '4',     'CR-2026-118: hours a Ready-for-collection vehicle stays on the waiting-room display before it drops off.')
) AS r(rule_key, value_json, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM "business_rule_configs" b
  WHERE b."rule_key" = r.rule_key AND (b."site_id" = s."id" OR b."site_id" IS NULL)
);
