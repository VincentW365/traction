# CR-2026-032 — Customer Complaints Log (ADR + Change Request)

**Status:** ADR / PLAN — **for approval. NOT implemented** (no schema, migration, or code yet).
**Type:** ADR + Change Request — new entity + 3 enums + new audited state machine (CLAUDE.md §9 mandatory review).
**Author:** Vincent Wilson · **Drafted:** 2026-06-14
**Approval gate:** §9 — schema change + new audited state machine. Surfaced for review **before** the migration is applied (mirrors the CR-A plan-first gate). Additive only; **no new third-party dependency**.

> This document was hardened by a design → 4-lens adversarial review → synthesis pass. Nothing has been built. On approval I implement → verify → pause before commit → commit + tag.

---

## 1. Problem / Context
Stakeholders want a place to **log customer complaints** and work them to resolution. Today there is no complaint concept — only free-text `notes` and `AuditLog`, neither of which gives a triageable, status-tracked, auditable complaint record.

## 2. Decision (ADR)
Introduce a **new `Complaint` entity** with a small **audited state machine** `OPEN → ACKNOWLEDGED → RESOLVED` (acknowledge is optional; `OPEN → RESOLVED` is allowed). Complaints are a **first-class governance record**, separate from rework. Fully **additive** (3 new enums + 1 new table + nullable FKs + virtual back-relations); no existing entity is modified or relaxed.

## 3. Alternatives considered (rejected)
- **Extend `ServiceVisit.notes` / `AuditLog` only** — rejected: no structured type/severity/status, no triage board, no SLA, no lifecycle/ownership.
- **Overload an existing entity (e.g. a status on ServiceVisit)** — rejected: a complaint is a distinct concept; conflating it weakens a core aggregate (CLAUDE.md §12).
- **Link rework → complaint** — rejected: complaints stay **separate** from rework; only an optional `serviceOrderId` soft link (CLAUDE.md §12).

## 4. Scope
**In this CR:** Complaint entity + enums + additive migration; complaints module (controller/service/DTOs) with the race-safe state machine, RBAC, and audit/StatusHistory; SLA `slaDueAt` computed from config (display/overdue badge only); web **Complaints** board + detail + new-complaint pages; tests; seed default config rows.

**Deferred (explicit, not silently dropped):**
- **Complaint notifications** (manager alert / customer-on-resolve) → deferred until **after CR-E (Twilio)**, so we don't wire messaging onto the current stub provider. `NotificationsService.queue` hook points noted but not called this round.
- **Reopen path** (RESOLVED is terminal this round — see Open Questions).
- **Manager-dashboard/reporting tie-in** (open/overdue counts) → later CR.
- **Creator-edits-own-complaint** → not allowed (manager edits, audited) per roadmap RBAC.
- **SLA escalation timer (BullMQ)** → out of scope (config-only).

## 5. Schema (additive) — `prisma/schema.prisma`
```prisma
enum ComplaintStatus { OPEN ACKNOWLEDGED RESOLVED }
enum ComplaintType { SERVICE_QUALITY WAIT_TIME STAFF_CONDUCT PRICING VEHICLE_DAMAGE COMMUNICATION OTHER }
enum ComplaintSeverity { LOW MEDIUM HIGH CRITICAL }

model Complaint {
  id              String            @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  complaintNumber String            @unique @map("complaint_number")   // immutable CMP-NNNNNN
  siteId          String            @map("site_id") @db.Uuid
  customerId      String            @map("customer_id") @db.Uuid
  serviceVisitId  String?           @map("service_visit_id") @db.Uuid  // optional soft link
  serviceOrderId  String?           @map("service_order_id") @db.Uuid  // optional; NO rework→complaint FK
  type            ComplaintType
  severity        ComplaintSeverity @default(MEDIUM)
  status          ComplaintStatus   @default(OPEN)
  subject         String
  description     String
  slaDueAt        DateTime?         @map("sla_due_at") @db.Timestamptz   // display/report only
  acknowledgedAt  DateTime?         @map("acknowledged_at") @db.Timestamptz
  acknowledgedByUserId String?      @map("acknowledged_by_user_id") @db.Uuid  // soft ref, from JWT
  resolvedAt      DateTime?         @map("resolved_at") @db.Timestamptz
  resolvedByUserId String?          @map("resolved_by_user_id") @db.Uuid
  resolutionNotes String?           @map("resolution_notes")           // required at resolve; manager-internal
  createdByUserId String?           @map("created_by_user_id") @db.Uuid
  createdAt       DateTime          @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime          @updatedAt @map("updated_at") @db.Timestamptz

  site         Site         @relation(fields: [siteId], references: [id])
  customer     Customer     @relation(fields: [customerId], references: [id])
  serviceVisit ServiceVisit? @relation(fields: [serviceVisitId], references: [id])
  serviceOrder ServiceOrder? @relation(fields: [serviceOrderId], references: [id])

  @@index([siteId, status])
  @@index([customerId])
  @@index([status])
  @@index([serviceVisitId])
  @@index([serviceOrderId])
  @@map("complaints")
}
```
**Back-relations (additive, virtual — no columns added to these tables):** `Customer.complaints`, `Site.complaints`, `ServiceVisit.complaints`, `ServiceOrder.complaints`.

