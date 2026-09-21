# CR-2026-112 — Customer Email Notifications

**Status:** Implemented
**Date:** 2026-09-21
**Supersedes:** the multi-channel scope of CR-2026-096 (pipeline retained), CR-2026-033 (Twilio SMS provider, removed)
**Modules:** notifications (API), maintenance, appointments, public-booking, health, web (composer + 11 screens), Prisma schema, seed, env, deploy-check

---

## 1. What this delivers

**One communication channel, built properly: customer email.**

Before this CR the platform presented a partially-completed multi-channel system.
Staff chose between SMS and Email on every message; SMS had a real provider
(Twilio) that had never been configured, so the SMS half of the interface offered
a channel the deployment could not use, and a stub quietly reported those sends
as successful. Appointment emails lived in code while everything else lived in
manager-editable templates.

After this CR:

- **Email is the channel.** Every customer-facing screen is an email screen. No
  channel selector, no SMS buttons, no SMS credentials, no SMS warnings.
- **A message that cannot be delivered is never reported as delivered.** A send
  naming any other channel is refused with a reason.
- **Every customer email is manager-editable**, including the four appointment
  messages that used to be wording buried in application code.
- **Two new events** join the pipeline: *Customer Action Required* and the
  appointment set (confirmation / changed / cancelled / reminder).
- SMS stays **documented as a future phase** (§11), not a half-built feature.

## 2. Architecture

```
event (staff action or automatic flow)
        │
   compose(reason, customer, vehicle, visit, recommendation)
        │   ← NotificationTemplateStore  ← notification_templates (editable, versioned)
        │   ← template-engine.ts (allow-listed {{placeholders}}, clean fallbacks)
        ▼
   Composer UI — To / Subject / Message, prefilled, editable, previewed
        │
   send(finalText, clientRequestId)
        │   → validation (address present + well-formed, no unresolved placeholders, opt-out, duplicates)
        │   → test routing (NOTIFICATION_MODE) / test-record capture (CR-2026-108)
        │   → ChannelRouterProvider → SMTP   (anything not EMAIL is REFUSED here)
        │   → NotificationLog (exact text sent + generated text + routing truth)
        │   → AuditLog
        ▼
   History (customer / vehicle / visit) · contact status (service-due workflow)
```

The adapter stays **channel-shaped on purpose**: `channel` is still part of every
send and the router still dispatches on it. Adding SMS later means writing one
provider class and passing it to `ChannelRouterProvider`. Nothing above that line
changes.

## 3. What was removed

| Removed | Why |
| --- | --- |
| `providers/twilio.provider.ts` + its spec | No SMS implementation in this release (directive §12). |
| `templates/sms-templates.ts` + its spec | SMS wording; the appointment text it supplied was inlined into the email fallback renderer. |
| `twilio` npm dependency | A vendor SDK for a channel that no longer exists here. |
| `NOTIFICATION_PROVIDER`, `TWILIO_*`, `NOTIFICATION_TEST_SMS_TO` env vars | Nothing reads them. An unconfigured SMS provider can no longer affect email because there is no SMS provider. |
| `smsConfigured` / `testSmsTo` capability flags | A screen cannot offer, warn about, or mention a channel this release does not have. |
| `smsSegmentInfo`, `isValidMobileNumber`, `toE164Jamaica` | SMS-only helpers. |
| SMS consent toggles (customer profile, check-in, appointment modal, public booking) | One channel, one consent question. |
| SMS/WhatsApp one-tap hand-off links on "Send booking link" | Directive §1/§11; staff copy the message and pass it on themselves. |
| "SMS provider" row on Admin → Deployment | Nothing to report. |

**Deliberately NOT removed:** `NotificationChannel.SMS` / `.WHATSAPP` (historical
rows must stay readable, and a future phase must not need a destructive
migration), `customer.notificationOptInSms` (dormant column, schema default, read
by nothing), and the legacy `*_SMS` template rows (history; never listed, never
editable, never rendered).

## 4. Data model (migration `20260921090000_cr_2026_112_email_only_notifications`)

Additive only — five `NotificationReason` values:
`CUSTOMER_ACTION_REQUIRED`, `APPOINTMENT_CONFIRMATION`, `APPOINTMENT_CHANGED`,
`APPOINTMENT_CANCELLED`, `APPOINTMENT_REMINDER`.

No column is added, dropped or retyped. `PICKUP_READY` is **not** renamed to
`VEHICLE_READY`: the screens now read "Vehicle Ready for Collection", and
renaming a stored value to change a label would rewrite history for nothing.

**On the directive's `CustomerNotification` shape (§6).** The existing
`NotificationLog` already carries every field it asks for, except dedicated
`serviceOrderId` / `appointmentId` columns. Those are *not* added: the log
carries `entityType` + `entityId` (already `Appointment` for booking messages,
`ServiceVisit` for visit messages) plus `customerId` and `vehicleId`. Adding
foreign keys that restate the same truth would duplicate it in two places, which
CLAUDE.md §4 forbids. A service order is reached through its visit.

## 5. Templates

Editable at **Setup → Notifications** (Manager, `CONFIG_EDIT`). Eleven email
templates, one per reason:

