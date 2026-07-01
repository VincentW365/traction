# CR-2026-064 — Notification history + manual send (per visit)

**Status:** Implemented.
**Requested by:** Vincent Wilson — workflow-gap audit ("Manual notification send + history").

## A. Objective
Give staff a per-visit view of notifications sent and a way to manually send one — the endpoints
existed but had no UI.

## B. Change (frontend only)
On the queue ticket detail (`queue/[id]/page.tsx`), a new **Notifications** card:
- **History** via `GET /notifications/log?entityId=<serviceVisitId>` — a table of When / Type
  (templateKey) / Channel / To / Status.
- **Manual send** via `POST /notifications/send-pickup-ready` `{ serviceVisitId, channels }` — three
  buttons: **Send SMS**, **Send Email**, **Log Call** (`MANUAL_CALL`, records a manual outreach).
  Sending invalidates + refreshes the history.
No backend change; both endpoints are gated by `QUEUE_VIEW` (Manager + Service Advisor already hold it).

## C. Impacted modules / data
- Web only: `apps/web/app/(dashboard)/queue/[id]/page.tsx`. No API/schema change.

## D. Notes
- Manual send uses the ready-for-pickup template (the available send endpoint). SMS/email actually
  transmit only when the notification provider is configured (Twilio); otherwise the stub logs them.
- Not a full notification composer — scoped to history + resend, per the audit finding.

## E. Tests / validation
- `pnpm --filter @bsop/web exec tsc --noEmit` — green. Web tests: 74 passed.

## F. Approval gate
Reuses existing permission-guarded endpoints; no schema/RBAC/logic change → **not a §9 trigger**.
Recorded as a Change Request; reversible via git.
