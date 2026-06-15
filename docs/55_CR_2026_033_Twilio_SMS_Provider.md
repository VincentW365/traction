# CR-2026-033 — Twilio SMS provider (Change Request)

**Status:** PLAN / Change Request — **for approval. NOT implemented** (no dependency added, no code yet).
**Type:** Change Request — **new third-party dependency** (`twilio`) in a core flow (CLAUDE.md §9). No schema change. Vendor pre-decided by CLAUDE.md (Twilio for SMS) → no ADR needed.
**Author:** Vincent Wilson · **Drafted:** 2026-06-14
**Approval gate:** §9 — surfaced before `pnpm add twilio` is run. Twilio is isolated behind the existing `NotificationProvider` adapter (CLAUDE.md §3: "no direct domain coupling to vendor SDKs").

> Phase A / CR-E (final quick win). On approval: add dep → implement provider + factory + env + templates + tests → verify → pause before commit.

---

## 1. Problem / Context
SMS today runs through a clean adapter (`NotificationProvider.send()`) but the **only implementation is `StubNotificationProvider`** (logs, never sends). Stakeholders mandated **Twilio** for SMS. This CR adds a real `TwilioNotificationProvider` behind the existing interface and lets ops select it via `NOTIFICATION_PROVIDER=twilio` (already an allowed enum value; default stays `stub`).

## 2. Key design finding (shapes scope)
`NotificationsService.processNotification` passes **`templateKey` + `templateData`** to `provider.send()` — **the provider renders the message body** (the stub never did). So the Twilio provider must turn each existing `templateKey` into an SMS body. Existing keys: `appointment_confirmation`, `appointment_reminder_24h`, `appointment_reminder_2h`, `service_delay_alert`, `ready_for_pickup`, `pickup_ready`, `midday_followup` (this one already passes a pre-rendered `templateData.message`). → CR-E includes a **small SMS template renderer**.

## 3. Scope
**In:** `twilio` dependency; `TwilioNotificationProvider` (SMS send + result mapping + E.164 normalization); an SMS template renderer for the keys above (+ generic fallback using `templateData.message`); env vars; a provider-selection **factory** (`stub` default | `twilio`); unit tests with a mocked Twilio client. **Stub remains the default** (dev/test/CI unchanged).

**Out / deferred:** EMAIL stays on the stub/log path (Twilio is SMS-only; real email = a future SendGrid CR). No BullMQ/queue change (still immediate send per existing service). No new outbound triggers — this only makes the *existing* SMS calls actually send. (Complaint notifications from CR-D remain deferred; they can be turned on later now that real SMS exists.)

## 4. Design
**Dependency:** `twilio` (npm), imported **only** inside `twilio.provider.ts`.

**Env** (`packages/config/src/env.ts`) — additive, optional (validated at provider construction when `NOTIFICATION_PROVIDER=twilio`):
- `TWILIO_ACCOUNT_SID?: string`
- `TWILIO_AUTH_TOKEN?: string`
- `TWILIO_FROM_NUMBER?: string` **or** `TWILIO_MESSAGING_SERVICE_SID?: string` (one required for live send)
- `.env.example` documents them. `NOTIFICATION_PROVIDER` enum already supports `twilio`.

**`apps/api/src/modules/notifications/providers/twilio.provider.ts`** (`implements NotificationProvider`):
- Constructor builds the Twilio client from env; throws a clear config error if `twilio` is selected but creds/from are missing.
- `send(input)`:
  - **SMS:** `body = renderSmsBody(templateKey, templateData)`; `to = toE164Jamaica(recipient)`; `client.messages.create({ to, from|messagingServiceSid, body })`; → `{ success: true, providerReference: msg.sid }`; on throw → `{ success: false, failureReason }` (never throws out; the service logs FAILED).
  - **EMAIL:** delegate to the stub/log path → `{ success: true, providerReference: 'email-stub' }` (documented; real email is a later CR).

**`apps/api/src/modules/notifications/templates/sms-templates.ts`** — pure `renderSmsBody(templateKey, data): string`:
- Explicit, friendly one-line bodies per known key (e.g. `ready_for_pickup` → "Hi {customerName}, your {vehicle} is ready for pickup at {siteName}."), using only non-PII-risky fields already passed.
- Fallback: if `data.message` is a string, use it; else a generic "Update from Bert's Auto Parts Service Centre."

**`toE164Jamaica(raw)`** (pure helper, tested): strip non-digits; `11` digits starting `1` → `+<digits>`; `10` digits → `+1<digits>`; `7` digits → `+1876<digits>`; else best-effort `+<digits>`. (Bert's stores e.g. `876-555-1234`.)

**Wiring** (`notifications.module.ts`): replace `useClass: StubNotificationProvider` with a **`useFactory`** that returns `TwilioNotificationProvider` when `validateEnv().NOTIFICATION_PROVIDER === 'twilio'`, else `StubNotificationProvider`. Both providers are registered; the stub is the default and the EMAIL fallback.

## 5. Files
- `apps/api/package.json` — add `twilio` dependency.
- `packages/config/src/env.ts` + `.env.example` — `TWILIO_*` vars.
- `apps/api/src/modules/notifications/providers/twilio.provider.ts` *(new)*.
- `apps/api/src/modules/notifications/templates/sms-templates.ts` *(new)*.
- `apps/api/src/modules/notifications/notifications.module.ts` — provider-selection factory.
- `apps/api/src/modules/notifications/providers/__tests__/twilio.provider.spec.ts` + `sms-templates.spec.ts` *(new)*.
- `docs/55_CR_2026_033_Twilio_SMS_Provider.md` *(this file)*.

## 6. Rule / Schema impact
**No schema change. No rule-engine change.** Only the SMS delivery mechanism changes, behind the existing adapter. The set of notifications sent is unchanged (this CR makes existing SMS calls real when `twilio` is selected).

## 7. Tests / Verification
- **Unit (mocked Twilio client — no live calls in CI):** SMS success maps `msg.sid` → `providerReference`; failure maps error → `failureReason` (no throw); `toE164Jamaica` cases (`876-555-1234` → `+18765551234`, already-`+1`, 7-digit); `renderSmsBody` for a couple keys + the `message`/generic fallback; EMAIL → stub path; factory returns stub by default and Twilio when env says so (+ missing-creds error).
- **Typecheck** api + web; **stub remains default** so the full suite is unaffected.
- **Live send:** only when you provide test creds and set `NOTIFICATION_PROVIDER=twilio` — exercised manually/off-CI (you said you'd supply credentials when ready).

## 8. Risks
| Risk | Mitigation |
| --- | --- |
| Vendor SDK coupling | Confined to `twilio.provider.ts`; everything else uses the `NotificationProvider` interface. |
| Accidental live sends in dev/CI | Default `NOTIFICATION_PROVIDER=stub`; Twilio only on explicit env opt-in + creds present. |
| Bad phone formats | `toE164Jamaica` normalization + Twilio rejects invalid numbers → mapped to FAILED (logged), never throws. |
| Secrets | Creds live in env only (never committed; `.env.example` placeholders). |
| EMAIL regressions | EMAIL keeps the stub/log path; no behavior change for email. |

## 9. Approval
**Mandatory review (§9 — new third-party dependency).** Additive, behind the adapter, stub-default → low risk. On approval: `pnpm add twilio` → implement → test → **pause before commit**; commit only the named files + annotated tag. No push, no remote. Provide Twilio test credentials whenever you want to exercise a real send.
