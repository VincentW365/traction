# Change Request — ETA Average Isolation (live-by-default, historical fallback)

**CR ID:** CR-2026-007
**Author:** Vincent Wilson · **Date:** 2026-06-09
**Status:** **DRAFT — not implemented.** Awaiting review/approval under `docs/21_Approval_Gates.md`.
**Builds on:** CR-2026-006 (operational scope filtering). Resolves the deferred follow-up `docs/29` item 2.5 (and `docs/33` §3a).

> ⚠️ This is an **ETA / queue-display change** and therefore a **Mandatory Review Trigger** (CLAUDE.md §9: "any change to ETA"). It is documented here for approval **before** any code is written. No implementation has been done.

### Reviewer position (2026-06-09 — Vincent Wilson)
Status remains **DRAFT / awaiting formal approval**, but the design direction is endorsed:
- ✅ Approve the overall design direction (live-by-default, historical small-sample fallback).
- ✅ Keep the proposed defaults: **30-day** live window, **20-order** minimum live sample.
- ✅ Defer outlier trimming for v1 (revisit later if needed).
- ✅ No queue / ranking / scheduling / bay / assignment logic changes.
- ✅ No schema migration — only `BusinessRuleConfig` values, and only if/when implementation is approved.

---

## 1. Change Summary
Isolate the queue board's average-service-time figure so it reflects **today's live operating conditions by default**, while still allowing the imported historical dataset to assist **only as an explicit, audited fallback** when the live sample is too small to be reliable.

Concretely, change `QueueService.getAvgServiceMinutes(siteId)` from "average of **all** completed service orders for the site" to a two-tier computation:
1. **Primary (default):** average of **live** completed service orders only — exclude `HISTORICAL_IMPORT` visits (reuse the CR-2026-006 `operational-scope` helper) and bound to a recent rolling window.
2. **Fallback (only if primary sample < threshold):** fall back to historical/all-time data to produce an early-pilot estimate, and **flag** that the figure is historical-derived.
3. **Final fallback:** the existing hard-coded default (currently 30 min) if neither tier has data.

