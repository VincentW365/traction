export const PERMISSIONS = {
  // Customer & Vehicle
  CUSTOMER_SEARCH: 'customer:search',
  CUSTOMER_CREATE: 'customer:create',
  CUSTOMER_UPDATE: 'customer:update',
  CUSTOMER_DIRECTORY: 'customer:directory', // CR-2026-021 — admin/manager browse-all phonebook

  VEHICLE_CREATE: 'vehicle:create',
  VEHICLE_UPDATE: 'vehicle:update',

  // Appointments
  APPOINTMENT_CREATE: 'appointment:create',
  APPOINTMENT_UPDATE: 'appointment:update',
  APPOINTMENT_CANCEL: 'appointment:cancel',
  APPOINTMENT_CONFIRM: 'appointment:confirm',
  APPOINTMENT_VIEW: 'appointment:view',

  // Check-In & Walk-In
  CHECKIN_PERFORM: 'checkin:perform',
  WALKIN_CREATE: 'walkin:create',

  // Queue
  QUEUE_VIEW: 'queue:view',
  QUEUE_OVERRIDE: 'queue:override',
  QUEUE_RECOMPUTE: 'queue:recompute',
  QUEUE_ABANDON: 'queue:abandon', // CR-2026-018 (P3) — mark visit no-show/abandoned

  // Service Orders (Phase 2)
  SERVICE_ORDER_CREATE: 'service_order:create',
  SERVICE_ORDER_UPDATE: 'service_order:update',
  SERVICE_ORDER_ASSIGN: 'service_order:assign',
  SERVICE_ORDER_STATUS: 'service_order:status',
  // CR-2026-084 — read-only view of service orders. The two GET endpoints used to
  // be gated on SERVICE_ORDER_CREATE, which technicians do not hold, so their own
  // job's order 403'd and the Pause / Resume / Ready-for-QC controls never rendered.
  SERVICE_ORDER_VIEW: 'service_order:view',

  // Config
  CONFIG_VIEW: 'config:view',
  CONFIG_EDIT: 'config:edit',

  // Audit
  AUDIT_VIEW: 'audit:view',

  // Reports
  REPORT_VIEW: 'report:view',

  // Users
  USER_MANAGE: 'user:manage',

  // Parts & Logistics (Phase 3)
  PARTS_MANAGE: 'parts:manage',

  // Maintenance (Phase 2+)
  MAINTENANCE_VIEW: 'maintenance:view',
  MAINTENANCE_OVERRIDE: 'maintenance:override',
  PRIOR_SERVICE_ENTRY: 'prior_service:entry',

  // Transport (Phase 4)
  TRANSPORT_MANAGE: 'transport:manage',

  // Staff Management (Manager Control Center)
  STAFF_VIEW: 'staff:view',
  STAFF_CREATE: 'staff:create',
  STAFF_UPDATE: 'staff:update',
  STAFF_DEACTIVATE: 'staff:deactivate',
  STAFF_DELETE: 'staff:delete',

  // Technician Profile Management
  TECHNICIAN_MANAGE: 'technician:manage',

  // Availability Management
  AVAILABILITY_MANAGE: 'availability:manage',

  // Service Catalogue Management
  SERVICE_TYPE_MANAGE: 'service_type:manage',

  // Resource/Bay Management
  RESOURCE_MANAGE: 'resource:manage',
  // CR-2026-065 — narrow operational up/down toggle (dispatch floor action), separate
  // from full RESOURCE_MANAGE/CONFIG_EDIT so Service Advisors can mark a bay down.
  RESOURCE_OPERATIONAL_TOGGLE: 'resource:operational_toggle',

  // Complaints (CR-2026-032)
  COMPLAINT_CREATE: 'complaint:create',
  COMPLAINT_VIEW: 'complaint:view',
  COMPLAINT_MANAGE: 'complaint:manage',
  COMPLAINT_RESOLVE: 'complaint:resolve',

  // Customer Notifications (CR-2026-096) — composing/sending SMS & email to
  // customers. Template management stays behind CONFIG_VIEW/CONFIG_EDIT.
  NOTIFY_SEND: 'notify:send',

  // CR-2026-108 — reading the FULL content of notifications captured during UAT:
  // subject, body and the recipient address they would have gone to. That is
  // customer-message content, not configuration, so it gets its own boundary
  // rather than riding on CONFIG_VIEW — which is only Manager-level today, but
  // would silently widen this if it were ever granted to advisors.
  NOTIFY_CAPTURED_VIEW: 'notify:captured_view',

  // CR-2026-113 — sending OPTIONAL outreach to a customer who has not opted in.
  // Deliberately its own boundary, and deliberately NOT granted to the service
  // advisor: overriding a recorded preference is an exceptional act, and an
  // exception available on the routine path stops being one. Operational email
  // (confirmations, authorisation requests, ready for collection) needs nothing
  // beyond NOTIFY_SEND, so this never stands between the front desk and its work.
  NOTIFY_CONSENT_OVERRIDE: 'notify:consent_override',

  // CR-2026-108 — the Admin Booking Simulator: reading the internal availability
  // decision (capacity numbers, rule values, later resource facts) and minting UAT
  // booking sessions. Diagnostic and privileged, so it is its own boundary.
  BOOKING_SIMULATE: 'booking:simulate',

  // Visual Inspections (CR-2026-034)
  INSPECTION_VIEW: 'inspection:view',
  INSPECTION_CREATE: 'inspection:create',
  INSPECTION_EDIT: 'inspection:edit',
  INSPECTION_SIGNOFF: 'inspection:signoff', // senior-tech sign-off (ADMIN/MANAGER in v1)
  INSPECTION_DECISION: 'inspection:decision', // record customer decisions + customer sign-off
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const FRONT_DESK_PERMISSIONS: PermissionKey[] = [
  PERMISSIONS.CUSTOMER_SEARCH,
  PERMISSIONS.CUSTOMER_CREATE,
  PERMISSIONS.CUSTOMER_UPDATE,
  PERMISSIONS.VEHICLE_CREATE,
  PERMISSIONS.VEHICLE_UPDATE,
  PERMISSIONS.APPOINTMENT_VIEW,
  PERMISSIONS.APPOINTMENT_CONFIRM,
  PERMISSIONS.CHECKIN_PERFORM,
  PERMISSIONS.WALKIN_CREATE,
  PERMISSIONS.QUEUE_VIEW,
  // Front desk owns no-show/abandon handling; inherited by SERVICE_ADVISOR + MANAGER.
  PERMISSIONS.QUEUE_ABANDON,
  PERMISSIONS.MAINTENANCE_VIEW,
  // Complaints: front desk + advisor + manager can log and view (CR-2026-032)
  PERMISSIONS.COMPLAINT_CREATE,
  PERMISSIONS.COMPLAINT_VIEW,
  // Inspections: front desk can view + record customer decisions/sign-off (CR-2026-034)
  PERMISSIONS.INSPECTION_VIEW,
  PERMISSIONS.INSPECTION_DECISION,
  // CR-2026-096 — front desk sends due-service reminders, queue updates, and
  // pickup notices (with message editing) through the shared composer.
  PERMISSIONS.NOTIFY_SEND,
];

const SERVICE_ADVISOR_PERMISSIONS: PermissionKey[] = [
  ...FRONT_DESK_PERMISSIONS,
  PERMISSIONS.APPOINTMENT_CREATE,
  PERMISSIONS.APPOINTMENT_UPDATE,
  PERMISSIONS.APPOINTMENT_CANCEL,
  PERMISSIONS.SERVICE_ORDER_VIEW,
  PERMISSIONS.SERVICE_ORDER_CREATE,
  PERMISSIONS.SERVICE_ORDER_UPDATE,
  PERMISSIONS.SERVICE_ORDER_ASSIGN,
  PERMISSIONS.SERVICE_ORDER_STATUS,
  PERMISSIONS.MAINTENANCE_OVERRIDE,
  PERMISSIONS.PRIOR_SERVICE_ENTRY,
  PERMISSIONS.PARTS_MANAGE,
  PERMISSIONS.TRANSPORT_MANAGE,
  // CR-2026-065 — advisors run dispatch and can mark a resource down/up.
  PERMISSIONS.RESOURCE_OPERATIONAL_TOGGLE,
  // Inspections: advisors perform/fill inspections (CR-2026-034)
  PERMISSIONS.INSPECTION_CREATE,
  PERMISSIONS.INSPECTION_EDIT,
];

const TECHNICIAN_PERMISSIONS: PermissionKey[] = [
  PERMISSIONS.QUEUE_VIEW,
  // CR-2026-084 — a technician must be able to READ the order they are working on;
  // without this their own job 403'd and they could start work but never finish it.
  PERMISSIONS.SERVICE_ORDER_VIEW,
  PERMISSIONS.SERVICE_ORDER_STATUS,
  // Inspections: technicians perform/fill inspections (CR-2026-034)
  PERMISSIONS.INSPECTION_VIEW,
  PERMISSIONS.INSPECTION_CREATE,
  PERMISSIONS.INSPECTION_EDIT,
];

/**
 * CR-2026-048 — consolidated role model. Four roles only:
 *  - ADMIN          → full system access; shown in the UI as "Manager".
 *  - SERVICE_ADVISOR→ front office (absorbs the former Front Desk); shown as "Service Advisor".
 *  - TECHNICIAN     → workshop.
 *  - CUSTOMER       → non-staff (status pages only; not assignable to staff).
 * Removed: MANAGER (folded into ADMIN), FRONT_DESK (folded into SERVICE_ADVISOR),
 * PARTS_STAFF, TRANSPORT_COORDINATOR. Parts/transport remain SYSTEM functions —
 * SERVICE_ADVISOR keeps PARTS_MANAGE + TRANSPORT_MANAGE; ADMIN has everything.
 */
export const ROLE_PERMISSIONS: Record<string, PermissionKey[]> = {
  CUSTOMER: [],
  SERVICE_ADVISOR: SERVICE_ADVISOR_PERMISSIONS,
  TECHNICIAN: TECHNICIAN_PERMISSIONS,
  ADMIN: Object.values(PERMISSIONS),
};

/** Staff-assignable role codes (CUSTOMER is excluded — it is not a staff role). */
export const STAFF_ROLE_CODES = ['ADMIN', 'SERVICE_ADVISOR', 'TECHNICIAN'] as const;
export type StaffRoleCode = (typeof STAFF_ROLE_CODES)[number];

/** Display labels for role codes (single source of truth for the UI/API). */
export const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Manager',
  SERVICE_ADVISOR: 'Service Advisor',
  TECHNICIAN: 'Technician',
  CUSTOMER: 'Customer',
};
