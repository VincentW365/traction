# Change Request — Service Catalog / Price List Integration + Job-Category Analytics

**CR ID:** CR-2026-019
**Author:** Vincent Wilson · **Date:** 2026-06-11
**Status:** APPROVED (design). Implementation gated and split into P1a → P1b → P1c; **P1a begins only on receipt of the price-list file**. This document is design/approval only — no schema, migration, importer, analytics, or UI is created by it.

---

## A. Objective
Give management analytics by **job category / classification** across both current (live) operations and the 9,055 imported historical jobs: which job categories are growing or shrinking, volume over time, **estimated** value where price data exists, seasonality, technician/job mix, and useful operational metrics for an automotive service centre.

We now have a **price list (jobs, prices, classifications)**. It is integrated as an **internal service catalog / classification reference for analytics and job categorization** — **not** as a parts/labor pricing workflow and **not** as invoice truth.

---

## B. Context & inspection findings
These findings drive every decision below (verified against the current codebase):

- **No pricing exists in the schema** except `PosReference.amount` (synced from the external POS). `ServiceType.family` (14 values: Service, Quick Service, Brakes, Tires, A/C, Diagnostics, Electrical, Cooling, Suspension, Engine, Transmission, Inspection, Cleaning, External) is the only category vocabulary today. `data/service_catalogue.csv` is the existing **operational** catalog and carries **no prices**.
- **Historical jobs have zero structured items.** Each of the 9,055 jobs is one `ServiceVisit` + one `ServiceOrder`; the service description is **free text** (`ServiceDetail(s) | Comment`) stored in `ServiceVisit.notes` **and** `ServiceOrder.notes`, with source metadata in `ExternalSystemRef.metadata` (system `SHAREPOINT_JOB_SHEET`). The historical source contains **no price/amount**. → historical categorization **requires text matching** against the preserved notes.
- **Live jobs are structured:** `ServiceOrderItem → ServiceType (.family)`. Live jobs categorize directly; only pricing needs a catalog link.
- **Reporting is ready to extend:** `ReportingService` already has `getServiceFamilyBreakdown` (groups by `st.family` via order items) and `getHistoricalAnalytics` (historical-only; deliberately omits service mix because historical has no items). `common/helpers/operational-scope.ts` provides `liveVisitSql` / `historicalVisitSql`. The web reports pages, the client-side `downloadCsv` pattern, `StatCard`/bar-row/table idioms, the `REPORT_VIEW` permission, and the sidebar nav pattern are all reusable.

---

## C. Key decisions (preserved)
1. **The price list becomes internal service catalog / reference data — not invoice truth.** Catalog prices are **estimated/catalog values**; real financial truth remains in the external POS (`PosReference.amount`).
2. **Parts and labor remain external-platform workflows.** BSOP does not become the source of truth for parts/labor pricing; `ExternalSystemRef` remains their home and is unchanged.
3. **Additive / non-destructive schema direction** — new objects only, no edits to existing columns/data:
   - `ServiceCatalogItem`
   - `ServiceJobMapping`
   - `ServiceMatchMethod` (enum)
   - `ServiceMatchStatus` (enum)
4. **Historical jobs map from preserved raw/free-text notes** (`ServiceVisit.notes` / `ServiceOrder.notes`); the raw text is **never overwritten** — the mapping stores a copy.
5. **Live jobs map from structured `ServiceOrderItem → ServiceType`** (category via `family`; price via the optional catalog↔ServiceType link).
6. **Exact / normalized matches may be auto-matched** (`AUTO_MATCHED`).
7. **Fuzzy matches go to a review queue only (`NEEDS_REVIEW`) — never auto-confirmed.**
8. **Unmatched jobs remain visible as `UNMAPPED`** (kept, surfaced in a review report, counted in unmapped count/% and unmapped revenue risk; never discarded).
9. **Estimated values must always be labelled as catalog/estimated value, not invoice revenue.**
10. **Work is split into three gated sub-packages:** **P1a** catalog import · **P1b** historical/live mapping · **P1c** analytics / UI / CSV.

---

## D. Proposed design — data model (additive; one migration per sub-package)

### `ServiceCatalogItem` — price list / catalog reference
`id` · `jobCode String?` (sku/code if present) · `name` · `normalizedName` (matching key) · `category` · `subcategory String?` · `basePrice Decimal(12,2)?` · `laborPrice Decimal(12,2)?` · `partsPrice Decimal(12,2)?` · `currency String?` (taken from the list; not assumed) · `effectiveFrom DateTime?` · `effectiveTo DateTime?` · `active Boolean = true` · `source String` (e.g. `PRICE_LIST_2026`) · `rawImportRow Json` (provenance) · `serviceTypeId String?` (optional → `ServiceType`, bridges live-job pricing) · `importBatchId String?` · timestamps.
Indexes: `normalizedName`, `category`, `jobCode`, `serviceTypeId`.
**Prices are estimated/catalog values — documented in-model as NOT invoice truth.** New price lists create new effective rows and supersede prior rows via `effectiveTo` (never destroyed).

