# 24 — Handoff: Status & Open Decisions (for external review)

> Self-contained briefing for a second AI/reviewer. Captures what the project is,
> what's been done, what's in flight, and the decisions that need resolving.
> Date: 2026-06-09.

---

## 1. What the project is

**BSOP ("Traction")** — a unified **service operations platform** for **Bert's Auto Parts Service Centre** (auto repair shop, Jamaica). One platform, multiple modules, one central **scheduling brain**.

- **Stack:** Modular monolith. Next.js + TypeScript (web), NestJS + TypeScript (API), PostgreSQL + Prisma, Socket.IO realtime, REST API. Monorepo (`apps/web`, `apps/api`, `prisma`).
- **Maturity:** Already built well past MVP — ~50 Prisma models; modules for appointments, queue, scheduling engine (deterministic: hard-constraint filter → priority class → weighted rank → tech/bay match → ETA → decision snapshot), check-in, service orders, technicians, resources/bays, parts, transport, notifications (SMS/email adapter, currently stubbed), maintenance reminders, reporting, audit, and a public per-customer status page.
- **Governance (important):** The repo has a strict operating charter (`CLAUDE.md`). Notably **§9 "Mandatory Review Triggers"** requires stopping for written approval (ADR/Change Request) before changes to: core-entity schema, appointment priority logic, grace/lateness rules, queue ranking, fast-track/batching, auth model, parts-blocking, audit weakening, etc. Scheduling rules must be **deterministic and auditable**; business-rule values live in a `BusinessRuleConfig` table, not hard-coded.

## 2. Real-world inputs we're working from

