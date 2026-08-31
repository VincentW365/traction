-- CR-2026-099 — reconciliation workstream for historical unknown-customer visits.
ALTER TABLE "service_visits" ADD COLUMN "historical_review_status" TEXT;
UPDATE "service_visits" sv SET "historical_review_status" = 'UNRESOLVED'
FROM "customers" c
WHERE c."id" = sv."customer_id" AND c."customer_number" = 'BERT-HIST-UNKNOWN';
