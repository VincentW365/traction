# CR-2026-113 — Communication Purpose, Email Data Quality, Collection Wording

**Status:** Implemented
**Date:** 2026-09-21
**Follows:** CR-2026-112 (email-only customer notifications)
**Modules:** notifications (API), customers, data-import, maintenance, appointments, public-booking, web (composer + 10 screens), Prisma schema, seed, settings catalogue, scripts

---

## 1. What this delivers

Four decisions taken after CR-2026-112 went live, in the owner's words: do not
manufacture consent, clean the placeholder email data, say "Collection", and give
WhatsApp back.

| § | Decision | Outcome |
| --- | --- | --- |
| 2 | Do **not** bulk-enable 6,857 imported consent flags | No preference record was altered. Instead, messages carry a **purpose**, and consent applies to the purposes the business configures. |
| 3 | Clean the imported email data | 3,649 placeholder values became NULL, audited; two values a machine must not guess at are named for a person. |
| 4 | "Ready for Collection" | Changed through the manager path (versioned + audited), not by weakening seeding. |
| 5 | Restore WhatsApp sharing | Back as a staff hand-off. Not a notification channel; SMS stays out. |

---

## 2. Consent applies to outreach, not to the service

### The problem this fixes

Every customer email was gated on one flag, `notificationOptInEmail`, which the
import wrote as **false** on 6,857 of 6,901 customers. The consequence was not
"we send less marketing". It was that an advisor had to **override a customer's
recorded preference** to send an appointment confirmation, an authorisation
request, or "your vehicle is ready".

That is the wrong shape twice over. An override used on the routine path is not
an override — it is a keystroke, and the preference it steps over stops meaning
anything to the person clicking past it. Meanwhile the messages a customer
genuinely needs about their own booking were the ones being suppressed.

### The model

`CommunicationPurpose` — **TRANSACTIONAL · REMINDER · MARKETING** — recorded on
every template (configurable per template) and on every sent message.

| Purpose | What it covers | Gated on consent? |
| --- | --- | --- |
| `TRANSACTIONAL` | Confirmation · changed · cancelled · customer action required · checked in · work started · service update · ready for collection · custom | **No** |
| `REMINDER` | Appointment reminder — a prompt about a commitment they made | **No** |
| `MARKETING` | Service-due campaigns · offers · the after-visit thank-you | **Yes** |

**The platform does not encode a legal interpretation.** Which purposes require
consent is the business rule `notification_purposes_requiring_consent`
(factory value `["MARKETING"]`, editable under Settings → Notifications →
Customer consent). A business that decides reminders need consent too changes a
setting, not a deployment. A missing or unreadable value falls back to the
factory policy — never to "email everyone".

### The override, when it is genuinely needed

Sending optional outreach to a customer who has not opted in is now:

- **Restricted by role** — a new permission, `notify:consent_override`, granted
  to **Manager only**. A service advisor is told *"A manager can send it anyway
  if there is a reason to. You can also call the customer and log the call."*
  rather than being handed a button that 403s.
- **Reason-required** — at least 10 characters, entered in the composer.
- **Audited, timestamped, attributed** — `consentOverridden` and
  `consentOverrideReason` on the notification row, plus an AuditLog entry
  carrying the actor and the purpose.

> **Decision to review:** restricting the override to Manager is the strict
> reading of "restricted by role", and it is deliberate — but it does mean an
> advisor working the Due for Contact list cannot send to an opted-out customer
> without a manager. Granting `NOTIFY_CONSENT_OVERRIDE` to
> `SERVICE_ADVISOR_PERMISSIONS` is a one-line change if that proves too tight.

### What this changes in practice, today

With 398 reachable addresses in the base and 0 of them opted in:

- Appointment confirmations, changes, cancellations, reminders, authorisation
  requests and ready-for-collection notices now **go out** — nothing to override.
- Service-due campaigns and the after-visit thank-you still **do not**, which is
  the correct answer until consent is actually recorded.

**No customer preference record was read, written or migrated by this CR.**

---

## 3. Email data quality

`20260921150000_cr_2026_113_clear_placeholder_emails` — idempotent, audited,
verified before and after with `pnpm customers:email-quality`.

| | before | after |
| --- | ---: | ---: |
| customers | 6,902 | **6,902** (unchanged — the migration fails loudly if not) |
| placeholder text stored as an address | 3,649 | **0** |
| real addresses | 398 | **398** (none altered, re-cased or trimmed) |
| no address recorded (NULL) | 2,853 | 6,502 |

