# Resource Capacity — Operations Handbook

**For the Service Centre manager and whoever maintains the system after handover.**
Everything in here is done on screen. Nothing needs a developer, and nothing needs
the site to be redeployed.

Last verified 2026-09-18 against the live configuration. Engineering record:
`docs/122` §K–§P.

---

## 1. What is running right now

| Setting | Value | What it means |
|---|---|---|
| Online catalogue | **ON**, 6 services | Customers can only book the six services listed below |
| Appointment length | **Standard 80 minutes** | Every online booking holds a position for 80 minutes, whatever the job |
| Booking capacity | **Fixed limit of 2** | At most two customer appointments can overlap, site-wide |
| Resource-aware scheduling | **Diagnostic only** | The smarter model runs alongside and is compared, but decides nothing |

These four are deliberate and should stay as they are until the steps in §10 and
§11 are completed and separately approved.

The settings themselves live under **Setup → Business Rules** if you ever need to
read them:

```
booking_enforce_online_bookable     true
appointment_duration_source         DEFAULT
booking_capacity_mode               FIXED
booking_max_concurrent_appointments 2
```

---

## 2. What customers can book

| Service | Kind of work it needs | Length | Buffer |
|---|---|---:|---:|
| Brake Inspection | General repair | 30 min | 0 |
| Vehicle Cleaning | General repair | 30 min | 0 |
| Tire Rotation | General repair | 25 min | 0 |
| Oil Change | **Oil & lube** | 30 min | 0 |
| Wheel Alignment | **Wheel alignment** | 60 min | 0 |
| Pre-Purchase Vehicle Inspection | **Inspection** | 75 min | 0 |

The lengths above are what the catalogue says. They are **not in use yet** —
every booking currently takes the standard 80 minutes (see §11).

To change which services appear online: **Setup → Services**, tick or untick
*Offered online*. That takes effect immediately.

---

## 3. How capacity is worked out

The system never stores a capacity number. It works it out every time it is asked,
from what you have configured. That is why adding a bay changes the answer
immediately and why nothing needs deploying.

**A resource counts toward capacity only when all of these are true:**

1. its role is **Work position** or **Overflow position**;
2. it is active and available for scheduling;
3. its status today is **Available** (not maintenance, not out of service);
4. it is not retired.

**Three things that deliberately count for nothing:**

- **Equipment** — a jack or a stand is used *at* a position, not *as* one.
  Counting them is how one vehicle on one jack with two stands becomes four
  bookings.
- **Not yet confirmed** — nobody has said what it is. That is the absence of a
  decision, not a decision that it is useless.
- **External** — the machine shop is not our capacity.

**Capability counts are never added together.** One bay that can do three kinds of
work appears in three rows on the dashboard and is still **one vehicle at a time**.
The system is built around this: it works out whether each overlapping job can be
given a *different* physical bay, rather than counting pools and adding them up.

---

## 4. The eight heavy-lift positions

Management has confirmed that **eight heavy-lift bays exist physically**. That is
settled and the system is configured for eight.

| Record | Name | Kind of work | Identity checked? |
|---|---|---|---|
| BAY-01 | Heavy Lift 1 | General repair | Not yet |
| BAY-02 | Heavy Lift 2 | General repair | Not yet |
| BAY-03 | Sedan Lift | General repair | Not yet — **see below** |
| BAY-06 | Heavy Lift 6 | General repair | Not yet |
| BAY-07 | Heavy Lift 7 | General repair | Not yet |
| BAY-08 | Heavy Lift 8 | General repair | Not yet |
| BAY-09 | Heavy Lift 9 | General repair | Not yet |
| BAY-10 | Heavy Lift 10 | General repair | Not yet |

---

## 5. Why those records say "Provisional"

The **count** of eight is confirmed. **Which record is which bay is not.**

Those eight records were matched to the eight physical bays from their names, lift
types and code numbers. That is a reasonable guess. It is not the same as somebody
walking the floor and checking, and the system says so rather than quietly treating
the guess as fact.

Two things worth knowing:

- **This does not reduce capacity.** All eight count. The shop has eight bays
  whichever record is which.
- **BAY-03 is separately flagged.** It is recorded as a *sedan* lift at standard
  weight rather than a heavy lift. If it is not one of the eight you mean, change
  its role and add the real eighth — see §8.

### To confirm one

1. **Setup → Resources & Bays → Confirm Work Positions**
2. Click the resource to open it
3. Tick **"I have checked this in the building"**

