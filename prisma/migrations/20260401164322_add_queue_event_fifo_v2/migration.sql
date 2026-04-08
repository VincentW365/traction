-- CreateTable
CREATE TABLE "queue_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "service_visit_id" UUID NOT NULL,
    "queue_ticket_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "position_before" INTEGER,
    "position_after" INTEGER,
    "reason_code" TEXT,
    "actor_user_id" UUID,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "queue_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "queue_events_service_visit_id_created_at_idx" ON "queue_events"("service_visit_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "queue_events_queue_ticket_id_idx" ON "queue_events"("queue_ticket_id");

-- AddForeignKey
ALTER TABLE "queue_events" ADD CONSTRAINT "queue_events_service_visit_id_fkey" FOREIGN KEY ("service_visit_id") REFERENCES "service_visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_events" ADD CONSTRAINT "queue_events_queue_ticket_id_fkey" FOREIGN KEY ("queue_ticket_id") REFERENCES "queue_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_events" ADD CONSTRAINT "queue_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
