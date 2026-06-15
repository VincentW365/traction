# CR-2026-037 — Mileage decoupled from service (relax DMAIC Rule 5)

**Status:** IMPLEMENTED. **Type:** Business-rule change (DMAIC Rule 5) — §9 mandatory-review item, recorded here. Owner-directed.
**Author:** Vincent Wilson · **Date:** 2026-06-15

## 1. Request
"A specific service must be selected for mileage to be used. Mileage should be able to be entered regardless of the service selected." Staff were blocked from recording a mileage reading unless the job included a mileage-requiring ("service-category") service.

## 2. Old behavior (DMAIC Rule 5)
`assertMileageGate` enforced **both** directions:
- service job **without** mileage → reject (mileage required)
- **non-service job + mileage → reject** ("Mileage cannot be recorded for non-service jobs") ← the blocker

So entering mileage depended on the service selected.

## 3. New behavior
Mileage may be recorded for **any** job — entry no longer depends on the service:
| Job | Mileage | Result |
|---|---|---|
| service-category | none | reject (still **required**) |
| service-category | provided | allow |
| non-service | provided | **allow** (was reject) |
| non-service | none | allow |

Only the **non-service + mileage → reject** branch was removed. The "mileage required for service-category jobs" rule is **kept** (it never blocked *entering* mileage, only omitting it on service jobs), and the manager override remains.

## 4. Change
- `apps/api/src/common/helpers/mileage-gate.ts` — removed the non-service rejection branch; updated JSDoc.
- Enforcement points unchanged (`check-in.service`, `walk-ins.service`, `status.controller` completion) — all use the shared helper. The manager-override audit hook is unchanged (it still records an explicit override if one is supplied).
- Tests updated: `mileage-gate.spec.ts`, `walk-ins/__tests__/mileage-gate.service.spec.ts`, `appointments/__tests__/mileage-gate-boundaries.spec.ts` — the former "non-service + mileage → reject" cases now assert **allow**.
- No schema, DTO, API-contract, or UI change. The DTOs already accept an optional `mileageIn`/`mileageOut`; the check-in/walk-in UI already let staff type a mileage reading (the rejection happened server-side on submit).

## 5. Impact / risk
| Item | Note |
|---|---|
| Data quality | Mileage on non-service jobs is now permitted; it remains required for service-category jobs (e.g. oil changes) so maintenance-interval tracking is unaffected. |
| Audit | Manager-override audit path unchanged; an explicit override supplied on a now-allowed case is still logged (benign). |
| Other rules | No effect on lateness/grace/priority/queue/parts rules. |

## 6. Verification
Full API vitest suite green (mileage-gate helper + walk-in + check-in/completion boundary specs updated and passing); API typecheck green.