Do them as you go. There is no need to do all eight at once, and nothing is
blocked while they are outstanding.

---

## 6. What still needs your input

Three of the six services customers can book have **no bay assigned to do the
work**:

| Service | Needs | Bays that can do it |
|---|---|---:|
| Oil Change | Oil & lube | **0** |
| Wheel Alignment | Wheel alignment | **0** |
| Pre-Purchase Vehicle Inspection | Inspection | **0** |

Those three are the only thing standing between the shop and resource-aware
scheduling. They are configuration, not a software problem: nobody has yet said
which bay does oil changes.

### To fix

1. **Setup → Resources & Bays → Confirm Work Positions**
2. Open the bay that does the work
3. Under **"What work can happen here?"**, tick the kind of work
4. Repeat for each of the three

**One bay is enough.** If only one bay does alignments, assign it to one bay. The
system will note that the service rests on a single position — that is a useful
warning, not a hint that you should pretend there are two.

You can assign several kinds of work to the same bay. It stays one vehicle at a
time; the system handles that correctly.

---

## 7. The seven not yet classified

These contribute **zero** and do not block anything:

| Record | Name | Likely question to answer |
|---|---|---|
| OVF-01 | Overflow Slot A | Is this a real extra vehicle position? |
| OVF-02 | Overflow Slot B | Same |
| LT-01 | Light Task Slot 1 | Does work actually happen here? |
| LT-02 | Light Task Slot 2 | Same |
| PWASH-01 | Power Wash | Is this a position of its own, or part of a bay? |
| BAY-04 | Mobile Lift | A position, or a jack used at one? |
| BAY-05 | Power Jack | Same |

Leaving them unclassified is **safe**. A resource that counts for nothing can never
cause an overbooking — the worst it can do is make the shop look smaller than it
is. Classify them when you know, and capacity goes up the same day.

`MSHOP-EXT` (External Machine Shop) is marked external and is out of scope
entirely. It needs no classification.

---

## 8. Day-to-day: adding, removing and changing resources

All of this is **Setup → Resources & Bays**. Every change is recorded against the
resource's history with who did it and when. None of it needs a deployment.

### Open a new bay

1. **Add Resource**
2. Give it a code and a name, choose **Bay**
3. Set **Counts as a work position** → *Work position*
4. On **Confirm Work Positions**, tick what work can happen there

Capacity goes up immediately.

### Take a bay out for the day

1. Find it → **Change status**
2. Choose *Maintenance* or *Temporarily unavailable*, give a reason

Capacity drops immediately. **Its role is kept** — it is still a work position, it
just isn't available today. Set it back to *Available* and capacity returns.

### Add an overflow position

Same as a new bay, but set the role to **Overflow position**. It starts counting as
soon as it is available and has a kind of work assigned. Add a second and a third
later; each one changes capacity on its own. There is no total to keep in step.

### Change what a bay can do

**Confirm Work Positions** → open it → tick or untick under *What work can happen
here?* Takes effect on the next booking calculation.

### Retire a bay for good

**Retire**, with a reason. History is kept in full and the bay stops taking new
work. If it comes back, **Reactivate** is a separate, recorded action.

> Deleting is only possible for a resource that has never been used — a typo. Once
> a bay has held a vehicle, it is retired, never erased.

### Vehicle restrictions

On the resource's edit form: whether it takes sedans, SUVs or both. A mobile jack
is sedan-only by a safety rule and cannot be overridden from a booking — only by a
manager at dispatch, which is recorded.

---

## 9. Running the shadow check

The shadow check compares what customers are offered today against what the
resource-aware model would have offered, and records the differences.

**Run it after any change to bays, roles or capabilities.**

```bash
pnpm booking:shadow-validate
```

It prints a table per service and stamps the result against the configuration it
measured. Reading the columns:

| Column | Means | Is it bad? |
|---|---|---|
| **Agree** | Both models gave the same answer | No — expected |
| **Over** | Today's limit offered a slot no bay could cover | **Yes** — the shop is being oversold |
| **Under** | Today's limit refused a slot where bays were free | No — capacity going to waste |
| **Incompl** | The model could not tell, because a kind of work has no bay | Configuration gap, not a capacity finding |

**Today's result:** 702 *Incomplete*, 0 Over, 0 Under — every one of them the three
unassigned specialties from §6.

**Target once §6 is done:** `oversold = 0`, `incomplete = 0`.

*Under* may remain and is not a problem. It means the fixed limit of 2 is turning
away work the shop could do — which is exactly the thing resource-aware scheduling
would fix.

