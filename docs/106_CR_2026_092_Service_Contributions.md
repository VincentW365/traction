# CR-2026-092 — service contributions, the four codes resolved, and visual evidence

**Status:** Implemented — schema, engine, backend, admin screen, work-order UI,
visual-QA route and screenshot capture.
**Local commits only, not pushed**, per the standing directive.

Closes the four deferrals from
[CR-2026-090 §2](104_CR_2026_090_KPI_Operational_Integration.md) and
[CR-2026-091](105_CR_2026_091_Pending_Benchmark_Review.md).

---

## 1. What the catalogue actually says

Every decision below came from inspecting the real rows, the imported price list and
historical usage, rather than from preference.

| Code | Exact name | Family | Duration | Work-order lines | Appointment lines |
|---|---|---|---|---|---|
| `FUEL-FLT-01` | Fuel Filter Change | Service | **30 min** | 0 | 0 |
| `BRK-01` | Brake Inspection | Brakes | **30 min** | 3 | 2 |
| `EST-01` | Estimate / Inspection | Service | **30 min** | 0 | 0 |
| `TIR-01` | Tire Rotation | Quick Service | **25 min** | 0 | 0 |

All four durations are valid, so **no provisional allowance was needed**. The
provisional path exists, is seeded automatically when a catalogue duration is missing
or zero, and is flagged in the admin screen — it simply did not fire here.

The imported price list (206 rows) supplied the decisive evidence:

- **Brakes are already distinguished by the shop.** Separate lines exist for
  "To R/R DISC PADS", "To R/R DISC PADS **rear electronic**", "R/R BRAKE SHOE"
  (drums), "BRAKE FLUID FLUSH", "To R/R Disc Rotors" and "To Clean & Adjust Brakes".
  Axle *and* work type are real distinctions in this business.
- **"Rotate Tyres" is its own billable line**, so a rotation is chargeable work, not a
  courtesy check.
- **No estimate or quotation line exists at all.**

---

## 2. The six contribution modes

The old model had two answers: identifies a manager package, or makes the job custom.
Most real work is neither, and forcing it into one of those two is what left ordinary
jobs unrateable.

| Mode | Meaning |
|---|---|
| `PACKAGE_COMPONENT` | Identifies General Service / Front Brakes / Spark Plugs |
| `INCLUDED_IN_BASE` | Already inside the package allowance — adds nothing, and does **not** knock the job out of its package |
| `ADDITIVE_STANDARD` | Genuine extra technician work — its duration is **added** to the standard |
| `SEPARATE_SLA` | Tracked operationally, outside technician repair time — neither extends the standard nor voids it |
| `CONDITIONAL` | Resolves via a structured qualifier, and never stays unresolved once one is supplied |
| `CUSTOM_ONLY` | Genuinely bespoke. **Exactly one** service qualifies (`MSHOP-01`, external machine-shop work) |

Duration sources: `MANAGER_PACKAGE`, `SERVICE_CATALOG_DURATION`,
`FIXED_CONFIGURED_DURATION`, `NO_DURATION`.
Allowance bases: `PER_JOB` (default), `PER_SERVICE_LINE`, `PER_UNIT`.

`PER_UNIT` is the only basis that multiplies, and only where the catalogue prices work
per unit. Quadrupling a whole-job rotation because a car has four wheels is precisely
what it exists to prevent.

---

## 3. A manager package requires a General Service

The rule running through everything. Front-brake work on its own is **not** "General
Service + Front Brakes" — it is a brake repair, measured against the brake catalogue
time. Giving it the package allowance would hand a technician ninety minutes of
general-service time nobody asked them to spend.

Every snapshot now records **where its standard came from**:

| Source | Meaning |
|---|---|
| `MANAGER_PACKAGE` | The matrix alone |
| `MANAGER_PACKAGE_PLUS_ADDITIVES` | Package plus approved additive work |
| `CATALOG_COMPOSITE` | No General Service — built from catalogue standards |
| `MANAGER_CUSTOM` | A manager-approved standard for this job |
| `NOT_TECHNICIAN_RATED` | Not technician repair work |

"Standard 120 minutes" is unreadable without this: it could be a Sedan General Service
package, or a standalone repair whose catalogue times happen to sum to the same figure.

### The formula

```
manager-package job:   final = packageStandard + Σ(additive minutes)
no general service:    final = Σ(applicable catalogue standards)
```

Counted only when the line is approved, performed and not cancelled, declined,
deferred or awaiting approval. Never counted: administrative lines, duplicate aliases,
or the same component twice.

---

## 4. The four resolutions

