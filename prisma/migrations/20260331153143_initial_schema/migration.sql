-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED', 'MISSED', 'CANCELLED', 'RESCHEDULED');

-- CreateEnum
CREATE TYPE "ServiceVisitStatus" AS ENUM ('CREATED', 'ARRIVED', 'CHECKED_IN', 'QUEUED', 'CALLED', 'IN_SERVICE', 'WAITING_PARTS', 'QC', 'READY_FOR_PICKUP', 'CLOSED', 'ABANDONED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QueueDisplayStatus" AS ENUM ('PENDING_RANK', 'ISSUED', 'WAITING', 'CALLED', 'IN_SERVICE', 'BLOCKED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VisitSourceType" AS ENUM ('APPOINTMENT', 'WALKIN');

-- CreateEnum
CREATE TYPE "QueuePriorityClass" AS ENUM ('APPT_PROTECTED', 'APPT_LATE_SOFT', 'WALKIN_STANDARD', 'WALKIN_FASTTRACK', 'BLOCKED_PARTS', 'BLOCKED_SKILL', 'MISSED_APPOINTMENT', 'MANUAL_OVERRIDE');

-- CreateEnum
CREATE TYPE "ServiceOrderStatus" AS ENUM ('DRAFT', 'APPROVED', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_PARTS', 'QC', 'READY_TO_INVOICE', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PartsRequestStatus" AS ENUM ('OPEN', 'RESERVING', 'PARTIAL', 'READY', 'TRANSFER_IN_PROGRESS', 'RECEIVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('REQUESTED', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'DELAYED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TransportDirection" AS ENUM ('DROPOFF', 'PICKUP');

-- CreateEnum
CREATE TYPE "TransportStatus" AS ENUM ('REQUESTED', 'CONFIRMATION_PENDING', 'SCHEDULED', 'DRIVER_ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('SMS', 'EMAIL', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'SCHEDULED', 'SENT', 'DELIVERED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PENDING', 'PAID', 'ON_ACCOUNT', 'FAILED', 'WAIVED');

-- CreateEnum
CREATE TYPE "RecommendationConfidence" AS ENUM ('OEM', 'VERIFIED', 'NEEDS_CONFIRMATION', 'ESTIMATE');

-- CreateEnum
CREATE TYPE "DrivingProfile" AS ENUM ('NORMAL', 'SEVERE');

-- CreateTable
CREATE TABLE "sites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Jamaica',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID,
    "auth_subject" TEXT,
    "email" TEXT,
    "full_name" TEXT NOT NULL,
    "role_code" TEXT NOT NULL,
    "password_hash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_number" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "notification_opt_in_sms" BOOLEAN NOT NULL DEFAULT true,
    "notification_opt_in_email" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "plate_number" TEXT NOT NULL,
    "vin" TEXT,
    "make" TEXT,
    "model" TEXT,
    "model_year" INTEGER,
    "color" TEXT,
    "odometer" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "base_duration_minutes" INTEGER NOT NULL,
    "quick_service" BOOLEAN NOT NULL DEFAULT false,
    "appointment_only" BOOLEAN NOT NULL DEFAULT false,
    "required_skill_code" TEXT,
    "required_bay_type" TEXT,
    "parts_preposition_required" BOOLEAN NOT NULL DEFAULT false,
    "transport_eligible" BOOLEAN NOT NULL DEFAULT false,
    "batching_family" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "service_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_rule_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID,
    "rule_key" TEXT NOT NULL,
    "value_json" JSONB NOT NULL,
    "effective_from" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMPTZ,
    "notes" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_rule_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "scheduled_start_at" TIMESTAMPTZ NOT NULL,
    "scheduled_end_at" TIMESTAMPTZ,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'DRAFT',
    "confirmation_status" TEXT DEFAULT 'PENDING',
    "source_channel" TEXT DEFAULT 'STAFF',
    "notes" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_services" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "appointment_id" UUID NOT NULL,
    "service_type_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "requested_notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_visits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "appointment_id" UUID,
    "source_type" "VisitSourceType" NOT NULL,
    "arrival_at" TIMESTAMPTZ,
    "check_in_started_at" TIMESTAMPTZ,
    "checked_in_at" TIMESTAMPTZ,
    "status" "ServiceVisitStatus" NOT NULL DEFAULT 'CREATED',
    "queue_priority_class" "QueuePriorityClass",
    "current_eta_start_at" TIMESTAMPTZ,
    "current_eta_complete_at" TIMESTAMPTZ,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "service_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_tickets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "service_visit_id" UUID NOT NULL,
    "ticket_number" TEXT NOT NULL,
    "checkin_sequence" INTEGER NOT NULL,
    "queue_rank" INTEGER,
    "display_status" "QueueDisplayStatus" NOT NULL DEFAULT 'PENDING_RANK',
    "generated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_ranked_at" TIMESTAMPTZ,
    "override_active" BOOLEAN NOT NULL DEFAULT false,
    "override_reason_code" TEXT,
    "override_applied_by" UUID,
    "override_applied_at" TIMESTAMPTZ,
    "override_expires_at" TIMESTAMPTZ,
    "override_cleared_at" TIMESTAMPTZ,
    "override_cleared_by" UUID,
    "override_priority_mode" TEXT,
    "override_rank_position" INTEGER,

    CONSTRAINT "queue_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_decisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "service_visit_id" UUID NOT NULL,
    "snapshot_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priority_class" "QueuePriorityClass" NOT NULL,
    "score" DECIMAL(12,2),
    "blocked_reason" TEXT,
    "reason_codes" JSONB NOT NULL DEFAULT '[]',
    "candidate_technician_ids" JSONB,
    "candidate_bay_ids" JSONB,
    "eta_start_at" TIMESTAMPTZ,
    "eta_complete_at" TIMESTAMPTZ,

    CONSTRAINT "queue_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "technicians" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_account_id" UUID NOT NULL,
    "employee_code" TEXT NOT NULL,
    "home_site_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "technicians_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "technician_skills" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "technician_id" UUID NOT NULL,
    "skill_code" TEXT NOT NULL,
    "proficiency_level" INTEGER NOT NULL DEFAULT 1,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "technician_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_bays" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "bay_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "work_bays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "service_visit_id" UUID NOT NULL,
    "advisor_user_id" UUID,
    "status" "ServiceOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "promised_completion_at" TIMESTAMPTZ,
    "payment_status" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "closed_at" TIMESTAMPTZ,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "service_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "service_order_id" UUID NOT NULL,
    "service_type_id" UUID NOT NULL,
    "estimate_minutes" INTEGER,
    "actual_minutes" INTEGER,
    "parts_ready_flag" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "service_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "technician_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "service_order_id" UUID NOT NULL,
    "technician_id" UUID NOT NULL,
    "bay_id" UUID,
    "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "ended_at" TIMESTAMPTZ,
    "is_primary" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'ASSIGNED',

    CONSTRAINT "technician_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parts_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "service_order_id" UUID NOT NULL,
    "status" "PartsRequestStatus" NOT NULL DEFAULT 'OPEN',
    "required_by_at" TIMESTAMPTZ,
    "notes" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "parts_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parts_request_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "parts_request_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "description" TEXT,
    "qty_requested" DECIMAL(12,2) NOT NULL,
    "qty_reserved" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "critical_flag" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "parts_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parts_reservations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "parts_request_item_id" UUID NOT NULL,
    "inventory_location_code" TEXT NOT NULL,
    "qty_reserved" DECIMAL(12,2) NOT NULL,
    "reserved_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "parts_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_transfers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "parts_request_id" UUID NOT NULL,
    "source_site_id" UUID,
    "destination_site_id" UUID,
    "eta_at" TIMESTAMPTZ,
    "shipped_at" TIMESTAMPTZ,
    "received_at" TIMESTAMPTZ,
    "status" "TransferStatus" NOT NULL DEFAULT 'REQUESTED',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "inventory_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transport_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "service_visit_id" UUID NOT NULL,
    "direction" "TransportDirection" NOT NULL,
    "status" "TransportStatus" NOT NULL DEFAULT 'REQUESTED',
    "origin_address" TEXT,
    "destination_address" TEXT,
    "requested_pickup_at" TIMESTAMPTZ,
    "scheduled_pickup_at" TIMESTAMPTZ,
    "actual_start_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "driver_user_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "transport_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "template_key" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "provider_reference" TEXT,
    "scheduled_at" TIMESTAMPTZ,
    "sent_at" TIMESTAMPTZ,
    "delivered_at" TIMESTAMPTZ,
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_references" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "service_order_id" UUID NOT NULL,
    "external_ref" TEXT NOT NULL,
    "amount" DECIMAL(12,2),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "synced_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "changed_by_user_id" UUID,
    "changed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason_code" TEXT,
    "notes" TEXT,

    CONSTRAINT "status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "before_json" JSONB,
    "after_json" JSONB,
    "reason_code" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_spec_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "vehicle_id" UUID NOT NULL,
    "vin" TEXT,
    "year" INTEGER,
    "make" TEXT,
    "model" TEXT,
    "trim" TEXT,
    "engine_code" TEXT,
    "engine_description" TEXT,
    "displacement" TEXT,
    "fuel_type" TEXT,
    "drive_type" TEXT,
    "decode_source" TEXT NOT NULL,
    "decode_confidence" "RecommendationConfidence" NOT NULL,
    "decoded_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_spec_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fluid_spec_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "vehicle_id" UUID NOT NULL,
    "service_type_code" TEXT NOT NULL,
    "sae_viscosity_grade" TEXT,
    "api_category" TEXT,
    "ilsac_category" TEXT,
    "oem_approval_code" TEXT,
    "capacity_with_filter" DECIMAL(6,2),
    "capacity_without_filter" DECIMAL(6,2),
    "normal_interval_miles" INTEGER,
    "severe_interval_miles" INTEGER,
    "normal_interval_months" INTEGER,
    "severe_interval_months" INTEGER,
    "source_provider" TEXT NOT NULL,
    "source_reference" TEXT,
    "effective_at" TIMESTAMPTZ,
    "confidence" "RecommendationConfidence" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fluid_spec_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_recommendations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "vehicle_id" UUID NOT NULL,
    "service_visit_id" UUID,
    "service_order_id" UUID,
    "service_type_code" TEXT NOT NULL,
    "recommendation_type" TEXT NOT NULL,
    "driving_profile" "DrivingProfile" NOT NULL,
    "basis_odometer" INTEGER,
    "basis_date" TIMESTAMPTZ,
    "interval_miles" INTEGER,
    "interval_months" INTEGER,
    "next_due_odometer" INTEGER,
    "next_due_date" TIMESTAMPTZ,
    "due_now_flag" BOOLEAN,
    "is_determinable" BOOLEAN NOT NULL DEFAULT true,
    "recommendation_source" TEXT NOT NULL,
    "confidence" "RecommendationConfidence" NOT NULL,
    "fluid_spec_snapshot_id" UUID,
    "vehicle_spec_snapshot_id" UUID,
    "supersedes_recommendation_id" UUID,
    "notes" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sites_code_key" ON "sites"("code");

-- CreateIndex
CREATE UNIQUE INDEX "user_accounts_auth_subject_key" ON "user_accounts"("auth_subject");

-- CreateIndex
CREATE UNIQUE INDEX "customers_customer_number_key" ON "customers"("customer_number");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_vin_key" ON "vehicles"("vin");

-- CreateIndex
CREATE INDEX "vehicles_customer_id_idx" ON "vehicles"("customer_id");

-- CreateIndex
CREATE INDEX "vehicles_plate_number_idx" ON "vehicles"("plate_number");

-- CreateIndex
CREATE UNIQUE INDEX "service_types_code_key" ON "service_types"("code");

-- CreateIndex
CREATE INDEX "business_rule_configs_rule_key_idx" ON "business_rule_configs"("rule_key");

-- CreateIndex
CREATE INDEX "business_rule_configs_site_id_idx" ON "business_rule_configs"("site_id");

-- CreateIndex
CREATE INDEX "appointments_site_id_scheduled_start_at_idx" ON "appointments"("site_id", "scheduled_start_at");

-- CreateIndex
CREATE INDEX "appointments_status_idx" ON "appointments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "service_visits_appointment_id_key" ON "service_visits"("appointment_id");

-- CreateIndex
CREATE INDEX "service_visits_site_id_status_idx" ON "service_visits"("site_id", "status");

-- CreateIndex
CREATE INDEX "service_visits_customer_id_vehicle_id_idx" ON "service_visits"("customer_id", "vehicle_id");

-- CreateIndex
CREATE UNIQUE INDEX "queue_tickets_service_visit_id_key" ON "queue_tickets"("service_visit_id");

-- CreateIndex
CREATE UNIQUE INDEX "queue_tickets_ticket_number_key" ON "queue_tickets"("ticket_number");

-- CreateIndex
CREATE INDEX "queue_tickets_queue_rank_idx" ON "queue_tickets"("queue_rank");

-- CreateIndex
CREATE INDEX "queue_tickets_display_status_idx" ON "queue_tickets"("display_status");

-- CreateIndex
CREATE INDEX "queue_decisions_service_visit_id_snapshot_at_idx" ON "queue_decisions"("service_visit_id", "snapshot_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "technicians_user_account_id_key" ON "technicians"("user_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "technicians_employee_code_key" ON "technicians"("employee_code");

-- CreateIndex
CREATE UNIQUE INDEX "technician_skills_technician_id_skill_code_key" ON "technician_skills"("technician_id", "skill_code");

-- CreateIndex
CREATE UNIQUE INDEX "work_bays_site_id_code_key" ON "work_bays"("site_id", "code");

-- CreateIndex
CREATE INDEX "service_orders_service_visit_id_idx" ON "service_orders"("service_visit_id");

-- CreateIndex
CREATE INDEX "service_orders_status_idx" ON "service_orders"("status");

-- CreateIndex
CREATE INDEX "technician_assignments_technician_id_idx" ON "technician_assignments"("technician_id");

-- CreateIndex
CREATE INDEX "technician_assignments_service_order_id_idx" ON "technician_assignments"("service_order_id");

-- CreateIndex
CREATE INDEX "parts_requests_service_order_id_idx" ON "parts_requests"("service_order_id");

-- CreateIndex
CREATE INDEX "parts_requests_status_idx" ON "parts_requests"("status");

-- CreateIndex
CREATE INDEX "inventory_transfers_status_idx" ON "inventory_transfers"("status");

-- CreateIndex
CREATE INDEX "transport_requests_service_visit_id_idx" ON "transport_requests"("service_visit_id");

-- CreateIndex
CREATE INDEX "transport_requests_status_idx" ON "transport_requests"("status");

-- CreateIndex
CREATE INDEX "notification_logs_entity_type_entity_id_idx" ON "notification_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "notification_logs_status_idx" ON "notification_logs"("status");

-- CreateIndex
CREATE INDEX "pos_references_service_order_id_idx" ON "pos_references"("service_order_id");

-- CreateIndex
CREATE INDEX "status_history_entity_type_entity_id_idx" ON "status_history"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "status_history_changed_at_idx" ON "status_history"("changed_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_idx" ON "audit_logs"("actor_user_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "vehicle_spec_snapshots_vehicle_id_idx" ON "vehicle_spec_snapshots"("vehicle_id");

-- CreateIndex
CREATE INDEX "fluid_spec_snapshots_vehicle_id_service_type_code_idx" ON "fluid_spec_snapshots"("vehicle_id", "service_type_code");

-- CreateIndex
CREATE INDEX "maintenance_recommendations_vehicle_id_idx" ON "maintenance_recommendations"("vehicle_id");

-- CreateIndex
CREATE INDEX "maintenance_recommendations_service_visit_id_idx" ON "maintenance_recommendations"("service_visit_id");

-- CreateIndex
CREATE INDEX "maintenance_recommendations_next_due_odometer_idx" ON "maintenance_recommendations"("next_due_odometer");

-- CreateIndex
CREATE INDEX "maintenance_recommendations_next_due_date_idx" ON "maintenance_recommendations"("next_due_date");

-- AddForeignKey
ALTER TABLE "user_accounts" ADD CONSTRAINT "user_accounts_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_rule_configs" ADD CONSTRAINT "business_rule_configs_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_rule_configs" ADD CONSTRAINT "business_rule_configs_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_service_type_id_fkey" FOREIGN KEY ("service_type_id") REFERENCES "service_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_visits" ADD CONSTRAINT "service_visits_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_visits" ADD CONSTRAINT "service_visits_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_visits" ADD CONSTRAINT "service_visits_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_visits" ADD CONSTRAINT "service_visits_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_tickets" ADD CONSTRAINT "queue_tickets_service_visit_id_fkey" FOREIGN KEY ("service_visit_id") REFERENCES "service_visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_tickets" ADD CONSTRAINT "queue_tickets_override_applied_by_fkey" FOREIGN KEY ("override_applied_by") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_tickets" ADD CONSTRAINT "queue_tickets_override_cleared_by_fkey" FOREIGN KEY ("override_cleared_by") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_decisions" ADD CONSTRAINT "queue_decisions_service_visit_id_fkey" FOREIGN KEY ("service_visit_id") REFERENCES "service_visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technicians" ADD CONSTRAINT "technicians_user_account_id_fkey" FOREIGN KEY ("user_account_id") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technicians" ADD CONSTRAINT "technicians_home_site_id_fkey" FOREIGN KEY ("home_site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_skills" ADD CONSTRAINT "technician_skills_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_bays" ADD CONSTRAINT "work_bays_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_service_visit_id_fkey" FOREIGN KEY ("service_visit_id") REFERENCES "service_visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_items" ADD CONSTRAINT "service_order_items_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_items" ADD CONSTRAINT "service_order_items_service_type_id_fkey" FOREIGN KEY ("service_type_id") REFERENCES "service_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_assignments" ADD CONSTRAINT "technician_assignments_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_assignments" ADD CONSTRAINT "technician_assignments_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_assignments" ADD CONSTRAINT "technician_assignments_bay_id_fkey" FOREIGN KEY ("bay_id") REFERENCES "work_bays"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parts_requests" ADD CONSTRAINT "parts_requests_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parts_request_items" ADD CONSTRAINT "parts_request_items_parts_request_id_fkey" FOREIGN KEY ("parts_request_id") REFERENCES "parts_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parts_reservations" ADD CONSTRAINT "parts_reservations_parts_request_item_id_fkey" FOREIGN KEY ("parts_request_item_id") REFERENCES "parts_request_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_parts_request_id_fkey" FOREIGN KEY ("parts_request_id") REFERENCES "parts_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transport_requests" ADD CONSTRAINT "transport_requests_service_visit_id_fkey" FOREIGN KEY ("service_visit_id") REFERENCES "service_visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transport_requests" ADD CONSTRAINT "transport_requests_driver_user_id_fkey" FOREIGN KEY ("driver_user_id") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_references" ADD CONSTRAINT "pos_references_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_history" ADD CONSTRAINT "status_history_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_spec_snapshots" ADD CONSTRAINT "vehicle_spec_snapshots_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fluid_spec_snapshots" ADD CONSTRAINT "fluid_spec_snapshots_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_recommendations" ADD CONSTRAINT "maintenance_recommendations_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_recommendations" ADD CONSTRAINT "maintenance_recommendations_service_visit_id_fkey" FOREIGN KEY ("service_visit_id") REFERENCES "service_visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_recommendations" ADD CONSTRAINT "maintenance_recommendations_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_recommendations" ADD CONSTRAINT "maintenance_recommendations_fluid_spec_snapshot_id_fkey" FOREIGN KEY ("fluid_spec_snapshot_id") REFERENCES "fluid_spec_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_recommendations" ADD CONSTRAINT "maintenance_recommendations_vehicle_spec_snapshot_id_fkey" FOREIGN KEY ("vehicle_spec_snapshot_id") REFERENCES "vehicle_spec_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_recommendations" ADD CONSTRAINT "maintenance_recommendations_supersedes_recommendation_id_fkey" FOREIGN KEY ("supersedes_recommendation_id") REFERENCES "maintenance_recommendations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_recommendations" ADD CONSTRAINT "maintenance_recommendations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
