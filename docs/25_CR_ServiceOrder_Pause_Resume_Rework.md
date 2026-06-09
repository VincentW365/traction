# Change Request — Service Order Pause/Resume + Rework (Rectify)

**CR ID:** CR-2026-001
**Author:** Vincent Wilson · **Date:** 2026-06-09
**Status:** ✅ IMPLEMENTED — RECORDING-ONLY scope (approved + built 2026-06-09). Pause/resume + rework recording, audit, and API endpoints landed with **no change to scheduling/ETA/queue-rank**. The three "paused-clock" sub-decisions remain DEFERRED to a follow-up CR. Web UI (tech buttons) + manager pause/rework reporting are the remaining follow-ups.

**Implemented in:** `prisma/schema.prisma` (PAUSED + PauseReason enums, `service_order_pauses` + `service_order_reworks` tables), migration `20260609162547_pause_resume_rework_recording` (applied), `service-orders.service.ts` (`pause`/`resume`/`openRework`), `service-orders.controller.ts` (POST `:id/pause` `:id/resume` `:id/rework`), `dto/pause-rework.dto.ts`, tests `__tests__/pause-rework.service.spec.ts` (7 passing). API typechecks clean.
**Governance:** Triggers `CLAUDE.md` §9 (core-entity schema change · state-machine change · potential queue-ranking/ETA impact). Uses `templates/Change_Request_Template.md`.

---

## Change Summary

Add **first-class pause/resume** and a **rework (rectify) loop** to the `ServiceOrder` lifecycle, with append-only ledgers for auditability:

1. New status `PAUSED` on `ServiceOrderStatus`.
2. New transitions: `IN_PROGRESS → PAUSED`, `PAUSED → IN_PROGRESS | CANCELLED`, and `QC → IN_PROGRESS` (rework re-open).
3. New append-only **`ServiceOrderPause`** ledger (pause intervals + reason codes).
4. New **`ServiceOrderRework`** table (QC-failure rework loops, preserving original work history).
5. Keep `WAITING_PARTS` / `WAITING_CUSTOMER` as their own states (NOT folded into `PAUSED`).
6. Define the **"paused-clock" rule** (resource hold + ETA behaviour) as explicit, configurable `BusinessRuleConfig` values.

Pause **duration is derived** from the ledger, never stored as a mutable field.

## Why the Change Is Needed

- **Business rule TECH-003** already requires: *"a technician cannot be double-booked … unless one job is paused and the system records the pause."* The system currently cannot record a pause.
- **Real data (SharePoint, 9,055 jobs):** **17.3% of jobs (1,564) used pause/resume**; **30 jobs** had rework (`RectifyStartTime`). The live `ServiceOrder` machine has neither.
- Current machine only models *reason-specific holds* (`WAITING_PARTS`, `WAITING_CUSTOMER`) and is **forward-only at QC** (`QC → READY_TO_INVOICE | CANCELLED`) — no way to send work back.
- Without this, the platform cannot faithfully represent real shop operation, cannot satisfy TECH-003, and cannot report pause/rework KPIs (which the DMAIC CONTROL phase calls for).

## Files / Modules Impacted

- `prisma/schema.prisma` — `ServiceOrderStatus` enum (+`PAUSED`); new models `ServiceOrderPause`, `ServiceOrderRework`; new enum `PauseReason`; relations on `ServiceOrder`.
- `apps/api/src/modules/service-orders/service-orders.service.ts` — `VALID_TRANSITIONS`, `ORDER_TO_VISIT_STATUS`, `RECOMPUTE_TRIGGERS`; new `pause()`, `resume()`, `openRework()` methods.
- `apps/api/src/modules/service-orders/service-orders.controller.ts` — new endpoints (RBAC-guarded).
- `apps/api/src/modules/service-orders/dto/` — `PauseServiceOrderDto`, `ReworkServiceOrderDto`.
- Scheduling engine — interaction of `PAUSED` with resource occupancy + ETA/rank (see "paused-clock rule"; gated by config).
- Reuse existing `StatusHistory` + `AuditLog` for transition/override audit (no new audit infra needed).
- `apps/web` — technician/service-order UI (pause/resume/rework buttons); manager pause/rework reporting (follow-up).
- Tests — state-machine transition + rule coverage; migration.

## Rule Impact

- **New rules:** pause lifecycle; rework loop; the paused-clock rule (below).
- **TECH-003** — becomes satisfiable (pauses recorded).
- **Queue ranking / ETA (§9-sensitive):** *only* if paused jobs are excluded from active ETA or change rank. This is isolated behind config and called out as an explicit sub-decision — default ships without altering ranking.
- **Parts-blocking unchanged** — `WAITING_PARTS` keeps its distinct scheduling-eligibility semantics (a parts-blocked visit is ineligible for service start per the scheduling spec). Deliberately **not** merged into `PAUSED`.

## Schema / API Impact

### Enum
```prisma
enum ServiceOrderStatus { DRAFT APPROVED ASSIGNED IN_PROGRESS PAUSED WAITING_PARTS WAITING_CUSTOMER QC READY_TO_INVOICE CLOSED CANCELLED }

enum PauseReason { WAITING_TECH WAITING_BAY CUSTOMER_AUTHORIZATION EXTERNAL_MACHINE_SHOP BREAK_OR_END_OF_DAY OTHER }
// NOTE: WAITING_PARTS / WAITING_CUSTOMER are intentionally NOT pause reasons — they remain first-class states.
```