`SERVICE_DUE` · `CUSTOMER_ACTION_REQUIRED` · `QUEUE_CHECKED_IN` ·
`QUEUE_WORK_STARTED` · `QUEUE_UPDATE` · `PICKUP_READY` ·
`APPOINTMENT_CONFIRMATION` · `APPOINTMENT_CHANGED` · `APPOINTMENT_CANCELLED` ·
`APPOINTMENT_REMINDER` · `CUSTOM`

The keys keep their `_EMAIL` suffix from CR-2026-096, so a deployment that has
already been seeded keeps every manager edit. The appointment templates are
seeded with **the exact wording those emails already went out with**, so moving
them from code to the template store changed what a manager can edit, not what a
customer receives.

`NotificationTemplateStore` is now the one place wording is resolved from — the
composer and the automatic flows read the same rows. It self-heals a missing
template from factory wording, and returns nothing for a **disabled** template so
that switching a notification off actually switches it off.

New placeholders: `appointmentReference`, `appointmentWhen`,
`appointmentServices`, `appointmentDuration`, `appointmentInstructions`,
`manageUrl`, `actionRequired`, `actionNeededBy`.

**Renderer change:** a *labelled* line whose only value is missing is now dropped
whole. The appointment emails are written as `Vehicle: {{vehicleDescription}}`,
and a customer must never read a bare "Vehicle:". A placeholder inside a sentence
still simply disappears, exactly as before.

## 6. Events

| Event | Reason | Raised from |
| --- | --- | --- |
| Vehicle due for service | `SERVICE_DUE` | Due for Contact list; automatic reminder sweep |
| **Customer action required** | `CUSTOMER_ACTION_REQUIRED` | Visit page — one click on a job held `WAITING_CUSTOMER`, or the message-type picker |
| Checked in / work started / service update | `QUEUE_*` | Visit page |
| Vehicle ready for collection | `PICKUP_READY` | Ready-for-collection panel; visit page |
| **Appointment confirmed / changed / cancelled** | `APPOINTMENT_*` | Public booking + staff appointment changes |
| **Appointment reminder** | `APPOINTMENT_REMINDER` | Hourly sweep (unchanged cadence) |
| Custom | `CUSTOM` | Customer, vehicle and visit pages |

`{{actionRequired}}` and `{{actionNeededBy}}` are deliberately **empty** in the
seeded template: the advisor writes what the customer must decide, in
customer-facing words. No internal cause (technician availability, KPI state,
resource shortage) is ever auto-disclosed — the same rule as `QUEUE_UPDATE`.

## 7. Public booking now requires an email address

The confirmation email carries the booking reference and the link to change or
cancel; with email as the only channel, a booking made without an address leaves
the customer with nothing. `/book` therefore requires an email for a new
customer, and says why: *"We email your confirmation and your link to change or
cancel."*

**Staff-created appointments keep email optional** — the advisor has the customer
in front of them and can read the reference out. Where no address exists, the
screens say so; the audit entry for a staff-made change now records
`customerNotified` from the truth rather than assuming it.

## 8. Missing address handling (§8)

One sentence, one place (`notification-messages.ts` / `lib/notification-copy.ts`):

> No customer email address is recorded. Add or update the customer's email
> address before sending this notification.

- **Composer:** shows it, and — for an advisor or manager — offers an inline
  field to add the address to the customer record on the spot.
- **Ready-for-collection panel:** the action is disabled and labelled "No email
  on file"; calling the customer is still offered and still recorded.
- **API:** returns it on compose (`customer.emailProblem`) and as the 400 on send.
- **Automatic flows:** skip the customer rather than recording a phantom send.

No screen offers SMS as the alternative.

## 9. Delivery honesty (§9) — unchanged and extended

`deliveryDisplayState()` remains the one mapping from a log row to what a person
is told. "Sent" means the provider accepted the message; it is never shown for a
simulated or test-redirected row and never means "delivered".

Extended by this CR:

- A request for a non-email channel returns `FAILED` with the refusal reason and
  **creates no log row** — nothing was attempted.
- `sendPickupReady` reports a missing address as `FAILED` with the operational
  sentence instead of silently returning nothing for that channel.
- A failed legacy SMS row cannot be "retried" by a release with no SMS; the
  refusal says so.
- The maintenance reminder records the provider's verdict for the one channel it
  now has, and stays `SCHEDULED` for retry when the mail server refused.

## 10. Test vs production (§10) — unchanged

`NOTIFICATION_MODE=TEST` (the default) redirects every customer send to
`NOTIFICATION_TEST_EMAIL_TO` and records both the intended and the actual
recipient. A real mailbox in TEST mode with no test recipient refuses to send.
Per-record capture (CR-2026-108) is untouched: messages about test records are
rendered and recorded in full, never transmitted, and read in the UAT view.
`deploy:check` still fails a production deployment left in TEST.

## 11. SMS as a future phase (not a current feature)

To add SMS later:

1. Write `providers/<vendor>.provider.ts` implementing `NotificationProvider`.
2. Construct it in `notifications.module.ts` and pass it to
   `ChannelRouterProvider(email, sms)` — restore the second constructor argument.
