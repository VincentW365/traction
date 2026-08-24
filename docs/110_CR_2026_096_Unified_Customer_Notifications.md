# CR-2026-096 — Unified Customer SMS/Email Notifications

**Status:** Implemented (local commits only)
**Date:** 2026-08-24
**Modules:** notifications (API), maintenance (API), web (composer + 6 screens), Prisma schema, seed, deploy-check

---

## 1. What this delivers

One notification pipeline for every staff-initiated customer message:

**Generate → Review → Edit → Preview → Send → Track**

Three scenarios share it end to end:

1. **Vehicle Due for Service** — from the Due for Contact list (Management).
2. **Queue / Service Progress** — from any live queue ticket (Checked In / Work Started / Service Update / Custom).
3. **Vehicle Ready for Pickup** — from the visit's ready-for-collection state (replaces the old hard-coded pickup buttons).

Plus **Contact Customer** from the customer profile and vehicle profile (custom message).

There is exactly one composer (`CustomerNotificationComposer`), one template store
(`notification_templates`), one delivery log (`notification_logs`), one audit trail,
and one provider abstraction. Nothing pickup-specific was rebuilt — the existing
provider layer (stub/Twilio behind `NotificationProvider`) was extended, not replaced.

## 2. Architecture

```
NotificationEvent (staff action or future automation)
        │
   compose(reason, customer, vehicle, visit, recommendation)
        │   ← NotificationTemplate (admin-editable, versioned)
        │   ← template-engine.ts (allow-listed {{placeholders}}, clean fallbacks)
        ▼
   Composer UI (edit recipient/body/subject, preview, segments)
        │
   send(channels, finalText, clientRequestId)
        │   → validation (phone/email, unresolved placeholders, opt-out, duplicates)
        │   → test routing (NOTIFICATION_MODE)
        │   → NotificationProvider.send({body, subject})   ← Twilio / stub
        │   → NotificationLog (exact text sent + generated text + routing truth)
        │   → AuditLog
        ▼
   History (customer / vehicle / visit) · contact status (service-due workflow)
```

Frontend screens never know the provider. They see only capability flags from
`GET /notifications/capabilities`: `{ smsConfigured, emailConfigured, mode, testRoutingActive }`.

## 3. Data model (migration `20260824170000_cr_2026_096_unified_customer_notifications`)

- **`notification_templates`** — key (unique), reason, channel, name, subject, body,
  enabled, version, updatedBy. Version increments on every wording change.
- **`notification_logs`** additions — `reason`, `subject`, `body` (final text as sent),
  `generated_body` (template output before staff edits), `intended_recipient` +
  `test_routed` (test-mode redirect truth, never concealed), `simulated` (no real
  provider — recorded, not delivered), `customer_id`, `vehicle_id`, `client_request_id`
  (unique; double-click idempotency).
- **`maintenance_recommendations`** additions — `contact_status`
  (NOT_CONTACTED / CONTACTED / BOOKED / DEFERRED / DO_NOT_CONTACT),
  `last_contacted_at`, `last_contact_log_id`.

Delivery status (SENT / DELIVERED / FAILED …) and business outcome (CONTACTED /
BOOKED …) are **separate truths**: a message can be SENT while the follow-up stays
CONTACTED until the customer books. `CONTACT_DUE` is derived (row appears in the due
list), not stored.

## 4. Templates

Editable at **Setup → Notifications** (Manager only; `CONFIG_EDIT`). Seeded
create-if-missing — a manager's edited wording survives reseeds and redeploys.
The API also self-heals a missing template from factory wording at compose time,
so a fresh deploy can never present an empty composer.

Keys: `SERVICE_DUE_SMS/EMAIL`, `QUEUE_CHECKED_IN_SMS/EMAIL`,
`QUEUE_WORK_STARTED_SMS/EMAIL`, `QUEUE_UPDATE_SMS/EMAIL`, `PICKUP_READY_SMS/EMAIL`,
`CUSTOM_SMS/EMAIL`.

Placeholders are **allow-listed** (`template-engine.ts`); a template edit containing
an unknown `{{token}}` is rejected. A placeholder with no value renders away cleanly
(no `null null`, no `{{vehicleYear}}` leaking, no doubled spaces); a **final** message
still containing `{{…}}` blocks sending with the missing fields named.
`{{vehicleDescription}}` is the composed "2020 Honda Grace" string with fallbacks
("Honda Grace" → "vehicle 1234 AB" → "vehicle").