### FUEL-FLT-01 → `ADDITIVE_STANDARD`, catalogue duration, `PER_JOB`

Distinct from `OIL-FLT-01` "Oil Filter Change" (20 min), which *is* the ordinary filter
absorbed by an oil change.

> **Noted for management, not acted on.** The price list carries "Engine Tuneup –
> Engine Oil, Oil Filter, Ac Filter, Air Filter; **Fuel Filter**" as a single FULL
> SERVICE line, so the shop's own full-service package does include a fuel filter. That
> package is a larger thing than the manager's 90-minute General Service, whose activity
> list says only "filters". The directive locks this to ADDITIVE_STANDARD and it is
> implemented that way; if management decides otherwise the admin screen changes it with
> an effective date and no code change.

### BRK-01 → `CONDITIONAL` on the brake qualifier

Not mapped unconditionally to Front Brakes. Resolution rules, all tested:

| Situation | Result |
|---|---|
| Front **pads** + General Service | Front Brakes package component, **no extra minutes** |
| Front pads, **no** General Service | Own catalogue duration |
| **Rear** pads | Additive |
| **Shoes** (either axle) | Additive — never Front Brakes |
| Rotor / disc / fluid / bleed / other | Additive |
| **Inspection only** + General Service | Included, zero minutes |
| Inspection only, standalone | Own catalogue standard |

**Both axles selected produce TWO contributions.** The UI may offer both; the backend
resolves them into separate front and rear work with separate allowances.

### EST-01 → `ADDITIVE_STANDARD` (the directive's diagnostic-work case)

Repository inspection settles it as **technician work, not quotation preparation**:

- it requires a bay (`requiredBayType: GENERAL`) and sets `mobileJackAllowed` — an
  administrative quote needs neither a ramp nor a jack;
- it carries a technician skill code (`GENERAL`), which is what the scheduling engine
  matches technicians on;
- it has a real 30-minute duration and is bookable as a work-order line, and every
  `ServiceType` on an order draws a technician and a bay;
- the platform's actual quoting path is elsewhere — inspection recommendations with
  customer decisions (CR-2026-034) — and does not use a `ServiceType`;
- the price list contains no estimate or quotation line at all.

`SEPARATE_SLA` remains implemented and tested for genuine advisor activity. No
catalogue service currently qualifies, which is a finding rather than a gap.

### TIR-01 → `CONDITIONAL` on the tyre operation, `PER_JOB`

| Operation | Result |
|---|---|
| Pressure / tread check + General Service | Included, zero minutes |
| Pressure / tread check, standalone | Own catalogue standard |
| Rotation, balance, alignment, puncture repair, replacement, other | Additive (25 min) |

Tyre work found during inspection counts only once the customer approves it and it
becomes a real order line. A declined or deferred recommendation never changes the
benchmark.

### Aliases

`DISC-01`, `BRK-01` and `BRK-02` can all represent front-pad work and all map to the
same Front Brakes component. The component counts **once**; three codes never earn
three allowances. Original service codes stay on the work order and the canonical
component is held separately.

`DISC-01` is marked `isSupersededCode` — it has never appeared on a work order in the
entire history, while `BRK-02` is what the shop books. Historical lines stay intact and
resolvable; nothing was rewritten.

---

## 5. Qualifiers are captured before the work, not after

The failure this prevents: discovering at submit-to-QC that a brake line never said
which axle. By then the technician has done the work and the job cannot be rated, which
reads to them as punishment for a form they never saw.

- Conditional services prompt for their qualifier **immediately**, with controlled
  radios and selects. No free text — the qualifier decides which benchmark applies, and
  "front pads (I think)" is not something a calculation can act on.
- The calculated KPI effect is shown **before** confirming.
- Validation is server-side (`PATCH /service-orders/:id/items/:itemId/qualifiers`).
- **Start Work runs a final readiness check** and refuses with an actionable message
  naming the service and the missing answer, which a service advisor or manager can
  supply on the spot.
- Legacy open jobs are asked at the next edit, approval or Start Work. Completed
  historical work orders are never altered.

---

## 6. Scope changes keep their history

A service added or removed before completion recalculates the standard, **preserves the
previous calculation as a revision** with actor, reason and timestamp, and leaves
elapsed time untouched — the scope changed, the clock did not restart.

After first submission to QC the benchmark is not silently altered; correction requires
manager authorisation and a reason, and both results are preserved.

Rating arithmetic is unchanged and uses the final standard:

```
variance = kpiCompletionMinutes − finalStandardMinutes
≤0 Excellent · 1–30 Meets Target · 31–60 Needs Improvement · >60 Below Standard
```

