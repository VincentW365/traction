# CR-2026-116 — The Booking Simulator becomes a switch the business owns

**Status:** COMPLETE. Verified live, end to end.
**Date:** 2026-09-21
**Ask:** "Make the booking simulation a setting that can be turned on/off and
have the option appear or disappear based off the setting."

---

## A. Objective

The Booking Simulator (Setup → Booking Simulator) was permanently present for
Managers. It is a testing tool — it explains why a slot is or is not offered,
and it can start a UAT session that makes disposable test bookings through the
real `/book` flow. That is exactly the kind of thing a business wants available
during commissioning and put away afterwards, without waiting for a release.

It is now governed by one setting, `booking_simulator_enabled`, which a Manager
changes in Settings like any other business rule.

## B. Inputs used

`docs/122` (CR-2026-108 Stage 3, the simulator and the UAT session),
`docs/130` (CR-2026-109, the Settings console), `CLAUDE.md` §6 (rules live in
config, never in code) and §12 (never bury rule values in frontend code).

## C. Assumptions

1. **Default ON.** The ask was "make it a switch", not "turn it off". The
   simulator works today and managers may be using it, so the migration seeds
   `true` and the code defaults to `true` when no row exists. Introducing a
   switch must not be the thing that removes a working tool. Turning it off is
   one click, and §H says how.
2. **Site-scoped row, read unscoped.** The rule is stored per site, as every
   business rule is, but read without a site filter — matching `booking_enabled`
   and `appointment_reminder_enabled`. The pilot is single-site; a half
   site-aware flag would be a worse lie than an honestly global one.
3. **Not a permission.** `BOOKING_SIMULATE` still decides *who* may use the
   tool. The flag decides *whether the business runs it at all*. They fail
   differently and are kept apart.

## D. What was built

**The switch is enforced where the data is served, not only in the menu.** This
is the whole design decision. A screen the navigation no longer shows is still a
screen anyone can reach by typing the address, and its endpoints would answer
exactly as before — "off" would mean "harder to find", which is not what a
manager reading a control labelled On/Off is being told.

| Layer | Behaviour when off |
| --- | --- |
| `GET /admin/testing/booking/simulate` | 403 `FEATURE_DISABLED` |
| `GET /admin/testing/booking/shadow-findings` | 403 `FEATURE_DISABLED` |
| `POST /admin/testing/booking/uat-session` | 403 `FEATURE_DISABLED` |
| `POST /public/booking/uat/redeem` | refused — see below |
| Sidebar → Setup → Booking Simulator | not rendered |
| Settings → Booking & Scheduling → *Related* | link withdrawn |
| Settings → System & Testing → launchpad | link withdrawn |
| `/admin/testing/booking` typed directly | a plain "this tool is switched off" page with a route back to the setting |

New, reusable and small: `@RequireFeature(...)` + `FeatureFlagGuard`, shaped to
read like the `@RequirePermission` / `RbacGuard` pair already on every
controller. `isFeatureOn()` is the single reading of a flag, shared by the guard
and by the service that needs the same answer outside a request pipeline, so the
two halves of one feature cannot disagree.

**The outstanding-launch-token case.** A UAT launch link issued before the
switch went off must not still open a test session afterwards — "off" would hold
everywhere except the one path that creates test customers and captures their
messages. `redeemUatLaunchToken` now checks the flag first and refuses through
the *existing* rejection route, so the tester gets the message that already
exists — *"Return to the Booking Simulator and start a new UAT session"* — and
is never silently dropped into a real booking.

**What is deliberately NOT done:** a UAT session cookie already in a tester's
browser is left alone. Invalidating it mid-flow would turn a booking the tester
believes is disposable into a real customer with a real confirmation email. The
cookie is short-lived and runs out on its own. That is the safer failure.

**The switch is not behind the thing it hides.** It lives in Settings → Booking
& Scheduling → *Testing tools*, a category that is never gated. A control
reachable only through the tool it can hide would be a one-way door.

## E. Impacted modules and data

- New: `common/constants/features.ts`, `common/decorators/require-feature.decorator.ts`,
  `common/guards/feature-flag.guard.ts`, `common/helpers/feature-flags.ts`,
  `apps/web/hooks/use-feature.ts`
- Changed: booking-simulator controller and service, sidebar, settings catalogue
  and category page, the simulator page
- Data: one `BusinessRuleConfig` row per site, `booking_simulator_enabled`,
  seeded `true` by migration `20260921200000_cr_2026_116_booking_simulator_switch`
  and by `prisma/seed.ts` so a fresh clone matches a running deployment
- No schema change. `deploy:check` reports no drift.

## F. Risks and tradeoffs

- **A stale browser tab** can still show the menu item for up to a minute after
  the switch changes (the rules query is cached). Clicking it lands on the
  "switched off" page and the endpoints refuse, so the worst case is one wasted
  click, not a leak.
- **The flag is read on every simulator request** — one indexed lookup on a
  Manager-only screen. Not worth a cache.
- **Default ON is a judgement call.** If the intent is that the tool ships
  hidden, that is one toggle, not a code change (§H).

## G. Tests and validation

14 new unit tests (8 API, 5 web catalogue, 1 UAT redemption). Full suites:
**api 1782 · web 389**, both typecheck configs clean, `pnpm build` clean,
`pnpm audit:operational` 80/80, `deploy:check` PASS with no drift.

Verified live against the built API, switching through the **Settings endpoint**
rather than editing the database — so the audit path was exercised too:

```
switch ON      simulate=200   uat-session=201
switch OFF     simulate=403   {"code":"FEATURE_DISABLED", "message":"The Booking
                               Simulator is switched off for this site. A manager
                               can turn it back on under Settings → Booking &
                               Scheduling → Testing tools."}
               uat-session=403
               public services=200, public site=200   (customers unaffected)
outstanding UAT token, minted while ON, redeemed while OFF
               redeem=400 UAT_SESSION_INVALID
restored ON    simulate=200
```

`AuditLog` recorded every flip as `CONFIG_CHANGE` with before/after values and
the user who made it — four entries, attributed, no separate mechanism.

## H. Approval gate

None required: no core-entity schema change, no queue or scheduling logic
change, no auth model change, no new dependency. It adds a configurable rule,
which is the direction `CLAUDE.md` §6 and §12 require.

**One decision is the owner's:** the simulator currently ships **on**. If it
should be hidden in the live system, turn it off once in Settings → Booking &
Scheduling → Testing tools after deploying. Nothing customers see changes either
way, and test records already created are kept.
