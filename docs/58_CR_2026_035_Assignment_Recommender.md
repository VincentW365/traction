# CR-2026-035 — Technician Assignment Recommender (ADR + Change Request)

**Status:** IMPLEMENTED (autonomous run — user delegated commits/approvals). **Phase B.**
**Type:** ADR + Change Request — read-only recommender over assignment; **no schema change, no new dependency, no change to the existing assign flow.**
**Author:** Vincent Wilson · **Drafted:** 2026-06-15
**Approval gate:** §9 names "any change to assignment logic" — but this CR **adds a read-only recommendation surface only**; the authoritative `POST /service-orders/:id/assign` flow (skill/bay/double-booking checks) is untouched. Recorded here per §9.

## 1. Context / Decision
Stakeholders asked for "the best way to assign technicians." Decision (approved in the roadmap): **recommend, staff confirms** — surface a **ranked list of qualified technicians** for a service order; the human still assigns via the existing endpoint. Reuses the built-but-unused scheduling-engine matcher and adds **shift availability** + **current load** + a **transparent score**.

### Alternatives considered (rejected)
- **Auto-assign** (engine picks + assigns) — rejected for v1: bigger change to core logic; humans lose control. (Could be a later CR.)
- **New scoring engine** — rejected: reuse `scheduling/engine/resource.matcher` for skill candidacy; keep scoring small + explainable.

## 2. What it does (read-only)
`GET /technicians/recommended/:serviceOrderId` (`SERVICE_ORDER_ASSIGN`):
- Derives the order's **required skill codes** + **bay types** from its service-type items.
- **Reuses `matchResources`** (scheduling engine) to find technicians who have **ALL** required skills.
- Computes per candidate: **current open-assignment load** (`status IN ASSIGNED/IN_PROGRESS, endedAt null`), **today's shift availability** (`MechanicDayAvailability.status`, or `NOT_SCHEDULED`), matched skills.
- **Transparent score** = `100 + availabilityBonus − loadPenalty + skillBreadthBonus` (breakdown returned). Ranked desc, tiebreak by load then employee code.
- Returns `{ serviceOrderId, siteId, requiredSkillCodes, requiredBayTypes, compatibleBays, technicians: [ranked + scoreBreakdown] }`. `compatibleBays` = all active bays when no specific bay type is required (so an unconstrained job isn't shown zero bays).

**No writes, no audit** (pure read). Assignment itself remains the existing manual confirm flow.

## 3. Files
- `apps/api/src/modules/technicians/technicians.service.ts` — `getRecommendedTechnicians(serviceOrderId, now?)` (reuses `matchResources`).
- `apps/api/src/modules/technicians/technicians.controller.ts` — `GET /technicians/recommended/:serviceOrderId` (declared before `:id`).
- `apps/api/src/modules/technicians/__tests__/recommended-technicians.service.spec.ts` *(new)*.
- `apps/web/app/(dashboard)/queue/[id]/page.tsx` — ranked recommendations inside the existing assign form ("Use" prefills the tech + a compatible bay); manual select retained.
- `docs/58_CR_2026_035_Assignment_Recommender.md` *(this file)*.

## 4. Rule / schema impact
**None.** No schema change. No change to `ServiceOrdersService.assign` (skill/bay/double-booking enforcement stays authoritative). The recommender is advisory; the API still validates on confirm. No new dependency or permission (reuses `SERVICE_ORDER_ASSIGN`).

## 5. Scoring (explainable, not magic)
`availabilityBonus`: AVAILABLE +50, ON_BREAK +10, NOT_SCHEDULED 0, OFF_FLOOR/ABSENT −50. `loadPenalty`: 40 × open assignments. `skillBreadthBonus`: +1 per skill (minor tiebreak). All surfaced in `scoreBreakdown` and shown in the UI so staff see *why* a tech is ranked. Tunable later via config if desired.

## 6. Risks
| Risk | Mitigation |
|---|---|
| Mistaken for auto-assign | Advisory only; staff confirm via existing endpoint; API re-validates skill/bay/double-book. |
| Empty availability data | NOT_SCHEDULED is neutral (bonus 0), so the recommender still ranks by skill+load when shifts aren't tracked. |
| Bay matcher returns 0 when no bay type required | Bay compatibility computed directly (all active bays when unconstrained), not via the matcher's bay filter. |
| Engine coupling | Only the pure `matchResources` is imported; no scheduler state touched. |

## 7. Tests
Service unit: skill candidacy via matcher (only techs with all required skills); ranking by availability + load (AVAILABLE/0-load tops; ABSENT/loaded sinks); compatibleBays = all when no required type, filtered when required; 404 on missing order; score breakdown present. Full API suite stays green; api+web typecheck.

## 8. Status
Implemented + verified in this autonomous run; committed and tagged `save-point-post-assignment-recommender`. No push, no remote. Auto-assign + config-tunable weights remain possible future CRs.
