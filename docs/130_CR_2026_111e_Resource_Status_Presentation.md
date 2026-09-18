# CR-2026-111e — Resource status presentation clarity

**Status:** Complete. Presentation only — no model, API contract, scheduling or capacity change.
**Date:** 2026-09-18
**Closes:** the operational regression/audit stream.

---

## 1. The problem

A work resource has two independent facts, and the model keeps them apart correctly:

| Fact | Field | Values |
|---|---|---|
| **Occupancy** — is something in it? | `status` | `AVAILABLE` · `OCCUPIED` · `RESERVED` |
| **Operational condition** — can it take work? | `isOperational` / `operationalState` | `AVAILABLE` · `TEMPORARILY_UNAVAILABLE` · `MAINTENANCE` · `OUT_OF_SERVICE` |

Both use the word **AVAILABLE** for their own meaning. The Dispatch Board printed
the occupancy word as its headline chip, so a bay under maintenance with nothing in
it showed a **green "Available"** — the bay nobody could use looked like the best
bay on the board. The red "Down for maintenance" note sat *below* it.

---

## 2. What changed

**Nothing in the model, the APIs' behaviour, scheduling, capacity, resource
lifecycle, WorkBay assignment or shadow calculations.**

### One additive projection

`resources.service.ts` now projects `operationalState` on the resource card, read
from the `operationalStatus` relation **the same query already loads**. No new
query, no field removed. Without it the board could only say "not operational" and
had to guess the reason — which is why every downed resource read "Down for
maintenance" even when it was out of service.

### One shared presentation module

`apps/web/lib/resource-status.ts` — pure functions, no React. Neither raw word is
ever printed:

- **Occupancy** → `Available` · `In use` · `Reserved`
- **Operational** → `Operational` · `Temporarily Unavailable` · `Maintenance` · `Out of Service`

`AVAILABLE` renders **"Operational"** in the operational dimension, because that
single overloaded word is the whole defect.

### The rule

When a resource **cannot take work**, the operational state **leads** and occupancy
is demoted to a quiet secondary line. When it can, occupancy leads.

```
BAY-01                    [ Maintenance ]      ← orange stripe, leads
Heavy Lift 1
Not currently occupied                          ← secondary, muted
┌────────────────────────────────────────┐
│ Cannot take work — Maintenance         │
│ Lift inspection due                    │
└────────────────────────────────────────┘
```

```
BAY-02                    [ Available ]        ← green stripe, operational
Heavy Lift 2
Operational
        Ready for assignment
```

Both screens use the module, so the Dispatch Board and Setup → Resources cannot
drift apart. Chip and stripe classes are **literal** strings — a composed
`border-l-${tone}` is purged by Tailwind and the stripe silently vanishes; a test
pins this.

---

## 3. A trap found while verifying

There are **two** ways a resource gets marked down, and they write different things:

| Action | Endpoint | Writes |
|---|---|---|
| Setup → Resources, graded status | `POST /resources/:id/status` | `operationalState = MAINTENANCE` … |
| **Dispatch Board "Mark down"** | `POST /resources/:id/operational-status` | `isOperational = false`, **graded state left `AVAILABLE`** |

Reading the graded word alone would have shown a bay marked down **from the board**
— the commonest path — as green and "Available": the original defect, reintroduced
by the fix. Confirmed against the live API:

```
{"isOperational":false,"operationalState":"AVAILABLE","status":"AVAILABLE"}
```

Two `AVAILABLE`s and a `false`. The presentation now reconciles both signals
(`effectiveOperationalState`), and the boolean-only case is described honestly as
**"Temporarily Unavailable"** rather than inventing a reason nobody gave. Verified
in the browser: that row renders `Temporarily Unavailable` / `Not currently occupied`.

This is a presentation reconciliation. The endpoints were not changed.

---

## 4. Verification

| Check | Result |
|---|---|
| Wording/presentation tests | **28 passed** (`lib/__tests__/resource-status.spec.ts`) |
| Web suite | **337 passed** |
| API suite | **1672 passed**, 17 skipped |
| Both typechecks | clean |
| Schema drift | none |
| **Operational regression audit re-run** | **80/80, all areas PASS** |
| Browser verification | Maintenance, boolean-toggle, and operational bays all render correctly |

The audit was re-run because an API projection changed, additively — behaviour is
unaffected and the matrix is unchanged.

### Behaviour deliberately untouched

"Ready for assignment" still requires `isOperational && status === 'AVAILABLE'`,
and the `summary.available` count still requires both. Those are gates, not wording.

---

## 5. Production state

`booking_capacity_mode` = **FIXED** · `appointment_duration_source` = **DEFAULT** ·
RESOURCE_AWARE = **SHADOW only** · GEN-SERV-01 **not public** · 8 approved public
services unchanged · BAY-01 restored to AVAILABLE · no migration.

---

## 6. Now operational/configuration decisions, not development defects

Recorded here so they are not mistaken for open engineering work:

1. Confirm LUBE-capable resource(s).
2. Confirm ALIGNMENT-capable resource(s).
3. Confirm INSPECTION-capable resource(s).
4. Confirm provisional physical bay identities over time.
5. Complete optional overflow/light-position classification.
6. Rerun resource shadow validation after configuration.
7. Reassess DEFAULT → CATALOGUE only after resource validation.

**The operational regression/audit stream is closed.**