### `ServiceJobMapping` — job → catalog mapping (one row per matched service segment; many per order)
`id` · `serviceOrderId String` (→ `ServiceOrder`) · `serviceOrderItemId String?` (→ `ServiceOrderItem`, live only) · `catalogItemId String?` (→ `ServiceCatalogItem`; null = unmapped) · `rawText String?` (matched snippet — a **copy**; source notes untouched) · `confidence Float?` · `matchMethod ServiceMatchMethod` · `status ServiceMatchStatus` · `reviewedByUserId String?` · `reviewedAt DateTime?` · `importBatchId String?` · timestamps.
Indexes: `serviceOrderId`, `catalogItemId`, `status`.

### Enums
- `ServiceMatchMethod { EXACT, NORMALIZED, FUZZY, MANUAL, NONE }`
- `ServiceMatchStatus { AUTO_MATCHED, NEEDS_REVIEW, CONFIRMED, REJECTED, UNMAPPED }`

*Rationale for a new table vs. extending `ServiceType`:* `ServiceType` is the operational scheduling template (duration/skills/bay) and must stay clean and price-free; the catalog carries prices, classification, effectivity, and raw provenance and may not map 1:1 to operational service types. The optional `serviceTypeId` link is the "hybrid" that bridges live jobs to pricing.

---

## E. Sub-packages (each: dry-run → review → approve → idempotent write + rollback)

### P1a — Catalog / price-list import  *(requires the price-list file)*
- Pure `catalog.mapper.ts` — normalize names, parse prices → `Decimal`, read category/subcategory/effectivity.
- Runner `import-catalog.ts`: **dry-run first** (summarize rows, distinct categories, duplicates, missing-price, invalid-price), then `--commit` (additive idempotent upsert keyed by `jobCode` else `normalizedName`, batch-tagged) + `--rollback <batchId>`. `rawImportRow` preserved. New list = new effective rows; prior superseded with `effectiveTo`.

### P1b — Historical / live mapping & backfill
- Pure `service-normalize.ts` — lowercase, strip punctuation, collapse whitespace, expand common abbreviations, **split multi-service text** on delimiters (`|`, `,`, `/`, `;`); similarity (trigram / token-set), threshold default **0.85**, stored in `BusinessRuleConfig` (explicitly approved here).
- Runner `map-jobs.ts`: **dry-run first** (counts: exact / normalized / fuzzy→review / unmapped; multi-service segment stats), then `--commit` (writes `ServiceJobMapping`, idempotent by `(serviceOrderId, segment-hash)` + batch) + `--rollback`.
- **Live** items map `EXACT` via `serviceType` → catalog `serviceTypeId`. **Conservative rule:** fuzzy → `NEEDS_REVIEW` only; **estimated revenue counts only `AUTO_MATCHED` (exact/normalized) or human-`CONFIRMED`.**
- A small `catalog` module exposes a **review-queue confirm/reject** endpoint (sets `status` + reviewer + `MANUAL`). **Source `notes` are never modified.**

### P1c — Analytics + UI + CSV (read-only)
- New `ReportingService` methods + `@RequirePermission(REPORT_VIEW)` routes, reusing `live/historicalVisitSql` and the valid-duration guard (`completed_at > started_at`).
- New web page **`/reports/service-mix`** (ADMIN/MANAGER) using existing `StatCard` / bar-row / table idioms + a **mapping-review** view for `NEEDS_REVIEW` / `UNMAPPED`; sidebar nav entry.
- **CSV exports** (category summary, job-trend summary, unmapped list) via the existing client-side `downloadCsv`. **No PII** in exports (categories / counts / values / technician names only).

---

## F. Analytics scope (delivered in P1c)
**A. Historical by category:** totals by category; monthly timeline by category; top growing / shrinking; top recurring; job-mix by month; **estimated** historical revenue (acceptable-confidence matches only); unmapped count + %.
**B. Live by category:** live service mix; completed this week/month; category demand; **estimated** value of completed work (priced); comparison vs historical baseline.
**C. Trends:** month-over-month growth; rolling 3-month; year-over-year (history spans ~Oct 2023 → Jun 2026 ≈ 32 months → feasible); rising / declining categories; seasonal peaks; top-10 by volume; top-10 by **estimated** value; low-volume/high-value; high-volume/low-value.
**D. Operational/business:** average service duration by category (valid timestamps only); rework rate by category; pause / waiting-parts rate by category; technician workload mix by category; completed vs cancelled by category; classification coverage; **unmapped revenue risk**; services with missing/stale prices; categories with rising demand (parts-stock / technician-capacity hint).

All monetary outputs are labelled **estimated / catalog value**, never invoice revenue.

---

## G. Impacted modules & data
- **New:** `ServiceCatalogItem`, `ServiceJobMapping` tables + 2 enums (additive migrations); `data-import` mappers + scripts; a small `catalog` module; reporting methods/routes; one new web reports page (+ mapping-review view); sidebar entry.
- **Read-only touched:** historical `ServiceVisit`/`ServiceOrder` notes (read for matching — never written); `ServiceType` (read for live categorization + optional catalog link).
- **Untouched:** queue ranking, ETA, scheduling, Rule 3, transport, notifications, deployment, POS/invoicing, and external parts/labor workflows.

