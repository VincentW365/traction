/**
 * CR-2026-096 — factory wording for customer notification templates.
 * CR-2026-112 — email only, and every customer-facing email now lives here.
 *
 * These are the SEED values only. The live wording lives in the
 * `notification_templates` table and is edited by managers under
 * Setup → Notifications — no code change, no redeploy. Seeding is
 * create-if-missing: an admin's edited wording is NEVER overwritten by a
 * redeploy (same operational-configurability principle as Resources & Bays).
 *
 * The APPOINTMENT_* templates were rendered in application code before
 * CR-2026-112 (`email-templates.ts`). They are seeded here with that exact
 * wording, so moving them into the template store changed what a manager can
 * edit, not what a customer receives. The code renderer remains as the fallback
 * for a deployment whose table has not been seeded yet.
 *
 * `{{vehicleDescription}}` is the composed "2020 Toyota Corolla" string built
 * server-side with clean fallbacks (make/model only → "Toyota Corolla"; nothing
 * known → "vehicle 1234 AB"), so a missing year can never render broken text.
 * A labelled line whose only value is missing ("Vehicle: {{vehicleDescription}}")
 * is dropped whole by the renderer — never sent as a bare "Vehicle:".
 *
 * The keys keep their `_EMAIL` suffix from CR-2026-096 so a deployment that has
 * already been seeded keeps every manager edit. Legacy `_SMS` rows are left in
 * the table (history stays readable) but are never listed, rendered or sent.
 */

export type NotificationReasonCode =
  | 'SERVICE_DUE'
  | 'CUSTOMER_ACTION_REQUIRED'
  | 'QUEUE_CHECKED_IN'
  | 'QUEUE_WORK_STARTED'
  | 'QUEUE_UPDATE'
  | 'PICKUP_READY'
  | 'APPOINTMENT_CONFIRMATION'
  | 'APPOINTMENT_CHANGED'
  | 'APPOINTMENT_CANCELLED'
  | 'APPOINTMENT_REMINDER'
  | 'CUSTOM';

export interface DefaultTemplate {
  key: string;
  reason: NotificationReasonCode;
  /** CR-2026-112 — EMAIL is the only channel this release sends on. */
  channel: 'EMAIL';
  name: string;
  subject: string;
  body: string;
}