### New models (append-only ledgers)
```prisma
model ServiceOrderPause {
  id              String     @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  serviceOrderId  String     @map("service_order_id") @db.Uuid
  reasonCode      PauseReason @map("reason_code")
  startedAt       DateTime   @default(now()) @map("started_at") @db.Timestamptz
  endedAt         DateTime?  @map("ended_at") @db.Timestamptz
  pausedByUserId  String?    @map("paused_by_user_id") @db.Uuid
  resumedByUserId String?    @map("resumed_by_user_id") @db.Uuid
  notes           String?
  createdAt       DateTime   @default(now()) @map("created_at") @db.Timestamptz
  serviceOrder    ServiceOrder @relation(fields: [serviceOrderId], references: [id], onDelete: Cascade)
  @@index([serviceOrderId])
  @@map("service_order_pauses")
}

model ServiceOrderRework {
  id             String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  serviceOrderId String   @map("service_order_id") @db.Uuid
  reasonCode     String   @map("reason_code")
  description    String?
  reworkCount    Int      @default(1) @map("rework_count")
  openedAt       DateTime @default(now()) @map("opened_at") @db.Timestamptz
  openedByUserId String?  @map("opened_by_user_id") @db.Uuid
  closedAt       DateTime? @map("closed_at") @db.Timestamptz
  closedByUserId String?  @map("closed_by_user_id") @db.Uuid
  createdAt      DateTime @default(now()) @map("created_at") @db.Timestamptz
  serviceOrder   ServiceOrder @relation(fields: [serviceOrderId], references: [id], onDelete: Cascade)
  @@index([serviceOrderId])
  @@map("service_order_reworks")
}
```

### Transition table changes (`VALID_TRANSITIONS`)
```
IN_PROGRESS: + 'PAUSED'                      (existing: WAITING_PARTS, WAITING_CUSTOMER, QC, CANCELLED)
PAUSED:      ['IN_PROGRESS', 'CANCELLED']    (new)
QC:          + 'IN_PROGRESS'                 (rework re-open; creates ServiceOrderRework) (existing: READY_TO_INVOICE, CANCELLED)
```

### API endpoints (RBAC: technician / advisor; override audited)
- `POST /service-orders/:id/pause` `{ reasonCode, notes? }` → status `PAUSED`, opens a `ServiceOrderPause` row, writes `StatusHistory`.
- `POST /service-orders/:id/resume` `{ notes? }` → status `IN_PROGRESS`, closes the open pause row (`endedAt`).
- `POST /service-orders/:id/rework` `{ reasonCode, description? }` (from `QC`) → status `IN_PROGRESS`, creates/increments `ServiceOrderRework`.
- Completing rework = existing `change-status` `IN_PROGRESS → QC`.

Migration is **additive** (new enum values + 2 tables) — no backfill (history is analytics-only, not imported).

## The "paused-clock" rule — explicit sub-decisions for approval

These are the §9-sensitive choices; each becomes a `BusinessRuleConfig` key:

1. **Resource occupancy while paused** — hold the bay or release it? **Recommend:** configurable; default *hold* for short pauses, *release* on `BREAK_OR_END_OF_DAY`.
2. **ETA / promised-time while paused** — **Recommend:** pause the active-service clock (don't penalise promised-time risk during a pause); **retain queue rank** (no re-ranking). This keeps ranking logic untouched for v1.
3. **Customer-facing display when paused** — **Recommend:** continue showing "In Service" (non-alarming); only end-of-day holds surface differently.

If any sub-decision is rejected, the feature can still ship with pauses recorded (audit/KPI value) while deferring the scheduling interaction.

## Risks

- **State-machine regressions** in the completion flow → mitigated by exhaustive transition tests (valid + invalid).
- **Scheduling/ETA interaction** is the riskiest surface (ranking-sensitive). Mitigation: ship pause/resume + rework **recording first**, with the ETA/occupancy behaviour behind config defaults that don't change ranking.
- **Adoption** — techs must actually press pause/resume; UI must be one-tap on the technician view, or data quality suffers (the same failure mode seen in the SharePoint history).
- **DB risk** — minimal; purely additive migration, no data backfill.

## Tests / Validation

- Unit: every new transition (valid) and rejection (e.g. `PAUSED → QC` invalid).
- A paused order's duration = sum of ledger intervals; resume closes exactly one open pause.
- `QC → IN_PROGRESS` creates a `ServiceOrderRework`; original `ServiceOrderItem`/history untouched; `reworkCount` increments on repeat.
- Every transition writes `StatusHistory` with actor + timestamp + reason.
- Scenario tests tie to DMAIC: pause-during-service, rework-after-QC, end-of-day hold.

## Implementation Outline (once approved)

1. Schema migration (enum + 2 tables) → `prisma migrate`.
2. Extend `VALID_TRANSITIONS` + add `pause/resume/openRework` service methods (transactional: status + ledger + StatusHistory in one tx).
3. Controller endpoints + DTOs + RBAC.
4. `BusinessRuleConfig` keys for the paused-clock rule.
5. Technician UI buttons; manager reporting (follow-up).
6. Tests + docs (state diagram in module README).

## Rollback

Additive and reversible: feature-flag the endpoints; if rolled back, the new tables/enum value are simply unused (no data loss, no destructive down-migration required for pilot).

## Proposed Effective Phase

**Phase 2** (service orders + technician/bay assignment + work status tracking) — per `CLAUDE.md` §7 delivery order.

## Approval Needed?

**Yes.** §9 triggers: (a) schema change to a core entity (`ServiceOrder` + new tables), (b) service-order state-machine change, (c) potential queue-ranking/ETA impact (isolated behind config). Requires sign-off before implementation. The three "paused-clock" sub-decisions in particular need an explicit decision.