## 2. Why the Change Is Needed
- `getAvgServiceMinutes` currently aggregates every completed `service_order` joined to `service_visits` for the site with **no status/ticket/recency/source scope**. After the historical import (~9,055 terminal visits), historical orders dominate the sample and skew the average that drives the live board ETA (`estimatedWaitMinutes = queueRank × avgServiceMinutes`, `queue.service.ts:68–69`, also consumed at `:475`).
- CR-2026-006 deliberately did **not** touch this because it feeds ETA (out of that CR's scope). This CR is the dedicated, reviewable ETA change.
- **Business goal:** ETA should reflect current bay throughput, crew, and mix — not a back-loaded historical book — while the historical data still provides a sane estimate during the early pilot when live volume is thin.

## 3. Recommended Approach (for approval)
**Live-by-default, historical-fallback only on small live sample.**

- **Primary sample (live):**
  - `service_orders` with `started_at` and `completed_at` set,
  - joined visit is **not** `HISTORICAL_IMPORT` (reuse `liveVisitSql('sv')` from `common/helpers/operational-scope.ts`),
  - within a **rolling recency window** (proposed default **30 days**),
  - optionally trimmed for outliers (e.g. ignore durations above a sane cap) — TBD, see §6.
- **Sample-size gate:** if the live sample count `< MIN_LIVE_SAMPLE` (proposed default **20** completed orders), the live average is considered unreliable.
- **Fallback (historical):** when the gate fails, compute the average over the broader/all-time set (the current behavior) to produce an early-pilot estimate. Return a marker indicating the source used.
- **Final fallback:** if even the fallback has no rows, keep the existing constant default (30 min).
- **Explainability:** return not just the number but the **source** (`LIVE` | `HISTORICAL_FALLBACK` | `DEFAULT`) and the sample size, so the board/manager view can indicate when an ETA is historically derived (and so the decision is auditable per CLAUDE.md §5/§10). Surfacing this in the UI is optional and can be a thin follow-up.

### Configurability (no hard-coded magic — CLAUDE.md §10)
Both knobs must be config, not inline constants, via `BusinessRuleConfig` (site-aware), with documented defaults:
- `eta_avg_live_window_days` (default 30)
- `eta_avg_min_live_sample` (default 20)
- (optional) `eta_avg_outlier_cap_minutes`

## 4. Files / Modules Impacted
- `apps/api/src/modules/queue/queue.service.ts` — `getAvgServiceMinutes` (logic + signature/return shape if exposing source), and its two call sites (`getBoard` ~`:51`, and ~`:475`).
- `common/helpers/operational-scope.ts` — **reuse only** (`liveVisitSql`); no change expected. If a recency/window SQL fragment is shared, it would be a small additive helper.
- `BusinessRuleConfig` seed/config — add the new rule keys + defaults (data/config, not schema).
- Tests: `modules/queue/__tests__/avg-service-minutes.scope.spec.ts` (new) — mocked Prisma, assert: live-only by default; historical fallback engages below threshold; source flag correct; final default when empty; window/threshold honored.
- Docs: this file; resolve `docs/29` item 2.5 on completion.

## 5. Rule Impact
- Touches the **ETA presentation rule** only (estimated wait shown on queue/board surfaces). 
- **Does not** change queue **ranking**, priority classes, scoring inputs, scheduling eligibility, bay/tech assignment, overrides, or any write path. `queueRank` is unchanged; only the minutes-per-position multiplier becomes live-aware.
- Express the rule per CLAUDE.md §6:
  - **Rule:** ETA uses the average duration of recent live completed orders.
  - **Example:** 25 live orders in the last 30 days averaging 42 min → position 3 shows ~126 min.
  - **Exception:** fewer than 20 live orders → use historical average, flagged as historical.
  - **System response:** compute primary; if under threshold, fall back; else constant default; return source + sample size.
  - **Configurable?** Yes — window, threshold (BusinessRuleConfig).
  - **Approval needed?** Yes (ETA change).

## 6. Schema / API Impact
- **Schema:** none (no migration). Uses existing `service_orders` / `service_visits` columns and `BusinessRuleConfig`.
- **API:** `getAvgServiceMinutes` is currently private/internal. If we surface the source/sample-size on the board response (`estimatedWaitMinutes` is already returned), that's an **additive** field (e.g. `etaBasis: 'LIVE' | 'HISTORICAL_FALLBACK' | 'DEFAULT'`) — backward compatible. OpenAPI updated if exposed.
- **Open question (for review):** outlier trimming — include in v1 or defer? Recommend a simple upper cap behind a config key, off by default, to avoid scope creep.

## 7. Risks / Tradeoffs
- **ETA shifts visibly** the moment this ships (live averages differ from the historical-inflated number). Expected and desired, but it is a user-facing change — communicate to front desk.
- **Small-sample volatility:** a 30-day live window early in the pilot may swing; the threshold + historical fallback mitigate this, but the window/threshold defaults may need tuning (hence configurable).
- **Two code paths** add a little complexity; covered by tests and the explicit source flag.
- **No regression to ranking/scheduling** — strictly the display multiplier. Verified by leaving `queueRank` and all scheduling logic untouched.

## 8. Tests / Validation
- Unit (mocked Prisma): live-only filter present by default; fallback triggers only when live count < threshold; correct source flag + sample size; final constant default on empty; window and threshold read from config (with documented defaults when config absent).
- Full API suite + `tsc --noEmit` green.
- If a seeded DB is reachable (read-only): compare board ETA before/after on a site with historical + a few live orders; confirm ranking/order of tickets is unchanged (only the minutes differ).

## 9. Proposed Effective Phase
**Phase 5** (advanced reporting / forecasting candidates) — deterministic refinement of an existing estimate, not a new predictive model.

## 10. Approval Needed?
**Yes.** ETA/queue-display change → Mandatory Review Trigger (CLAUDE.md §9). Requires sign-off under `docs/21_Approval_Gates.md` before implementation. Use this CR (and `templates/Change_Request_Template.md`) as the review artifact.
