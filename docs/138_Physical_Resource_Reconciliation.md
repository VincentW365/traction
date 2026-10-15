# Physical position ↔ system resource reconciliation

**Date:** 2026-10-15
**Status:** PROVISIONAL — awaiting workshop confirmation. **Nothing in production, in
the resource inventory, or in booking capacity has been changed.**
**Inputs:** the photographic audit of eight numbered working positions (preliminary
findings, 2026-10-15); the system's resource inventory as it stands on the
development database (`pnpm resources:summary` + a direct read of `work_resources`);
`docs/122` (CR-108 Stage 5) and `docs/119` §150.

This is the table the audit's action 9 asks for. It is deliberately a *question
sheet*, not an answer sheet: where the photographs and the software disagree, the
disagreement is shown, not resolved. Every row that needs a person to confirm
something says so. Per action 1, **no handwritten position number is assumed to
be any BAY code.**

---

## 1. The one thing the photographs change

The software currently holds **eight PRIMARY service positions, all with the
GENERAL capability**, set up on the premise "management confirmed eight physical
heavy-lift bays" (`scripts/configure-resource-baseline.ts`). The photographs show
eight *positions* — but **four two-post lifts, two drive-on runway lifts, and two
ground-level positions with no fixed lift visible.** That is not eight heavy
lifts.

It matters because a position's lift decides what work it can take. A ground
floor cannot do under-vehicle work that needs a lift; a runway lift is where an
alignment station usually lives, but that has to be seen, not inferred (action 6).
Until the mapping is confirmed, the scheduler's belief that any of its eight
positions can take any GENERAL job is **unverified**, and the count of positions
that can genuinely take a given service may be lower than eight.

The software can already record the difference: `liftType` is free text
(`"heavy"`, `"sedan"`, `"mobile"`, `"power_jack"` today), so `"runway"` and
`null` (ground level) need no schema change — only confirmation.

## 2. Table A — the eight physical positions

| Your # | Observed | Proposed classification | System record it *might* be (NOT confirmed) | What the system currently says about that record |
| --- | --- | --- | --- | --- |
| 1 | White Toyota SUV, BendPak two-post lift | Mechanical lift bay | one of BAY-01 / 02 / 08 / 09 / 10 | `liftType: heavy`, HEAVY, SUV ok, GENERAL |
| 2 | Red SUV raised, two-post lift | Mechanical lift bay | one of BAY-01 / 02 / 08 / 09 / 10 | as above |
| 3 | Grey Toyota SUV, drive-on runway lift with ramps | **Drive-on lift bay** | **none** — no record has a runway lift type | — |
| 4 | Black sedan raised, two-post lift | Mechanical lift bay | one of BAY-01 / 02 / 08 / 09 / 10, or BAY-03 "Sedan Lift" | BAY-03 is `liftType: sedan`, STANDARD weight |
| 5 | Silver sedan, covered ground-level position, no fixed lift seen | Ground-level service position — **pending** | possibly BAY-06 or BAY-07 (both `liftType: null`), or LT-01 / LT-02, or OVF-01 / OVF-02 | BAY-06/07 are PRIMARY + GENERAL (i.e. counted as full bays); LT/OVF are UNVERIFIED (count as nothing) |
| 6 | Drive-on runway lift, yellow ramps | **Drive-on lift bay** | **none** — as position 3 | — |
| 7 | Covered working area, no fixed lifting equipment seen | Open service position — **pending** | as position 5 | as position 5 |
| 8 | Unoccupied two-post lifting station | Mechanical lift bay | one of BAY-01 / 02 / 08 / 09 / 10 | as position 1 |

**Reading the table:** five system records say *heavy two-post lift* and the
photographs show four. Two system records (BAY-06, BAY-07, "was Bay 6/7 (TBD)")
have **no lift type recorded at all** and are the likeliest candidates for the two
ground-level positions — but if so, they are currently counted as full GENERAL
service bays, which may be wrong. Two runway lifts exist in the building and
nowhere in the software.

## 3. Table B — the eight unverified records and four support items

