-- CR-2026-089 — Queue ticket numbering v2.
--
--   Full reference   B01-260820-003   {LOCATION}-{YYMMDD}-{SEQUENCE}
--   Customer number  B01-003
--   Display emphasis 003
--
-- Replaces QTK-BERT-01-20260820-0003. QTK and BERT identified nothing the
-- application did not already know, and the four-digit year plus extra padding
-- cost width on a lobby screen for no identification benefit.
--
-- FULLY ADDITIVE and deliberately non-destructive. Existing tickets are NOT
-- rewritten: legacy QTK-... references stay exactly as issued for auditability,
-- and every read path keeps working because nothing in the codebase parses the
-- string — it has always been an opaque display token. The new columns are
-- nullable precisely so historical rows can leave them empty.
--
-- daily_ticket_counters exists so a sequence can be allocated by ONE atomic
-- upsert-and-increment instead of the previous SELECT MAX(seq)+1, which leaned
-- entirely on SERIALIZABLE isolation and, because Prisma does not retry, handed a
-- raw 500 to whichever front-desk user lost a concurrent check-in.
--
-- The composite unique on (business_date, daily_sequence, location_code_snapshot)
-- makes a duplicate sequence impossible even if the allocator were bypassed.

-- AlterTable
ALTER TABLE "queue_tickets" ADD COLUMN     "business_date" DATE,
ADD COLUMN     "daily_sequence" INTEGER,
ADD COLUMN     "display_ticket_number" TEXT,
ADD COLUMN     "location_code_snapshot" TEXT,
ADD COLUMN     "ticket_reference" TEXT;

-- AlterTable
ALTER TABLE "sites" ADD COLUMN     "ticket_code" TEXT;

-- CreateTable
CREATE TABLE "daily_ticket_counters" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "last_sequence" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_ticket_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "daily_ticket_counters_site_id_business_date_key" ON "daily_ticket_counters"("site_id", "business_date");

-- CreateIndex
CREATE UNIQUE INDEX "queue_tickets_ticket_reference_key" ON "queue_tickets"("ticket_reference");

-- CreateIndex
CREATE UNIQUE INDEX "queue_tickets_business_date_daily_sequence_location_code_sn_key" ON "queue_tickets"("business_date", "daily_sequence", "location_code_snapshot");

-- CreateIndex
CREATE UNIQUE INDEX "sites_ticket_code_key" ON "sites"("ticket_code");

-- AddForeignKey
ALTER TABLE "daily_ticket_counters" ADD CONSTRAINT "daily_ticket_counters_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

