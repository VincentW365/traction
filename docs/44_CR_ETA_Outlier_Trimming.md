# Change Request — ETA Outlier Trimming (config-driven)

**CR ID:** CR-2026-015
**Author:** Vincent Wilson · **Date:** 2026-06-10
**Status:** IMPLEMENTED (pending review/commit).
**Builds on:** CR-2026-007 (ETA average isolation). Resolves the deferred outlier-trimming follow-up.

---

## A. Objective
Improve live ETA accuracy by excluding absurd durations from the queue-board ETA average. **Config-driven and disabled by default** — when unconfigured, behavior is unchanged. Read-only on historical data; does not alter scheduling/ranking.

## B. Approach (per CR-2026-007's deferred design)
- New optional `BusinessRuleConfig` key **`eta_avg_outlier_cap_minutes`** (site-aware), read via the existing `readEtaConfigNumber` helper (same direct-read used for window/threshold). **Absent or ≤0 ⇒ no trimming.**
- When configured (>0), the ETA average is restricted to **valid durations in `(0, cap]`** — trimming absurd-high outliers *and* the nonsensical non-positive durations present in some historical rows. Applied symmetrically to **both** the live (Tier 1) and historical-fallback (Tier 2) averages.

## C. Changes
`apps/api/src/modules/queue/queue.service.ts` — `getAvgServiceMinutes`:
- Reads the cap (default `ETA_DEFAULT_OUTLIER_CAP_MINUTES = 0`); builds a conditional `Prisma.sql` fragment (`Prisma.empty` when disabled) and interpolates it into both `$queryRaw` blocks; logs when applied. `AvgServiceResult` shape unchanged (no `getBoard`/`getPublicDisplayBoard` mapping change).

## D. Guardrails honored
- Only the **displayed ETA multiplier** is affected, and only when the cap is configured. `queueRank`, ranking, scheduling, assignment, dispatch, Rule 3 untouched. No schema migration, no writes, no historical-data mutation. Raw SQL uses hard-coded predicates; the cap value is **parameterized** (`${outlierCap}`).

## E. Config
| Key | valueJson | Effect |
| --- | --- | --- |
| `eta_avg_outlier_cap_minutes` | a positive number (minutes) | Exclude orders whose duration is ≤0 or > cap from the ETA average. Absent/0 → no trimming (default). |

## F. Tests / verification
- `eta-average.scope.spec.ts` extended: cap key is read; the cap predicate + parameter (`90`) appear in **both** tier queries when configured; **no** cap clause when the key is absent (default unchanged). `vitest run eta-average` 7/7; `tsc --noEmit` 0.
- Optional scratch check: with the historical-heavy fallback, setting the key lowers the average (outliers/negatives excluded); omitting it leaves the average unchanged.

## G. Approval gate
ETA-display change, but the mechanism (CR-2026-007) was already approved; this only adds the deferred, off-by-default cap. No schema/Rule-3/ranking change. Normal feature CR.
