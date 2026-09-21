-- CR-2026-113 — placeholder text must not behave like an email address.
--
-- THE PROBLEM
--   The customer import put the literal string "N/A" in the email column of
--   3,649 records. Nothing can be sent to it, but it is not nothing: it makes
--   "has an email address" read as true in every count, every report and every
--   screen that checks for presence rather than validity.
--
-- WHAT THIS CHANGES
--   Recognised placeholder text becomes NULL — the application's proper
--   representation of "we do not have this". Nothing else. The comparison is on
--   a trimmed, lower-cased copy, so " N/A " and "n/a" are both caught, and the
--   stored value of a real address is never rewritten.
--
--   Recognised placeholders: n/a · na · n.a. · none · null · nil · - · -- · .
--   (plus any value that is only whitespace)
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   * It does not touch a value containing "@". No legitimate address is
--     altered, re-cased or trimmed by this migration.
--   * It does not try to REPAIR anything. This database contains one address
--     with a missing @ ("sashan.wisdom99gmail.com") and one free-text note
--     ("driver jason west"). Guessing at either would be inventing customer
--     data. They are left exactly as they are, reported in docs/132 §2, and the
--     application already treats both as "no valid address" rather than trying
--     to send to them.
--   * It does not touch any consent/preference column.
--
-- IDEMPOTENT: re-running matches nothing, because the values are already NULL.
--
-- AUDIT: the row count actually changed is written to audit_logs with a NULL
--   actor (the platform's convention for system-initiated actions), so the
--   change is explainable later from inside the application, not only from
--   this file.
--
-- ROLLBACK
--   Deliberately not reversible: the original value carried no information
--   beyond "not supplied", which is exactly what NULL now records. The audit row
--   retains the count for verification.

DO $$
DECLARE
  before_total   integer;
  before_placeholder integer;
  cleared        integer;
  after_placeholder  integer;
  after_real     integer;
BEGIN
  SELECT count(*) INTO before_total FROM customers;
  SELECT count(*) INTO before_placeholder
    FROM customers
   WHERE email IS NOT NULL
     AND lower(btrim(email)) IN ('n/a', 'na', 'n.a.', 'none', 'null', 'nil', '-', '--', '.', '');

  UPDATE customers
     SET email = NULL
   WHERE email IS NOT NULL
     AND lower(btrim(email)) IN ('n/a', 'na', 'n.a.', 'none', 'null', 'nil', '-', '--', '.', '');
  GET DIAGNOSTICS cleared = ROW_COUNT;

  SELECT count(*) INTO after_placeholder
    FROM customers
   WHERE email IS NOT NULL
     AND lower(btrim(email)) IN ('n/a', 'na', 'n.a.', 'none', 'null', 'nil', '-', '--', '.', '');
  SELECT count(*) INTO after_real FROM customers WHERE email IS NOT NULL AND position('@' in email) > 0;

  -- The customer count itself must be identical: this migration clears a column,
  -- it never removes a customer. Fail loudly rather than quietly if that changed.
  IF (SELECT count(*) FROM customers) <> before_total THEN
    RAISE EXCEPTION 'CR-2026-113: customer count changed during email cleanup (% -> %)',
      before_total, (SELECT count(*) FROM customers);
  END IF;

  IF cleared > 0 THEN
    INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, before_json, after_json, reason_code, notes)
    VALUES (
      NULL,
      'CUSTOMER_PLACEHOLDER_EMAILS_CLEARED',
      'Customer',
      NULL,
      jsonb_build_object('placeholderEmails', before_placeholder, 'customers', before_total),
      jsonb_build_object(
        'cleared', cleared,
        'placeholderEmailsRemaining', after_placeholder,
        'realAddressesUnchanged', after_real,
        'customers', before_total
      ),
      'DATA_QUALITY',
      'CR-2026-113 — literal placeholder text ("N/A" and similar) replaced with NULL in customers.email. No address containing "@" was altered and no customer record was removed.'
    );
  END IF;

  RAISE NOTICE 'CR-2026-113 email cleanup: % cleared, % placeholders remaining, % real addresses, % customers',
    cleared, after_placeholder, after_real, before_total;
END
$$;