**Migration** (`prisma migrate dev --name cr_2026_032_customer_complaints`): `CREATE TYPE`×3 + `CREATE TABLE complaints` + indexes + FKs (site/customer `ON DELETE RESTRICT`; visit/order `ON DELETE SET NULL`). **No `ALTER TABLE` on `sites`/`customers`/`service_visits`/`service_orders`.** Table starts empty → no backfill. `complaintNumber` = `CMP-NNNNNN` generated **inside the create `$transaction`** via regex-anchored `MAX(CAST(SUBSTRING(complaint_number FROM 5) AS INT))+1` over `complaint_number ~ '^CMP-[0-9]+$'` (mirrors `customers.service.ts`), `@unique` as the race backstop.

## 6. State machine (race-safe; audit/history written after the status write)
| From | To | Action | Guard / mechanism |
|---|---|---|---|
| — | OPEN | create | `COMPLAINT_CREATE`; validate customer/site exist + optional links exist + subject/description non-empty; generate number + `slaDueAt` in the create tx |
| OPEN | ACKNOWLEDGED | acknowledge | `COMPLAINT_MANAGE`; conditional `updateMany({where:{id,status:'OPEN'}})`; `count===0 → BadRequest` |
| OPEN / ACKNOWLEDGED | RESOLVED | resolve | `COMPLAINT_RESOLVE`; `resolutionNotes` trimmed-non-empty required **before** write; conditional `updateMany({where:{id,status:{in:['OPEN','ACKNOWLEDGED']}}})`; `count===0 → BadRequest` |
| OPEN / ACKNOWLEDGED | (same) | patch | `COMPLAINT_MANAGE`; descriptive fields only (never status/number); **BadRequest if RESOLVED** (terminal); recompute `slaDueAt` only if severity changes; writes **no** StatusHistory |

- **Race-safety** via conditional `updateMany` (pattern from queue-abandon / serviceOrderPause) → exactly one StatusHistory + AuditLog per real transition.
- **Audit/history pattern matches every existing service:** status write in a `$transaction`, then `statusHistory.record(...)` + `audit.log(...)` **awaited after** (AuditService/StatusHistoryService take no `tx` client). True tx-atomicity of audit would be a cross-cutting change to shared audit infra → separate ADR, out of scope.
- `entityType = 'Complaint'` (PascalCase) on **all** history/audit calls, so the detail timeline (`findByEntity('Complaint', id)`) is complete.

## 7. API + RBAC (module `apps/api/src/modules/complaints/`)
`@Controller('complaints')`, `JwtAuthGuard + RbacGuard` (class), `SiteGuard` on create; by-id ops re-check `complaint.siteId === user.siteId` (ADMIN bypass) in the **service** to close the cross-site IDOR (SiteGuard is a no-op without a siteId in the request). DTOs whitelisted (`forbidNonWhitelisted`) — never accept `complaintNumber`/`status`/`*ByUserId`.

| Method/path | Permission | Effect |
|---|---|---|
| `POST /complaints` | `COMPLAINT_CREATE` | create OPEN (+number, +slaDueAt) + history(null→OPEN) + audit |
| `GET /complaints` | `COMPLAINT_VIEW` | list (non-ADMIN forced to `user.siteId`); filters status/severity/type/customer; paginated |
| `GET /complaints/:id` | `COMPLAINT_VIEW` | detail + linked visit/order + StatusHistory timeline (service site-check) |
| `POST /complaints/:id/acknowledge` | `COMPLAINT_MANAGE` | OPEN→ACKNOWLEDGED |
| `POST /complaints/:id/resolve` | `COMPLAINT_RESOLVE` | →RESOLVED (resolutionNotes required) |
| `PATCH /complaints/:id` | `COMPLAINT_MANAGE` | descriptive edit (blocked on RESOLVED) |

**Permissions** (`permissions.ts`): `COMPLAINT_CREATE` + `COMPLAINT_VIEW` → FRONT_DESK + SERVICE_ADVISOR + MANAGER (+ADMIN); `COMPLAINT_MANAGE` + `COMPLAINT_RESOLVE` → MANAGER (+ADMIN). **Audit actions:** `COMPLAINT_CREATED/ACKNOWLEDGED/RESOLVED/UPDATED`.