---

## H. Risks / tradeoffs
- **Sparse/noisy historical free text → low auto-match rate / large review queue.** Mitigation: conservative matching + review queue + unmapped surfaced; never overstate revenue.
- **Estimated price ≠ invoice amount** (core guardrail) → all values labelled "estimated/catalog"; real money stays in the external POS.
- **Multi-service segmentation is imperfect** → keep raw text + human review; idempotent re-run.
- **Price-list format unknown until provided** → P1a parser finalized against the real file behind a dry-run gate.
- **Early-period coverage** (partial 2023) → label YoY/seasonality confidence.
- **Scale** → additive tables + indexes; 9,055-row matching via batch dry-run; analytics are read-only aggregates.

---

## I. Tests / validation (per sub-package)
- API typecheck + Web typecheck.
- Unit tests for normalization & matching (`service-normalize`), catalog parsing (`catalog.mapper`).
- Import dry-run tests; mapping dry-run tests (count breakdowns, multi-service split).
- Analytics tests (scope: live vs historical; estimated-value confidence gating; unmapped counts).
- Read-only live local smoke on a disposable/scratch basis; confirm no unrelated modules changed.

---

## J. Guardrails (binding)
Additive / non-destructive only; **never overwrite historical raw notes** (mapping stores a copy); **fuzzy never auto-confirmed**; estimated values always labelled (price ≠ invoice); **no PII in exports**; **no changes** to queue ranking / ETA / scheduling / Rule 3 / transport / notifications / deployment / external parts-labor; **no POS/invoicing**; prices treated as catalog/estimated unless the business confirms otherwise.

---

## K. Approval gate & sequencing
This is a **Mandatory Review Trigger** (schema additions + new analytics + new import/mapping pipeline) — covered by this approved CR. Sequencing:
1. **(this step) Documentation** — `docs/48` (no code).
2. **P1a** — begins **on receipt of the price-list file**; dry-run first, pause before any DB write.
3. **P1b** — after P1a; dry-run first.
4. **P1c** — after P1b; read-only analytics/UI/CSV.

**The price-list file is required before P1a coding** (to finalize the parser's column mapping and validate prices). Each sub-package pauses for review and commits only explicitly-named files; no push, no remote.

---

## L. P1a — Real workbook inspection, locked decisions & dry-run (2026-06-11)

**File:** `SERVICE CENTER PRICE LIST UPDATE 2026.xlsx` (kept **outside the repo**; never committed). 18 tabs — a mixed, human-authored workbook, not a clean table.

**Sheet roles:**
- **Import source = the 13 category tabs** (category = the tab name): SERVICE, ENGINE & OTHER, FULL SERVICE, TRANSMISSIONS, FUEL FILTERS, RADIATOR, ENGINE MOUNTS, SUSPENSION, BRAKES, STEERING, DRIVETRAIN, LIGHTING & BODY, CAR CARE.
- **`MASTER PRICE LIST`** — cross-check only (no category column), not imported.
- **Excluded:** `CAR CLASSIFICATION` (6,603 vehicle rows), `Job Classification`, `Sheet1`.
- **`Sheet2` = PII** (staff names / DOB / emergency contacts) — **never parsed, logged, exported, or used as a test fixture.**

**Column layout (category tabs + master):** ~10 boilerplate rows, then a header `TYPE OF SERVICE | PRICE | _ | _ | _ | NEW PRICE | TAX PRICE | COMMENTS`, then data. **No job/SKU code** (name-only).

**Locked column mapping → `ServiceCatalogItem`:** `name` = col B; `category` = tab name; **`basePrice` = col F** (current pre-tax estimate); **`priceTaxInclusive` = col G**; **C, D, E, F, G, H + comment preserved verbatim in `rawImportRow`**; col H is preserve-only; `currency = "JMD"`; `jobCode`/`subcategory`/`laborPrice`/`partsPrice` = null (no code, no split). Blank/zero price → null; float artifacts rounded to 2 dp. **Duplicate names are kept as distinct variants;** only EXACT full-row repeats dedupe via `rowHash`.

**Schema (additive, design only — NOT applied during dry-run):** new `service_catalog_items` table + migration `20260611120000_service_catalog_item`. No ALTER to existing tables; no `ServiceJobMapping` (that is P1b).

**Dry-run result (parser run against the real file; NO DB writes, NO PII):**
- 13/13 category tabs parsed; **206 rows**. `Sheet2` present in the workbook but **read: NO**.
- basePrice/tax verified (e.g. base 900 → tax 1035; base 1300 → tax 1495 = ×1.15 GCT).
- **2** rows missing a base price (kept, flagged), **0** zero-as-null in base, **0** non-numeric base, **197** float cells rounded to 2 dp, **0** exact full-row duplicates, **9** same-name variants kept.
- 204/206 with base + tax-inclusive prices.
- Cross-check vs MASTER: 194 of 197 imported distinct names also appear in MASTER (3 not in master; 12 master names not in the category tabs).

**Status:** P1a parser + dry-run + tests delivered. **No catalog rows written to the DB; migration not applied; `--commit` is gated** pending review of this dry-run.
