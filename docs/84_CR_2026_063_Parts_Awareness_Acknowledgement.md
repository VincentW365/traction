# CR-2026-063 — Parts awareness + acknowledgement (external parts)

**Status:** Implemented.
**Requested by:** Vincent Wilson — "If a service might require a part, have it say so when the appointment is created… make [staff] aware and acknowledge it. Actual parts request is done through another application."

## A. Objective
Make parts readiness effective without owning parts: **flag** at booking/check-in that a chosen
service may need parts, and let staff **acknowledge** the parts are arranged (in the external app).

## B. Design (no schema change)
Actual parts ordering stays in the external app. Traction records only awareness + an
acknowledgement, stored as an **audit event** (no new columns):
- **Awareness banner (frontend only):** `/service-types` already returns `partsPrepositionRequired`
  (true for oil/filters/battery/brakes/etc.). Added the field to the client `ServiceType` interfaces
  and render an amber "⚠ May require parts" banner when any selected service is flagged — in the
  **appointment wizard** (service step) and the **walk-in check-in** page.
- **Acknowledgement (audit-backed):** new `AUDIT_ACTIONS.PARTS_ACK_APPLIED` / `PARTS_ACK_CLEARED` and
  `AuditService.findLatest(entityType, entityId, action[])`. New endpoints on the existing
  `service-visits` controller (`QUEUE_VIEW`): `POST /service-visits/:id/acknowledge-parts`
  ({acknowledged?, note?}) writes the audit row; `GET /service-visits/:id/parts-ack` returns the
  current `{acknowledged, at, by}` derived from the latest APPLIED/CLEARED row.
- **Queue detail UI:** in the Parts Readiness cell (shown only when `partsReadiness !== NOT_REQUIRED`),
  an **"Acknowledge parts prepositioned"** button, or a green "✓ Parts prepositioned — by <name>"
  with a *clear* action once acknowledged.
- **Catalogue visibility:** the admin service catalogue now shows a **Parts** badge per service so
  managers can see which services raise the banner.

The scheduling engine / `partsReadiness` derivation is untouched (it's a projection; UNCONFIRMED
already doesn't block dispatch). The acknowledgement is an auditable informational anchor.

## C. Impacted modules / data
- API: `audit/audit.service.ts` (actions + `findLatest`), `status/status.controller.ts` (2 endpoints
  on `ServiceVisitCompletionController`). No schema change.
- Web: `appointments/new/page.tsx`, `check-in/page.tsx`, `queue/[id]/page.tsx`,
  `admin/service-catalogue/page.tsx`.

## D. Tests / validation
- New `status/__tests__/parts-ack.controller.spec.ts`: apply logs APPLIED + reports acknowledged with
  actor; clear logs CLEARED + reports not-acknowledged; state derived from latest row; empty → not
  acknowledged; missing visit → 404. `vitest run src/modules/status` — 15 passed.
- `pnpm --filter @bsop/api exec tsc --noEmit` + `--filter @bsop/web` — green. Web tests: 74 passed.

## E. Notes
- Actual parts request / reserve / receive intentionally NOT built (external app owns it).
- Banner copy is generic ("arrange preposition in the parts system"); a configurable deep-link
  (`parts_app_url`) can be added later if a URL is provided.

## F. Approval gate
No schema change; acknowledgement rides on the existing AuditLog; scheduling/parts-blocking logic
untouched → **not a §9 trigger**. Recorded as a Change Request; reversible via git.