Recognised placeholders: `n/a · na · n.a. · none · null · nil · - · -- · .` and
whitespace, compared trimmed and lower-cased. None contains `@`, so the rule can
only ever turn a non-address into NULL. The row count actually changed is written
to `audit_logs` (`CUSTOMER_PLACEHOLDER_EMAILS_CLEARED`, reason `DATA_QUALITY`).

### Two values deliberately left alone

```
BERT-C-1dwftnjyqux48  "driver Jason West"          free text in the email column
BERT-C-2y21d8izvzsqg  "sashan.wisdom99gmail.com"   an address with no "@"
```

Repairing either would be inventing customer data — the second is *probably*
`sashan.wisdom99@gmail.com`, and "probably" is not good enough to write into a
customer record. Both are reported by `pnpm customers:email-quality`, and the
application already treats them as "no valid address" rather than trying to send.

### It cannot happen again

`common/helpers/customer-email.ts` is the one rule, applied at every write
boundary — customer create/update, public booking, and the importer that
introduced the problem:

- trim, lower-case (one customer, not two records)
- blank or placeholder → **NULL** (missing, not an error)
- anything else → validated, or rejected with *"…is not a valid email address.
  Enter a full address such as name@example.com, or leave it blank if the
  customer has not given one."*
- `undefined` stays `undefined`, so a partial update never blanks an address it
  was not given
- the bulk importer **reports** a malformed address instead of aborting a
  9,000-row run

---

## 4. "Ready for Collection"

Changed through `pnpm notifications:collection-wording --commit` — the same table,
version bump and audit entry a manager's edit produces — **not** by changing
seeding. Create-if-missing is what protects manager wording from deployments, and
it stays exactly as it was.

Verified end to end: template subject ✓ body ✓ name ✓ composer draft ✓ the
automatic ready-for-collection flow ✓ Communication History label ✓ queue board ✓
reports ✓ lobby display ✓ schedule rail ✓.

Stored identifiers (`PICKUP_READY`, `readyForPickup`, `/queue/pickup`) are
untouched: renaming a value history already refers to, to change a label, would
rewrite the past.

> **A bug this CR caught in its own tooling.** The first version of the wording
> script replaced the word everywhere, including inside `{{pickupDetails}}` —
> producing `{{collectionDetails}}`, which is not on the placeholder allow-list.
> No customer would have seen it (the renderer drops unfillable tokens), but a
> manager saving that template would have been blocked by validation. The script
> now leaves `{{…}}` tokens strictly alone, the affected row was repaired with
> its own audit entry (`PLACEHOLDER_REPAIR`), and the script is idempotent.

---

## 5. WhatsApp booking-link sharing

Restored on **Send booking link**, and framed for what it is: a link the staff
member opens on their **own device**, with the message ready to send to a
customer who is usually standing in front of them.

It is **not** a notification channel. The platform transmits nothing, records no
delivery, and routes no customer message through it — the API already built the
`wa.me` URL and still does. The screen says so: *"WhatsApp opens on your device —
the system does not send it."*

The SMS deep link stays out: SMS is not part of this release at all.

---

## 6. Data model

`20260921140000_cr_2026_113_communication_purpose` — additive only:

- `CommunicationPurpose` enum
- `notification_templates.purpose` (default `TRANSACTIONAL`; `SERVICE_DUE` set to
  `MARKETING` and `APPOINTMENT_REMINDER` to `REMINDER` by reason, not by key)
- `notification_logs.purpose` (NULL on pre-CR rows — unknown, not assumed)
- `notification_logs.consent_overridden` + `consent_override_reason`

No column is dropped or retyped; no customer record is touched.

---

## 7. Tests

- **api 1,711 passing** — new: `consent-policy.spec.ts` (12: what needs consent,
  the policy as configuration, every reason classified),
  `customer-email.spec.ts` (11: placeholders, normalisation, the import path).
  Updated: the reminder sweep now asserts that an opted-out customer *still* gets
  their reminder; the composer spec asserts the block, the advisor refusal, the
  manager's required reason, and that an operational message needs no override.
- **web 370 passing** — new: `cr-2026-113-surfaces.test.ts` (18), including a
  check that no customer-facing screen shows the word "pickup" in prose while
  leaving stored identifiers alone.
- `audit:operational` 80/80 · `deploy:check` PASS.

---

## 8. Operational notes

- `pnpm customers:email-quality` — read-only; run before/after any import.
- `pnpm notifications:collection-wording [--commit]` — idempotent; dry run first.
- Both are safe against production and change nothing without `--commit`.
- **Production deployment order:** `prisma migrate deploy` (applies both
  migrations, including the audited data cleanup) → `pnpm db:seed` (adds the
  consent-policy rule, create-if-missing) → `pnpm notifications:collection-wording --commit`.