Historical messages are immutable: each log row stores the exact final text and the
template version used; editing a template affects only future sends.

## 5. Test routing (`NOTIFICATION_MODE`)

- **TEST (default)** — every customer send is redirected to
  `NOTIFICATION_TEST_SMS_TO` / `NOTIFICATION_TEST_EMAIL_TO`. The composer shows
  "TEST MODE — Customer will not receive this message." The log keeps BOTH intended
  and actual recipient. A **real** provider in TEST mode with **no** test recipient
  refuses to send (background flows record FAILED with the reason).
- **LIVE** — explicit deployment change; sends reach real customers.
- **Stub provider** (no SMS/email provider configured) — sends are recorded with
  `simulated: true` and shown as "not delivered" in history; the composer shows a
  "Messaging is unavailable" banner. The app stays fully usable.

Test routing applies to **every** send path, including the legacy cron flows
(appointment reminders, midday follow-up, delay alerts).

## 6. Guard rails

- **Send-to override ≠ master-data edit.** Changing a number/email in the composer
  affects that message only; "Update customer record" is a separate, permissioned,
  audited action (`PATCH /customers/:id`).
- **Opt-out** is displayed and never silently overridden — sending anyway requires an
  explicit staff confirmation, which is audited (`optOutOverridden`).
- **Duplicate pickup**: a second PICKUP_READY send returns a structured 409 with the
  prior send's channel/time; the composer shows "already sent … Send another?" and
  resend requires the explicit tick. Never fully blocked.
- **Double-click**: the composer generates a `clientRequestId` per opening; the unique
  column makes the second submit a no-op.
- **Rate limit**: 20 sends/user/minute at the service layer.
- **Provider truth**: provider acceptance → `SENT` (never shown as Delivered);
  provider failure/exception → `FAILED` with reason; retry (`POST /notifications/retry/:id`)
  is allowed only for FAILED and creates a new audited attempt.
- **No KPI/internal leakage**: queue templates contain zero internal state; the
  delay/update template's `{{staffEditableUpdate}}` is deliberately empty so staff must
  write the customer-facing wording themselves.
- Phone normalization: E.164 for Jamaica (+1876/+1658 shapes, 7/10/11-digit inputs);
  arbitrary strings are rejected, never blindly "+1"-prefixed. Email validated server-side.

## 7. Permissions

| Action | Permission | Roles |
| --- | --- | --- |
| Compose/send/manual-contact/retry | `notify:send` (new) | Service Advisor, Manager |
| View history | `queue:view` | all staff |
| List templates | `config:view` | Manager |
| Edit templates / enable-disable | `config:edit` | Manager |
| Update customer contact info | `customer:update` | Service Advisor, Manager |
| Set service-due contact status | `maintenance:override` | Service Advisor, Manager |

## 8. Endpoints

- `GET  /notifications/capabilities`
- `POST /notifications/compose`
- `POST /notifications/send`
- `POST /notifications/manual-contact` (PHONE_CALL / IN_PERSON / OTHER+note)
- `GET  /notifications/history?customerId|vehicleId|serviceVisitId`
- `GET  /notifications/record/:id`
- `POST /notifications/retry/:id`
- `GET/PUT /notifications/templates[/:key]`
- `PATCH /maintenance/recommendations/:id/contact-status`
- Legacy `POST /notifications/send-pickup-ready` remains operational (compat).

## 9. Future automation boundary

The pipeline is event-shaped (`reason → template → recipient → channel → send`), so
future automatic messages (appointment confirmed, checked in, work started, completed)
only need a caller — no UI/provider rework. Nothing is auto-enabled by this CR: staff
stay in control of every customer-facing message.

## 10. Operational notes

- `.env.example` documents `NOTIFICATION_MODE`, `NOTIFICATION_TEST_SMS_TO`,
  `NOTIFICATION_TEST_EMAIL_TO`.
- `deploy:check` verifies the notification templates exist (warn text names the fix);
  seeding is create-if-missing in `prisma/seed.ts`.
- Email currently has **no real provider** (stub only) — email sends are recorded as
  simulated until a SendGrid/SMTP CR lands; the UI says so honestly.