> If you change configuration and do not re-run this, the system notices: the
> recorded stamp no longer matches the shop and activation is blocked until you
> run it again. That is deliberate.

---

## 10. Turning on resource-aware scheduling

**Do not do this at the same time as §11.** One change at a time, so that if
something looks wrong you know which change caused it.

### Before you can

The system checks all of these and refuses if any fails:

| Check | Today |
|---|---|
| Every bookable service has a bay that can do it | ✗ — three outstanding (§6) |
| At least one bay is available | ✓ |
| No bay has contradictory settings | ✓ |
| Shadow check has been run against *this* configuration | ✓ |
| Shadow check found no overselling | ✓ |
| Shadow check could evaluate every service | ✗ — the same three |

You can see this live on **Setup → Resources & Bays**, in *Not ready to switch
over*. Things listed under **Worth knowing** are warnings and do **not** block —
unclassified overflow, provisional identities and single-position services are all
fine to leave.

### The steps

1. Complete §6 — assign Oil & lube, Wheel alignment and Inspection
2. Run `pnpm booking:shadow-validate`
3. Check **Resources & Bays** reads *Ready to switch over*
4. **Bring the result back for an activation decision — do not switch it on
   automatically**
5. If approved: **Setup → Business Rules** → `booking_capacity_mode` → `RESOURCE_AWARE`

Leave `appointment_duration_source` on `DEFAULT` throughout. That isolates the
capacity change.

### If it goes wrong

Set `booking_capacity_mode` back to `FIXED`. It takes effect immediately and no
existing booking is affected.

---

## 11. Turning on catalogue appointment lengths

**Only after §10 has been running and proven in normal operation.**

Today every booking takes 80 minutes. The catalogue says an oil change is 30. Using
the catalogue lengths would fit more work into a day — the question is whether the
shop can absorb it.

### Before you can

1. §10 done, and resource-aware scheduling running normally for a period you are
   happy with
2. Re-run the impact analysis:

```bash
pnpm booking:duration-impact-resource
```

3. Read the recommendation at the bottom

**Current recommendation: HOLD.** Eight confirmed positions genuinely weaken the
original concern — a saturation increase against a ceiling of 2 is a different
proposition from the same increase against 8. But the services that shorten most
are the specialty ones, and three of them have no bay assigned at all. Shortening
them would push more bookings toward pools whose size nobody has established.

Re-run it once §6 is done. If each specialty has a bay, the picture changes.

### The step, if approved

**Setup → Business Rules** → `appointment_duration_source` → `CATALOGUE`.

Not automatic. Bring the analysis back for a decision.

---

## 12. Safeguards that must stay

These are built in and should not be removed or worked around:

- **Activation preflight** — resource-aware scheduling cannot be switched on while
  a bookable service has no bay to do it
- **Stale-check protection** — changing configuration invalidates the last shadow
  check
- **Provisional identities** — an inferred mapping is never reported as verified
- **Warnings vs blockers** — a resource contributing zero never blocks anything
- **Capability-based readiness** — the gate is "can we do what customers can book",
  not "is every row tidy"
- **The matching solver** — capacity is worked out from real bays, never by adding
  pools
- **Equipment excluded** — jacks and stands never count as positions
- **Full audit** — every resource change records who and when
- **The simulator** — both models side by side on every slot
- **Derived capacity** — no stored bay count anywhere
- **No automatic bay matching** — old bay records are linked by a person, never
  guessed from codes

---

## 13. Where things are

| Task | Where |
|---|---|
| Add, edit, retire a resource | Setup → Resources & Bays |
| Roles, capabilities, identity, old-bay links | Setup → Resources & Bays → Confirm Work Positions |
| Capacity and readiness at a glance | Top of Setup → Resources & Bays |
| Compare the two models slot by slot | Setup → Booking Simulator |
| Which services are offered online | Setup → Services |
| The four settings in §1 | Setup → Business Rules |

| Command | Does |
|---|---|
| `pnpm booking:shadow-validate` | Runs the shadow check and stamps it |
| `pnpm resources:summary` | Full written summary of the resource position |
| `pnpm booking:duration-impact-resource` | The §11 analysis |
| `pnpm resources:baseline` | Shows the eight-bay baseline; `--commit` applies it |
| `pnpm deploy:check` | Confirms a deployment is configured correctly |

---

## 14. In short

The software is finished. What remains is three capability assignments and, in your
own time, ticking off eight bays.

Nothing outstanding requires a developer, and nothing requires the site to be
redeployed.