## 8. SLA (config-only, no timer)
`slaDueAt = createdAt + hours[severity]`, where the hours map comes from `BusinessRuleConfig` key `complaint_sla_hours_by_severity` (active row `effectiveTo: null`, same read pattern as maintenance reminders) with an in-code fallback `{LOW:120, MEDIUM:72, HIGH:24, CRITICAL:4}`. Stored for **display/reporting only** — the "overdue" badge is computed `now()` vs `slaDueAt` (RESOLVED never overdue); **nothing enqueues, escalates, or auto-transitions.** Seed the default config row.

## 9. Web (`apps/web/app/(dashboard)/complaints/`)
- `page.tsx` — triage board: filters (status/severity/type), columns (number, customer, subject, severity, status, SLA/overdue badge). View for all; Acknowledge/Resolve actions shown for MANAGER/ADMIN (UX only; API is authoritative).
- `new/page.tsx` — log a complaint (customer select, optional visit/order link, type/severity/subject/description).
- `[id]/page.tsx` — detail + StatusHistory timeline; manager Acknowledge / Resolve (notes required) / Edit (hidden once RESOLVED).
- Sidebar entry "Complaints" (Operations or Bookings section), roles FRONT_DESK/SERVICE_ADVISOR/MANAGER/ADMIN.

## 10. Tests
Service: create sets OPEN + `CMP-000001` + slaDueAt (config + fallback) + history/audit after the tx; number regex ignores non-CMP rows; resolve rejects empty/whitespace notes **before** any write; legal/illegal transitions; **race-safety** (concurrent resolve → exactly one succeeds, one StatusHistory/audit row); direct OPEN→RESOLVED leaves `acknowledgedAt` null; PATCH blocked on RESOLVED + recomputes slaDueAt on severity change + writes no history; optional links validated. Controller/e2e: RBAC matrix (front-desk/advisor create+view, 403 on manage/resolve; manager/admin full), DTO whitelist, cross-site IDOR (Site-B id → NotFound for non-ADMIN). Web: overdue badge, resolve-blocked-without-notes, manager-only buttons.

## 11. Files
`prisma/schema.prisma`; `prisma/migrations/<ts>_cr_2026_032_customer_complaints/`; `apps/api/src/common/constants/permissions.ts`; `apps/api/src/modules/audit/audit.service.ts` (AUDIT_ACTIONS); new `apps/api/src/modules/complaints/` (module, controller, service, 4 DTOs, `__tests__/`); `apps/api/src/app.module.ts`; `apps/web/app/(dashboard)/complaints/{page,new/page,[id]/page}.tsx`; `apps/web/components/sidebar.tsx`; a seed/config insert for the SLA config rows; this doc.

## 12. Risks
| Risk | Mitigation |
|---|---|
| Concurrent acknowledge/resolve double-writes | conditional `updateMany` guard (count===0 → BadRequest) |
| Cross-site complaint access (IDOR) | service-layer `siteId` check on every by-id op (ADMIN bypass) |
| `resolutionNotes` whitespace bypass | trim-length validator in DTO **and** re-check in service before write |
| Resolved complaints mutated | PATCH BadRequest when RESOLVED; number/status never editable |
| Audit/history not atomic with status write | accepted (matches all existing services); documented; true atomicity = separate infra ADR |
| Number collision under load | generated in create tx + `@unique` backstop + caller retry on P2002 |

## 13. Schema / API impact + backfill
Additive schema (3 enums + 1 table + nullable FKs + virtual back-relations); **no backfill**; new read/write endpoints under `/complaints`; new `COMPLAINT_*` permissions. No change to scheduling/queue/parts/transport/auth. **No new dependency.**

## 14. Decisions baked in (defaults — override at approval)
`CMP-NNNNNN` 6-pad; severity default `MEDIUM`; SLA `{LOW:120,MEDIUM:72,HIGH:24,CRITICAL:4}`; RESOLVED terminal (no reopen this round); keep both `COMPLAINT_MANAGE` + `COMPLAINT_RESOLVE` keys; complaints list shows **all** complaints (governance record; no test-data/historical filter); **no notifications this round** (post-Twilio); creator cannot edit own (manager edits, audited).

## 15. Open questions to confirm (or accept the defaults above)
1. **SLA hours** — are `{LOW:120, MEDIUM:72, HIGH:24, CRITICAL:4}` right for Bert's? (display-only)
2. **Reopen** — OK that RESOLVED is terminal for now? (a wrongly-closed complaint would otherwise need a future governed REOPEN transition — not a raw DB edit)
3. **Notifications** — confirm deferring all complaint notifications to after Twilio (CR-E). Manager alert on HIGH/CRITICAL and/or a customer "we've logged your complaint / resolved it" message would come then.
4. **Provenance** — show all complaints (incl. those linked to historical/sandbox customers), or filter to live customers only?

## 16. Approval
**Mandatory review (§9).** Additive, nullable, no dependency/auth change → moderate risk (new audited state machine). On approval: apply migration + implement + test + **pause before commit**; commit only the named files + annotated tag. No push, no remote.