3. Re-add the credential keys to `packages/config/src/env.ts` and a
   `smsConfigured` capability flag.
4. Seed `*_SMS` templates (the enum values, the channel column, the log shape and
   `customer.notificationOptInSms` are all still there).
5. Reintroduce a channel choice in the composer — and only then.

Nothing in this CR has to be undone to do that.

## 12. Permissions — unchanged

Compose/send/manual-contact/retry `notify:send` (Service Advisor, Manager) ·
history `queue:view` · templates `config:view` / `config:edit` (Manager) ·
customer contact details `customer:update` · captured/UAT view
`notify:captured_view`.

## 13. Tests

- `apps/api` — 1685 passing. New: `email-only-notifications.spec.ts` (template
  store, appointment templates, code fallback, disabled template, no-address
  path). Rewritten: `customer-notifications.service.spec.ts` (28 checks incl. the
  SMS refusal and the two missing-address cases), the reminder sweep, the pickup
  outcome, the channel router, the template engine.
- `apps/web` — 352 passing. New: `cr-2026-112-surfaces.test.ts` — fails the build
  if the word "SMS", an SMS consent field, or a channel list comes back to any
  notification screen.
- Superseded assertions in the CR-106 and CR-111 surface tests were updated in
  place, with a note saying why, rather than deleted.

## 14. Operational notes

- `.env.example` documents the email-only set; the Twilio block is gone.
- `deploy:check` now counts **EMAIL** templates (≥ 11) so legacy SMS rows cannot
  satisfy it.
- Seeding stays create-if-missing: manager wording survives redeploys.
- **Owner action for go-live:** none beyond what CR-2026-106 already required —
  `EMAIL_PROVIDER=smtp` with the mailbox credentials, `NOTIFICATION_MODE=LIVE`,
  and one proof send from Admin → Deployment → "Prove outbound email works".
  Any `NOTIFICATION_PROVIDER` / `TWILIO_*` values still set in the Render
  environment are now ignored and can be deleted at leisure.

## 15. Acceptance criteria

| # | Criterion | Where |
| --- | --- | --- |
| 1 | Staff can email an eligible customer from the workflow | Composer on customer / vehicle / visit / due-for-contact / ready panel |
| 2 | Existing email templates and structure are used | `notification_templates`, keys unchanged |
| 3 | Customer and vehicle details populate automatically | `loadContext` → placeholders |
| 4 | Staff can edit permitted content before sending | Subject + body editable; preview step |
| 5 | The attempt and its status are recorded | `NotificationLog` + `AuditLog` |
| 6 | Notification history is visible | Customer, vehicle and visit pages |
| 7 | Missing addresses are handled clearly | §8 |
| 8 | Email works without any SMS configuration | No SMS config exists |
| 9 | No active SMS buttons, selectors or setup remain | `cr-2026-112-surfaces.test.ts` |
| 10 | UAT cannot contact live customers | TEST routing + per-record capture |
| 11 | Production delivery is independently verifiable | Admin → Deployment verify card |
| 12 | Failed emails show a failure state | `displayState` FAILED + reason |
| 13 | Vehicle-ready emails still work | Ready panel + visit page |
| 14 | Due-for-service and customer-contact use the same architecture | One pipeline, one store |
| 15 | The architecture supports SMS later | §11 |

---

## 16. Two things the owner needs to decide (data, not code)

Found while verifying this CR against the live local database (6,901 real
customers). Neither is a defect in this change, and neither was altered here —
both are consent and data decisions that belong to the owner.

**a) Almost no customer can currently be emailed.**

| | customers |
| --- | ---: |
| Total (excluding test data) | 6,901 |
| No email address at all | 2,852 |
| Email recorded as the literal text `N/A` | 3,649 |
| Address containing `@` | 398 |
| …of those, opted in to email | **0** |
| Opted in to email anywhere in the base | 44 (all created in-app; none has an address) |

The import wrote `notificationOptInEmail = false` on essentially every row. The
platform behaves correctly: staff get the opt-out confirmation (audited) and the
automatic flows skip those customers rather than inventing a send. But until the
owner decides how consent is established, **no automatic customer email will go
out to the imported base**, and every staff-initiated one needs an explicit
override. Flipping 6,857 consent flags is a decision, not a migration, so this CR
did not touch them.

The 3,649 `N/A` values are also worth a cleanup pass: they are not addresses, and
they make "has an email" look truer than it is in any report.

**b) The live `PICKUP_READY` template still says "Ready for Pickup".**

Seeding is create-if-missing, so the row written by CR-2026-096 was correctly
left alone — that rule is what protects manager edits. The screens now say
"Vehicle Ready for Collection" while that email still says "pickup". It is a
one-line edit in **Setup → Notifications**, deliberately left to the owner rather
than overwritten by a deployment.

A second migration (`20260921100000_cr_2026_112_template_labels`) did strip the
now-redundant " (Email)" suffix from template LABELS, because the admin UI does
not expose `name` for editing and that text was never a manager’s choice. It
touches `name` only, and only on rows no human has edited.
