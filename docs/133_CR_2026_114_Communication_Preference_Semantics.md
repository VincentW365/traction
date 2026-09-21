# CR-2026-114 — Preference Semantics, Booking Email Rules, WhatsApp Hand-off

**Status:** Implemented
**Date:** 2026-09-21
**Follows:** CR-2026-112 (email only), CR-2026-113 (communication purpose)
**Modules:** notifications, customers, appointments, walk-ins, public-booking, data-import, web (composer, customer profile, booking, staff wizard), Prisma schema, seed, scripts

---

## 1. What this delivers (items 5–8 + the wording correction)

| § | Item | Outcome |
| --- | --- | --- |
| 2 | Wording correction | An advisor is never told to switch channel to get around a recorded preference — and the message now depends on what is actually recorded. |
| 3 | §6 Preference semantics | `UNKNOWN / ALLOWED / DECLINED` with provenance. 6,857 imported records became **UNKNOWN**, not DECLINED. |
| 4 | §7 Customer profile | Two plain-language rows; no database terminology; a backfilled state carries no invented decision date. |
| 5 | §5 Booking rules | Online booking requires an email, in plainer words. Staff booking does not — and says what will not be sent. |
| 6 | §8 Testing | 61 new checks across API and web, including the enforcement matrix and the placeholder-mutation regression. |

---

## 2. The wording correction

Removed:

> Ask a manager to send it, or record the contact as a phone call instead.

The problem with it was not politeness. It taught staff that a customer's
recorded wishes are an obstacle with a workaround, and the workaround it named
was changing channel.

What the system says now depends on what is actually recorded, because the two
states are not the same thing:

**DECLINED** — the customer's own words:
> This customer has declined optional email outreach. A Manager is required to
> authorize an exception. Otherwise, use an approved customer-contact method in
> accordance with the customer's recorded communication preferences.

**UNKNOWN** — nobody has asked:
> This customer has no recorded preference for optional email — nobody has asked
> them yet, so there is no agreement to rely on. A Manager is required to
> authorize an exception. Otherwise, ask the customer and record their answer, or
> use an approved customer-contact method in accordance with the customer's
> recorded communication preferences.

The second points at the action that actually fixes the situation: ask, and
record the answer.

---

## 3. Preference semantics (§6)

### The problem

`customers.notification_opt_in_email` is a boolean. The question has three
answers. The import wrote **false** on 6,857 of 6,901 customers because no
affirmative answer existed — and every screen then presented that as a decision
the customer had made.

### The model

`CustomerCommunicationPreference` — one row per (customer, channel, purpose):

```
status   UNKNOWN | ALLOWED | DECLINED
source   ONLINE_BOOKING | CUSTOMER_PROFILE | STAFF_CAPTURED | IMPORTED_UNKNOWN | MIGRATED
capturedAt / capturedByUserId / note
```

**No row at all reads as UNKNOWN.** Absence of a record is absence of an answer,
which is precisely what the boolean could not express.

### The backfill, and what it refused to do

| From | To | Rows | Why |
| --- | --- | ---: | --- |
| `false` | **UNKNOWN** (`IMPORTED_UNKNOWN`) | 6,857 | Nothing in this database evidences a refusal. |
| `true` | ALLOWED (`MIGRATED`) | 45 | The permissive value the platform was already acting on. |
| — | DECLINED | **0** | A refusal is only ever recorded, never inferred. |

`capturedAt` is NULL on every backfilled row: we do not know when, or whether,
anyone asked, and a timestamp would claim otherwise. Verified after the
migration: 0 rows carry a capture date, 0 are DECLINED, and the row count equals
the customer count exactly.

### Enforcement is unchanged in effect

UNKNOWN gates marketing exactly as `false` did, so **no customer starts receiving
anything they were not already receiving.** The entire difference is in what
staff are told, and in what a real answer can later overwrite without pretending
to contradict the customer.

### The legacy column

`notification_opt_in_email` is **not** dropped. It is now a documented
**projection** of the EMAIL/MARKETING row, written in the same transaction by
`CommunicationPreferenceService` — the only writer of either. CLAUDE.md §4 allows
a documented projection; it does not allow two independent truths. Dropping the
column would have put a schema migration and a behaviour migration on the same
deploy with no way to roll back one without the other.

---

## 4. Customer profile (§7)

```
Email address
jean@example.com

Email communications
Service & appointment updates                     Available
Optional outreach                            Preference unknown

Nobody has asked this customer yet. It is not a refusal — ask when you next
speak to them.
```

