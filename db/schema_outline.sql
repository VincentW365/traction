-- Bert's Service Operations Platform
-- Starter schema outline (PostgreSQL-oriented)
-- This is a blueprint, not the final production migration set.

create extension if not exists pgcrypto;

-- =========================
-- ENUMS
-- =========================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'appointment_status') then
    create type appointment_status as enum (
      'DRAFT',
      'CONFIRMED',
      'CHECKED_IN',
      'IN_PROGRESS',
      'COMPLETED',
      'MISSED',
      'CANCELLED',
      'RESCHEDULED'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'service_visit_status') then
    create type service_visit_status as enum (
      'CREATED',
      'ARRIVED',
      'CHECKED_IN',
      'QUEUED',
      'CALLED',
      'IN_SERVICE',
      'WAITING_PARTS',
      'QC',
      'READY_FOR_PICKUP',
      'CLOSED',
      'ABANDONED',
      'CANCELLED'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'queue_display_status') then
    create type queue_display_status as enum (
      'ISSUED',
      'WAITING',
      'CALLED',
      'IN_SERVICE',
      'BLOCKED',
      'COMPLETED',
      'CANCELLED'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'visit_source_type') then
    create type visit_source_type as enum ('APPOINTMENT', 'WALKIN');
  end if;

  if not exists (select 1 from pg_type where typname = 'queue_priority_class') then
    create type queue_priority_class as enum (
      'APPT_PROTECTED',
      'APPT_LATE_SOFT',
      'WALKIN_STANDARD',
      'WALKIN_FASTTRACK',
      'BLOCKED_PARTS',
      'BLOCKED_SKILL',
      'MISSED_APPOINTMENT',
      'MANUAL_OVERRIDE'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'service_order_status') then
    create type service_order_status as enum (
      'DRAFT',
      'APPROVED',
      'ASSIGNED',
      'IN_PROGRESS',
      'WAITING_PARTS',
      'QC',
      'READY_TO_INVOICE',
      'CLOSED',
      'CANCELLED'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'parts_request_status') then
    create type parts_request_status as enum (
      'OPEN',
      'RESERVING',
      'PARTIAL',
      'READY',
      'TRANSFER_IN_PROGRESS',
      'RECEIVED',
      'CLOSED',
      'CANCELLED'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'transfer_status') then
    create type transfer_status as enum (
      'REQUESTED',
      'APPROVED',
      'IN_TRANSIT',
      'RECEIVED',
      'DELAYED',
      'CANCELLED'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'transport_direction') then
    create type transport_direction as enum ('DROPOFF', 'PICKUP');
  end if;

  if not exists (select 1 from pg_type where typname = 'transport_status') then
    create type transport_status as enum (
      'REQUESTED',
      'CONFIRMATION_PENDING',
      'SCHEDULED',
      'DRIVER_ASSIGNED',
      'IN_PROGRESS',
      'COMPLETED',
      'CANCELLED'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'notification_channel') then
    create type notification_channel as enum ('SMS', 'EMAIL', 'WHATSAPP');
  end if;

  if not exists (select 1 from pg_type where typname = 'notification_status') then
    create type notification_status as enum (
      'PENDING',
      'SCHEDULED',
      'SENT',
      'DELIVERED',
      'FAILED',
      'CANCELLED'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'payment_status') then
    create type payment_status as enum (
      'UNPAID',
      'PENDING',
      'PAID',
      'ON_ACCOUNT',
      'FAILED',
      'WAIVED'
    );
  end if;
end $$;

-- =========================
-- FOUNDATION
-- =========================

