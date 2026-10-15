# CR-2026-117 — Coming out of test email routing, from the app

**Status:** COMPLETE. Verified live, end to end.
**Date:** 2026-10-15
**Ask:** "Is there a way to get the email out of test sending from the webapp and
not through my boss's system settings?"

---

## A. Objective

Customer email was pinned to test routing by `NOTIFICATION_MODE`, an environment
variable resolved once at boot. Coming out of it meant an env change and a
redeploy — which in practice meant the person holding the deployment
credentials, every single time, including to undo it.

That is the wrong gate. Whether this business writes to its own customers is an
operational decision made by the people who answer to those customers. It is not
infrastructure.

## B. The split, and why it is where it is

**Moved into Settings** — because neither is a secret:

| Setting | Was | Now |
| --- | --- | --- |
| Send Email to Customers | `NOTIFICATION_MODE=TEST\|LIVE` | `notifications_live_sending`, a toggle |
| Test Address | `NOTIFICATION_TEST_EMAIL_TO` | `notifications_test_email_to`, a text field |

**Did not move, and must not** — `EMAIL_PROVIDER` and `SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. A mailbox password in a
`BusinessRuleConfig` row is readable by every account with `CONFIG_VIEW`, is
copied verbatim into the audit log's before/after values the first time anyone
edits it, and is in every database backup from then on. `CLAUDE.md` §10 puts
provider credentials behind the env boundary; that is the right call and this CR
does not weaken it.

**The resulting division of labour:** the owner connects the mailbox **once**.
After that nobody needs him again — not to go live, not to come back, not to
change where test mail lands.

## C. Assumptions

1. **Default stays OFF.** The migration seeds `false`. A migration must not be
   the thing that starts an installation writing to real customers.
2. **The setting wins; the environment is the fallback.** With no row — a
   deployment that has not migrated, a database mid-setup — behaviour is exactly
   as before. Once a row exists it is the answer, in both directions.
3. **The switch works both ways.** A manager who sees a problem can stop the
   sending themselves. A one-way switch is not a switch.
4. Nothing is currently sending live, so seeding `false` regresses no
   deployment. The owner's outstanding "email proof" step is still outstanding.

## D. What was built

- `NotificationRoutingService` resolves mode and test recipient **per send**
  rather than at boot, so a change takes effect on the next message instead of
  the next deploy. One indexed lookup on a path that is already doing network
  I/O.
- Both send paths now use it: `NotificationsService.routeRecipient` (background
  flows) and `CustomerNotificationsService.resolveRouting` (the composer).
- `capabilities()` reports the **effective** mode plus `modeSource`, so nobody
  hunts for a setting that is not in charge yet.
- A guard on `ConfigService.updateRule`: live sending cannot be turned on
  without a mailbox. A switch reading ON while every message is still recorded
  as simulated is worse than one that refuses — the first anyone would learn of
  it is a customer who was never told their car was ready.
- Refusal messages rewritten for the person who now reads them. They used to
  name environment variables (`NOTIFICATION_TEST_EMAIL_TO`,
  `NOTIFICATION_MODE=LIVE`) at a manager who cannot set either.

## E. The bug this turned up

`NOTIFICATION_CAPABILITIES` was **provided** by `NotificationsModule` but never
**exported**. `@Global()` publishes only what a module exports, so `ConfigService`
injected `undefined` and the new guard refused *every* attempt to go live with
"no mailbox is connected" — on an installation that had one correctly wired.

Caught only because the live probe flipped a real switch against a real mailbox
instead of trusting the unit tests. It is the nastiest shape of failure: the
guard was indistinguishable from the condition it guards against, so a manager
would have gone back to the owner asking for something already done, and the
owner would have found nothing wrong.

## F. Risks and tradeoffs

- **Any Manager account can now start emailing real customers.** That is the
  requested change, not a side effect. It is audited with before/after values
  and attribution, it needs `CONFIG_EDIT`, and the control carries its
  consequence in plain words. If this should be narrower than Manager, that is a
  permission change and a separate decision.
- **One extra rule read per send.** Negligible beside the SMTP round trip.
- **UAT capture is untouched.** `TestRecordResolver` still captures anything
  belonging to a test run regardless of this switch, so a UAT booking cannot
  reach a real person even with live sending on.

## G. Tests and validation

11 new unit tests. Full suites: **api 1793 · web 389**, both typecheck configs
clean, build clean.

Verified live against the built API:

```
no mailbox wired
  turn live sending ON   → 403 EMAIL_MAILBOX_NOT_CONFIGURED, message naming
                            whose job the mailbox is

mailbox wired, switch off
  capabilities           → mode TEST, testRoutingActive true
  set Test Address       → testEmailTo follows immediately
  turn live sending ON   → accepted
  capabilities           → mode LIVE, testRoutingActive false   (no restart)
  turn live sending OFF  → back to TEST
```

`AuditLog` recorded both flips as `CONFIG_CHANGE` with before/after values and
the user who made them.

## H. Approval gate

Worth management's attention rather than a code review: this changes **who can
start writing to customers** from "whoever holds the deployment credentials" to
"any Manager account". That was the explicit request, and it is recorded here so
the decision is visible rather than buried in a diff.

## I. What the owner still has to do, once

Connect the mailbox in the deployed API environment:

```
EMAIL_PROVIDER=smtp
SMTP_HOST=…        SMTP_PORT=…      SMTP_SECURE=true|false
SMTP_USER=…        SMTP_PASS=…      SMTP_FROM="Bert's Auto Parts <service@…>"
```

`NOTIFICATION_MODE` and `NOTIFICATION_TEST_EMAIL_TO` may stay as they are; once
the rule rows exist they are no longer consulted. After this, everything else is
Settings → Notifications → **Where customer email goes**.
