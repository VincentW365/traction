# CR-2026-056 — Automatic 24-hour appointment reminders

**Status:** Implemented.
**Requested by:** Vincent Wilson — "24 hours before appointment have the customers be notified of their appointments."
**Trigger decision (owner):** use an in-app cron (`@nestjs/schedule`), not an external scheduler.

## A. Objective
Notify customers ~24 hours before their appointment, automatically, using the existing
notification adapter (SMS via Twilio/stub; email when implemented).

## B. Inputs used
- `notifications.service.ts` — `queue()` adapter, opt-in checks, existing reminder skeleton.
- `templates/sms-templates.ts` — `appointment_reminder_24h` template already present.
- `appointments` model — `scheduledStartAt`, `AppointmentStatus` enum.
- Existing sweep precedent: midday follow-up (`POST /notifications/midday-followup`).

## C. Assumptions
1. No background-job infra existed (BullMQ unwired, `@nestjs/schedule` absent). An **hourly in-app
   cron** running an idempotent sweep is the cleanest mechanism that needs no Redis/external cron.
2. Reminder window/enable are **business rules** (configurable), defaulting to enabled / 24h.
3. Reminders target still-upcoming appointments: `DRAFT`, `CONFIRMED`, `RESCHEDULED` (never
   checked-in/in-progress/completed/missed/cancelled).

## D. Design / change
- **`NotificationsService.sweepAppointmentReminders(now?)`** — finds appointments whose
  `scheduledStartAt` is in `(now, now + reminderHours]`, not already reminded
  (dedup on NotificationLog `templateKey = appointment_reminder_24h`), and queues an SMS and/or
  email per the customer's opt-in. **Sent immediately** (no `scheduledAt`) — the sweep itself is the
  schedule, so the existing "SCHEDULED notifications are never processed" gap is avoided.
- **`NotificationsCronService`** — `@Cron(EVERY_HOUR)` calls the sweep; failures are logged, never
  fatal. Hourly cadence ⇒ a reminder goes out within the hour an appointment crosses the 24h mark.
- **`ScheduleModule.forRoot()`** added to `AppModule` (aliased `NestScheduleModule` — a local
  `ScheduleModule` for the resource schedule already owns that name).
- **Manual trigger**: `POST /notifications/appointment-reminders` (perm `REPORT_VIEW`) runs the same
  idempotent sweep — for testing or a belt-and-braces external cron.
- **Business rules** (seed): `appointment_reminder_enabled` (true), `appointment_reminder_hours` (24).
  Absent rules default to enabled/24h, so existing databases work without reseeding.

## E. Impacted modules / data
- API: `notifications.service.ts`, `notifications-cron.service.ts` (new), `notifications.module.ts`,
  `notifications.controller.ts`, `app.module.ts`; `prisma/seed.ts`. New dep `@nestjs/schedule`.
- No schema change, no migration. Read-only over appointments; writes only NotificationLog rows.

## F. Risks / tradeoffs
- **New dependency** `@nestjs/schedule` (first-party NestJS, no Redis) — see Approval gate.
- Template text says "tomorrow"; if `appointment_reminder_hours` is changed far from 24 the copy is
  slightly off (dedup key stays `appointment_reminder_24h`). Acceptable for the default.
- Email only sends once an email provider is wired (currently stub) — SMS is the live channel.
- The cron is per-process; multi-instance deploys would each sweep, but the NotificationLog dedup
  keeps sends single. (Single-instance today.)

## G. Tests / validation
- `apps/api/.../__tests__/appointment-reminders.service.spec.ts` — sends SMS in-window; sends EMAIL on
  email opt-in; idempotent skip when already reminded; skip when opted out of all channels; no-op when
  `appointment_reminder_enabled` is false. **18 notifications tests pass.**
- `pnpm --filter @bsop/api exec tsc --noEmit` — green.

## H. Approval gate
Adds one **first-party** dependency (`@nestjs/schedule`) to enable a deterministic, idempotent,
config-gated reminder sweep. No schema/RBAC/auth/queue-ranking change. The dependency was explicitly
chosen by the owner over an external cron. Recorded as a Change Request; reversible via git.