create table if not exists sites (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  timezone text not null default 'America/Jamaica',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_accounts (
  id uuid primary key default gen_random_uuid(),
  site_id uuid references sites(id),
  auth_subject text unique,
  email text,
  full_name text not null,
  role_code text not null,
  status text not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  customer_number text not null unique,
  first_name text not null,
  last_name text not null,
  phone text not null,
  email text,
  notification_opt_in_sms boolean not null default true,
  notification_opt_in_email boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists vehicles (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  plate_number text not null,
  vin text,
  make text,
  model text,
  model_year integer,
  color text,
  odometer integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vehicles_vin_unique unique (vin)
);

create index if not exists idx_vehicles_customer_id on vehicles(customer_id);
create index if not exists idx_vehicles_plate_number on vehicles(plate_number);

create table if not exists service_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  family text not null,
  base_duration_minutes integer not null,
  quick_service boolean not null default false,
  appointment_only boolean not null default false,
  required_skill_code text,
  required_bay_type text,
  parts_preposition_required boolean not null default false,
  transport_eligible boolean not null default false,
  batching_family text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists business_rule_configs (
  id uuid primary key default gen_random_uuid(),
  site_id uuid references sites(id),
  rule_key text not null,
  value_json jsonb not null,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  notes text,
  created_by_user_id uuid references user_accounts(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_business_rule_configs_key on business_rule_configs(rule_key);
create index if not exists idx_business_rule_configs_site on business_rule_configs(site_id);

-- =========================
-- APPOINTMENTS / VISITS / QUEUE
-- =========================

create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id),
  customer_id uuid not null references customers(id),
  vehicle_id uuid not null references vehicles(id),
  scheduled_start_at timestamptz not null,
  scheduled_end_at timestamptz,
  status appointment_status not null default 'DRAFT',
  confirmation_status text default 'PENDING',
  source_channel text default 'STAFF',
  notes text,
  created_by_user_id uuid references user_accounts(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_appointments_site_start on appointments(site_id, scheduled_start_at);
create index if not exists idx_appointments_status on appointments(status);

create table if not exists appointment_services (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments(id) on delete cascade,
  service_type_id uuid not null references service_types(id),
  qty integer not null default 1,
  requested_notes text,
  created_at timestamptz not null default now()
);

create table if not exists service_visits (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id),
  customer_id uuid not null references customers(id),
  vehicle_id uuid not null references vehicles(id),
  appointment_id uuid references appointments(id),
  source_type visit_source_type not null,
  arrival_at timestamptz,
  check_in_started_at timestamptz,
  checked_in_at timestamptz,
  status service_visit_status not null default 'CREATED',
  queue_priority_class queue_priority_class,
  current_eta_start_at timestamptz,
  current_eta_complete_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_service_visits_site_status on service_visits(site_id, status);
create index if not exists idx_service_visits_customer_vehicle on service_visits(customer_id, vehicle_id);

create table if not exists queue_tickets (
  id uuid primary key default gen_random_uuid(),
  service_visit_id uuid not null unique references service_visits(id) on delete cascade,
  ticket_number text not null unique,
  checkin_sequence integer not null,
  queue_rank integer,
  display_status queue_display_status not null default 'ISSUED',
  generated_at timestamptz not null default now(),
  last_ranked_at timestamptz
);

create index if not exists idx_queue_tickets_rank on queue_tickets(queue_rank);
create index if not exists idx_queue_tickets_display_status on queue_tickets(display_status);

create table if not exists queue_decisions (
  id uuid primary key default gen_random_uuid(),
  service_visit_id uuid not null references service_visits(id) on delete cascade,
  snapshot_at timestamptz not null default now(),
  priority_class queue_priority_class not null,
  score numeric(12,2),
  blocked_reason text,
  reason_codes jsonb not null default '[]'::jsonb,
  candidate_technician_ids jsonb,
  candidate_bay_ids jsonb,
  eta_start_at timestamptz,
  eta_complete_at timestamptz
);

create index if not exists idx_queue_decisions_visit_snapshot on queue_decisions(service_visit_id, snapshot_at desc);

-- =========================
-- TECHNICIANS / BAYS / SERVICE ORDERS
-- =========================

create table if not exists technicians (
  id uuid primary key default gen_random_uuid(),
  user_account_id uuid not null unique references user_accounts(id),
  employee_code text not null unique,
  home_site_id uuid references sites(id),
  status text not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists technician_skills (
  id uuid primary key default gen_random_uuid(),
  technician_id uuid not null references technicians(id) on delete cascade,
  skill_code text not null,
  proficiency_level integer not null default 1,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (technician_id, skill_code)
);

create table if not exists work_bays (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id),
  code text not null,
  bay_type text not null,
  status text not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, code)
);

create table if not exists service_orders (
  id uuid primary key default gen_random_uuid(),
  service_visit_id uuid not null references service_visits(id),
  advisor_user_id uuid references user_accounts(id),
  status service_order_status not null default 'DRAFT',
  promised_completion_at timestamptz,
  payment_status payment_status not null default 'UNPAID',
  started_at timestamptz,
  completed_at timestamptz,
  closed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_service_orders_visit on service_orders(service_visit_id);
create index if not exists idx_service_orders_status on service_orders(status);

create table if not exists service_order_items (
  id uuid primary key default gen_random_uuid(),
  service_order_id uuid not null references service_orders(id) on delete cascade,
  service_type_id uuid not null references service_types(id),
  estimate_minutes integer,
  actual_minutes integer,
  parts_ready_flag boolean not null default false,
  status text not null default 'PLANNED',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists technician_assignments (
  id uuid primary key default gen_random_uuid(),
  service_order_id uuid not null references service_orders(id) on delete cascade,
  technician_id uuid not null references technicians(id),
  bay_id uuid references work_bays(id),
  assigned_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,
  is_primary boolean not null default true,
  status text not null default 'ASSIGNED'
);

create index if not exists idx_technician_assignments_technician on technician_assignments(technician_id);
create index if not exists idx_technician_assignments_order on technician_assignments(service_order_id);

-- =========================
-- PARTS
-- =========================

create table if not exists parts_requests (
  id uuid primary key default gen_random_uuid(),
  service_order_id uuid not null references service_orders(id) on delete cascade,
  status parts_request_status not null default 'OPEN',
  required_by_at timestamptz,
  notes text,
  created_by_user_id uuid references user_accounts(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_parts_requests_order on parts_requests(service_order_id);
create index if not exists idx_parts_requests_status on parts_requests(status);

create table if not exists parts_request_items (
  id uuid primary key default gen_random_uuid(),
  parts_request_id uuid not null references parts_requests(id) on delete cascade,
  sku text not null,
  description text,
  qty_requested numeric(12,2) not null,
  qty_reserved numeric(12,2) not null default 0,
  critical_flag boolean not null default false,
  status text not null default 'OPEN',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists parts_reservations (
  id uuid primary key default gen_random_uuid(),
  parts_request_item_id uuid not null references parts_request_items(id) on delete cascade,
  inventory_location_code text not null,
  qty_reserved numeric(12,2) not null,
  reserved_at timestamptz not null default now(),
  status text not null default 'ACTIVE'
);

create table if not exists inventory_transfers (
  id uuid primary key default gen_random_uuid(),
  parts_request_id uuid not null references parts_requests(id),
  source_site_id uuid references sites(id),
  destination_site_id uuid references sites(id),
  eta_at timestamptz,
  shipped_at timestamptz,
  received_at timestamptz,
  status transfer_status not null default 'REQUESTED',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_inventory_transfers_status on inventory_transfers(status);

-- =========================
-- TRANSPORT
-- =========================

create table if not exists transport_requests (
  id uuid primary key default gen_random_uuid(),
  service_visit_id uuid not null references service_visits(id),
  direction transport_direction not null,
  status transport_status not null default 'REQUESTED',
  origin_address text,
  destination_address text,
  requested_pickup_at timestamptz,
  scheduled_pickup_at timestamptz,
  actual_start_at timestamptz,
  completed_at timestamptz,
  driver_user_id uuid references user_accounts(id),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_transport_requests_visit on transport_requests(service_visit_id);
create index if not exists idx_transport_requests_status on transport_requests(status);

-- =========================
-- NOTIFICATIONS / POS / HISTORY
-- =========================

create table if not exists notification_logs (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  channel notification_channel not null,
  template_key text not null,
  recipient text not null,
  status notification_status not null default 'PENDING',
  provider_reference text,
  scheduled_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_notification_logs_entity on notification_logs(entity_type, entity_id);
create index if not exists idx_notification_logs_status on notification_logs(status);

create table if not exists pos_references (
  id uuid primary key default gen_random_uuid(),
  service_order_id uuid not null references service_orders(id),
  external_ref text not null,
  amount numeric(12,2),
  status text not null default 'PENDING',
  synced_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_pos_references_order on pos_references(service_order_id);

create table if not exists status_history (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  from_status text,
  to_status text not null,
  changed_by_user_id uuid references user_accounts(id),
  changed_at timestamptz not null default now(),
  reason_code text,
  notes text
);

create index if not exists idx_status_history_entity on status_history(entity_type, entity_id);
create index if not exists idx_status_history_changed_at on status_history(changed_at);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references user_accounts(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before_json jsonb,
  after_json jsonb,
  reason_code text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_logs_actor on audit_logs(actor_user_id);
create index if not exists idx_audit_logs_entity on audit_logs(entity_type, entity_id);

-- =========================
-- RECOMMENDED FOLLOW-UP
-- =========================

-- Add trigger functions for updated_at maintenance.
-- Add application migrations for seed service types and business rules.
-- Add partial unique indexes for active visit / ticket constraints if required.
-- Add reporting views for queue board and KPI projections.
