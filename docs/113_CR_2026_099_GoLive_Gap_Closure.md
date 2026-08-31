# CR-2026-099 — Final Operational Go-Live Gap Closure

**Status:** Implemented and pushed
**Date:** 2026-08-31

---

## 1. The queue engine is real

The FIFO ranking (with its ~15 decorative priority settings) is replaced by the
deterministic, auditable priority engine of docs/08 / CLAUDE.md §5, in
`scheduling/engine/priority-position.calculator.ts` (pure function):

- **Classes:** `MANUAL_OVERRIDE` (pinned, unchanged semantics) ·
  `APPT_PROTECTED` (checked in within −`protected_window_early_min` /
  +`protected_window_late_min` of the slot) · `APPT_LATE_SOFT` (late up to
  `missed_threshold_min`, lateness-penalised) · `MISSED_APPOINTMENT` (honestly
  labelled, ranked as a walk-in) · `WALKIN_FASTTRACK` (every requested service
  is quick-service) · `WALKIN_STANDARD`. Very early appointment arrivals wait
  as walk-ins until their protection window opens.
- **Score** = class base weight (`base_weight_*`) + wait bonus
  (`wait_time_bonus_per_min`, capped `wait_time_bonus_cap_min`) − lateness
  penalty (`lateness_penalty_per_min`). Ties break by check-in order, so
  equal-class arrivals never leapfrog (the wait bonus grows at the same rate).
  Fairness escalation is structural: a two-hour walk-in (600+240) overtakes a
  freshly-arrived late appointment (~785) but never a protected one (1000+).
- **Blocked tickets step aside; overrides pin** — both exactly as before.
- **Explainability:** every rank/class change writes a `QueueDecision` snapshot
  (class, score, plain-language reason codes). The board shows a class chip per
  ticket; the ticket page shows "Why position #N" from the record.
- **Configuration is live:** all eleven Queue Priority / Priority Weights
  settings are read on every recompute; changing a weight changes the order
  (pinned by test). `fairness_threshold_min` now drives a LONG_WAIT manager
  alert. Thirteen decorative settings (batching/quick-service bonuses, bay
  reservations, ETA bands, provider selectors, overflow flags, blocked-return
  policy, max-protected-delay) are **hidden from the Settings UI** — every
  visible knob controls behaviour.
- 14-case engine spec covers the directive's scenario matrix; verified live
  (board chip, persisted decision, reasons).

## 2. Passwords and authentication

- **Self-service change** (`POST /auth/change-password`, Account page in the
  topbar): verifies the current password, policy = ≥8 chars with a letter and
  a number, bcrypt(12), never logged. `passwordChangedAt` is stamped and
  `refresh` rejects tokens issued before it — a change ends every other
  session while the current one continues on fresh tokens.
- **Manager reset** (`POST /staff/:id/reset-password`, button on the staff
  page): temporary password with the same policy; ends the person's sessions.
- **Default credentials are surfaced, never silently accepted:**
  `/health/deployment` (Admin → Deployment) lists accounts still on documented
  seed passwords — 20 flagged on the dev box today. Validated live: wrong
  current → 401, weak → 400, old password dead, new works, pre-change refresh
  token rejected.

## 3. Notification delivery architecture

- **Email is deliverable**: `SmtpNotificationProvider` (nodemailer, transport
  injected) works with any SMTP mailbox — Microsoft 365, Google Workspace, a
  relay. `EMAIL_PROVIDER=smtp` + `SMTP_HOST/PORT/SECURE/USER/PASS/FROM`.
- **ChannelRouterProvider** routes SMS→(Twilio|stub), EMAIL→(SMTP|stub); no
  provider knows about the other channel; simulation/test/live switch entirely
  by environment: stub ⇒ recorded-not-delivered (flagged `simulated`),
  `NOTIFICATION_MODE=TEST` ⇒ redirected to test recipients with intended +
  actual retained, `LIVE` + real providers ⇒ customer delivery.
- Honest by construction: the UI already labels simulated/test sends;
  capabilities and the Deployment page show the live provider state.

## 4. Historical unknown-customer reconciliation

Admin → **Data Review** (`/reconciliation/*`, CONFIG_VIEW/EDIT): 1,089 visits
carry `historicalReviewStatus` (UNRESOLVED → RESOLVED | AMBIGUOUS). Each row
shows the ORIGINAL imported job text (extracted from the SharePoint HTML blob,
e.g. "SC3250FH: TUNDRA: SERVICE:") and exact vehicle-code/plate matches
against real vehicles as candidates. Relink is deliberate (per-visit, audited,
before/after recorded, placeholder rows preserved); ambiguous stays explicitly
ambiguous. Counts: 1,089 unresolved / 0 / 0 at ship; in the first 10, 2 had
high-confidence candidates — this is a workstream, not an automation.

## 5. Dormant modules — classification

- **Parts Requests/Reservations:** retired at the owner's direction (API module
  unregistered like Transport was; schema stays — the WAITING_PARTS workflow
  and parts-readiness projection read it).
- **Transport:** dormant-but-harmless (already unregistered + page archived,
  CR-2026-040). Planned if vehicle transport ever becomes a service.
- **PosReference:** dormant-but-harmless schema; payment lives in the external
  POS by policy (GOV-005 withdrawn). No UI, no flows, nothing to remove safely.

## 6. Robustness

Report endpoints validate `siteId`/date params (7 guards): malformed or
reversed ranges return 400 with a plain message instead of a Prisma 500.

## 7. Test-contamination + KPI reconciliation

The Aug-24 test tickets were resolved operationally in CR-2026-098c (tickets
completed/cancelled, orphaned orders cancelled, terminal-visit exclusion added
to every operational count). Confirmed clean again during this validation.

## 8. Production deployment — checklist (deployment is controlled externally)

`render.yaml` has `autoDeploy: true`: every push to master rebuilds, runs
`migrate deploy` + idempotent seed + `deploy-check` (build fails if they do).
The documented URLs in DEPLOY_RENDER.md are EXAMPLES; verification needs the
real service URL from the Render account:

1. Render → bsop-api → confirm the latest deploy succeeded and
   `GET <api>/api/v1/health` shows `build.commit` = the pushed SHA and the
   latest migration `20260831160000_cr_2026_099_historical_review`.
2. Admin → Deployment in the deployed web app: reference data seeded,
   customers imported, **security.defaultCredentialAccounts is EMPTY** (change
   every listed account via Account / Staff → Reset Password).
3. Go-live envs when ready (all default safe): `NOTIFICATION_MODE=LIVE`,
   `NOTIFICATION_PROVIDER=twilio` + `TWILIO_*`, `EMAIL_PROVIDER=smtp` +
   `SMTP_*`. Until then messages are recorded, not delivered — and the UI says
   so.
4. Postgres backups: Render free tier has none — schedule
   `pg_dump "$DATABASE_URL"` off-platform (daily) or upgrade the plan for
   point-in-time recovery. **This remains the biggest operational risk.**
5. Redis: not required by the deployed topology (BullMQ unwired); local dev
   uses `scripts\start-redis.bat`.

## 9. Validation

993 API + 113 web tests pass (14-case engine spec, SMTP provider + router,
fixtures updated); typecheck clean both apps; live validation script covered
scheduling classes/decisions, the full password matrix, notification
capabilities, reconciliation summary/candidates, and report 400s.