**(a) A DMAIC document** (from the shop's process analyst) defining the actual requirements. Key facts:

- **Equipment (real):** 2 Stands (any vehicle/any job), 2 Mobile Jacks (**sedan-class only**, weight limit), 1 Power Wash bay (cleaning only, must be "operational"), Machine Shop (**external** — never internally bay-scheduled).
- **7 scheduling rules the app must enforce:**
  1. No same-day scheduling after **10:00 AM** without manager override.
  2. Job completed before **12:00 PM** triggers an automated follow-up email.
  3. Mobile jack only for sedan-class vehicles.
  4. Cleaning jobs only to the power-wash bay, only if machine operational.
  5. Mileage recorded only for "service"-category jobs.
  6. External machine-shop jobs logged separately, never bay-scheduled.
  7. Service-due reminder = last service date + interval.
- **Other features:** customer-facing queue visibility (public link, no login), staff scheduling dashboard, automated email at each status change, midday follow-up trigger.

**(b) SharePoint operational data** — the shop's live "Service Center: Job Sheet" (9,068 rows, ~2.5 years).

## 3. What we've DONE

1. **Reconciled DMAIC vs. the existing build.** The platform already satisfies ~80% of the DMAIC (equipment model, rules 1/3/4/6/7, service catalogue, notification triggers, public status page). Decision taken: **keep the full platform; treat the DMAIC's 7 rules as the pilot launch/acceptance checklist** (do not trim the build).
2. **Seeded real reference data** from the SharePoint export: the real **12-technician roster** (replacing placeholders) and aligned the **oil-type** options to actual values (Regular Oil, Liqui Moly, Amsoil). Note: real per-technician **skill matrices are unknown** (not in the data) — all seeded with a baseline skill only.
3. **Built a public waiting-room display board** (new feature, requested by the manager): a kiosk/wall-TV screen showing the live queue (In Queue / In Service / Ready) — token-gated (no login), PII-safe (ticket numbers only, no names/plates), realtime via existing Socket.IO gateway. Public route `app/display/[token]`, new sanitized API endpoint.
4. **Extracted the full job history from SharePoint** (a multi-step saga — see §5). Result: **`jobs.csv`, 9,055 rows** (99.9% of the list). Built a reusable, dependency-free extractor (`scripts/sharepoint/json-to-csv.mjs`) that handles SharePoint's owssvr XML / OData Atom / REST JSON formats.
5. **Generated a baseline analytics report** (`docs/23`, reproducible via `scripts/sharepoint/analyze-jobs.mjs`).

## 4. Key findings from the real data (baselines)

- **~274 jobs/month**, steady, slight upward trend. **Saturday busiest** (1,760 vs ~1,450 weekdays); Sunday closed.
- **98.4% completion**, 0.9% cancellation.
- **Service mix:** Brakes 16%, Shocks/Suspension 15%, Filters 10%, Oil/Service 8%. Oil/lube on ~51% of jobs. **48% of service descriptions are unstructured free-text** (no clean category).
- **Pauses on 17.3% of jobs (1,564).** Rework ("rectify") on 30 jobs.
- **3,728 distinct customers**; ~45% one-visit, ~39% repeat (2–5 visits).
- **Mileage data is unreliable** (54 readings > 400,000).

## 5. The data-access constraint (critical context)

- The job sheet is **readable**; we pulled it fully via the SharePoint REST API in the developer's signed-in browser (Export-to-CSV blanks lookups; owssvr/Export-to-Excel is disabled on the tenant).
- **BUT the customer/vehicle master list is ACCESS-DENIED** to the developer's account — via direct read *and* via lookup `$expand`. So **customer names and vehicle models are unavailable.** Jobs are keyed only by an anonymous `CustomerNo` id.
- The developer **cannot request access changes or exports from anyone else** — current access is the ceiling. PnP PowerShell won't help (same identity → same denial).
- Consequence: any historical import is **name-less** (`Customer #<id>`), and vehicle-class (sedan vs non-sedan) — which drives the mobile-jack rule — is **not derivable from the data**.

## 6. OPEN DECISIONS (what we need to reason out)

For each: the issue, our current lean, and why it's open.

### A. Pause/Resume + Rework in the job state machine  *(needs §9 approval)*
- **Issue:** The live `ServiceOrder` state machine has no generic **PAUSED** state (only WAITING_PARTS / WAITING_CUSTOMER) and **no rework/rectify path** (QC only moves forward). The real data shows **17.3% of jobs pause** and a business rule (TECH-003) already requires pauses be recorded.
- **Our lean:** Add a first-class pause/resume (with timestamp capture) and a QC→rework loop. This is a core-entity + state-machine change → governance requires a written change request first.
- **Open:** exact state model (single PAUSED state + reason code? separate paused-clock?), how rework is modeled (re-open vs. new linked order), audit/timestamp design.

### B. Rule 2 — midday follow-up semantics
- **Issue:** DMAIC says "job **completed** before 12:00 PM → follow-up email." Current code triggers for jobs **in queue** before noon, not jobs **completed** before noon. Semantics mismatch (touches notification behavior).
- **Our lean:** Correct it to fire on completion-before-noon. Small but needs sign-off (notification behavior).

### C. Rule 5 — mileage gate enforcement
- **Issue:** A `requiresMileage` flag exists but isn't enforced server-side; mileage can be recorded on non-service jobs.
- **Our lean:** Enforce at the write boundary. Low risk.

### D. Historical data import — whether/how
- **Issue:** We have 9,055 historical jobs but **no customer names/models**. Should we import them into the operational DB (as anonymous `Customer #id` + placeholder vehicles + historical ServiceVisit/ServiceOrder records), keep them as an analytics-only dataset, or both?
- **Our lean:** Analytics value is clear (already done). Operational import is questionable without identity. Leaning: defer operational import until/unless identity is unlocked; keep analytics.
- **Open:** Is name-less historical data worth importing operationally (for reporting screens / realistic dev data), or does it pollute core tables? How to model an anonymous customer/vehicle cleanly?

### E. Customer identity — how to ever unlock it
- **Issue:** Names/models are behind a permission wall the developer can't change and can't ask others to change.
- **Options to weigh:** (i) accept name-less permanently and design around `CustomerNo` as the stable key; (ii) capture identity **going forward** via the new platform's own intake (ignore historical names); (iii) some future access grant.
- **Our lean:** Design the platform so `CustomerNo` is a first-class external reference, and **capture fresh identity at intake** rather than depending on the locked history.

### F. Vehicle weight-class auto-population
- **Issue:** The mobile-jack rule needs sedan vs non-sedan, but the data doesn't carry vehicle class, and a make/model lookup exists but isn't auto-applied.
- **Our lean:** Capture class at intake (front-desk picks sedan/SUV/truck), with the lookup as a suggestion. Minor.

### G. Free-text service entry
- **Issue:** 48% of historical service descriptions are unstructured. The platform has a structured `ServiceType` catalogue that fixes this going forward.
- **Open:** Do we attempt to back-classify historical free-text (for analytics), or only enforce structure going forward? (Low stakes.)

## 7. Specific questions for the external reviewer

1. **State machine (A):** best-practice model for pause/resume + rework in a service-order lifecycle that must stay auditable and deterministic? Single PAUSED state with reason codes vs. orthogonal "paused" flag with a separate clock? How to represent rework without losing original-work history?
2. **Historical import (D):** given no customer identity, is an operational import worth it, or analytics-only? If imported, how to model anonymous customers/vehicles so real identity can be merged in later without rework?
3. **Identity strategy (E):** is "capture fresh at intake, treat `CustomerNo` as an external ref, don't depend on locked history" the right call? Any cleaner pattern?
4. **Sequencing:** of the open items (A–G), what order maximizes value for a pilot launch, given the DMAIC's 7 rules are the acceptance checklist?
5. Anything we're missing or getting wrong in the reasoning above?

## 8. Pointers (repo files, for context)

- `CLAUDE.md` — governance charter (esp. §9 review triggers).
- `docs/22_SharePoint_Data_Request.md` — full extraction story + how to unlock identity later.
- `docs/23_Baseline_Operations_Analytics.md` — the baseline report.
- `prisma/schema.prisma` — data model (~50 models).
- `apps/api/src/modules/service-orders/service-orders.service.ts` — current state machine.
- `scripts/sharepoint/` — the extractor + analytics tooling.