export const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  // --- Vehicle due for service -------------------------------------------------
  {
    key: 'SERVICE_DUE_EMAIL',
    reason: 'SERVICE_DUE',
    channel: 'EMAIL',
    name: 'Service due reminder',
    subject: 'Service Reminder — {{registrationNumber}}',
    body: `Hi {{customerFirstName}},

This is a reminder from Bert's Service Centre that your {{vehicleDescription}}, registration {{registrationNumber}}, is due for servicing.

{{serviceDueDetails}}

Please contact us or schedule your next service at your convenience.

Thank you,
Bert's Service Centre`,
  },

  // --- Customer action required ------------------------------------------------
  // CR-2026-112. {{actionRequired}} is deliberately empty: the advisor writes what
  // the customer must decide, in customer-facing words. Internal causes (technician
  // availability, KPI state, resource shortages) are never auto-disclosed.
  {
    key: 'CUSTOMER_ACTION_REQUIRED_EMAIL',
    reason: 'CUSTOMER_ACTION_REQUIRED',
    channel: 'EMAIL',
    name: 'Customer action required',
    subject: 'We need your go-ahead — {{registrationNumber}}',
    body: `Hi {{customerFirstName}},

We need a decision from you before we can continue working on your {{vehicleDescription}}, registration {{registrationNumber}}.

{{actionRequired}}

Needed by: {{actionNeededBy}}

Please reply to this email or call us and we will get straight back to work.

Thank you,
Bert's Service Centre`,
  },

  // --- Queue: checked in -------------------------------------------------------
  {
    key: 'QUEUE_CHECKED_IN_EMAIL',
    reason: 'QUEUE_CHECKED_IN',
    channel: 'EMAIL',
    name: 'Checked in',
    subject: 'Vehicle Checked In — {{registrationNumber}}',
    body: `Hi {{customerFirstName}},

Your {{vehicleDescription}}, registration {{registrationNumber}}, has been checked in at Bert's Service Centre. Your ticket is {{ticketDisplayNumber}}.

We will keep you updated on its progress.

Thank you,
Bert's Service Centre`,
  },

  // --- Queue: work started -----------------------------------------------------
  {
    key: 'QUEUE_WORK_STARTED_EMAIL',
    reason: 'QUEUE_WORK_STARTED',
    channel: 'EMAIL',
    name: 'Work started',
    subject: 'Work Started — {{registrationNumber}}',
    body: `Hi {{customerFirstName}},

Work has started on your {{vehicleDescription}}, registration {{registrationNumber}}.

We will notify you when there is another important update.

Thank you,
Bert's Service Centre`,
  },

  // --- Queue: delay / update ---------------------------------------------------
  // {{staffEditableUpdate}} is deliberately empty by default: the staff member must
  // write the customer-facing explanation. Internal causes (technician issues, KPI,
  // resource shortages) are never auto-disclosed.
  {
    key: 'QUEUE_UPDATE_EMAIL',
    reason: 'QUEUE_UPDATE',
    channel: 'EMAIL',
    name: 'Service update / delay',
    subject: 'Service Update — {{registrationNumber}}',
    body: `Hi {{customerFirstName}},

There has been an update to the service of your {{vehicleDescription}}, registration {{registrationNumber}}.

{{staffEditableUpdate}}

Please contact us if you need further information.

Thank you,
Bert's Service Centre`,
  },

  // --- Vehicle ready for collection --------------------------------------------
  // Reason code PICKUP_READY is retained (CR-2026-096 history); the label is
  // "Vehicle Ready for Collection" everywhere a person reads it.
  {
    key: 'PICKUP_READY_EMAIL',
    reason: 'PICKUP_READY',
    channel: 'EMAIL',
    name: 'Vehicle ready for collection',
    subject: 'Your Vehicle Is Ready for Collection — {{registrationNumber}}',
    body: `Hi {{customerFirstName}},

Your {{vehicleDescription}}, registration {{registrationNumber}}, is ready for collection at Bert's Service Centre.

{{pickupDetails}}

Thank you,
Bert's Service Centre`,
  },

  // --- Appointments -------------------------------------------------------------
  // CR-2026-112 — seeded with the wording these emails already went out with, so
  // the move from code to template store is invisible to customers.
  {
    key: 'APPOINTMENT_CONFIRMATION_EMAIL',
    reason: 'APPOINTMENT_CONFIRMATION',
    channel: 'EMAIL',
    name: 'Appointment confirmation',
    subject: 'Appointment confirmed — {{appointmentReference}}',
    body: `Hi {{customerFirstName}},

Your appointment at {{siteName}} is confirmed.

Reference: {{appointmentReference}}
When: {{appointmentWhen}}
Vehicle: {{vehicleDescription}}
Planned time: about {{appointmentDuration}} minutes
Service: {{appointmentServices}}

{{appointmentInstructions}}

View, move or cancel: {{manageUrl}}

{{siteName}}`,
  },
  {
    key: 'APPOINTMENT_CHANGED_EMAIL',
    reason: 'APPOINTMENT_CHANGED',
    channel: 'EMAIL',
    name: 'Appointment changed',
    subject: 'Appointment moved — {{appointmentReference}}',
    body: `Hi {{customerFirstName}},

Your appointment at {{siteName}} has been moved.

Reference: {{appointmentReference}}
When: {{appointmentWhen}}
Vehicle: {{vehicleDescription}}
Planned time: about {{appointmentDuration}} minutes
Service: {{appointmentServices}}

{{appointmentInstructions}}

View, move or cancel: {{manageUrl}}

{{siteName}}`,
  },
  {
    key: 'APPOINTMENT_CANCELLED_EMAIL',
    reason: 'APPOINTMENT_CANCELLED',
    channel: 'EMAIL',
    name: 'Appointment cancelled',
    subject: 'Appointment cancelled — {{appointmentReference}}',
    body: `Hi {{customerFirstName}},

Your appointment at {{siteName}} has been cancelled.

Reference: {{appointmentReference}}
When: {{appointmentWhen}}
Vehicle: {{vehicleDescription}}

You can book again at any time.

{{siteName}}`,
  },
  {
    key: 'APPOINTMENT_REMINDER_EMAIL',
    reason: 'APPOINTMENT_REMINDER',
    channel: 'EMAIL',
    name: 'Appointment reminder',
    subject: 'Reminder: your appointment at {{siteName}}',
    body: `Hi {{customerFirstName}},

This is a reminder of your appointment at {{siteName}}.

Reference: {{appointmentReference}}
When: {{appointmentWhen}}
Vehicle: {{vehicleDescription}}
Service: {{appointmentServices}}

{{appointmentInstructions}}

If you need to change it, please contact us.

{{siteName}}`,
  },

  // --- Custom message ----------------------------------------------------------
  // Empty body: staff write the whole message. Kept as a template so custom sends
  // still flow through the same versioning, audit, and history machinery.
  {
    key: 'CUSTOM_EMAIL',
    reason: 'CUSTOM',
    channel: 'EMAIL',
    name: 'Custom message',
    subject: "Message from Bert's Service Centre",
    body: '',
  },
];

export const TEMPLATE_KEYS = DEFAULT_TEMPLATES.map((t) => t.key);

/** CR-2026-112 — one template per reason, so a reason always resolves. */
export function defaultTemplateFor(reason: string): DefaultTemplate | undefined {
  return DEFAULT_TEMPLATES.find((t) => t.reason === reason);
}
