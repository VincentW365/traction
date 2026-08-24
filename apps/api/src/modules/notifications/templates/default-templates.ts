/**
 * CR-2026-096 — factory wording for customer notification templates.
 *
 * These are the SEED values only. The live wording lives in the
 * `notification_templates` table and is edited by managers under
 * Administration → Notifications — no code change, no redeploy. Seeding is
 * create-if-missing: an admin's edited wording is NEVER overwritten by a
 * redeploy (same operational-configurability principle as Resources & Bays).
 *
 * `{{vehicleDescription}}` is the composed "2020 Toyota Corolla" string built
 * server-side with clean fallbacks (make/model only → "Toyota Corolla"; nothing
 * known → "vehicle 1234 AB"), so a missing year can never render broken text.
 */

export interface DefaultTemplate {
  key: string;
  reason:
    | 'SERVICE_DUE'
    | 'QUEUE_CHECKED_IN'
    | 'QUEUE_WORK_STARTED'
    | 'QUEUE_UPDATE'
    | 'PICKUP_READY'
    | 'CUSTOM';
  channel: 'SMS' | 'EMAIL';
  name: string;
  subject?: string;
  body: string;
}

export const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  // --- Vehicle due for service -------------------------------------------------
  {
    key: 'SERVICE_DUE_SMS',
    reason: 'SERVICE_DUE',
    channel: 'SMS',
    name: 'Service due reminder (SMS)',
    body: "Hi {{customerFirstName}}, your {{vehicleDescription}} ({{registrationNumber}}) is due for servicing at Bert's Service Centre. Please contact us or book your service at your convenience. Thank you.",
  },
  {
    key: 'SERVICE_DUE_EMAIL',
    reason: 'SERVICE_DUE',
    channel: 'EMAIL',
    name: 'Service due reminder (Email)',
    subject: 'Service Reminder — {{registrationNumber}}',
    body: `Hi {{customerFirstName}},

This is a reminder from Bert's Service Centre that your {{vehicleDescription}}, registration {{registrationNumber}}, is due for servicing.

{{serviceDueDetails}}

Please contact us or schedule your next service at your convenience.

Thank you,
Bert's Service Centre`,
  },

  // --- Queue: checked in -------------------------------------------------------
  {
    key: 'QUEUE_CHECKED_IN_SMS',
    reason: 'QUEUE_CHECKED_IN',
    channel: 'SMS',
    name: 'Checked in (SMS)',
    body: "Hi {{customerFirstName}}, your {{vehicleDescription}} ({{registrationNumber}}) has been checked in at Bert's Service Centre. Your ticket is {{ticketDisplayNumber}}. We will keep you updated on its progress.",
  },
  {
    key: 'QUEUE_CHECKED_IN_EMAIL',
    reason: 'QUEUE_CHECKED_IN',
    channel: 'EMAIL',
    name: 'Checked in (Email)',
    subject: 'Vehicle Checked In — {{registrationNumber}}',
    body: `Hi {{customerFirstName}},

Your {{vehicleDescription}}, registration {{registrationNumber}}, has been checked in at Bert's Service Centre. Your ticket is {{ticketDisplayNumber}}.

We will keep you updated on its progress.

Thank you,
Bert's Service Centre`,
  },

  // --- Queue: work started -----------------------------------------------------
  {
    key: 'QUEUE_WORK_STARTED_SMS',
    reason: 'QUEUE_WORK_STARTED',
    channel: 'SMS',
    name: 'Work started (SMS)',
    body: 'Hi {{customerFirstName}}, work has started on your {{vehicleDescription}} ({{registrationNumber}}). We will notify you when there is another important update.',
  },
  {
    key: 'QUEUE_WORK_STARTED_EMAIL',
    reason: 'QUEUE_WORK_STARTED',
    channel: 'EMAIL',
    name: 'Work started (Email)',
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
    key: 'QUEUE_UPDATE_SMS',
    reason: 'QUEUE_UPDATE',
    channel: 'SMS',
    name: 'Service update / delay (SMS)',
    body: 'Hi {{customerFirstName}}, there has been an update to the service of your {{vehicleDescription}} ({{registrationNumber}}). {{staffEditableUpdate}} Please contact us if you need further information.',
  },
  {
    key: 'QUEUE_UPDATE_EMAIL',
    reason: 'QUEUE_UPDATE',
    channel: 'EMAIL',
    name: 'Service update / delay (Email)',
    subject: 'Service Update — {{registrationNumber}}',
    body: `Hi {{customerFirstName}},

There has been an update to the service of your {{vehicleDescription}}, registration {{registrationNumber}}.

{{staffEditableUpdate}}

Please contact us if you need further information.

Thank you,
Bert's Service Centre`,
  },

  // --- Ready for pickup --------------------------------------------------------
  {
    key: 'PICKUP_READY_SMS',
    reason: 'PICKUP_READY',
    channel: 'SMS',
    name: 'Ready for pickup (SMS)',
    body: "Hi {{customerFirstName}}, your {{vehicleDescription}} ({{registrationNumber}}) is ready for pickup at Bert's Service Centre. Please contact us if you need any additional information. Thank you.",
  },
  {
    key: 'PICKUP_READY_EMAIL',
    reason: 'PICKUP_READY',
    channel: 'EMAIL',
    name: 'Ready for pickup (Email)',
    subject: 'Your Vehicle Is Ready for Pickup — {{registrationNumber}}',
    body: `Hi {{customerFirstName}},

Your {{vehicleDescription}}, registration {{registrationNumber}}, is ready for pickup at Bert's Service Centre.

{{pickupDetails}}

Thank you,
Bert's Service Centre`,
  },

  // --- Custom message ----------------------------------------------------------
  // Empty bodies: staff write the whole message. Kept as templates so custom sends
  // still flow through the same versioning, audit, and history machinery.
  {
    key: 'CUSTOM_SMS',
    reason: 'CUSTOM',
    channel: 'SMS',
    name: 'Custom message (SMS)',
    body: '',
  },
  {
    key: 'CUSTOM_EMAIL',
    reason: 'CUSTOM',
    channel: 'EMAIL',
    name: 'Custom message (Email)',
    subject: "Message from Bert's Service Centre",
    body: '',
  },
];

export const TEMPLATE_KEYS = DEFAULT_TEMPLATES.map((t) => t.key);