| System record | What the system says today | Audit's recommended treatment | Decision needed from the workshop |
| --- | --- | --- | --- |
| BAY-04 Mobile Lift | UNVERIFIED; `mobile`, STANDARD, sedan-only, counts as nothing | Equipment, unless it is its own usable position | Is it a *place* a car is serviced, or a *tool* wheeled to a place? |
| BAY-05 Power Jack | UNVERIFIED; `power_jack`, LIGHT, sedan-only | Support equipment, not a booking bay | Same question. (Likely equipment.) |
| OVF-01 Overflow Slot A | UNVERIFIED; OVERFLOW, STANDARD | Conditional overflow; location unconfirmed | Where is it? Is it position 5 or 7, or somewhere not photographed? |
| OVF-02 Overflow Slot B | as above | as above | as above |
| LT-01 Light Task Slot 1 | UNVERIFIED; LIGHT_SLOT, LIGHT | Possibly one of the ground-level positions | Is it position 5 or 7? If so, it is the *same place* as a BAY-06/07 record and must not be counted twice. |
| LT-02 Light Task Slot 2 | as above | as above | as above |
| PWASH-01 Power Wash | UNVERIFIED; POWER_WASH | Cleaning resource; no dedicated location established | Is there a wash location that is *not* also a service position? (Decides whether Vehicle Cleaning occupies repair capacity.) |
| MSHOP-EXT External Machine Shop | UNVERIFIED; EXTERNAL | External provider, not an on-site bay | None — classify EXTERNAL / not capacity. No workshop walk needed. |
| MJACK-01 / 02 Mobile Jack | SUPPORT_EQUIPMENT (counts as nothing) | — | None; already correct. |
| STAND-01 / 02 | SUPPORT_EQUIPMENT (counts as nothing) | — | None; already correct. |

## 4. Table C — the six legacy bay records (the old table)

These are what scheduling *used* before the resource model existed. They are kept
for history (action 2) and must each be either linked to the physical position
that is the same place, or marked as history. **Not inventing a link is the rule:
the scheduler reasons from whatever is written here.**

| Legacy record | Bay type recorded | Job history | Disposition options |
| --- | --- | --- | --- |
| BAY-01 | GENERAL | 39 jobs | Link to whichever physical lift it was — or history |
| BAY-02 | GENERAL | 6 jobs | as above |
| BAY-03 | LUBE | 16 jobs | Which position did oil changes happen at? Link there, or history |
| BAY-04 | ALIGNMENT | 0 jobs | Is there an alignment station? If yes, link to it; if not, history |
| BAY-05 | DIAGNOSTIC | 1 job | Link or history |
| BAY-06 | INSPECTION | 0 jobs | Link or history |

`docs/122` §1199 already established that legacy `BAY-01` and resource `BAY-01`
share a code **by accident, not identity**. The code must not be used as the link.

## 5. The four questions that block classification

Everything in Tables A–C collapses to these. Answered, the register can be
finalised; unanswered, nothing should be written.

1. **Which numbered positions are which system records?** Specifically: which
   four of BAY-01/02/08/09/10 are the four two-post lifts (1, 2, 4, 8), and is
   BAY-03 "Sedan Lift" one of them — or is BAY-03 something else? The fifth
   "heavy" record has no photographed counterpart.
2. **What are positions 5 and 7?** Are they BAY-06/BAY-07 (currently counted as
   full bays), the Light Task Slots, the Overflow Slots, or the same place under
   two names? Do customers' booked jobs ever happen there, and what kind?
3. **Where is the alignment equipment, if any?** The two runway lifts (3, 6) are
   the natural place, but action 6 forbids assuming it. Until confirmed, Wheel
   Alignment (TIR-02) has no position and stays unbookable — correctly.
4. **Is there a wash location that is not also a service position?** If cleaning
   happens in a bay, a booked wash occupies repair capacity and the system
   should model it that way (it does today). If there is a separate wash area,
   Vehicle Cleaning needs its own capability — a catalogue change needing
   approval — and PWASH-01 becomes that position.

Two smaller confirmations ride along: BAY-04 and BAY-05 as equipment (almost
certainly yes), and which position oil changes happen at (so OIL-01 — 16 jobs of
history under legacy BAY-03 — gets a verified LUBE position).

## 6. What the confirmed answers would change in the software

Listed so the scale is clear; none of it is done.

- Two records gain `liftType: "runway"` (free text; no schema change).
- Two records (whichever are 5 and 7) either lose PRIMARY status, or keep it
  with capabilities narrowed to what a ground-level position can do. Either way
  the *derived* position count stops assuming they are lifts.
- LT-01/02 and OVF-01/02 are either linked to the same physical places (and
  retired as duplicates) or classified as what they are.
- Legacy BAY-01..06 each get a link or a history note. **No job record moves.**
- ALIGNMENT, LUBE and INSPECTION are assigned to confirmed positions only.
- `booking_capacity_mode` stays **FIXED** (action 8). Even once every row above
  is confirmed, moving to resource-aware capacity is a separate, gated step:
  all eight readiness checks must pass, and a manager flips it in Settings.

## 7. What was not done, deliberately

- No change to production, to the resource inventory, or to booking capacity
  (action 10).
- `resources:baseline` was **not** run and must not be run as written: it would
  classify eight records as heavy lifts, which the photographs show is not the
  building. Its create-if-missing fix (CR-2026-119) is still worth applying so
  a fresh deployment is not left with three lifts — but the *list of eight* in
  that script needs correcting against Table A first.
- No capability was assigned from the photographs alone.
