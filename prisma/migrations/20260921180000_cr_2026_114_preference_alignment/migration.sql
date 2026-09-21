-- CR-2026-114 — align the hand-written preference table with the Prisma schema.
--
-- `deploy:check` compares the live database against prisma/schema.prisma and
-- warns on ANY difference, which is exactly what it is for: a schema the tooling
-- disagrees with is a schema nobody can reason about later. Two differences
-- crept in when the table was written by hand in the previous migration:
--
--   1. `updated_at` carried a database DEFAULT. Prisma's `@updatedAt` is
--      application-managed, so the column must not have one. Leaving it would
--      mean two writers of the same value with different rules.
--
--   2. The unique index was created with a name Postgres truncated at 63
--      characters; Prisma generates a shorter, different name for the same
--      constraint. Same index, same guarantee — but a name the tooling does not
--      recognise reads as drift forever.
--
-- Both are cosmetic in behaviour and both are fixed here rather than by editing
-- the applied migration, which would change a checksum that other environments
-- have already recorded.
--
-- Idempotent: each statement is guarded, so re-running changes nothing.

ALTER TABLE "customer_communication_preferences" ALTER COLUMN "updated_at" DROP DEFAULT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
     WHERE relname = 'customer_communication_preferences_customer_id_channel_purpose_'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE relname = 'customer_communication_preferences_customer_id_channel_purp_key'
  ) THEN
    ALTER INDEX "customer_communication_preferences_customer_id_channel_purpose_"
      RENAME TO "customer_communication_preferences_customer_id_channel_purp_key";
  END IF;
END
$$;