The manager's absolute completion-time rating remains separate and is never merged with
the adjusted one.

---

## 7. Preventing the next unmapped service

`scripts/verify-kpi-contributions.mjs` exits non-zero when:

- any of the four named codes has no active policy;
- **any active service** has no contribution policy;
- a policy takes its minutes from the catalogue but the catalogue has none;
- a conditional service names no qualifier;
- a fixed-duration policy has no configured minutes.

Current output: **31 active services, 33 active policies, 0 provisional, OK.**

---

## 8. Visual evidence

My earlier claim that this machine had no browser automation was wrong: **Playwright
was already a root devDependency**, with browsers under `%LocalAppData%\ms-playwright`.
It is reused rather than replaced, with a documented `chrome-cli` fallback that detects
Edge or Chrome directly.

- Route: `/dev/visual-qa/kpi` — 21 KPI states on synthetic data.
- Gated on `NODE_ENV !== 'production'` **and** `ENABLE_VISUAL_QA=true`; 404 otherwise.
  Verified both ways.
- No live API calls, no real names, plates or phone numbers.
- `scripts/capture-kpi-screenshots.mjs` probes the route first, captures at 1440×1200
  and 390×844, prints the browser executable used, and exits non-zero on any failure —
  capturing a 404 would produce a real PNG of an error page, which is worse than
  failing because it looks like evidence.
- Output to `artifacts/kpi-visual-evidence/` (gitignored).

---

## 9. Data model

| Change | Purpose |
|---|---|
| `KpiContributionMode`, `KpiDurationSource`, `KpiAllowanceBasis`, `KpiRequiredQualifier` | The policy vocabulary |
| `BrakeAxle`, `BrakeWorkType`, `TireOperation` | Structured qualifiers |
| `KpiBenchmarkSource` | Where a standard came from |
| `KpiServiceComponent` + 8 columns | The contribution policy, on the existing effective-dated table rather than a parallel one |
| `ServiceOrderItem.brakeWorkType / tireOperation / unitQuantity` | Qualifiers on the line |
| `WorkOrderKpiSnapshot.benchmarkSource / calculationBreakdown / calculationRevisions` | Provenance and arithmetic |

Two migrations, both additive:
`20260821200000_cr_2026_092_service_contributions` converts existing mappings in place
so nothing loses its configuration, and
`20260821203000_cr_2026_092_contribution_corrections` fixes the two rows the blanket
conversion could not (MSHOP-01 → CUSTOM_ONLY, DISC-01 → superseded).

Completed snapshots keep every rating and standard they carry; only the new descriptive
`benchmark_source` column was backfilled to describe what they already were.

---

## 10. Verified live

Every scenario run against the real API and the real seeded catalogue, then removed:

| Job (Sedan unless noted) | Standard | Source |
|---|---|---|
| OIL-01 + FUEL-FLT-01 | 90 + 30 = **120** | PACKAGE_PLUS_ADDITIVES |
| FUEL-FLT-01 alone | **30** | CATALOG_COMPOSITE |
| OIL-01 + BRK-01 inspection | **90** (Included) | MANAGER_PACKAGE |
| BRK-01 inspection alone | **30** | CATALOG_COMPOSITE |
| OIL-01 + EST-01 | 90 + 30 = **120** | PACKAGE_PLUS_ADDITIVES |
| OIL-01 + TIR-01 pressure check | **90** (Included) | MANAGER_PACKAGE |
| OIL-01 + TIR-01 rotation | 90 + 25 = **115** | PACKAGE_PLUS_ADDITIVES |
| OIL-01 + front pads | **120** | MANAGER_PACKAGE |
| OIL-01 + front pads **(SUV)** | **150** | MANAGER_PACKAGE |
| Front pads, no general service | **90** | CATALOG_COMPOSITE |
| OIL-01 + rear pads | 90 + 90 = **180** | PACKAGE_PLUS_ADDITIVES |
| OIL-01 + rear shoes | 90 + 90 = **180** | PACKAGE_PLUS_ADDITIVES |
| OIL-01 + **both axles** pads | 120 + 90 = **210** | PACKAGE_PLUS_ADDITIVES |
| Brake line, no qualifiers | *not ready* — names the missing answer | — |
| OIL-01 + **declined** tyre replacement | **90** | MANAGER_PACKAGE |
| OIL-01 + front pads + SPK-01 + FUEL-FLT-01 | 150 + 30 = **180** | PACKAGE_PLUS_ADDITIVES |

The first two brake rows are the directive's own worked examples, and they come out at
120 and 150 exactly.