For a customer who actually answered, the second row reads **Allowed** or
**Declined**, and a provenance line appears: *Recorded 21 Sep 2026 by Admin User*.
A backfilled UNKNOWN shows no date, because there is none.

Recording an answer offers all three states in words, not booleans:

- *Allowed — they agreed to reminders and offers*
- *Declined — they asked not to receive them*
- *Not recorded — nobody has asked yet*

Every change is audited with previous state, new state, purpose, source, time,
actor and note (`CUSTOMER_COMMUNICATION_PREFERENCE_UPDATED`). Opening the editor
and saving without changing anything writes nothing: that is not a decision.

---

## 5. Booking rules (§5)

**Online / self-service — email required.** The confirmation is the customer's
receipt: it carries the reference and the only link they have to change or
cancel. The guidance now reads:

> Enter your email address to receive your booking confirmation and appointment updates.

Placeholder text and malformed addresses are refused at the DTO, and could not be
stored as an address even if a caller bypassed it.

**Staff-created — never blocked, never faked.** No placeholder is invented. The
review step states the consequence while the customer is still on the phone:

> Email updates — No email on file, no confirmation or reminder will be sent

The address can be added to the customer record at any time, and the next
message goes out normally.

---

## 6. WhatsApp (§8 verification)

Restored in CR-2026-113 §4, now pinned down by tests: it appears **only** in the
booking-link hand-off, opens on the staff member's own device, requires no
provider configuration, never enters `ChannelRouterProvider`, and creates no
delivery record. Copy-message remains; SMS stays absent.

---

## 7. Tests added (§8)

**API (1,759 passing, 48 new)**

- `communication-preference.spec.ts` (14) — UNKNOWN on no row and on a failed
  lookup; UNKNOWN blocks but reads differently from DECLINED; no capture date for
  UNKNOWN; the projection follows ALLOWED only; an unchanged save writes nothing;
  and the placeholder-mutation regression, including the exact naive replacement
  that shipped in CR-2026-113 and was repaired.
- `purpose-enforcement.spec.ts` (27) — every TRANSACTIONAL reason independently,
  against both UNKNOWN and DECLINED customers; REMINDER under the default policy
  **and** with the policy changed, proving the setting changes enforcement rather
  than only the settings screen; MARKETING blocked, the refusal wording, the
  advisor refusal, the manager's required reason, and the full override record.
- `booking-email-requirement.spec.ts` (7) — valid / missing / placeholder /
  malformed online; staff path has no email requirement to fail.

**Web (384 passing, 18 new)** — `cr-2026-114-surfaces.test.ts`: the booking
asymmetry, the profile's two rows and three options, no database terminology in
anything a person reads, the corrected wording, and a directory-wide sweep
proving WhatsApp appears nowhere but the hand-off.

Superseded assertions in the CR-112 and CR-113 surface tests were updated in
place with the reason, not deleted.

---

## 8. Migrations

| Migration | What |
| --- | --- |
| `…170000_cr_2026_114_communication_preferences` | The table, two enums, and the audited backfill. |
| `…180000_cr_2026_114_preference_alignment` | Drops a DB default Prisma manages, and renames an index Postgres truncated — so `deploy:check` reports no drift. |

The second exists because the first was hand-written: a schema the tooling
disagrees with is a schema nobody can reason about later. Fixed forward rather
than by editing an applied migration, whose checksum other environments have
already recorded.

---

## 9. Final acceptance position

| | |
| --- | --- |
| Automated notification engine | Email ✓ · SMS ✗ · WhatsApp ✗ |
| Booking-link convenience | Copy ✓ · WhatsApp share ✓ · SMS share ✗ |
| Communication purposes | Transactional ✓ · Reminder ✓ · Marketing ✓ · configurable by purpose ✓ |
| Overrides | Manager-only ✓ · reason required ✓ · fully audited ✓ |
| Preference semantics | Unknown ≠ declined ✓ · allowance and refusal distinguishable ✓ |
| Booking | Online requires email ✓ · staff does not ✓ |

## 10. Deployment order

```
prisma migrate deploy          # preferences table + backfill + alignment
pnpm db:seed                   # consent-policy rule (create-if-missing)
pnpm customers:email-quality   # read-only verification
```

`pnpm notifications:collection-wording --commit` is still required on any
environment that has not had CR-2026-113 applied.
